import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import {
  caaCancelamentoPendenteSqlWhere,
  caaCancelamentoSqlWhere,
  isCaaCancelamentoPendente,
  isCaaCancelamentoSolicitacao,
} from '../utils/caaRowFilters.js';
import { cicloFromRow, compareCicloSets, normalizeCiclo } from '../utils/cicloFromRow.js';
import * as academicTermRepo from '../repositories/academicTermRepository.js';
import { rowBelongsToAcademicTerm } from './termResolverService.js';
import { shouldReplaceEvasaoRow } from '../utils/evasaoDedup.js';
import { personNameFromRow } from '../utils/personName.js';
import { isLikelyErpMatriculaRgm, normalizeRgmCanonical, isValidRematriculaRgm } from '../utils/rgmDisplay.js';
import { cpfDigitsFromExcelCell, parseExcelNumericCell, phoneDigitsFromExcelCell } from '../utils/excelNumericCell.js';

/** @typedef {{ ids: Set<string>, ciclos: Set<string>, row?: Record<string, unknown> }} PersonIndexEntry */

const RGM_KEYS = [
  'RGM',
  'Rgm',
  'rgm',
  'RGM_ALUN',
  'RGM_ALUNO',
  'Rgm Aluno',
  'Matricula',
  'matricula',
  'MATRICULA',
  'Matrícula',
  'MATRÍCULA',
  'matrícula',
  'Username',
  'username',
  'Login',
  'login',
];

const CPF_KEYS = [
  'CPF',
  'CPF_ALUN',
  'CPF_ALUNO',
  'Cpf Aluno',
  'Cpf',
  'cpf',
  'CPF Aluno',
  'Cpf do Aluno',
  'CPF do Aluno',
  'Documento',
];

const EMAIL_KEYS = [
  'Email',
  'E-mail',
  'E_MAIL',
  'email',
  'EMAIL',
  'e-mail',
  'E-Mail',
  'Email Aluno',
  'E-mail Aluno',
  'Email do Aluno',
];

const TEL_KEYS = [
  'Fone celular',
  'Celular',
  'Telefone',
  'telefone',
  'Fone',
  'FONE_CEL',
  'TELEFONE_CEL',
  'DDD_CEL',
  'Celular Aluno',
  'Telefone Aluno',
  'Fone Celular',
];

/** @param {unknown} v */
function digits(v) {
  return parseExcelNumericCell(v).replace(/\D/g, '').trim();
}

function normalizeEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.length < 6 || !s.includes('@')) return '';
  const [, domain] = s.split('@');
  return domain && domain.includes('.') ? s : '';
}

function normalizePhone(v) {
  let d = phoneDigitsFromExcelCell(v);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.length >= 10 && d.length <= 11 ? d : '';
}

/**
 * @param {Record<string, unknown>} row
 * @param {{ category?: string }} [opts]
 * @returns {Set<string>}
 */
export function collectRowIdentities(row, opts = {}) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const k of RGM_KEYS) {
    const raw = row[k];
    if (opts.category === 'matriculados' && isLikelyErpMatriculaRgm(raw)) continue;
    const rgm = normalizeRgmCanonical(raw);
    if (!rgm) continue;
    if (opts.category === 'rematricula' && !isValidRematriculaRgm(rgm)) continue;
    out.add(`RGM:${rgm}`);
  }
  for (const k of CPF_KEYS) {
    const d = cpfDigitsFromExcelCell(row[k]);
    if (d.length === 11) out.add(`CPF:${d}`);
  }
  for (const k of EMAIL_KEYS) {
    const e = normalizeEmail(row[k]);
    if (e) out.add(`EMAIL:${e}`);
  }
  for (const k of TEL_KEYS) {
    const t = normalizePhone(row[k]);
    if (t) out.add(`TEL:${t}`);
  }
  const nome = personNameFromRow(row);
  if (nome.length >= 10) out.add(`NOME:${nome}`);
  return out;
}

/** @param {Set<string>} ids */
export function canonicalFromIdentities(ids) {
  const list = [...ids];
  const rgms = list.filter((x) => x.startsWith('RGM:')).sort();
  const cpfs = list.filter((x) => x.startsWith('CPF:')).sort();
  const emails = list.filter((x) => x.startsWith('EMAIL:')).sort();
  const tels = list.filter((x) => x.startsWith('TEL:')).sort();
  if (rgms.length) return rgms[0];
  if (cpfs.length) return cpfs[0];
  if (emails.length) return emails[0];
  if (tels.length) return tels[0];
  return null;
}

