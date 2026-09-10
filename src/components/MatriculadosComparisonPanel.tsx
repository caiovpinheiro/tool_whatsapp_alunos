import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import type {
  MatriculadosComparisonBlock,
  MatriculadosComparisonByCiclo,
  MatriculadosComparisonResponse,
} from '../services/reportApi';

const ACTIVATION_BLOCK_IDS = new Set([
  'docs-pendentes',
  'financeiro',
  'inadimplentes-vencidos',
  'inadimplentes-pos-siaa',
  'provavel-evasao',
  'acessos-blackboard',
  'processos-caa',
]);

function Num({ n }: { n: number }) {
  return <span className="tabular-nums font-semibold text-gray-900">{n.toLocaleString('pt-BR')}</span>;
}

function getCount(cicloData: MatriculadosComparisonByCiclo | undefined, blockId: string): number {
  if (!cicloData) return 0;
  const block = cicloData.blocks.find((bl) => bl.id === blockId);
  if (!block) return 0;
  return block.mode === 'other_is_coverage_list' ? block.matriculados_sem_intersecao : block.intersecao;
}

function primaryCount(b: MatriculadosComparisonBlock): number | null {
  if (b.missing_other) return null;
  if (b.id === 'processos-caa') return b.intersecao;
  const isBbCoverage = b.mode === 'other_is_coverage_list';
  return isBbCoverage ? b.matriculados_sem_intersecao : b.intersecao;
}

const EXPANDED_STORAGE_KEY = 'reports_comparison_expanded_v1';

interface CollapsibleBlockProps {
  blockId: string;
  title: string;
  subtitle?: string;
  badge?: string | null;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

function CollapsibleBlock({
  blockId,
  title,
  subtitle,
  badge,
  expanded,
  onToggle,
  children,
}: CollapsibleBlockProps) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        id={`comparison-block-${blockId}`}
        aria-expanded={expanded}
        aria-controls={`comparison-block-body-${blockId}`}
        onClick={onToggle}
        className="w-full flex items-start gap-2 px-4 py-3 text-left hover:bg-gray-50/80 transition-colors"
      >
        <span className="mt-0.5 text-gray-400 flex-shrink-0">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">{title}</span>
            {badge != null && (
              <span className="text-xs font-semibold tabular-nums text-gray-700 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded">
                {badge}
              </span>
            )}
          </span>
          {subtitle && !expanded && (
            <span className="block text-[11px] text-gray-500 mt-0.5 truncate">{subtitle}</span>
          )}
        </span>
      </button>
      {expanded && (
        <div id={`comparison-block-body-${blockId}`} className="px-4 pb-4 pt-0 border-t border-gray-50">
          {children}
        </div>
      )}
    </div>
  );
}

interface BlockCardProps {
  b: MatriculadosComparisonBlock;
  byCiclo?: Record<string, MatriculadosComparisonByCiclo>;
  availableCiclos?: string[];
  expanded: boolean;
  onToggle: () => void;
}

