import { apiAuthHeaders } from './apiAuth';

export interface CleanStaleOrigemAtivacaoResponse {
  scanned: number;
  from_log?: number;
  from_dispatch_only?: number;
  cleaned: number;
  failed: number;
  errors: Array<{ lead_id: string; error: string }>;
  stale_window_hours: number;
  crm_rate_per_second: number;
  dry_run: boolean;
  ran_at: string;
}

export interface CleanStaleActivationTagsResponse {
  scanned: number;
  cleaned: number;
  failed: number;
  errors: Array<{ contact_id: string; tag_name: string; error: string }>;
  stale_window_hours: number;
  dry_run: boolean;
  skipped_no_config?: boolean;
  ran_at: string;
}

export interface SyncCrmDesfechosResponse {
  scanned: number;
  synced_revertido: number;
  synced_confirmado: number;
  ignored: number;
  failed: number;
  errors: Array<{ lead_id: string; error: string }>;
  lookback_days: number;
  dry_run: boolean;
  ran_at: string;
  crm_rate_per_second: number;
  skipped_no_config?: boolean;
}

export interface DatacrazyCacheSyncLastRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  pages: number;
  leads_seen: number;
  leads_upserted: number;
  leads_skipped: number;
  status: string;
  error_message: string | null;
}

export interface DatacrazyCacheStatusResponse {
  ok: boolean;
  cache_count: number;
  running: boolean;
  running_since: string | null;
  last_sync: DatacrazyCacheSyncLastRun | null;
}

export interface SyncDatacrazyCacheResponse {
  logId: string;
  pages: number;
  leadsSeen: number;
  upserted: number;
  skipped: number;
  durationMs: number;
  dry_run: boolean;
}

export interface StartDatacrazyCacheSyncResponse {
  ok: boolean;
  status: 'running';
  dry_run: boolean;
}

export interface NovoCrmCacheRunningSync {
  id: string;
  mode: 'full' | 'incremental';
  started_at: string;
  contacts_total: number | null;
  contacts_seen: number | null;
  cache_upserted: number | null;
  batches_scanned: number | null;
  progress_updated_at: string | null;
}

export interface NovoCrmCacheLastSync {
  id: string;
  mode: 'full' | 'incremental';
  started_at: string;
  finished_at: string | null;
  contacts_total: number | null;
  contacts_seen: number;
  cache_upserted: number;
  cache_skipped: number;
  contacts_deleted: number;
  data_loss_events: number;
  status: string;
  error_message: string | null;
}

export interface NovoCrmFlagsLastSync {
  finished_at?: string | null;
  ok?: boolean;
  mode?: string;
  dry_run?: boolean;
  phase?: string | null;
  scanned?: number;
  matched?: number;
  flags_updated?: number;
  flags_queued?: number;
  fields_updated?: number;
  stages_moved?: number;
  stages_queued?: number;
  stages_skipped_untouchable?: number;
  write_queue?: number;
  errors?: number;
  aborted?: boolean;
  cancelled?: boolean;
  abort_reason?: string | null;
  matriculados_snapshot_id?: string | null;
}

export interface NovoCrmOrphanDedupeLastRun {
  finished_at?: string | null;
  ok?: boolean;
  cancelled?: boolean;
  dry_run?: boolean;
  status?: string;
  scope?: string;
  orphans_total?: number;
  orphans_scanned?: number;
  would_create?: number;
  deals_would_create_on_orphan?: number;
  deals_would_create_on_sibling?: number;
  skipped_already_has_deal_live?: number;
  incomplete_total?: number;
  incomplete_enriched?: number;
  incomplete_scanned?: number;
  dup_to_perdido?: number;
  deals_would_move_perdido?: number;
  deals_moved_perdido?: number;
  dup_deal_groups?: number;
  dup_deals_would_move_perdido?: number;
  dup_deals_moved_perdido?: number;
  created_deals?: number;
  orphan_no_match?: number;
  errors?: number;
  deal_not_found?: number;
  warmed_cache?: number;
  error?: string | null;
  tag_name?: string;
  tags_applied?: number;
  tags_failed?: number;
}

export interface NovoCrmFlagsRunningJob {
  jobId: string;
  mode?: string;
  status: string;
  dry_run?: boolean;
  total: number;
  processed: number;
  sent: number;
  matched?: number;
  flags_updated?: number;
  fields_updated?: number;
  stages_moved?: number;
  eta_ms?: number | null;
  phase: string | null;
  status_message: string | null;
  started_at: string;
  cancel_requested?: boolean;
}

