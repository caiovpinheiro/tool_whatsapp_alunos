/**
 * Cliente HTTP do CRM EduIT (Novo CRM).
 *
 * Env:
 *   NOVO_CRM_API_BASE_URL=https://integrations.bwipo.com
 *   NOVO_CRM_API_TOKEN=eduit_...
 *   NOVO_CRM_ENABLED=1
 */

import { tagNameForCategory } from '../utils/novoCrmActivationTags.js';
import * as tagLogRepo from '../repositories/activationNovoCrmTagRepository.js';
import { createRateLimiter } from '../utils/rateLimiter.js';

function apiBase() {
  const raw = String(process.env.NOVO_CRM_API_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');
  // Sem default pra produção: URL vazia quebra o client em vez de apontar pra crm.eduit.com.br.
  if (!raw) {
    const err = new Error('NOVO_CRM_API_BASE_URL não configurado.');
    err.status = 503;
    throw err;
  }
  return raw;
}

/** Host canônico da URL configurada (mesmo critério do host guard). */
export function getNovoCrmApiHost() {
  try {
    return new URL(apiBase()).host.toLowerCase();
  } catch {
    return String(process.env.NOVO_CRM_API_BASE_URL || '')
      .trim()
      .toLowerCase();
  }
}

function apiToken() {
  return String(process.env.NOVO_CRM_API_TOKEN || '').trim();
}

/** Teto global de req/s (sync, enrich, tags). Default 2; teto 6 (catch-up Full Sync). Att no dia-a-dia: 2. */
function apiRatePerSecond() {
  return Math.max(1, Math.min(6, Number(process.env.NOVO_CRM_API_RATE_PER_SECOND) || 2));
}

function apiTimeoutMs() {
  return Math.max(5000, Math.min(60_000, Number(process.env.NOVO_CRM_API_TIMEOUT_MS) || 15_000));
}

const apiLimiter = createRateLimiter(apiRatePerSecond(), 1000);

export function isNovoCrmApiConfigured() {
  const enabled = String(process.env.NOVO_CRM_ENABLED || '').trim() === '1';
  return (
    enabled &&
    Boolean(apiToken()) &&
    Boolean(String(process.env.NOVO_CRM_API_BASE_URL || '').trim())
  );
}

function digitsOnly(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function phoneSearchVariants(telefone) {
  let d = digitsOnly(telefone);
  if (!d) return [];
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  const out = new Set();
  if (d.length >= 10) {
    out.add(d);
    out.add(`55${d}`);
    out.add(`+55${d}`);
  }
  return [...out];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, maxRetries?: number }} [opts]
 */
async function request(path, opts = {}) {
  const token = apiToken();
  if (!token) {
    const err = new Error('NOVO_CRM_API_TOKEN não configurado.');
    err.status = 503;
    throw err;
  }
  const method = String(opts.method || 'GET').toUpperCase();
  // POST (create) não é idempotente → sem retry por default.
  // PUT/PATCH/DELETE: poucos retries (429/5xx). GET: retries generosos.
  let defaultRetries = 4;
  if (method === 'POST') defaultRetries = 0;
  else if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') defaultRetries = 2;
  const maxRetries = Math.max(
    0,
    opts.maxRetries != null ? Number(opts.maxRetries) : defaultRetries
  );
  // Status transitórios do CRM (instância DEV costuma dar 502 sob carga).
  const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);
  let attempt = 0;

  while (true) {
    await apiLimiter.acquire();

    let res;
    try {
      res = await fetch(`${apiBase()}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(opts.body != null
            ? { 'Content-Type': 'application/json; charset=utf-8' }
            : {}),
        },
        body: opts.body != null ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(apiTimeoutMs()),
      });
    } catch (netErr) {
      // Falha de rede (fetch failed / ECONNRESET / timeout) → retry com backoff.
      if (attempt < maxRetries) {
        const backoffMs = Math.min(30_000, 1500 * 2 ** attempt);
        attempt += 1;
        console.warn(
          `[novo-crm-api] rede falhou em ${path} (${netErr?.message || netErr}) — retry ${attempt}/${maxRetries} em ${backoffMs}ms`
        );
        await sleep(backoffMs);
        continue;
      }
      const err = new Error(`Novo CRM rede: ${netErr?.message || netErr}`);
      err.status = 0;
      err.cause = netErr;
      throw err;
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (RETRIABLE_STATUS.has(res.status) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoffMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, 1500 * 2 ** attempt);
      attempt += 1;
      console.warn(
        `[novo-crm-api] ${res.status} em ${path} — retry ${attempt}/${maxRetries} em ${backoffMs}ms`
      );
      await sleep(backoffMs);
      continue;
    }

    if (!res.ok) {
      const err = new Error(json?.message || json?.error || `Novo CRM HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }
}

function normalizeTagBody(tag) {
  const tagId = tag?.tagId ? String(tag.tagId).trim() : '';
  const tagName = tag?.tagName ? String(tag.tagName).trim() : '';
  if (!tagId && !tagName) {
    const err = new Error('tagId ou tagName obrigatório');
    err.status = 400;
    throw err;
  }
  return tagId ? { tagId } : { tagName };
}

function itemsFromListResponse(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.items)) return raw.items;
  return [];
}

