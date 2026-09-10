import { query } from '../db/client.js';
import { FIELDS } from './studentRepository.js';
import {
  BASE_CATEGORIES,
  countRowsForSnapshot,
  getLatestSnapshot,
} from './baseUploadRepository.js';
import { caaCancelamentoSqlWhere } from '../utils/caaRowFilters.js';

/** @type {Map<string, number>} */
const caaFilteredCountMemory = new Map();

/**
 * @param {{ id: string, row_count?: number, metadata?: unknown }} snap
 */
async function getCaaFilteredCount(snap) {
  const meta =
    snap.metadata && typeof snap.metadata === 'object'
      ? snap.metadata
      : typeof snap.metadata === 'string'
        ? JSON.parse(snap.metadata || '{}')
        : {};
  const fromMeta = meta?.caa_cancelamento_count;
  if (Number.isFinite(fromMeta)) {
    return Number(fromMeta);
  }

  const mem = caaFilteredCountMemory.get(snap.id);
  if (mem != null) return mem;

  const filtered = await countRowsForSnapshot('processos-caa', snap.id, {
    dataWhereSql: caaCancelamentoSqlWhere(),
  });
  caaFilteredCountMemory.set(snap.id, filtered);

  query(
    `update processos_caa_snapshots
        set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb
      where id = $1`,
    [snap.id, JSON.stringify({ caa_cancelamento_count: filtered })]
  ).catch((err) => {
    console.warn('[reports] persist caa_cancelamento_count:', err.message);
  });

  return filtered;
}

