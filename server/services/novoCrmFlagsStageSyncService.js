/**
 * Sync diário/manual de matriculados → deals já existentes no Novo CRM.
 *
 * Modes:
 *   flags_stage — atualiza as 4 flags (Sim/Não) + move etapa (respeitando intocáveis)
 *   fields      — grava campos SIAA só se o cache divergir + alinha etapa + Situação
 *   both        — fields + flags_stage
 *
 * Intocáveis (não move etapa): Ganho, Cancelado; Retenção sem CAA open (manual).
 * CAA open ≤72h → Retenção; após 72h segue SIAA (pode sair de Retenção).
 * Apply otimizado: só reescreve flag quando (a) valor conhecido diverge, ou
 * (b) campo vazio e próximo=Sim (não grava vazio→Não — evita flood de PUTs).
 * Após PUT, writeback no JSON do espelho (applyDealCustomFieldWrites) — Full
 * FETCH=0 não relê flags; sem isso a Att seguinte regrava os mesmos Sim.
 * mode=fields usa a mesma ideia nos campos SIAA: vazio→preenche, igual→skip,
 * diverge→corrige. Sem isso o cron das 05:00 regrava ~38k deals toda noite.
 *
 * Entrada + saída (31/07/2026): o relatório do dia é a verdade. Matriculados
 * é a base "sim": satélites (evasão/docs/…) enriquecem identidade via
 * RGM/CPF → CPF/e-mail/fone do matriculados antes do match no CRM. Loop
 * principal (entrada) + passo inverso (saída Sim→Não / sai Sem Rematricula;
 * órfão sem match matriculados → Perdido).
 * Email/phone só se ÚNICOS. Sanity: nRows < ratio × simCount → pula saída.
 *
 * Situação + remat (03/08/2026): mode=fields também move etapa (não só
 * flags_stage). Quem está no remat mas em Graduação volta pra Sem Rematrícula;
 * quem saiu do remat recebe Situação Em Curso/Cancelado e etapa SIAA.
 * Cancelado/Trancado SIAA vence o label "Sem Rematrícula" no carousel.
 * Em Atendimento é intocável pra etapa (só campos/flags) — fila humana.
 *
 * Situação piggyback (03/08 tarde): flags_stage alinhava carousel Situação
 * só quando o alvo era Sem Rematrícula (entrada remat). Deals já em Grad/Pós/
 * Acol com Sit vazia/errada (∅→Em Curso, Sit=Sem Rematrícula com out_remat)
 * ficavam skip no Att — o align script pegava. Agora sempre alinha Situação
 * via resolveSituacaoCrm quando canMoveStages (flags ou fields), se o cache
 * divergir — sem reescrever os demais campos SIAA do mode=fields.
 *
 * exit_remat_orphan (03/08 noite): ao mover Sem Remat→Perdido sem matRow,
 * limpa carousel "Sem Rematrícula" (não inventa Cancelado). Dedupe→Perdido
 * alinha sit SIAA com inRematricula=false (novoCrmOrphanAlunoProvisionService).
 *
 * Atualizado?=Sim (04/08): só se o PUT inclui campo SIAA core com valor
 * (hasSiaaFieldWrite). Stage-only / flags-only / clear vazio / orphan sem
 * mat NÃO marcam — filtro Kanban espera deals preenchidos.
 *
 * Fora da Relação (31/08): sem match SIAA (já tentou RGM/CPF/e-mail/fone) e
 * etapa mexível → Perdido. Tem CPF/RGM ou não tem (D: telefone já foi
 * buscado). Quem está no relatório remat vai pra Sem Rematrícula, não Perdido.
 * Relação <10k linhas ou <70% do snapshot anterior → não limpa (sanity).
 * Acolhimento continua por turma (Data Matrícula → 1ª mensalidade).
 *
 * Multi-curso (06/08): CPF com 2+ RGMs no SIAA NÃO casa só por CPF/email/fone
 * para sobrescrever RGM/curso/nível/polo/situação/etapa. Match canônico = RGM
 * no deal. Fallback CPF só se 1 RGM SIAA (singleton). Evita Pós→Grad stomp
 * (incidente Naionara: 9 clones com RGM Grad).
 */

import { randomUUID } from 'node:crypto';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import * as caaProtocolsRepo from '../repositories/caaProtocolsRepository.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import {
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeRgm,
} from '../utils/novoCrmCacheNormalize.js';
import {
  extractMatriculadosMappedValues,
  formatDataMatriculaCrm,
  normalizeCursoCrm,
  normalizeNivelCrm,
  normalizeSituacaoCrm,
  resolveSituacaoCrm,
  SITUACAO_CRM_SEM_REMATRICULA,
} from '../utils/novoCrmFieldMapping.js';
import {
  classifyMatriculado,
  getCaaRetencaoHours,
  getNovoCrmDealFieldIds,
  getNovoCrmStageIds,
  isCaaWithinRetencaoWindow,
  isUntouchableStageId,
  stageNameFromId,
  titleCasePolo,
} from '../utils/novoCrmStageRules.js';
import {
  getDeal,
  isNovoCrmApiConfigured,
  updateDeal,
  updateDealCustomFields,
} from './novoCrmClient.js';
import { isNovoCrmWriteAllowedOnThisHost } from './novoCrmMatriculadosProvisionService.js';
import { isNovoCrmCacheSyncRunning } from './novoCrmPersonCacheSyncService.js';
import { marcoFieldPair } from '../utils/marcoRegulatorio.js';
import { fixaDateFieldPairs } from '../utils/fixaMatriculaDates.js';
import { baseRowFilterForCategory } from '../utils/inadPosSiaaImport.js';

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function simNao(v) {
  return v ? 'Sim' : 'Não';
}

const LIMPEZA_DUPLICATA_TAG_PREFIX = 'limpeza_duplicata_';

/**
 * Deals marcados pelo dedupe são quarentena: nenhum job automático pode
 * trocar sua etapa, mesmo que o SIAA/rematrícula classifique outro destino.
 * @param {object|null|undefined} deal
 */
function hasLimpezaDuplicataTag(deal) {
  const tags = Array.isArray(deal?.tags) ? deal.tags : [];
  return tags.some((tag) => {
    const name =
      typeof tag === 'string'
        ? tag
        : String(tag?.name ?? tag?.tagName ?? tag?.value ?? '');
    return name.trim().toLowerCase().startsWith(LIMPEZA_DUPLICATA_TAG_PREFIX);
  });
}

/**
 * Core SIAA keys that count as "preencheu dados" for Atualizado?=Sim.
 * Flags (doc/inad/bb/evasao) e o próprio Atualizado NÃO entram.
 * @see hasSiaaFieldWrite
 */
const SIAA_ATUALIZADO_FIELD_KEYS = [
  'cpf',
  'rgm',
  'curso',
  'polo',
  'situacao',
  'nivel',
  'email',
  'email_ad',
  'nasc',
  'data_matricula',
  'data_rematricula',
  'marco',
];

/**
 * true se `values` grava ao menos um campo SIAA com valor não-vazio.
 * Clear situacao (value '') / só flags / só Atualizado → false.
 * Situação vinda de resolveSituacaoCrm (Em Curso/Cancelado/…) → true.
 */
function hasSiaaFieldWrite(values, fieldIds) {
  if (!Array.isArray(values) || !values.length || !fieldIds) return false;
  const siaaIds = new Set();
  for (const key of SIAA_ATUALIZADO_FIELD_KEYS) {
    const id = String(fieldIds[key] || '').trim();
    if (id) siaaIds.add(id);
  }
  if (!siaaIds.size) return false;
  return values.some((v) => {
    const fid = String(v?.fieldId || '').trim();
    if (!siaaIds.has(fid)) return false;
    const val = v?.value;
    if (val == null) return false;
    return String(val).trim() !== '';
  });
}

/** Marca deal como sincronizado com dados SIAA (campo Atualizado?=Sim). */
function ensureAtualizadoSim(values, fieldIds) {
  const id = String(fieldIds?.atualizado || '').trim();
  if (!id) return values || [];
  const list = Array.isArray(values) ? values : [];
  if (list.some((v) => String(v?.fieldId || '').trim() === id)) return list;
  list.push({ fieldId: id, value: 'Sim' });
  return list;
}

/**
 * Índice de identidade de uma base satélite (rematrícula/docs/inad/bb/evasão).
 * Fluxo: ler o que o arquivo trouxer → enriquecer via matriculados (RGM/CPF)
 * para completar cpf/email/telefone → indexar. Email/phone só entram se
 * ÚNICOS no índice final. `nRows` = linhas do snapshot satélite.
 * `hasSnapshot` distingue "base nunca subida" de "base subida que não rendeu
 * identidade nenhuma" — a segunda é sinal de import quebrado.
 * @typedef {{ cpf: Set<string>, rgm: Set<string>, email: Set<string>, phone: Set<string>, nRows: number, category?: string, hasSnapshot?: boolean }} IdentityIndex
 */

/** @returns {{cpf:string,rgm:string,email:string,phone:string}} */
function pickIdentityFromRow(row) {
  return {
    cpf: normalizeCpf(row.CPF ?? row.cpf ?? row.Cpf),
    rgm: normalizeRgm(row.RGM ?? row.rgm ?? row.Rgm ?? row.RGM_ALUN),
    email: normalizeEmail(row.Email ?? row['E-mail'] ?? row.email ?? row['e-mail']),
    phone: normalizePhone(
      row.Telefone ?? row.Celular ?? row['Fone celular'] ?? row['Fone Celular'] ?? row.phone
    ),
  };
}

/**
 * Completa identidade satélite com dados do matriculados (RGM → CPF/e-mail/fone).
 * Ex.: evasão só traz RGM; matriculados devolve o restante pro match no CRM.
 * @param {{cpf:string,rgm:string,email:string,phone:string}} id
 * @param {Map<string, Record<string, unknown>>|null|undefined} byRgm
 * @param {Map<string, Record<string, unknown>>|null|undefined} byCpf
 */
function enrichIdentityFromMatriculados(id, byRgm, byCpf) {
  if (!byRgm && !byCpf) return id;
  const matRow =
    (id.rgm && byRgm?.get(id.rgm)) || (id.cpf && byCpf?.get(id.cpf)) || null;
  if (!matRow) return id;
  const m = extractMatriculadosMappedValues(matRow);
  return {
    cpf: id.cpf || normalizeCpf(m.cpf),
    rgm: id.rgm || normalizeRgm(m.rgm),
    email: id.email || normalizeEmail(m._email) || normalizeEmail(m.e_mail_ad),
    phone: id.phone || normalizePhone(m._phone || m.telefone_comercial),
  };
}

