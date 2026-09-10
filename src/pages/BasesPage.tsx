import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Loader2, Trash2, Upload, UploadCloud, FileSpreadsheet, Lock, Unlock } from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { Header } from '../components/Header';
import { RematriculaBasesSection } from '../components/RematriculaBasesSection';
import { Toast, type ToastVariant } from '../components/Toast';
import { detectFileKind, fileToCsvText, isSupportedFile } from '../utils/fileToCsvText';
import {
  addBasesToBrowser,
  baseNeedsServerImport,
  emptyBasesStore,
  loadBasesFromBrowser,
  MAX_LOCAL_CSV_CHARS,
  removeBaseFromBrowser,
  type BasesByCategory,
  type SavedBase,
} from '../utils/basesBrowserStorage';
import { baseUploadApi } from '../services/baseUploadApi';
import type { ReportSlug } from '../services/reportApi';
import { cyclesApi, type CycleStatus } from '../services/cyclesApi';
import { readConsultorIdentity } from '../services/meuPainelApi';

const SECTIONS: { id: ReportSlug; title: string; hint: string }[] = [
  {
    id: 'matriculados',
    title: 'Matriculados',
    hint: 'Listas de alunos matriculados (CSV/XLSX normalizado como CSV).',
  },
  {
    id: 'docs-pendentes',
    title: 'Alunos docs. pendentes',
    hint: 'Base para pendências de documentação.',
  },
  {
    id: 'financeiro',
    title: 'Financeiro',
    hint: 'Base financeira / mensalidade em aberto (inclui quem ainda está no prazo de pagamento).',
  },
  {
    id: 'inadimplentes-vencidos',
    title: 'Inadimplentes Vencidos',
    hint:
      'Alunos com mensalidade vencida (legado). Preferir uploads em Rematrícula (SIAA / Portal de Polos).',
  },
  {
    id: 'inadimplentes-pos-siaa',
    title: 'Inadimplente Pós SIAA',
    hint: 'Export SIAA de mensalidade em aberto da Pós-Graduação.',
  },
  {
    id: 'acessos-blackboard',
    title: 'Acessos Blackboard',
    hint: 'Quem já acessou o BB (export por polo). Ativação = matriculados que não estão neste arquivo.',
  },
  {
    id: 'processos-caa',
    title: 'Processos CAA',
    hint: 'Protocolos e status do CAA.',
  },
  {
    id: 'provavel-evasao',
    title: 'Provável evasão',
    hint:
      'Export de risco de evasão (RGM, Ciclo, Evasão Média). Duplicatas por RGM+ciclo são removidas no import — fica só a linha com maior probabilidade.',
  },
];

/** Todo XLSX no servidor — preserva RGM formatado (ex.: 49004816) da célula Excel. */
const SERVER_PARSE_MIN_BYTES = 0;

function countDataLines(csvText: string): number {
  const t = csvText.trim();
  if (!t) return 0;
  return t.split(/\r?\n/).length;
}

interface ToastState {
  message: string;
  variant: ToastVariant;
  visible: boolean;
}

