/**
 * Provisionamento / dedupe de órfãos + incompletos no Novo CRM.
 *
 * Match matriculados: e-mail **ou telefone** (além de cpf/rgm no sibling).
 *
 * Órfão (sem deal):
 *   - Criação desativada por decisão de produto (13/08/2026).
 *   - O dedupe atua somente em incompletos e duplicados.
 *
 * Incompleto (tem deal, sem CPF e/ou RGM no espelho):
 *   - Sibling “bom” → move deal(s) do contact ruim para Perdido.
 *   - Sem sibling → empty-only fill no deal (enrich leve).
 *
 * Nunca cria segundo contact. Nunca apaga contact.
 *
 * Anti-spam multi-curso (06/08): se sibling já tem dealCount >= N RGMs SIAA
 * do mesmo CPF (ou RGM vazio no live mas deals existem), NÃO recria.
 * Empty RGM writeback não desbloqueia create no próximo run.
 *
 * Env: NOVO_CRM_ORPHAN_* (delay/concurrency/max/offset/live_check)
 * scope: orphans | incomplete | both (default both no dedupe endpoint)
 */

import { randomUUID } from 'node:crypto';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import * as caaProtocolsRepo from '../repositories/caaProtocolsRepository.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import {
  extractMatriculadosMappedValues,
  resolveSituacaoCrm,
} from '../utils/novoCrmFieldMapping.js';
import {
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeRgm,
} from '../utils/novoCrmCacheNormalize.js';
import {
  caaClassifyCtx,
  classifyMatriculado,
  getNovoCrmDealFieldIds,
  getNovoCrmStageIds,
  isUntouchableStageId,
  titleCasePolo,
} from '../utils/novoCrmStageRules.js';
import { displayRgmFromMatriculadosRow } from '../utils/rgmDisplay.js';
import { marcoFieldPair } from '../utils/marcoRegulatorio.js';
import { fixaDateFieldPairs } from '../utils/fixaMatriculaDates.js';
import { baseRowFilterForCategory } from '../utils/inadPosSiaaImport.js';
import { cpfDigitsFromExcelCell } from '../utils/excelNumericCell.js';
import {
  addTagToDeal,
  createDeal,
  ensureTagByName,
  findDealForContact,
  getDeal,
  isNovoCrmApiConfigured,
  listDealsPage,
  updateDeal,
  updateDealCustomFields,
} from './novoCrmClient.js';
import { isNovoCrmWriteAllowedOnThisHost } from './novoCrmMatriculadosProvisionService.js';
import { warmContactFromLive } from './novoCrmCacheWarmService.js';

// Decisão de produto (13/08/2026): dedupe não provisiona negócios.
// Mantido como constante fechada também no backend para proteger callers
// antigos que ainda enviem scope=orphans|both.
const CREATE_ORPHAN_DEALS_ENABLED = false;
const DEDUPE_PLAN_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.NOVO_CRM_DEDUPE_PLAN_MAX_AGE_MS) || 2 * 60 * 60 * 1000
);

/** Último plano também fica em memória; o repositório é o fallback após restart. */
let lastDedupeActionPlan = null;

function cacheGenerationKey(state) {
  if (!state) return '';
  return JSON.stringify({
    cursor_updated_at: state.cursor_updated_at || null,
    cursor_id: state.cursor_id || null,
    updated_at: state.updated_at || null,
  });
}

/**
 * Guard live leve: 1 GET deals?contactId=. Se já existe deal, pula (órfão
 * deveria ter 0). Desligável via NOVO_CRM_ORPHAN_LIVE_CHECK=0 quando offset
 * cobre a run anterior.
 */
async function liveContactHasAnyDeal(contactId) {
  try {
    const deal = await findDealForContact(contactId);
    return Boolean(deal?.id);
  } catch (err) {
    console.warn('[novo-crm-orphan-provision] live check failed', contactId, err?.message || err);
    return true;
  }
}

function normalizeNameForCompare(v) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Nome do contact no CRM costuma ser apelido ("Bia", "Luh Oliveira") — não dá
 * para exigir igualdade. Só rejeitamos o caso perigoso: contact com nome
 * completo plausível que não compartilha nenhum token com o nome da fonte
 * (e-mail/telefone compartilhado entre pessoas diferentes).
 * @returns {boolean} true quando é seguro seguir
 */
function namesPlausiblyMatch(contactName, sourceName) {
  const a = normalizeNameForCompare(contactName).split(' ').filter((t) => t.length >= 3);
  const b = normalizeNameForCompare(sourceName).split(' ').filter((t) => t.length >= 3);
  if (!a.length || !b.length) return true;
  const overlap = a.some((ta) =>
    b.some((tb) => ta === tb || ta.startsWith(tb) || tb.startsWith(ta))
  );
  if (overlap) return true;
  return a.length < 2;
}

/** Match conservador para identificador compartilhável (e-mail/telefone). */
function namesShareIdentityToken(contactName, sourceName) {
  const a = normalizeNameForCompare(contactName).split(' ').filter((t) => t.length >= 3);
  const b = normalizeNameForCompare(sourceName).split(' ').filter((t) => t.length >= 3);
  if (!a.length || !b.length) return false;
  return a.some((ta) =>
    b.some((tb) => ta === tb || ta.startsWith(tb) || tb.startsWith(ta))
  );
}

/** CPF live confiável (descarta lixo tipo "9" → "00000000009"). */
function isLiveCpfTrustworthy(v) {
  const d = digits(v);
  return d.length === 11 && !/^0{6}/.test(d) && !/^(\d)\1{10}$/.test(d);
}

/** RGM live confiável. */
function isLiveRgmTrustworthy(v) {
  return digits(v).length >= 7;
}

function panelFieldValue(dealDetail, names) {
  const wanted = names.map((n) => n.toLowerCase());
  const fields = dealDetail?.dealPanelFields || dealDetail?.customFields || [];
  for (const f of fields) {
    const name = String(f?.name || f?.label || '')
      .trim()
      .toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
}

/** Deal ausente no CRM (cache stale após delete) — contamos como skip, não erro. */
function isDealMissingError(err) {
  const status = Number(err?.status);
  if (status === 404) return true;
  const msg = String(err?.message || err || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  return (
    msg.includes('nao encontrado') ||
    msg.includes('not found') ||
    msg.includes('negocio nao encontrado')
  );
}

/** Soft-log: 3 primeiras + a cada 100 (evita flood "Negócio não encontrado"). */
let _dealNotFoundLogCount = 0;
function noteDealNotFoundSoft(dealId, context) {
  _dealNotFoundLogCount += 1;
  if (_dealNotFoundLogCount <= 3 || _dealNotFoundLogCount % 100 === 0) {
    console.warn(
      `[novo-crm-orphan-provision] deal not found (stale) ${context || ''} deal=${dealId} total=${_dealNotFoundLogCount}`
    );
  }
}

/**
 * Lê stage + CPF/RGM de um deal ao vivo. `ok:false` quando a API falhou —
 * chamador deve tratar como "não sei" e não escrever.
 * `notFound:true` = deal apagado no CRM (espelho stale).
 */
async function liveDealIdentity(dealId) {
  try {
    const detail = await getDeal(dealId);
    if (!detail?.id) {
      noteDealNotFoundSoft(dealId, 'identity empty');
      return { ok: false, notFound: true };
    }
    return {
      ok: true,
      notFound: false,
      stageId: String(detail?.stage?.id || detail?.stageId || '').trim(),
      cpf: panelFieldValue(detail, ['cpf', 'documento', 'taxid']),
      rgm: panelFieldValue(detail, ['rgm']),
    };
  } catch (err) {
    if (isDealMissingError(err)) {
      noteDealNotFoundSoft(dealId, 'identity');
      return { ok: false, notFound: true };
    }
    console.warn('[novo-crm-orphan-provision] live deal read failed', dealId, err?.message || err);
    return { ok: false, notFound: false };
  }
}

const DEDUPE_PANEL_FIELDS = [
  'cpf',
  'rgm',
  'curso',
  'polo',
  'situação',
  'situacao',
  'nível',
  'nivel',
  'e-mail',
  'email',
  'e-mail ad',
  'email ad',
  'documentos pendentes',
  'doc pendentes',
  'inadimplente',
  'acesso blackboard',
  'acessoblack',
  'evasão',
  'evasao',
];

/** Telefone BR plausível: DDD + 8/9 dígitos (com ou sem 55). */
function isPlausibleBrPhone(v) {
  const d = digits(v);
  const local = d.startsWith('55') ? d.slice(2) : d;
  return local.length === 10 || local.length === 11;
}

function isPlausibleEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v ?? '').trim());
}

/**
 * Leitura live rica de um deal para escolher qual card sobrevive num grupo de
 * duplicados. `ok:false` = não sei → grupo inteiro é pulado.
 * `notFound:true` = deal apagado (contagem not_found no progresso).
 */
async function liveDealForDedupe(dealId) {
  try {
    const detail = await getDeal(dealId);
    if (!detail?.id) {
      noteDealNotFoundSoft(dealId, 'dedupe empty');
      return { ok: false, notFound: true };
    }
    const fields = detail?.dealPanelFields || detail?.customFields || [];
    let filled = 0;
    for (const f of fields) {
      const name = String(f?.name || f?.label || '').trim().toLowerCase();
      if (!DEDUPE_PANEL_FIELDS.includes(name)) continue;
      if (f?.value != null && String(f.value).trim() !== '') filled += 1;
    }
    const contact = detail.contact || {};
    return {
      ok: true,
      notFound: false,
      dealId: String(detail.id),
      number: detail.number ?? null,
      title: detail.title || null,
      stageId: String(detail?.stage?.id || detail?.stageId || '').trim(),
      stageName: detail?.stage?.name || null,
      rgm: panelFieldValue(detail, ['rgm']),
      cpf: panelFieldValue(detail, ['cpf', 'documento', 'taxid']),
      ownerId: detail.ownerId || detail.owner?.id || null,
      filledFields: filled,
      notes: (detail.notes || []).length + (detail.activities || []).length,
      createdAt: detail.createdAt || null,
      contactId: String(detail.contactId || contact.id || ''),
      contactName: contact.name || null,
      contactEmailOk: isPlausibleEmail(contact.email),
      contactPhoneOk: isPlausibleBrPhone(contact.phone),
      conversations: (contact.conversations || []).length,
    };
  } catch (err) {
    if (isDealMissingError(err)) {
      noteDealNotFoundSoft(dealId, 'dedupe');
      return { ok: false, notFound: true };
    }
    console.warn('[novo-crm-orphan-provision] live dedupe read failed', dealId, err?.message || err);
    return { ok: false, notFound: false };
  }
}

/**
 * Mesmo shape de `liveDealForDedupe`, lido do espelho (`novo_crm_person_cache`).
 * Prévia (dry_run) usa isto — não satura a API. Conversas/notes não vêm no
 * snapshot; o score ainda decide por dono + campos SIAA + e-mail/telefone.
 */
function cacheDealForDedupe(deal, row) {
  const fields = deal?.customFields || deal?.dealPanelFields || [];
  let filled = 0;
  for (const f of fields) {
    const name = String(f?.name || f?.label || '').trim().toLowerCase();
    if (!DEDUPE_PANEL_FIELDS.includes(name)) continue;
    if (f?.value != null && String(f.value).trim() !== '') filled += 1;
  }
  const contact = row?.raw_data?.contact || {};
  return {
    ok: true,
    notFound: false,
    dealId: String(deal.id),
    number: deal.number ?? null,
    title: deal.title || null,
    stageId: String(deal?.stageId || deal?.stage?.id || '').trim(),
    stageName: deal?.stageName || deal?.stage?.name || null,
    rgm: dealCustomValue(deal, ['rgm']),
    cpf: dealCustomValue(deal, ['cpf', 'documento', 'taxid']),
    ownerId: deal.ownerId || deal.owner?.id || null,
    filledFields: filled,
    notes: 0,
    createdAt: deal.createdAt || null,
    contactId: String(row.contact_id || contact.id || ''),
    contactName: row.nome || contact.name || null,
    contactEmailOk: isPlausibleEmail(row.email_norm || contact.email),
    contactPhoneOk: isPlausibleBrPhone(row.phone_norm || contact.phone),
    conversations: 0,
  };
}

function indexCacheDealsById(cacheRows) {
  /** @type {Map<string, { deal: object, row: object }>} */
  const map = new Map();
  for (const row of cacheRows || []) {
    for (const deal of dealsFromCacheRow(row)) {
      const id = String(deal?.id || '').trim();
      if (id) map.set(id, { deal, row });
    }
  }
  return map;
}

/**
 * Score de sobrevivência de um card duplicado (maior vence).
 * Ordem acordada: dono → campos SIAA preenchidos → e-mail → telefone →
 * conversa (desempate) → mais antigo (fora do score, no sort).
 *
 * A conversa fica no *contato*, não no negócio, e não se perde quando o card
 * vai para Perdido — por isso pesa menos que a qualidade do cadastro
 * (pares 30/07: o card com conversa era o "Lead #21136153" sem e-mail).
 */
function dedupeSurvivorScore(d, expectedName = '') {
  let s = 0;
  const dealName = normalizeNameForCompare(d.contactName || d.title);
  const officialName = normalizeNameForCompare(expectedName);
  if (officialName && dealName === officialName) s += 5000;
  else if (officialName && namesShareIdentityToken(dealName, officialName)) s += 2000;
  if (d.ownerId) s += 1000;
  s += (d.filledFields || 0) * 10;
  if (d.contactEmailOk) s += 30;
  if (d.contactPhoneOk) s += 20;
  if (d.conversations > 0) s += 15;
  if (d.notes > 0) s += 5;
  return s;
}