/**
 * @param {string} category
 * @param {{ byRgm?: Map<string, Record<string, unknown>>, byCpf?: Map<string, Record<string, unknown>> }|null} [matLookups]
 * @returns {Promise<IdentityIndex>}
 */
async function loadIdentityIndexFromBase(category, matLookups = null) {
  /** @type {IdentityIndex} */
  const index = {
    cpf: new Set(),
    rgm: new Set(),
    email: new Set(),
    phone: new Set(),
    nRows: 0,
    category,
    hasSnapshot: false,
  };
  const snap = await baseUploadRepo.getLatestSnapshot(category);
  if (!snap?.id) return index;
  index.hasSnapshot = true;
  const emailCount = new Map();
  const phoneCount = new Map();
  const byRgm = matLookups?.byRgm || null;
  const byCpf = matLookups?.byCpf || null;
  const rowFilter = baseRowFilterForCategory(category);
  await baseUploadRepo.forEachRowDataForSnapshot(category, snap.id, (row) => {
    if (rowFilter && !rowFilter(row)) return;
    index.nRows += 1;
    const id = enrichIdentityFromMatriculados(pickIdentityFromRow(row), byRgm, byCpf);
    if (id.cpf) index.cpf.add(id.cpf);
    if (id.rgm) index.rgm.add(id.rgm);
    if (id.email) emailCount.set(id.email, (emailCount.get(id.email) || 0) + 1);
    if (id.phone) phoneCount.set(id.phone, (phoneCount.get(id.phone) || 0) + 1);
  });
  for (const [email, n] of emailCount) if (n === 1) index.email.add(email);
  for (const [phone, n] of phoneCount) if (n === 1) index.phone.add(phone);
  return index;
}

/**
 * União de índices satélite — usado quando uma flag do CRM é alimentada por
 * mais de um relatório (ex. «Financeira» = vencidos Grad + inadimplentes Pós).
 * `nRows` soma para o guard de sanidade da saída continuar proporcional.
 * @param {...IdentityIndex} indexes
 * @returns {IdentityIndex}
 */
function mergeIdentityIndexes(...indexes) {
  /** @type {IdentityIndex} */
  const out = { cpf: new Set(), rgm: new Set(), email: new Set(), phone: new Set(), nRows: 0 };
  let broken = false;
  for (const idx of indexes) {
    if (!idx) continue;
    // Snapshot existe mas não rendeu identidade nenhuma = import/filtro
    // quebrado (cabeçalho não promovido, coluna renomeada, filtro zerando
    // tudo). Testa CPF/RGM, não `nRows` — linha existe mesmo quando a coluna
    // de identidade sumiu. Zera nRows: o guard de sanidade pula a saída da
    // flag inteira em vez de limpar em massa quem só aparece nessa base.
    if (idx.hasSnapshot && idx.cpf.size === 0 && idx.rgm.size === 0) {
      broken = true;
      console.warn(
        `[novo-crm-flags-sync] base "${idx.category}": snapshot com ${idx.nRows} linha(s) mas 0 identidades — saída da flag desligada por segurança.`
      );
    }
    for (const v of idx.cpf) out.cpf.add(v);
    for (const v of idx.rgm) out.rgm.add(v);
    for (const v of idx.email) out.email.add(v);
    for (const v of idx.phone) out.phone.add(v);
    out.nRows += Number(idx.nRows) || 0;
  }
  if (broken) out.nRows = 0;
  return out;
}

/**
 * @param {IdentityIndex} index
 * @param {{cpf?:string, rgm?:string, email?:string, phone?:string}} identity
 */
function identityInIndex(index, identity = {}) {
  if (!index) return false;
  const { cpf, rgm, email, phone } = identity;
  if (cpf && index.cpf.has(cpf)) return true;
  if (rgm && index.rgm.has(rgm)) return true;
  if (email && index.email.has(email)) return true;
  if (phone && index.phone.has(phone)) return true;
  return false;
}

/** Índice satélite a partir do set `cpf:` / `rgm:` (visto em CAA, qualquer status). */
function identityIndexFromCaaIdSet(idSet) {
  const index = { cpf: new Set(), rgm: new Set(), email: new Set(), phone: new Set(), nRows: 0 };
  if (!idSet || typeof idSet.values !== 'function') return index;
  for (const key of idSet) {
    const s = String(key);
    if (s.startsWith('cpf:')) index.cpf.add(s.slice(4));
    else if (s.startsWith('rgm:')) index.rgm.add(s.slice(4));
  }
  index.nRows = Math.max(index.cpf.size, index.rgm.size);
  return index;
}

/** Ratio mínimo nRows/simCount pra permitir saída (Sim→Não / sair de Sem Rematricula). */
function flagsExitSanityRatio() {
  const v = Number(process.env.NOVO_CRM_FLAGS_EXIT_SANITY_RATIO);
  if (!Number.isFinite(v)) return 0.7;
  return Math.min(Math.max(v, 0), 1);
}

/** Normaliza valor de flag CRM para comparar Sim/Não. */
function normFlagValue(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (!s) return '';
  if (s === 'sim' || s === 'true' || s === '1' || s === 'yes') return 'sim';
  if (s === 'nao' || s === 'false' || s === '0' || s === 'no') return 'nao';
  return s;
}

/**
 * Lê valor de custom field no deal do cache (por id e/ou nome).
 * @param {object} deal
 * @param {string} fieldId
 * @param {string[]} names
 */
function readDealField(deal, fieldId, names = []) {
  const id = String(fieldId || '').trim();
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of deal?.customFields || []) {
    const fid = String(f?.id || f?.fieldId || '').trim();
    const name = String(f?.name || '')
      .trim()
      .toLowerCase();
    if ((id && fid === id) || (wanted.length && wanted.includes(name))) {
      if (f?.value != null && String(f.value).trim() !== '') return String(f.value).trim();
    }
  }
  return '';
}

function foldFieldText(v) {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
}

/**
 * true = não grava. Compara o valor que iríamos mandar com o do cache
 * (mesma fonte das flags). Nunca trata alvo vazio como “limpar”.
 */
function dataMatriculaYmdFromDeal(deal, fieldIds) {
  const raw = readDealField(deal, fieldIds?.data_matricula, [
    'data_de_matricula',
    'data matricula',
    'data de matricula',
  ]);
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }
  return '';
}

function isRecentIsoDate(ymd, days, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return false;
  const t = Date.parse(`${ymd}T12:00:00-03:00`);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= days * 86400000;
}

function fieldValueUnchanged(kind, cur, next) {
  const nxt = String(next ?? '').trim();
  if (!nxt) return true;
  const curS = String(cur ?? '').trim();
  if (!curS) return false;
  switch (kind) {
    case 'cpf':
      return (normalizeCpf(curS) || '') === (normalizeCpf(nxt) || '');
    case 'rgm':
      return (normalizeRgm(curS) || digits(curS)) === (normalizeRgm(nxt) || digits(nxt));
    case 'date':
      return (
        (formatDataMatriculaCrm(curS) || foldFieldText(curS)) ===
        (formatDataMatriculaCrm(nxt) || foldFieldText(nxt))
      );
    case 'situacao':
      return normalizeSituacaoCrm(curS) === normalizeSituacaoCrm(nxt);
    case 'nivel':
      return (normalizeNivelCrm(curS) || foldFieldText(curS)) ===
        (normalizeNivelCrm(nxt) || foldFieldText(nxt));
    case 'email':
      return (normalizeEmail(curS) || foldFieldText(curS)) ===
        (normalizeEmail(nxt) || foldFieldText(nxt));
    case 'curso':
      return foldFieldText(normalizeCursoCrm(curS) || curS) ===
        foldFieldText(normalizeCursoCrm(nxt) || nxt);
    case 'polo':
      return foldFieldText(titleCasePolo(curS) || curS) ===
        foldFieldText(titleCasePolo(nxt) || nxt);
    default:
      return foldFieldText(curS) === foldFieldText(nxt);
  }
}

function pushChangedField(list, deal, fieldId, value, names, kind) {
  const id = String(fieldId || '').trim();
  const next = value == null ? '' : String(value).trim();
  if (!id || !next) return;
  const cur = readDealField(deal, id, names);
  if (fieldValueUnchanged(kind, cur, next)) return;
  list.push({ fieldId: id, value: next });
}