export interface NovoCrmOrphanDedupeRunningJob {
  jobId: string;
  status: string;
  dry_run?: boolean;
  total: number;
  processed: number;
  sent: number;
  failed?: number;
  eta_ms?: number | null;
  phase: string | null;
  status_message: string | null;
  started_at: string;
  cancel_requested?: boolean;
  orphans_total?: number;
  orphans_processed?: number;
  incomplete_total?: number;
  incomplete_processed?: number;
  dup_groups?: number;
  dup_groups_processed?: number;
  already_has_deal?: number;
  would_create?: number;
  live_ok?: number;
  deal_not_found?: number;
  errors?: number;
}

export interface NovoCrmCacheLiveJob {
  phase?: string | null;
  status_message?: string | null;
  contacts_total?: number | null;
  contacts_seen?: number;
  cache_upserted?: number;
  deals_page?: number;
  deals_total_pages?: number | null;
  deals_seen?: number;
  deals_total?: number;
  started_at?: string;
}

export interface NovoCrmNightCronStatus {
  cache_enabled: boolean;
  cache_source: string;
  cache_full_hour_utc: number;
  cache_next_ms: number | null;
  fetch_deal_fields: boolean;
  fields_enabled: boolean;
  fields_hour_utc: number;
  fields_next_ms: number | null;
  flags_enabled: boolean;
  provision_enabled: boolean;
  api_configured: boolean;
}

export interface NovoCrmCacheStatusResponse {
  ok: boolean;
  cache_total: number;
  cache_active: number;
  missing_cpf: number;
  missing_rgm: number;
  incomplete_fields: number;
  running: boolean;
  running_sync: NovoCrmCacheRunningSync | null;
  running_cache?: NovoCrmCacheLiveJob | null;
  night_cron?: NovoCrmNightCronStatus | null;
  last_sync: NovoCrmCacheLastSync | null;
  last_flags_sync?: NovoCrmFlagsLastSync | null;
  last_fields_sync?: NovoCrmFlagsLastSync | null;
  last_orphan_dedupe?: NovoCrmOrphanDedupeLastRun | null;
  running_flags?: NovoCrmFlagsRunningJob | null;
  running_orphan_dedupe?: NovoCrmOrphanDedupeRunningJob | null;
  running_provision?: {
    jobId: string;
    mode?: string;
    status: string;
    dry_run?: boolean;
    total?: number;
    processed?: number;
    sent?: number;
    failed?: number;
    phase: string | null;
    status_message: string | null;
    started_at: string;
    cancel_requested?: boolean;
  } | null;
  state: { cursor_updated_at: string | null } | null;
  open_data_loss_events: number;
}

export interface StartNovoCrmCacheSyncResponse {
  ok: boolean;
  status: 'running';
  mode: 'full' | 'incremental';
  dry_run: boolean;
}

export type NovoCrmEnrichScope = 'cpf' | 'rgm' | 'incomplete' | 'all_mapped';

export interface NovoCrmEnrichPreviewResponse {
  ok: boolean;
  dry_run: boolean;
  scope: NovoCrmEnrichScope | string;
  matriculados_snapshot_id: string;
  matriculados_file: string | null;
  matriculados_rows: number | null;
  index: { by_cpf: number; by_rgm: number; by_phone: number };
  candidates: number;
  matched: number;
  no_match: number;
  would_update: number;
  skipped_no_fill: number;
  updated: number;
  errors: number;
  would_fill_by_field: Record<string, number>;
  sample: Array<{
    contact_id: string;
    deal_id: string | null;
    nome: string | null;
    fields: string[];
    contact_patch: string[];
  }>;
  error_samples: Array<{ contact_id: string; error: string }>;
}

export interface NovoCrmEnrichStartResponse {
  ok: boolean;
  status: 'running';
  jobId: string;
  scope: string;
  dry_run: boolean;
}

export interface NovoCrmEnrichJobStatusResponse {
  ok: boolean;
  running: boolean;
  job: {
    jobId: string;
    scope: string;
    status: string;
    dry_run: boolean;
    total: number;
    processed: number;
    sent: number;
    failed: number;
    skipped: number;
    phase: string | null;
    status_message: string | null;
    started_at: string;
    finished_at: string | null;
    error: string | null;
    result: NovoCrmEnrichPreviewResponse | null;
  } | null;
}

