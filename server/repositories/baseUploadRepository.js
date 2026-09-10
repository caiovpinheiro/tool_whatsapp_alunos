import Papa from 'papaparse';
import { getPool, query } from '../db/client.js';
import { isCaaCancelamentoSolicitacao } from '../utils/caaRowFilters.js';
import {
  repairCaaExportRow,
  validateCaaUploadRows,
} from '../utils/caaExportRepair.js';
import { dedupeProvavelEvasaoRows } from '../utils/evasaoDedup.js';
import {
  isRgmColumnKey,
  normalizeFinanceiroRow,
  normalizeMatriculadosRowRgms,
  normalizeRgmCanonical,
  normalizeRowRgms,
} from '../utils/rgmDisplay.js';
import { repairSiaaRematriculaRow } from '../utils/siaaRematriculaRepair.js';
import { promoteInadPosSiaaHeader } from '../utils/inadPosSiaaImport.js';

/** @typedef {'matriculados'|'docs-pendentes'|'financeiro'|'inadimplentes-vencidos'|'inadimplentes-pos-siaa'|'rematricula'|'acessos-blackboard'|'processos-caa'|'provavel-evasao'} BaseCategory */

export const REMATRICULA_SOURCES = /** @type {const} */ (['siaa', 'portal-de-polos']);

export const BASE_CATEGORIES = /** @type {const} */ ([
  'matriculados',
  'docs-pendentes',
  'financeiro',
  'inadimplentes-vencidos',
  'inadimplentes-pos-siaa',
  'rematricula',
  'acessos-blackboard',
  'processos-caa',
  'provavel-evasao',
]);

const TABLES = {
  matriculados: { snapshots: 'matriculados_snapshots', rows: 'matriculados_rows' },
  'docs-pendentes': { snapshots: 'docs_pendentes_snapshots', rows: 'docs_pendentes_rows' },
  financeiro: { snapshots: 'financeiro_snapshots', rows: 'financeiro_rows' },
  'inadimplentes-vencidos': {
    snapshots: 'inadimplentes_vencidos_snapshots',
    rows: 'inadimplentes_vencidos_rows',
  },
  'inadimplentes-pos-siaa': {
    snapshots: 'inadimplentes_pos_siaa_snapshots',
    rows: 'inadimplentes_pos_siaa_rows',
  },
  rematricula: { snapshots: 'rematricula_snapshots', rows: 'rematricula_rows' },
  'acessos-blackboard': { snapshots: 'acessos_blackboard_snapshots', rows: 'acessos_blackboard_rows' },
  'processos-caa': { snapshots: 'processos_caa_snapshots', rows: 'processos_caa_rows' },
  'provavel-evasao': { snapshots: 'provavel_evasao_snapshots', rows: 'provavel_evasao_rows' },
};

const MAX_ROWS_PER_UPLOAD =
  Number(process.env.BASE_UPLOAD_MAX_ROWS) > 0
    ? Number(process.env.BASE_UPLOAD_MAX_ROWS)
    : 120_000;

const INSERT_CHUNK =
  Number(process.env.BASE_UPLOAD_INSERT_CHUNK) > 0
    ? Number(process.env.BASE_UPLOAD_INSERT_CHUNK)
    : 3000;

/**
 * @param {string} category
 * @returns {{ snapshots: string, rows: string }}
 */
export function resolveTables(category) {
  const t = TABLES[category];
  if (!t) {
    const err = new Error(`Categoria inválida: ${category}`);
    err.status = 400;
    throw err;
  }
  return t;
}

/**
 * @param {unknown} raw
 * @returns {'siaa'|'portal-de-polos'}
 */
export function normalizeRematriculaSource(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (s === 'siaa') return 'siaa';
  if (s === 'portal-de-polos' || s === 'portal de polos' || s === 'portal-polos') {
    return 'portal-de-polos';
  }
  const err = new Error('Fonte rematrícula inválida. Use siaa ou portal-de-polos.');
  err.status = 400;
  throw err;
}

/**
 * @param {string} csvText
 * @returns {Record<string, string>[]}
 */