function situacaoRank(row) {
  const sit = String(row['Situação Matrícula'] || row.Situacao || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (sit.includes('CURSO')) return 0;
  if (sit.includes('CANCEL')) return 2;
  return 1;
}

/** Mantém a melhor linha por chave (EM CURSO vence CANCELADO). */
function keepBestRow(map, key, row) {
  if (!key) return;
  const prev = map.get(key);
  if (!prev || situacaoRank(row) < situacaoRank(prev)) map.set(key, row);
}

/**
 * Resolve linha SIAA do deal. RGM no deal é canônico.
 * Multi-curso (2+ RGMs pro mesmo CPF): proíbe match só por CPF/email/fone —
 * evita singleton stomp de RGM/curso no mode=fields.
 * @returns {{ matRow: object|null, via: string|null, multiStrict: boolean }}
 */
function resolveMatRowForDeal({
  rgmDeal,
  cpfDeal,
  emailCache,
  phoneCache,
  byRgm,
  byCpf,
  byEmail,
  byPhone,
  multiRgmCpfs,
}) {
  if (rgmDeal && byRgm.has(rgmDeal)) {
    return { matRow: byRgm.get(rgmDeal), via: 'rgm', multiStrict: false };
  }

  /** @type {{ row: object, via: string, cpf: string }[]} */
  const candidates = [];
  if (cpfDeal && byCpf.has(cpfDeal)) {
    candidates.push({ row: byCpf.get(cpfDeal), via: 'cpf', cpf: cpfDeal });
  }
  if (emailCache && byEmail.has(emailCache)) {
    const row = byEmail.get(emailCache);
    const m = extractMatriculadosMappedValues(row);
    candidates.push({
      row,
      via: 'email',
      cpf: normalizeCpf(m.cpf) || cpfDeal || '',
    });
  }
  if (phoneCache && byPhone.has(phoneCache)) {
    const row = byPhone.get(phoneCache);
    const m = extractMatriculadosMappedValues(row);
    candidates.push({
      row,
      via: 'phone',
      cpf: normalizeCpf(m.cpf) || cpfDeal || '',
    });
  }

  for (const cand of candidates) {
    const cpf = cand.cpf || '';
    if (cpf && multiRgmCpfs.has(cpf)) {
      // multi-curso: sem RGM no deal (ou RGM fora do SIAA) → não stomp
      return { matRow: null, via: null, multiStrict: true };
    }
    return { matRow: cand.row, via: cand.via, multiStrict: false };
  }
  return { matRow: null, via: null, multiStrict: false };
}

function maxErrorsBeforeAbort() {
  // Cap alto: ghost deals no cache (404) não contam — ver isDealMissingError.
  return Math.min(Math.max(Number(process.env.NOVO_CRM_FLAGS_SYNC_MAX_ERRORS) || 50, 5), 2000);
}

/** Workers paralelos no apply (rate limit global do client ainda vale). Default 2, teto 4. */
function flagsSyncConcurrency() {
  return Math.min(Math.max(Number(process.env.NOVO_CRM_FLAGS_SYNC_CONCURRENCY) || 2, 1), 4);
}

/**
 * getDeal live antes de mover? Default OFF — confia no stageId do espelho
 * (Full Sync noturno). Ligue NOVO_CRM_FLAGS_SYNC_LIVE_STAGE=1 se quiser revalidar.
 */
function flagsSyncLiveStage() {
  const v = String(process.env.NOVO_CRM_FLAGS_SYNC_LIVE_STAGE || '').trim();
  return v === '1' || v === 'true';
}

/** Deal apagado no CRM mas ainda no espelho local — skip, não abort. */
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

function findCustom(deal, names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of deal?.customFields || []) {
    const name = String(f?.name || '')
      .trim()
      .toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
}

function dealsFromCacheRow(row) {
  const raw = row?.raw_data || {};
  const byId = raw.dealsById && typeof raw.dealsById === 'object' ? raw.dealsById : {};
  const list = Object.values(byId);
  if (list.length) return list;
  if (row.primary_deal_id) {
    // stageId null → fail-closed no move (não movemos sem saber a etapa).
    return [{ id: String(row.primary_deal_id), stageId: null, customFields: [] }];
  }
  return [];
}

/**
 * @param {{ dryRun?: boolean, mode?: 'flags_stage'|'fields'|'both', maxDeals?: number, jobId?: string|null }} [opts]
 */
export async function runFlagsStageSync(opts = {}) {
  const dryRun = opts.dryRun === true;
  const mode = ['flags_stage', 'fields', 'both'].includes(opts.mode) ? opts.mode : 'flags_stage';
  const doFlags = mode === 'flags_stage' || mode === 'both';
  const doFields = mode === 'fields' || mode === 'both';
  // Fields também alinha etapa (remat ↔ Graduação/Pós/Perdido) — noturno PROD
  // roda flags_stage=OFF, então só fields movia se liberarmos aqui.
  const canMoveStages = doFlags || doFields;
  const maxDeals = Math.min(Math.max(Number(opts.maxDeals) || 50000, 1), 100000);
  const jobId = opts.jobId || null;
  const errorBudget = maxErrorsBeforeAbort();
  let aborted = false;
  let abortReason = null;
  let cancelled = false;
  /** Fase atual p/ last-run / cancel (UI parcial). */
  let currentPhase = 'starting';

  if (!isNovoCrmApiConfigured()) {
    const err = new Error('NOVO_CRM_ENABLED/TOKEN/BASE_URL não configurados');
    err.status = 503;
    throw err;
  }
  if (!isNovoCrmWriteAllowedOnThisHost()) {
    const err = new Error(
      'Sync fields/flags bloqueado neste host. Use CRM DEV ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + NOVO_CRM_API_BASE_URL explícita.'
    );
    err.status = 403;
    throw err;
  }

  const patchJob = (p) => {
    if (p?.phase) currentPhase = p.phase;
    if (!jobId) return;
    const j = jobs.get(jobId);
    if (j) Object.assign(j, p);
  };

  /** Operador pediu stop via POST …/stop (cancel_requested no job). */
  const checkCancel = () => {
    if (!jobId) return false;
    const j = jobs.get(jobId);
    if (j?.cancel_requested) {
      cancelled = true;
      aborted = true;
      abortReason = 'cancelado pelo operador';
      return true;
    }
    return false;
  };

  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap?.id) {
    const err = new Error('Snapshot de matriculados ausente');
    err.status = 400;
    throw err;
  }
  const matSnapPrev = (await baseUploadRepo.listSnapshots('matriculados', { limit: 2 }))[1] || null;
  const curMatRows = Number(matSnap.row_count) || 0;
  const prevMatRows = Number(matSnapPrev?.row_count) || 0;
  const foraRelacaoAllowed =
    curMatRows >= 10000 && (prevMatRows === 0 || curMatRows >= 0.7 * prevMatRows);

  patchJob({ phase: 'loading_bases', status_message: 'Carregando matriculados + bases…' });

  /** @type {Map<string, Record<string, unknown>>} */
  const byCpf = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const byRgm = new Map();
  /** @type {Map<string, Record<string, unknown>>} — só e-mails únicos no relatório */
  const byEmail = new Map();
  /** @type {Map<string, Record<string, unknown>>} — só telefones únicos no relatório */
  const byPhone = new Map();
  /** @type {Map<string, Set<string>>} CPF → RGMs distintos no SIAA (multi-curso) */
  const rgmsByCpf = new Map();
  const emailRowCount = new Map();
  const phoneRowCount = new Map();
  // Matriculados PRIMEIRO — base "sim" pra completar identidade das satélites
  // (evasão etc. muitas vezes só trazem RGM → puxamos CPF/e-mail/fone aqui).
  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
    const m = extractMatriculadosMappedValues(row);
    const cpf = normalizeCpf(m.cpf);
    const rgm = normalizeRgm(m.rgm);
    if (cpf) keepBestRow(byCpf, cpf, row);
    if (rgm) keepBestRow(byRgm, rgm, row);
    if (cpf && rgm) {
      let set = rgmsByCpf.get(cpf);
      if (!set) {
        set = new Set();
        rgmsByCpf.set(cpf, set);
      }
      set.add(rgm);
    }
    const rowEmails = new Set([normalizeEmail(m._email), normalizeEmail(m.e_mail_ad)].filter(Boolean));
    for (const email of rowEmails) {
      emailRowCount.set(email, (emailRowCount.get(email) || 0) + 1);
      keepBestRow(byEmail, email, row);
    }
    const phone = normalizePhone(m._phone || m.telefone_comercial);
    if (phone) {
      phoneRowCount.set(phone, (phoneRowCount.get(phone) || 0) + 1);
      keepBestRow(byPhone, phone, row);
    }
  });
  for (const [email, n] of emailRowCount) if (n > 1) byEmail.delete(email);
  for (const [phone, n] of phoneRowCount) if (n > 1) byPhone.delete(phone);
  /** CPFs com 2+ RGMs no SIAA — fields/stage nunca via singleton CPF */
  const multiRgmCpfs = new Set();
  for (const [cpf, set] of rgmsByCpf) {
    if (set.size > 1) multiRgmCpfs.add(cpf);
  }

  const matLookups = { byRgm, byCpf };
  const [remat, caaT0Map, caaSeenSet, doc, inadGrad, inadPos, fin, bb, evasao] =
    await Promise.all([
      loadIdentityIndexFromBase('rematricula', matLookups),
      caaProtocolsRepo.loadOpenCaaT0Map(),
      caaProtocolsRepo.loadSeenCaaIdSet(),
      loadIdentityIndexFromBase('docs-pendentes', matLookups),
      loadIdentityIndexFromBase('inadimplentes-vencidos', matLookups),
      loadIdentityIndexFromBase('inadimplentes-pos-siaa', matLookups),
      loadIdentityIndexFromBase('financeiro', matLookups),
      loadIdentityIndexFromBase('acessos-blackboard', matLookups),
      loadIdentityIndexFromBase('provavel-evasao', matLookups),
    ]);
  // Campo CRM «Financeira» (situacaofinanceira) = vencidos da Graduação (SIAA
  // web) + inadimplentes da Pós (export SIAA por polo). União nas duas pontas:
  // entrada marca Sim, e o passo de saída só limpa quem não está em nenhuma
  // das duas — senão uma base zeraria a flag da outra.
  const inad = mergeIdentityIndexes(inadGrad, inadPos);
  const caaRetencaoHours = getCaaRetencaoHours();
  const caaSeen = identityIndexFromCaaIdSet(caaSeenSet);
  const stageIds = getNovoCrmStageIds();
  const retencaoStageId = String(stageIds.Retenção || '').trim();
  const semRematStageId = String(stageIds['Sem Rematricula'] || '').trim();
  const perdidoStageId = String(stageIds.Perdido || '').trim();

  patchJob({ phase: 'loading_cache', status_message: 'Carregando espelho local…' });
  const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({
    scope: 'all_mapped',
    limit: 100000,
  });

  const fieldIds = getNovoCrmDealFieldIds();
  let scanned = 0;
  let matched = 0;
  let flagsUpdated = 0;
  let stagesMoved = 0;
  let stagesSkippedUntouchable = 0;
  let stagesSkippedLimpezaDuplicata = 0;
  let stagesSkippedUnknown = 0;
  let fieldsUpdated = 0;
  let skippedNoMatch = 0;
  let skippedMultiStrict = 0;
  let skippedNoDeal = 0;
  let skippedMissing = 0;
  let skippedUnchanged = 0;
  let situacaoSemRematUpdated = 0;
  let situacaoSemRematWouldUpdate = 0;
  let errors = 0;
  const liveStage = flagsSyncLiveStage();
  const concurrency = dryRun ? 1 : flagsSyncConcurrency();
  /** @type {Record<string, number>} */
  const stagesByTarget = {};
  /** @type {Array<object>} */
  const samples = [];
  /** @type {Array<object>} */
  const errorSamples = [];
  /** @type {Array<object>} */
  const workQueue = [];
  let flagsExitCleared = 0;
  let stagesExitRemat = 0;
  let stagesExitRematOrphan = 0;
  let stagesForaRelacao = 0;
  let stagesSemIdentidade = 0;
  let stagesRematSemRelacao = 0;
  /** Identificados na varredura (ainda não gravados no apply). */
  let flagsQueued = 0;
  let stagesQueued = 0;
  /** @type {Record<string, number>} */
  const exitSkippedSanity = {};

  const noteError = (sample) => {
    errors += 1;
    if (errorSamples.length < 15) errorSamples.push(sample);
    if (errors >= errorBudget && !aborted) {
      aborted = true;
      abortReason = `abort após ${errors} erros`;
      console.error(`[novo-crm-flags-sync] ${abortReason}`);
    }
  };

  const noteMissing = (dealId, cpf) => {
    skippedMissing += 1;
    if (skippedMissing <= 5 || skippedMissing % 100 === 0) {
      console.warn(
        `[novo-crm-flags-sync] SKIP missing deal=${dealId} cpf=${cpf || '?'} (total=${skippedMissing})`
      );
    }
  };

  patchJob({
    phase: 'processing',
    status_message: 'Processando deals…',
    total: cacheRows.length,
  });

  outer: for (const row of cacheRows) {
    if (aborted || checkCancel()) break;
    const deals = dealsFromCacheRow(row);
    if (!deals.length) {
      skippedNoDeal += 1;
      continue;
    }

    const cpfCache = normalizeCpf(row.cpf_norm);
    const emailCache = normalizeEmail(row.email_norm);
    const phoneCache =
      normalizePhone(row.phone_norm) ||
      normalizePhone(row.raw_data?.contact?.phone) ||
      normalizePhone(row.raw_data?.contact?.mobilePhone) ||
      normalizePhone(row.raw_data?.contact?.whatsapp);

    for (const deal of deals) {
      if (aborted || checkCancel() || scanned >= maxDeals) break outer;
      scanned += 1;
      if (scanned % 50 === 0 || scanned === 1) {
        // Apply: during scan flags_updated still 0 — expose queue + partial scanned for live UI / cancel.
        const liveFlags = dryRun ? flagsUpdated : flagsUpdated + flagsQueued;
        const liveStages = dryRun ? stagesMoved : stagesMoved + stagesQueued;
        patchJob({
          processed: scanned,
          total: Math.min(maxDeals, cacheRows.length) || scanned,
          sent: flagsUpdated + stagesMoved + fieldsUpdated,
          matched,
          flags_updated: liveFlags,
          stages_moved: liveStages,
          status_message: dryRun
            ? `Prévia: ${scanned.toLocaleString('pt-BR')} deals (match ${matched})…`
            : `Calculando: ${scanned.toLocaleString('pt-BR')} deals · match ${matched} · fila ${workQueue.length}…`,
        });
      }

      const dealId = String(deal.id || '').trim();
      if (!dealId) continue;

      const rgmDeal = normalizeRgm(findCustom(deal, ['rgm']) || row.rgm_norm);
      const cpfDeal = normalizeCpf(findCustom(deal, ['cpf']) || cpfCache);
      // RGM canônico. Multi-curso: sem RGM no deal → não stomp RGM/curso via CPF.
      const resolved = resolveMatRowForDeal({
        rgmDeal,
        cpfDeal,
        emailCache,
        phoneCache,
        byRgm,
        byCpf,
        byEmail,
        byPhone,
        multiRgmCpfs,
      });
      const matRow = resolved.matRow;
      if (!matRow) {
        if (resolved.multiStrict) {
          skippedMultiStrict += 1;
          continue;
        }
        const currentStageId = String(deal.stageId || '').trim() || null;
        const identityLoose = {
          cpf: cpfDeal,
          rgm: rgmDeal,
          email: emailCache,
          phone: phoneCache,
        };
        const inRemat = identityInIndex(remat, identityLoose);
        const hasId = Boolean(cpfDeal || rgmDeal);
        const caaT0Loose = caaProtocolsRepo.lookupCaaT0(caaT0Map, cpfDeal, rgmDeal);
        const inCaaFreshLoose = isCaaWithinRetencaoWindow(caaT0Loose);
        // Só o botão Att (flags_stage/both). O cron fields das 05:00 não manda
        // Perdido em massa — Relação D−1 + sanity frouxa seria perigoso.
        const foraRelacaoEnabled = doFlags && foraRelacaoAllowed;
        if (!foraRelacaoEnabled) {
          if (doFlags && !foraRelacaoAllowed) {
            exitSkippedSanity.fora_relacao = (exitSkippedSanity.fora_relacao || 0) + 1;
          }
          skippedNoMatch += 1;
          continue;
        }
        if (!currentStageId) {
          stagesSkippedUnknown += 1;
          continue;
        }
        if (isUntouchableStageId(currentStageId) || currentStageId === perdidoStageId) {
          if (isUntouchableStageId(currentStageId)) stagesSkippedUntouchable += 1;
          else skippedUnchanged += 1;
          continue;
        }
        if (retencaoStageId && currentStageId === retencaoStageId) {
          stagesSkippedUntouchable += 1;
          continue;
        }
        if (hasLimpezaDuplicataTag(deal)) {
          stagesSkippedLimpezaDuplicata += 1;
          continue;
        }
        if (!inRemat && !inCaaFreshLoose && isRecentIsoDate(dataMatriculaYmdFromDeal(deal, fieldIds), 5)) {
          skippedNoMatch += 1;
          continue;
        }
        const targetName = inCaaFreshLoose
          ? 'Retenção'
          : inRemat
            ? 'Sem Rematricula'
            : 'Perdido';
        const targetId = inCaaFreshLoose
          ? retencaoStageId
          : inRemat
            ? semRematStageId
            : perdidoStageId;
        if (!targetId) {
          skippedNoMatch += 1;
          continue;
        }
        if (currentStageId === targetId) {
          skippedUnchanged += 1;
          continue;
        }
        if (inCaaFreshLoose) {
          /* Retenção: não conta como limpeza Perdido */
        } else if (inRemat) stagesRematSemRelacao += 1;
        else if (hasId) stagesForaRelacao += 1;
        else stagesSemIdentidade += 1;
        stagesByTarget[targetName] = (stagesByTarget[targetName] || 0) + 1;
        if (dryRun) {
          stagesMoved += 1;
          if (samples.length < 20) {
            samples.push({
              dry_run: true,
              fora_relacao: true,
              reason: inCaaFreshLoose
                ? 'caa_retencao'
                : inRemat
                  ? 'remat_sem_relacao'
                  : hasId
                    ? 'fora_relacao'
                    : 'sem_identidade',
              dealId,
              cpf: cpfDeal,
              rgm: rgmDeal,
              from: stageNameFromId(currentStageId) || currentStageId,
              to: targetName,
            });
          }
          continue;
        }
        workQueue.push({
          contactId: String(row.contact_id || '').trim(),
          dealId,
          cpf: cpfDeal,
          rgm: rgmDeal,
          inCaaOpen: inCaaFreshLoose,
          inCaaFresh: inCaaFreshLoose,
          classification: { stageName: targetName, stageId: targetId },
          values: [],
          needsFlagWrite: false,
          needsFieldWrite: false,
          needsSemRematSituacao: false,
          needsMove: true,
          needsLiveStage: true,
          fromStageId: currentStageId,
          isForaRelacao: !inRemat,
        });
        stagesQueued += 1;
        continue;
      }
      matched += 1;

      const mapped = extractMatriculadosMappedValues(matRow);
      const cpf = normalizeCpf(mapped.cpf) || cpfDeal;
      const rgm = normalizeRgm(mapped.rgm) || rgmDeal;
      const emailForMatch = normalizeEmail(mapped._email) || normalizeEmail(mapped.e_mail_ad) || emailCache;
      const phoneForMatch =
        normalizePhone(mapped._phone || mapped.telefone_comercial) || phoneCache;
      const identity = {
        cpf,
        rgm,
        email: emailForMatch,
        phone: phoneForMatch,
      };
      const caaT0 = caaProtocolsRepo.lookupCaaT0(caaT0Map, cpf, rgm);
      const inCaaOpen = Boolean(caaT0);
      const inCaaFresh = isCaaWithinRetencaoWindow(caaT0);
      const inCaaSeen = identityInIndex(caaSeen, identity);
      const classification = classifyMatriculado(matRow, {
        inRematricula: identityInIndex(remat, identity),
        inCaaOpen,
        inCaaFresh,
        inCaaSeen,
        inDoc: identityInIndex(doc, identity),
        inInad: identityInIndex(inad, identity),
        inFinanceiro: identityInIndex(fin, identity),
        inBb: identityInIndex(bb, identity),
        inEvasao: identityInIndex(evasao, identity),
      });
      stagesByTarget[classification.stageName] =
        (stagesByTarget[classification.stageName] || 0) + 1;

      // Cache stageId — se ausente, fail-closed (não move).
      let currentStageId = String(deal.stageId || '').trim() || null;
      const cleanupProtected = hasLimpezaDuplicataTag(deal);

      /** @type {Array<{fieldId:string,value:string}>} */
      const flagValues = [];
      if (doFlags) {
        const flagPairs = [
          [
            fieldIds.doc_pendentes,
            simNao(classification.flags.doc_pendentes),
            ['doc pendentes', 'doc_pendentes', 'docpendente'],
          ],
          [
            fieldIds.inadimplente,
            simNao(classification.flags.inadimplente),
            // PROD: custom field `situacaofinanceira` (label Financeira) = vencidos.
            // NÃO incluir alias `financeiro` — esse é o flag da base Financeiro (prazo/desconto).
            ['inadimplente', 'situacaofinanceira', 'situacao financeira', 'financeira'],
          ],
          [
            fieldIds.financeiro,
            simNao(classification.flags.financeiro),
            // PROD: name `dia` label "Dia 10" — aliases de leitura (não misturar com situacaofinanceira).
            ['dia 10', 'dia10', 'dia', 'financeiro'],
          ],
          [
            fieldIds.acessoblack,
            simNao(classification.flags.acessoblack),
            ['acessoblack', 'acesso black'],
          ],
          [fieldIds.evasao, simNao(classification.flags.evasao), ['evasao', 'evasão']],
          [
            fieldIds.caa,
            simNao(classification.flags.caa),
            ['caa', 'processos caa', 'processos-caa'],
          ],
        ];
        for (const [fieldId, value, names] of flagPairs) {
          if (!fieldId) continue;
          const cur = normFlagValue(readDealField(deal, fieldId, names));
          const next = normFlagValue(value);
          // Política (31/07/2026):
          // - vazio + próximo=Sim → preenche (corrige subcontagem vs bases)
          // - vazio + próximo=Não → NÃO grava (evita 4 PUTs × N deals = gargalo antigo)
          // - já tem valor e diverge → corrige
          if (cur === next) continue;
          if (!cur && next !== 'sim') continue;
          flagValues.push({ fieldId, value });
        }
      }

      /** @type {Array<{fieldId:string,value:string}>} */
      const fieldValues = [];
      if (doFields) {
        pushChangedField(fieldValues, deal, fieldIds.cpf, digits(mapped.cpf), ['cpf', 'documento', 'taxid'], 'cpf');
        pushChangedField(fieldValues, deal, fieldIds.rgm, digits(mapped.rgm), ['rgm'], 'rgm');
        pushChangedField(fieldValues, deal, fieldIds.curso, mapped.curso, ['curso'], 'curso');
        const fixaDates = fixaDateFieldPairs(fieldIds, digits(mapped.rgm));
        if (fixaDates.length) {
          for (const pair of fixaDates) {
            const isRemat = pair.fieldId === String(fieldIds.data_rematricula || '').trim();
            pushChangedField(
              fieldValues,
              deal,
              pair.fieldId,
              pair.value,
              isRemat
                ? ['data_rematricula', 'data_de_rematricula', 'data rematricula']
                : ['data_de_matricula', 'data matricula', 'data de matricula'],
              'date'
            );
          }
        } else {
          pushChangedField(
            fieldValues,
            deal,
            fieldIds.data_matricula,
            mapped.data_matricula,
            ['data_de_matricula', 'data matricula', 'data de matricula'],
            'date'
          );
        }
        {
          const marco = marcoFieldPair(fieldIds, matRow);
          if (marco) {
            pushChangedField(
              fieldValues,
              deal,
              marco.fieldId,
              marco.value,
              ['marco_regulatorio_2', 'marco regulatorio', 'marco'],
              'text'
            );
          }
        }
        pushChangedField(
          fieldValues,
          deal,
          fieldIds.polo,
          titleCasePolo(mapped.polo) || mapped.polo,
          ['polo'],
          'polo'
        );
        const situacao = resolveSituacaoCrm(
          mapped.situacao || matRow['Situação Matrícula'],
          { inRematricula: identityInIndex(remat, identity) }
        );
        pushChangedField(
          fieldValues,
          deal,
          fieldIds.situacao,
          situacao,
          ['situação', 'situacao', 'situação matrícula'],
          'situacao'
        );
        pushChangedField(fieldValues, deal, fieldIds.nivel, mapped.nivel, ['nivel', 'nível'], 'nivel');
        pushChangedField(fieldValues, deal, fieldIds.email, mapped._email, ['email', 'e-mail'], 'email');
        pushChangedField(
          fieldValues,
          deal,
          fieldIds.email_ad,
          mapped.e_mail_ad,
          ['e_mail_ad', 'email academico', 'email acadêmico'],
          'email'
        );
        if (matRow['Data Nascimento'] && fieldIds.nasc) {
          pushChangedField(
            fieldValues,
            deal,
            fieldIds.nasc,
            String(matRow['Data Nascimento']).slice(0, 10),
            ['data_nascimento', 'nascimento', 'data nascimento'],
            'date'
          );
        }
      }

      // carousel Situação: sempre alinha com remat/SIAA quando Att/fields
      // mexe no deal (canMoveStages). Antes: só se alvo = Sem Rematricula —
      // buraco que deixava Grad com Sit vazia/errada após mode=flags_stage.
      // resolveSituacaoCrm: Cancel/Tranc SIAA > remat > situação SIAA.
      const semRematSituacaoValues = [];
      if (canMoveStages && fieldIds.situacao) {
        const alreadyInFieldValues =
          doFields && fieldValues.some((fv) => fv.fieldId === fieldIds.situacao);
        if (!alreadyInFieldValues) {
          const curSituacao = readDealField(deal, fieldIds.situacao, [
            'situação',
            'situacao',
            'situação matrícula',
          ]);
          const targetSit = resolveSituacaoCrm(mapped.situacao || matRow['Situação Matrícula'], {
            inRematricula: identityInIndex(remat, identity),
          });
          if (
            targetSit &&
            normalizeSituacaoCrm(curSituacao) !== normalizeSituacaoCrm(targetSit)
          ) {
            semRematSituacaoValues.push({ fieldId: fieldIds.situacao, value: targetSit });
          }
        }
      }

      const values = [...flagValues, ...fieldValues, ...semRematSituacaoValues];

      /**
       * @param {string|null} stageId
       * @param {boolean} caaOpen
       */
      const decideMove = (stageId, caaOpen) => {
        if (!canMoveStages || !classification.stageId) {
          return { move: false, untouchable: false, cleanupProtected: false, unknown: false };
        }
        if (cleanupProtected) {
          return { move: false, untouchable: true, cleanupProtected: true, unknown: false };
        }
        if (!stageId) {
          return { move: false, untouchable: false, cleanupProtected: false, unknown: true };
        }
        if (isUntouchableStageId(stageId)) {
          return { move: false, untouchable: true, cleanupProtected: false, unknown: false };
        }
        // Retenção sem CAA open = manual / outra automação — não mexe.
        if (retencaoStageId && stageId === retencaoStageId && !caaOpen) {
          return { move: false, untouchable: true, cleanupProtected: false, unknown: false };
        }
        if (classification.stageId === stageId) {
          return { move: false, untouchable: false, cleanupProtected: false, unknown: false };
        }
        return { move: true, untouchable: false, cleanupProtected: false, unknown: false };
      };

      if (dryRun) {
        const d = decideMove(currentStageId, inCaaOpen);
        if (doFlags && flagValues.length) flagsUpdated += 1;
        if (doFields && fieldValues.length) fieldsUpdated += 1;
        if (semRematSituacaoValues.length) situacaoSemRematWouldUpdate += 1;
        if (!flagValues.length && !fieldValues.length && !semRematSituacaoValues.length && !d.move) skippedUnchanged += 1;
        if (d.move) stagesMoved += 1;
        else if (d.cleanupProtected) stagesSkippedLimpezaDuplicata += 1;
        else if (d.untouchable) stagesSkippedUntouchable += 1;
        else if (d.unknown) stagesSkippedUnknown += 1;
        if (samples.length < 20) {
          samples.push({
            dry_run: true,
            dealId,
            cpf,
            rgm,
            from: stageNameFromId(currentStageId) || currentStageId,
            to: classification.stageName,
            move: d.move,
            untouchable: d.untouchable,
            cleanup_protected: d.cleanupProtected,
            unknown_stage: d.unknown,
            in_caa_fresh: inCaaFresh,
            in_caa_open: inCaaOpen,
            in_caa_seen: inCaaSeen,
            flags: classification.flags,
            flags_would_write: flagValues.length,
            situacao_sem_remat_would_write: semRematSituacaoValues.length > 0,
          });
        }
        continue;
      }

      const cacheDecide = decideMove(currentStageId, inCaaOpen);
      const needsFlagWrite = flagValues.length > 0;
      const needsFieldWrite = fieldValues.length > 0;
      const needsSemRematSituacao = semRematSituacaoValues.length > 0;
      const needsMove = Boolean(cacheDecide.move && classification.stageId);
      // Etapa desconhecida no cache: só getDeal se LIVE_STAGE=1; senão skip move.
      const contactId = String(row.contact_id || '').trim();
      const enqueue = (item) => {
        workQueue.push({ ...item, contactId: item.contactId || contactId });
        if (item.needsFlagWrite) flagsQueued += 1;
        if (item.needsMove) stagesQueued += 1;
      };

      if (cacheDecide.unknown) {
        if (liveStage && canMoveStages && classification.stageId) {
          enqueue({
            dealId,
            cpf,
            rgm,
            inCaaOpen,
            inCaaFresh,
            classification,
            values,
            needsFlagWrite,
            needsFieldWrite,
            needsSemRematSituacao,
            needsMove: true,
            needsLiveStage: true,
            fromStageId: currentStageId,
          });
        } else {
          stagesSkippedUnknown += 1;
          if (!needsFlagWrite && !needsFieldWrite && !needsSemRematSituacao) skippedUnchanged += 1;
          else {
            enqueue({
              dealId,
              cpf,
              rgm,
              inCaaOpen,
              inCaaFresh,
              classification,
              values,
              needsFlagWrite,
              needsFieldWrite,
              needsSemRematSituacao,
              needsMove: false,
              needsLiveStage: false,
              fromStageId: currentStageId,
            });
          }
        }
        continue;
      }

      if (!needsFlagWrite && !needsFieldWrite && !needsSemRematSituacao && !needsMove) {
        skippedUnchanged += 1;
        if (cacheDecide.untouchable) stagesSkippedUntouchable += 1;
        continue;
      }

      enqueue({
        dealId,
        cpf,
        rgm,
        inCaaOpen,
        inCaaFresh,
        classification,
        values,
        needsFlagWrite,
        needsFieldWrite,
        needsSemRematSituacao,
        needsMove,
        // Toda troca de etapa revalida ao vivo: a tag limpeza_duplicata pode
        // ter sido aplicada depois do último Full Sync e nunca pode ser ignorada.
        needsLiveStage: Boolean(needsMove),
        fromStageId: currentStageId,
      });
    }
  }

  // ===== Passo INVERSO (saída): fecha flags/etapa de quem SAIU da base do dia. =====
  // Varre TODOS os deals do cache com flag=Sim / etapa Sem Remat. Quem já foi
  // enfileirado no loop principal (matched) é mesclado por dealId (idempotente).
  // mode=fields também roda saída de Sem Rematrícula (reclassifica + Situação).
  if ((doFlags || doFields) && !aborted && !checkCancel()) {
    patchJob({ phase: 'processing_exit', status_message: 'Verificando saídas (entrada/saída)…' });

    const sanityRatio = flagsExitSanityRatio();
    const exitFlagDefs = doFlags
      ? [
          {
            key: 'doc_pendentes',
            fieldId: fieldIds.doc_pendentes,
            names: ['doc pendentes', 'doc_pendentes', 'docpendente'],
            index: doc,
          },
          {
            key: 'inadimplente',
            fieldId: fieldIds.inadimplente,
            names: ['inadimplente', 'situacaofinanceira', 'situacao financeira', 'financeira'],
            index: inad,
          },
          {
            key: 'financeiro',
            fieldId: fieldIds.financeiro,
            names: ['dia 10', 'dia10', 'dia', 'financeiro'],
            index: fin,
          },
          {
            key: 'acessoblack',
            fieldId: fieldIds.acessoblack,
            names: ['acessoblack', 'acesso black'],
            index: bb,
          },
          { key: 'evasao', fieldId: fieldIds.evasao, names: ['evasao', 'evasão'], index: evasao },
          // CAA NÃO entra no passo inverso: o XLSX é D−1 (quem estava ontem
          // não está hoje). Sim é sticky em quem já apareceu em caa_protocols.
        ]
      : [];

    /** @type {Record<string, number>} */
    const flagSimCount = {
      doc_pendentes: 0,
      inadimplente: 0,
      financeiro: 0,
      acessoblack: 0,
      evasao: 0,
    };
    /** @type {Array<{dealId:string, fieldId:string, key:string, cpf:string, rgm:string}>} */
    const flagExitCandidates = [];
    let semRematSimCount = 0;
    /** @type {Array<{dealId:string, deal:object, cpf:string, rgm:string, matRow:object, currentStageId:string}>} */
    const semRematExitCandidates = [];

    for (const row of cacheRows) {
      const deals = dealsFromCacheRow(row);
      if (!deals.length) continue;
      const cpfCache = normalizeCpf(row.cpf_norm);
      const emailCache = normalizeEmail(row.email_norm);
      const phoneCache = normalizePhone(row.phone_norm);

      for (const deal of deals) {
        const dealId = String(deal.id || '').trim();
        if (!dealId) continue;

        const rgmDeal = normalizeRgm(findCustom(deal, ['rgm']) || row.rgm_norm);
        const cpfDeal = normalizeCpf(findCustom(deal, ['cpf']) || cpfCache);
        // Mesma resolução do loop principal (multi-curso = RGM-only).
        const resolvedExit = resolveMatRowForDeal({
          rgmDeal,
          cpfDeal,
          emailCache,
          phoneCache,
          byRgm,
          byCpf,
          byEmail,
          byPhone,
          multiRgmCpfs,
        });
        const matForIdentity = resolvedExit.matRow;
        let identity = { cpf: cpfDeal, rgm: rgmDeal, email: emailCache, phone: phoneCache };
        if (matForIdentity) {
          const mappedId = extractMatriculadosMappedValues(matForIdentity);
          identity = {
            cpf: normalizeCpf(mappedId.cpf) || cpfDeal,
            rgm: normalizeRgm(mappedId.rgm) || rgmDeal,
            email:
              normalizeEmail(mappedId._email) ||
              normalizeEmail(mappedId.e_mail_ad) ||
              emailCache,
            phone: normalizePhone(mappedId._phone || mappedId.telefone_comercial) || phoneCache,
          };
        }

        for (const def of exitFlagDefs) {
          if (!def.fieldId) continue;
          const cur = normFlagValue(readDealField(deal, def.fieldId, def.names));
          if (cur !== 'sim') continue;
          flagSimCount[def.key] += 1;
          if (!identityInIndex(def.index, identity)) {
            flagExitCandidates.push({
              dealId,
              contactId: String(row.contact_id || '').trim(),
              fieldId: def.fieldId,
              key: def.key,
              cpf: identity.cpf,
              rgm: identity.rgm,
            });
          }
        }

        const currentStageId = String(deal.stageId || '').trim() || null;
        if (semRematStageId && currentStageId === semRematStageId) {
          semRematSimCount += 1;
          const noCpfRgm = !cpfDeal && !rgmDeal;
          // Sem CPF e sem RGM → captura/não sincronizado → Perdido.
          // Fora do remat: com matRow reclassifica; sem matRow → Perdido.
          if (noCpfRgm) {
            semRematExitCandidates.push({
              dealId,
              contactId: String(row.contact_id || '').trim(),
              deal,
              cpf: identity.cpf,
              rgm: identity.rgm,
              matRow: null,
              currentStageId,
              orphan: true,
              reason: 'no_cpf_rgm',
            });
          } else if (!identityInIndex(remat, identity)) {
            semRematExitCandidates.push({
              dealId,
              contactId: String(row.contact_id || '').trim(),
              deal,
              cpf: identity.cpf,
              rgm: identity.rgm,
              matRow: matForIdentity || null,
              currentStageId,
              orphan: !matForIdentity,
              reason: matForIdentity ? 'left_remat_base' : 'no_mat_match',
            });
          }
        }
      }
    }

    /** @type {Record<string, boolean>} */
    const flagsExitAllowed = {};
    for (const def of exitFlagDefs) {
      const base = def.index;
      const simCount = flagSimCount[def.key];
      const allowed = base.nRows > 0 && base.nRows >= sanityRatio * simCount;
      flagsExitAllowed[def.key] = allowed;
      if (!allowed) {
        exitSkippedSanity[def.key] = flagExitCandidates.filter((c) => c.key === def.key).length;
      }
    }
    const semRematExitAllowed = remat.nRows > 0 && remat.nRows >= sanityRatio * semRematSimCount;
    if (!semRematExitAllowed) exitSkippedSanity.sem_rematricula = semRematExitCandidates.length;

    const workQueueByDealId = new Map(workQueue.map((item) => [item.dealId, item]));

    // --- Flags: Sim→Não quando a identidade some da base (sanity permitindo) ---
    for (const def of exitFlagDefs) {
      if (!flagsExitAllowed[def.key]) continue;
      const candidates = flagExitCandidates.filter((c) => c.key === def.key);
      for (const c of candidates) {
        if (dryRun) {
          flagsExitCleared += 1;
          if (samples.length < 20) {
            samples.push({
              dry_run: true,
              exit: true,
              dealId: c.dealId,
              cpf: c.cpf,
              rgm: c.rgm,
              flag: def.key,
              from: 'Sim',
              to: 'Não',
            });
          }
          continue;
        }
        let item = workQueueByDealId.get(c.dealId);
        if (!item) {
          item = {
            dealId: c.dealId,
            contactId: c.contactId || '',
            cpf: c.cpf,
            rgm: c.rgm,
            inCaaOpen: false,
            inCaaFresh: false,
            classification: null,
            values: [],
            needsFlagWrite: false,
            needsFieldWrite: false,
            needsSemRematSituacao: false,
            needsMove: false,
            needsLiveStage: false,
            fromStageId: null,
          };
          workQueueByDealId.set(c.dealId, item);
          workQueue.push(item);
        } else if (c.contactId && !item.contactId) {
          item.contactId = c.contactId;
        }
        if (!item.values.some((v) => v.fieldId === def.fieldId)) {
          item.values.push({ fieldId: def.fieldId, value: 'Não' });
          item.needsFlagWrite = true;
          item.exitFlagCount = (item.exitFlagCount || 0) + 1;
        }
      }
    }

    // --- Sem Rematricula: fora do remat → reclassifica (com matRow) ou Perdido (órfão) ---
    if (semRematExitAllowed) {
      for (const c of semRematExitCandidates) {
        const existing = workQueueByDealId.get(c.dealId);
        if (existing?.needsMove) continue; // já tratado pelo loop principal.

        // Órfão: sem match matriculados → Perdido (limpa captura/WhatsApp da fila).
        // Sem SIAA não inventamos Cancelado; mas limpa carousel "Sem Rematrícula"
        // pra não polluir filtro Perdido+Situação no Kanban (UI ~34 do 03/08).
        if (c.orphan || !c.matRow) {
          if (!perdidoStageId) continue;
          const classification = { stageName: 'Perdido', stageId: perdidoStageId };
          const curSitOrphan = fieldIds.situacao
            ? readDealField(c.deal, fieldIds.situacao, [
                'situação',
                'situacao',
                'situação matrícula',
              ])
            : '';
          const clearStaleSemRemat =
            Boolean(fieldIds.situacao) &&
            normalizeSituacaoCrm(curSitOrphan) ===
              normalizeSituacaoCrm(SITUACAO_CRM_SEM_REMATRICULA);
          if (dryRun) {
            stagesExitRematOrphan += 1;
            if (samples.length < 20) {
              samples.push({
                dry_run: true,
                exit: true,
                orphan: true,
                dealId: c.dealId,
                cpf: c.cpf,
                rgm: c.rgm,
                from: 'Sem Rematricula',
                to: 'Perdido',
                situacao_would_clear_sem_remat: clearStaleSemRemat,
              });
            }
            continue;
          }
          let item = workQueueByDealId.get(c.dealId);
          if (!item) {
            item = {
              dealId: c.dealId,
              contactId: c.contactId || '',
              cpf: c.cpf,
              rgm: c.rgm,
              inCaaOpen: false,
              inCaaFresh: false,
              classification,
              values: [],
              needsFlagWrite: false,
              needsFieldWrite: false,
              needsSemRematSituacao: false,
              needsMove: true,
              needsLiveStage: true,
              fromStageId: c.currentStageId,
              isExitRemat: true,
              isExitRematOrphan: true,
            };
            workQueueByDealId.set(c.dealId, item);
            workQueue.push(item);
          } else {
            if (c.contactId && !item.contactId) item.contactId = c.contactId;
            item.classification = classification;
            item.needsMove = true;
            item.needsLiveStage = true;
            item.isExitRemat = true;
            item.isExitRematOrphan = true;
            if (!item.fromStageId) item.fromStageId = c.currentStageId;
          }
          // Limpa "Sem Rematrícula" residual no Perdido (não inventa Cancelado).
          if (
            clearStaleSemRemat &&
            !item.values.some((v) => v.fieldId === fieldIds.situacao)
          ) {
            item.values.push({ fieldId: fieldIds.situacao, value: '' });
            item.needsSemRematSituacao = true;
          }
          continue;
        }

        const mapped = extractMatriculadosMappedValues(c.matRow);
        const cpf = normalizeCpf(mapped.cpf) || c.cpf;
        const rgm = normalizeRgm(mapped.rgm) || c.rgm;
        const emailForMatch = normalizeEmail(mapped._email) || normalizeEmail(mapped.e_mail_ad);
        const phoneForMatch = normalizePhone(mapped._phone || mapped.telefone_comercial);
        const exitIdentity = {
          cpf,
          rgm,
          email: emailForMatch,
          phone: phoneForMatch,
        };
        const caaT0 = caaProtocolsRepo.lookupCaaT0(caaT0Map, cpf, rgm);
        const inCaaOpen = Boolean(caaT0);
        const inCaaFresh = isCaaWithinRetencaoWindow(caaT0);
        const inCaaSeen = identityInIndex(caaSeen, exitIdentity);
        const classification = classifyMatriculado(c.matRow, {
          inRematricula: false,
          inCaaOpen,
          inCaaFresh,
          inCaaSeen,
          inDoc: identityInIndex(doc, exitIdentity),
          inInad: identityInIndex(inad, exitIdentity),
          inFinanceiro: identityInIndex(fin, exitIdentity),
          inBb: identityInIndex(bb, exitIdentity),
          inEvasao: identityInIndex(evasao, exitIdentity),
        });

        const situacaoValues = [];
        if (fieldIds.situacao) {
          const curSituacao = readDealField(c.deal, fieldIds.situacao, [
            'situação',
            'situacao',
            'situação matrícula',
          ]);
          const novaSituacao = resolveSituacaoCrm(mapped.situacao || c.matRow['Situação Matrícula'], {
            inRematricula: false,
          });
          if (novaSituacao && normalizeSituacaoCrm(curSituacao) !== normalizeSituacaoCrm(novaSituacao)) {
            situacaoValues.push({ fieldId: fieldIds.situacao, value: novaSituacao });
          }
        }

        if (dryRun) {
          stagesExitRemat += 1;
          if (samples.length < 20) {
            samples.push({
              dry_run: true,
              exit: true,
              dealId: c.dealId,
              cpf,
              rgm,
              from: 'Sem Rematricula',
              to: classification.stageName,
              situacao_would_write: situacaoValues.length > 0,
            });
          }
          continue;
        }

        let item = workQueueByDealId.get(c.dealId);
        if (!item) {
          item = {
            dealId: c.dealId,
            contactId: c.contactId || '',
            cpf,
            rgm,
            inCaaOpen,
            inCaaFresh,
            classification,
            values: [],
            needsFlagWrite: false,
            needsFieldWrite: false,
            needsSemRematSituacao: false,
            needsMove: false,
            needsLiveStage: false,
            fromStageId: c.currentStageId,
          };
          workQueueByDealId.set(c.dealId, item);
          workQueue.push(item);
        } else {
          if (c.contactId && !item.contactId) item.contactId = c.contactId;
          item.classification = classification;
          item.inCaaOpen = inCaaOpen;
          item.inCaaFresh = inCaaFresh;
          if (!item.fromStageId) item.fromStageId = c.currentStageId;
        }
        if (situacaoValues.length && !item.values.some((v) => v.fieldId === fieldIds.situacao)) {
          item.values.push(...situacaoValues);
          item.needsSemRematSituacao = true;
        }
        item.needsMove = true;
        item.needsLiveStage = true;
        item.isExitRemat = true;
      }
    }
  }

  if (!dryRun && workQueue.length && !aborted && !checkCancel()) {
    patchJob({
      phase: 'writing',
      status_message: `Gravando ${workQueue.length} alterações (${concurrency} workers)…`,
      total: workQueue.length,
      processed: 0,
      matched,
      flags_updated: flagsUpdated,
      stages_moved: stagesMoved,
    });
    let cursor = 0;
    let written = 0;
    const writeStartedAt = Date.now();
    const decideMoveWork = (stageId, caaOpen, classification, cleanupProtected = false) => {
      if (!canMoveStages || !classification?.stageId) {
        return { move: false, untouchable: false, cleanupProtected: false, unknown: false };
      }
      if (cleanupProtected) {
        return { move: false, untouchable: true, cleanupProtected: true, unknown: false };
      }
      if (!stageId) {
        return { move: false, untouchable: false, cleanupProtected: false, unknown: true };
      }
      if (isUntouchableStageId(stageId)) {
        return { move: false, untouchable: true, cleanupProtected: false, unknown: false };
      }
      if (retencaoStageId && stageId === retencaoStageId && !caaOpen) {
        return { move: false, untouchable: true, cleanupProtected: false, unknown: false };
      }
      if (classification.stageId === stageId) {
        return { move: false, untouchable: false, cleanupProtected: false, unknown: false };
      }
      return { move: true, untouchable: false, cleanupProtected: false, unknown: false };
    };

    const worker = async () => {
      while (!aborted) {
        if (checkCancel()) return;
        const idx = cursor++;
        if (idx >= workQueue.length) return;
        const item = workQueue[idx];
        try {
          // Atualizado?=Sim só se gravou campo SIAA real (CPF/RGM/polo/situação/…).
          // Stage-only, flags-only, clear vazio / orphan→Perdido sem mat → não marca.
          if (fieldIds.atualizado && hasSiaaFieldWrite(item.values, fieldIds)) {
            item.values = ensureAtualizadoSim(item.values || [], fieldIds);
          }
          if (item.values?.length) {
            await updateDealCustomFields(item.dealId, item.values);
            try {
              await cacheRepo.applyDealCustomFieldWrites(
                item.contactId,
                item.dealId,
                item.values
              );
            } catch (err) {
              console.warn(
                `[novo-crm-flags-sync] cache writeback fail deal=${item.dealId}:`,
                err?.message || err
              );
            }
            if (item.needsFlagWrite) flagsUpdated += 1;
            if (item.needsFieldWrite) fieldsUpdated += 1;
            if (item.needsSemRematSituacao) situacaoSemRematUpdated += 1;
            if (item.exitFlagCount) flagsExitCleared += item.exitFlagCount;
          }

          let stageId = item.fromStageId;
          let cleanupProtected = false;
          if (item.needsLiveStage) {
            try {
              const live = await getDeal(item.dealId);
              stageId = String(live?.stageId || live?.stage?.id || '').trim() || null;
              cleanupProtected = hasLimpezaDuplicataTag(live);
            } catch (err) {
              if (isDealMissingError(err)) {
                noteMissing(item.dealId, item.cpf);
                written += 1;
                continue;
              }
              noteError({ dealId: item.dealId, cpf: item.cpf, error: `getDeal: ${err?.message || err}` });
              stagesSkippedUnknown += 1;
              written += 1;
              continue;
            }
          }

          if (item.needsMove || item.needsLiveStage) {
            const d = decideMoveWork(
              stageId,
              item.inCaaOpen,
              item.classification,
              cleanupProtected
            );
            if (d.move) {
              await updateDeal(item.dealId, { stageId: item.classification.stageId });
              stagesMoved += 1;
              if (item.isExitRematOrphan) stagesExitRematOrphan += 1;
              else if (item.isExitRemat) stagesExitRemat += 1;
            } else if (d.cleanupProtected) {
              stagesSkippedLimpezaDuplicata += 1;
            } else if (d.untouchable) {
              stagesSkippedUntouchable += 1;
            } else if (d.unknown) {
              stagesSkippedUnknown += 1;
            }
            if (samples.length < 15) {
              samples.push({
                dealId: item.dealId,
                cpf: item.cpf,
                rgm: item.rgm,
                from: stageNameFromId(stageId) || stageId,
                to: item.classification.stageName,
                moved: d.move,
                untouchable: d.untouchable,
                cleanup_protected: d.cleanupProtected,
                unknown_stage: d.unknown,
                in_caa_fresh: item.inCaaFresh,
                in_caa_open: item.inCaaOpen,
              });
            }
          }
        } catch (err) {
          if (isDealMissingError(err)) {
            noteMissing(item.dealId, item.cpf);
          } else {
            noteError({ dealId: item.dealId, cpf: item.cpf, error: err?.message || String(err) });
            console.warn(`[novo-crm-flags-sync] FAIL deal=${item.dealId}:`, err?.message || err);
          }
        }
        written += 1;
        if (written % 10 === 0 || written === workQueue.length) {
          const elapsed = Math.max(1, Date.now() - writeStartedAt);
          const rate = written / elapsed; // items/ms
          const remaining = workQueue.length - written;
          const etaMs = rate > 0 ? Math.round(remaining / rate) : null;
          patchJob({
            processed: written,
            total: workQueue.length,
            sent: flagsUpdated + stagesMoved + fieldsUpdated,
            matched,
            flags_updated: flagsUpdated,
            fields_updated: fieldsUpdated,
            stages_moved: stagesMoved,
            eta_ms: etaMs,
            status_message:
              mode === 'fields'
                ? `Gravados ${written}/${workQueue.length}… · campos ${fieldsUpdated} · etapas ${stagesMoved}`
                : `Gravados ${written}/${workQueue.length}… · flags ${flagsUpdated} · etapas ${stagesMoved}`,
          });
        }
      }
    };

    console.log(
      `[novo-crm-flags-sync] write queue=${workQueue.length} concurrency=${concurrency} live_stage=${liveStage}`
    );
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  // Fase onde o job realmente parou (antes de marcar done) — útil no cancel.
  const stoppedPhase = currentPhase || 'starting';

  const result = {
    ok: !aborted && !cancelled,
    dry_run: dryRun,
    mode,
    phase: stoppedPhase,
    scanned,
    matched,
    flags_updated: flagsUpdated,
    flags_queued: workQueue.filter((i) => i.needsFlagWrite).length,
    flags_exit_cleared: flagsExitCleared,
    fields_updated: fieldsUpdated,
    situacao_sem_remat_updated: dryRun ? situacaoSemRematWouldUpdate : situacaoSemRematUpdated,
    situacao_sem_remat_would_update: situacaoSemRematWouldUpdate,
    stages_moved: stagesMoved,
    stages_queued: workQueue.filter((i) => i.needsMove).length,
    stages_exit_remat: stagesExitRemat,
    stages_exit_remat_orphan: stagesExitRematOrphan,
    stages_fora_relacao: stagesForaRelacao,
    stages_sem_identidade: stagesSemIdentidade,
    stages_remat_sem_relacao: stagesRematSemRelacao,
    stages_skipped_untouchable: stagesSkippedUntouchable,
    stages_skipped_limpeza_duplicata: stagesSkippedLimpezaDuplicata,
    stages_skipped_unknown: stagesSkippedUnknown,
    exit_skipped_sanity: exitSkippedSanity,
    skipped_no_match: skippedNoMatch,
    skipped_multi_rgm_no_deal_rgm: skippedMultiStrict,
    skipped_no_deal: skippedNoDeal,
    skipped_missing: skippedMissing,
    skipped_unchanged: skippedUnchanged,
    write_queue: workQueue.length,
    concurrency,
    live_stage: liveStage,
    caa_retencao_hours: caaRetencaoHours,
    caa_open_ids: caaT0Map.size,
    caa_seen_ids: caaSeenSet.size,
    caa_seen_people: caaSeen.nRows,
    stages_by_target: stagesByTarget,
    errors,
    aborted,
    cancelled,
    abort_reason: abortReason,
    error_budget: errorBudget,
    max_deals: maxDeals,
    sample_capped: scanned >= maxDeals && cacheRows.length > maxDeals,
    samples,
    error_samples: errorSamples,
    matriculados_snapshot_id: matSnap.id,
  };

  const finalStatus = cancelled ? 'cancelled' : aborted ? 'failed' : 'completed';
  patchJob({
    phase: 'done',
    status: finalStatus,
    finished_at: new Date().toISOString(),
    result,
    processed: scanned,
    sent: flagsUpdated + stagesMoved + fieldsUpdated,
    matched,
    flags_updated: dryRun ? flagsUpdated : flagsUpdated + (cancelled ? flagsQueued : 0),
    stages_moved: dryRun ? stagesMoved : stagesMoved + (cancelled ? stagesQueued : 0),
    // Cancel parcial: mostre gravados + enfileirados (fila ainda não escrita).
    eta_ms: null,
    status_message: cancelled
      ? `Cancelado pelo operador` +
        (scanned
          ? ` · até então ${scanned.toLocaleString('pt-BR')} deals` +
            (flagsUpdated || stagesMoved
              ? ` · ${flagsUpdated} flags · ${stagesMoved} etapas`
              : workQueue.length
                ? ` · fila ${workQueue.length}`
                : '')
          : ` · fase ${stoppedPhase || 'start'}`)
      : aborted
        ? abortReason
        : dryRun
          ? 'Prévia pronta'
          : 'Sync concluído',
  });

  // Persiste última Att (apply real) — jobs em memória somem no restart.
  // Também grava cancel parcial (scanned / gravados / fila) e fase onde parou.
  if (!dryRun) {
    try {
      await cacheRepo.saveFlagsStageLastRun({
        finished_at: new Date().toISOString(),
        ok: !aborted && !cancelled,
        mode,
        dry_run: false,
        phase: stoppedPhase,
        scanned,
        matched,
        flags_updated: flagsUpdated,
        flags_queued: workQueue.filter((i) => i.needsFlagWrite).length,
        flags_exit_cleared: flagsExitCleared,
        fields_updated: fieldsUpdated,
        stages_moved: stagesMoved,
        stages_queued: workQueue.filter((i) => i.needsMove).length,
        stages_exit_remat: stagesExitRemat,
        stages_exit_remat_orphan: stagesExitRematOrphan,
        stages_fora_relacao: stagesForaRelacao,
        stages_sem_identidade: stagesSemIdentidade,
        stages_remat_sem_relacao: stagesRematSemRelacao,
        stages_skipped_untouchable: stagesSkippedUntouchable,
        stages_skipped_limpeza_duplicata: stagesSkippedLimpezaDuplicata,
        exit_skipped_sanity: exitSkippedSanity,
        skipped_unchanged: skippedUnchanged,
        write_queue: workQueue.length,
        errors,
        aborted,
        cancelled,
        abort_reason: abortReason || null,
        matriculados_snapshot_id: matSnap.id,
      });
    } catch (err) {
      console.warn('[novo-crm-flags-sync] save last run failed:', err?.message || err);
    }
  }

  console.log('[novo-crm-flags-sync] done', JSON.stringify({ ...result, samples: undefined }));
  return result;
}