/**
 * Busca contact por telefone / CPF / e-mail (nessa ordem).
 * @param {{ telefone?: string|null, cpf?: string|null, email?: string|null, nome?: string|null }} item
 * @returns {Promise<object|null>}
 */
export async function searchContactForActivationItem(item) {
  const tried = new Set();
  const queries = [
    ...phoneSearchVariants(item?.telefone),
    (() => {
      const cpf = digitsOnly(item?.cpf);
      return cpf.length === 11 ? cpf : '';
    })(),
    String(item?.email || '')
      .trim()
      .toLowerCase(),
  ].filter((q) => q && q.length >= 3);

  for (const q of queries) {
    if (tried.has(q)) continue;
    tried.add(q);
    const raw = await request(`/api/contacts?search=${encodeURIComponent(q)}`);
    const items = itemsFromListResponse(raw);
    if (items.length === 0) continue;

    const phoneWanted = phoneSearchVariants(item?.telefone);
    const cpfWanted = digitsOnly(item?.cpf);
    const emailWanted = String(item?.email || '')
      .trim()
      .toLowerCase();

    const ranked = items.slice().sort((a, b) => {
      const score = (c) => {
        let s = 0;
        const p = digitsOnly(c.phone);
        const pNorm = p.length >= 12 && p.startsWith('55') ? p.slice(2) : p;
        if (phoneWanted.some((v) => digitsOnly(v).endsWith(pNorm) || pNorm.endsWith(digitsOnly(v).slice(-11)))) {
          s += 10;
        }
        if (cpfWanted.length === 11 && String(c.email || '').includes(cpfWanted)) s += 3;
        if (emailWanted && String(c.email || '').toLowerCase() === emailWanted) s += 8;
        return s;
      };
      return score(b) - score(a);
    });
    return ranked[0] || null;
  }
  return null;
}

/**
 * Deal OPEN do contact (primeiro), senão qualquer deal.
 * @param {string} contactId
 * @returns {Promise<object|null>}
 */
export async function findDealForContact(contactId) {
  const id = String(contactId || '').trim();
  if (!id) return null;
  const raw = await request(`/api/deals?contactId=${encodeURIComponent(id)}`);
  const items = itemsFromListResponse(raw);
  if (items.length === 0) return null;
  const open = items.find((d) => String(d.status || '').toUpperCase() === 'OPEN');
  return open || items[0];
}

/**
 * @param {{ telefone?: string|null, cpf?: string|null, email?: string|null, nome?: string|null }} item
 * @returns {Promise<{ contactId: string, dealId: string|null, contact: object, deal: object|null }|null>}
 */
export async function resolveContactAndDealForActivationItem(item) {
  const contact = await searchContactForActivationItem(item);
  if (!contact?.id) return null;
  const deal = await findDealForContact(contact.id);
  return {
    contactId: String(contact.id),
    dealId: deal?.id ? String(deal.id) : null,
    contact,
    deal,
  };
}

/** Lista tags da org autenticada. @returns {Promise<Array<{id:string,name:string,color?:string}>>} */
export async function listTags() {
  const raw = await request('/api/tags');
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.items)) return raw.items;
  return [];
}

/**
 * Resolve tagId pelo nome (após POST que pode ter criado a tag).
 * @param {string} tagName
 * @returns {Promise<string|null>}
 */
