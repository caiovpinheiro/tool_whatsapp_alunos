import { getPool, query, withTransaction } from '../db/client.js';
import {
  collectFilledBusinessPaths,
  hashObject,
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeRgm,
} from '../utils/novoCrmCacheNormalize.js';
import { cacheRowHasIncompleteMappedFields } from '../utils/novoCrmFieldMapping.js';

const LOCK_KEY = 73201443;

export async function acquireSyncLock() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query('select pg_try_advisory_lock($1) as locked', [LOCK_KEY]);
    if (!rows[0]?.locked) {
      client.release();
      return null;
    }
    return async () => {
      try {
        await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
      } finally {
        client.release();
      }
    };
  } catch (err) {
    client.release();
    throw err;
  }
}

export async function recordSyncStart({ mode, cursorStartedAt = null, contactsTotal = null }) {
  const { rows } = await query(
    `insert into novo_crm_cache_sync_log (mode, cursor_started_at, contacts_total)
     values ($1, $2, $3)
     returning id`,
    [mode, cursorStartedAt, contactsTotal]
  );
  return String(rows[0].id);
}

export async function recordSyncProgress(
  id,
  { batches = 0, contactsSeen = 0, upserted = 0, skipped = 0, dataLossEvents = 0 }
) {
  await query(
    `update novo_crm_cache_sync_log
        set batches_scanned = $2,
            contacts_seen = $3,
            cache_upserted = $4,
            cache_skipped = $5,
            data_loss_events = $6,
            progress_updated_at = now()
      where id = $1`,
    [id, batches, contactsSeen, upserted, skipped, dataLossEvents]
  );
}

export async function recordSyncFinish(
  id,
  {
    status = 'ok',
    cursorFinishedAt = null,
    batches = 0,
    contactsSeen = 0,
    upserted = 0,
    skipped = 0,
    deleted = 0,
    dataLossEvents = 0,
    errorMessage = null,
  }
) {
  await query(
    `update novo_crm_cache_sync_log
        set finished_at = now(),
            cursor_finished_at = $2,
            batches_scanned = $3,
            contacts_seen = $4,
            cache_upserted = $5,
            cache_skipped = $6,
            contacts_deleted = $7,
            data_loss_events = $8,
            status = $9,
            error_message = $10
      where id = $1`,
    [
      id,
      cursorFinishedAt,
      batches,
      contactsSeen,
      upserted,
      skipped,
      deleted,
      dataLossEvents,
      status === 'cancelled' ? 'error' : status,
      errorMessage,
    ]
  );
}

export async function forceFinishRunningSyncs(errorMessage = 'sync interrompido (timeout/restart)') {
  const { rowCount } = await query(
    `update novo_crm_cache_sync_log
        set status = 'error',
            finished_at = now(),
            error_message = $1
      where status = 'running'
        and finished_at is null`,
    [errorMessage]
  );
  return rowCount ?? 0;
}

/**
 * Fecha syncs órfãos. Não mata sync que ainda reporta progresso recente
 * (full noturno pode passar de 1h; orçamento aceito ~2–3h).
 */
export async function closeStaleRunningSyncs() {
  const { rowCount } = await query(
    `update novo_crm_cache_sync_log
        set status = 'error',
            finished_at = now(),
            error_message = 'sync interrompido (timeout/restart)'
      where status = 'running'
        and finished_at is null
        and started_at < now() - interval '8 hours'
        and coalesce(progress_updated_at, started_at) < now() - interval '30 minutes'`
  );
  return (rowCount ?? 0) > 0;
}

export async function getSyncState() {
  const { rows } = await query(
    `select key, cursor_updated_at, cursor_id, updated_at
       from novo_crm_cache_sync_state
      where key = 'contacts_deals'`
  );
  return rows[0] || null;
}

export async function updateSyncState({ cursorUpdatedAt, cursorId = null }) {
  await query(
    `insert into novo_crm_cache_sync_state (key, cursor_updated_at, cursor_id, updated_at)
     values ('contacts_deals', $1, $2, now())
     on conflict (key) do update set
       cursor_updated_at = excluded.cursor_updated_at,
       cursor_id = excluded.cursor_id,
       updated_at = now()`,
    [cursorUpdatedAt, cursorId]
  );
}

