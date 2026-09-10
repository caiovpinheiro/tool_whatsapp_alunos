import type { StudentDTO } from './studentApi';
import { fetchJson } from './httpJson';

export type ReportSlug =
  | 'matriculados'
  | 'docs-pendentes'
  | 'financeiro'
  | 'inadimplentes-vencidos'
  | 'inadimplentes-pos-siaa'
  | 'rematricula'
  | 'acessos-blackboard'
  | 'processos-caa'
  | 'provavel-evasao';

export type RematSubgrupoFilter = 'all' | 'adimplente' | 'inadimplente';

export interface RematriculaReportRow {
  nome: string;
  rgm: string;
  cpf: string;
  email: string;
  telefone: string;
  polo: string;
  curso: string;
  ciclo: string;
  instituicao: string;
  situacao_matricula: string;
  financeiro: string;
  remat_subgrupo: 'adimplente' | 'inadimplente';
  prior_activation_count: number;
  last_dispatch_at: string | null;
}

export interface RematriculaReportSummary {
  total_fila: number;
  adimplente: number;
  inadimplente: number;
  hint: string;
  warning: string | null;
  active_source: string | null;
  matriculados_snapshot: SnapshotMetaDto | null;
  remat_base: (SnapshotMetaDto & { source?: string }) | null;
}

export interface RematriculaReportResponse {
  summary: RematriculaReportSummary;
  subgrupo: RematSubgrupoFilter;
  total: number;
  total_fila: number;
  remat_subgrupo_counts: { adimplente: number; inadimplente: number };
  items: RematriculaReportRow[];
  offset: number;
  limit: number;
  generated_at: string;
}

export interface RematriculaDailyStat {
  stat_date: string;
  snapshot_id: string | null;
  source: string | null;
  total_em_curso: number;
  adimplente: number;
  inadimplente: number;
  pct_inadimplente: number | string | null;
  delta_total: number | null;
  delta_adimplente: number | null;
  delta_inadimplente: number | null;
  novos_inadimplentes: number | null;
  recuperados_financeiro: number | null;
  sairam_da_base: number | null;
  ativacoes_dia: number;
  captured_at: string;
}

export interface RematriculaTrackingResponse {
  live: {
    total: number;
    adimplente: number;
    inadimplente: number;
    pct_inadimplente: number;
  } | null;
  latest: RematriculaDailyStat | null;
  previous: RematriculaDailyStat | null;
  series: RematriculaDailyStat[];
  activations_series: { day: string; n: number }[];
  snapshot: (SnapshotMetaDto & { source?: string }) | null;
  upload_diff: {
    novos_inadimplentes: number;
    recuperados_financeiro: number;
    novos_na_base?: number;
    sairam_da_base: number;
    from_snapshot_at?: string;
  } | null;
  kpis: {
    total_em_curso: number;
    adimplente: number;
    inadimplente: number;
    pct_inadimplente: number;
    delta_total: number | null;
    delta_inadimplente: number | null;
    delta_adimplente: number | null;
    ativacoes_hoje: number;
    ativacoes_periodo: number;
    novos_inadimplentes: number;
    recuperados: number;
    rematriculas_acumuladas: number;
    rematriculas_hoje: number;
    rematriculas_periodo: number;
    rematriculas_ciclo: string;
  };
  matriculados_snapshot: (SnapshotMetaDto & { source?: string }) | null;
  focus_date?: string | null;
  focus_found?: boolean | null;
  filter?: { days: number | null; from: string | null; to: string | null };
  generated_at: string;
}

export interface ReportOverviewResponse {
  counts: Record<ReportSlug, number>;
  /** Ex.: CAA — "12.172 de 150.002 linhas no arquivo" */
  count_hints?: Partial<Record<ReportSlug, string>>;
}

export interface ReportListResponse {
  students: StudentDTO[];
  total: number;
  type: ReportSlug;
}

export interface SnapshotMetaDto {
  id: string;
  file_name: string;
  row_count: number;
  created_at: string;
}