export async function resolveTagIdByName(tagName) {
  const name = String(tagName || '').trim();
  if (!name) return null;
  const tags = await listTags();
  const hit = tags.find((t) => String(t?.name || '') === name);
  return hit?.id ? String(hit.id) : null;
}

/**
 * Cria tag no catálogo da org.
 * @param {{ name: string, color?: string }} payload
 */
export async function createTag(payload) {
  const name = String(payload?.name || '').trim();
  if (!name) {
    const err = new Error('name obrigatório para criar tag');
    err.status = 400;
    throw err;
  }
  const color = String(payload?.color || '#6366f1').trim() || '#6366f1';
  return request('/api/tags', { method: 'POST', body: { name, color } });
}

/**
 * Garante que a tag existe no catálogo e devolve o id.
 * POST /api/deals/:id/tags com tagName nova dispara create no CRM; se a
 * sequência `org_number_counters` estiver quebrada, isso 500 e o card
 * fica sem etiqueta. Por isso o apply precisa do id *antes* de mover.
 * @param {string} tagName
 * @param {{ color?: string }} [opts]
 * @returns {Promise<{ tagId: string, created: boolean, name: string }>}
 */
export async function ensureTagByName(tagName, opts = {}) {
  const name = String(tagName || '').trim();
  if (!name) {
    const err = new Error('tagName obrigatório');
    err.status = 400;
    throw err;
  }
  const existing = await resolveTagIdByName(name);
  if (existing) return { tagId: existing, created: false, name };
  try {
    const created = await createTag({ name, color: opts.color });
    const tagId = String(created?.id || '').trim() || (await resolveTagIdByName(name));
    if (tagId) return { tagId, created: true, name };
  } catch (err) {
    const wrap = new Error(
      `CRM não criou a tag "${name}" (${err?.message || err}). ` +
        'Crie essa tag no CRM (mesmo nome, filtro Tags) e rode de novo. ' +
        'Erro org_number_counters = sequência de tags quebrada no EduIT.'
    );
    wrap.status = err?.status || 500;
    wrap.code = 'TAG_CREATE_FAILED';
    wrap.cause = err;
    throw wrap;
  }
  const err = new Error(`CRM não devolveu id da tag "${name}"`);
  err.code = 'TAG_CREATE_FAILED';
  throw err;
}

/**
 * @param {string} dealId
 * @param {{ tagId?: string, tagName?: string }} tag
 */
export async function addTagToDeal(dealId, tag) {
  const id = String(dealId || '').trim();
  if (!id) {
    const err = new Error('dealId obrigatório');
    err.status = 400;
    throw err;
  }
  return request(`/api/deals/${encodeURIComponent(id)}/tags`, {
    method: 'POST',
    body: normalizeTagBody(tag),
  });
}

/**
 * @param {string} contactId
 * @param {{ tagId?: string, tagName?: string }} tag
 */
export async function addTagToContact(contactId, tag) {
  const id = String(contactId || '').trim();
  if (!id) {
    const err = new Error('contactId obrigatório');
    err.status = 400;
    throw err;
  }
  return request(`/api/contacts/${encodeURIComponent(id)}/tags`, {
    method: 'POST',
    body: normalizeTagBody(tag),
  });
}

/**
 * @param {string} dealId
 * @param {{ tagId?: string, tagName?: string }} tag
 * DELETE no CRM exige tagId (tagName só funciona no POST).
 */
export async function removeTagFromDeal(dealId, tag) {
  const id = String(dealId || '').trim();
  if (!id) {
    const err = new Error('dealId obrigatório');
    err.status = 400;
    throw err;
  }
  let tagId = tag?.tagId ? String(tag.tagId).trim() : '';
  if (!tagId && tag?.tagName) {
    tagId = (await resolveTagIdByName(String(tag.tagName).trim())) || '';
  }
  if (!tagId) {
    const err = new Error('tagId obrigatório para remover tag (DELETE)');
    err.status = 400;
    throw err;
  }
  return request(`/api/deals/${encodeURIComponent(id)}/tags`, {
    method: 'DELETE',
    body: { tagId },
  });
}

/**
 * @param {string} contactId
 * @param {{ tagId?: string, tagName?: string }} tag
 * DELETE no CRM exige tagId (tagName só funciona no POST).
 */