export function rowIdentity(row) {
  return canonicalFromIdentities(collectRowIdentities(row));
}

/**
 * @param {string} category
 * @param {{ caaOnlyPending?: boolean }} [opts]
 */
function rowFilterForCategory(category, opts = {}) {
  if (category === 'processos-caa') {
    return opts.caaOnlyPending ? isCaaCancelamentoPendente : isCaaCancelamentoSolicitacao;
  }
  return null;
}

/**
 * @param {string} category
 * @param {{ caaOnlyPending?: boolean }} [opts]
 */
function dataWhereSqlForCategory(category, opts = {}) {
  if (category === 'processos-caa') {
    return opts.caaOnlyPending ? caaCancelamentoPendenteSqlWhere() : caaCancelamentoSqlWhere();
  }
  return undefined;
}

/**
 * @param {PersonIndexEntry} a
 * @param {PersonIndexEntry} b
 */
function identityHit(a, b) {
  for (const id of a.ids) {
    if (b.ids.has(id)) return true;
  }
  return false;
}

/**
 * Índice invertido: id de identidade → entradas distintas (evita O(n×m) em bases grandes).
 * @param {Map<string, PersonIndexEntry>} byCanon
 * @returns {Map<string, PersonIndexEntry[]>}
 */
export function buildIdentityLookup(byCanon) {
  /** @type {Map<string, PersonIndexEntry[]>} */
  const lookup = new Map();
  for (const entry of byCanon.values()) {
    for (const id of entry.ids) {
      const list = lookup.get(id);
      if (list) {
        if (!list.includes(entry)) list.push(entry);
      } else {
        lookup.set(id, [entry]);
      }
    }
  }
  return lookup;
}

/**
 * @param {PersonIndexEntry} matEntry
 * @param {Iterable<PersonIndexEntry>} candidates
 * @returns {'none'|'aligned'|'cross_cycle'}
 */
function matchAgainstCandidates(matEntry, candidates) {
  let sawIdentity = false;
  let aligned = false;
  let crossOnly = false;
  for (const other of candidates) {
    if (!identityHit(matEntry, other)) continue;
    sawIdentity = true;
    const cmp = compareCicloSets(matEntry.ciclos, other.ciclos);
    if (cmp === 'aligned' || cmp === 'missing') {
      aligned = true;
      break;
    }
    if (cmp === 'divergent') crossOnly = true;
  }
  if (!sawIdentity) return 'none';
  if (aligned) return 'aligned';
  if (crossOnly) return 'cross_cycle';
  return 'none';
}

/**
 * Cruzamento matriculados × outra base respeitando ciclo quando ambos informam.
 * @param {PersonIndexEntry} matEntry
 * @param {Map<string, PersonIndexEntry>} otherByCanon
 * @param {Map<string, PersonIndexEntry[]>} [otherLookup]
 * @returns {'none'|'aligned'|'cross_cycle'}
 */
export function matchMatriculadoToOtherIndex(matEntry, otherByCanon, otherLookup) {
  const lookup = otherLookup ?? buildIdentityLookup(otherByCanon);
  /** @type {Set<PersonIndexEntry>} */
  const candidates = new Set();
  for (const id of matEntry.ids) {
    const list = lookup.get(id);
    if (!list) continue;
    for (const entry of list) candidates.add(entry);
  }
  if (!candidates.size) return 'none';
  return matchAgainstCandidates(matEntry, candidates);
}

/**
 * @param {string} category
 * @param {string} snapshotId
 * @param {{ snapshotRowCount?: number, keepSampleRow?: boolean }} [opts]
 */