const FLAGS_STAGE_LAST_KEY = 'flags_stage_last';
const FIELDS_LAST_KEY = 'fields_last';
const ORPHAN_DEDUPE_LAST_KEY = 'orphan_dedupe_last';
const ORPHAN_DEDUPE_PLAN_KEY = 'orphan_dedupe_plan';

function isFieldsSyncMode(summary) {
  return String(summary?.mode || '').trim() === 'fields';
}

/**
 * Persistência genérica de resumo em `novo_crm_cache_sync_state.cursor_id` (JSON).
 * Jobs em memória somem no restart — last-run sobrevive.
 * @param {string} key
 * @param {object} summary
 */
async function saveJsonSyncState(key, summary) {
  const payload = JSON.stringify(summary || {});
  await query(
    `insert into novo_crm_cache_sync_state (key, cursor_updated_at, cursor_id, updated_at)
     values ($1, now(), $2, now())
     on conflict (key) do update set
       cursor_updated_at = now(),
       cursor_id = excluded.cursor_id,
       updated_at = now()`,
    [key, payload]
  );
}

/** @param {string} key @returns {Promise<object|null>} */
async function getJsonSyncState(key) {
  const { rows } = await query(
    `select cursor_id, cursor_updated_at, updated_at
       from novo_crm_cache_sync_state
      where key = $1`,
    [key]
  );
  const row = rows[0];
  if (!row?.cursor_id) return null;
  try {
    const parsed = JSON.parse(row.cursor_id);
    return {
      ...parsed,
      finished_at: parsed.finished_at || row.updated_at || row.cursor_updated_at || null,
    };
  } catch {
    return { raw: row.cursor_id, finished_at: row.updated_at || null };
  }
}

/**
 * Persiste resumo da última Att de etapas (sobrevive a restart; jobs em memória não).
 * Inclui cancel parcial (scanned/flags/etapas até o stop).
 * mode=fields (cron da madrugada) vai para `fields_last` — não pisa o card Att.
 * @param {object} summary
 */
export async function saveFlagsStageLastRun(summary) {
  const key = isFieldsSyncMode(summary) ? FIELDS_LAST_KEY : FLAGS_STAGE_LAST_KEY;
  await saveJsonSyncState(key, summary);
}

/** @returns {Promise<object|null>} */
export async function getFlagsStageLastRun() {
  return getJsonSyncState(FLAGS_STAGE_LAST_KEY);
}

/** @returns {Promise<object|null>} */
export async function getFieldsLastRun() {
  return getJsonSyncState(FIELDS_LAST_KEY);
}

/**
 * Última prévia/apply de dedupe órfãos (dry + apply).
 * @param {object} summary
 */
export async function saveOrphanDedupeLastRun(summary) {
  await saveJsonSyncState(ORPHAN_DEDUPE_LAST_KEY, summary);
}

/** @returns {Promise<object|null>} */
export async function getOrphanDedupeLastRun() {
  return getJsonSyncState(ORPHAN_DEDUPE_LAST_KEY);
}

/**
 * Plano acionável produzido pela última prévia de dedupe.
 * Usa a mesma tabela de state para sobreviver a restart entre Prévia e Aplicar.
 * @param {object} plan
 */
export async function saveOrphanDedupePlan(plan) {
  await saveJsonSyncState(ORPHAN_DEDUPE_PLAN_KEY, plan);
}

/** @returns {Promise<object|null>} */
export async function getOrphanDedupePlan() {
  return getJsonSyncState(ORPHAN_DEDUPE_PLAN_KEY);
}

async function loadExisting(contactId) {
  const { rows } = await query(
    `select contact_id, primary_deal_id, raw_data, filled_field_count, content_hash, is_deleted,
            cpf_norm, rgm_norm
       from novo_crm_person_cache
      where contact_id = $1`,
    [contactId]
  );
  return rows[0] || null;
}

const CPF_FIELD_NAMES = new Set(['cpf', 'documento', 'taxid']);
const RGM_FIELD_NAMES = new Set(['rgm']);
const CPF_FIELD_IDS = new Set(['cmrnpd33ekm5snm01jecpmevp']);
const RGM_FIELD_IDS = new Set(['cmrmexurt18tfnm01e6krzug6']);