export interface MatriculadosComparisonBlock {
  id: Exclude<ReportSlug, 'matriculados'>;
  title: string;
  mode: 'other_is_problem_list' | 'other_is_coverage_list' | 'other_is_process_list';
  missing_other: boolean;
  matriculados_snapshot: SnapshotMetaDto | null;
  other_snapshot: SnapshotMetaDto | null;
  matriculados_rows?: number;
  matriculados_distintos: number;
  matriculados_sem_chave: number;
  na_outra_rows?: number;
  /** Total de linhas no arquivo antes do filtro (ex.: CAA só cancelamento). */
  na_outra_rows_total?: number;
  na_outra_filtro?: string;
  na_outra_distintos: number;
  na_outra_sem_chave?: number;
  intersecao: number;
  /** Mesmo RGM/CPF etc., mas ciclo diferente (possível rematrícula ou linha antiga). */
  intersecao_ciclo_divergente?: number;
  matriculados_match_identidade_ciclo_antigo?: number;
  matriculados_sem_intersecao: number;
  na_outra_sem_matricula: number;
  na_outra_ciclo_divergente?: number;
}

export interface MatriculadosComparisonByCiclo {
  blocks: MatriculadosComparisonBlock[];
}

export interface MatriculadosComparisonResponse {
  matriculados_snapshot: SnapshotMetaDto | null;
  matriculados_distintos: number;
  matriculados_sem_chave: number;
  comparisons: MatriculadosComparisonBlock[];
  by_ciclo?: Record<string, MatriculadosComparisonByCiclo>;
  available_ciclos?: string[];
  cached_at?: string;
}

export type MatriculadosComparisonResult =
  | MatriculadosComparisonResponse
  | { building: true };

export function isComparisonBuilding(
  r: MatriculadosComparisonResult
): r is { building: true } {
  return 'building' in r && r.building === true;
}