export type NovoCrmFlagsStageMode = 'flags_stage' | 'fields' | 'both';

export interface NovoCrmFlagsStagePreviewResponse {
  ok: boolean;
  dry_run: boolean;
  mode: NovoCrmFlagsStageMode | string;
  phase?: string;
  scanned: number;
  matched: number;
  flags_updated: number;
  flags_queued?: number;
  fields_updated: number;
  stages_moved: number;
  stages_queued?: number;
  stages_skipped_untouchable: number;
  skipped_no_match: number;
  skipped_no_deal: number;
  write_queue?: number;
  cancelled?: boolean;
  abort_reason?: string | null;
  errors: number;
  samples: Array<{
    dealId?: string;
    cpf?: string;
    rgm?: string;
    from?: string | null;
    to?: string;
    move?: boolean;
    moved?: boolean;
    untouchable?: boolean;
    flags?: Record<string, boolean>;
  }>;
  error_samples: Array<{ dealId?: string; cpf?: string; error: string }>;
}

export interface NovoCrmFlagsStageStartResponse {
  ok: boolean;
  status: 'running';
  jobId: string;
  dry_run: boolean;
  mode: string;
}

export interface NovoCrmFlagsStageJobStatusResponse {
  ok: boolean;
  running: boolean;
  job: {
    jobId: string;
    mode: string;
    status: string;
    dry_run: boolean;
    total: number;
    processed: number;
    sent: number;
    matched?: number;
    flags_updated?: number;
    fields_updated?: number;
    stages_moved?: number;
    eta_ms?: number | null;
    phase: string | null;
    status_message: string | null;
    started_at: string;
    finished_at: string | null;
    cancel_requested?: boolean;
    error: string | null;
    result: NovoCrmFlagsStagePreviewResponse | null;
  } | null;
}

export type NovoCrmProvisionMode = 'new' | 'all';

export interface NovoCrmProvisionPreviewResponse {
  ok: boolean;
  dry_run: boolean;
  mode: NovoCrmProvisionMode | string;
  scanned: number;
  processed_people?: number;
  created_contacts: number;
  created_deals: number;
  updated_existing?: number;
  skipped_existing: number;
  skipped_cache: number;
  /** Pulados porque o RGM já existe no espelho (CPF do espelho pode estar corrompido). */
  skipped_cache_rgm?: number;
  skipped_cache_email?: number;
  skipped_cache_phone?: number;
  cancelled?: boolean;
  skipped_not_delta?: number;
  skipped_no_cpf: number;
  skipped_bad_name?: number;
  matched_by_cpf?: number;
  matched_by_phone?: number;
  matched_by_email?: number;
  search_fuzzy_rejected?: number;
  warmed_cache?: number;
  warm_cache_errors?: number;
  errors: number;
  max_creates: number;
  prior_snapshot_id?: string | null;
  matriculados_snapshot_id?: string;
  samples: Array<{
    cpf?: string;
    nome?: string;
    reused_contact?: boolean;
    existing_contact_id?: string;
    action?: 'sync_only' | 'would_create';
    deals?: Array<{ rgm?: string; stage?: string }>;
  }>;
  /** Dry-run: todas as linhas que seriam criadas (CSV). */
  to_create?: Array<{
    nome?: string;
    cpf?: string;
    rgm?: string;
    tipo?: string;
    curso?: string;
    polo?: string;
    ciclo?: string;
    situacao?: string;
    etapa?: string;
    email?: string;
    telefone?: string;
  }>;
  to_create_count?: number;
  error_samples: Array<{ cpf?: string; error: string }>;
}

export interface NovoCrmProvisionStartResponse {
  ok: boolean;
  status: 'running';
  jobId: string;
  dry_run: boolean;
  mode: string;
  max_creates: number | null;
}

export interface NovoCrmProvisionJobStatusResponse {
  ok: boolean;
  running: boolean;
  job: {
    jobId: string;
    mode: string;
    status: string;
    dry_run: boolean;
    total: number;
    processed: number;
    sent: number;
    failed: number;
    phase: string | null;
    status_message: string | null;
    started_at: string;
    finished_at: string | null;
    cancel_requested?: boolean;
    error: string | null;
    result: NovoCrmProvisionPreviewResponse | null;
  } | null;
}