/** @type {Map<string, object>} */
const jobs = new Map();
let runningJobId = null;
/** Promise ativa — cobre sync HTTP e background. */
let activeFlagsPromise = null;

export function isFlagsStageSyncRunning() {
  return activeFlagsPromise != null || (runningJobId != null && jobs.get(runningJobId)?.status === 'running');
}

export function getFlagsStageSyncJob(jobId) {
  return jobs.get(String(jobId || '')) || null;
}

export function getRunningFlagsStageSyncJob() {
  if (!runningJobId) return null;
  const j = jobs.get(runningJobId);
  return j?.status === 'running' ? j : null;
}

/**
 * Pede parada cooperativa do job Att de etapas (lidos nos loops de scan/write).
 * @param {string} [jobId]
 * @returns {{ ok: boolean, jobId?: string, error?: string }}
 */
export function requestCancelFlagsStageSync(jobId) {
  const id = jobId ? String(jobId) : runningJobId;
  if (!id) return { ok: false, error: 'Nenhum job de Att em andamento' };
  const j = jobs.get(id);
  if (!j) return { ok: false, error: 'Job não encontrado' };
  if (j.status !== 'running') {
    return { ok: false, jobId: id, error: `Job não está rodando (status=${j.status})` };
  }
  j.cancel_requested = true;
  j.status_message = 'Cancelando… (para no próximo lote)';
  console.log(`[novo-crm-flags-sync] cancel requested job=${id}`);
  return { ok: true, jobId: id };
}