function pickDedupeSurvivor(deals, expectedName = '') {
  return [...deals].sort((a, b) => {
    const diff =
      dedupeSurvivorScore(b, expectedName) - dedupeSurvivorScore(a, expectedName);
    if (diff) return diff;
    const ta = Date.parse(a.createdAt || '') || Number.MAX_SAFE_INTEGER;
    const tb = Date.parse(b.createdAt || '') || Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return Number(a.number || 0) - Number(b.number || 0);
  })[0];
}

function dealStageIdFromCache(deal) {
  return String(deal?.stageId || deal?.stage?.id || '').trim();
}

/**
 * Identidade live no CRM (RGMs + CPFs em TODOS os deals do contact).
 * Usado no path sibling — cache local fica stale entre runs / com SKIP_FIELDS.
 */
async function liveIdentityOnContact(contactId) {
  const rgms = new Set();
  const cpfs = new Set();
  let dealCount = 0;
  try {
    const page = await listDealsPage({ contactId, page: 1, perPage: 100 });
    const items = page.items || [];
    dealCount = items.length;
    for (const d of items) {
      if (!d?.id) continue;
      let detail = d;
      const hasPanel = Array.isArray(d.dealPanelFields) || Array.isArray(d.customFields);
      if (!hasPanel) {
        try {
          detail = (await getDeal(d.id)) || d;
        } catch {
          detail = d;
        }
      }
      const rgm = normalizeRgm(panelFieldValue(detail, ['rgm']));
      const cpf = normalizeCpf(panelFieldValue(detail, ['cpf', 'documento', 'taxid']));
      if (rgm) rgms.add(rgm);
      if (cpf) cpfs.add(cpf);
    }
  } catch (err) {
    console.warn('[novo-crm-orphan-provision] live identity failed', contactId, err?.message || err);
    return { rgms, cpfs, dealCount: -1, ok: false };
  }
  return { rgms, cpfs, dealCount, ok: true };
}

const DELAY_MS = Math.max(
  0,
  Number(process.env.NOVO_CRM_ORPHAN_PROVISION_DELAY_MS ?? 20) || 0
);

/**
 * Tag CRM de limpeza: `limpeza_duplicata_DD.MM.YYYY` (data local Brasil).
 * @param {Date} [d]
 * @returns {string}
 */
export function limpezaDuplicataTagName(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `limpeza_duplicata_${get('day')}.${get('month')}.${get('year')}`;
}

function orphanConcurrency() {
  return Math.min(Math.max(Number(process.env.NOVO_CRM_ORPHAN_PROVISION_CONCURRENCY) || 2, 1), 4);
}

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function simNao(v) {
  return v ? 'Sim' : 'Não';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultMaxCreates() {
  return Math.min(Math.max(Number(process.env.NOVO_CRM_ORPHAN_PROVISION_MAX_PER_RUN) || 20000, 1), 20000);
}

/**
 * Índice matriculados por e-mail e telefone → grupo de deals (por RGM).
 * @param {string} snapshotId
 * @returns {Promise<{ byEmail: Map<string, Map<string, object>>, byPhone: Map<string, Map<string, object>> }>}
 */
async function buildAlunoMatchIndex(snapshotId) {
  /** @type {Map<string, Map<string, object>>} */
  const byEmail = new Map();
  /** @type {Map<string, Map<string, object>>} */
  const byPhone = new Map();

  const addTo = (map, key, item) => {
    if (!key) return;
    let group = map.get(key);
    if (!group) {
      group = new Map();
      map.set(key, group);
    }
    const gkey = item.rgm || `_norgm_${group.size}`;
    if (!group.has(gkey)) group.set(gkey, item);
  };

  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', snapshotId, (row) => {
    const mapped = extractMatriculadosMappedValues(row);
    const cpf = normalizeCpf(cpfDigitsFromExcelCell(mapped.cpf || row.CPF || ''));
    const rgmDisp = displayRgmFromMatriculadosRow(row);
    const rgm = normalizeRgm(rgmDisp || mapped.rgm);
    const phone = normalizePhone(mapped._phone || mapped.telefone_comercial);
    const item = { row, mapped, cpf, rgm, curso: mapped.curso, phone };

    const email1 = normalizeEmail(mapped._email);
    const email2 = normalizeEmail(mapped.e_mail_ad);
    addTo(byEmail, email1, item);
    if (email2 && email2 !== email1) addTo(byEmail, email2, item);
    addTo(byPhone, phone, item);
  });

  return { byEmail, byPhone };
}

/**
 * @param {string} category
 * @returns {Promise<Set<string>>} cpfs + rgms
 */
async function loadIdSetFromBase(category) {
  const set = new Set();
  const snap = await baseUploadRepo.getLatestSnapshot(category);
  if (!snap?.id) return set;
  const rowFilter = baseRowFilterForCategory(category);
  await baseUploadRepo.forEachRowDataForSnapshot(category, snap.id, (row) => {
    if (rowFilter && !rowFilter(row)) return;
    const cpf = digits(row.CPF || row.cpf || row.Cpf);
    const rgm = digits(row.RGM || row.rgm || row.Rgm || row.RGM_ALUN);
    if (cpf.length >= 11) set.add(`cpf:${cpf}`);
    if (rgm) set.add(`rgm:${rgm}`);
  });
  return set;
}

function inSet(set, cpf, rgm) {
  if (cpf && set.has(`cpf:${cpf}`)) return true;
  if (rgm && set.has(`rgm:${rgm}`)) return true;
  return false;
}

function dealsFromCacheRow(row) {
  const raw = row?.raw_data || {};
  const byId = raw.dealsById && typeof raw.dealsById === 'object' ? raw.dealsById : {};
  return Object.values(byId);
}