export async function buildPersonIndexFromSnapshot(category, snapshotId, opts = {}) {
  const snapshotRowCount = opts.snapshotRowCount;
  const keepSampleRow = opts.keepSampleRow === true;
  const filterOpts = { caaOnlyPending: opts.caaOnlyPending === true };
  const rowFilter = rowFilterForCategory(category, filterOpts);
  const dataWhereSql = dataWhereSqlForCategory(category, filterOpts);
  /** @type {Map<string, PersonIndexEntry>} */
  const byCanon = new Map();
  let skipped = 0;
  let rowCount = 0;
  const rowCountTotal = snapshotRowCount ?? 0;
  await baseUploadRepo.forEachRowDataForSnapshot(
    category,
    snapshotId,
    (row) => {
      rowCount += 1;
      if (rowFilter && !rowFilter(row)) return;
      const ids = collectRowIdentities(row, { category });
      if (ids.size === 0) {
        skipped += 1;
        return;
      }
      const canon = canonicalFromIdentities(ids);
      if (!canon) {
        skipped += 1;
        return;
      }
      const ciclo = cicloFromRow(row);
      const cur = byCanon.get(canon);
      if (!cur) {
        /** @type {PersonIndexEntry} */
        const entry = { ids: new Set(ids), ciclos: new Set() };
        if (ciclo) entry.ciclos.add(ciclo);
        if (keepSampleRow) entry.row = row;
        byCanon.set(canon, entry);
      } else {
        for (const id of ids) cur.ids.add(id);
        if (ciclo) cur.ciclos.add(ciclo);
        if (category === 'provavel-evasao' && keepSampleRow && shouldReplaceEvasaoRow(row, cur.row)) {
          cur.row = row;
        }
      }
    },
    { dataWhereSql }
  );
  return { byCanon, skipped, rowCount, rowCountTotal, rowFilterActive: Boolean(rowFilter) };
}

/** @param {Map<string, PersonIndexEntry>} byCanon */
function unionIdentitySet(byCanon) {
  /** @type {Set<string>} */
  const u = new Set();
  for (const { ids } of byCanon.values()) {
    for (const id of ids) u.add(id);
  }
  return u;
}

/** @param {Map<string, PersonIndexEntry>} matByCanon @param {Map<string, PersonIndexEntry>} otherByCanon */
function comparePersonIndexes(matByCanon, otherByCanon) {
  const otherLookup = buildIdentityLookup(otherByCanon);
  const matLookup = buildIdentityLookup(matByCanon);

  let intersecao = 0;
  let intersecao_ciclo_divergente = 0;
  let matriculados_match_identidade_ciclo_antigo = 0;

  for (const mat of matByCanon.values()) {
    const m = matchMatriculadoToOtherIndex(mat, otherByCanon, otherLookup);
    if (m === 'aligned') intersecao += 1;
    else if (m === 'cross_cycle') {
      intersecao_ciclo_divergente += 1;
      matriculados_match_identidade_ciclo_antigo += 1;
    }
  }

  let na_outra_sem_matricula = 0;
  let na_outra_ciclo_divergente = 0;
  for (const other of otherByCanon.values()) {
    const m = matchMatriculadoToOtherIndex(other, matByCanon, matLookup);
    if (m === 'none') na_outra_sem_matricula += 1;
    else if (m === 'cross_cycle') na_outra_ciclo_divergente += 1;
  }

  return {
    matriculados_distintos: matByCanon.size,
    na_outra_distintos: otherByCanon.size,
    intersecao,
    intersecao_ciclo_divergente,
    matriculados_match_identidade_ciclo_antigo,
    matriculados_sem_intersecao:
      matByCanon.size - intersecao - matriculados_match_identidade_ciclo_antigo,
    na_outra_sem_matricula,
    na_outra_ciclo_divergente,
  };
}

const COMPARISONS = [
  { id: 'docs-pendentes', title: 'Documentos pendentes', mode: 'other_is_problem_list' },
  { id: 'financeiro', title: 'Financeiro / inadimplência', mode: 'other_is_problem_list' },
  {
    id: 'inadimplentes-vencidos',
    title: 'Inadimplentes vencidos',
    mode: 'other_is_problem_list',
  },
  {
    id: 'inadimplentes-pos-siaa',
    title: 'Inadimplente Pós SIAA',
    mode: 'other_is_problem_list',
  },
  {
    id: 'provavel-evasao',
    title: 'Provável evasão',
    mode: 'other_is_problem_list',
  },
  { id: 'acessos-blackboard', title: 'Acessos Blackboard', mode: 'other_is_coverage_list' },
  {
    id: 'processos-caa',
    title: 'CAA — solicitações de cancelamento',
    mode: 'other_is_process_list',
  },
];

function snapshotDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    file_name: row.file_name,
    row_count: row.row_count,
    created_at: row.created_at,
  };
}

const COMPARISON_CACHE_TTL_MS = 10 * 60 * 1000;
/** @type {{ expires: number, data: object } | null} */
let comparisonCache = null;
/** @type {Promise<object> | null} */
let comparisonInFlight = null;