/**
 * Mutex: impede sync HTTP + background + cron em paralelo.
 * @param {{ dryRun?: boolean, mode?: string, maxDeals?: number, jobId?: string|null }} opts
 */
export async function runFlagsStageSyncLocked(opts = {}) {
  if (activeFlagsPromise) {
    const err = new Error('Sync de flags/etapa já em andamento');
    err.status = 409;
    throw err;
  }
  activeFlagsPromise = runFlagsStageSync(opts);
  try {
    return await activeFlagsPromise;
  } finally {
    activeFlagsPromise = null;
  }
}

/**
 * @param {{ mode?: string, dryRun?: boolean, maxDeals?: number }} opts
 */
export function startFlagsStageSyncBackground(opts = {}) {
  if (isFlagsStageSyncRunning()) {
    return { started: false, jobId: runningJobId, error: 'Sync de flags/etapa já em andamento' };
  }
  const jobId = randomUUID();
  const entry = {
    jobId,
    mode: opts.mode || 'flags_stage',
    status: 'running',
    dry_run: Boolean(opts.dryRun),
    total: 0,
    processed: 0,
    sent: 0,
    matched: 0,
    flags_updated: 0,
    stages_moved: 0,
    eta_ms: null,
    cancel_requested: false,
    phase: 'starting',
    status_message: 'Iniciando…',
    started_at: new Date().toISOString(),
    finished_at: null,
    result: null,
    error: null,
  };
  jobs.set(jobId, entry);
  runningJobId = jobId;

  activeFlagsPromise = runFlagsStageSync({
    dryRun: Boolean(opts.dryRun),
    mode: opts.mode || 'flags_stage',
    maxDeals: opts.maxDeals,
    jobId,
  })
    .then((result) => {
      entry.status = result?.cancelled
        ? 'cancelled'
        : result?.aborted
          ? 'failed'
          : 'completed';
      entry.result = result;
      entry.finished_at = new Date().toISOString();
      if (result?.cancelled) entry.error = 'Cancelado pelo operador';
      else if (result?.aborted) entry.error = result.abort_reason;
      return result;
    })
    .catch((err) => {
      entry.status = 'failed';
      entry.error = err?.message || String(err);
      entry.finished_at = new Date().toISOString();
      // Exceção no meio da rodada: persiste last-run com o parcial já acumulado
      // no job em memória (patchJob foi mutando entry.* durante a varredura),
      // senão o painel fica preso no último sucesso e escondia o erro.
      if (!entry.dry_run) {
        cacheRepo
          .saveFlagsStageLastRun({
            finished_at: entry.finished_at,
            ok: false,
            mode: entry.mode,
            dry_run: false,
            phase: entry.phase,
            scanned: entry.processed || 0,
            matched: entry.matched || 0,
            flags_updated: entry.flags_updated || 0,
            stages_moved: entry.stages_moved || 0,
            aborted: true,
            cancelled: false,
            error: entry.error,
            abort_reason: entry.error,
          })
          .catch((saveErr) => {
            console.warn('[novo-crm-flags-stage] save last run (error path) failed:', saveErr?.message || saveErr);
          });
      }
      throw err;
    })
    .finally(() => {
      if (runningJobId === jobId) runningJobId = null;
      activeFlagsPromise = null;
    });

  return { started: true, jobId };
}