function extractCpfRgmFromRaw(rawData) {
  const deals = rawData?.dealsById;
  if (!deals || typeof deals !== 'object') return { cpf: null, rgm: null };
  let cpf = null;
  let rgm = null;
  for (const deal of Object.values(deals)) {
    const fields = deal?.customFields;
    if (!Array.isArray(fields)) continue;
    for (const field of fields) {
      const name = String(field?.name || '').trim().toLowerCase();
      const id = String(field?.id || '').trim();
      const val = field?.value;
      if (val == null || String(val).trim() === '') continue;
      if (!cpf && (CPF_FIELD_NAMES.has(name) || CPF_FIELD_IDS.has(id))) cpf = val;
      if (!rgm && (RGM_FIELD_NAMES.has(name) || RGM_FIELD_IDS.has(id))) rgm = val;
    }
    if (cpf && rgm) break;
  }
  return { cpf, rgm };
}

function diffRemovedFields(oldRaw, nextRaw) {
  const before = collectFilledBusinessPaths(oldRaw || {});
  const after = collectFilledBusinessPaths(nextRaw || {});
  const removed = [];
  const previousValues = {};
  for (const [path, value] of before.entries()) {
    if (!after.has(path)) {
      removed.push(path);
      previousValues[path] = value;
    }
  }
  return { removed, previousValues, beforeCount: before.size, afterCount: after.size };
}

async function recordDataLossEvent({ snapshot, existing, diff, syncLogId }) {
  if (!diff.removed.length) return false;
  const fingerprint = hashObject({
    contactId: snapshot.contactId,
    dealId: snapshot.primaryDealId || existing?.primary_deal_id || null,
    removed: diff.removed.slice().sort(),
    previousHash: existing?.content_hash || null,
    nextHash: snapshot.contentHash,
  });
  const { rowCount } = await query(
    `insert into novo_crm_data_loss_events
       (contact_id, deal_id, field_paths, previous_values, filled_count_before,
        filled_count_after, previous_hash, next_hash, sync_log_id, fingerprint)
     values ($1, $2, $3::text[], $4::jsonb, $5, $6, $7, $8, $9, $10)
     on conflict (fingerprint) do nothing`,
    [
      snapshot.contactId,
      snapshot.primaryDealId || existing?.primary_deal_id || null,
      diff.removed,
      JSON.stringify(diff.previousValues),
      diff.beforeCount,
      diff.afterCount,
      existing?.content_hash || null,
      snapshot.contentHash,
      syncLogId ? Number(syncLogId) : null,
      fingerprint,
    ]
  );
  return (rowCount ?? 0) > 0;
}

/** Marca primary_deal_id após create (evita re-provisionar órfão no próximo run sem full sync). */
export async function markPrimaryDealId(contactId, dealId) {
  const cid = String(contactId || '').trim();
  const did = String(dealId || '').trim();
  if (!cid || !did) return;
  await query(
    `update novo_crm_person_cache
        set primary_deal_id = $2,
            last_synced_at = now()
      where contact_id = $1
        and (primary_deal_id is null or btrim(primary_deal_id) = '')`,
    [cid, did]
  );
}

/**
 * Espelha no JSON do cache o que acabou de ir no PUT do CRM.
 * Sem isso a próxima Att vê flag vazia e regrava os mesmos ~11k.
 * Não mexe em content_hash (Full FETCH=0 continua podendo skip).
 */
