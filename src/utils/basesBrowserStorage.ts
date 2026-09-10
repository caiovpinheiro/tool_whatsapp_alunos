import type { ReportSlug } from '../services/reportApi';

const DB_NAME = 'disparador_bases_idb_v1';
const DB_VERSION = 1;
const STORE = 'files';

const LEGACY_STORAGE_KEY = 'disparador_upload_bases_v1';
const LEGACY_STORAGE_KEY_V2 = 'disparador_upload_bases_v2';

/** Acima disso não guardamos csvText no navegador (só metadados + servidor). */
export const MAX_LOCAL_CSV_CHARS = 8_000_000;

export interface SavedBase {
  id: string;
  name: string;
  size: number;
  lineCount: number;
  uploadedAt: string;
  csvText: string;
  /** Preenchido quando o CSV já foi enviado ao Postgres e não cabe localmente. */
  serverSnapshotId?: string;
  serverOnly?: boolean;
}

export type BasesByCategory = Record<ReportSlug, SavedBase[]>;

export interface PersistResult {
  ok: boolean;
  error?: string;
}

type StoredRow = SavedBase & { category: ReportSlug };

const CATEGORIES: ReportSlug[] = [
  'matriculados',
  'docs-pendentes',
  'financeiro',
  'inadimplentes-vencidos',
  'inadimplentes-pos-siaa',
  'acessos-blackboard',
  'processos-caa',
  'provavel-evasao',
];

export function emptyBasesStore(): BasesByCategory {
  return {
    matriculados: [],
    'docs-pendentes': [],
    financeiro: [],
    'inadimplentes-vencidos': [],
    'inadimplentes-pos-siaa': [],
    'acessos-blackboard': [],
    'processos-caa': [],
    'provavel-evasao': [],
  };
}

function isValidSavedBase(x: unknown): x is SavedBase {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as SavedBase).id === 'string' &&
    typeof (x as SavedBase).name === 'string' &&
    (typeof (x as SavedBase).csvText === 'string' ||
      Boolean((x as SavedBase).serverOnly || (x as SavedBase).serverSnapshotId))
  );
}

function formatPersistError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'QuotaExceededError') {
      return 'Espaço do navegador esgotado. Remova bases antigas ou importe direto no servidor.';
    }
    return err.message || err.name;
  }
  if (err instanceof Error) return err.message;
  return 'Erro desconhecido ao salvar';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponível neste navegador.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error('Falha ao abrir IndexedDB'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('category', 'category', { unique: false });
      }
    };
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Transação IndexedDB falhou'));
    tx.onabort = () => reject(tx.error ?? new Error('Transação IndexedDB abortada'));
  });
}

function loadLegacyLocalStorage(): BasesByCategory {
  const empty = emptyBasesStore();
  try {
    const v2 = localStorage.getItem(LEGACY_STORAGE_KEY_V2);
    if (v2) {
      const parsed = JSON.parse(v2) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const id of CATEGORIES) {
          const arr = (parsed as Record<string, unknown>)[id];
          if (Array.isArray(arr)) {
            empty[id] = arr.filter(isValidSavedBase);
          }
        }
        return empty;
      }
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as unknown;
      if (Array.isArray(parsed)) {
        empty.matriculados = parsed.filter(isValidSavedBase);
      }
    }
  } catch {
    /* ignore */
  }
  return empty;
}

function clearLegacyLocalStorage(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY_V2);
  } catch {
    /* ignore */
  }
}

function trimForLocalStore(base: SavedBase): SavedBase {
  if (base.serverOnly || base.serverSnapshotId) {
    return { ...base, csvText: '', serverOnly: true };
  }
  if (base.csvText.length > MAX_LOCAL_CSV_CHARS) {
    return {
      ...base,
      csvText: '',
      serverOnly: true,
    };
  }
  return base;
}

async function putRows(rows: StoredRow[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const os = tx.objectStore(STORE);
  for (const row of rows) {
    os.put(row);
  }
  await txDone(tx);
  db.close();
}

async function writeAll(store: BasesByCategory): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const os = tx.objectStore(STORE);
  os.clear();
  for (const category of CATEGORIES) {
    for (const base of store[category] || []) {
      os.put({ ...trimForLocalStore(base), category } satisfies StoredRow);
    }
  }
  await txDone(tx);
  db.close();
}

async function migrateFromLocalStorageIfNeeded(): Promise<void> {
  const legacy = loadLegacyLocalStorage();
  const hasLegacy = CATEGORIES.some((c) => (legacy[c]?.length ?? 0) > 0);
  if (!hasLegacy) return;
  await writeAll(legacy);
  clearLegacyLocalStorage();
}

export async function loadBasesFromBrowser(): Promise<BasesByCategory> {
  const empty = emptyBasesStore();
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    const rows = await new Promise<StoredRow[]>((resolve, reject) => {
      req.onsuccess = () => resolve((req.result as StoredRow[]) || []);
      req.onerror = () => reject(req.error ?? new Error('Falha ao ler bases'));
    });
    await txDone(tx);
    db.close();

    if (rows.length === 0) {
      await migrateFromLocalStorageIfNeeded();
      return loadBasesFromBrowser();
    }

    for (const row of rows) {
      if (!CATEGORIES.includes(row.category) || !isValidSavedBase(row)) continue;
      const { category, ...base } = row;
      empty[category].push(base);
    }
    for (const category of CATEGORIES) {
      empty[category].sort(
        (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      );
    }
    clearLegacyLocalStorage();
    return empty;
  } catch {
    return loadLegacyLocalStorage();
  }
}

export async function addBasesToBrowser(
  category: ReportSlug,
  additions: SavedBase[]
): Promise<PersistResult> {
  if (!additions.length) return { ok: true };
  try {
    const rows = additions.map(
      (b) => ({ ...trimForLocalStore(b), category }) satisfies StoredRow
    );
    await putRows(rows);
    clearLegacyLocalStorage();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatPersistError(err) };
  }
}

export async function removeBaseFromBrowser(
  category: ReportSlug,
  id: string
): Promise<PersistResult> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await txDone(tx);
    db.close();
    void category;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatPersistError(err) };
  }
}

/** @deprecated Prefer addBasesToBrowser / removeBaseFromBrowser */
export async function persistBasesToBrowser(store: BasesByCategory): Promise<boolean> {
  try {
    await writeAll(store);
    clearLegacyLocalStorage();
    return true;
  } catch {
    return false;
  }
}

export function baseNeedsServerImport(b: SavedBase): boolean {
  return Boolean(b.serverOnly || !b.csvText.trim());
}
