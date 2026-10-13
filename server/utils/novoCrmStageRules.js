/**
 * Regras de etapa/flags Novo CRM (DEV) — matriculados + bases satélite.
 * IDs default = CRM DEV; sobrescreva via env NOVO_CRM_STAGE_* / NOVO_CRM_FIELD_*.
 *
 * Guard PROD (28/07/2026, bugfix): quando NOVO_CRM_API_BASE_URL aponta pra
 * host PROD (integrations.bwipo.com, cruzeiro-ead.bwipo.com ou crm.eduit.com.br)
 * e não há env var explícita, os IDs são lidos de data/novo-crm-prod-ids.json
 * em vez do fallback DEV hard-coded. Sem isso,
 * qualquer chamador que esqueça de setar NOVO_CRM_STAGE_* / NOVO_CRM_FIELD_* (ex.:
 * scripts/novo-crm-apply-fast.mjs) manda stageId/fieldId de DEV pra PROD e a
 * API rejeita createDeal com "Referência inválida (estágio, contato ou
 * responsável)". Em PROD, se o ID também não existir no JSON, retorna '' —
 * NUNCA cai no fallback DEV (o ID não existe naquele CRM).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROD_IDS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'novo-crm-prod-ids.json'
);

let prodIdsFileCache; // undefined = ainda não tentou carregar; null = ausente/erro

function loadProdIdsFile() {
  if (prodIdsFileCache !== undefined) return prodIdsFileCache;
  try {
    prodIdsFileCache = JSON.parse(fs.readFileSync(PROD_IDS_PATH, 'utf8'));
  } catch {
    prodIdsFileCache = null;
  }
  return prodIdsFileCache;
}

function apiBaseHost() {
  try {
    return new URL(String(process.env.NOVO_CRM_API_BASE_URL || '').trim()).host.toLowerCase();
  } catch {
    return String(process.env.NOVO_CRM_API_BASE_URL || '').trim().toLowerCase();
  }
}

/** Hosts do CRM acadêmico PROD (UI/API). Token e IDs são os mesmos da org. */
export function isProdCrmHost(host = apiBaseHost()) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'crm.eduit.com.br' || h.endsWith('.crm.eduit.com.br')) return true;
  if (h === 'cruzeiro-ead.bwipo.com') return true;
  if (h === 'integrations.bwipo.com') return true;
  return false;
}

function prodIdsMap() {
  const raw = loadProdIdsFile();
  if (!raw) return null;
  return { ...(raw.stages || {}), ...(raw.fields || {}) };
}

function envId(key, fallback) {
  const v = String(process.env[key] || '').trim();
  // "-" / "skip" / "0" = desliga o ID (não usar fallback DEV em PROD).
  if (v === '-' || v === 'skip' || v === '0') return '';
  if (v) return v;
  if (isProdCrmHost()) {
    const prodVal = prodIdsMap()?.[key];
    if (prodVal) return String(prodVal);
    // PROD sem ID mapeado (env nem JSON): nunca usar o hard-coded de DEV.
    return '';
  }
  return fallback;
}

export function getNovoCrmStageIds() {
  return {
    Acolhimento: envId('NOVO_CRM_STAGE_ACOLHIMENTO', 'cmrtilckh001tua48a8n1mi8w'),
    Graduação: envId('NOVO_CRM_STAGE_GRADUACAO', 'cmrtilckh001uua48mv59m7vf'),
    Pós: envId('NOVO_CRM_STAGE_POS', 'cmrtilckh001vua48ozyjlar6'),
    Retenção: envId('NOVO_CRM_STAGE_RETENCAO', 'cmrtilckh001wua48e5t40tyw'),
    'Sem Rematricula': envId('NOVO_CRM_STAGE_SEM_REMATRICULA', 'cmrtilckh001xua48q124whlu'),
    Cancelado: envId('NOVO_CRM_STAGE_CANCELADO', 'cmrtit17i002vua48j28a5mms'),
    Ganho: envId('NOVO_CRM_STAGE_GANHO', 'cmrtilckh001yua48xxic8vwx'),
    Perdido: envId('NOVO_CRM_STAGE_PERDIDO', 'cmrtilckh001zua48bubr5vya'),
    // PROD: fila operacional humana — nunca auto-mover etapa (flags/fields ok).
    'Em Atendimento': envId('NOVO_CRM_STAGE_EM_ATENDIMENTO', 'cmrxn1r190v2vo101kaqh4cup'),
    'Lead de Entrada': envId('NOVO_CRM_STAGE_LEAD_ENTRADA', 'cmrwd95sx01mfpd01axkzjhm8'),
  };
}