export async function applyDealCustomFieldWrites(contactId, dealId, pairs) {
  const did = String(dealId || '').trim();
  if (!did || !Array.isArray(pairs) || !pairs.length) return false;
  const cid = String(contactId || '').trim();

  return withTransaction(async (client) => {
    let row = null;
    if (cid) {
      const { rows } = await client.query(
        `select contact_id, raw_data, cpf_norm, rgm_norm
           from novo_crm_person_cache
          where contact_id = $1
          for update`,
        [cid]
      );
      row = rows[0] || null;
    }
    if (!row) {
      const { rows } = await client.query(
        `select contact_id, raw_data, cpf_norm, rgm_norm
           from novo_crm_person_cache
          where is_deleted = false
            and (primary_deal_id = $1 or raw_data->'dealsById' ? $1)
          limit 1
          for update`,
        [did]
      );
      row = rows[0] || null;
    }
    if (!row?.raw_data) return false;

    const raw = typeof row.raw_data === 'object' ? { ...row.raw_data } : {};
    const deals =
      raw.dealsById && typeof raw.dealsById === 'object' ? { ...raw.dealsById } : {};
    const existingDeal = deals[did];
    if (!existingDeal || typeof existingDeal !== 'object') return false;
    const deal = { ...existingDeal };
    const fields = Array.isArray(deal.customFields)
      ? deal.customFields.map((f) => ({ ...f }))
      : [];

    let nextCpf = row.cpf_norm || null;
    let nextRgm = row.rgm_norm || null;
    for (const pair of pairs) {
      const id = String(pair?.fieldId || '').trim();
      if (!id) continue;
      const value = pair?.value == null ? '' : String(pair.value);
      const idx = fields.findIndex((f) => String(f?.id || f?.fieldId || '').trim() === id);
      if (idx >= 0) {
        fields[idx] = { ...fields[idx], id: fields[idx].id || id, value };
      } else {
        fields.push({ id, name: '', value });
      }
      const name = String((idx >= 0 ? fields[idx] : fields[fields.length - 1])?.name || '')
        .trim()
        .toLowerCase();
      if (CPF_FIELD_IDS.has(id) || CPF_FIELD_NAMES.has(name)) {
        nextCpf = normalizeCpf(value) || nextCpf;
      }
      if (RGM_FIELD_IDS.has(id) || RGM_FIELD_NAMES.has(name)) {
        nextRgm = normalizeRgm(value) || nextRgm;
      }
    }

    deal.customFields = fields;
    deals[did] = deal;
    raw.dealsById = deals;

    await client.query(
      `update novo_crm_person_cache
          set raw_data = $2::jsonb,
              cpf_norm = $3,
              rgm_norm = $4,
              last_synced_at = now()
        where contact_id = $1`,
      [row.contact_id, JSON.stringify(raw), nextCpf, nextRgm]
    );
    return true;
  });
}

function incomingLacksDealCustomFields(rawData) {
  const deals = rawData?.dealsById;
  if (!deals || typeof deals !== 'object') return true;
  for (const deal of Object.values(deals)) {
    const fields = deal?.customFields;
    if (Array.isArray(fields) && fields.length > 0) return false;
  }
  return true;
}

function mergePreserveIdentity(snapshot, existing) {
  if (!existing) return snapshot;
  const rawData = snapshot.rawData && typeof snapshot.rawData === 'object' ? { ...snapshot.rawData } : {};
  if (incomingLacksDealCustomFields(rawData) && existing.raw_data?.dealsById) {
    const nextDeals = { ...(rawData.dealsById || {}) };
    for (const [id, oldDeal] of Object.entries(existing.raw_data.dealsById)) {
      const incoming = nextDeals[id];
      const oldFields = oldDeal?.customFields;
      if (!Array.isArray(oldFields) || oldFields.length === 0) continue;
      if (!incoming) {
        nextDeals[id] = oldDeal;
        continue;
      }
      const newFields = incoming.customFields;
      if (!Array.isArray(newFields) || newFields.length === 0) {
        nextDeals[id] = {
          ...incoming,
          customFields: oldFields,
          tags: Array.isArray(incoming.tags) && incoming.tags.length ? incoming.tags : oldDeal.tags,
        };
      }
    }
    rawData.dealsById = nextDeals;
  }
  const fromRaw = extractCpfRgmFromRaw(rawData);
  const cpfNorm = snapshot.cpfNorm || existing.cpf_norm || normalizeCpf(fromRaw.cpf) || null;
  const rgmNorm = snapshot.rgmNorm || existing.rgm_norm || normalizeRgm(fromRaw.rgm) || null;
  const filledFieldCount = collectFilledBusinessPaths(rawData).size;
  return { ...snapshot, cpfNorm, rgmNorm, rawData, filledFieldCount };
}