/** @type {Map<string, { expires: number, data: Awaited<ReturnType<typeof buildPersonIndexFromSnapshot>> }>} */
const personIndexCaches = new Map();

export function invalidateComparisonCache() {
  comparisonCache = null;
  comparisonInFlight = null;
  personIndexCaches.clear();
}

async function buildPersonIndexCached(category, snapshotId, snapshotRowCount) {
  const key = `${category}:${snapshotId}`;
  const hit = personIndexCaches.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  const data = await buildPersonIndexFromSnapshot(category, snapshotId, { snapshotRowCount });
  personIndexCaches.set(key, { expires: Date.now() + COMPARISON_CACHE_TTL_MS, data });
  return data;
}

export function isComparisonBuilding() {
  return Boolean(comparisonInFlight);
}

export function getComparisonCacheMeta() {
  if (!comparisonCache || comparisonCache.expires <= Date.now()) return null;
  return { cached_at: comparisonCache.data.cached_at };
}

/** Dispara o cálculo em background se ainda não houver cache nem build em andamento. */
export function startComparisonBuildIfNeeded() {
  if (comparisonCache && comparisonCache.expires > Date.now()) return;
  if (comparisonInFlight) return;
  console.log('[comparison] iniciando cálculo em background…');
  void buildMatriculadosComparison()
    .then(() => console.log('[comparison] cache pronto.'))
    .catch((err) => console.error('[comparison] falhou:', err.message));
}

/**
 * Ciclos distintos presentes no matByCanon, ordenados desc.
 * @param {Map<string, PersonIndexEntry>} matByCanon
 * @returns {string[]}
 */
function extractAvailableCiclos(matByCanon) {
  const set = new Set();
  for (const entry of matByCanon.values()) {
    for (const c of entry.ciclos) {
      if (c) set.add(c);
    }
  }
  return [...set].sort((a, b) => b.localeCompare(a));
}

/**
 * Monta os blocks de comparação para um dado subconjunto de matByCanon.
 * @param {Map<string, PersonIndexEntry>} matByCanon
 * @param {{ rowCount: number, skipped: number }} matIndex
 * @param {Record<string, object>} otherSnaps
 * @param {object} matSnap
 */
async function buildBlocksForMat(matByCanon, matIndex, otherSnaps, matSnap) {
  /** @type {object[]} */
  const blocks = [];
  for (const def of COMPARISONS) {
    const otherSnap = otherSnaps[def.id];
    if (!otherSnap) {
      blocks.push({
        id: def.id,
        title: def.title,
        mode: def.mode,
        matriculados_snapshot: snapshotDto(matSnap),
        other_snapshot: null,
        matriculados_rows: matIndex.rowCount,
        matriculados_distintos: matByCanon.size,
        matriculados_sem_chave: matIndex.skipped,
        na_outra_distintos: 0,
        intersecao: 0,
        matriculados_sem_intersecao: matByCanon.size,
        na_outra_sem_matricula: 0,
        missing_other: true,
      });
      continue;
    }

    const otherIndex = await buildPersonIndexCached(def.id, otherSnap.id, otherSnap.row_count);
    const c = comparePersonIndexes(matByCanon, otherIndex.byCanon);
    const matriculados_sem_intersecao =
      def.mode === 'other_is_coverage_list'
        ? matByCanon.size - c.intersecao
        : c.matriculados_sem_intersecao;

    blocks.push({
      id: def.id,
      title: def.title,
      mode: def.mode,
      matriculados_snapshot: snapshotDto(matSnap),
      other_snapshot: snapshotDto(otherSnap),
      matriculados_rows: matIndex.rowCount,
      matriculados_distintos: c.matriculados_distintos,
      matriculados_sem_chave: matIndex.skipped,
      na_outra_rows: otherIndex.rowCount,
      na_outra_rows_total:
        otherIndex.rowFilterActive && otherIndex.rowCountTotal != null
          ? otherIndex.rowCountTotal
          : undefined,
      na_outra_filtro:
        def.id === 'processos-caa'
          ? 'Somente Subprocesso de cancelamento de matrícula (ex.: CANCELAMENTO DE MATRÍCULA).'
          : undefined,
      na_outra_distintos: c.na_outra_distintos,
      na_outra_sem_chave: otherIndex.skipped,
      intersecao: c.intersecao,
      intersecao_ciclo_divergente: c.intersecao_ciclo_divergente,
      matriculados_match_identidade_ciclo_antigo: c.matriculados_match_identidade_ciclo_antigo,
      matriculados_sem_intersecao,
      na_outra_sem_matricula: c.na_outra_sem_matricula,
      na_outra_ciclo_divergente: c.na_outra_ciclo_divergente,
      missing_other: false,
    });
  }
  return blocks;
}