function CyclesPanel() {
  const [cycles, setCycles] = useState<CycleStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyCiclo, setBusyCiclo] = useState<string | null>(null);
  const [freezingCiclo, setFreezingCiclo] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await cyclesApi.list();
      setCycles(data.cycles);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar ciclos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleFreeze = useCallback(async (ciclo: string) => {
    setBusyCiclo(ciclo);
    try {
      const identity = readConsultorIdentity();
      await cyclesApi.freeze(ciclo, {
        reason: motivo.trim() || undefined,
        by: identity.nome ?? identity.username ?? undefined,
      });
      setFreezingCiclo(null);
      setMotivo('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao congelar ciclo.');
    } finally {
      setBusyCiclo(null);
    }
  }, [motivo, load]);

  const handleUnfreeze = useCallback(async (ciclo: string) => {
    setBusyCiclo(ciclo);
    try {
      await cyclesApi.unfreeze(ciclo);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao reativar ciclo.');
    } finally {
      setBusyCiclo(null);
    }
  }, [load]);

  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/80 flex items-center gap-2">
        <Lock className="w-4 h-4 text-gray-500" />
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Ciclos</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Congele um ciclo para removê-lo do disparador, relatórios e dropdowns. O histórico de disparos é preservado.
          </p>
        </div>
      </div>
      <div className="p-4">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Carregando ciclos…
          </div>
        )}
        {error && (
          <p className="text-xs text-red-500">{error}</p>
        )}
        {!loading && !error && cycles.length === 0 && (
          <p className="text-xs text-gray-400">Nenhum ciclo disponível (suba uma base de matriculados).</p>
        )}
        {!loading && cycles.length > 0 && (
          <ul className="divide-y divide-gray-100">
            {cycles.map((c) => (
              <li key={c.ciclo} className="py-2.5 flex flex-col gap-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-gray-900">{c.ciclo}</span>
                  {c.status === 'frozen' ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-600">
                      <Lock className="w-3 h-3" />
                      arquivado
                      {c.frozen_at && (
                        <span className="text-gray-400 ml-0.5">
                          em {new Date(c.frozen_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          {c.frozen_by ? ` por ${c.frozen_by}` : ''}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700">
                      ativo
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    {c.status === 'active' && (
                      <button
                        type="button"
                        disabled={busyCiclo === c.ciclo}
                        onClick={() => setFreezingCiclo(freezingCiclo === c.ciclo ? null : c.ciclo)}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {busyCiclo === c.ciclo ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Lock className="w-3 h-3" />
                        )}
                        Congelar
                      </button>
                    )}
                    {c.status === 'frozen' && (
                      <button
                        type="button"
                        disabled={busyCiclo === c.ciclo}
                        onClick={() => void handleUnfreeze(c.ciclo)}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                      >
                        {busyCiclo === c.ciclo ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Unlock className="w-3 h-3" />
                        )}
                        Reativar
                      </button>
                    )}
                  </div>
                </div>
                {c.reason && (
                  <p className="text-[11px] text-gray-400 pl-0.5">Motivo: {c.reason}</p>
                )}
                {freezingCiclo === c.ciclo && (
                  <div className="mt-1 flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                    <p className="text-xs font-medium text-amber-800">
                      Congelar ciclo <strong>{c.ciclo}</strong>? O ciclo some do disparador e relatórios. Histórico preservado.
                    </p>
                    <textarea
                      className="w-full text-xs rounded-md border border-gray-200 px-2.5 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-amber-300"
                      placeholder="Motivo (opcional)"
                      rows={2}
                      value={motivo}
                      onChange={(e) => setMotivo(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busyCiclo === c.ciclo}
                        onClick={() => void handleFreeze(c.ciclo)}
                        className="flex items-center gap-1 px-3 py-1 text-xs font-semibold rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
                      >
                        {busyCiclo === c.ciclo ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Lock className="w-3 h-3" />
                        )}
                        Confirmar congelamento
                      </button>
                      <button
                        type="button"
                        onClick={() => { setFreezingCiclo(null); setMotivo(''); }}
                        className="px-3 py-1 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default function BasesPage() {
  const [store, setStore] = useState<BasesByCategory>(() => emptyBasesStore());
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState<Partial<Record<ReportSlug, boolean>>>({});
  const [importingId, setImportingId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>({
    message: '',
    variant: 'success',
    visible: false,
  });

  const showToast = useCallback((message: string, variant: ToastVariant = 'success') => {
    setToast({ message, variant, visible: true });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadBasesFromBrowser().then((loaded) => {
      if (!cancelled) setStore(loaded);
      if (!cancelled) setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const uploadToServerAndSlim = useCallback(
    async (category: ReportSlug, bases: SavedBase[], rawFiles?: Map<string, File>) => {
      const saved: SavedBase[] = [];
      for (const b of bases) {
        const raw = rawFiles?.get(b.id);
        const useRaw =
          raw &&
          (detectFileKind(raw) === 'xlsx' && raw.size >= SERVER_PARSE_MIN_BYTES);
        const result = useRaw
          ? await baseUploadApi.uploadFile(category, raw)
          : await baseUploadApi.uploadCsv(category, {
              fileName: b.name,
              csvText: b.csvText,
              fileSizeBytes: b.size,
            });
        if (result.warning) {
          showToast(result.warning, 'error');
        }
        saved.push({
          ...b,
          csvText: '',
          serverOnly: true,
          serverSnapshotId: result.snapshot?.id,
          lineCount: result.rowCount ?? b.lineCount,
        });
      }
      return saved;
    },
    []
  );

  const ingestFiles = useCallback(
    async (fileList: FileList | File[], category: ReportSlug) => {
      const files = Array.from(fileList).filter((f) => isSupportedFile(f));
      if (!files.length) {
        showToast('Nenhum arquivo CSV ou XLSX válido selecionado.', 'error');
        return;
      }
      setBusy((b) => ({ ...b, [category]: true }));
      try {
        const additions: SavedBase[] = [];
        const rawFiles = new Map<string, File>();
        for (const file of files) {
          const id = uuid();
          const serverParse =
            detectFileKind(file) === 'xlsx' && file.size >= SERVER_PARSE_MIN_BYTES;
          if (serverParse) {
            additions.push({
              id,
              name: file.name,
              size: file.size,
              lineCount: 0,
              uploadedAt: new Date().toISOString(),
              csvText: '',
            });
            rawFiles.set(id, file);
          } else {
            const csvText = await fileToCsvText(file);
            additions.push({
              id,
              name: file.name,
              size: file.size,
              lineCount: countDataLines(csvText),
              uploadedAt: new Date().toISOString(),
              csvText,
            });
          }
        }

        const label = SECTIONS.find((s) => s.id === category)?.title ?? category;
        const serverDirect = additions.filter((b) => rawFiles.has(b.id));
        const localCandidates = additions.filter(
          (b) => !rawFiles.has(b.id) && b.csvText.length <= MAX_LOCAL_CSV_CHARS
        );
        const huge = additions.filter(
          (b) => !rawFiles.has(b.id) && b.csvText.length > MAX_LOCAL_CSV_CHARS
        );

        const saved: SavedBase[] = [];

        if (serverDirect.length) {
          try {
            showToast(
              `${label}: importando ${serverDirect.length} arquivo(s) no servidor (planilha grande)…`,
              'info'
            );
            const onServer = await uploadToServerAndSlim(category, serverDirect, rawFiles);
            const result = await addBasesToBrowser(category, onServer);
            if (!result.ok) {
              showToast(
                result.error ||
                  'Importado no servidor, mas não foi possível registrar na lista local.',
                'error'
              );
              return;
            }
            saved.push(...onServer);
          } catch (serverErr) {
            showToast(
              serverErr instanceof Error
                ? serverErr.message
                : 'Falha ao importar planilha grande no servidor.',
              'error'
            );
            return;
          }
        }

        if (localCandidates.length) {
          let result = await addBasesToBrowser(category, localCandidates);
          if (result.ok) {
            saved.push(...localCandidates);
          } else {
            try {
              const onServer = await uploadToServerAndSlim(category, localCandidates, rawFiles);
              result = await addBasesToBrowser(category, onServer);
              if (result.ok) saved.push(...onServer);
            } catch (serverErr) {
              showToast(
                result.error ||
                  (serverErr instanceof Error
                    ? serverErr.message
                    : 'Não foi possível salvar nem importar no servidor.'),
                'error'
              );
              return;
            }
          }
        }

        if (huge.length) {
          try {
            showToast(
              `${label}: arquivo grande — importando direto no servidor (pode levar alguns minutos)…`,
              'info'
            );
            const onServer = await uploadToServerAndSlim(category, huge, rawFiles);
            const result = await addBasesToBrowser(category, onServer);
            if (!result.ok) {
              showToast(
                result.error ||
                  'Importado no servidor, mas não foi possível registrar na lista local.',
                'error'
              );
              return;
            }
            saved.push(...onServer);
          } catch (serverErr) {
            showToast(
              serverErr instanceof Error
                ? serverErr.message
                : 'Falha ao importar arquivo grande no servidor.',
              'error'
            );
            if (!saved.length) return;
          }
        }

        if (!saved.length) {
          showToast('Nenhum arquivo foi salvo.', 'error');
          return;
        }

        setStore((prev) => ({
          ...prev,
          [category]: [...saved, ...(prev[category] || [])],
        }));

        const serverOnlyCount = saved.filter((b) => b.serverOnly).length;
        const suffix =
          serverOnlyCount > 0
            ? ' Importado no servidor — abra Relatórios e clique em Atualizar.'
            : '';
        showToast(
          saved.length === 1
            ? `${label}: "${saved[0].name}" salvo (${saved[0].lineCount} linhas).${suffix}`
            : `${label}: ${saved.length} arquivo(s) salvos.${suffix}`,
          'success'
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Erro ao processar arquivo(s).', 'error');
      } finally {
        setBusy((b) => ({ ...b, [category]: false }));
      }
    },
    [showToast, uploadToServerAndSlim]
  );

  const handlePick = useCallback(
    (category: ReportSlug) => {
      if (busy[category]) return;
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept =
        '.csv,.xlsx,.xls,.xlsm,.xlsb,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';
      input.onchange = () => {
        const list = input.files;
        if (list?.length) void ingestFiles(list, category);
      };
      input.click();
    },
    [busy, ingestFiles]
  );

  const removeBase = useCallback(
    async (category: ReportSlug, id: string) => {
      const result = await removeBaseFromBrowser(category, id);
      if (!result.ok) {
        showToast(result.error || 'Erro ao atualizar o armazenamento local.', 'error');
        return;
      }
      setStore((prev) => ({
        ...prev,
        [category]: (prev[category] || []).filter((b) => b.id !== id),
      }));
      showToast('Arquivo removido.', 'info');
    },
    [showToast]
  );

  const applyServerImportResult = useCallback(
    async (category: ReportSlug, b: SavedBase, file: File, result: { snapshot?: { id: string }; rowCount?: number }) => {
      const rows = result.rowCount ?? b.lineCount;
      const slim: SavedBase = {
        ...b,
        name: file.name,
        size: file.size,
        lineCount: rows,
        uploadedAt: new Date().toISOString(),
        csvText: '',
        serverOnly: true,
        serverSnapshotId: result.snapshot?.id ?? b.serverSnapshotId,
      };
      await removeBaseFromBrowser(category, b.id);
      await addBasesToBrowser(category, [slim]);
      setStore((prev) => ({
        ...prev,
        [category]: (prev[category] || []).map((x) => (x.id === b.id ? slim : x)),
      }));
      return rows;
    },
    []
  );

  const importToServer = useCallback(
    async (category: ReportSlug, b: SavedBase, fileFromPicker?: File) => {
      const pickFile = (): Promise<File | null> =>
        new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept =
            '.csv,.xlsx,.xls,.xlsm,.xlsb,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';
          input.onchange = () => resolve(input.files?.[0] ?? null);
          input.click();
        });

      setImportingId(b.id);
      try {
        let file = fileFromPicker;
        if (!file && baseNeedsServerImport(b)) {
          showToast(`Escolha o arquivo para importar em "${SECTIONS.find((s) => s.id === category)?.title ?? category}".`, 'info');
          file = await pickFile();
          if (!file) return;
        }

        if (file) {
          const isXlsx = detectFileKind(file) === 'xlsx';
          const result = isXlsx
            ? await baseUploadApi.uploadFile(category, file)
            : await baseUploadApi.uploadCsv(category, {
                fileName: file.name,
                csvText: await fileToCsvText(file),
                fileSizeBytes: file.size,
              });
          if (result.warning) {
            showToast(result.warning, 'error');
          }
          const rows = await applyServerImportResult(category, b, file, result);
          showToast(
            `"${file.name}" importado no servidor (${rows.toLocaleString('pt-BR')} linhas). Atualize Relatórios/Ativação.`,
            'success'
          );
          return;
        }

        if (!b.csvText.trim()) {
          showToast(`"${b.name}" não tem cópia local. Clique na nuvem e escolha o arquivo.`, 'error');
          return;
        }

        const result = await baseUploadApi.uploadCsv(category, {
          fileName: b.name,
          csvText: b.csvText,
          fileSizeBytes: b.size,
        });
        if (result.warning) {
          showToast(result.warning, 'error');
        }
        const pseudoFile = new File([b.csvText], b.name, { type: 'text/csv' });
        const rows = await applyServerImportResult(category, b, pseudoFile, result);
        showToast(
          `"${b.name}" importado no servidor (${rows.toLocaleString('pt-BR')} linhas). Atualize Relatórios/Ativação.`,
          'success'
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao importar no servidor.';
        const hint =
          msg.includes('500') || msg.includes('fetch') || msg.includes('ECONNRESET')
            ? ' Verifique se o backend está rodando (npm run dev).'
            : '';
        showToast(msg + hint, 'error');
      } finally {
        setImportingId(null);
      }
    },
    [showToast, applyServerImportResult]
  );

  const downloadBase = useCallback(
    (b: SavedBase) => {
      if (baseNeedsServerImport(b)) {
        showToast(
          `"${b.name}" está só no servidor (arquivo grande). Os dados estão em Relatórios.`,
          'info'
        );
        return;
      }
      const blob = new Blob([b.csvText], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const baseName = b.name.replace(/\.[^.]+$/i, '') || 'base';
      a.href = url;
      a.download = `${baseName}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [showToast]
  );

  const totalFiles = SECTIONS.reduce((n, s) => n + (store[s.id]?.length ?? 0), 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900">Bases</h2>
            <p className="text-sm text-gray-500 mt-1 max-w-3xl">
              Arraste ou clique para salvar no navegador. Depois use{' '}
              <strong className="text-gray-700">Importar no servidor</strong> (ícone de nuvem) para
              alimentar os cards e comparações em{' '}
              <Link to="/reports" className="text-whatsapp-700 hover:underline font-medium">
                Relatórios
              </Link>
              . Formatos: CSV ou XLSX.
            </p>
          </div>
          {!hydrated ? (
            <span className="text-xs text-gray-400">Carregando…</span>
          ) : (
            <span className="text-xs text-gray-500">{totalFiles} arquivo(s) no total</span>
          )}
        </div>

        <CyclesPanel />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <RematriculaBasesSection
            onToast={(message, variant) => showToast(message, variant)}
          />
          {SECTIONS.map((section) => {
            const list = store[section.id] || [];
            const isBusy = Boolean(busy[section.id]);
            return (
              <section
                key={section.id}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm flex flex-col overflow-hidden"
              >
                <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/80">
                  <h3 className="text-sm font-semibold text-gray-900">{section.title}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{section.hint}</p>
                </div>

                <div className="p-4 flex flex-col gap-3 flex-1 min-h-0">
                  <div
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handlePick(section.id);
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (isBusy) return;
                      void ingestFiles(e.dataTransfer.files, section.id);
                    }}
                    onClick={() => handlePick(section.id)}
                    className={`rounded-xl border-2 border-dashed border-gray-200 p-5 text-center cursor-pointer transition-all flex-shrink-0 ${
                      isBusy
                        ? 'opacity-60 pointer-events-none'
                        : 'hover:border-whatsapp-400 hover:bg-emerald-50/30'
                    }`}
                  >
                    <div className="w-11 h-11 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-2">
                      <Upload className="w-5 h-5 text-gray-500" />
                    </div>
                    <p className="text-xs font-medium text-gray-700">
                      {isBusy ? 'Processando…' : 'Arraste arquivos aqui ou clique'}
                    </p>
                    <p className="text-[11px] text-gray-400 mt-0.5">CSV, XLSX, XLS…</p>
                  </div>

                  <div className="flex-1 min-h-[120px] max-h-56 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50/50">
                    {list.length === 0 ? (
                      <p className="text-xs text-gray-500 p-3 text-center">Nenhum arquivo nesta base.</p>
                    ) : (
                      <ul className="divide-y divide-gray-100">
                        {list.map((b) => (
                          <li
                            key={b.id}
                            className="px-3 py-2 flex items-start gap-2 hover:bg-white/80 text-xs"
                          >
                            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-gray-900 truncate" title={b.name}>
                                {b.name}
                              </p>
                              <p className="text-gray-500">
                                {b.lineCount} linhas · {(b.size / 1024).toFixed(1)} KB
                                {b.serverOnly ? ' · no servidor' : ''} ·{' '}
                                {new Date(b.uploadedAt).toLocaleString('pt-BR', {
                                  day: '2-digit',
                                  month: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </p>
                            </div>
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                type="button"
                                disabled={importingId === b.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void importToServer(section.id, b);
                                }}
                                className="p-1.5 text-gray-500 hover:text-whatsapp-700 hover:bg-whatsapp-50 rounded-md disabled:opacity-50"
                                title={
                                  b.serverOnly
                                    ? 'Reimportar no servidor (escolher arquivo de novo)'
                                    : 'Importar no servidor (Postgres) para Relatórios'
                                }
                              >
                                {importingId === b.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <UploadCloud className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  downloadBase(b);
                                }}
                                className="p-1.5 text-gray-500 hover:text-whatsapp-700 hover:bg-whatsapp-50 rounded-md"
                                title="Baixar CSV"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void removeBase(section.id, b.id);
                                }}
                                className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-md"
                                title="Remover"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>

        <p className="text-xs text-gray-400">
          Arquivos pequenos ficam no navegador (IndexedDB); arquivos grandes ou quando o
          navegador está cheio são importados direto no servidor. Use{' '}
          <strong className="text-gray-500">Importar no servidor</strong> (nuvem). Se já consta
          &quot;no servidor&quot;, clique na nuvem de novo e escolha o arquivo para{' '}
          <strong className="text-gray-500">substituir</strong> os dados. Depois atualize Relatórios.
        </p>
      </main>

      <Toast
        message={toast.message}
        variant={toast.variant}
        isVisible={toast.visible}
        onClose={() => setToast((t) => ({ ...t, visible: false }))}
      />
    </div>
  );
}