export async function upsertSnapshot(snapshot, { syncLogId = null, fullSeenAt = null } = {}) {
  const existing = await loadExisting(snapshot.contactId);
  const merged = mergePreserveIdentity(snapshot, existing);
  let dataLossInserted = 0;
  const skipFalseLoss = incomingLacksDealCustomFields(snapshot.rawData);
  if (existing?.raw_data && !skipFalseLoss) {
    const diff = diffRemovedFields(existing.raw_data, merged.rawData);
    if (diff.removed.length) {
      dataLossInserted = (await recordDataLossEvent({ snapshot: merged, existing, diff, syncLogId })) ? 1 : 0;
    }
  }

  if (existing?.content_hash === merged.contentHash && existing?.is_deleted === false) {
    await query(
      `update novo_crm_person_cache
          set last_synced_at = now(),
              last_full_seen_at = coalesce($2, last_full_seen_at),
              source_updated_at = coalesce($3, source_updated_at)
        where contact_id = $1`,
      [merged.contactId, fullSeenAt, merged.sourceUpdatedAt]
    );
    return { upserted: 0, skipped: 1, dataLossInserted };
  }

  await query(
    `insert into novo_crm_person_cache
       (contact_id, primary_deal_id, contact_number, nome, phone_norm, email_norm,
        cpf_norm, rgm_norm, raw_data, filled_field_count, content_hash,
        source_updated_at, last_full_seen_at, is_deleted)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, false)
     on conflict (contact_id) do update set
       primary_deal_id = excluded.primary_deal_id,
       contact_number = excluded.contact_number,
       nome = excluded.nome,
       phone_norm = excluded.phone_norm,
       email_norm = excluded.email_norm,
       cpf_norm = excluded.cpf_norm,
       rgm_norm = excluded.rgm_norm,
       raw_data = excluded.raw_data,
       filled_field_count = excluded.filled_field_count,
       content_hash = excluded.content_hash,
       source_updated_at = excluded.source_updated_at,
       last_synced_at = now(),
       last_full_seen_at = coalesce(excluded.last_full_seen_at, novo_crm_person_cache.last_full_seen_at),
       is_deleted = false`,
    [
      merged.contactId,
      merged.primaryDealId,
      merged.contactNumber,
      merged.nome,
      merged.phoneNorm,
      merged.emailNorm,
      merged.cpfNorm,
      merged.rgmNorm,
      JSON.stringify(merged.rawData),
      merged.filledFieldCount,
      merged.contentHash,
      merged.sourceUpdatedAt,
      fullSeenAt,
    ]
  );
  return { upserted: 1, skipped: 0, dataLossInserted };
}

/**
 * Soft-delete só quem já tinha sido visto em um full anterior e sumiu neste.
 * Não apaga entradas só de incremental/ativação (last_full_seen_at null).
 */
export async function markDeletedNotSeenSince(fullSeenAt) {
  const { rowCount } = await query(
    `update novo_crm_person_cache
        set is_deleted = true,
            last_synced_at = now()
      where is_deleted = false
        and last_full_seen_at is not null
        and last_full_seen_at < $1::timestamptz`,
    [fullSeenAt]
  );
  return rowCount ?? 0;
}

/**
 * CPFs, RGMs, e-mails e telefones já presentes no cache (contatos ativos).
 * Usado pela idempotência do provisionamento — evita recriar quem já existe.
 * @returns {Promise<{ cpfs: Set<string>, rgms: Set<string>, emails: Set<string>, phones: Set<string> }>}
 */
export async function loadExistingCpfRgmSets() {
  const { rows } = await query(
    `select cpf_norm, rgm_norm, email_norm, phone_norm
       from novo_crm_person_cache
      where is_deleted = false`
  );
  const cpfs = new Set();
  const rgms = new Set();
  const emails = new Set();
  const phones = new Set();
  for (const r of rows) {
    const c = String(r.cpf_norm || '').replace(/\D/g, '');
    const g = String(r.rgm_norm || '').replace(/\D/g, '');
    const e = String(r.email_norm || '').trim().toLowerCase();
    const p = String(r.phone_norm || '').replace(/\D/g, '');
    if (c.length >= 11) cpfs.add(c);
    if (g) rgms.add(g);
    if (e.includes('@')) emails.add(e);
    if (p.length >= 10) phones.add(p);
  }
  return { cpfs, rgms, emails, phones };
}