/**
 * Horas em que CAA open força etapa Retenção (default 72).
 * Depois: classifica por SIAA; Retenção sem CAA open = manual/outra automação.
 */
export function getCaaRetencaoHours() {
  return Math.min(Math.max(Number(process.env.NOVO_CRM_CAA_RETENCAO_HOURS) || 72, 1), 8760);
}

/** @param {Date|null|undefined} t0 @param {Date} [now] */
export function isCaaWithinRetencaoWindow(t0, now = new Date()) {
  if (!t0 || !(t0 instanceof Date) || Number.isNaN(t0.getTime())) return false;
  const ms = getCaaRetencaoHours() * 60 * 60 * 1000;
  return now.getTime() - t0.getTime() <= ms;
}

/**
 * Flag CAA = já apareceu em algum upload (sticky Sim). Etapa Retenção = open ≤72h.
 * @param {Date|null|undefined} t0
 * @param {{ now?: Date, seen?: boolean }} [opts]
 */
export function caaClassifyCtx(t0, opts = {}) {
  const now = opts.now || new Date();
  const inCaaOpen = Boolean(t0 && t0 instanceof Date && !Number.isNaN(t0.getTime()));
  const inCaaFresh = isCaaWithinRetencaoWindow(t0, now);
  const inCaaSeen = opts.seen !== undefined ? Boolean(opts.seen) : inCaaOpen;
  return { inCaaOpen, inCaaFresh, inCaaSeen };
}

/**
 * Etapas que o job NÃO move (humano/IA). Flags/campos SIAA ainda podem ser atualizados.
 * - Ganho / Cancelado: terminais de negócio
 * - Em Atendimento: fila operacional do consultor (só campos, sem tirar da etapa)
 * Retenção NÃO entra aqui — saída pós-72h / keep manual é decidido no sync
 * (já em Retenção sem CAA open = intocável).
 */
export function getUntouchableStageIds() {
  const s = getNovoCrmStageIds();
  return new Set(
    [s.Ganho, s.Cancelado, s['Em Atendimento']].filter(Boolean)
  );
}

export function isUntouchableStageId(stageId) {
  const id = String(stageId || '').trim();
  if (!id) return false;
  return getUntouchableStageIds().has(id);
}

/** Campo nativo `deals.lostReason`. O funil recusa Perdido sem esse texto. */
export const LOST_REASON_CANCELADO = 'Cancelado';
export const LOST_REASON_TRANCADO = 'Trancado';
export const LOST_REASON_SEM_RESPOSTA = 'Sem resposta';

const MOTIVO_PERDA_SELECT = new Set([
  'Sem resposta',
  'Financeiro',
  'Outro Polo',
  'Tempo',
  'Desemprego',
]);

/**
 * Motivo ao entrar em Perdido.
 * SIAA Cancelado → Cancelado. SIAA Trancado → Trancado (não é cancelamento;
 * nenhuma opção do SELECT Motivo Perda descreve trancamento).
 * Fora da Relação, sem identidade, órfão de rematrícula e duplicata → Sem resposta:
 * não há status acadêmico que prove cancelamento.
 * @param {{ meta?: { isCancelado?: boolean, isTrancado?: boolean, situacao?: string } } | null | undefined} classification
 */