function fieldsHourUtc() {
  // Default 08:00 UTC = 05:00 BRT (após provision ~04:00 BRT).
  return Math.max(
    0,
    Math.min(23, Math.floor(Number(process.env.NOVO_CRM_FIELDS_SYNC_HOUR_UTC) || 8))
  );
}

function msUntilHourUtc(hourUtc) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Cron noturno: atualiza só campos SIAA dos deals existentes. */
export function startExistingFieldsSyncCron() {
  if (String(process.env.NOVO_CRM_FIELDS_SYNC_ENABLED || '').trim() !== '1') {
    console.log('[novo-crm-fields-sync] cron off (NOVO_CRM_FIELDS_SYNC_ENABLED≠1)');
    return;
  }
  if (!isNovoCrmApiConfigured()) {
    console.log('[novo-crm-fields-sync] cron off — API não configurada');
    return;
  }
  if (!isNovoCrmWriteAllowedOnThisHost()) {
    console.log(
      '[novo-crm-fields-sync] cron off — escrita bloqueada neste host (DEV allowlist ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL)'
    );
    return;
  }

  const hour = fieldsHourUtc();
  const delay = msUntilHourUtc(hour);
  console.log(
    `[novo-crm-fields-sync] cron: próximo em ${Math.round(delay / 60000)} min (${String(hour).padStart(2, '0')}:00 UTC)`
  );

  const first = setTimeout(() => {
    if (isNovoCrmCacheSyncRunning()) {
      console.warn(
        '[novo-crm-fields-sync] pulando esta rodada — Full Sync ainda em andamento'
      );
    } else {
      startFlagsStageSyncBackground({ dryRun: false, mode: 'fields' });
    }
    const daily = setInterval(() => {
      if (isNovoCrmCacheSyncRunning()) {
        console.warn(
          '[novo-crm-fields-sync] pulando esta rodada — Full Sync ainda em andamento'
        );
        return;
      }
      startFlagsStageSyncBackground({ dryRun: false, mode: 'fields' });
    }, 24 * 60 * 60 * 1000);
    if (typeof daily?.unref === 'function') daily.unref();
  }, delay);
  if (typeof first?.unref === 'function') first.unref();
}