export async function getCacheStats() {
  const [
    { rows: countRows },
    { rows: lastRows },
    { rows: runningRows },
    { rows: eventRows },
    { rows: stateRows },
    { rows: gapRows },
    lastFlagsRun,
    lastFieldsRun,
    lastOrphanDedupe,
  ] = await Promise.all([
    query(
      `select count(*)::int as total,
              count(*) filter (where is_deleted = false)::int as active
         from novo_crm_person_cache`
    ),
    query(
      `select *
         from novo_crm_cache_sync_log
        where finished_at is not null
        order by started_at desc
        limit 1`
    ),
    query(
      `select id, mode, started_at, contacts_total, contacts_seen,
              cache_upserted, batches_scanned, progress_updated_at
         from novo_crm_cache_sync_log
        where status = 'running' and finished_at is null
          and started_at > now() - interval '8 hours'
        order by started_at desc
        limit 1`
    ),
    query(
      `select count(*)::int as open_events
         from novo_crm_data_loss_events
        where acknowledged_at is null`
    ),
    query(`select * from novo_crm_cache_sync_state where key = 'contacts_deals'`),
    query(
      `select count(*) filter (
                where is_deleted = false
                  and (cpf_norm is null or btrim(cpf_norm) = '')
              )::int as missing_cpf,
              count(*) filter (
                where is_deleted = false
                  and (rgm_norm is null or btrim(rgm_norm) = '')
              )::int as missing_rgm,
              count(*) filter (
                where is_deleted = false
                  and (
                    cpf_norm is null or btrim(cpf_norm) = ''
                    or rgm_norm is null or btrim(rgm_norm) = ''
                    or phone_norm is null or btrim(phone_norm) = ''
                    or email_norm is null or btrim(email_norm) = ''
                    or nome is null or btrim(nome) = ''
                  )
              )::int as incomplete_fields
         from novo_crm_person_cache`
    ),
    getFlagsStageLastRun(),
    getFieldsLastRun(),
    getOrphanDedupeLastRun(),
  ]);

  // Antes da chave fields_last, o cron mode=fields gravava em flags_stage_last
  // e o card Att mostrava a madrugada. Reclassifica esse residual.
  let last_flags_sync = lastFlagsRun || null;
  let last_fields_sync = lastFieldsRun || null;
  if (isFieldsSyncMode(last_flags_sync)) {
    const flagsAt = Date.parse(String(last_flags_sync.finished_at || '')) || 0;
    const fieldsAt = Date.parse(String(last_fields_sync?.finished_at || '')) || 0;
    if (!last_fields_sync || flagsAt >= fieldsAt) last_fields_sync = last_flags_sync;
    last_flags_sync = null;
  }

  return {
    total: countRows[0]?.total ?? 0,
    active: countRows[0]?.active ?? 0,
    missing_cpf: gapRows[0]?.missing_cpf ?? 0,
    missing_rgm: gapRows[0]?.missing_rgm ?? 0,
    // KPI rápido (identidade/contato). O enrich scope=incomplete ainda varre os 10 campos.
    incomplete_fields: gapRows[0]?.incomplete_fields ?? 0,
    last_sync: lastRows[0] || null,
    running: runningRows[0] || null,
    open_data_loss_events: eventRows[0]?.open_events ?? 0,
    state: stateRows[0] || null,
    last_flags_sync,
    last_fields_sync,
    last_orphan_dedupe: lastOrphanDedupe || null,
  };
}

/**
 * Lista ativos do cache (para enrichment).
 * @param {{ scope?: 'cpf'|'rgm'|'incomplete'|'all_mapped', limit?: number }} [opts]
 */
export async function listActiveCacheRowsForEnrichment(opts = {}) {
  const scope = opts.scope || 'incomplete';
  const limit = Math.min(Math.max(Number(opts.limit) || 50000, 1), 100000);
  const { rows } = await query(
    `select contact_id, primary_deal_id, contact_number, nome,
            phone_norm, email_norm, cpf_norm, rgm_norm, raw_data, filled_field_count
       from novo_crm_person_cache
      where is_deleted = false
      order by contact_id
      limit $1`,
    [limit]
  );

  if (scope === 'all_mapped') return rows;
  if (scope === 'incomplete') {
    return rows.filter((r) => cacheRowHasIncompleteMappedFields(r));
  }
  if (scope === 'cpf') {
    return rows.filter((r) => !r.cpf_norm || String(r.cpf_norm).trim() === '');
  }
  if (scope === 'rgm') {
    return rows.filter((r) => !r.rgm_norm || String(r.rgm_norm).trim() === '');
  }
  return rows;
}

