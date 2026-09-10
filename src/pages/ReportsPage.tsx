import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, RefreshCw } from 'lucide-react';
import { CaaDailyPanel } from '../components/CaaDailyPanel';
import { CaaFunnelPanel } from '../components/CaaFunnelPanel';
import { ConsultoresPanel } from '../components/ConsultoresPanel';
import { Header } from '../components/Header';
import { MatriculadosComparisonPanel } from '../components/MatriculadosComparisonPanel';
import { RematriculaReportPanel } from '../components/RematriculaReportPanel';
import {
  isComparisonBuilding,
  reportApi,
  type MatriculadosComparisonResponse,
  type ReportSlug,
} from '../services/reportApi';
import { academicTermApi, type AcademicTermDTO } from '../services/academicTermApi';

const REPORT_CARDS: {
  id: ReportSlug;
  title: string;
  description: string;
}[] = [
  {
    id: 'matriculados',
    title: 'Matriculados',
    description: 'Alunos com data de matrícula (status diferente de cancelado).',
  },
  {
    id: 'docs-pendentes',
    title: 'Alunos docs. pendentes',
    description:
      'Indicadores em raw_data: docs_pendentes, documentação, pendência documental ou status da documentação.',
  },
  {
    id: 'financeiro',
    title: 'Financeiro',
    description:
      'Mensalidade em aberto (inclui quem ainda está no prazo). Cruzamento no painel de comparação.',
  },
  {
    id: 'inadimplentes-vencidos',
    title: 'Inadimplentes Vencidos',
    description:
      'Mensalidade vencida (após o prazo). Base legada; rematrícula usa SIAA/Portal em Bases.',
  },
  {
    id: 'inadimplentes-pos-siaa',
    title: 'Inadimplente Pós SIAA',
    description:
      'Export SIAA de mensalidade em aberto da Pós. Último snapshot importado em Bases; cruzamento no painel de comparação.',
  },
  {
    id: 'rematricula',
    title: 'Rematrícula',
    description:
      'Upload SIAA ou Portal — SIT_ATUAL=EM CURSO. Filtro Adimplente / Inadimplente no relatório abaixo.',
  },
  {
    id: 'provavel-evasao',
    title: 'Provável evasão',
    description:
      'Último snapshot importado em Bases (RGM, Ciclo, Faixa Risco Evasão). Cruzamento no painel de comparação.',
  },
  {
    id: 'acessos-blackboard',
    title: 'Acessos Blackboard',
    description: 'Export de quem já acessou o BB; ativação foca matriculados fora do arquivo.',
  },
  {
    id: 'processos-caa',
    title: 'CAA cancelamento',
    description:
      'Somente Subprocesso de cancelamento de matrícula (filtro no export CAA, não o total do arquivo).',
  },
];