export async function removeTagFromContact(contactId, tag) {
  const id = String(contactId || '').trim();
  if (!id) {
    const err = new Error('contactId obrigatório');
    err.status = 400;
    throw err;
  }
  let tagId = tag?.tagId ? String(tag.tagId).trim() : '';
  if (!tagId && tag?.tagName) {
    tagId = (await resolveTagIdByName(String(tag.tagName).trim())) || '';
  }
  if (!tagId) {
    const err = new Error('tagId obrigatório para remover tag (DELETE)');
    err.status = 400;
    throw err;
  }
  return request(`/api/contacts/${encodeURIComponent(id)}/tags`, {
    method: 'DELETE',
    body: { tagId },
  });
}

/**
 * Aplica tag canônica da categoria no contact (+ deal se informado) e grava log SET.
 *
 * @param {{
 *   contactId: string,
 *   dealId?: string|null,
 *   category: string,
 *   masterKey?: string|null,
 *   cpf?: string|null,
 *   rgm?: string|null,
 *   nome?: string|null,
 * }} opts
 */
export async function activateByCategoryTag(opts) {
  const contactId = String(opts?.contactId || '').trim();
  const category = String(opts?.category || '').trim();
  const dealId = opts?.dealId ? String(opts.dealId).trim() : null;
  if (!contactId) {
    const err = new Error('contactId obrigatório');
    err.status = 400;
    throw err;
  }
  const tagName = tagNameForCategory(category);
  if (!tagName) {
    const err = new Error(`Categoria sem tag de ativação: ${category}`);
    err.status = 400;
    throw err;
  }

  const logBase = {
    category,
    tagName,
    contactId,
    dealId,
    masterKey: opts?.masterKey ?? null,
    cpf: opts?.cpf ?? null,
    rgm: opts?.rgm ?? null,
    nome: opts?.nome ?? null,
  };

  try {
    await addTagToContact(contactId, { tagName });
    if (dealId) {
      await addTagToDeal(dealId, { tagName });
    }
    const tagId = await resolveTagIdByName(tagName);
    await tagLogRepo.recordTagLog({
      ...logBase,
      tagId,
      tagValue: tagName,
      status: 'ok',
    });
    return { ok: true, tagName, tagId, contactId, dealId };
  } catch (err) {
    await tagLogRepo
      .recordTagLog({
        ...logBase,
        tagId: null,
        tagValue: tagName,
        status: 'failed',
        errorMessage: err?.message || String(err),
      })
      .catch(() => {});
    throw err;
  }
}

/**
 * @param {string} dealId
 * @param {string} category
 * @deprecated Prefer activateByCategoryTag com contactId (UI mostra tags no contact).
 */
export async function activateDealByCategoryTag(dealId, category) {
  const tagName = tagNameForCategory(category);
  if (!tagName) {
    const err = new Error(`Categoria sem tag de ativação: ${category}`);
    err.status = 400;
    throw err;
  }
  return addTagToDeal(dealId, { tagName });
}

/** @type {Map<string, {id:string,name:string,label?:string,type?:string,options?:unknown[]}>|null} */
let dealCustomFieldsByName = null;
/** @type {Set<string>|null} */
let dealCustomFieldIds = null;
let dealCustomFieldsLoadedAt = 0;
const CF_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Custom fields da entidade deal (cache 10 min).
 * @returns {Promise<Map<string, {id:string,name:string,label?:string,type?:string,options?:unknown[]}>>}
 */
export async function getDealCustomFieldsByName() {
  const now = Date.now();
  if (dealCustomFieldsByName && now - dealCustomFieldsLoadedAt < CF_CACHE_TTL_MS) {
    return dealCustomFieldsByName;
  }
  const raw = await request('/api/custom-fields?entity=deal');
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
  /** @type {Map<string, {id:string,name:string,label?:string,type?:string,options?:unknown[]}>} */
  const map = new Map();
  const ids = new Set();
  for (const f of items) {
    const id = f?.id ? String(f.id) : '';
    if (id) ids.add(id);
    const name = String(f?.name || '')
      .trim()
      .toLowerCase();
    if (!name || !id) continue;
    map.set(name, {
      id,
      name,
      label: f.label != null ? String(f.label) : undefined,
      type: f.type != null ? String(f.type) : undefined,
      options: Array.isArray(f.options) ? f.options : [],
    });
  }
  dealCustomFieldsByName = map;
  dealCustomFieldIds = ids;
  dealCustomFieldsLoadedAt = now;
  return map;
}