async function buildMatriculadosComparisonInternal() {
  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap) {
    const err = new Error('Nenhum snapshot de matriculados. Envie a base ou rode o seed.');
    err.status = 404;
    throw err;
  }

  const matIndex = await buildPersonIndexCached('matriculados', matSnap.id, matSnap.row_count);
  const matByCanon = matIndex.byCanon;

  const otherSnaps = await baseUploadRepo.getLatestSnapshotsByCategory(
    COMPARISONS.map((c) => c.id)
  );

  // Blocos agregados (comportamento existente)
  const comparisons = await buildBlocksForMat(matByCanon, matIndex, otherSnaps, matSnap);

  // Segmentação por ciclo
  const available_ciclos = extractAvailableCiclos(matByCanon);
  /** @type {Record<string, { blocks: object[] }>} */
  const by_ciclo = {};
  for (const ciclo of available_ciclos) {
    const filteredMat = new Map();
    for (const [canon, entry] of matByCanon) {
      if (entry.ciclos.has(ciclo)) filteredMat.set(canon, entry);
    }
    by_ciclo[ciclo] = { blocks: await buildBlocksForMat(filteredMat, matIndex, otherSnaps, matSnap) };
  }

  return {
    matriculados_snapshot: snapshotDto(matSnap),
    matriculados_distintos: matByCanon.size,
    matriculados_sem_chave: matIndex.skipped,
    comparisons,
    by_ciclo,
    available_ciclos,
    cached_at: new Date().toISOString(),
  };
}

export async function buildMatriculadosComparison() {
  if (comparisonCache && comparisonCache.expires > Date.now()) {
    return comparisonCache.data;
  }
  if (comparisonInFlight) {
    return comparisonInFlight;
  }

  comparisonInFlight = buildMatriculadosComparisonInternal()
    .then((data) => {
      comparisonCache = { expires: Date.now() + COMPARISON_CACHE_TTL_MS, data };
      console.log(
        `[comparison] pronto em memória (${data.matriculados_distintos} matriculados distintos).`
      );
      return data;
    })
    .finally(() => {
      comparisonInFlight = null;
    });

  return comparisonInFlight;
}

/** @param {Record<string, unknown>} row */
function poloFromMatriculadoRow(row) {
  return String(row.Polo ?? row['Nome Polo'] ?? row.NOME_POLO ?? row.polo ?? '').trim();
}

/**
 * @typedef {{ term_id?: string, polo?: string }} ReportFilters
 */

/**
 * Índice de matriculados restrito à turma e/ou polo selecionados nos Relatórios.
 * @param {ReportFilters} filters
 */
export async function buildFilteredMatriculadosIndex(filters = {}) {
  const termId = filters.term_id ? String(filters.term_id).trim() : '';
  const poloNeedle = filters.polo ? String(filters.polo).trim().toLowerCase() : '';
  const hasFilter = Boolean(termId || poloNeedle);

  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap) {
    return {
      matSnap: null,
      byCanon: new Map(),
      skipped: 0,
      rowCount: 0,
      hasFilter,
      filterLabel: null,
    };
  }

  let targetTerm = null;
  if (termId) {
    targetTerm = await academicTermRepo.findById(termId);
  }
  let filterLabel = null;
  if (targetTerm) {
    filterLabel = `${targetTerm.codigo} — ${targetTerm.nome}`;
  } else if (termId) {
    filterLabel = `turma ${termId}`;
  }
  if (poloNeedle) {
    filterLabel = filterLabel ? `${filterLabel} · polo "${filters.polo}"` : `polo "${filters.polo}"`;
  }

  /** @type {Map<string, PersonIndexEntry>} */
  const byCanon = new Map();
  let skipped = 0;
  let rowCount = 0;

  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
    rowCount += 1;
    if (targetTerm) {
      if (!rowBelongsToAcademicTerm(targetTerm, row)) return;
    }
    if (poloNeedle) {
      const polo = poloFromMatriculadoRow(row).toLowerCase();
      if (!polo.includes(poloNeedle)) return;
    }
    const ids = collectRowIdentities(row, { category: 'matriculados' });
    if (ids.size === 0) {
      skipped += 1;
      return;
    }
    const canon = canonicalFromIdentities(ids);
    if (!canon) {
      skipped += 1;
      return;
    }
    const ciclo = cicloFromRow(row);
    const cur = byCanon.get(canon);
    if (!cur) {
      /** @type {PersonIndexEntry} */
      const entry = { ids: new Set(ids), ciclos: new Set() };
      if (ciclo) entry.ciclos.add(ciclo);
      byCanon.set(canon, entry);
    } else {
      for (const id of ids) cur.ids.add(id);
      if (ciclo) cur.ciclos.add(ciclo);
    }
  });

  return { matSnap, byCanon, skipped, rowCount, hasFilter, filterLabel };
}