export default function ReportsPage() {
  const [terms, setTerms] = useState<AcademicTermDTO[]>([]);
  const [termId, setTermId] = useState('');
  const [polo, setPolo] = useState('');
  const [active, setActive] = useState<ReportSlug>('matriculados');
  const [counts, setCounts] = useState<Partial<Record<ReportSlug, number>>>({});
  const [countHints, setCountHints] = useState<Partial<Record<ReportSlug, string>>>({});
  const [caaOpenCount, setCaaOpenCount] = useState<number | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [comparison, setComparison] = useState<MatriculadosComparisonResponse | null>(null);
  const [loadingComparison, setLoadingComparison] = useState(true);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      term_id: termId || undefined,
      polo: polo.trim() || undefined,
    }),
    [termId, polo]
  );

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true);
    setOverviewError(null);
    try {
      const r = await reportApi.overview(filters);
      setCounts(r.counts);
      setCountHints(r.count_hints ?? {});
    } catch (e) {
      setOverviewError(e instanceof Error ? e.message : 'Erro ao carregar resumo');
    } finally {
      setLoadingOverview(false);
    }
    try {
      const caa = await reportApi.caaSummary();
      setCaaOpenCount(caa.current.open);
    } catch {
      setCaaOpenCount(null);
    }
  }, [filters]);

  const loadComparison = useCallback(async (opts?: { refresh?: boolean }) => {
    setLoadingComparison(true);
    setComparisonError(null);

    const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

    const pullWhenReady = async (): Promise<MatriculadosComparisonResponse | null> => {
      for (let i = 0; i < 120; i += 1) {
        const status = await reportApi.matriculadosComparisonStatus();
        if (status.ready) {
          const r = await reportApi.matriculadosComparison();
          if (!isComparisonBuilding(r)) return r;
        }
        await sleep(status.building || !status.ready ? 3000 : 1500);
      }
      return null;
    };

    try {
      if (opts?.refresh) {
        await reportApi.matriculadosComparisonInvalidate().catch(() => {});
      }
      const first = await reportApi.matriculadosComparison();
      if (!isComparisonBuilding(first)) {
        setComparison(first);
        return;
      }
      const data = await pullWhenReady();
      if (data) {
        setComparison(data);
        return;
      }
      setComparisonError(
        'O painel de comparação demorou demais. Confira se o backend está rodando e clique em Recalcular painel.'
      );
      setComparison(null);
    } catch (e) {
      setComparisonError(e instanceof Error ? e.message : 'Erro ao carregar comparação');
      setComparison(null);
    } finally {
      setLoadingComparison(false);
    }
  }, []);

  useEffect(() => {
    academicTermApi
      .list({})
      .then((r) => setTerms(r.terms))
      .catch(() => setTerms([]));
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (loadingOverview) return;
    const delay = overviewError ? 800 : 400;
    const t = window.setTimeout(() => {
      void loadComparison();
    }, delay);
    return () => window.clearTimeout(t);
  }, [loadComparison, loadingOverview, overviewError]);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-gray-900">
              <BarChart3 className="w-7 h-7 text-whatsapp-600" />
              <h2 className="text-2xl font-semibold">Relatórios</h2>
            </div>
            <p className="text-sm text-gray-500 mt-1 max-w-3xl">
              Somente visualização: cards e comparação com as planilhas em{' '}
              <Link to="/bases" className="text-whatsapp-700 hover:underline font-medium">
                Bases
              </Link>
              . Para buscar no DataCrazy e ativar, use{' '}
              <Link to="/?mode=activation" className="text-whatsapp-700 hover:underline font-medium">
                Disparador → Ativação por bases
              </Link>
              .
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                await reportApi.overviewInvalidate().catch(() => {});
                await loadOverview();
                await loadComparison({ refresh: true });
              })();
            }}
            disabled={loadingOverview || loadingComparison}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw
              className={`w-4 h-4 ${loadingOverview || loadingComparison ? 'animate-spin' : ''}`}
            />
            Atualizar
          </button>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 flex flex-wrap gap-3 shadow-sm">
          <select
            value={termId}
            onChange={(e) => setTermId(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm min-w-[200px] focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
          >
            <option value="">Todas as turmas</option>
            {terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.codigo} — {t.nome}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Filtrar por polo (contém)"
            value={polo}
            onChange={(e) => setPolo(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm flex-1 min-w-[180px] max-w-xs focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
          />
        </div>

        {overviewError && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-700 p-3">
            <p className="font-medium">Resumo das bases (cards)</p>
            <p className="mt-1">{overviewError}</p>
            <p className="mt-2 text-xs text-rose-600/90">
              Confira se o backend está rodando (<code>npm run dev</code>), se o <code>.env</code> tem{' '}
              <code>DATABASE_URL</code>, e aguarde no terminal do servidor{' '}
              <code>contagem CAA ok</code> (pré-aquecimento). Depois clique em <strong>Atualizar</strong>.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          {REPORT_CARDS.map((card) => {
            const isCaa = card.id === 'processos-caa';
            const rawN = counts[card.id];
            const n = isCaa ? (caaOpenCount ?? undefined) : rawN;
            const title = isCaa ? 'CAA — ativações disponíveis' : card.title;
            const description = isCaa
              ? 'Protocolos com status PENDENTE no snapshot mais recente — fila ativa para ativação.'
              : card.description;
            const hint = isCaa
              ? rawN != null
                ? `de ${rawN.toLocaleString('pt-BR')} cancelamentos no arquivo`
                : undefined
              : countHints[card.id];
            const selected = active === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => setActive(card.id)}
                className={`text-left rounded-xl border p-4 transition-shadow ${
                  selected
                    ? 'border-whatsapp-400 bg-whatsapp-50 ring-2 ring-whatsapp-200 shadow-sm'
                    : 'border-gray-100 bg-white hover:border-gray-200 shadow-sm'
                }`}
              >
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{title}</p>
                <p className="text-2xl font-semibold text-gray-900 mt-1 tabular-nums">
                  {loadingOverview && n === undefined ? '…' : (n ?? 0).toLocaleString('pt-BR')}
                </p>
                <p className="text-xs text-gray-500 mt-2 leading-snug">
                  {description}
                  {hint && <span className="block mt-1 text-amber-800/90 font-medium">{hint}</span>}
                </p>
              </button>
            );
          })}
        </div>

        <MatriculadosComparisonPanel
          data={comparison}
          loading={loadingComparison}
          error={comparisonError}
          onRefresh={() => void loadComparison({ refresh: true })}
        />

        <CaaDailyPanel />

        {active === 'processos-caa' && <CaaFunnelPanel />}

        {active === 'processos-caa' && <ConsultoresPanel />}

        {active === 'rematricula' && <RematriculaReportPanel onRefreshOverview={() => void loadOverview()} />}
      </main>
    </div>
  );
}