function BlockCard({ b, byCiclo, availableCiclos, expanded, onToggle }: BlockCardProps) {
  const count = primaryCount(b);
  const badge =
    count != null
      ? count.toLocaleString('pt-BR')
      : b.missing_other
        ? 'sem upload'
        : null;

  const subtitle = b.missing_other
    ? 'Nenhum snapshot importado'
    : `Planilha: ${b.other_snapshot?.file_name ?? '—'}`;

  if (b.missing_other) {
    return (
      <CollapsibleBlock
        blockId={b.id}
        title={b.title}
        subtitle={subtitle}
        badge={badge}
        expanded={expanded}
        onToggle={onToggle}
      >
        <p className="text-xs text-amber-800 mt-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
          Nenhum snapshot importado para esta base. Envie a planilha em Bases ou rode o seed.
        </p>
      </CollapsibleBlock>
    );
  }

  if (b.id === 'processos-caa') {
    return (
      <CollapsibleBlock
        blockId={b.id}
        title={b.title}
        subtitle={subtitle}
        badge={badge}
        expanded={expanded}
        onToggle={onToggle}
      >
        <p className="text-[11px] text-gray-500 mt-2">
          Planilha: {b.other_snapshot?.file_name}
          {b.na_outra_rows_total != null && b.na_outra_rows_total !== b.na_outra_rows ? (
            <>
              {' '}
              · {b.na_outra_rows?.toLocaleString('pt-BR')} linhas de cancelamento (de{' '}
              {b.na_outra_rows_total.toLocaleString('pt-BR')} no arquivo)
            </>
          ) : (
            <> · {b.na_outra_rows?.toLocaleString('pt-BR')} linhas</>
          )}
        </p>
        <p className="text-xs text-gray-600 mt-3 leading-relaxed">
          O cruzamento bruto (matriculados × planilha CAA) inclui protocolos já concluídos
          ou cancelados pelo aluno. A <strong>fila real de ativação</strong> e o desfecho diário
          (perdidos / revertidos / novos pendentes) ficam no painel{' '}
          <strong>CAA — Painel D+1</strong> abaixo, alimentado por <code className="text-[10px]">caa_protocols</code>.
        </p>
      </CollapsibleBlock>
    );
  }

  const isBbCoverage = b.mode === 'other_is_coverage_list';
  const a = isBbCoverage ? b.matriculados_sem_intersecao : b.intersecao;
  const bOnly = isBbCoverage ? b.intersecao : b.matriculados_sem_intersecao;
  const out = b.na_outra_sem_matricula;

  let primaryLabel = '';
  let primaryDesc = '';
  let secondaryLabel = '';
  let secondaryDesc = '';
  let tertiaryLabel = '';
  let tertiaryDesc = '';

  if (b.mode === 'other_is_problem_list') {
    primaryLabel = 'Com pendência (matrícula + planilha de docs)';
    primaryDesc =
      'Estão matriculados e também na lista de pendências — fila principal para ativação ou regularização.';
    secondaryLabel = 'Matriculado sem pendência nesta planilha';
    secondaryDesc = 'Na base de matrícula, mas não aparecem nesta planilha de pendências.';
    tertiaryLabel = 'Só na planilha de pendências';
    tertiaryDesc =
      b.id === 'provavel-evasao'
        ? 'Sem match por nome/RGM com matriculados. A planilha de evasão usa RGM numérico; matriculados costuma vir como +000000-00 — o cruzamento usa também o nome.'
        : 'Linhas na planilha sem match com matriculados. Quem só casa por RGM com ciclo diferente aparece no bloco âmbar abaixo (rematrícula / ciclo antigo).';
  } else if (b.mode === 'other_is_coverage_list') {
    primaryLabel = 'Matriculados sem linha no export BB';
    primaryDesc =
      'Ainda sem registro no arquivo de acessos — fila para ativar ou orientar primeiro acesso ao Blackboard.';
    secondaryLabel = 'Matriculados com linha no export BB';
    secondaryDesc =
      'Quem aparece no export já consta como tendo acessado o Blackboard (não entra na fila de ativação).';
    tertiaryLabel = 'No BB, fora do conjunto de matriculados';
    tertiaryDesc =
      'Linhas do BB sem match com matriculados. RGM igual com ciclo diferente não conta como “já acessou” no ciclo atual.';
  } else {
    primaryLabel = 'Matriculados com solicitação de cancelamento (CAA)';
    primaryDesc =
      'Match com linhas em que o Subprocesso é cancelamento de matrícula (ex.: CANCELAMENTO DE MATRÍCULA).';
    secondaryLabel = 'Matriculados sem cancelamento neste recorte';
    secondaryDesc =
      'Matriculados sem protocolo de cancelamento de matrícula no filtro atual do CAA.';
    tertiaryLabel = 'Cancelamentos CAA sem matrícula correspondente';
    tertiaryDesc =
      'Solicitações de cancelamento no arquivo que não casam com matriculados distintos.';
  }

  const showActivationHint = ACTIVATION_BLOCK_IDS.has(b.id) && a > 0;

  return (
    <CollapsibleBlock
      blockId={b.id}
      title={b.title}
      subtitle={subtitle}
      badge={badge}
      expanded={expanded}
      onToggle={onToggle}
    >
      <p className="text-[11px] text-gray-500 mt-2">
        Planilha: {b.other_snapshot?.file_name}
        {b.na_outra_rows_total != null && b.na_outra_rows_total !== b.na_outra_rows ? (
          <>
            {' '}
            · {b.na_outra_rows?.toLocaleString('pt-BR')} linhas de cancelamento (de{' '}
            {b.na_outra_rows_total.toLocaleString('pt-BR')} no arquivo)
          </>
        ) : (
          <> · {b.na_outra_rows?.toLocaleString('pt-BR')} linhas</>
        )}{' '}
        · {b.na_outra_distintos.toLocaleString('pt-BR')} pessoas distintas
        {b.na_outra_sem_chave != null && b.na_outra_sem_chave > 0 && (
          <> · {b.na_outra_sem_chave.toLocaleString('pt-BR')} linhas sem chave</>
        )}
      </p>
      {b.na_outra_filtro && (
        <p className="text-[10px] text-amber-800/90 mt-1 leading-snug">{b.na_outra_filtro}</p>
      )}
      <dl className="mt-3 space-y-3 text-xs">
        <div className="rounded-lg bg-rose-50 border border-rose-100 px-3 py-2">
          <dt className="text-rose-800 font-medium">{primaryLabel}</dt>
          <dd className="text-lg mt-0.5">
            <Num n={a} />
          </dd>
          {byCiclo && availableCiclos && availableCiclos.length > 1 && (
            <dd className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-gray-500">
              {availableCiclos.map((c) => (
                <span key={c} className="px-1.5 py-0.5 rounded bg-gray-100 border border-gray-200">
                  {c}:{' '}
                  <strong className="text-gray-700">
                    {getCount(byCiclo[c], b.id).toLocaleString('pt-BR')}
                  </strong>
                </span>
              ))}
            </dd>
          )}
          <dd className="text-rose-700/90 mt-1 leading-snug">{primaryDesc}</dd>
          {showActivationHint && (
            <dd className="text-[10px] text-rose-800/90 mt-2 leading-snug">
              Para buscar e ativar no DataCrazy, use{' '}
              <Link to="/?mode=activation" className="font-medium text-whatsapp-700 hover:underline">
                Disparador → Ativação por bases
              </Link>
              .
            </dd>
          )}
        </div>
        <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2">
          <dt className="text-emerald-800 font-medium">{secondaryLabel}</dt>
          <dd className="text-lg mt-0.5">
            <Num n={bOnly} />
          </dd>
          <dd className="text-emerald-700/90 mt-1 leading-snug">{secondaryDesc}</dd>
        </div>
        <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2">
          <dt className="text-gray-700 font-medium">{tertiaryLabel}</dt>
          <dd className="text-lg mt-0.5">
            <Num n={out} />
          </dd>
          <dd className="text-gray-600 mt-1 leading-snug">{tertiaryDesc}</dd>
        </div>
        {(b.intersecao_ciclo_divergente ?? 0) > 0 && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <dt className="text-amber-900 font-medium">Mesma pessoa, ciclo divergente</dt>
            <dd className="text-lg mt-0.5">
              <Num n={b.intersecao_ciclo_divergente ?? 0} />
            </dd>
            <dd className="text-amber-800/90 mt-1 leading-snug">
              RGM/CPF coincide, mas o <strong>Ciclo</strong> da matrícula não bate com o da planilha — comum em
              rematrícula ou pendência de ciclo anterior. Não entram na fila de ativação desta campanha.
            </dd>
            {(b.na_outra_ciclo_divergente ?? 0) > 0 && (
              <dd className="text-[10px] text-amber-800/80 mt-1">
                Na planilha importada: {(b.na_outra_ciclo_divergente ?? 0).toLocaleString('pt-BR')} pessoa(s) só
                com esse tipo de match.
              </dd>
            )}
          </div>
        )}
      </dl>
    </CollapsibleBlock>
  );
}