export function lostReasonForPerdido(classification) {
  const meta = classification?.meta || {};
  const situacao = String(meta.situacao || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (meta.isCancelado || situacao.includes('CANCEL')) return LOST_REASON_CANCELADO;
  if (meta.isTrancado || situacao.includes('TRANC')) return LOST_REASON_TRANCADO;
  return LOST_REASON_SEM_RESPOSTA;
}

/** Valor do SELECT Motivo Perda, ou '' quando o rótulo nativo não está nas opções. */
export function motivoPerdaSelectValue(lostReason) {
  const value = String(lostReason || '').trim();
  return MOTIVO_PERDA_SELECT.has(value) ? value : '';
}

export function stageNameFromId(stageId) {
  const id = String(stageId || '').trim();
  if (!id) return null;
  const stages = getNovoCrmStageIds();
  for (const [name, sid] of Object.entries(stages)) {
    if (sid === id) return name;
  }
  return null;
}

/** Custom fields deal (DEV). */
export function getNovoCrmDealFieldIds() {
  return {
    cpf: envId('NOVO_CRM_FIELD_CPF', 'cmr9f7nfk02xhp701mhvulyxe'),
    rgm: envId('NOVO_CRM_FIELD_RGM', 'cmr9dvugp02sbp7019lv6jgt4'),
    curso: envId('NOVO_CRM_FIELD_CURSO', 'cmr9dw2bx02sdp701lxbkt4nd'),
    polo: envId('NOVO_CRM_FIELD_POLO', 'cmr9f0ang02whp7016bmxlzji'),
    situacao: envId('NOVO_CRM_FIELD_SITUACAO', 'cmr9f1ewb02wpp701gb7y5rf8'),
    nivel: envId('NOVO_CRM_FIELD_NIVEL', ''),
    email: envId('NOVO_CRM_FIELD_EMAIL', 'cmr9f27vg02wtp701sry87ds4'),
    email_ad: envId('NOVO_CRM_FIELD_EMAIL_AD', 'cmr9f2iq302wxp701573yz5w7'),
    nasc: envId('NOVO_CRM_FIELD_NASC', 'cmq579tb1003bvemcck96lhwx'),
    // PROD: DATE `data_de_matricula` / label "Data de Matrícula".
    data_matricula: envId('NOVO_CRM_FIELD_DATA_MATRICULA', ''),
    // PROD: TEXT `data_de_rematricula` / label "Data de Rematricula".
    data_rematricula: envId('NOVO_CRM_FIELD_DATA_REMATRICULA', ''),
    // SELECT Pré/Pós — PROD live 2026-08-17: label "Marco Regulatorio",
    // name `marco_regulatorio_2`, id `cmst97c9q01a7mp019n6671ji`.
    // Vazio (sem env/JSON) = não grava.
    marco: envId('NOVO_CRM_FIELD_MARCO', ''),
    acessoblack: envId('NOVO_CRM_FIELD_ACESSO_BLACK', 'cmrtjzsqx008hua48qsgaeppd'),
    doc_pendentes: envId('NOVO_CRM_FIELD_DOC_PENDENTES', 'cmrtjumbj007nua48rqjbzzj8'),
    // PROD: situacaofinanceira ("Financeira") = inadimplentes-vencidos (não a base Financeiro).
    inadimplente: envId('NOVO_CRM_FIELD_INADIMPLENTE', 'cmrtjygzx008bua48uiugpx9u'),
    // Financeiro (base slug `financeiro`) → PROD custom field label "Dia 10", name `dia` (SELECT Sim/Não).
    // NÃO é um field name `financeiro` — ver NOVO_CRM_FIELD_FINANCEIRO no JSON/env.
    financeiro: envId('NOVO_CRM_FIELD_FINANCEIRO', ''),
    // CAA open (qualquer idade) → etapa Retenção só ≤72h.
    // Flag Sim = já apareceu (caa_protocols, sticky — ver inCaaSeen). Sem id = não grava.
    caa: envId('NOVO_CRM_FIELD_CAA', ''),
    evasao: envId('NOVO_CRM_FIELD_EVASAO', 'cmrtk0ob6008nua48ceomws81'),
    // PROD: "Atualizado?" — Sim só com escrita de campos SIAA (não stage/flags-only).
    atualizado: envId('NOVO_CRM_FIELD_ATUALIZADO', ''),
    // PROD: SELECT `motivoperda` label "Motivo Perda". Não é o lostReason nativo.
    motivo_perda: envId('NOVO_CRM_FIELD_MOTIVO_PERDA', ''),
  };
}

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function excelSerialToDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n < 20000) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
}