export interface NovoCrmRegressionEvent {
  id: string | number;
  contact_id?: string;
  detected_at?: string;
  removed_paths?: unknown;
  acknowledged_at?: string | null;
}

export interface NovoCrmRegressionsResponse {
  ok: boolean;
  events: NovoCrmRegressionEvent[];
}

export interface OrphanDedupePreviewResponse {
  ok: boolean;
  dry_run: boolean;
  cancelled?: boolean;
  scope: string;
  matriculados_snapshot_id: string;
  matriculados_file: string | null;
  index: { by_email: number; by_phone: number };
  cache_total: number;
  orphans_total: number;
  orphans_scanned: number;
  orphan_aluno: number;
  orphan_no_match: number;
  matched_email: number;
  matched_phone: number;
  dup_contact_skip: number;
  dup_skip_no_deal: number;
  dup_to_perdido: number;
  deals_would_create_on_orphan: number;
  deals_would_create_on_sibling: number;
  deals_would_move_perdido?: number;
  deals_moved_perdido?: number;
  incomplete_total: number;
  incomplete_scanned: number;
  incomplete_no_match: number;
  incomplete_enriched: number;
  incomplete_ambiguous?: number;
  incomplete_name_mismatch?: number;
  incomplete_live_already_ok?: number;
  incomplete_live_conflict?: number;
  incomplete_live_unknown?: number;
  perdido_skipped_live?: number;
  perdido_live_unknown?: number;
  dup_deal_groups?: number;
  dup_deals_extra?: number;
  dup_cross_contact?: number;
  dup_resolved_live?: number;
  dup_live_unknown?: number;
  dup_stopped_at_max?: boolean;
  dup_deals_would_move_perdido?: number;
  dup_deals_moved_perdido?: number;
  created_deals: number;
  errors: number;
  tag_name?: string;
  tags_applied?: number;
  tags_failed?: number;
  skipped_already_has_deal_live?: number;
  warmed_cache?: number;
  warm_cache_errors?: number;
  stopped_at_max: boolean;
  samples: unknown[];
}

export interface OrphanDedupeStartResponse {
  ok: boolean;
  status: 'running';
  jobId: string;
  dry_run: boolean;
  scope: string;
  max_creates: number | null;
}

export interface OrphanDedupeJobStatusResponse {
  ok: boolean;
  running: boolean;
  job: {
    jobId: string;
    status: string;
    dry_run: boolean;
    total: number;
    processed: number;
    sent: number;
    failed: number;
    eta_ms?: number | null;
    phase: string | null;
    status_message: string | null;
    started_at: string;
    finished_at: string | null;
    cancel_requested?: boolean;
    orphans_total?: number;
    orphans_processed?: number;
    incomplete_total?: number;
    incomplete_processed?: number;
    dup_groups?: number;
    dup_groups_processed?: number;
    already_has_deal?: number;
    would_create?: number;
    live_ok?: number;
    deal_not_found?: number;
    errors?: number;
    error: string | null;
    result: OrphanDedupePreviewResponse | null;
  } | null;
}

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...apiAuthHeaders(),
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const payload = data as { error?: string; jobId?: string };
    const err = new Error(payload?.error || `Requisição falhou (${response.status})`) as Error & {
      status?: number;
      jobId?: string;
    };
    err.status = response.status;
    if (payload?.jobId) err.jobId = payload.jobId;
    throw err;
  }
  return data as T;
}