export function csvTextToRowObjects(csvText) {
  const raw = String(csvText || '');
  const maxCsvBytes = Number(process.env.BASE_UPLOAD_MAX_CSV_BYTES) || 90 * 1024 * 1024;
  if (Buffer.byteLength(raw, 'utf8') > maxCsvBytes) {
    const err = new Error(
      `Arquivo CSV muito grande para enviar de uma vez (máx. ~${Math.round(maxCsvBytes / 1024 / 1024)} MB).`
    );
    err.status = 413;
    throw err;
  }
  const parsed = Papa.parse(raw, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => String(h ?? '').trim(),
  });
  const fatalErrors = (parsed.errors || []).filter(
    (e) => e.code !== 'TooFewFields' && e.code !== 'TooManyFields'
  );
  if (fatalErrors.length) {
    const msg = fatalErrors.map((e) => e.message).join('; ');
    const err = new Error(`CSV: ${msg}`);
    err.status = 400;
    throw err;
  }
  const data = parsed.data || [];
  return data.map((row) => {
    /** @type {Record<string, string>} */
    const o = {};
    if (row && typeof row === 'object') {
      for (const [k, v] of Object.entries(row)) {
        const s = v === null || v === undefined ? '' : String(v).trim();
        o[k] = isRgmColumnKey(k) ? normalizeRgmCanonical(s) || s : s;
      }
    }
    return o;
  });
}

/**
 * @param {string} category
 * @param {{ fileName: string, fileSizeBytes?: number|null, objects: Record<string, unknown>[], metadata?: object }} input
 */
/**
 * @param {import('pg').PoolClient} client
 * @param {string} rt
 * @param {string} snapshotId
 * @param {number} startIndex
 * @param {Record<string, string>[]} slice
 */
async function insertRowChunk(client, rt, snapshotId, startIndex, slice) {
  const valueParts = [];
  const params = [];
  let p = 1;
  for (let j = 0; j < slice.length; j += 1) {
    valueParts.push(`($${p++}::uuid, $${p++}::int, $${p++}::jsonb)`);
    params.push(snapshotId, startIndex + j, JSON.stringify(slice[j]));
  }
  await client.query(
    `insert into ${rt} (snapshot_id, row_index, data) values ${valueParts.join(', ')}`,
    params
  );
}