interface Props {
  data: MatriculadosComparisonResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function MatriculadosComparisonPanel({ data, loading, error, onRefresh }: Props) {
  const [cicloFilter, setCicloFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
      if (raw) return JSON.parse(raw) as Record<string, boolean>;
    } catch {
      /* ignore */
    }
    return {};
  });

  const persistExpanded = useCallback((next: Record<string, boolean>) => {
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const toggleBlock = useCallback(
    (id: string) => {
      persistExpanded({ ...expanded, [id]: !expanded[id] });
    },
    [expanded, persistExpanded]
  );

  const availableCiclos = data?.available_ciclos ?? [];
  const byCiclo = data?.by_ciclo ?? {};

  const displayBlocks =
    cicloFilter !== 'all' && byCiclo[cicloFilter]
      ? byCiclo[cicloFilter].blocks
      : data?.comparisons ?? [];

  const visibleBlocks = displayBlocks.filter((b) => b.id !== 'processos-caa');

  useEffect(() => {
    if (!visibleBlocks.length) return;
    const ids = new Set(visibleBlocks.map((b) => b.id));
    const pruned = Object.fromEntries(Object.entries(expanded).filter(([k]) => ids.has(k)));
    if (Object.keys(pruned).length !== Object.keys(expanded).length) {
      persistExpanded(pruned);
    }
  }, [visibleBlocks, expanded, persistExpanded]);

  const expandAll = () => {
    const next: Record<string, boolean> = {};
    for (const b of visibleBlocks) next[b.id] = true;
    persistExpanded(next);
  };

  const collapseAll = () => persistExpanded({});

  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2 bg-gray-50/80">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Comparação com base em Matriculados</h3>
          <p className="text-xs text-gray-500 mt-0.5 max-w-3xl">
            Universo: último snapshot de matriculados. Cruzamento por RGM, CPF, e-mail ou telefone; quando as
            duas planilhas trazem <strong>Ciclo</strong>, o match exige o mesmo ciclo (evita confundir rematrícula
            com pendência antiga).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {availableCiclos.length > 1 && (
            <div className="flex items-center gap-2">
              <label htmlFor="ciclo-filter-comparison" className="text-xs text-gray-600 shrink-0">
                Ciclo:
              </label>
              <select
                id="ciclo-filter-comparison"
                value={cicloFilter}
                onChange={(e) => setCicloFilter(e.target.value)}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-whatsapp-400"
              >
                <option value="all">Todos</option>
                {availableCiclos.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              {cicloFilter !== 'all' && (
                <span className="text-xs text-gray-500">
                  Filtrado:{' '}
                  <strong className="text-gray-700">{cicloFilter}</strong>
                  <button
                    type="button"
                    onClick={() => setCicloFilter('all')}
                    className="ml-1 text-gray-400 hover:text-gray-600"
                    title="Limpar filtro de ciclo"
                  >
                    ×
                  </button>
                </span>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Recalcular painel
          </button>
          {visibleBlocks.length > 0 && (
            <>
              <button
                type="button"
                onClick={expandAll}
                className="px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900"
              >
                Expandir todas
              </button>
              <button
                type="button"
                onClick={collapseAll}
                className="px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900"
              >
                Recolher todas
              </button>
            </>
          )}
        </div>
      </div>

      <div className="p-4">
        {error && (
          <div className="mb-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700 px-3 py-2">
            {error}
          </div>
        )}
        {loading && !data && (
          <div className="text-sm text-gray-500 space-y-1">
            <p>
              Calculando comparações no servidor… A primeira vez costuma levar ~30–90 segundos
              (banco remoto + CAA filtrado). Os cards acima já podem aparecer antes deste painel.
            </p>
            <p className="text-xs text-gray-400">
              Não feche a página. Se aparecer erro de conexão, confira se o terminal do{' '}
              <code className="text-[11px]">npm run dev</code> não reiniciou no meio do cálculo.
            </p>
          </div>
        )}
        {data && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-4 text-xs text-gray-600">
              <span>
                Snapshot matrícula:{' '}
                <span className="font-medium text-gray-900">{data.matriculados_snapshot?.file_name}</span>
              </span>
              <span>
                Matriculados distintos: <Num n={data.matriculados_distintos} />
              </span>
              {data.matriculados_sem_chave > 0 && (
                <span className="text-amber-700">
                  Linhas sem chave: <Num n={data.matriculados_sem_chave} />
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {visibleBlocks.map((b) => (
                <BlockCard
                  key={b.id}
                  b={b}
                  byCiclo={cicloFilter === 'all' ? byCiclo : undefined}
                  availableCiclos={cicloFilter === 'all' ? availableCiclos : []}
                  expanded={Boolean(expanded[b.id])}
                  onToggle={() => toggleBlock(b.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