function pick(row, keys) {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * Turmas de ingresso → 1ª mensalidade. Em Acolhimento enquanto hoje (BRT) ≤ vencimento.
 * Duas turmas podem coexistir na coluna (ex. 17–25/08: agosto ainda + setembro já).
 * A partir de 18/11/2026 o ingresso é 2027/1 (turma ainda sem cutoff).
 */
export const ACOLHIMENTO_TURMAS = [
  {
    ciclo: '2026/2',
    turma: 'agosto',
    matriculaDe: '2026-05-13',
    matriculaAte: '2026-08-16',
    acolhimentoAte: '2026-08-25',
  },
  {
    ciclo: '2026/2',
    turma: 'setembro',
    matriculaDe: '2026-08-17',
    matriculaAte: '2026-09-13',
    acolhimentoAte: '2026-09-25',
  },
  {
    ciclo: '2026/2',
    turma: 'outubro',
    matriculaDe: '2026-09-14',
    matriculaAte: '2026-10-11',
    acolhimentoAte: '2026-10-25',
  },
  {
    ciclo: '2026/2',
    turma: 'novembro',
    matriculaDe: '2026-10-12',
    matriculaAte: '2026-11-17',
    acolhimentoAte: '2026-11-25',
  },
];

/** @deprecated cutoff único por ciclo — 2026/2 não é mais 25/08 para todo mundo. */
export const ACOLHIMENTO_PRIMEIRA_MENSALIDADE_POR_CICLO = {
  '2026/2': '2026-08-25',
};

/** Normaliza `2026.2` / `2026/2` / `2026-2` → `2026/2`. */
export function normalizeCicloSlash(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/(\d{4})\s*[./\-]\s*(\d)/);
  if (!m) return s.replace(/\./g, '/');
  return `${m[1]}/${m[2]}`;
}

function todayYmdSaoPaulo(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function parseDataMatriculaYmd(raw) {
  const dmRaw = String(raw ?? '').trim();
  if (!dmRaw) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(dmRaw)) return dmRaw.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dmRaw)) {
    const [dd, mm, yyyy] = dmRaw.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }
  const dm = excelSerialToDate(dmRaw);
  if (!dm) return null;
  return dm.toISOString().slice(0, 10);
}