/** @deprecated KPI incomplete agora é SQL rápido; mantido por compat. */
export function invalidateIncompleteFieldsCache() {}


export async function listDataLossEvents({ limit = 100, acknowledged = false } = {}) {
  const { rows } = await query(
    `select *
       from novo_crm_data_loss_events
      where (
        ($2::boolean = false and acknowledged_at is null)
        or ($2::boolean = true and acknowledged_at is not null)
      )
      order by detected_at desc
      limit $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500), Boolean(acknowledged)]
  );
  return rows;
}

export async function acknowledgeDataLossEvent(id, acknowledgedBy = null) {
  const { rows } = await query(
    `update novo_crm_data_loss_events
        set acknowledged_at = now(),
            acknowledged_by = $2
      where id = $1
      returning *`,
    [id, acknowledgedBy]
  );
  return rows[0] || null;
}

function candidateKeys(item) {
  return {
    phone: normalizePhone(item?.telefone || item?.phone),
    cpf: normalizeCpf(item?.cpf),
    email: normalizeEmail(item?.email),
    rgm: normalizeRgm(item?.rgm),
  };
}

export async function resolveActivationBatch(items) {
  const decorated = (items || []).map((item, index) => ({ item, index, keys: candidateKeys(item) }));
  const phones = [...new Set(decorated.map((d) => d.keys.phone).filter(Boolean))];
  const cpfs = [...new Set(decorated.map((d) => d.keys.cpf).filter(Boolean))];
  const emails = [...new Set(decorated.map((d) => d.keys.email).filter(Boolean))];
  const rgms = [...new Set(decorated.map((d) => d.keys.rgm).filter(Boolean))];

  const { rows } = await query(
    `select contact_id, primary_deal_id, nome, phone_norm, email_norm, cpf_norm, rgm_norm, raw_data
       from novo_crm_person_cache
      where is_deleted = false
        and (
          (cardinality($1::text[]) > 0 and phone_norm = any($1::text[])) or
          (cardinality($2::text[]) > 0 and cpf_norm = any($2::text[])) or
          (cardinality($3::text[]) > 0 and email_norm = any($3::text[])) or
          (cardinality($4::text[]) > 0 and rgm_norm = any($4::text[]))
        )`,
    [phones, cpfs, emails, rgms]
  );

  const out = new Map();
  for (const d of decorated) {
    const scored = rows
      .map((r) => {
        let score = 0;
        let reason = '';
        if (d.keys.phone && r.phone_norm === d.keys.phone) {
          score = 40;
          reason = 'phone';
        } else if (d.keys.cpf && r.cpf_norm === d.keys.cpf) {
          score = 30;
          reason = 'cpf';
        } else if (d.keys.email && r.email_norm === d.keys.email) {
          score = 20;
          reason = 'email';
        } else if (d.keys.rgm && r.rgm_norm === d.keys.rgm) {
          score = 10;
          reason = 'rgm';
        }
        return score ? { row: r, score, reason } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || String(a.row.contact_id).localeCompare(String(b.row.contact_id)));

    if (!scored.length) {
      out.set(d.index, { status: 'not_found', reason: 'contact_not_found_novo_crm_cache' });
      continue;
    }
    const best = scored[0];
    const tied = scored.filter((s) => s.score === best.score);
    if (tied.length > 1) {
      out.set(d.index, {
        status: 'ambiguous',
        reason: `ambiguous_match_${best.reason}`,
        candidates: tied.map((s) => String(s.row.contact_id)).slice(0, 10),
      });
      continue;
    }
    out.set(d.index, {
      status: 'ok',
      reason: best.reason,
      contactId: String(best.row.contact_id),
      dealId: best.row.primary_deal_id ? String(best.row.primary_deal_id) : null,
      contact: best.row.raw_data?.contact || null,
      deal: best.row.primary_deal_id
        ? best.row.raw_data?.dealsById?.[String(best.row.primary_deal_id)] || null
        : null,
      raw: best.row.raw_data || null,
    });
  }
  return out;
}