function dealCustomValue(deal, names) {
  const wanted = names.map((n) => n.toLowerCase());
  const sources = [];
  if (Array.isArray(deal?.customFields)) sources.push(...deal.customFields);
  if (Array.isArray(deal?.dealPanelFields)) sources.push(...deal.dealPanelFields);
  for (const f of sources) {
    const name = String(f?.name || f?.label || '')
      .trim()
      .toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
}

/**
 * Agrupa cartões candidatos a dedupe por RGM.
 *
 * Seed: contact com o RGM em qualquer deal (ou rgm_norm). Depois:
 *  1) expande por CPF (outros contacts com mesmo CPF e RGM vazio / igual);
 *  2) puxa TODOS os deals do contact (mesmo sem RGM no espelho / etapa stale
 *     no cache) — a conferência live filtra Perdido/untouchable e RGM
 *     conflitante.
 *
 * Cobre Nicole (45528446): 2 contacts, 3 deals — um survivor com RGM no
 * cache + irmão sem customFields no espelho (antes some do grupo e ficava
 * 2 Graduação abertos após mover só 1).
 *
 * @param {object[]} cacheRows
 * @returns {Map<string, Array<{ dealId: string, contactId: string }>>}
 */
function buildDedupeDealGroups(cacheRows) {
  /** @type {Map<string, Set<string>>} */
  const contactsByRgm = new Map();
  /** @type {Map<string, string>} */
  const cpfByContact = new Map();
  /** @type {Map<string, object>} */
  const rowByContact = new Map();

  for (const row of cacheRows) {
    const cid = String(row.contact_id || '').trim();
    if (!cid) continue;
    rowByContact.set(cid, row);

    const cpfRow = normalizeCpf(row.cpf_norm);
    if (cpfRow) cpfByContact.set(cid, cpfRow);

    const rgmRow = normalizeRgm(row.rgm_norm);
    if (rgmRow) {
      let s = contactsByRgm.get(rgmRow);
      if (!s) {
        s = new Set();
        contactsByRgm.set(rgmRow, s);
      }
      s.add(cid);
    }

    for (const deal of dealsFromCacheRow(row)) {
      const rgm = normalizeRgm(dealCustomValue(deal, ['rgm']));
      const cpfDeal = normalizeCpf(dealCustomValue(deal, ['cpf', 'documento', 'taxid']));
      if (cpfDeal) cpfByContact.set(cid, cpfDeal);
      if (!rgm) continue;
      let s = contactsByRgm.get(rgm);
      if (!s) {
        s = new Set();
        contactsByRgm.set(rgm, s);
      }
      s.add(cid);
    }
  }

  /** @type {Map<string, Set<string>>} */
  const contactsByCpf = new Map();
  for (const [cid, cpf] of cpfByContact) {
    let s = contactsByCpf.get(cpf);
    if (!s) {
      s = new Set();
      contactsByCpf.set(cpf, s);
    }
    s.add(cid);
  }

  // 2º passo no nível contact: mesmo CPF com RGM vazio ou idêntico.
  for (const [rgm, cset] of contactsByRgm) {
    const extras = [];
    for (const cid of cset) {
      const cpf = cpfByContact.get(cid);
      if (!cpf) continue;
      for (const other of contactsByCpf.get(cpf) || []) {
        if (other === cid || cset.has(other)) continue;
        const otherRow = rowByContact.get(other);
        if (!otherRow) continue;
        const otherRgms = rgmsOnCacheRow(otherRow);
        if (otherRgms.size === 0 || otherRgms.has(rgm)) extras.push(other);
      }
    }
    for (const e of extras) cset.add(e);
  }

  /** @type {Map<string, Array<{ dealId: string, contactId: string }>>} */
  const dealGroups = new Map();
  for (const [rgm, cset] of contactsByRgm) {
    /** @type {Array<{ dealId: string, contactId: string }>} */
    const arr = [];
    for (const cid of cset) {
      const row = rowByContact.get(cid);
      if (!row) continue;
      for (const deal of dealsFromCacheRow(row)) {
        const dealId = String(deal?.id || '').trim();
        if (!dealId) continue;
        const dealRgm = normalizeRgm(dealCustomValue(deal, ['rgm']));
        // Outro curso / outro RGM no mesmo contact — não puxa.
        if (dealRgm && dealRgm !== rgm) continue;
        // Inclui Perdido/untouchable no cache (stage stale): live filtra.
        if (!arr.some((d) => d.dealId === dealId)) {
          arr.push({ dealId, contactId: cid });
        }
      }
    }
    if (arr.length > 1) dealGroups.set(`rgm:${rgm}`, arr);
  }

  // Clones sem RGM nunca entram no índice acima. Acrescenta identidades fortes;
  // a conferência live recusa depois qualquer grupo com 2+ RGMs válidos.
  const identityGroups = new Map();
  const addIdentity = (key, dealId, contactId) => {
    if (!key || !dealId) return;
    let byDeal = identityGroups.get(key);
    if (!byDeal) {
      byDeal = new Map();
      identityGroups.set(key, byDeal);
    }
    byDeal.set(String(dealId), { dealId: String(dealId), contactId: String(contactId) });
  };
  for (const row of cacheRows) {
    const cid = String(row.contact_id || '').trim();
    if (!cid) continue;
    const deals = dealsFromCacheRow(row);
    const rowCpf = normalizeCpf(row.cpf_norm);
    const rowName = normalizeNameForCompare(row.nome || row.raw_data?.contact?.name);
    const rowPhone = normalizePhone(row.phone_norm || row.raw_data?.contact?.phone);
    const rowEmail = normalizeEmail(row.email_norm || row.raw_data?.contact?.email);
    for (const deal of deals) {
      const dealId = String(deal?.id || '').trim();
      if (!dealId) continue;
      const dealCpf =
        normalizeCpf(dealCustomValue(deal, ['cpf', 'documento', 'taxid'])) || rowCpf;
      addIdentity(`contact:${cid}`, dealId, cid);
      if (dealCpf) addIdentity(`cpf:${dealCpf}`, dealId, cid);
      // Telefone/e-mail isolados são compartilháveis (família/assessoria).
      // Nome exato normalizado evita fundir pessoas diferentes.
      if (rowName && rowPhone) addIdentity(`name_phone:${rowName}|${rowPhone}`, dealId, cid);
      if (rowName && rowEmail) addIdentity(`name_email:${rowName}|${rowEmail}`, dealId, cid);
    }
  }
  for (const [key, byDeal] of identityGroups) {
    const arr = [...byDeal.values()];
    if (arr.length > 1) dealGroups.set(key, arr);
  }
  return dealGroups;
}

/** RGMs presentes em qualquer deal do contact (+ denorm rgm_norm). */
function rgmsOnCacheRow(row) {
  const set = new Set();
  if (row.rgm_norm) {
    const g = normalizeRgm(row.rgm_norm);
    if (g) set.add(g);
  }
  for (const deal of dealsFromCacheRow(row)) {
    const g = normalizeRgm(dealCustomValue(deal, ['rgm']));
    if (g) set.add(g);
  }
  return set;
}

function addToMultiMap(map, key, value) {
  if (!key) return;
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  if (!arr.includes(value)) arr.push(value);
}

/**
 * Índices do cache (contact_id, email, phone, cpf, rgm).
 */
function buildCacheIndices(cacheRows) {
  const byContactId = new Map();
  const byEmail = new Map();
  const byPhone = new Map();
  const byCpf = new Map();
  const byRgm = new Map();

  for (const row of cacheRows) {
    const id = String(row.contact_id);
    byContactId.set(id, row);

    const email1 = normalizeEmail(row.email_norm);
    const email2 = normalizeEmail(row.raw_data?.contact?.email);
    addToMultiMap(byEmail, email1, id);
    if (email2 && email2 !== email1) addToMultiMap(byEmail, email2, id);

    const phone1 = normalizePhone(row.phone_norm);
    const phone2 = normalizePhone(row.raw_data?.contact?.phone);
    addToMultiMap(byPhone, phone1, id);
    if (phone2 && phone2 !== phone1) addToMultiMap(byPhone, phone2, id);

    const cpf1 = normalizeCpf(row.cpf_norm);
    addToMultiMap(byCpf, cpf1, id);

    for (const rgm of rgmsOnCacheRow(row)) addToMultiMap(byRgm, rgm, id);

    for (const deal of dealsFromCacheRow(row)) {
      const cpf2 = normalizeCpf(dealCustomValue(deal, ['cpf', 'documento', 'taxid']));
      if (cpf2) addToMultiMap(byCpf, cpf2, id);
    }
  }

  return { byContactId, byEmail, byPhone, byCpf, byRgm };
}

function siblingCompletenessScore(row) {
  if (!row) return 0;
  let s = 0;
  if (normalizeCpf(row.cpf_norm)) s += 2;
  if (rgmsOnCacheRow(row).size > 0) s += 2;
  if (row.primary_deal_id || dealsFromCacheRow(row).length > 0) s += 1;
  return s;
}

/**
 * Sibling com deal que compartilha email/phone/cpf/rgm. Prefere o mais completo.
 * @returns {string|null}
 */
function findSiblingContactId(orphanContactId, keys, indices, sourceName = '') {
  const candidateIds = new Set();
  for (const e of keys.emails || []) for (const id of indices.byEmail.get(e) || []) candidateIds.add(id);
  for (const p of keys.phones || []) for (const id of indices.byPhone.get(p) || []) candidateIds.add(id);
  for (const c of keys.cpfs || []) for (const id of indices.byCpf.get(c) || []) candidateIds.add(id);
  for (const r of keys.rgms || []) for (const id of indices.byRgm.get(r) || []) candidateIds.add(id);
  candidateIds.delete(String(orphanContactId));

  const withDeal = [...candidateIds].filter((id) => {
    const row = indices.byContactId.get(id);
    if (!row || (!row.primary_deal_id && dealsFromCacheRow(row).length === 0)) return false;
    // E-mail/telefone de assessoria podem pertencer a vários alunos.
    return !sourceName || namesShareIdentityToken(sourceName, row.nome || row.raw_data?.contact?.name);
  });
  if (!withDeal.length) return null;
  withDeal.sort((a, b) => {
    const sa = siblingCompletenessScore(indices.byContactId.get(a));
    const sb = siblingCompletenessScore(indices.byContactId.get(b));
    return sb - sa || String(a).localeCompare(String(b));
  });
  return withDeal[0];
}

function contactPhones(row) {
  return [
    normalizePhone(row.phone_norm),
    normalizePhone(row.raw_data?.contact?.phone),
  ].filter(Boolean);
}

function contactEmails(row) {
  return [
    normalizeEmail(row.email_norm),
    normalizeEmail(row.raw_data?.contact?.email),
  ].filter(Boolean);
}

/** Tem deal mas falta CPF e/ou RGM no espelho. */
function isIncompleteWithDeal(row) {
  if (!row.primary_deal_id && dealsFromCacheRow(row).length === 0) return false;
  const hasCpf = Boolean(normalizeCpf(row.cpf_norm));
  const hasRgm = rgmsOnCacheRow(row).size > 0 || Boolean(normalizeRgm(row.rgm_norm));
  return !hasCpf || !hasRgm;
}

/**
 * @param {object} fieldIds
 * @param {object} mapped
 * @param {object} row
 * @param {object} classification
 */
function buildDealValues(fieldIds, mapped, row, classification) {
  return [
    digits(mapped.cpf) ? { fieldId: fieldIds.cpf, value: digits(mapped.cpf) } : null,
    digits(mapped.rgm) ? { fieldId: fieldIds.rgm, value: digits(mapped.rgm) } : null,
    mapped.curso ? { fieldId: fieldIds.curso, value: mapped.curso } : null,
    ...(() => {
      const fixa = fixaDateFieldPairs(fieldIds, digits(mapped.rgm));
      if (fixa.length) return fixa;
      return mapped.data_matricula && fieldIds.data_matricula
        ? [{ fieldId: fieldIds.data_matricula, value: mapped.data_matricula }]
        : [];
    })(),
    marcoFieldPair(fieldIds, row),
    mapped.polo ? { fieldId: fieldIds.polo, value: titleCasePolo(mapped.polo) || mapped.polo } : null,
    (() => {
      const situacao = resolveSituacaoCrm(mapped.situacao || row['Situação Matrícula'], {
        inRematricula: Boolean(classification.meta?.inRematricula),
      });
      return situacao ? { fieldId: fieldIds.situacao, value: situacao } : null;
    })(),
    mapped.nivel && fieldIds.nivel ? { fieldId: fieldIds.nivel, value: mapped.nivel } : null,
    mapped._email ? { fieldId: fieldIds.email, value: mapped._email } : null,
    mapped.e_mail_ad ? { fieldId: fieldIds.email_ad, value: mapped.e_mail_ad } : null,
    row['Data Nascimento']
      ? { fieldId: fieldIds.nasc, value: String(row['Data Nascimento']).slice(0, 10) }
      : null,
    { fieldId: fieldIds.doc_pendentes, value: simNao(classification.flags.doc_pendentes) },
    { fieldId: fieldIds.inadimplente, value: simNao(classification.flags.inadimplente) },
    fieldIds.financeiro
      ? { fieldId: fieldIds.financeiro, value: simNao(classification.flags.financeiro) }
      : null,
    fieldIds.caa ? { fieldId: fieldIds.caa, value: simNao(classification.flags.caa) } : null,
    { fieldId: fieldIds.acessoblack, value: simNao(classification.flags.acessoblack) },
    { fieldId: fieldIds.evasao, value: simNao(classification.flags.evasao) },
    fieldIds.atualizado ? { fieldId: fieldIds.atualizado, value: 'Sim' } : null,
  ].filter((x) => x && x.fieldId);
}

/**
 * @param {{
 *   dryRun?: boolean,
 *   maxCreates?: number,
 *   jobId?: string|null,
 *   scope?: 'orphans'|'incomplete'|'both',
 *   offset?: number,
 *   liveCheck?: boolean,
 * }} [opts]
 */
export async function runOrphanAlunoProvision(opts = {}) {
  const dryRun = opts.dryRun !== false;
  const maxCreates = Math.min(Math.max(Number(opts.maxCreates) || defaultMaxCreates(), 1), 20000);
  const jobId = opts.jobId || null;
  const scopeRaw = String(opts.scope || 'orphans').trim().toLowerCase();
  const scope = ['orphans', 'incomplete', 'duplicates', 'both'].includes(scopeRaw)
    ? scopeRaw
    : 'orphans';
  const doOrphans =
    CREATE_ORPHAN_DEALS_ENABLED && (scope === 'orphans' || scope === 'both');
  const doIncomplete = scope === 'incomplete' || scope === 'both';
  const doDuplicates = scope === 'duplicates' || scope === 'both';

  if (!dryRun) {
    if (!isNovoCrmApiConfigured()) {
      const err = new Error('NOVO_CRM_ENABLED/TOKEN não configurados para gravar.');
      err.status = 503;
      throw err;
    }
    if (!isNovoCrmWriteAllowedOnThisHost()) {
      const err = new Error(
        'Provisionamento de órfãos bloqueado neste host. Use CRM DEV ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL explícita.'
      );
      err.status = 403;
      throw err;
    }
  }

  const runStartedAt = Date.now();
  _dealNotFoundLogCount = 0;
  let cancelled = false;
  let dealNotFound = 0;
  let planFallbackReason = null;
  let phaseStartedAt = Date.now();
  let phaseProcessedBase = 0;

  /** Contadores expostos no job (sempre definidos — evita TDZ no tickProgress). */
  const counters = {
    orphans_total: 0,
    orphans_processed: 0,
    incomplete_total: 0,
    incomplete_processed: 0,
    dup_groups: 0,
    dup_groups_processed: 0,
    already_has_deal: 0,
    would_create: 0,
    live_ok: 0,
    errors: 0,
  };
  /** @type {Array<Record<string, unknown>>} */
  const plannedMoves = [];
  /** @type {Array<Record<string, unknown>>} */
  const plannedFills = [];

  const patchJob = (p) => {
    if (!jobId) return;
    const entry = jobs.get(jobId);
    if (!entry) return;
    Object.assign(entry, p);
  };

  const checkCancel = () => {
    if (!jobId) return false;
    const j = jobs.get(jobId);
    if (j?.cancel_requested) {
      cancelled = true;
      return true;
    }
    return false;
  };

  /**
   * Atualiza progresso rico + ETA por fase.
   * @param {Record<string, unknown>} extra
   */
  const tickProgress = (extra = {}) => {
    if (!jobId) return;
    const entry = jobs.get(jobId);
    if (!entry) return;
    const total = Number(extra.total != null ? extra.total : entry.total) || 0;
    const processed = Number(extra.processed != null ? extra.processed : entry.processed) || 0;
    const elapsedPhase = Math.max(1, Date.now() - phaseStartedAt);
    const doneInPhase = Math.max(0, processed - phaseProcessedBase);
    const rate = doneInPhase > 0 ? doneInPhase / elapsedPhase : 0;
    const remaining = total > 0 ? Math.max(0, total - processed) : 0;
    const etaMs = rate > 0 && remaining > 0 ? Math.round(remaining / rate) : null;
    Object.assign(entry, {
      ...counters,
      deal_not_found: dealNotFound,
      cancel_requested: Boolean(entry.cancel_requested),
      eta_ms: etaMs,
      ...extra,
      total,
      processed,
      failed: counters.errors,
      sent: dryRun ? counters.would_create : Number(extra.sent != null ? extra.sent : entry.sent) || 0,
    });
  };

  const beginPhase = (phase, total, message) => {
    phaseStartedAt = Date.now();
    phaseProcessedBase = 0;
    tickProgress({
      phase,
      total,
      processed: 0,
      status_message: message,
      eta_ms: null,
    });
  };

  /**
   * Apply rápido: usa somente os writes descobertos pela prévia. Cada alvo e
   * keeper ainda passa por GET live antes de qualquer mutação.
   */
  const tryApplySavedPlan = async () => {
    if (dryRun) return null;
    const currentState = await cacheRepo.getSyncState();
    const currentGeneration = cacheGenerationKey(currentState);
    let plan = lastDedupeActionPlan;
    if (!plan) {
      try {
        plan = await cacheRepo.getOrphanDedupePlan();
      } catch (err) {
        console.warn('[novo-crm-orphan-provision] load action plan failed:', err?.message || err);
      }
    }

    const createdAtMs = Date.parse(plan?.created_at || '');
    const staleReason =
      !plan
        ? 'prévia sem plano acionável'
        : plan.consumed_at
          ? 'plano da prévia já aplicado'
          : plan.scope !== scope
            ? `escopo mudou (${plan.scope || 'n/a'} → ${scope})`
            : !createdAtMs || Date.now() - createdAtMs > DEDUPE_PLAN_MAX_AGE_MS
              ? 'prévia expirou (mais de 2h)'
              : plan.cache_generation !== currentGeneration
                ? 'cache mudou após a prévia'
                : null;
    if (staleReason) {
      planFallbackReason = staleReason;
      patchJob({
        plan_fallback: true,
        plan_fallback_reason: staleReason,
        status_message: `Prévia ausente/desatualizada (${staleReason}); recalculando…`,
      });
      return null;
    }

    lastDedupeActionPlan = plan;
    const moves = Array.isArray(plan.moves) ? plan.moves : [];
    const fills = Array.isArray(plan.fills) ? plan.fills : [];
    const total = moves.length + fills.length;
    const fieldIds = getNovoCrmDealFieldIds();
    const perdidoStageId = String(getNovoCrmStageIds().Perdido || '').trim();
    const tagName = String(plan.tag_name || limpezaDuplicataTagName()).trim();
    let tagId = '';
    try {
      const ensured = await ensureTagByName(tagName);
      tagId = ensured.tagId;
    } catch (tagErr) {
      const msg = tagErr?.message || String(tagErr);
      const failed = {
        ok: false,
        cancelled: false,
        dry_run: false,
        status: 'failed',
        error: msg,
        scope,
        tag_name: tagName,
        tags_applied: 0,
        tags_failed: 0,
        errors: 1,
        error_samples: [{ type: 'tag_create', error: msg }],
      };
      patchJob({
        phase: 'done',
        status: 'failed',
        finished_at: new Date().toISOString(),
        result: failed,
        status_message: msg,
      });
      try {
        await cacheRepo.saveOrphanDedupeLastRun({
          ...failed,
          finished_at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn('[novo-crm-orphan-provision] save tag-fail apply failed:', err?.message || err);
      }
      return failed;
    }
    let processed = 0;
    let movesApplied = 0;
    let incompleteMovesApplied = 0;
    let duplicateMovesApplied = 0;
    let fillsApplied = 0;
    let skipped = 0;
    let errors = 0;
    let notFound = 0;
    let tagsApplied = 0;
    let tagsFailed = 0;
    const errorSamples = [];

    beginPhase('apply_plan', total, `Aplicando plano da prévia: ${moves.length} Perdido · ${fills.length} fills…`);
    const report = () => {
      counters.errors = errors;
      tickProgress({
        phase: 'apply_plan',
        total,
        processed,
        sent: movesApplied + fillsApplied,
        failed: errors,
        deal_not_found: notFound,
        plan_moves_total: moves.length,
        plan_moves_applied: movesApplied,
        plan_fills_total: fills.length,
        plan_fills_applied: fillsApplied,
        status_message:
          `Aplicando ${movesApplied}/${moves.length} Perdido · ${fillsApplied}/${fills.length} fills` +
          (skipped ? ` · pulados ${skipped}` : '') +
          (notFound ? ` · not_found ${notFound}` : ''),
      });
    };

    const pairStillValid = (target, keeper, action) => {
      if (!target?.ok || !keeper?.ok) return false;
      if (
        !keeper.stageId ||
        keeper.stageId === perdidoStageId
      ) {
        return false;
      }
      const expectedRgm = normalizeRgm(action.expected_rgm);
      const keeperRgm = normalizeRgm(keeper.rgm);
      if (expectedRgm && isLiveRgmTrustworthy(keeper.rgm) && keeperRgm !== expectedRgm) {
        return false;
      }
      const expectedCpf = normalizeCpf(action.expected_cpf);
      const keeperCpf = normalizeCpf(keeper.cpf);
      if (expectedCpf && isLiveCpfTrustworthy(keeper.cpf) && keeperCpf !== expectedCpf) {
        return false;
      }
      if (action.reason === 'duplicate') {
        if (target.contactId && target.contactId === keeper.contactId) return true;
        const targetCpf = normalizeCpf(target.cpf);
        if (
          isLiveCpfTrustworthy(target.cpf) &&
          isLiveCpfTrustworthy(keeper.cpf) &&
          targetCpf === keeperCpf
        ) {
          return true;
        }
        return namesPlausiblyMatch(
          target.contactName || target.title,
          keeper.contactName || keeper.title
        );
      }
      return namesPlausiblyMatch(
        target.contactName || target.title || action.target_name,
        keeper.contactName || keeper.title || action.keeper_name
      );
    };

    for (const action of moves) {
      if (checkCancel()) break;
      try {
        const [target, keeper] = await Promise.all([
          liveDealForDedupe(action.target_deal_id),
          liveDealForDedupe(action.keeper_deal_id),
        ]);
        if (!target.ok || !keeper.ok) {
          if (target.notFound || keeper.notFound) notFound += 1;
          skipped += 1;
        } else if (
          target.stageId === perdidoStageId ||
          isUntouchableStageId(target.stageId) ||
          !pairStillValid(target, keeper, action)
        ) {
          skipped += 1;
        } else {
          await updateDeal(action.target_deal_id, { stageId: perdidoStageId });
          movesApplied += 1;
          if (action.reason === 'duplicate') duplicateMovesApplied += 1;
          else incompleteMovesApplied += 1;
          const values = [
            action.situacao && fieldIds.situacao
              ? { fieldId: fieldIds.situacao, value: action.situacao }
              : null,
            fieldIds.atualizado ? { fieldId: fieldIds.atualizado, value: 'Sim' } : null,
          ].filter(Boolean);
          if (values.length) {
            await updateDealCustomFields(action.target_deal_id, values, { maxRetries: 4 });
          }
          try {
            await addTagToDeal(action.target_deal_id, { tagId, tagName });
            tagsApplied += 1;
          } catch (tagErr) {
            tagsFailed += 1;
            console.warn(
              '[novo-crm-orphan-provision] planned tag failed',
              action.target_deal_id,
              tagErr?.message || tagErr
            );
            if (errorSamples.length < 25) {
              errorSamples.push({
                type: 'tag',
                deal_id: action.target_deal_id,
                error: tagErr?.message || String(tagErr),
              });
            }
          }
          if (DELAY_MS > 0) await sleep(DELAY_MS);
        }
      } catch (err) {
        errors += 1;
        if (errorSamples.length < 25) {
          errorSamples.push({
            type: 'planned_move',
            deal_id: action.target_deal_id,
            error: err?.message || String(err),
          });
        }
      }
      processed += 1;
      report();
    }

    for (const action of fills) {
      if (checkCancel()) break;
      try {
        const live = await liveDealIdentity(action.target_deal_id);
        if (!live.ok) {
          if (live.notFound) notFound += 1;
          skipped += 1;
        } else if (
          live.stageId === perdidoStageId ||
          isUntouchableStageId(live.stageId)
        ) {
          skipped += 1;
        } else {
          const values = (Array.isArray(action.fields) ? action.fields : []).filter((f) => {
            const current = f.campo === 'cpf' ? live.cpf : live.rgm;
            return f.campo === 'cpf'
              ? !isLiveCpfTrustworthy(current)
              : !isLiveRgmTrustworthy(current);
          });
          if (!values.length) {
            skipped += 1;
          } else {
            await updateDealCustomFields(
              action.target_deal_id,
              values.map((f) => ({ fieldId: f.field_id, value: f.value })),
              { maxRetries: 4 }
            );
            fillsApplied += 1;
            if (DELAY_MS > 0) await sleep(DELAY_MS);
          }
        }
      } catch (err) {
        errors += 1;
        if (errorSamples.length < 25) {
          errorSamples.push({
            type: 'planned_fill',
            deal_id: action.target_deal_id,
            error: err?.message || String(err),
          });
        }
      }
      processed += 1;
      report();
    }

    const wasCancelled = cancelled || checkCancel();
    const result = {
      ok: !wasCancelled,
      cancelled: wasCancelled,
      dry_run: false,
      scope,
      applied_from_preview_plan: true,
      plan_created_at: plan.created_at,
      matriculados_snapshot_id: plan.matriculados_snapshot_id || null,
      orphan_deal_creation_disabled: true,
      orphans_total: 0,
      orphans_scanned: 0,
      orphan_aluno: 0,
      orphan_no_match: 0,
      matched_email: 0,
      matched_phone: 0,
      dup_contact_skip: 0,
      dup_skip_no_deal: 0,
      dup_to_perdido: plan.incomplete_moves || 0,
      deals_moved_perdido: incompleteMovesApplied,
      incomplete_total: plan.incomplete_total || 0,
      incomplete_scanned: 0,
      incomplete_enriched: fillsApplied,
      dup_deal_groups: plan.dup_deal_groups || 0,
      dup_deals_moved_perdido: duplicateMovesApplied,
      created_deals: 0,
      errors,
      deal_not_found: notFound,
      plan_actions_total: total,
      plan_actions_processed: processed,
      plan_moves_total: moves.length,
      plan_moves_applied: movesApplied,
      plan_fills_total: fills.length,
      plan_fills_applied: fillsApplied,
      plan_skipped: skipped,
      tag_name: tagName,
      tags_applied: tagsApplied,
      tags_failed: tagsFailed,
      error_samples: errorSamples,
    };
    patchJob({
      phase: 'done',
      status: wasCancelled ? 'cancelled' : 'completed',
      finished_at: new Date().toISOString(),
      result,
      eta_ms: null,
      status_message: wasCancelled
        ? 'Aplicação do plano cancelada'
        : `Plano aplicado: ${movesApplied}/${moves.length} Perdido · ${fillsApplied}/${fills.length} fills`,
    });
    if (!wasCancelled) plan.consumed_at = new Date().toISOString();
    plan.consumed_result = {
      moves_applied: movesApplied,
      fills_applied: fillsApplied,
      skipped,
      errors,
    };
    lastDedupeActionPlan = plan;
    try {
      await Promise.all([
        cacheRepo.saveOrphanDedupePlan(plan),
        cacheRepo.saveOrphanDedupeLastRun({
          finished_at: new Date().toISOString(),
          ok: !wasCancelled,
          cancelled: wasCancelled,
          dry_run: false,
          status: wasCancelled ? 'cancelled' : 'completed',
          scope,
          applied_from_preview_plan: true,
          incomplete_total: plan.incomplete_total || 0,
          incomplete_enriched: fillsApplied,
          dup_to_perdido: plan.incomplete_moves || 0,
          deals_moved_perdido: incompleteMovesApplied,
          dup_deal_groups: plan.dup_deal_groups || 0,
          dup_deals_moved_perdido: duplicateMovesApplied,
          errors,
          deal_not_found: notFound,
          tag_name: tagName,
          tags_applied: tagsApplied,
          tags_failed: tagsFailed,
        }),
      ]);
    } catch (err) {
      console.warn('[novo-crm-orphan-provision] save planned apply failed:', err?.message || err);
    }
    return result;
  };

  if (checkCancel()) {
    patchJob({
      phase: 'done',
      status: 'cancelled',
      finished_at: new Date().toISOString(),
      status_message: 'Cancelado antes de iniciar',
    });
    return { ok: false, cancelled: true, dry_run: dryRun, scope };
  }

  const plannedApplyResult = await tryApplySavedPlan();
  if (plannedApplyResult) return plannedApplyResult;
  const scanCacheGeneration = cacheGenerationKey(await cacheRepo.getSyncState());

  beginPhase(
    'load_matriculados',
    0,
    planFallbackReason
      ? `Prévia ausente/desatualizada (${planFallbackReason}); refazendo varredura completa…`
      : 'Indexando matriculados (e-mail + telefone)…'
  );
  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap?.id) {
    const err = new Error('Nenhum snapshot de matriculados encontrado. Faça upload em Bases.');
    err.status = 400;
    throw err;
  }
  const { byEmail, byPhone } = await buildAlunoMatchIndex(matSnap.id);
  // Lookup SIAA por CPF/RGM — alinhar Situação ao mandar card pra Perdido (dedupe).
  /** @type {Map<string, Record<string, unknown>>} */
  const byRgmMat = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const byCpfMat = new Map();
  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
    const m = extractMatriculadosMappedValues(row);
    const cpf = normalizeCpf(m.cpf);
    const rgm = normalizeRgm(m.rgm);
    if (rgm && !byRgmMat.has(rgm)) byRgmMat.set(rgm, row);
    if (cpf && !byCpfMat.has(cpf)) byCpfMat.set(cpf, row);
  });

  if (checkCancel()) {
    patchJob({
      phase: 'done',
      status: 'cancelled',
      finished_at: new Date().toISOString(),
      status_message: 'Cancelado',
    });
    return { ok: false, cancelled: true, dry_run: dryRun, scope };
  }

  beginPhase('load_bases', 0, 'Carregando bases satélite…');
  const [remat, caaT0Map, caaSeen, doc, inadGrad, inadPos, fin, bb, evasao] =
    await Promise.all([
      loadIdSetFromBase('rematricula'),
      caaProtocolsRepo.loadOpenCaaT0Map(),
      caaProtocolsRepo.loadSeenCaaIdSet(),
      loadIdSetFromBase('docs-pendentes'),
      loadIdSetFromBase('inadimplentes-vencidos'),
      loadIdSetFromBase('inadimplentes-pos-siaa'),
      loadIdSetFromBase('financeiro'),
      loadIdSetFromBase('acessos-blackboard'),
      loadIdSetFromBase('provavel-evasao'),
    ]);
  // Flag «Financeira»: vencidos da Graduação + inadimplentes da Pós.
  const inad = new Set([...inadGrad, ...inadPos]);

  beginPhase('scan_mirror', 0, 'Escaneando espelho (órfãos / incompletos)…');
  const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({ scope: 'all_mapped', limit: 100000 });
  const indices = buildCacheIndices(cacheRows);
  const orphans = doOrphans
    ? cacheRows.filter((r) => !r.primary_deal_id && dealsFromCacheRow(r).length === 0)
    : [];
  const incompletes = doIncomplete ? cacheRows.filter((r) => isIncompleteWithDeal(r)) : [];
  counters.orphans_total = orphans.length;
  counters.incomplete_total = incompletes.length;

  const fieldIds = getNovoCrmDealFieldIds();
  const perdidoStageId = String(getNovoCrmStageIds().Perdido || '').trim();
  const offset = Math.max(0, Number(opts.offset ?? process.env.NOVO_CRM_ORPHAN_OFFSET) || 0);
  const liveCheckEnv = String(process.env.NOVO_CRM_ORPHAN_LIVE_CHECK ?? '1').trim();
  const liveCheck =
    opts.liveCheck != null ? Boolean(opts.liveCheck) : liveCheckEnv !== '0' && liveCheckEnv !== 'false';
  const concurrency = dryRun ? 1 : orphanConcurrency();
  /** Tag de auditoria no deal movido a Perdido por limpeza. BRT. */
  const limpezaDupTagName = limpezaDuplicataTagName();
  let limpezaDupTagId = '';
  if (!dryRun) {
    try {
      const ensured = await ensureTagByName(limpezaDupTagName);
      limpezaDupTagId = ensured.tagId;
    } catch (tagErr) {
      const msg = tagErr?.message || String(tagErr);
      const failed = {
        ok: false,
        cancelled: false,
        dry_run: false,
        status: 'failed',
        error: msg,
        scope,
        tag_name: limpezaDupTagName,
        tags_applied: 0,
        tags_failed: 0,
        errors: 1,
        error_samples: [{ type: 'tag_create', error: msg }],
      };
      patchJob({
        phase: 'done',
        status: 'failed',
        finished_at: new Date().toISOString(),
        result: failed,
        status_message: msg,
      });
      try {
        await cacheRepo.saveOrphanDedupeLastRun({
          ...failed,
          finished_at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn('[novo-crm-orphan-provision] save tag-fail apply failed:', err?.message || err);
      }
      return failed;
    }
  }

  /**
   * Card forçado pra Perdido (duplicata) não é fila de rematrícula: grava Situação
   * SIAA sem forçar "Sem Rematrícula" (inRematricula=false) — cancel→Cancelado,
   * EM CURSO→Em Curso. Evita lixo no filtro Kanban Perdido+Sem Rematrícula.
   * @param {string} dealId
   * @param {{ rgm?: string, cpf?: string }} id
   */
  async function alignSitAfterPerdidoMove(dealId, id) {
    const sitFid = String(fieldIds?.situacao || '').trim();
    if (!sitFid || !dealId) return;
    const mat =
      (id.rgm && byRgmMat.get(id.rgm)) || (id.cpf && byCpfMat.get(id.cpf)) || null;
    if (!mat) return;
    const mapped = extractMatriculadosMappedValues(mat);
    const sit = resolveSituacaoCrm(mapped.situacao || mat['Situação Matrícula'], {
      inRematricula: false,
    });
    if (!sit) return;
    /** @type {Array<{fieldId:string,value:string}>} */
    const vals = [{ fieldId: sitFid, value: sit }];
    if (fieldIds?.atualizado) vals.push({ fieldId: fieldIds.atualizado, value: 'Sim' });
    await updateDealCustomFields(dealId, vals, { maxRetries: 4 });
  }

  function plannedSituacao(id) {
    const mat =
      (id.rgm && byRgmMat.get(id.rgm)) || (id.cpf && byCpfMat.get(id.cpf)) || null;
    if (!mat) return null;
    const mapped = extractMatriculadosMappedValues(mat);
    return (
      resolveSituacaoCrm(mapped.situacao || mat['Situação Matrícula'], {
        inRematricula: false,
      }) || null
    );
  }

  /**
   * Best-effort: etapa Perdido já aplicada; falha de tag só loga + conta.
   * @param {string} dealId
   */
  async function tagLimpezaDuplicataBestEffort(dealId) {
    const id = String(dealId || '').trim();
    if (!id) return;
    try {
      await addTagToDeal(id, {
        tagId: limpezaDupTagId || undefined,
        tagName: limpezaDupTagName,
      });
      tagsApplied += 1;
    } catch (err) {
      tagsFailed += 1;
      console.warn(
        '[novo-crm-orphan-provision] tag limpeza_duplicata failed',
        id,
        limpezaDupTagName,
        err?.message || err
      );
    }
  }

  let scanned = 0;
  let orphanAluno = 0;
  let orphanNoMatch = 0;
  let matchedEmail = 0;
  let matchedPhone = 0;
  let dupContactSkip = 0;
  let dupSkipNoDeal = 0;
  let dupToPerdido = 0;
  let dealsMovedPerdido = 0;
  let incompleteScanned = 0;
  let incompleteNoMatch = 0;
  let incompleteEnriched = 0;
  let incompleteAmbiguous = 0;
  let incompleteNameMismatch = 0;
  let incompleteLiveAlreadyOk = 0;
  let incompleteLiveConflict = 0;
  let incompleteLiveUnknown = 0;
  let perdidoSkippedLive = 0;
  let perdidoLiveUnknown = 0;
  let dupGroups = 0;
  let dupDealsExtra = 0;
  let dupDealsMoved = 0;
  let dupResolvedLive = 0;
  let dupLiveUnknown = 0;
  let dupCrossContact = 0;
  let dupNameMismatch = 0;
  let dupMultiRgmSkipped = 0;
  let dupStoppedAtMax = false;
  let dealsWouldCreateOnOrphan = 0;
  let dealsWouldCreateOnSibling = 0;
  let createdDeals = 0;
  let errors = 0;
  let tagsApplied = 0;
  let tagsFailed = 0;
  let skippedAlreadyHasDeal = 0;
  let skippedDuplicateRgm = 0;
  let skippedCpfCapacity = 0;
  let warmedCache = 0;
  let warmCacheErrors = 0;
  let stoppedAtMax = false;
  /** @type {Array<object>} */
  const samples = [];
  /** @type {Array<object>} */
  const errorSamples = [];
  /** @type {Array<object>} amostras do que foi barrado pelas travas de segurança */
  const skipSamples = [];
  /** @type {Set<string>} claim `${contactId}:${rgm}` na run — evita spam concorrente/reentry */
  const claimedDealKeys = new Set();
  /** @type {Map<string, { rgms: Set<string>, cpfs: Set<string> }>} identidade live memoizada */
  const liveIdentityCache = new Map();

  const skipFieldsAll = String(process.env.NOVO_CRM_ORPHAN_SKIP_FIELDS || '').trim() === '1';

  patchJob({
    phase: 'live_check_orphans',
    total: orphans.length,
    processed: offset,
    status_message:
      orphans.length === 0
        ? 'Sem órfãos no espelho — pulando…'
        : dryRun
          ? `Conferindo ${orphans.length} órfãos ao vivo…`
          : `Criando deals para ${orphans.length} órfãos…`,
  });
  phaseStartedAt = Date.now();
  phaseProcessedBase = offset;
  counters.orphans_processed = offset;

  console.log(
    `[novo-crm-orphan-provision] start dry=${dryRun} scope=${scope} max=${maxCreates} offset=${offset} conc=${concurrency} orphans=${orphans.length} incompletes=${incompletes.length}`
  );

  const atMax = () => dealsWouldCreateOnOrphan + dealsWouldCreateOnSibling >= maxCreates;

  function claimKey(contactId, rgm, cpf) {
    const id = String(contactId);
    const keys = [];
    if (rgm) keys.push(`${id}:rgm:${rgm}`);
    else if (cpf) keys.push(`${id}:cpf:${cpf}`);
    else keys.push(`${id}:norgm`);
    for (const k of keys) {
      if (claimedDealKeys.has(k)) return false;
    }
    for (const k of keys) claimedDealKeys.add(k);
    return true;
  }

  function rememberCreatedIdentity(contactId, rgm, cpf) {
    const id = String(contactId);
    addToMultiMap(indices.byRgm, rgm, id);
    addToMultiMap(indices.byCpf, cpf, id);
    let live = liveIdentityCache.get(id);
    if (!live) {
      live = { rgms: new Set(), cpfs: new Set() };
      liveIdentityCache.set(id, live);
    }
    if (rgm) live.rgms.add(rgm);
    if (cpf) live.cpfs.add(cpf);
    const cacheRow = indices.byContactId.get(id);
    if (cacheRow && rgm) {
      // Mantém rgmsOnCacheRow coerente na mesma run (mesmo sem fields no CRM ainda).
      cacheRow.rgm_norm = cacheRow.rgm_norm || rgm;
    }
  }

  async function getMergedSiblingIdentity(siblingId, siblingRow) {
    const id = String(siblingId);
    const fromCache = rgmsOnCacheRow(siblingRow);
    const cpfsCache = new Set();
    const cpf1 = normalizeCpf(siblingRow?.cpf_norm);
    if (cpf1) cpfsCache.add(cpf1);
    for (const deal of dealsFromCacheRow(siblingRow)) {
      const c = normalizeCpf(dealCustomValue(deal, ['cpf', 'documento', 'taxid']));
      if (c) cpfsCache.add(c);
    }

    let live = liveIdentityCache.get(id);
    if (!live) {
      // Sempre consulta API no path sibling (dry ou apply) — cache stale foi a
      // causa raiz do spam de deals (Everton / Flor, 28/07).
      const fetched = await liveIdentityOnContact(id);
      live = { rgms: fetched.rgms, cpfs: fetched.cpfs, dealCount: fetched.dealCount, ok: fetched.ok };
      liveIdentityCache.set(id, live);
    }

    const rgms = new Set([...fromCache, ...live.rgms]);
    const cpfs = new Set([...cpfsCache, ...live.cpfs]);
    const dealCount =
      live.dealCount != null && live.dealCount >= 0
        ? Math.max(live.dealCount, dealsFromCacheRow(siblingRow).length)
        : Math.max(fromCache.size, dealsFromCacheRow(siblingRow).length);
    return { rgms, cpfs, dealCount, liveOk: live.ok !== false };
  }

  async function createOneDeal({ contactId, nome, it, classification }) {
    if (!CREATE_ORPHAN_DEALS_ENABLED) {
      throw new Error('Criação de negócios pelo dedupe está desativada.');
    }
    const rgm = it.rgm || '';
    const cpf = it.cpf || normalizeCpf(digits(it.mapped?.cpf));
    if (!claimKey(contactId, rgm, cpf)) {
      skippedDuplicateRgm += 1;
      return null;
    }
    const deal = await createDeal({ title: nome, contactId, stageId: classification.stageId });
    createdDeals += 1;
    // Mesmo com SKIP_FIELDS=1, grava CPF+RGM — sem isso o dedupe sibling
    // não vê o RGM e recria o mesmo deal em runs seguintes (incidente 28/07).
    const values = skipFieldsAll
      ? [
          cpf ? { fieldId: fieldIds.cpf, value: cpf } : null,
          rgm ? { fieldId: fieldIds.rgm, value: rgm } : null,
        ].filter(Boolean)
      : buildDealValues(fieldIds, it.mapped, it.row, classification);
    if (values.length) {
      try {
        await updateDealCustomFields(deal.id, values, { maxRetries: 4 });
      } catch (fieldErr) {
        if (errorSamples.length < 25) {
          errorSamples.push({
            orphan_contact_id: contactId,
            deal_id: deal.id,
            rgm,
            error: `fields: ${fieldErr?.message || fieldErr}`,
          });
        }
        // Não deixa clone vazio vivo: se o write-back de CPF/RGM falhar,
        // quarentena o card recém-criado e permite uma futura run tentar de novo.
        try {
          await updateDeal(deal.id, { stageId: perdidoStageId });
          await tagLimpezaDuplicataBestEffort(deal.id);
        } catch (cleanupErr) {
          throw new Error(
            `fields: ${fieldErr?.message || fieldErr}; quarantine: ${cleanupErr?.message || cleanupErr}`
          );
        }
        throw new Error(`fields: ${fieldErr?.message || fieldErr}; deal enviado para Perdido`);
      }
    }
    rememberCreatedIdentity(contactId, rgm, cpf);
    try {
      await cacheRepo.markPrimaryDealId(contactId, deal.id);
    } catch {
      /* best-effort */
    }
    // Só registra a identidade depois que CPF/RGM foram persistidos.
    if (rgm || cpf) {
      let live = liveIdentityCache.get(String(contactId));
      if (!live) {
        live = { rgms: new Set(), cpfs: new Set(), dealCount: 0, ok: true };
        liveIdentityCache.set(String(contactId), live);
      }
      if (rgm) live.rgms.add(rgm);
      if (cpf) live.cpfs.add(cpf);
      live.dealCount = Math.max(Number(live.dealCount) || 0, 0) + 1;
    }
    if (DELAY_MS > 0) await sleep(DELAY_MS);
    return deal;
  }

  async function processOrphanAt(i) {
    if (cancelled || checkCancel() || stoppedAtMax || atMax()) {
      if (atMax()) stoppedAtMax = true;
      return;
    }
    const row = orphans[i];
    scanned += 1;

    const reportOrphanProgress = () => {
      counters.orphans_processed = Math.max(i + 1, offset);
      counters.already_has_deal = skippedAlreadyHasDeal;
      counters.would_create = dealsWouldCreateOnOrphan + dealsWouldCreateOnSibling;
      counters.live_ok = Math.max(0, orphanAluno + skippedAlreadyHasDeal);
      counters.errors = errors;
      tickProgress({
        processed: Math.max(i + 1, offset),
        total: orphans.length,
        sent: dryRun ? counters.would_create : createdDeals,
        failed: errors,
        status_message:
          (dryRun
            ? `Órfãos ${Math.max(i + 1, offset)}/${orphans.length} · já tinham negócio ${skippedAlreadyHasDeal} · a criar ${counters.would_create}`
            : `Órfãos ${Math.max(i + 1, offset)}/${orphans.length} · criados ${createdDeals}`) +
          (dealNotFound ? ` · not_found ${dealNotFound}` : ''),
      });
    };

    const emailCandidates = contactEmails(row);
    const phoneCandidates = contactPhones(row);
    let group = null;
    let matchedKey = null;
    let matchVia = null;
    for (const e of emailCandidates) {
      if (byEmail.has(e)) {
        group = byEmail.get(e);
        matchedKey = e;
        matchVia = 'email';
        break;
      }
    }
    if (!group) {
      for (const p of phoneCandidates) {
        if (byPhone.has(p)) {
          group = byPhone.get(p);
          matchedKey = p;
          matchVia = 'phone';
          break;
        }
      }
    }
    if (!group) {
      orphanNoMatch += 1;
      reportOrphanProgress();
      return;
    }
    orphanAluno += 1;
    if (matchVia === 'email') matchedEmail += 1;
    if (matchVia === 'phone') matchedPhone += 1;

    const rawItems = [...group.values()];
    const sourceNames = new Set(
      rawItems.map((it) => normalizeNameForCompare(it.mapped?._nome_full)).filter(Boolean)
    );
    const items = rawItems.filter((it) =>
      sourceNames.size > 1
        ? namesShareIdentityToken(row.nome, it.mapped?._nome_full)
        : namesPlausiblyMatch(row.nome, it.mapped?._nome_full)
    );
    if (!items.length) {
      orphanNoMatch += 1;
      if (skipSamples.length < 25) {
        skipSamples.push({
          type: 'shared_contact_identity_mismatch',
          contact_id: row.contact_id,
          nome: row.nome,
          match_via: matchVia,
          match_key: matchedKey,
        });
      }
      reportOrphanProgress();
      return;
    }
    const emailsSet = new Set(emailCandidates);
    const phonesSet = new Set(phoneCandidates);
    for (const it of items) {
      const e2 = normalizeEmail(it.mapped.e_mail_ad);
      if (e2) emailsSet.add(e2);
      const e3 = normalizeEmail(it.mapped._email);
      if (e3) emailsSet.add(e3);
      const ph = normalizePhone(it.phone || it.mapped._phone);
      if (ph) phonesSet.add(ph);
    }
    const cpfsSet = new Set(items.map((it) => it.cpf).filter(Boolean));
    const rgmsSet = new Set(items.map((it) => it.rgm).filter(Boolean));

    const siblingId = findSiblingContactId(
      row.contact_id,
      { emails: emailsSet, phones: phonesSet, cpfs: cpfsSet, rgms: rgmsSet },
      indices,
      row.nome
    );

    if (siblingId) {
      const siblingRow = indices.byContactId.get(siblingId);
      const siblingIdStr = String(siblingId);
      // Sempre cruza com identidade live (API) — cache sozinho gerou spam
      // de deals no sibling quando SKIP_FIELDS deixava RGM vazio (28/07).
      const siblingIdent = await getMergedSiblingIdentity(siblingIdStr, siblingRow);
      const siblingRgms = siblingIdent.rgms;
      const siblingCpfs = siblingIdent.cpfs;

      const siaaRgms = new Set(items.map((it) => it.rgm).filter(Boolean));
      const cpfShared = items.some((it) => it.cpf && siblingCpfs.has(it.cpf));
      // Capacidade: CPF já tem N deals ≥ N RGMs SIAA → não recria
      // (cobre empty RGM writeback: live sem RGM mas dealCount já cobre).
      const capacityCovered =
        cpfShared &&
        siaaRgms.size > 0 &&
        siblingIdent.dealCount >= 0 &&
        siblingIdent.dealCount >= siaaRgms.size;
      // Live sem RGM em nenhum deal, mas já existem deals do CPF
      // (= field write falhou / stale) → não inventa card novo.
      const emptyRgmWritebackSpam =
        cpfShared &&
        siblingIdent.dealCount > 0 &&
        siblingRgms.size === 0 &&
        siaaRgms.size > 0;

      const missingItems = items.filter((it) => {
        if (capacityCovered || emptyRgmWritebackSpam) return false;
        if (it.rgm && siblingRgms.has(it.rgm)) return false;
        // Sem RGM: se sibling já tem qualquer deal / mesmo CPF, não inventa outro.
        if (!it.rgm) {
          if (siblingIdent.dealCount > 0) return false;
          if (it.cpf && siblingCpfs.has(it.cpf)) return false;
        }
        // Mesmo CPF + sibling já cobre esse RGM via claim da run.
        if (it.rgm && claimedDealKeys.has(`${siblingIdStr}:rgm:${it.rgm}`)) return false;
        return true;
      });

      if (!missingItems.length) {
        if (capacityCovered || emptyRgmWritebackSpam) skippedCpfCapacity += 1;
        dupContactSkip += 1;
        dupSkipNoDeal += 1;
        if (samples.length < 25) {
          samples.push({
            type:
              emptyRgmWritebackSpam
                ? 'dup_skip_empty_rgm_writeback'
                : capacityCovered
                  ? 'dup_skip_cpf_capacity'
                  : 'dup_skip_no_deal',
            orphan_contact_id: row.contact_id,
            sibling_contact_id: siblingId,
            match_via: matchVia,
            match_key: matchedKey,
            rgms: [...rgmsSet],
            sibling_rgms: [...siblingRgms],
            sibling_deal_count: siblingIdent.dealCount,
            siaa_rgm_count: siaaRgms.size,
          });
        }
        reportOrphanProgress();
        return;
      }

      for (const it of missingItems) {
        if (atMax()) {
          stoppedAtMax = true;
          break;
        }
        // Re-check claim/live após creates anteriores no mesmo loop/workers.
        if (it.rgm && (siblingRgms.has(it.rgm) || claimedDealKeys.has(`${siblingIdStr}:rgm:${it.rgm}`))) {
          skippedDuplicateRgm += 1;
          continue;
        }
        dealsWouldCreateOnSibling += 1;
        const classification = classifyMatriculado(it.row, {
          inRematricula: inSet(remat, it.cpf, it.rgm),
          ...caaClassifyCtx(caaProtocolsRepo.lookupCaaT0(caaT0Map, it.cpf, it.rgm), {
            seen: inSet(caaSeen, it.cpf, it.rgm),
          }),
          inDoc: inSet(doc, it.cpf, it.rgm),
          inInad: inSet(inad, it.cpf, it.rgm),
          inFinanceiro: inSet(fin, it.cpf, it.rgm),
          inBb: inSet(bb, it.cpf, it.rgm),
          inEvasao: inSet(evasao, it.cpf, it.rgm),
        });
        if (samples.length < 25) {
          samples.push({
            type: 'extra_deal_on_sibling',
            orphan_contact_id: row.contact_id,
            sibling_contact_id: siblingId,
            match_via: matchVia,
            match_key: matchedKey,
            rgm: it.rgm,
            curso: it.curso,
            stage: classification.stageName,
          });
        }
        if (!dryRun) {
          try {
            const nome = siblingRow?.nome || it.mapped._nome_full || 'Aluno SIAA';
            const created = await createOneDeal({
              contactId: siblingId,
              nome,
              it,
              classification,
            });
            if (created && it.rgm) siblingRgms.add(it.rgm);
            if (created && it.cpf) siblingCpfs.add(it.cpf);
          } catch (err) {
            errors += 1;
            if (errorSamples.length < 25) {
              errorSamples.push({
                orphan_contact_id: row.contact_id,
                sibling_contact_id: siblingId,
                rgm: it.rgm,
                error: err?.message || String(err),
              });
            }
          }
        }
      }
    } else {
      // Orphan path: live-check default ON, inclusive na prévia — o índice de
      // deals do full sync perde registros e cria falsos órfãos no espelho.
      // Quem já tem negócio ao vivo é sincronizado no espelho e sai da conta.
      if (liveCheck && (await liveContactHasAnyDeal(row.contact_id))) {
        skippedAlreadyHasDeal += 1;
        try {
          await warmContactFromLive(String(row.contact_id));
          warmedCache += 1;
        } catch (err) {
          warmCacheErrors += 1;
          console.warn(
            `[novo-crm-orphan-provision] warm cache contact=${row.contact_id}:`,
            err?.message || err
          );
        }
        reportOrphanProgress();
        return;
      }
      const orphanRgms = rgmsOnCacheRow(row);
      for (const it of items) {
        if (atMax()) {
          stoppedAtMax = true;
          break;
        }
        if (it.rgm && (orphanRgms.has(it.rgm) || claimedDealKeys.has(`${row.contact_id}:rgm:${it.rgm}`))) {
          skippedDuplicateRgm += 1;
          continue;
        }
        dealsWouldCreateOnOrphan += 1;
        const classification = classifyMatriculado(it.row, {
          inRematricula: inSet(remat, it.cpf, it.rgm),
          ...caaClassifyCtx(caaProtocolsRepo.lookupCaaT0(caaT0Map, it.cpf, it.rgm), {
            seen: inSet(caaSeen, it.cpf, it.rgm),
          }),
          inDoc: inSet(doc, it.cpf, it.rgm),
          inInad: inSet(inad, it.cpf, it.rgm),
          inFinanceiro: inSet(fin, it.cpf, it.rgm),
          inBb: inSet(bb, it.cpf, it.rgm),
          inEvasao: inSet(evasao, it.cpf, it.rgm),
        });
        if (samples.length < 25) {
          samples.push({
            type: 'orphan_aluno',
            orphan_contact_id: row.contact_id,
            match_via: matchVia,
            match_key: matchedKey,
            rgm: it.rgm,
            curso: it.curso,
            stage: classification.stageName,
          });
        }
        if (!dryRun) {
          try {
            const nome = row.nome || it.mapped._nome_full || 'Aluno SIAA';
            const created = await createOneDeal({
              contactId: row.contact_id,
              nome,
              it,
              classification,
            });
            if (created && it.rgm) orphanRgms.add(it.rgm);
          } catch (err) {
            errors += 1;
            if (errorSamples.length < 25) {
              errorSamples.push({
                orphan_contact_id: row.contact_id,
                rgm: it.rgm,
                error: err?.message || String(err),
              });
            }
          }
        }
      }
    }

    reportOrphanProgress();
  }

  let nextIndex = offset;
  const worker = async () => {
    while (true) {
      if (cancelled || checkCancel() || stoppedAtMax || atMax()) return;
      const idx = nextIndex++;
      if (idx >= orphans.length) return;
      await processOrphanAt(idx);
    }
  };
  if (orphans.length > 0 && !cancelled) {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  // === INCOMPLETE PASS ===
  if (!cancelled && checkCancel()) {
    /* flag set */
  }
  if (!cancelled && doIncomplete && incompletes.length > 0) {
    beginPhase(
      'process_incomplete',
      incompletes.length,
      `Processando incompletos (${incompletes.length})…`
    );

    let incIdx = 0;
    const reportIncProgress = () => {
      counters.incomplete_processed = incIdx;
      counters.errors = errors;
      counters.already_has_deal = skippedAlreadyHasDeal;
      counters.would_create = dealsWouldCreateOnOrphan + dealsWouldCreateOnSibling;
      tickProgress({
        processed: incIdx,
        total: incompletes.length,
        failed: errors,
        status_message:
          `Incompletos ${incIdx}/${incompletes.length}` +
          (incompleteEnriched ? ` · enrich ${incompleteEnriched}` : '') +
          (dupToPerdido ? ` · →Perdido ${dupToPerdido}` : '') +
          (dealNotFound ? ` · not_found ${dealNotFound}` : ''),
      });
    };
    for (const row of incompletes) {
      if (cancelled || checkCancel()) break;
      incompleteScanned += 1;
      incIdx += 1;

      // Match matriculados via email then phone.
      const emailCandidates = contactEmails(row);
      const phoneCandidates = contactPhones(row);
      let group = null;
      let matchedKey = null;
      let matchVia = null;
      for (const e of emailCandidates) {
        if (byEmail.has(e)) { group = byEmail.get(e); matchedKey = e; matchVia = 'email'; break; }
      }
      if (!group) {
        for (const p of phoneCandidates) {
          if (byPhone.has(p)) { group = byPhone.get(p); matchedKey = p; matchVia = 'phone'; break; }
        }
      }
      if (!group) {
        incompleteNoMatch += 1;
        reportIncProgress();
        continue;
      }
      if (matchVia === 'email') matchedEmail += 1;
      else matchedPhone += 1;

      const rawItems = [...group.values()];
      const sourceNames = new Set(
        rawItems.map((it) => normalizeNameForCompare(it.mapped?._nome_full)).filter(Boolean)
      );
      const items = rawItems.filter((it) =>
        sourceNames.size > 1
          ? namesShareIdentityToken(row.nome, it.mapped?._nome_full)
          : namesPlausiblyMatch(row.nome, it.mapped?._nome_full)
      );
      if (!items.length) {
        incompleteNoMatch += 1;
        reportIncProgress();
        continue;
      }

      // E-mail/telefone compartilhado entre alunos diferentes: não dá para
      // saber de quem é o CPF/RGM. Não escreve nada.
      const distinctPeople = new Set(
        items.map((it) => normalizeNameForCompare(it.mapped?._nome_full)).filter(Boolean)
      );
      if (items.length > 1 && distinctPeople.size > 1) {
        incompleteAmbiguous += 1;
        if (skipSamples.length < 25) {
          skipSamples.push({
            type: 'ambiguous_match',
            contact_id: row.contact_id,
            nome: row.nome,
            match_via: matchVia,
            match_key: matchedKey,
            candidatos: [...distinctPeople].slice(0, 4),
          });
        }
        reportIncProgress();
        continue;
      }

      const emailsSet = new Set(emailCandidates);
      const phonesSet = new Set(phoneCandidates);
      for (const it of items) {
        const e2 = normalizeEmail(it.mapped.e_mail_ad);
        if (e2) emailsSet.add(e2);
        const e3 = normalizeEmail(it.mapped._email);
        if (e3) emailsSet.add(e3);
        const ph = normalizePhone(it.phone || it.mapped._phone);
        if (ph) phonesSet.add(ph);
      }
      const cpfsSet = new Set(items.map((it) => it.cpf).filter(Boolean));
      const rgmsSet = new Set(items.map((it) => it.rgm).filter(Boolean));

      // Find sibling more complete than this contact.
      const siblingId = findSiblingContactId(
        row.contact_id,
        { emails: emailsSet, phones: phonesSet, cpfs: cpfsSet, rgms: rgmsSet },
        indices,
        row.nome
      );
      const currentScore = siblingCompletenessScore(row);
      const siblingRow = siblingId ? indices.byContactId.get(siblingId) : null;
      const siblingScore = siblingRow ? siblingCompletenessScore(siblingRow) : 0;

      if (siblingId && siblingRow && siblingScore > currentScore) {
        // Sibling is more complete → mark bad deals on this contact as Perdido.
        if (!perdidoStageId) {
          // Cannot resolve Perdido stage (probably missing env / wrong host) — skip.
          reportIncProgress();
          continue;
        }
        if (!namesPlausiblyMatch(row.nome, siblingRow.nome)) {
          incompleteNameMismatch += 1;
          if (skipSamples.length < 25) {
            skipSamples.push({
              type: 'name_mismatch_sibling',
              contact_id: row.contact_id,
              nome: row.nome,
              sibling_contact_id: siblingId,
              sibling_nome: siblingRow.nome,
              match_via: matchVia,
              match_key: matchedKey,
            });
          }
          reportIncProgress();
          continue;
        }
        dupToPerdido += 1;

        // Collect all deals on this incomplete contact.
        const allDeals = dealsFromCacheRow(row);
        const primaryId = String(row.primary_deal_id || '').trim();
        if (primaryId && !allDeals.some((d) => String(d.id) === primaryId)) {
          allDeals.push({ id: primaryId });
        }

        for (const deal of allDeals) {
          if (!deal?.id) continue;
          let dealStageId = String(deal?.stageId || deal?.stage_id || '').trim();
          if (isUntouchableStageId(dealStageId)) continue;
          if (dealStageId === perdidoStageId) continue;

          // Espelho pode estar defasado: confere etapa e campos ao vivo antes
          // de mover algo para Perdido.
          if (liveCheck) {
            const live = await liveDealIdentity(deal.id);
            if (!live.ok) {
              if (live.notFound) dealNotFound += 1;
              perdidoLiveUnknown += 1;
              continue;
            }
            if (isUntouchableStageId(live.stageId) || live.stageId === perdidoStageId) {
              perdidoSkippedLive += 1;
              continue;
            }
            if (isLiveCpfTrustworthy(live.cpf) || isLiveRgmTrustworthy(live.rgm)) {
              // Negócio tem identidade no CRM — não é a linha "vazia" duplicada.
              perdidoSkippedLive += 1;
              continue;
            }
            dealStageId = live.stageId || dealStageId;
          }

          if (dryRun) {
            const siblingDeals = dealsFromCacheRow(siblingRow);
            const siblingPrimaryId = String(siblingRow.primary_deal_id || '').trim();
            const keeper =
              (siblingPrimaryId &&
                siblingDeals.find((d) => String(d.id) === siblingPrimaryId)) ||
              (siblingPrimaryId ? { id: siblingPrimaryId } : null) ||
              siblingDeals[0] ||
              null;
            if (keeper?.id) {
              const expectedRgm = [...rgmsSet][0] || '';
              const expectedCpf = [...cpfsSet][0] || normalizeCpf(row.cpf_norm);
              plannedMoves.push({
                kind: 'move',
                reason: 'incomplete_sibling',
                target_deal_id: String(deal.id),
                keeper_deal_id: String(keeper.id),
                target_name: row.nome || null,
                keeper_name: siblingRow.nome || null,
                expected_rgm: expectedRgm || null,
                expected_cpf: expectedCpf || null,
                situacao: plannedSituacao({ rgm: expectedRgm, cpf: expectedCpf }),
              });
            }
          }
          dealsMovedPerdido += 1;
          if (samples.length < 25) {
            samples.push({
              type: 'dup_to_perdido',
              incomplete_contact_id: row.contact_id,
              sibling_contact_id: siblingId,
              deal_id: deal.id,
              current_stage_id: dealStageId || null,
              match_via: matchVia,
              match_key: matchedKey,
            });
          }
          if (!dryRun) {
            try {
              await updateDeal(deal.id, { stageId: perdidoStageId });
              await alignSitAfterPerdidoMove(deal.id, {
                rgm: normalizeRgm(dealCustomValue(deal, ['rgm'])),
                cpf:
                  normalizeCpf(dealCustomValue(deal, ['cpf'])) ||
                  normalizeCpf(row.cpf_norm),
              });
              await tagLimpezaDuplicataBestEffort(deal.id);
              if (DELAY_MS > 0) await sleep(DELAY_MS);
            } catch (err) {
              errors += 1;
              if (errorSamples.length < 25) {
                errorSamples.push({
                  incomplete_contact_id: row.contact_id,
                  deal_id: deal.id,
                  error: err?.message || String(err),
                });
              }
            }
          }
        }
      } else {
        // No suitable sibling → empty-only fill CPF/RGM on primary deal.
        const allDeals = dealsFromCacheRow(row);
        const primaryId = String(row.primary_deal_id || '').trim();
        const primaryDeal =
          (primaryId && allDeals.find((d) => String(d.id) === primaryId)) ||
          (primaryId ? { id: primaryId } : null) ||
          allDeals[0] ||
          null;

        if (!primaryDeal?.id || !fieldIds?.cpf) {
          reportIncProgress();
          continue;
        }

        const hasCpf = Boolean(normalizeCpf(row.cpf_norm));
        const hasRgm = rgmsOnCacheRow(row).size > 0 || Boolean(normalizeRgm(row.rgm_norm));
        const it = items[0];

        if (!namesPlausiblyMatch(row.nome, it?.mapped?._nome_full)) {
          incompleteNameMismatch += 1;
          if (skipSamples.length < 25) {
            skipSamples.push({
              type: 'name_mismatch_siaa',
              contact_id: row.contact_id,
              nome: row.nome,
              nome_siaa: it?.mapped?._nome_full || null,
              match_via: matchVia,
              match_key: matchedKey,
            });
          }
          reportIncProgress();
          continue;
        }

        let enrichValues = [
          (!hasCpf && it?.cpf) ? { fieldId: fieldIds.cpf, value: it.cpf, campo: 'cpf' } : null,
          (!hasRgm && it?.rgm) ? { fieldId: fieldIds.rgm, value: it.rgm, campo: 'rgm' } : null,
        ].filter(Boolean);

        if (!enrichValues.length) {
          reportIncProgress();
          continue;
        }

        // Espelho pode dizer "vazio" com o CRM já preenchido. Só escreve o que
        // realmente está vazio/corrompido ao vivo — nunca sobrescreve valor bom.
        if (liveCheck) {
          const live = await liveDealIdentity(primaryDeal.id);
          if (!live.ok) {
            if (live.notFound) dealNotFound += 1;
            incompleteLiveUnknown += 1;
            reportIncProgress();
            continue;
          }
          const before = enrichValues.length;
          enrichValues = enrichValues.filter((v) => {
            const liveValue = v.campo === 'cpf' ? live.cpf : live.rgm;
            const trustworthy =
              v.campo === 'cpf' ? isLiveCpfTrustworthy(liveValue) : isLiveRgmTrustworthy(liveValue);
            if (!trustworthy) return true;
            if (digits(liveValue) !== digits(v.value)) {
              incompleteLiveConflict += 1;
              if (skipSamples.length < 25) {
                skipSamples.push({
                  type: 'live_conflict',
                  contact_id: row.contact_id,
                  nome: row.nome,
                  deal_id: primaryDeal.id,
                  campo: v.campo,
                  valor_crm: liveValue,
                  valor_siaa: v.value,
                });
              }
            }
            return false;
          });
          if (!enrichValues.length) {
            if (before) incompleteLiveAlreadyOk += 1;
            reportIncProgress();
            continue;
          }
        }

        incompleteEnriched += 1;
        if (dryRun) {
          plannedFills.push({
            kind: 'fill',
            target_deal_id: String(primaryDeal.id),
            target_name: row.nome || null,
            fields: enrichValues.map((v) => ({
              field_id: v.fieldId,
              value: v.value,
              campo: v.campo,
            })),
          });
        }
        if (samples.length < 25) {
          samples.push({
            type: 'incomplete_enriched',
            contact_id: row.contact_id,
            deal_id: primaryDeal.id,
            match_via: matchVia,
            match_key: matchedKey,
            filled: enrichValues.map((v) => (v.fieldId === fieldIds.cpf ? 'cpf' : 'rgm')),
          });
        }
        if (!dryRun) {
          try {
            await updateDealCustomFields(
              primaryDeal.id,
              enrichValues.map((v) => ({ fieldId: v.fieldId, value: v.value })),
              { maxRetries: 4 }
            );
            if (DELAY_MS > 0) await sleep(DELAY_MS);
          } catch (err) {
            errors += 1;
            if (errorSamples.length < 25) {
              errorSamples.push({
                incomplete_contact_id: row.contact_id,
                deal_id: primaryDeal.id,
                error: err?.message || String(err),
              });
            }
          }
        }
      }

      reportIncProgress();
    }
  }

  // === DUPLICATES PASS ===
  // Mesma pessoa (mesmo RGM) com 2+ cartões em etapa mexível. Não é coberto
  // pelos passes acima: os dois cards têm CPF/RGM, então nenhum é "órfão" nem
  // "incompleto". Mantém 1 card por score e manda os outros para Perdido.
  if (!cancelled && doDuplicates) {
    const maxMoves = Math.min(
      Math.max(Number(process.env.NOVO_CRM_DEDUPE_MAX_MOVES) || 1000, 1),
      20000
    );
    beginPhase('duplicates', 0, 'Procurando cartões duplicados…');

    const dealGroups = buildDedupeDealGroups(cacheRows);

    const groups = [...dealGroups.entries()];
    dupGroups = groups.length;
    counters.dup_groups = groups.length;
    const cacheDealById = indexCacheDealsById(cacheRows);
    const dupViaCache = Boolean(dryRun);
    beginPhase(
      'duplicates',
      groups.length,
      dupViaCache
        ? `Conferindo ${groups.length} pessoas no espelho…`
        : `Conferindo ${groups.length} pessoas ao vivo…`
    );
    console.info(
      `[novo-crm-orphan-provision] duplicates via=${dupViaCache ? 'cache' : 'live'} groups=${groups.length}`
    );

    /** Deals já “consumidos” como survivor/loser — evita reprocessar no mesmo run. */
    const consumedDealIds = new Set();

    const reportDupProgress = () => {
      counters.dup_groups_processed = groupIdx;
      counters.errors = errors;
      tickProgress({
        processed: groupIdx,
        total: groups.length,
        failed: errors,
        status_message:
          `Duplicados ${groupIdx}/${groups.length}` +
          (dupDealsMoved ? ` · →Perdido ${dupDealsMoved}` : '') +
          (dealNotFound ? ` · not_found ${dealNotFound}` : ''),
      });
    };

    let groupIdx = 0;
    for (const [groupKey, cands] of groups) {
      if (cancelled || checkCancel()) break;
      groupIdx += 1;
      if (dupDealsMoved >= maxMoves) {
        dupStoppedAtMax = true;
        break;
      }

      const pendingCands = cands.filter((c) => !consumedDealIds.has(c.dealId));
      if (pendingCands.length < 2) {
        reportDupProgress();
        continue;
      }

      const isRgmGroup = groupKey.startsWith('rgm:');
      const groupRgm = isRgmGroup ? groupKey.slice(4) : '';
      const matchType = groupKey.slice(0, groupKey.indexOf(':'));

      // Prévia: só o espelho (Postgres). Apply: GET live — quem morre não
      // pode sair de um snapshot stale.
      const live = [];
      let unknown = false;
      for (const c of pendingCands) {
        let d;
        if (dupViaCache) {
          const hit = cacheDealById.get(String(c.dealId));
          d = hit ? cacheDealForDedupe(hit.deal, hit.row) : { ok: false, notFound: true };
        } else {
          d = await liveDealForDedupe(c.dealId);
        }
        if (!d.ok) {
          if (d.notFound) dealNotFound += 1;
          unknown = true;
          break;
        }
        if (!dupViaCache && DELAY_MS > 0) await sleep(DELAY_MS);
        const liveRgm = normalizeRgm(d.rgm);
        // RGM vazio no live ainda entra (irmão sem fields no cache — herdou o grupo).
        // RGM diferente = outro curso, fora.
        if (isRgmGroup && liveRgm && liveRgm !== groupRgm) continue;
        if (!d.stageId || d.stageId === perdidoStageId || isUntouchableStageId(d.stageId)) continue;
        live.push(d);
      }
      if (unknown) {
        dupLiveUnknown += 1;
        reportDupProgress();
        continue;
      }
      if (live.length < 2) {
        dupResolvedLive += 1;
        reportDupProgress();
        continue;
      }

      // Identidade por CPF/contact/nome+telefone/e-mail nunca cruza cursos:
      // 2+ RGMs válidos no live = multi-curso legítimo ou grupo ambíguo.
      const liveRgms = new Set(live.map((d) => normalizeRgm(d.rgm)).filter(Boolean));
      if (!isRgmGroup) {
        if (liveRgms.size > 1) {
          dupMultiRgmSkipped += 1;
          if (skipSamples.length < 25) {
            skipSamples.push({
              type: 'dup_multi_rgm_skip',
              match_type: matchType,
              match_key: groupKey.slice(groupKey.indexOf(':') + 1),
              rgms: [...liveRgms],
              deals: live.map((d) => d.number || d.dealId),
            });
          }
          reportDupProgress();
          continue;
        }
      }
      const effectiveRgm = groupRgm || (liveRgms.size === 1 ? [...liveRgms][0] : '');
      const officialName = effectiveRgm
        ? extractMatriculadosMappedValues(byRgmMat.get(effectiveRgm) || {})._nome_full
        : '';

      // Mesmo RGM+CPF não basta: e-mail/telefone de assessoria ou CPF
      // compartilhado gera "CHARLES" × "SARA" no mesmo grupo. Só dedupe se
      // nomes casam, mesmo contact_id ou CPF live confiável idêntico.
      const anchor = pickDedupeSurvivor(live, officialName);
      const anchorCpf = isLiveCpfTrustworthy(anchor.cpf) ? normalizeCpf(anchor.cpf) : '';
      const samePerson = live.filter((d) => {
        if (d.dealId === anchor.dealId) return true;
        if (d.contactId && d.contactId === anchor.contactId) return true;
        const dCpf = isLiveCpfTrustworthy(d.cpf) ? normalizeCpf(d.cpf) : '';
        if (anchorCpf && dCpf && anchorCpf === dCpf) return true;
        return namesPlausiblyMatch(d.contactName || d.title, anchor.contactName || anchor.title);
      });
      if (samePerson.length < live.length) {
        dupNameMismatch += 1;
        if (skipSamples.length < 25) {
          skipSamples.push({
            type: 'dup_name_mismatch',
            rgm: groupRgm || normalizeRgm(anchor.rgm) || null,
            match_type: matchType,
            cpf: anchor.cpf || null,
            nomes: live.map((d) => d.contactName || d.title),
          });
        }
      }
      if (samePerson.length < 2) {
        reportDupProgress();
        continue;
      }

      const survivor = pickDedupeSurvivor(samePerson, officialName);
      const losers = samePerson.filter((d) => d.dealId !== survivor.dealId);
      dupDealsExtra += losers.length;
      if (new Set(samePerson.map((d) => d.contactId)).size > 1) dupCrossContact += 1;

      if (samples.length < 25) {
        samples.push({
          type: 'dup_deal',
          rgm: groupRgm || normalizeRgm(survivor.rgm) || null,
          mesmo_cadastro: new Set(samePerson.map((d) => d.contactId)).size === 1,
          mantido: {
            deal: survivor.number,
            titulo: survivor.title,
            etapa: survivor.stageName,
            campos: survivor.filledFields,
            conversas: survivor.conversations,
            score: dedupeSurvivorScore(survivor, officialName),
          },
          para_perdido: losers.map((l) => ({
            deal: l.number,
            titulo: l.title,
            etapa: l.stageName,
            campos: l.filledFields,
            conversas: l.conversations,
            score: dedupeSurvivorScore(l, officialName),
          })),
        });
      }

      for (const d of samePerson) consumedDealIds.add(d.dealId);

      if (dryRun) {
        for (const loser of losers) {
          plannedMoves.push({
            kind: 'move',
            reason: 'duplicate',
            target_deal_id: String(loser.dealId),
            keeper_deal_id: String(survivor.dealId),
            target_name: loser.contactName || loser.title || null,
            keeper_name: survivor.contactName || survivor.title || null,
            expected_rgm: groupRgm || normalizeRgm(survivor.rgm) || null,
            expected_cpf: normalizeCpf(survivor.cpf) || null,
            situacao: plannedSituacao({
              rgm: groupRgm || normalizeRgm(loser.rgm),
              cpf: normalizeCpf(loser.cpf),
            }),
          });
        }
        dupDealsMoved += losers.length;
      } else {
        for (const l of losers) {
          try {
            await updateDeal(l.dealId, { stageId: perdidoStageId });
            await alignSitAfterPerdidoMove(l.dealId, {
              rgm: normalizeRgm(l.rgm) || groupRgm,
              cpf: normalizeCpf(l.cpf),
            });
            await tagLimpezaDuplicataBestEffort(l.dealId);
            dupDealsMoved += 1;
            if (DELAY_MS > 0) await sleep(DELAY_MS);
          } catch (err) {
            errors += 1;
            if (errorSamples.length < 25) {
              errorSamples.push({
                dup_rgm: groupRgm || normalizeRgm(l.rgm) || null,
                match_type: matchType,
                deal_id: l.dealId,
                error: err?.message || String(err),
              });
            }
          }
        }
      }
      reportDupProgress();
    }
  }

  const result = {
    ok: !cancelled,
    cancelled,
    dry_run: dryRun,
    scope,
    orphan_deal_creation_disabled: !CREATE_ORPHAN_DEALS_ENABLED,
    matriculados_snapshot_id: matSnap.id,
    matriculados_file: matSnap.file_name || null,
    index: { by_email: byEmail.size, by_phone: byPhone.size },
    cache_total: cacheRows.length,
    orphans_total: orphans.length,
    orphans_scanned: scanned,
    orphan_aluno: orphanAluno,
    orphan_no_match: orphanNoMatch,
    matched_email: matchedEmail,
    matched_phone: matchedPhone,
    dup_contact_skip: dupContactSkip,
    dup_skip_no_deal: dupSkipNoDeal,
    dup_to_perdido: dupToPerdido,
    deals_would_create_on_orphan: dealsWouldCreateOnOrphan,
    deals_would_create_on_sibling: dealsWouldCreateOnSibling,
    ...(dryRun
      ? { deals_would_move_perdido: dealsMovedPerdido }
      : { deals_moved_perdido: dealsMovedPerdido }),
    incomplete_total: incompletes.length,
    incomplete_scanned: incompleteScanned,
    incomplete_no_match: incompleteNoMatch,
    incomplete_enriched: incompleteEnriched,
    incomplete_ambiguous: incompleteAmbiguous,
    incomplete_name_mismatch: incompleteNameMismatch,
    incomplete_live_already_ok: incompleteLiveAlreadyOk,
    incomplete_live_conflict: incompleteLiveConflict,
    incomplete_live_unknown: incompleteLiveUnknown,
    perdido_skipped_live: perdidoSkippedLive,
    perdido_live_unknown: perdidoLiveUnknown,
    dup_deal_groups: dupGroups,
    dup_deals_extra: dupDealsExtra,
    dup_cross_contact: dupCrossContact,
    dup_resolved_live: dupResolvedLive,
    dup_live_unknown: dupLiveUnknown,
    dup_name_mismatch: dupNameMismatch,
    dup_multi_rgm_skipped: dupMultiRgmSkipped,
    dup_stopped_at_max: dupStoppedAtMax,
    ...(dryRun
      ? { dup_deals_would_move_perdido: dupDealsMoved }
      : { dup_deals_moved_perdido: dupDealsMoved }),
    created_deals: dryRun ? 0 : createdDeals,
    errors: dryRun ? 0 : errors,
    tag_name: limpezaDupTagName,
    tags_applied: dryRun ? 0 : tagsApplied,
    tags_failed: dryRun ? 0 : tagsFailed,
    skipped_already_has_deal_live: skippedAlreadyHasDeal,
    warmed_cache: warmedCache,
    warm_cache_errors: warmCacheErrors,
    skipped_duplicate_rgm: skippedDuplicateRgm,
    skipped_cpf_capacity: skippedCpfCapacity,
    max_creates: maxCreates,
    offset,
    concurrency,
    live_check: liveCheck,
    plan_fallback: Boolean(planFallbackReason),
    plan_fallback_reason: planFallbackReason,
    skip_fields_all: skipFieldsAll,
    delay_ms: DELAY_MS,
    stopped_at_max: stoppedAtMax,
    samples,
    skip_samples: skipSamples,
    error_samples: errorSamples,
  };

  patchJob({
    phase: 'done',
    status: cancelled ? 'cancelled' : 'completed',
    finished_at: new Date().toISOString(),
    result: { ...result, cancelled, deal_not_found: dealNotFound },
    eta_ms: null,
    ...counters,
    deal_not_found: dealNotFound,
    status_message: cancelled
      ? (dryRun ? 'Prévia cancelada' : 'Provisionamento cancelado')
      : dryRun
        ? 'Prévia pronta'
        : 'Provisionamento concluído',
  });

  if (dryRun && !cancelled) {
    const actionPlan = {
      version: 1,
      created_at: new Date().toISOString(),
      scope,
      cache_generation: scanCacheGeneration,
      matriculados_snapshot_id: matSnap.id,
      tag_name: limpezaDupTagName,
      incomplete_total: incompletes.length,
      incomplete_moves: plannedMoves.filter((a) => a.reason === 'incomplete_sibling').length,
      dup_deal_groups: dupGroups,
      moves: plannedMoves,
      fills: plannedFills,
    };
    lastDedupeActionPlan = actionPlan;
    try {
      await cacheRepo.saveOrphanDedupePlan(actionPlan);
      result.action_plan = {
        created_at: actionPlan.created_at,
        moves: plannedMoves.length,
        fills: plannedFills.length,
        max_age_ms: DEDUPE_PLAN_MAX_AGE_MS,
      };
      patchJob({ result: { ...result, cancelled, deal_not_found: dealNotFound } });
    } catch (err) {
      console.warn('[novo-crm-orphan-provision] save action plan failed:', err?.message || err);
    }
  }

  // Persist last preview/apply so the panel keeps a summary after progress clears.
  try {
    await cacheRepo.saveOrphanDedupeLastRun({
      finished_at: new Date().toISOString(),
      ok: !cancelled,
      cancelled,
      dry_run: dryRun,
      status: cancelled ? 'cancelled' : 'completed',
      scope,
      orphans_total: orphans.length,
      orphans_scanned: scanned,
      would_create:
        (dealsWouldCreateOnOrphan || 0) + (dealsWouldCreateOnSibling || 0),
      deals_would_create_on_orphan: dealsWouldCreateOnOrphan,
      deals_would_create_on_sibling: dealsWouldCreateOnSibling,
      skipped_already_has_deal_live: skippedAlreadyHasDeal,
      incomplete_total: incompletes.length,
      incomplete_enriched: incompleteEnriched,
      incomplete_scanned: incompleteScanned,
      dup_to_perdido: dupToPerdido,
      deals_would_move_perdido: dryRun ? dealsMovedPerdido : undefined,
      deals_moved_perdido: dryRun ? undefined : dealsMovedPerdido,
      dup_deal_groups: dupGroups,
      dup_deals_would_move_perdido: dryRun ? dupDealsMoved : undefined,
      dup_deals_moved_perdido: dryRun ? undefined : dupDealsMoved,
      created_deals: dryRun ? 0 : createdDeals,
      orphan_no_match: orphanNoMatch,
      errors: dryRun ? 0 : errors,
      tag_name: limpezaDupTagName,
      tags_applied: dryRun ? 0 : tagsApplied,
      tags_failed: dryRun ? 0 : tagsFailed,
      deal_not_found: dealNotFound,
      warmed_cache: warmedCache,
      action_plan_moves: dryRun && !cancelled ? plannedMoves.length : undefined,
      action_plan_fills: dryRun && !cancelled ? plannedFills.length : undefined,
    });
  } catch (err) {
    console.warn('[novo-crm-orphan-provision] save last run failed:', err?.message || err);
  }

  console.log('[novo-crm-orphan-provision] done', JSON.stringify({ ...result, samples: undefined, error_samples: undefined }));
  return result;
}

/** @type {Map<string, object>} */
const jobs = new Map();
let runningJobId = null;

/**
 * Prévia síncrona (dry-run).
 * @param {{ maxCreates?: number, scope?: 'orphans'|'incomplete'|'both' }} opts
 */
export async function previewOrphanAlunoProvision(opts = {}) {
  return runOrphanAlunoProvision({ maxCreates: opts.maxCreates, scope: opts.scope, dryRun: true });
}

/**
 * Prévia (com verificação ao vivo) ou apply em background. Retorna jobId.
 * @param {{ maxCreates?: number, offset?: number, liveCheck?: boolean, scope?: 'orphans'|'incomplete'|'both', dryRun?: boolean }} opts
 */
export function startOrphanAlunoProvisionApplyBackground(opts = {}) {
  if (runningJobId && jobs.get(runningJobId)?.status === 'running') {
    return { started: false, jobId: runningJobId, error: 'Provisionamento de órfãos já em andamento' };
  }
  const dryRun = opts.dryRun === true;
  const jobId = randomUUID();
  const entry = {
    jobId,
    status: 'running',
    dry_run: dryRun,
    total: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    eta_ms: null,
    cancel_requested: false,
    phase: 'starting',
    status_message: 'Iniciando…',
    started_at: new Date().toISOString(),
    finished_at: null,
    result: null,
    error: null,
    scope: opts.scope || 'orphans',
    orphans_total: 0,
    orphans_processed: 0,
    incomplete_total: 0,
    incomplete_processed: 0,
    dup_groups: 0,
    dup_groups_processed: 0,
    already_has_deal: 0,
    would_create: 0,
    live_ok: 0,
    deal_not_found: 0,
    errors: 0,
  };
  jobs.set(jobId, entry);
  runningJobId = jobId;

  void runOrphanAlunoProvision({
    maxCreates: opts.maxCreates,
    offset: opts.offset,
    liveCheck: opts.liveCheck,
    scope: opts.scope,
    dryRun,
    jobId,
  })
    .then((result) => {
      entry.status = result?.cancelled || entry.status === 'cancelled' ? 'cancelled' : 'completed';
      entry.result = result;
      entry.finished_at = new Date().toISOString();
      entry.phase = 'done';
      entry.eta_ms = null;
      if (!entry.status_message || !/cancel|pronta|conclu/i.test(String(entry.status_message))) {
        entry.status_message =
          entry.status === 'cancelled'
            ? entry.dry_run
              ? 'Prévia cancelada'
              : 'Cancelado'
            : entry.dry_run
              ? 'Prévia pronta'
              : 'Provisionamento concluído';
      }
    })
    .catch((err) => {
      entry.status = 'failed';
      entry.error = err?.message || String(err);
      entry.finished_at = new Date().toISOString();
      entry.phase = 'done';
      // Exceção no meio da rodada: persiste last-run com o parcial já acumulado
      // no job em memória, senão o card 3 fica preso no último sucesso/preview
      // e some o sinal de erro.
      cacheRepo
        .saveOrphanDedupeLastRun({
          finished_at: entry.finished_at,
          ok: false,
          cancelled: false,
          dry_run: entry.dry_run,
          status: 'failed',
          scope: entry.scope,
          orphans_total: entry.orphans_total || 0,
          orphans_scanned: entry.orphans_processed || 0,
          would_create: entry.would_create || 0,
          incomplete_total: entry.incomplete_total || 0,
          incomplete_scanned: entry.incomplete_processed || 0,
          dup_deal_groups: entry.dup_groups || 0,
          errors: entry.errors || 0,
          error: entry.error,
        })
        .catch((saveErr) => {
          console.warn('[novo-crm-orphan-provision] save last run (error path) failed:', saveErr?.message || saveErr);
        });
    })
    .finally(() => {
      if (runningJobId === jobId) runningJobId = null;
    });

  return { started: true, jobId };
}

export function getOrphanAlunoProvisionJob(jobId) {
  return jobs.get(String(jobId || '')) || null;
}

export function getRunningOrphanAlunoProvisionJob() {
  if (!runningJobId) return null;
  const j = jobs.get(runningJobId);
  return j?.status === 'running' ? j : null;
}

/**
 * Cancel cooperativo (para no próximo item da fase atual).
 * @param {string} [jobId]
 */
export function requestCancelOrphanAlunoProvision(jobId) {
  const id = jobId ? String(jobId) : runningJobId;
  if (!id) return { ok: false, error: 'Nenhum job de dedupe em andamento' };
  const j = jobs.get(id);
  if (!j) return { ok: false, error: 'Job não encontrado' };
  if (j.status !== 'running') {
    return { ok: false, jobId: id, error: 'Job não está rodando (status=' + j.status + ')' };
  }
  j.cancel_requested = true;
  j.status_message = 'Cancelando… (para no próximo item)';
  console.log('[novo-crm-orphan-provision] cancel requested job=' + id);
  return { ok: true, jobId: id };
}