/**
 * Conta linhas distintas na base Rematrícula (SIAA/Portal) com os mesmos filtros.
 * @param {ReportFilters} filters
 * @param {import('./termResolverService.js').AcademicTermLite | null | undefined} targetTerm
 */
async function countFilteredRematriculaSnapshot(filters, targetTerm) {
  const snap = await baseUploadRepo.getLatestSnapshot('rematricula');
  if (!snap) return { total: 0, adimplente: 0, inadimplente: 0 };

  const poloNeedle = filters.polo ? String(filters.polo).trim().toLowerCase() : '';
  const targetCiclo = targetTerm?.ciclo ? normalizeCiclo(targetTerm.ciclo) : null;
  /** @type {Set<string>} */
  const seen = new Set();
  let adimplente = 0;
  let inadimplente = 0;

  await baseUploadRepo.forEachRowDataForSnapshot('rematricula', snap.id, (row) => {
    if (targetCiclo) {
      const c = cicloFromRow(row);
      if (c !== targetCiclo) return;
    }
    if (poloNeedle) {
      const polo = String(row.NOME_POLO ?? row.Polo ?? row.polo ?? '')
        .trim()
        .toLowerCase();
      if (!polo.includes(poloNeedle)) return;
    }
    const canon = rowIdentity(row);
    if (!canon || seen.has(canon)) return;
    seen.add(canon);
    const fin = String(
      row.SIT_FINANCEIRA ?? row.situacao_financeira ?? row.Financeiro ?? ''
    ).toLowerCase();
    if (fin.includes('inadimpl')) inadimplente += 1;
    else adimplente += 1;
  });

  return { total: seen.size, adimplente, inadimplente };
}

/**
 * Cards do painel Relatórios com filtro de turma/polo (cruzamento matriculados × bases).
 * @param {ReportFilters} filters
 */
export async function overviewFromFilteredMatriculados(filters = {}) {
  const { matSnap, byCanon, skipped, rowCount, filterLabel } =
    await buildFilteredMatriculadosIndex(filters);

  /** @type {Record<string, number>} */
  const counts = { matriculados: byCanon.size };
  /** @type {Record<string, string>} */
  const count_hints = {};

  const hintPrefix = filterLabel ? `Filtro: ${filterLabel}` : '';
  if (hintPrefix) {
    count_hints.matriculados = `${hintPrefix} · ${byCanon.size.toLocaleString('pt-BR')} alunos distintos`;
  }

  if (!matSnap) {
    for (const def of COMPARISONS) counts[def.id] = 0;
    counts.rematricula = 0;
    return { counts, count_hints };
  }

  const matIndex = { rowCount, skipped };
  const otherSnaps = await baseUploadRepo.getLatestSnapshotsByCategory(
    COMPARISONS.map((c) => c.id)
  );
  const blocks = await buildBlocksForMat(byCanon, matIndex, otherSnaps, matSnap);

  for (const block of blocks) {
    counts[block.id] = block.intersecao ?? 0;
    if (hintPrefix && block.intersecao != null) {
      count_hints[block.id] = `${hintPrefix} · cruzamento com matriculados`;
    }
  }

  const targetTerm = filters.term_id
    ? (await academicTermRepo.findById(String(filters.term_id))) || null
    : null;
  const remat = await countFilteredRematriculaSnapshot(filters, targetTerm);
  counts.rematricula = remat.total;
  if (hintPrefix && remat.total > 0) {
    count_hints.rematricula = [
      hintPrefix,
      `${remat.adimplente.toLocaleString('pt-BR')} adimplente`,
      `${remat.inadimplente.toLocaleString('pt-BR')} inadimplente`,
    ].join(' · ');
  }

  return { counts, count_hints };
}