/**
 * PUT /api/deals/:id/custom-fields — body { values: [{ fieldId, value }] }
 * @param {string} dealId
 * @param {Array<{ fieldId: string, value: string|number|null }>} values
 * @param {{ maxRetries?: number }} [opts]
 */
export async function updateDealCustomFields(dealId, values, opts = {}) {
  const id = String(dealId || '').trim();
  if (!id) {
    const err = new Error('dealId obrigatório');
    err.status = 400;
    throw err;
  }
  let list = Array.isArray(values) ? values.filter((v) => v?.fieldId) : [];
  if (!list.length) {
    const err = new Error('values obrigatório');
    err.status = 400;
    throw err;
  }
  // Um fieldId morto (campo apagado no CRM, env/JSON stale) faz o Prisma
  // recusar o PUT inteiro (FK deal_custom_field_values_customFieldId_fkey)
  // e o deal fica sem CPF/RGM/data. Descarta só o ID desconhecido.
  try {
    await getDealCustomFieldsByName();
    const known = dealCustomFieldIds;
    if (known && known.size) {
      const dropped = [];
      list = list.filter((v) => {
        const fid = String(v.fieldId);
        if (known.has(fid)) return true;
        dropped.push(fid);
        return false;
      });
      if (dropped.length) {
        console.warn(
          `[novo-crm-api] drop unknown customFieldId on deal ${id}: ${[...new Set(dropped)].join(',')}`
        );
      }
    }
  } catch (err) {
    console.warn(
      '[novo-crm-api] catálogo de campos indisponível; PUT segue com a lista original:',
      err?.message || err
    );
  }
  if (!list.length) {
    const err = new Error('values obrigatório (nenhum fieldId existe neste CRM)');
    err.status = 400;
    throw err;
  }
  return request(`/api/deals/${encodeURIComponent(id)}/custom-fields`, {
    method: 'PUT',
    maxRetries: opts.maxRetries,
    body: {
      values: list.map((v) => ({
        fieldId: String(v.fieldId),
        value: v.value == null ? '' : v.value,
      })),
    },
  });
}

/**
 * @param {string} contactId
 * @param {{ name?: string, phone?: string, email?: string }} patch
 */
export async function updateContact(contactId, patch) {
  const id = String(contactId || '').trim();
  if (!id) {
    const err = new Error('contactId obrigatório');
    err.status = 400;
    throw err;
  }
  const body = {};
  if (patch?.name != null && String(patch.name).trim()) body.name = String(patch.name).trim();
  if (patch?.phone != null && String(patch.phone).trim()) body.phone = String(patch.phone).trim();
  if (patch?.email != null && String(patch.email).trim()) body.email = String(patch.email).trim();
  if (patch?.source != null && String(patch.source).trim()) body.source = String(patch.source).trim();
  if (!Object.keys(body).length) {
    const err = new Error('Nenhum campo de contact para atualizar');
    err.status = 400;
    throw err;
  }
  return request(`/api/contacts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body,
  });
}

/**
 * @param {{ name: string, email?: string|null, phone?: string|null, source?: string|null }} payload
 */
export async function createContact(payload) {
  const name = String(payload?.name || '').trim();
  if (!name) {
    const err = new Error('name obrigatório para criar contact');
    err.status = 400;
    throw err;
  }
  const body = { name };
  if (payload.email) body.email = String(payload.email).trim();
  if (payload.phone) body.phone = String(payload.phone).trim();
  if (payload.source) body.source = String(payload.source).trim();
  return request('/api/contacts', { method: 'POST', body });
}

/**
 * Atualiza deal (ex.: mover de etapa).
 * @param {string} dealId
 * @param {{ stageId?: string, title?: string, status?: string, lostReason?: string }} patch
 */
export async function updateDeal(dealId, patch) {
  const id = String(dealId || '').trim();
  if (!id) {
    const err = new Error('dealId obrigatório');
    err.status = 400;
    throw err;
  }
  const body = {};
  if (patch?.stageId != null && String(patch.stageId).trim()) {
    body.stageId = String(patch.stageId).trim();
  }
  if (patch?.title != null && String(patch.title).trim()) {
    body.title = String(patch.title).trim();
  }
  if (patch?.status != null && String(patch.status).trim()) {
    body.status = String(patch.status).trim();
  }
  if (patch?.lostReason != null && String(patch.lostReason).trim()) {
    body.lostReason = String(patch.lostReason).trim();
  }
  if (!Object.keys(body).length) {
    const err = new Error('Nenhum campo de deal para atualizar');
    err.status = 400;
    throw err;
  }
  return request(`/api/deals/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body,
  });
}