export async function createSnapshotFromRowObjects(category, input) {
  const { snapshots: st, rows: rt } = resolveTables(category);
  let objects = input.objects || [];
  const meta = input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {};

  if (category === 'inadimplentes-pos-siaa' && objects.length) {
    // 1ª linha do export é o título do relatório; o cabeçalho real vem depois.
    // O arquivo concatena os polos e repete título + cabeçalho em cada um.
    const promoted = promoteInadPosSiaaHeader(objects);
    objects = promoted.rows;
    meta.inad_pos_siaa_header_promoted = promoted.promoted;
    meta.inad_pos_siaa_separator_rows_dropped = promoted.separatorsDropped;
  }

  if (objects.length) {
    if (category === 'matriculados') {
      objects = objects.map((row) => normalizeMatriculadosRowRgms(row));
    } else if (category === 'financeiro') {
      objects = objects.map((row) => normalizeFinanceiroRow(row));
    } else if (category !== 'rematricula') {
      objects = objects.map((row) => normalizeRowRgms(row));
    }
    if (category === 'rematricula') {
      objects = objects.map((row) => repairSiaaRematriculaRow(row));
    }
  }

  if (category === 'provavel-evasao' && objects.length) {
    const before = objects.length;
    const deduped = dedupeProvavelEvasaoRows(objects);
    objects = deduped.rows;
    meta.provavel_evasao_rows_before_dedup = before;
    meta.provavel_evasao_rows_after_dedup = objects.length;
    meta.provavel_evasao_duplicates_removed = deduped.removed;
    if (deduped.skipped_no_key) {
      meta.provavel_evasao_skipped_no_rgm = deduped.skipped_no_key;
    }
    console.log(
      `[base-upload] provavel-evasao: dedup ${before.toLocaleString('pt-BR')} → ${objects.length.toLocaleString('pt-BR')} linhas (maior Evasão Média por RGM+ciclo)`
    );
  }

  if (objects.length > MAX_ROWS_PER_UPLOAD) {
    const err = new Error(
      `Limite de ${MAX_ROWS_PER_UPLOAD.toLocaleString('pt-BR')} linhas por upload.`
    );
    err.status = 400;
    throw err;
  }
  if (category === 'processos-caa' && objects.length) {
    const beforeRepair = validateCaaUploadRows(objects);
    objects = objects.map((row) => repairCaaExportRow(row));
    const afterRepair = validateCaaUploadRows(objects);
    if (!afterRepair.ok) {
      const err = new Error(afterRepair.message);
      err.status = 400;
      err.code = 'caa_upload_misaligned';
      throw err;
    }
    meta.caa_cancelamento_count = objects.filter((row) =>
      isCaaCancelamentoSolicitacao(row)
    ).length;
    if (beforeRepair.misaligned_pct >= 10) {
      meta.caa_columns_repaired = true;
      meta.caa_misaligned_pct_before_repair = beforeRepair.misaligned_pct;
    }
  }
  const fileName = String(input.fileName || 'upload.csv').slice(0, 512);
  const rematSource =
    category === 'rematricula'
      ? normalizeRematriculaSource(input.rematriculaSource ?? meta.rematricula_source)
      : null;
  if (rematSource) {
    meta.rematricula_source = rematSource;
  }

  const snapSql =
    category === 'rematricula'
      ? `insert into ${st} (file_name, file_size_bytes, row_count, metadata, source)
         values ($1, $2, $3, $4::jsonb, $5)
         returning id, file_name, file_size_bytes, row_count, created_at, metadata, source`
      : `insert into ${st} (file_name, file_size_bytes, row_count, metadata)
         values ($1, $2, $3, $4::jsonb)
         returning id, file_name, file_size_bytes, row_count, created_at, metadata`;

  const snapParams =
    category === 'rematricula'
      ? [
          fileName,
          input.fileSizeBytes ?? null,
          objects.length,
          JSON.stringify(meta),
          rematSource,
        ]
      : [fileName, input.fileSizeBytes ?? null, objects.length, JSON.stringify(meta)];

  const { rows: snapRows } = await query(snapSql, snapParams);
  const snap = snapRows[0];
  const snapshotId = snap.id;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(
      `set statement_timeout = ${Number(process.env.BASE_UPLOAD_STATEMENT_MS) || 600_000}`
    );
    await client.query('BEGIN');
    for (let i = 0; i < objects.length; i += INSERT_CHUNK) {
      const slice = objects.slice(i, i + INSERT_CHUNK);
      await insertRowChunk(client, rt, snapshotId, i, slice);
      if (i > 0 && i % 15_000 === 0) {
        console.log(`[base-upload] ${category}: ${i}/${objects.length} linhas…`);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await query(`delete from ${st} where id = $1`, [snapshotId]).catch(() => {});
    const wrapped = new Error(
      err.message?.includes('timeout')
        ? 'Banco demorou demais para gravar a planilha. Tente de novo sem reiniciar o terminal.'
        : `Falha ao gravar linhas: ${err.message}`
    );
    wrapped.status = err.status || 500;
    throw wrapped;
  } finally {
    client.release();
  }

  /** @type {string|null} */
  let caa_process_error = null;
  if (category === 'processos-caa') {
    try {
      const { processSnapshot } = await import('../services/caaProtocolsService.js');
      await processSnapshot(snapshotId);
    } catch (err) {
      caa_process_error = err.message || 'falha ao processar protocolos CAA';
      console.error('[base-upload] processos-caa:', caa_process_error);
    }
  }

  if (category === 'rematricula') {
    import('../services/rematriculaTrackingService.js')
      .then((m) => m.captureRematriculaDailyPoint({ reason: 'upload' }))
      .catch((err) => {
        console.warn('[rematricula-tracking] capture após upload:', err.message);
      });
  }

  return {
    snapshot: snap,
    rowCount: objects.length,
    caa_process_error,
    warning: caa_process_error
      ? `Planilha gravada, mas falhou ao atualizar protocolos CAA: ${caa_process_error}`
      : null,
  };
}

/**
 * @param {string} category
 * @param {{ fileName: string, fileSizeBytes?: number|null, csvText: string, metadata?: object }} input
 */
export async function createSnapshotFromCsv(category, input) {
  const objects = csvTextToRowObjects(input.csvText);
  return createSnapshotFromRowObjects(category, {
    fileName: input.fileName,
    fileSizeBytes: input.fileSizeBytes,
    objects,
    metadata: input.metadata,
    rematriculaSource: input.rematriculaSource,
  });
}

/**
 * @param {string} category
 * @param {{ limit?: number }} opts
 */
export async function listSnapshots(category, { limit = 80 } = {}) {
  const { snapshots: st } = resolveTables(category);
  const lim = Math.min(Math.max(Number(limit) || 80, 1), 200);
  const { rows } = await query(
    `select id, file_name, file_size_bytes, row_count, created_at, metadata${
      category === 'rematricula' ? ', source' : ''
    }
       from ${st}
      order by created_at desc
      limit $1`,
    [lim]
  );
  return rows;
}

/**
 * @param {string} category
 * @param {string} snapshotId
 */
export async function getSnapshot(category, snapshotId) {
  const { snapshots: st } = resolveTables(category);
  const { rows } = await query(
    `select id, file_name, file_size_bytes, row_count, created_at, metadata
       from ${st} where id = $1 limit 1`,
    [snapshotId]
  );
  return rows[0] || null;
}

/**
 * Snapshot mais recente da base rematrícula (qualquer fonte — SIAA ou Portal de Polos).
 * @param {string} category
 */
export async function getLatestSnapshot(category) {
  const { snapshots: st } = resolveTables(category);
  const { rows } = await query(
    `select id, file_name, file_size_bytes, row_count, created_at, metadata${
      category === 'rematricula' ? ', source' : ''
    }
       from ${st}
      order by created_at desc
      limit 1`
  );
  return rows[0] || null;
}

/**
 * @param {'siaa'|'portal-de-polos'} source
 */
export async function getLatestRematriculaSnapshotBySource(source) {
  const src = normalizeRematriculaSource(source);
  const { snapshots: st } = resolveTables('rematricula');
  const { rows } = await query(
    `select id, file_name, file_size_bytes, row_count, created_at, metadata, source
       from ${st}
      where source = $1
      order by created_at desc
      limit 1`,
    [src]
  );
  return rows[0] || null;
}

export async function getRematriculaBaseStatus() {
  const [active, siaa, portal] = await Promise.all([
    getLatestSnapshot('rematricula'),
    getLatestRematriculaSnapshotBySource('siaa'),
    getLatestRematriculaSnapshotBySource('portal-de-polos'),
  ]);
  return {
    active_source: active?.source ?? null,
    active_snapshot: active,
    active_row_count: active?.row_count ?? 0,
    siaa,
    portal_de_polos: portal,
  };
}

/**
 * @param {string[]} categories
 */
export async function getLatestSnapshotsByCategory(categories) {
  const entries = await Promise.all(
    categories.map(async (c) => [c, await getLatestSnapshot(c)])
  );
  return Object.fromEntries(entries);
}

/**
 * @param {string} category
 * @param {string} snapshotId
 * @param {{ dataWhereSql?: string }} [opts]
 */
export async function countRowsForSnapshot(category, snapshotId, opts = {}) {
  const { rows: rt } = resolveTables(category);
  const dataWhere = opts.dataWhereSql ? `and (${opts.dataWhereSql})` : '';
  const { rows } = await query(
    `select count(*)::int as n from ${rt} where snapshot_id = $1 ${dataWhere}`,
    [snapshotId]
  );
  return rows[0]?.n ?? 0;
}

/**
 * @param {string} category
 * @param {string} snapshotId
 * @param {(row: Record<string, unknown>) => void} onRow
 * @param {{ dataWhereSql?: string }} [opts] — cláusula extra AND no jsonb (sem "AND" inicial)
 */
export async function forEachRowDataForSnapshot(category, snapshotId, onRow, opts = {}) {
  const { rows: rt } = resolveTables(category);
  const page = Number(process.env.BASE_ROW_PAGE_SIZE) > 0 ? Number(process.env.BASE_ROW_PAGE_SIZE) : 25_000;
  const dataWhere = opts.dataWhereSql ? `and (${opts.dataWhereSql})` : '';
  let offset = 0;
  for (;;) {
    const { rows } = await query(
      `select data from ${rt}
        where snapshot_id = $1 ${dataWhere}
        order by row_index asc
        limit $2 offset $3`,
      [snapshotId, page, offset]
    );
    if (!rows.length) break;
    for (const r of rows) {
      if (r.data && typeof r.data === 'object') {
        onRow(/** @type {Record<string, unknown>} */ (r.data));
      }
    }
    if (rows.length < page) break;
    offset += rows.length;
  }
}

/**
 * @param {string} category
 * @param {string} snapshotId
 */
export async function fetchAllRowDataForSnapshot(category, snapshotId) {
  /** @type {Record<string, unknown>[]} */
  const out = [];
  await forEachRowDataForSnapshot(category, snapshotId, (row) => out.push(row));
  return out;
}

/**
 * @param {string} category
 * @param {string} snapshotId
 * @param {{ limit?: number, offset?: number }} opts
 */
export async function listRows(category, snapshotId, { limit = 200, offset = 0 } = {}) {
  const { rows: rt } = resolveTables(category);
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `select id, row_index, data from ${rt}
        where snapshot_id = $1
        order by row_index asc
        limit $2 offset $3`,
      [snapshotId, lim, off]
    ),
    query(`select count(*)::int as n from ${rt} where snapshot_id = $1`, [snapshotId]),
  ]);
  return { rows, total: countRows[0]?.n ?? 0 };
}

/**
 * @param {string} category
 * @param {string} snapshotId
 */
export async function deleteSnapshot(category, snapshotId) {
  const { snapshots: st } = resolveTables(category);
  const { rowCount } = await query(`delete from ${st} where id = $1`, [snapshotId]);
  return rowCount;
}