/** Pré-calcula contagem CAA filtrada para snapshots antigos (sem metadata). */
export async function prewarmCaaOverviewMetadata() {
  const snap = await getLatestSnapshot('processos-caa');
  if (!snap) return;
  const meta = snap.metadata && typeof snap.metadata === 'object' ? snap.metadata : {};
  if (Number.isFinite(meta?.caa_cancelamento_count)) return;
  console.log('[reports] pré-aquecendo contagem CAA (cancelamento matrícula)…');
  const t0 = Date.now();
  await getCaaFilteredCount(snap);
  console.log(`[reports] contagem CAA ok em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/** @typedef {{ term_id?: string, polo?: string }} ReportFilters */

const REPORT_TYPES = new Set([
  'matriculados',
  'docs-pendentes',
  'financeiro',
  'inadimplentes-vencidos',
  'inadimplentes-pos-siaa',
  'acessos-blackboard',
  'processos-caa',
  'provavel-evasao',
]);

/**
 * Filtros comuns (turma / polo) aplicados a todos os relatórios.
 * @param {ReportFilters} filters
 * @returns {{ clause: string, params: unknown[] }}
 */
function buildCommonClause(filters = {}) {
  const parts = [];
  const params = [];
  if (filters.term_id) {
    params.push(filters.term_id);
    parts.push(`term_id = $${params.length}`);
  }
  if (filters.polo) {
    params.push(`%${filters.polo}%`);
    parts.push(`polo ilike $${params.length}`);
  }
  const clause = parts.length ? parts.join(' and ') : 'true';
  return { clause, params };
}

/**
 * Cláusula específica do tipo de relatório (sem AND inicial).
 * Docs / financeiro / CAA: usa chaves em raw_data (jsonb) vindas de importações.
 */
function typeClause(type) {
  switch (type) {
    case 'matriculados':
      return `data_matricula is not null and status <> 'cancelado'`;
    case 'docs-pendentes':
      return `(
        lower(trim(coalesce(raw_data->>'docs_pendentes',''))) in ('sim','s','true','1','yes')
        or lower(trim(coalesce(raw_data->>'documentacao',''))) like '%pendente%'
        or lower(trim(coalesce(raw_data->>'pendencia_documental',''))) in ('sim','true','1','yes')
        or lower(trim(coalesce(raw_data->>'status_documentacao',''))) like '%pendente%'
      )`;
    case 'financeiro':
      return `(
        lower(trim(coalesce(raw_data->>'situacao_financeira',''))) like '%pendente%'
        or lower(trim(coalesce(raw_data->>'financeiro',''))) like '%pendente%'
        or lower(trim(coalesce(raw_data->>'inadimplente',''))) in ('sim','s','true','1','yes')
        or lower(trim(coalesce(raw_data->>'status_financeiro',''))) like '%inadimpl%'
      )`;
    case 'acessos-blackboard':
      return `ultimo_acesso_blackboard is not null`;
    case 'processos-caa':
      return `(
        length(trim(coalesce(raw_data->>'processo_caa',''))) > 0
        or length(trim(coalesce(raw_data->>'caa',''))) > 0
        or length(trim(coalesce(raw_data->>'status_caa',''))) > 0
        or length(trim(coalesce(raw_data->>'protocolo_caa',''))) > 0
      )`;
    default:
      return 'false';
  }
}

/**
 * @param {string} type
 * @param {ReportFilters} filters
 */
export function assertReportType(type) {
  if (!REPORT_TYPES.has(type)) {
    const err = new Error(`Tipo de relatório inválido: ${type}`);
    err.status = 400;
    throw err;
  }
}

/**
 * @param {string} type
 * @param {ReportFilters} filters
 */
export async function countReport(type, filters = {}) {
  assertReportType(type);
  const { clause: common, params: baseParams } = buildCommonClause(filters);
  const tClause = typeClause(type);
  const params = [...baseParams];
  const sql = `select count(*)::int as n from students where (${common}) and (${tClause})`;
  const { rows } = await query(sql, params);
  return rows[0]?.n ?? 0;
}

/**
 * @param {string} type
 * @param {ReportFilters} filters
 * @param {{ limit?: number, offset?: number }} page
 */
export async function listReport(type, filters = {}, page = {}) {
  assertReportType(type);
  const limit = Math.min(Math.max(parseInt(String(page.limit), 10) || 100, 1), 500);
  const offset = Math.max(parseInt(String(page.offset), 10) || 0, 0);
  const { clause: common, params: baseParams } = buildCommonClause(filters);
  const tClause = typeClause(type);
  const params = [...baseParams];
  params.push(limit);
  params.push(offset);
  const limIdx = params.length - 1;
  const offIdx = params.length;
  const sql = `select ${FIELDS} from students
     where (${common}) and (${tClause})
     order by nome asc
     limit $${limIdx} offset $${offIdx}`;
  const { rows } = await query(sql, params);
  return rows;
}

/**
 * Contagens agregadas para o painel (uma query por tipo, em paralelo).
 * @param {ReportFilters} filters
 */
export async function overview(filters = {}) {
  const types = [...REPORT_TYPES];
  const entries = await Promise.all(
    types.map(async (t) => [t, await countReport(t, filters)])
  );
  return Object.fromEntries(entries);
}

/**
 * Contagens do painel a partir do último snapshot de cada base importada.
 * @param {ReportFilters} _filters
 */
export async function overviewFromSnapshots(_filters = {}) {
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Record<string, string>} */
  const count_hints = {};
  await Promise.all(
    BASE_CATEGORIES.map(async (cat) => {
      try {
        const snap = await getLatestSnapshot(cat);
        if (!snap) {
          counts[cat] = 0;
          return;
        }
        if (cat === 'processos-caa') {
          const filtered = await getCaaFilteredCount(snap);
          counts[cat] = filtered;
          const total = snap.row_count ?? 0;
          if (total > 0 && total !== filtered) {
            count_hints[cat] = `de ${total.toLocaleString('pt-BR')} linhas no arquivo CAA`;
          }
          return;
        }
        counts[cat] = snap.row_count ?? 0;
      } catch (err) {
        console.error(`[reports] overview snapshot ${cat}:`, err.message);
        counts[cat] = 0;
      }
    })
  );
  return { counts, count_hints };
}