function qs(filters: { term_id?: string; polo?: string }) {
  const p = new URLSearchParams();
  if (filters.term_id) p.set('term_id', filters.term_id);
  if (filters.polo) p.set('polo', filters.polo);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const reportApi = {
  overview(filters: { term_id?: string; polo?: string } = {}) {
    return fetchJson<ReportOverviewResponse>(`/api/reports/overview${qs(filters)}`, {
      timeoutMs: 180_000,
      timeoutMessage:
        'O resumo dos cards demorou demais (a contagem CAA pode levar 1–2 min na primeira vez). Clique em Atualizar ou aguarde o backend terminar o pré-aquecimento no terminal.',
    });
  },

  async matriculadosComparison(): Promise<MatriculadosComparisonResult> {
    const timeoutMs = 120_000;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('/api/reports/matriculados-comparison', {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const text = await response.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (response.status === 202) {
        return { building: true };
      }
      if (!response.ok) {
        const message =
          (data as { error?: string })?.error ||
          `Requisição falhou (${response.status})`;
        throw new Error(message);
      }
      return data as MatriculadosComparisonResponse;
    } finally {
      window.clearTimeout(timer);
    }
  },

  overviewInvalidate() {
    return fetchJson<{ ok: boolean }>('/api/reports/overview/invalidate', {
      method: 'POST',
      timeoutMs: 15_000,
    });
  },

  matriculadosComparisonInvalidate() {
    return fetchJson<{ ok: boolean }>('/api/reports/matriculados-comparison/invalidate', {
      method: 'POST',
      timeoutMs: 15_000,
    });
  },

  matriculadosComparisonStatus() {
    return fetchJson<{
      ready: boolean;
      building: boolean;
      cached_at: string | null;
    }>('/api/reports/matriculados-comparison/status', { timeoutMs: 15_000 });
  },

  list(
    type: Exclude<ReportSlug, 'rematricula'>,
    filters: { term_id?: string; polo?: string; limit?: number; offset?: number } = {}
  ) {
    const p = new URLSearchParams();
    if (filters.term_id) p.set('term_id', filters.term_id);
    if (filters.polo) p.set('polo', filters.polo);
    if (filters.limit != null) p.set('limit', String(filters.limit));
    if (filters.offset != null) p.set('offset', String(filters.offset));
    const q = p.toString();
    return fetchJson<ReportListResponse>(`/api/reports/${type}${q ? `?${q}` : ''}`, {
      timeoutMs: 180_000,
    });
  },

  rematricula(filters: {
    subgrupo?: RematSubgrupoFilter;
    limit?: number;
    offset?: number;
  } = {}) {
    const p = new URLSearchParams();
    if (filters.subgrupo && filters.subgrupo !== 'all') p.set('subgrupo', filters.subgrupo);
    if (filters.limit != null) p.set('limit', String(filters.limit));
    if (filters.offset != null) p.set('offset', String(filters.offset));
    const q = p.toString();
    return fetchJson<RematriculaReportResponse>(`/api/reports/rematricula${q ? `?${q}` : ''}`, {
      timeoutMs: 180_000,
    });
  },

  rematriculaTracking(opts: {
    days?: number;
    capture?: boolean;
    date?: string;
    from?: string;
    to?: string;
  } = {}) {
    const p = new URLSearchParams();
    if (opts.days != null) p.set('days', String(opts.days));
    if (opts.capture) p.set('capture', '1');
    if (opts.date) p.set('date', opts.date);
    if (opts.from) p.set('from', opts.from);
    if (opts.to) p.set('to', opts.to);
    const q = p.toString();
    return fetchJson<RematriculaTrackingResponse>(
      `/api/reports/rematricula/tracking${q ? `?${q}` : ''}`,
      { timeoutMs: 120_000 }
    );
  },

  caaSummary(opts: { scope?: 'last_snapshot' | 'hours'; hours?: number; ciclo?: string } = {}) {
    const p = new URLSearchParams();
    const scope = opts.scope || 'last_snapshot';
    p.set('scope', scope);
    if (scope === 'hours' && opts.hours) p.set('hours', String(opts.hours));
    if (opts.ciclo) p.set('ciclo', opts.ciclo);
    return fetchJson<CaaSummaryResponse>(`/api/reports/caa/summary?${p.toString()}`, {
      timeoutMs: 30_000,
    });
  },

  caaTransitions(
    opts: {
      scope?: 'last_snapshot' | 'hours';
      hours?: number;
      to_status?: CaaStatus[];
      limit?: number;
      current_status?: CaaStatus;
    } = {}
  ) {
    const p = new URLSearchParams();
    const scope = opts.scope || 'last_snapshot';
    p.set('scope', scope);
    if (scope === 'hours' && opts.hours) p.set('hours', String(opts.hours));
    if (opts.to_status?.length) p.set('to_status', opts.to_status.join(','));
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.current_status) p.set('current_status', opts.current_status);
    return fetchJson<CaaTransitionsResponse>(`/api/reports/caa/transitions?${p.toString()}`, {
      timeoutMs: 30_000,
    });
  },

  caaFunnel(
    params: {
      estado?: CaaFunnelEstado;
      engajado?: boolean;
      conflito?: boolean;
      limit?: number;
      offset?: number;
      ciclo?: string;
    } = {}
  ) {
    const p = new URLSearchParams();
    if (params.estado) p.set('estado', params.estado);
    if (params.engajado !== undefined) p.set('engajado', String(params.engajado));
    if (params.conflito) p.set('conflito', 'true');
    if (params.limit != null) p.set('limit', String(params.limit));
    if (params.offset != null) p.set('offset', String(params.offset));
    if (params.ciclo) p.set('ciclo', params.ciclo);
    const q = p.toString();
    return fetchJson<CaaFunnelResponse>(`/api/reports/caa/funnel${q ? `?${q}` : ''}`, {
      timeoutMs: 30_000,
    });
  },

  activationConversion(
    params: { category?: string; period_days?: number; offset?: number; ciclo?: string; from?: string | null; to?: string | null } = {}
  ) {
    const p = new URLSearchParams();
    if (params.category) p.set('category', params.category);
    if (params.period_days != null) p.set('period_days', String(params.period_days));
    if (params.offset != null) p.set('offset', String(params.offset));
    if (params.ciclo) p.set('ciclo', params.ciclo);
    if (params.from) p.set('from', params.from);
    if (params.to) p.set('to', params.to);
    const q = p.toString();
    return fetchJson<ActivationConversionResponse>(
      `/api/reports/activation-conversion${q ? `?${q}` : ''}`,
      { timeoutMs: 30_000 }
    );
  },
};

// --- Activation Conversion ---

export interface ActivationConversionKpis {
  total_dispatches: number;
  unique_dispatched: number;
  unique_responders: number;
  unique_clickers: number;
  unique_messages: number;
  unique_opt_outs: number;
  unique_reverted: number;
  response_rate: number;
  opt_out_rate: number;
}

export type ActivationConversionKpisByCiclo = Record<string, ActivationConversionKpis>;

export interface ActivationConversionByCategoryItem {
  category: string;
  label: string;
  total_dispatches: number;
  unique_dispatched: number;
  unique_responders: number;
  unique_opt_outs: number;
  unique_reverted: number;
  response_rate: number;
  opt_out_rate: number;
}

export interface ActivationConversionTopButton {
  button_payload: string;
  count: number;
}

export interface ActivationConversionRecentResponse {
  id: string;
  category: string;
  master_key: string | null;
  rgm: string | null;
  nome: string | null;
  response_kind: 'click' | 'message' | 'opt_out' | 'other';
  button_payload: string | null;
  message_text: string | null;
  received_at: string | null;
}

export interface ActivationConversionResponse {
  filters: {
    category: string;
    period_days: number;
    since: string;
    until?: string | null;
    now: string;
    ciclo?: string | null;
  };
  kpis: ActivationConversionKpis;
  kpis_by_ciclo?: ActivationConversionKpisByCiclo;
  available_ciclos?: string[];
  by_category: ActivationConversionByCategoryItem[];
  top_buttons: ActivationConversionTopButton[];
  recent_responses: ActivationConversionRecentResponse[];
  total_recent: number;
  limit: number;
  offset: number;
  generated_at: string;
}

export type CaaStatus = 'open' | 'lost_canceled' | 'lost_confirmed' | 'won_reverted' | 'unknown';

export type CaaFunnelEstado =
  | 'ativavel'
  | 'perdido_silencioso'
  | 'revertido_manual'
  | 'perdido_manual'
  | 'revertido_export'
  | 'perdido_export'
  | 'unknown';

export interface CaaFunnelManualOutcome {
  outcome: 'revertido' | 'confirmado' | 'sem_contato' | 'outro';
  occurred_at: string | null;
  consultor_nome: string | null;
  motivo: string | null;
}

export interface CaaFunnelItem {
  protocolo: string;
  rgm: string | null;
  nome: string | null;
  polo: string | null;
  curso: string | null;
  data_chegada: string | null;
  first_seen_at: string | null;
  t0_at: string | null;
  expires_at: string | null;
  horas_restantes: number | null;
  status_export: CaaStatus;
  manual_outcome: CaaFunnelManualOutcome | null;
  estado: CaaFunnelEstado;
  engajado: boolean;
  conflito: boolean;
  dispatches_total: number;
  dispatches_today: number;
  last_response_at: string | null;
  last_response_kind: string | null;
}

export interface CaaFunnelCounts {
  ativavel: number;
  perdido_silencioso: number;
  revertido_manual: number;
  perdido_manual: number;
  revertido_export: number;
  perdido_export: number;
  unknown: number;
  total_no_funil: number;
  engajados: number;
  com_conflito: number;
}

export interface CaaFunnelResponse {
  config: {
    janela_t0: string;
    janela_dias_tipo: string;
    cap_diario: number;
    cap_total: number;
    now: string;
  };
  counts: CaaFunnelCounts;
  counts_by_ciclo?: Record<string, CaaFunnelCounts>;
  available_ciclos?: string[];
  items: CaaFunnelItem[];
  total_items: number;
  limit: number;
  offset: number;
  generated_at: string;
}

export interface CaaSnapshotInfo {
  id: string;
  file_name: string;
  row_count: number;
  created_at: string;
}

export interface CaaSummaryTransitions {
  novos_pendentes: number;
  novos_pendentes_no_diff?: number;
  perdidos_canceled: number;
  perdidos_confirmed: number;
  revertidos: number;
}

export interface CaaSummaryResponse {
  scope: 'last_snapshot' | 'hours';
  window_hours: number | null;
  since: string | null;
  snapshot: CaaSnapshotInfo | null;
  previous_snapshot?: CaaSnapshotInfo | null;
  needs_previous?: boolean;
  identical_reimport?: boolean;
  used_stored_fallback?: boolean;
  transitions: CaaSummaryTransitions;
  current: Record<CaaStatus, number>;
  labels: Record<Exclude<CaaStatus, 'unknown'>, string>;
  available_ciclos?: string[];
  summary_by_ciclo?: Record<string, { transitions: CaaSummaryTransitions }>;
}

export interface CaaTransitionItem {
  protocolo: string;
  rgm: string | null;
  from_status: CaaStatus | null;
  to_status: CaaStatus;
  current_status: CaaStatus | null;
  changed_at: string;
  nome: string | null;
  email: string | null;
  telefone: string | null;
  polo: string | null;
  curso: string | null;
  subprocesso: string | null;
  data_chegada: string | null;
  data_previsao: string | null;
  data_conclusao: string | null;
  situacao_atendimento_raw: string | null;
  situacao_deferimento_raw: string | null;
  /** Aba pendentes: ainda na fila de ativação (não só diff D+1). */
  em_fila_ativacao?: boolean;
}

export interface CaaTransitionsResponse {
  scope: 'last_snapshot' | 'hours';
  since: string | null;
  snapshot: CaaSnapshotInfo | null;
  previous_snapshot?: CaaSnapshotInfo | null;
  needs_previous?: boolean;
  identical_reimport?: boolean;
  used_stored_fallback?: boolean;
  total: number;
  items: CaaTransitionItem[];
}