export function findAcolhimentoTurma(dataMatriculaYmd) {
  const ymd = String(dataMatriculaYmd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return (
    ACOLHIMENTO_TURMAS.find((t) => ymd >= t.matriculaDe && ymd <= t.matriculaAte) || null
  );
}

/**
 * Janela de Acolhimento por turma (Data Matrícula → 1º vencimento).
 * Sem data / fora das faixas / ingresso ≥ 18/11/2026 (2027/1) → não é Acolhimento.
 * @returns {{ inAcolhimento: boolean, acolhimentoAte: string|null, cicloNorm: string, turma: string|null }}
 */
export function resolveAcolhimentoWindow(matRow, now = new Date()) {
  const cicloNorm = normalizeCicloSlash(pick(matRow, ['Ciclo', 'ciclo', 'CICLO']));
  const empty = { inAcolhimento: false, acolhimentoAte: null, cicloNorm, turma: null };
  const ymd = parseDataMatriculaYmd(pick(matRow, ['Data Matrícula', 'Data Matricula']));
  if (!ymd) return empty;
  const turma = findAcolhimentoTurma(ymd);
  if (!turma) return empty;
  const today = todayYmdSaoPaulo(now);
  return {
    inAcolhimento: today <= turma.acolhimentoAte,
    acolhimentoAte: turma.acolhimentoAte,
    cicloNorm: turma.ciclo || cicloNorm,
    turma: turma.turma,
  };
}

/**
 * @param {Record<string, unknown>} matRow
 * @param {{
 *   inRematricula?: boolean,
 *   inCaa?: boolean,
 *   inCaaOpen?: boolean,
 *   inCaaFresh?: boolean,
 *   inCaaSeen?: boolean,
 *   inDoc?: boolean,
 *   inInad?: boolean,
 *   inFinanceiro?: boolean,
 *   inBb?: boolean,
 *   inEvasao?: boolean,
 *   now?: Date,
 * }} ctx
 */
export function classifyMatriculado(matRow, ctx) {
  const situacao = pick(matRow, ['Situação Matrícula', 'Situacao Matricula', 'Situação']).toUpperCase();
  const negocio = pick(matRow, ['Negócio', 'Negocio', 'Empresa', 'Nível', 'Nivel'])
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  // CANCELADO / TRANCADO (SIAA) → Perdido. Não usa etapa CRM "Cancelado"
  // (reservada ao time de retenção). Situação carousel continua distinta
  // (Cancelado vs Trancado) via resolveSituacaoCrm.
  const situacaoNorm = situacao.normalize('NFD').replace(/\p{M}/gu, '');
  const isCancelado = situacaoNorm.includes('CANCEL');
  const isTrancado = situacaoNorm.includes('TRANC');
  const isPos =
    negocio.includes('POS-GRAD') ||
    negocio.includes('POS GRAD') ||
    /(^|[^A-Z])POS([^A-Z]|$)/.test(negocio);
  const isGrad = negocio.includes('GRAD') && !isPos;

  const now = ctx.now || new Date();
  const { inAcolhimento, acolhimentoAte, cicloNorm, turma: acolhimentoTurma } =
    resolveAcolhimentoWindow(matRow, now);
  // Retenção só com CAA open dentro da janela (default 72h). Callers novos
  // passam inCaaFresh; inCaa legado só conta se inCaaFresh não veio.
  const inCaaFresh =
    ctx.inCaaFresh !== undefined ? Boolean(ctx.inCaaFresh) : Boolean(ctx.inCaa);
  const inCaaOpen =
    ctx.inCaaOpen !== undefined ? Boolean(ctx.inCaaOpen) : Boolean(inCaaFresh);
  // Flag sticky: já apareceu em qualquer dia. Sem inCaaSeen, cai no open
  // (callers antigos). Nunca usar o XLSX D−1 como “saiu”.
  const inCaaSeen =
    ctx.inCaaSeen !== undefined ? Boolean(ctx.inCaaSeen) : Boolean(inCaaOpen);

  const stages = getNovoCrmStageIds();
  /** @type {string} */
  let stageName;
  // Prioridade:
  //   1. CANCELADO/TRANCADO (SIAA) → Perdido (já perdido; vence CAA)
  //   2. CAA open ≤72h → Retenção
  //   3. rematrícula → Sem Rematricula
  //   4. acolhimento por turma (Data Matrícula → 1ª mensalidade)
  //   5. Pós / Graduação
  // Após 72h: não força Retenção — segue SIAA (Em curso → funil; Cancel→Perdido).
  // Quem já está em Retenção sem CAA open permanece (manual) no sync de flags.
  if (isCancelado || isTrancado) stageName = 'Perdido';
  else if (inCaaFresh) stageName = 'Retenção';
  else if (ctx.inRematricula) stageName = 'Sem Rematricula';
  else if (inAcolhimento) stageName = 'Acolhimento';
  else if (isPos) stageName = 'Pós';
  else if (isGrad) stageName = 'Graduação';
  else stageName = 'Graduação';

  return {
    stageName,
    stageId: stages[stageName],
    flags: {
      doc_pendentes: Boolean(ctx.inDoc),
      inadimplente: Boolean(ctx.inInad),
      financeiro: Boolean(ctx.inFinanceiro),
      acessoblack: Boolean(ctx.inBb),
      evasao: Boolean(ctx.inEvasao),
      // Sim se já apareceu em CAA (qualquer status/idade). Retenção = só inCaaFresh.
      caa: inCaaSeen,
    },
    meta: {
      situacao,
      negocio,
      ciclo: cicloNorm,
      isCancelado,
      isTrancado,
      isPos,
      isGrad,
      inAcolhimento,
      acolhimentoAte,
      acolhimentoTurma,
      inRematricula: Boolean(ctx.inRematricula),
      inCaa: inCaaOpen,
      inCaaOpen,
      inCaaFresh,
      inCaaSeen,
      cpf: digits(pick(matRow, ['CPF', 'cpf'])),
      rgm: digits(pick(matRow, ['RGM', 'rgm'])),
    },
  };
}

export function titleCasePolo(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^\d+\s*[-–]\s*/u, '');
  s = s.replace(/\b(CEB\s+)?POLO\s+/giu, '');
  s = s.replace(/\bSP_/giu, '');
  s = s.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function phoneE164Br(raw) {
  let d = digits(raw);
  if (!d) return null;
  if (d.startsWith('55') && d.length >= 12) return `+${d}`;
  if (d.length >= 10 && d.length <= 11) return `+55${d}`;
  return d.startsWith('+') ? raw : `+${d}`;
}