export const maintenanceApi = {
  cleanStaleOrigemAtivacao(opts?: { dryRun?: boolean }) {
    const qs = opts?.dryRun ? '?dry_run=true' : '';
    return jsonFetch<CleanStaleOrigemAtivacaoResponse>(
      `/api/maintenance/clean-stale-origem-ativacao${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  cleanStaleActivationTags(opts?: { dryRun?: boolean }) {
    const qs = opts?.dryRun ? '?dry_run=true' : '';
    return jsonFetch<CleanStaleActivationTagsResponse>(
      `/api/maintenance/clean-stale-activation-tags${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  syncCrmDesfechos(opts?: { dryRun?: boolean; days?: number }) {
    const params = new URLSearchParams();
    if (opts?.dryRun) params.set('dry_run', 'true');
    if (opts?.days != null) params.set('days', String(opts.days));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return jsonFetch<SyncCrmDesfechosResponse>(
      `/api/maintenance/sync-crm-desfechos${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  getDatacrazyCacheStatus() {
    return jsonFetch<DatacrazyCacheStatusResponse>('/api/maintenance/datacrazy-cache-status');
  },

  /** Sync em background — retorna 202; acompanhe com getDatacrazyCacheStatus(). */
  startDatacrazyCacheSync(opts?: { dryRun?: boolean }) {
    const qs = opts?.dryRun ? '?async=1&dryRun=1' : '?async=1';
    return jsonFetch<StartDatacrazyCacheSyncResponse>(
      `/api/maintenance/sync-datacrazy-cache${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Sync bloqueante (uso em scripts; pode levar vários minutos). */
  syncDatacrazyCacheBlocking(opts?: { dryRun?: boolean }) {
    const qs = opts?.dryRun ? '?dryRun=1' : '';
    return jsonFetch<SyncDatacrazyCacheResponse>(
      `/api/maintenance/sync-datacrazy-cache${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  getNovoCrmCacheStatus() {
    return jsonFetch<NovoCrmCacheStatusResponse>('/api/maintenance/novo-crm-cache-status');
  },

  /** Sync do espelho Novo CRM em background — retorna 202; acompanhe com getNovoCrmCacheStatus(). */
  startNovoCrmCacheSync(opts?: { mode?: 'full' | 'incremental' }) {
    const params = new URLSearchParams({ async: '1', mode: opts?.mode || 'full' });
    return jsonFetch<StartNovoCrmCacheSyncResponse>(
      `/api/maintenance/sync-novo-crm-cache?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  previewNovoCrmEnrich(scope: NovoCrmEnrichScope) {
    const params = new URLSearchParams({ scope, dry_run: '1' });
    return jsonFetch<NovoCrmEnrichPreviewResponse>(
      `/api/maintenance/enrich-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  startNovoCrmEnrichApply(scope: NovoCrmEnrichScope) {
    const params = new URLSearchParams({ scope, dry_run: '0', async: '1' });
    return jsonFetch<NovoCrmEnrichStartResponse>(
      `/api/maintenance/enrich-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  getNovoCrmEnrichStatus(jobId?: string) {
    const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
    return jsonFetch<NovoCrmEnrichJobStatusResponse>(
      `/api/maintenance/enrich-novo-crm-status${qs}`
    );
  },

  listNovoCrmRegressions(opts?: { limit?: number }) {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString() ? `?${params}` : '';
    return jsonFetch<NovoCrmRegressionsResponse>(
      `/api/maintenance/novo-crm-cache-regressions${qs}`
    );
  },

  ackNovoCrmRegression(id: string | number) {
    return jsonFetch<{ ok: boolean; event: NovoCrmRegressionEvent }>(
      `/api/maintenance/novo-crm-cache-regressions/${encodeURIComponent(String(id))}/ack`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Prévia: flags + etapas (dry_run). */
  previewNovoCrmFlagsStage(opts?: { mode?: 'flags_stage' | 'fields' | 'both'; max?: number }) {
    const params = new URLSearchParams({
      dry_run: '1',
      mode: opts?.mode || 'flags_stage',
    });
    if (opts?.max != null) params.set('max', String(opts.max));
    return jsonFetch<NovoCrmFlagsStagePreviewResponse>(
      `/api/maintenance/sync-flags-stage-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Aplica flags + etapas em background. */
  startNovoCrmFlagsStage(opts?: { mode?: 'flags_stage' | 'fields' | 'both'; max?: number }) {
    const params = new URLSearchParams({
      dry_run: '0',
      async: '1',
      mode: opts?.mode || 'flags_stage',
    });
    if (opts?.max != null) params.set('max', String(opts.max));
    return jsonFetch<NovoCrmFlagsStageStartResponse>(
      `/api/maintenance/sync-flags-stage-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  getNovoCrmFlagsStageStatus(jobId?: string) {
    const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
    return jsonFetch<NovoCrmFlagsStageJobStatusResponse>(
      `/api/maintenance/sync-flags-stage-novo-crm-status${qs}`
    );
  },

  /** Pede cancel do Att de etapas em andamento. */
  stopNovoCrmFlagsStage(jobId?: string) {
    const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
    return jsonFetch<{ ok: boolean; status: string; jobId?: string }>(
      `/api/maintenance/sync-flags-stage-novo-crm-stop${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Pede cancel do Full Sync do espelho. */
  stopNovoCrmCacheSync() {
    return jsonFetch<{ ok: boolean; status: string }>(
      `/api/maintenance/sync-novo-crm-cache-stop`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Prévia: criação de leads novos (mode=new) ou backlog (mode=all). */
  previewNovoCrmProvision(opts?: { mode?: NovoCrmProvisionMode; max?: number }) {
    const params = new URLSearchParams({
      dry_run: '1',
      mode: opts?.mode || 'new',
    });
    if (opts?.max != null) params.set('max', String(opts.max));
    return jsonFetch<NovoCrmProvisionPreviewResponse>(
      `/api/maintenance/provision-matriculados-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Inicia prévia com verificação live no CRM e warm cirúrgico do espelho. */
  startNovoCrmProvisionPreview(opts?: { mode?: NovoCrmProvisionMode; max?: number }) {
    const params = new URLSearchParams({
      dry_run: '1',
      async: '1',
      mode: opts?.mode || 'new',
    });
    if (opts?.max != null) params.set('max', String(opts.max));
    return jsonFetch<NovoCrmProvisionStartResponse>(
      `/api/maintenance/provision-matriculados-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Aplica criação de leads (async). Default mode=new (só ausentes do cache). */
  startNovoCrmProvision(opts?: { mode?: NovoCrmProvisionMode; max?: number }) {
    const params = new URLSearchParams({
      dry_run: '0',
      async: '1',
      mode: opts?.mode || 'new',
    });
    if (opts?.max != null) params.set('max', String(opts.max));
    return jsonFetch<NovoCrmProvisionStartResponse>(
      `/api/maintenance/provision-matriculados-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  getNovoCrmProvisionStatus(jobId?: string) {
    const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
    return jsonFetch<NovoCrmProvisionJobStatusResponse>(
      `/api/maintenance/provision-matriculados-novo-crm-status${qs}`
    );
  },

  /** Pede cancel da prévia/criação de leads em andamento. */
  stopNovoCrmProvision(jobId?: string) {
    const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
    return jsonFetch<{ ok: boolean; status: string; jobId?: string }>(
      `/api/maintenance/provision-matriculados-novo-crm-stop${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Prévia síncrona dedupe órfãos/incompletos (scope=both por padrão aqui). */
  previewOrphanDedupe(opts?: { scope?: 'orphans' | 'incomplete' | 'duplicates' | 'both'; max?: number }) {
    const params = new URLSearchParams({ dry_run: '1', scope: opts?.scope ?? 'both' });
    if (opts?.max != null) params.set('max', String(opts.max));
    return jsonFetch<OrphanDedupePreviewResponse>(
      `/api/maintenance/provision-orphan-alunos-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Inicia prévia dedupe em background (verifica cada órfão ao vivo no CRM). */
  startOrphanDedupePreview(opts?: { scope?: 'orphans' | 'incomplete' | 'duplicates' | 'both'; max?: number }) {
    const params = new URLSearchParams({
      dry_run: '1',
      async: '1',
      scope: opts?.scope ?? 'both',
    });
    if (opts?.max != null) params.set('max', String(opts.max));
    return jsonFetch<OrphanDedupeStartResponse>(
      `/api/maintenance/provision-orphan-alunos-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Inicia apply dedupe em background. */
  startOrphanDedupe(opts?: { scope?: 'orphans' | 'incomplete' | 'duplicates' | 'both'; max?: number }) {
    const params = new URLSearchParams({ dry_run: '0', async: '1', scope: opts?.scope ?? 'both' });
    if (opts?.max != null) params.set('max', String(opts.max));
    return jsonFetch<OrphanDedupeStartResponse>(
      `/api/maintenance/provision-orphan-alunos-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  getOrphanDedupeStatus(jobId?: string) {
    const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
    return jsonFetch<OrphanDedupeJobStatusResponse>(
      `/api/maintenance/provision-orphan-alunos-novo-crm-status${qs}`
    );
  },

  /** Pedido cooperativo para parar prévia/apply de dedupe órfãos. */
  stopOrphanDedupe(jobId?: string) {
    const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
    return jsonFetch<{ ok: boolean; status: string; jobId?: string }>(
      `/api/maintenance/provision-orphan-alunos-novo-crm-stop${qs}`,
      { method: 'POST', body: '{}' }
    );
  },
};