/**
 * @param {{ title: string, contactId: string, stageId: string, value?: number, lostReason?: string }} payload
 */
export async function createDeal(payload) {
  const title = String(payload?.title || '').trim();
  const contactId = String(payload?.contactId || '').trim();
  const stageId = String(payload?.stageId || '').trim();
  if (!title || !contactId || !stageId) {
    const err = new Error('title, contactId e stageId obrigatórios para criar deal');
    err.status = 400;
    throw err;
  }
  const body = { title, contactId, stageId };
  if (payload.value != null) body.value = payload.value;
  if (payload.lostReason != null && String(payload.lostReason).trim()) {
    body.lostReason = String(payload.lostReason).trim();
  }
  return request('/api/deals', { method: 'POST', body });
}

/**
 * Remove um contact do CRM. Use com cautela (irreversível).
 * @param {string} contactId
 */
export async function deleteContact(contactId) {
  const id = String(contactId || '').trim();
  if (!id) {
    const err = new Error('contactId obrigatório para deletar');
    err.status = 400;
    throw err;
  }
  return request(`/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Remove um deal do CRM. Use com cautela (irreversível).
 * @param {string} dealId
 */
export async function deleteDeal(dealId) {
  const id = String(dealId || '').trim();
  if (!id) {
    const err = new Error('dealId obrigatório para deletar');
    err.status = 400;
    throw err;
  }
  return request(`/api/deals/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Busca contacts por texto (CPF, nome, telefone…).
 * @param {string} q
 */
export async function searchContacts(q) {
  const query = String(q || '').trim();
  if (!query) return { items: [], total: 0 };
  const raw = await request(`/api/contacts?search=${encodeURIComponent(query)}&page=1&perPage=20`);
  return {
    items: Array.isArray(raw?.items) ? raw.items : [],
    total: Number(raw?.total) || 0,
  };
}

/**
 * @param {{ page?: number, perPage?: number }} [opts]
 * @returns {Promise<{ items: object[], total: number, page: number, perPage: number, totalPages: number|null }>}
 */
export async function listContactsPage(opts = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const perPage = Math.min(Math.max(Number(opts.perPage) || 100, 1), 200);
  const raw = await request(`/api/contacts?page=${page}&perPage=${perPage}`);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return {
    items,
    total: Number(raw?.total) || items.length,
    page: Number(raw?.page) || page,
    perPage: Number(raw?.perPage) || perPage,
    totalPages: raw?.totalPages != null ? Number(raw.totalPages) : null,
  };
}

/**
 * @param {{ page?: number, perPage?: number, contactId?: string }} [opts]
 */
export async function listDealsPage(opts = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const perPage = Math.min(Math.max(Number(opts.perPage) || 100, 1), 100);
  const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
  if (opts.contactId) params.set('contactId', String(opts.contactId));
  const raw = await request(`/api/deals?${params.toString()}`);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return {
    items,
    total: Number(raw?.total) || items.length,
    page: Number(raw?.page) || page,
    perPage: Number(raw?.perPage) || perPage,
    totalPages: raw?.totalPages != null ? Number(raw.totalPages) : null,
  };
}

/**
 * Detalhe do deal — inclui dealPanelFields com valores dos custom fields.
 * @param {string} dealId
 */
export async function getDeal(dealId) {
  const id = String(dealId || '').trim();
  if (!id) return null;
  return request(`/api/deals/${encodeURIComponent(id)}`);
}

/**
 * @param {string} contactId
 */
export async function getContact(contactId) {
  const id = String(contactId || '').trim();
  if (!id) return null;
  return request(`/api/contacts/${encodeURIComponent(id)}`);
}

export { tagNameForCategory, ATIVACAO_TAG_BY_CATEGORY } from '../utils/novoCrmActivationTags.js';