function flagsHourUtc() {
  // Default 09:00 UTC = 06:00 BRT (após fields). Manter FLAGS_SYNC_ENABLED=0 em PROD.
  return Math.max(
    0,
    Math.min(23, Math.floor(Number(process.env.NOVO_CRM_FLAGS_SYNC_HOUR_UTC) || 9))
  );
}

/** Cron noturno: flags Sim/Não + move etapa (respeita intocáveis). */
export function startFlagsStageSyncCron() {
  if (String(process.env.NOVO_CRM_FLAGS_SYNC_ENABLED || '').trim() !== '1') {
    console.log('[novo-crm-flags-sync] cron off (NOVO_CRM_FLAGS_SYNC_ENABLED≠1)');
    return;
  }
  if (!isNovoCrmApiConfigured()) {
    console.log('[novo-crm-flags-sync] cron off — API não configurada');
    return;
  }
  if (!isNovoCrmWriteAllowedOnThisHost()) {
    console.log(
      '[novo-crm-flags-sync] cron off — escrita bloqueada neste host (DEV allowlist ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL)'
    );
    return;
  }

  const hour = flagsHourUtc();
  const delay = msUntilHourUtc(hour);
  console.log(
    `[novo-crm-flags-sync] cron: próximo em ${Math.round(delay / 60000)} min (${String(hour).padStart(2, '0')}:00 UTC)`
  );

  const first = setTimeout(() => {
    startFlagsStageSyncBackground({ dryRun: false, mode: 'flags_stage' });
    const daily = setInterval(() => {
      startFlagsStageSyncBackground({ dryRun: false, mode: 'flags_stage' });
    }, 24 * 60 * 60 * 1000);
    if (typeof daily?.unref === 'function') daily.unref();
  }, delay);
  if (typeof first?.unref === 'function') first.unref();
}
