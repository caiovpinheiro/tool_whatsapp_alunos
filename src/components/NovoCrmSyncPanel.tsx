import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Database,
  FileWarning,
  RefreshCw,
  Square,
  UserPlus,
  UserRound,
  X,
  FileDown,
} from 'lucide-react';
import {
  maintenanceApi,
  type NovoCrmCacheStatusResponse,
  type NovoCrmFlagsStageJobStatusResponse,
  type NovoCrmProvisionJobStatusResponse,
  type NovoCrmProvisionPreviewResponse,
  type NovoCrmRegressionEvent,
  type OrphanDedupeJobStatusResponse,
  type OrphanDedupePreviewResponse,
} from '../services/maintenanceApi';
import {
  NOVO_CRM_SYNC_QUEUE_DEFAULT,
  NovoCrmSyncQueueCarousel,
  type NovoCrmSyncKind,
} from './NovoCrmSyncQueueCarousel';
function fmtDt(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

const SYNC_KIND_LABEL: Record<NovoCrmSyncKind, string> = {
  full: 'Full Sync',
  provision: 'Leads novos',
  flags: 'Att de etapas',
  dedupe: 'Dedupe',
};

function fmtDurationMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

const PROVISION_CSV_COLS = [
  'nome',
  'cpf',
  'rgm',
  'tipo',
  'curso',
  'polo',
  'ciclo',
  'situacao',
  'etapa',
  'email',
  'telefone',
] as const;

function downloadProvisionCsv(
  rows: NonNullable<NovoCrmProvisionPreviewResponse['to_create']>,
  filename: string
) {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [
    PROVISION_CSV_COLS.join(';'),
    ...rows.map((r) => PROVISION_CSV_COLS.map((k) => esc(r[k])).join(';')),
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function isFieldsJobMode(mode: string | null | undefined) {
  return String(mode || '').trim() === 'fields';
}

function phaseLabel(phase: string | null | undefined) {
  switch (phase) {
    case 'starting':
      return 'Iniciando';
    case 'provisioning':
      return 'Criando leads';
    case 'live_check':
      return 'Verificando no CRM';
    case 'loading':
    case 'loading_bases':
    case 'load_bases':
      return 'Carregando bases';
    case 'load_matriculados':
      return 'Indexando SIAA';
    case 'loading_cache':
    case 'load_cache':
    case 'scan_mirror':
      return 'Escaneando espelho';
    case 'live_check_orphans':
    case 'process':
      return 'Conferindo órfãos ao vivo';
    case 'process_incomplete':
      return 'Incompletos';
    case 'duplicates':
      return 'Duplicados';
    case 'apply_plan':
      return 'Aplicando prévia';
    case 'processing':
      return 'Calculando alterações';
    case 'processing_exit':
      return 'Entrada/saída remat';
    case 'writing':
      return 'Gravando no CRM';
    case 'done':
      return 'Concluído';
    default:
      return phase || '…';
  }
}

type AlertsPreview = {
  loading: boolean;
  error: string | null;
  alerts: NovoCrmRegressionEvent[] | null;
};

type FlagsJobLive = NonNullable<NovoCrmFlagsStageJobStatusResponse['job']>;
type DedupeJobLive = NonNullable<OrphanDedupeJobStatusResponse['job']>;
type ProvisionJobLive = NonNullable<NovoCrmProvisionJobStatusResponse['job']>;
const PROVISION_NEW_MAX = 1500;

export function NovoCrmSyncPanel() {
  const [status, setStatus] = useState<NovoCrmCacheStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alertsPreview, setAlertsPreview] = useState<AlertsPreview | null>(null);

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncStopping, setSyncStopping] = useState(false);

  const [flagsJobId, setFlagsJobId] = useState<string | null>(null);
  const [flagsJob, setFlagsJob] = useState<FlagsJobLive | null>(null);
  const [flagsMsg, setFlagsMsg] = useState<string | null>(null);
  const [flagsBusy, setFlagsBusy] = useState(false);
  const [flagsStopping, setFlagsStopping] = useState(false);

  const [dedupeBusy, setDedupeBusy] = useState(false);
  const [dedupeMsg, setDedupeMsg] = useState<string | null>(null);
  const [dedupePreview, setDedupePreview] = useState<OrphanDedupePreviewResponse | null>(null);
  const [dedupeJobId, setDedupeJobId] = useState<string | null>(null);
  const [dedupeJob, setDedupeJob] = useState<DedupeJobLive | null>(null);
  const [dedupeMode, setDedupeMode] = useState<'preview' | 'apply'>('preview');
  const [dedupeApplied, setDedupeApplied] = useState(false);
  const [dedupeStopping, setDedupeStopping] = useState(false);
  /** incompletos (CPF/RGM) primeiro — default seguro / mais rápido que both. */
  const [dedupeScope, setDedupeScope] = useState<'incomplete' | 'duplicates' | 'both'>(
    'incomplete'
  );

  const [provisionBusy, setProvisionBusy] = useState(false);
  const [provisionMsg, setProvisionMsg] = useState<string | null>(null);
  const [provisionPreview, setProvisionPreview] = useState<NovoCrmProvisionPreviewResponse | null>(
    null
  );
  const [provisionJobId, setProvisionJobId] = useState<string | null>(null);
  const [provisionJob, setProvisionJob] = useState<ProvisionJobLive | null>(null);
  const [provisionMode, setProvisionMode] = useState<'preview' | 'apply'>('preview');
  const [provisionApplied, setProvisionApplied] = useState(false);
  const [provisionStopping, setProvisionStopping] = useState(false);

  const [queueOrder, setQueueOrder] = useState<NovoCrmSyncKind[]>([]);
  const [queueRunning, setQueueRunning] = useState(false);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueMsg, setQueueMsg] = useState<string | null>(null);
  const [queueConfirm, setQueueConfirm] = useState(false);

  const pollRef = useRef<number | null>(null);
  const queueStopRef = useRef(false);

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await maintenanceApi.getNovoCrmCacheStatus();
      setStatus(s);
      setError(null);
      if (!s.running) {
        setSyncMsg((prev) => (prev && /em andamento/i.test(prev) ? null : prev));
      }
      // Reanexa Att em andamento (refresh / outra aba).
      if (s.running_flags?.jobId) {
        setFlagsJobId((prev) => prev || s.running_flags!.jobId);
        setFlagsBusy(true);
        const r = s.running_flags;
        setFlagsJob({
          jobId: r.jobId,
          mode: r.mode || 'flags_stage',
          status: r.status,
          dry_run: Boolean(r.dry_run),
          total: r.total ?? 0,
          processed: r.processed ?? 0,
          sent: r.sent ?? 0,
          matched: r.matched ?? 0,
          flags_updated: r.flags_updated ?? 0,
          fields_updated: r.fields_updated ?? 0,
          stages_moved: r.stages_moved ?? 0,
          eta_ms: r.eta_ms ?? null,
          phase: r.phase,
          status_message: r.status_message,
          started_at: r.started_at,
          finished_at: null,
          cancel_requested: r.cancel_requested,
          error: null,
          result: null,
        });
      } else {
        // Não rodando: limpa "rodando" stale e deixa last_flags_sync no card.
        setFlagsJobId(null);
        setFlagsBusy(false);
        setFlagsStopping(false);
        setFlagsJob(null);
      }
      // Reanexa dedupe/órfãos em andamento.
      if (s.running_orphan_dedupe?.jobId) {
        const o = s.running_orphan_dedupe;
        setDedupeJobId((prev) => prev || o.jobId);
        setDedupeBusy(true);
        setDedupeMode(o.dry_run === false ? 'apply' : 'preview');
        setDedupeJob({
          jobId: o.jobId,
          status: o.status,
          dry_run: Boolean(o.dry_run),
          total: o.total ?? 0,
          processed: o.processed ?? 0,
          sent: o.sent ?? 0,
          failed: o.failed ?? o.errors ?? 0,
          eta_ms: o.eta_ms ?? null,
          phase: o.phase,
          status_message: o.status_message,
          started_at: o.started_at,
          finished_at: null,
          cancel_requested: o.cancel_requested,
          orphans_total: o.orphans_total,
          orphans_processed: o.orphans_processed,
          incomplete_total: o.incomplete_total,
          incomplete_processed: o.incomplete_processed,
          dup_groups: o.dup_groups,
          dup_groups_processed: o.dup_groups_processed,
          already_has_deal: o.already_has_deal,
          would_create: o.would_create,
          live_ok: o.live_ok,
          deal_not_found: o.deal_not_found,
          errors: o.errors ?? o.failed ?? 0,
          error: null,
          result: null,
        });
        setDedupeMsg(o.status_message || phaseLabel(o.phase));
      } else {
        setDedupeJobId(null);
        setDedupeBusy(false);
        setDedupeStopping(false);
        setDedupeJob(null);
        // Hidrata última prévia/apply persistida (progress some ao terminar).
        const last = s.last_orphan_dedupe;
        if (last?.finished_at) {
          setDedupeApplied(!last.dry_run && !last.cancelled);
          setDedupeMsg(
            last.cancelled
              ? `Última ${last.dry_run ? 'prévia' : 'apply'} · cancelada · ${fmtDt(last.finished_at)}`
              : last.dry_run
                ? `Última prévia · ${fmtDt(last.finished_at)}`
                : `Última apply · ${fmtDt(last.finished_at)}`
          );
        }
      }
      if (s.running_provision?.jobId) {
        const p = s.running_provision;
        setProvisionJobId((prev) => prev || p.jobId);
        setProvisionBusy(true);
        setProvisionMode(p.dry_run === false ? 'apply' : 'preview');
        setProvisionJob({
          jobId: p.jobId,
          mode: p.mode || 'new',
          status: p.status,
          dry_run: Boolean(p.dry_run),
          total: p.total ?? 0,
          processed: p.processed ?? 0,
          sent: p.sent ?? 0,
          failed: p.failed ?? 0,
          phase: p.phase,
          status_message: p.status_message,
          started_at: p.started_at,
          finished_at: null,
          cancel_requested: Boolean(p.cancel_requested),
          error: null,
          result: null,
        });
        setProvisionMsg(p.status_message || phaseLabel(p.phase));
      }
      return s;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar status');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    return () => stopPoll();
  }, [loadStatus, stopPoll]);

  useEffect(() => {
    const needPoll = Boolean(
      status?.running || flagsJobId || dedupeJobId || provisionJobId || queueRunning
    );
    if (needPoll) {
      stopPoll();
      pollRef.current = window.setInterval(() => {
        void loadStatus();
        if (flagsJobId) {
          void maintenanceApi
            .getNovoCrmFlagsStageStatus(flagsJobId)
            .then((r) => {
              if (!r.job) return;
              setFlagsJob(r.job);
              setFlagsMsg(r.job.status_message || phaseLabel(r.job.phase));
              if (r.job.status !== 'running') {
                setFlagsJobId(null);
                setFlagsBusy(false);
                setFlagsStopping(false);
                const res = r.job.result;
                if (r.job.status === 'completed') {
                  const fieldsJob = isFieldsJobMode(r.job.mode || res?.mode);
                  setFlagsMsg(
                    (fieldsJob ? 'Att campos concluída: ' : 'Att concluída: ') +
                      (fieldsJob
                        ? `${res?.fields_updated ?? r.job.fields_updated ?? 0} campos · `
                        : `${res?.flags_updated ?? r.job.flags_updated ?? 0} flags · `) +
                      `${res?.stages_moved ?? r.job.stages_moved ?? 0} etapas` +
                      (res?.stages_skipped_untouchable
                        ? ` · ${res.stages_skipped_untouchable} intocáveis`
                        : '') +
                      (res?.scanned != null
                        ? ` · ${res.scanned.toLocaleString('pt-BR')} deals`
                        : '') +
                      (res?.errors ? ` · ${res.errors} erros` : '')
                  );
                } else if (r.job.status === 'cancelled') {
                  const scanned = res?.scanned ?? r.job.processed ?? 0;
                  const flags = res?.flags_updated ?? r.job.flags_updated ?? 0;
                  const stages = res?.stages_moved ?? r.job.stages_moved ?? 0;
                  const queue = res?.write_queue ?? 0;
                  const fieldsJob = isFieldsJobMode(r.job.mode || res?.mode);
                  setFlagsMsg(
                    (fieldsJob ? 'Att campos cancelada' : 'Att cancelada') +
                      (scanned || flags || stages || queue
                        ? ` (até então: ${Number(flags).toLocaleString('pt-BR')} flags · ${Number(stages).toLocaleString('pt-BR')} etapas · ${Number(scanned).toLocaleString('pt-BR')} deals` +
                          (queue ? ` · fila ${Number(queue).toLocaleString('pt-BR')}` : '') +
                          ')'
                        : res?.phase
                          ? ` · fase ${phaseLabel(res.phase)} (antes da varredura)`
                          : ' · sem progresso parcial')
                  );
                } else if (r.job.status === 'failed') {
                  setFlagsMsg(
                    r.job.error ||
                      (isFieldsJobMode(r.job.mode) ? 'Att campos falhou' : 'Att de etapas falhou')
                  );
                }
                void loadStatus();
              }
            })
            .catch(() => {});
        }
        if (dedupeJobId) {
          void maintenanceApi
            .getOrphanDedupeStatus(dedupeJobId)
            .then((r) => {
              if (!r.job) return;
              setDedupeJob(r.job);
              setDedupeMsg(r.job.status_message || phaseLabel(r.job.phase));
              if (r.job.status !== 'running') {
                setDedupeJobId(null);
                setDedupeBusy(false);
                setDedupeStopping(false);
                if (r.job.status === 'completed' && r.job.result) {
                  setDedupePreview(r.job.result);
                  setDedupeApplied(!r.job.result.dry_run);
                  setDedupeMsg(null);
                } else if (r.job.status === 'cancelled') {
                  if (r.job.result) {
                    setDedupePreview(r.job.result);
                    setDedupeApplied(false);
                  }
                  setDedupeMsg(
                    `Dedupe cancelada` +
                      (r.job.processed
                        ? ` (até ${Number(r.job.processed).toLocaleString('pt-BR')} processados)`
                        : '')
                  );
                } else if (r.job.status === 'failed') {
                  setDedupeMsg(
                    r.job.error || (dedupeMode === 'apply' ? 'Dedupe falhou' : 'Prévia dedupe falhou')
                  );
                }
                void loadStatus();
              }
            })
            .catch(() => {});
        }
        if (provisionJobId) {
          void maintenanceApi
            .getNovoCrmProvisionStatus(provisionJobId)
            .then((r) => {
              if (!r.job) return;
              setProvisionJob(r.job);
              setProvisionMsg(r.job.status_message || phaseLabel(r.job.phase));
              if (r.job.status !== 'running') {
                setProvisionJobId(null);
                setProvisionBusy(false);
                if (r.job.status === 'completed' && r.job.result) {
                  setProvisionPreview(r.job.result);
                  setProvisionApplied(!r.job.result.dry_run);
                  setProvisionMsg(null);
                  setProvisionStopping(false);
                } else if (r.job.status === 'cancelled') {
                  if (r.job.result) {
                    setProvisionPreview(r.job.result);
                    setProvisionApplied(false);
                  }
                  setProvisionMsg('Prévia/criação interrompida.');
                  setProvisionStopping(false);
                } else if (r.job.status === 'failed') {
                  setProvisionMsg(r.job.error || 'Criação de leads falhou');
                  setProvisionStopping(false);
                }
                void loadStatus();
              }
            })
            .catch(() => {});
        }
      }, 2000) as unknown as number;
    } else {
      stopPoll();
    }
    return () => stopPoll();
  }, [status?.running, flagsJobId, dedupeJobId, provisionJobId, queueRunning, dedupeMode, loadStatus, stopPoll]);

  const last = status?.last_sync || null;
  const lastFlags = status?.last_flags_sync || null;
  const lastFields = status?.last_fields_sync || null;
  const lastDedupe = status?.last_orphan_dedupe || null;
  const lastDurationMs =
    last?.finished_at && last?.started_at
      ? new Date(last.finished_at).getTime() - new Date(last.started_at).getTime()
      : null;

  const openAlertsPreview = async () => {
    if (!window.confirm('Carregar alertas de perda de dados?')) return;
    setAlertsPreview({ loading: true, error: null, alerts: null });
    try {
      const r = await maintenanceApi.listNovoCrmRegressions({ limit: 50 });
      setAlertsPreview({
        loading: false,
        error: null,
        alerts: r.events || [],
      });
    } catch (e) {
      setAlertsPreview({
        loading: false,
        error: e instanceof Error ? e.message : 'Falha ao listar alertas',
        alerts: null,
      });
    }
  };

  const runFullSync = async () => {
    if (syncBusy || status?.running) return;
    const ok = window.confirm(
      'Full Sync — espelho local\n\n' +
        'Vai varrer contacts/deals do CRM e atualizar o Postgres local.\n' +
        'Não cria leads nem altera campos/etapas no CRM.\n' +
        'Pode demorar vários minutos (às vezes ~1h).\n\n' +
        'Confirmar?'
    );
    if (!ok) return;
    setSyncBusy(true);
    setSyncMsg('Iniciando Full Sync…');
    try {
      await maintenanceApi.startNovoCrmCacheSync({ mode: 'full' });
      setSyncMsg('Full Sync em andamento…');
      await loadStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Falha ao iniciar sync';
      if (/já em andamento/i.test(msg)) {
        setSyncMsg('Sync já em andamento.');
        await loadStatus();
      } else {
        setError(msg);
        setSyncMsg(null);
      }
    } finally {
      setSyncBusy(false);
    }
  };

  const stopFullSync = async () => {
    if (syncStopping) return;
    setSyncStopping(true);
    try {
      await maintenanceApi.stopNovoCrmCacheSync();
      setSyncMsg('Cancelando Full Sync… (para no próximo lote)');
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : 'Falha ao pedir cancelamento');
    } finally {
      setSyncStopping(false);
    }
  };

  const runFlagsStageSync = async () => {
    if (flagsBusy || flagsJobId) return;
    const lf = status?.last_flags_sync;
    const lastLine = lf?.finished_at
      ? `Última Att real: ${fmtDt(lf.finished_at)} · ` +
        `${Number(lf.scanned || 0).toLocaleString('pt-BR')} deals · ` +
        `${Number(lf.matched || 0).toLocaleString('pt-BR')} match · ` +
        `${Number(lf.flags_updated || 0).toLocaleString('pt-BR')} flags · ` +
        `${Number(lf.stages_moved || 0).toLocaleString('pt-BR')} etapas` +
        (lf.cancelled ? ' · cancelada' : lf.aborted || lf.ok === false ? ' · incompleta' : '')
      : 'Ainda não há Att aplicada registrada neste ambiente.';

    const ok = window.confirm(
      `Att de etapas — aplicar no CRM\n\n` +
        `${lastLine}\n\n` +
        `Roda em TODOS os deals do espelho (sem amostra seca de 2.000).\n` +
        `Flags (Doc, Financeiro, BB, Evasão…) + etapa. CAA→Retenção só ≤72h; depois SIAA/Perdido.\n` +
        `Não toca Ganho/Cancelado nem Retenção manual (sem CAA open).\n` +
        `Acompanhe a barra de progresso e use "Parar" se precisar.\n\n` +
        `Dica: rode Full Sync antes se criou gente recentemente.\n\n` +
        `Confirmar aplicação?`
    );
    if (!ok) {
      setFlagsMsg('Cancelado.');
      return;
    }
    setFlagsBusy(true);
    setFlagsJob(null);
    setFlagsMsg('Iniciando Att de etapas…');
    try {
      const started = await maintenanceApi.startNovoCrmFlagsStage({ mode: 'flags_stage' });
      setFlagsJobId(started.jobId);
      setFlagsMsg('Att de etapas em andamento…');
    } catch (e) {
      setFlagsMsg(e instanceof Error ? e.message : 'Falha no Att de etapas');
      setFlagsBusy(false);
    }
  };

  const stopFlagsStage = async () => {
    if (flagsStopping) return;
    if (!window.confirm('Interromper a Att de etapas? O que já gravou permanece.')) return;
    setFlagsStopping(true);
    try {
      await maintenanceApi.stopNovoCrmFlagsStage(flagsJobId || undefined);
      setFlagsMsg('Cancelando Att… (para no próximo lote)');
    } catch (e) {
      setFlagsMsg(e instanceof Error ? e.message : 'Falha ao pedir cancelamento');
      setFlagsStopping(false);
    }
  };

  const runDedupePreview = async () => {
    if (dedupeBusy || dedupeJobId) return;
    setDedupeBusy(true);
    setDedupeMode('preview');
    setDedupeApplied(false);
    setDedupeMsg(`Iniciando prévia (scope=${dedupeScope})…`);
    setDedupePreview(null);
    setDedupeJob(null);
    try {
      const started = await maintenanceApi.startOrphanDedupePreview({ scope: dedupeScope });
      setDedupeJobId(started.jobId);
    } catch (e) {
      const err = e as Error & { jobId?: string; status?: number };
      if (err.jobId || /já em andamento/i.test(err.message || '')) {
        const jid = err.jobId;
        if (jid) setDedupeJobId(jid);
        else {
          try {
            const st = await maintenanceApi.getOrphanDedupeStatus();
            if (st.job?.jobId) {
              setDedupeJobId(st.job.jobId);
              setDedupeJob(st.job);
              setDedupeMode(st.job.dry_run === false ? 'apply' : 'preview');
              setDedupeMsg(st.job.status_message || phaseLabel(st.job.phase));
              return;
            }
          } catch {
            /* fallthrough */
          }
        }
        setDedupeMsg('Reanexando job em andamento…');
        void loadStatus();
        return;
      }
      setDedupeBusy(false);
      setDedupeMsg(e instanceof Error ? e.message : 'Falha na prévia dedupe');
    }
  };

  const confirmDedupeApply = async () => {
    if (dedupeBusy || dedupeJobId) return;
    setDedupeBusy(true);
    setDedupeMode('apply');
    setDedupeApplied(false);
    setDedupeMsg(`Aplicando no CRM (scope=${dedupeScope})…`);
    setDedupePreview(null);
    setDedupeJob(null);
    try {
      const started = await maintenanceApi.startOrphanDedupe({ scope: dedupeScope });
      setDedupeJobId(started.jobId);
    } catch (e) {
      const err = e as Error & { jobId?: string };
      if (err.jobId || /já em andamento/i.test(err.message || '')) {
        if (err.jobId) setDedupeJobId(err.jobId);
        setDedupeMsg('Reanexando job em andamento…');
        void loadStatus();
        return;
      }
      setDedupeBusy(false);
      setDedupeMsg(e instanceof Error ? e.message : 'Falha ao aplicar dedupe');
    }
  };

  const stopDedupe = async () => {
    if (dedupeStopping) return;
    if (!window.confirm('Interromper a prévia/aplicação de dedupe? O que já contou permanece.')) return;
    setDedupeStopping(true);
    try {
      await maintenanceApi.stopOrphanDedupe(dedupeJobId || undefined);
      setDedupeMsg('Cancelando dedupe… (para no próximo item)');
    } catch (e) {
      setDedupeMsg(e instanceof Error ? e.message : 'Falha ao pedir cancelamento');
      setDedupeStopping(false);
    }
  };

  const dismissDedupePreview = () => {
    setDedupePreview(null);
    setDedupeApplied(false);
    setDedupeMsg(null);
    setDedupeJob(null);
  };

  const runProvisionPreview = async () => {
    if (provisionBusy) return;
    setProvisionBusy(true);
    setProvisionApplied(false);
    setProvisionPreview(null);
    setProvisionMode('preview');
    setProvisionMsg('Prévia: quem está no SIAA e ainda não tem negócio…');
    try {
      const started = await maintenanceApi.startNovoCrmProvisionPreview({
        mode: 'new',
        max: PROVISION_NEW_MAX,
      });
      setProvisionJobId(started.jobId);
    } catch (e) {
      const err = e as Error & { jobId?: string };
      if (err.jobId || /já em andamento/i.test(err.message || '')) {
        if (err.jobId) setProvisionJobId(err.jobId);
        setProvisionMsg('Reanexando job em andamento…');
        void loadStatus();
        return;
      }
      setProvisionBusy(false);
      setProvisionMsg(e instanceof Error ? e.message : 'Falha na prévia de leads');
    }
  };

  const confirmProvisionApply = async () => {
    if (provisionBusy) return;
    setProvisionBusy(true);
    setProvisionMode('apply');
    setProvisionMsg('Criando leads no CRM…');
    try {
      const started = await maintenanceApi.startNovoCrmProvision({
        mode: 'new',
        max: PROVISION_NEW_MAX,
      });
      setProvisionJobId(started.jobId);
    } catch (e) {
      const err = e as Error & { jobId?: string };
      if (err.jobId || /já em andamento/i.test(err.message || '')) {
        if (err.jobId) setProvisionJobId(err.jobId);
        setProvisionMsg('Reanexando job em andamento…');
        void loadStatus();
        return;
      }
      setProvisionBusy(false);
      setProvisionMsg(e instanceof Error ? e.message : 'Falha ao criar leads');
    }
  };

  const dismissProvisionPreview = () => {
    setProvisionPreview(null);
    setProvisionApplied(false);
    setProvisionMsg(null);
    setProvisionJob(null);
  };

  const stopProvision = async () => {
    if (provisionStopping) return;
    setProvisionStopping(true);
    try {
      await maintenanceApi.stopNovoCrmProvision(provisionJobId || undefined);
      setProvisionMsg('Cancelando… (para no próximo da fila)');
    } catch (e) {
      setProvisionMsg(e instanceof Error ? e.message : 'Falha ao pedir cancelamento');
      setProvisionStopping(false);
    }
  };

  const queueKindRef = useRef<NovoCrmSyncKind | null>(null);

  const waitFullSyncDone = async (): Promise<'ok' | 'cancelled' | 'failed'> => {
    const before = await maintenanceApi.getNovoCrmCacheStatus();
    setStatus(before);
    const prevFinish = before.last_sync?.finished_at || null;
    let seenRunning = Boolean(before.running);
    const t0 = Date.now();
    while (!queueStopRef.current) {
      const s = await maintenanceApi.getNovoCrmCacheStatus();
      setStatus(s);
      if (s.running) seenRunning = true;
      const newFinish = s.last_sync?.finished_at || null;
      const done = (seenRunning && !s.running) || (!s.running && newFinish && newFinish !== prevFinish);
      if (done) {
        if (queueStopRef.current) return 'cancelled';
        if (s.last_sync?.status === 'ok') return 'ok';
        if (String(s.last_sync?.error_message || '').includes('cancelado')) return 'cancelled';
        return s.last_sync?.status === 'error' ? 'failed' : 'ok';
      }
      if (!seenRunning && Date.now() - t0 > 60_000 && !s.running) {
        throw new Error('Full Sync não iniciou');
      }
      if (Date.now() - t0 > 10 * 60 * 60 * 1000) throw new Error('Full Sync excedeu 10h');
      await sleep(2500);
    }
    return 'cancelled';
  };

  const waitNamedJob = async (
    jobId: string,
    fetchJob: (
      id: string
    ) => Promise<{ running?: boolean; job: { status: string; error?: string | null } | null }>
  ): Promise<'ok' | 'cancelled' | 'failed'> => {
    const t0 = Date.now();
    while (!queueStopRef.current) {
      const r = await fetchJob(jobId);
      const st = r.job?.status;
      if (st && st !== 'running') {
        if (st === 'completed') return 'ok';
        if (st === 'cancelled') return 'cancelled';
        throw new Error(r.job?.error || 'Job falhou');
      }
      if (Date.now() - t0 > 10 * 60 * 60 * 1000) throw new Error('Job excedeu 10h');
      await sleep(2500);
    }
    return 'cancelled';
  };

  const runQueuedStep = async (kind: NovoCrmSyncKind): Promise<'ok' | 'cancelled' | 'failed'> => {
    queueKindRef.current = kind;
    if (kind === 'full') {
      setSyncBusy(true);
      setSyncMsg('Fila: iniciando Full Sync…');
      try {
        await maintenanceApi.startNovoCrmCacheSync({ mode: 'full' });
        setSyncMsg('Full Sync em andamento…');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/já em andamento/i.test(msg)) throw e;
        setSyncMsg('Full Sync já em andamento — aguardando terminar…');
      }
      const out = await waitFullSyncDone();
      setSyncBusy(false);
      return out;
    }
    if (kind === 'flags') {
      setFlagsBusy(true);
      setFlagsJob(null);
      setFlagsMsg('Fila: iniciando Att de etapas…');
      let jobId = '';
      try {
        const started = await maintenanceApi.startNovoCrmFlagsStage({ mode: 'flags_stage' });
        jobId = started.jobId;
      } catch (e) {
        const st = await maintenanceApi.getNovoCrmFlagsStageStatus();
        if (!st.job?.jobId) throw e;
        jobId = st.job.jobId;
        setFlagsMsg('Att já em andamento — aguardando terminar…');
      }
      setFlagsJobId(jobId);
      setFlagsMsg('Att de etapas em andamento…');
      return waitNamedJob(jobId, (id) => maintenanceApi.getNovoCrmFlagsStageStatus(id));
    }
    if (kind === 'provision') {
      setProvisionBusy(true);
      setProvisionMode('apply');
      setProvisionMsg('Fila: criando leads novos…');
      let jobId = '';
      try {
        const started = await maintenanceApi.startNovoCrmProvision({
          mode: 'new',
          max: PROVISION_NEW_MAX,
        });
        jobId = started.jobId;
      } catch (e) {
        const st = await maintenanceApi.getNovoCrmProvisionStatus();
        if (!st.job?.jobId) throw e;
        jobId = st.job.jobId;
        setProvisionMsg('Criação já em andamento — aguardando terminar…');
      }
      setProvisionJobId(jobId);
      return waitNamedJob(jobId, (id) => maintenanceApi.getNovoCrmProvisionStatus(id));
    }
    setDedupeBusy(true);
    setDedupeMode('apply');
    setDedupeApplied(false);
    setDedupePreview(null);
    setDedupeJob(null);
    setDedupeMsg(`Fila: aplicando dedupe (${dedupeScope})…`);
    let jobId = '';
    try {
      const started = await maintenanceApi.startOrphanDedupe({ scope: dedupeScope });
      jobId = started.jobId;
    } catch (e) {
      const st = await maintenanceApi.getOrphanDedupeStatus();
      if (!st.job?.jobId) throw e;
      jobId = st.job.jobId;
      setDedupeMsg('Dedupe já em andamento — aguardando terminar…');
    }
    setDedupeJobId(jobId);
    return waitNamedJob(jobId, (id) => maintenanceApi.getOrphanDedupeStatus(id));
  };

  const stopQueue = async () => {
    queueStopRef.current = true;
    setQueueMsg('Parando fila…');
    const kind = queueKindRef.current;
    try {
      if (kind === 'full') await maintenanceApi.stopNovoCrmCacheSync();
      else if (kind === 'flags') await maintenanceApi.stopNovoCrmFlagsStage(flagsJobId || undefined);
      else if (kind === 'dedupe') await maintenanceApi.stopOrphanDedupe(dedupeJobId || undefined);
      else if (kind === 'provision') await maintenanceApi.stopNovoCrmProvision(provisionJobId || undefined);
    } catch {
      /* o wait loop encerra mesmo se o stop HTTP falhar */
    }
  };

  const runQueue = async () => {
    const plan = [...queueOrder];
    if (plan.length === 0) return;
    queueStopRef.current = false;
    setQueueConfirm(false);
    setQueueRunning(true);
    setQueueIndex(0);
    const parts: string[] = [];
    try {
      for (let i = 0; i < plan.length; i++) {
        if (queueStopRef.current) break;
        const kind = plan[i];
        setQueueIndex(i);
        setQueueMsg(`Fila ${i + 1}/${plan.length}: ${SYNC_KIND_LABEL[kind]}…`);
        const out = await runQueuedStep(kind);
        parts.push(`${SYNC_KIND_LABEL[kind]}: ${out === 'ok' ? 'ok' : out}`);
        if (out !== 'ok') break;
      }
      if (queueStopRef.current) {
        setQueueMsg(`Fila interrompida. ${parts.join(' · ')}`);
      } else if (parts.some((p) => !p.endsWith(': ok'))) {
        setQueueMsg(`Fila parou. ${parts.join(' · ')}`);
      } else {
        setQueueMsg(`Fila concluída. ${parts.join(' · ')}`);
      }
    } catch (e) {
      setQueueMsg(e instanceof Error ? e.message : 'Falha na fila');
    } finally {
      queueKindRef.current = null;
      setQueueRunning(false);
      setQueueIndex(-1);
      void loadStatus();
    }
  };

  const running = status?.running_sync || null;
  const live = status?.running_cache || null;
  const indexingDeals = live?.phase === 'index_deals';
  const total = indexingDeals
    ? live?.deals_total || null
    : running?.contacts_total ?? live?.contacts_total ?? null;
  const seen = indexingDeals
    ? live?.deals_seen ?? 0
    : running?.contacts_seen ?? live?.contacts_seen ?? 0;
  const pct =
    total && total > 0 ? Math.min(100, Math.round((seen / total) * 100)) : null;

  const flagsRunning = Boolean(flagsJobId) || Boolean(status?.running_flags);
  const fj = flagsJob;
  const fieldsJobRunning = flagsRunning && isFieldsJobMode(fj?.mode || status?.running_flags?.mode);
  const flagsPct =
    fj && fj.total > 0
      ? Math.min(100, Math.round((fj.processed / fj.total) * 100))
      : fj && fj.phase === 'writing'
        ? 0
        : null;
  const flagsEta =
    fj?.eta_ms != null && fj.eta_ms > 0 ? fmtDurationMs(fj.eta_ms) : null;
  const flagsElapsed =
    fj?.started_at != null
      ? fmtDurationMs(Date.now() - new Date(fj.started_at).getTime())
      : null;

  const dedupeRunning = Boolean(dedupeJobId) || Boolean(status?.running_orphan_dedupe);
  const dj = dedupeJob;
  const dedupePct =
    dj && dj.total > 0 ? Math.min(100, Math.round((dj.processed / dj.total) * 100)) : null;
  const dedupeEta =
    dj?.eta_ms != null && dj.eta_ms > 0 ? fmtDurationMs(dj.eta_ms) : null;
  const dedupeElapsed =
    dj?.started_at != null
      ? fmtDurationMs(Date.now() - new Date(dj.started_at).getTime())
      : null;

  const provisionRunning = Boolean(provisionJobId) || Boolean(status?.running_provision);
  const pj = provisionJob;

  const tiles: Array<{
    id: string;
    label: string;
    value: string;
    hint: string;
    icon: typeof Database;
    accent: string;
    onClick?: () => void;
  }> = [
    {
      id: 'cache',
      label: 'Pessoas no cache',
      value: (status?.cache_active ?? 0).toLocaleString('pt-BR'),
      hint: 'Espelho local (somente leitura)',
      icon: UserRound,
      accent: 'border-slate-200 bg-slate-50',
      onClick: () => void loadStatus(),
    },
    {
      id: 'cpf',
      label: 'Sem CPF',
      value: (status?.missing_cpf ?? 0).toLocaleString('pt-BR'),
      hint: 'Indicador do espelho — preenchimento roda à noite (att campos)',
      icon: CreditCard,
      accent: 'border-amber-200 bg-amber-50',
    },
    {
      id: 'rgm',
      label: 'Sem RGM',
      value: (status?.missing_rgm ?? 0).toLocaleString('pt-BR'),
      hint: 'Indicador do espelho — não é botão de sync',
      icon: CreditCard,
      accent: 'border-orange-200 bg-orange-50',
    },
    {
      id: 'incomplete',
      label: 'Campos incompletos',
      value: (status?.incomplete_fields ?? 0).toLocaleString('pt-BR'),
      hint: 'Falta CPF, RGM, telefone, e-mail ou nome no cache',
      icon: FileWarning,
      accent: 'border-rose-200 bg-rose-50',
    },
    {
      id: 'sync',
      label: 'Último Full Sync',
      value: last
        ? last.status === 'ok'
          ? fmtDt(last.finished_at || last.started_at)
          : last.status
        : 'Nunca',
      hint: lastDurationMs
        ? `${last?.mode || 'full'} · ${fmtDurationMs(lastDurationMs)}`
        : 'Use o botão Full Sync acima',
      icon: Database,
      accent: 'border-indigo-200 bg-indigo-50',
    },
    {
      id: 'alerts',
      label: 'Alertas',
      value: (status?.open_data_loss_events ?? 0).toLocaleString('pt-BR'),
      hint: 'Regressões no cache — clique para listar',
      icon: AlertTriangle,
      accent:
        (status?.open_data_loss_events ?? 0) > 0
          ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
          : 'border-emerald-200 bg-emerald-50 hover:border-emerald-300',
      onClick: () => void openAlertsPreview(),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Sync Novo CRM</h2>
            <p className="text-sm text-gray-500 mt-1 max-w-3xl">
              Espelho ≠ att campos ≠ etapas. Dedupe preenche incompletos e trata duplicados. Leads novos cria quem está no SIAA diário sem negócio.
            </p>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-3xl text-xs text-gray-600">
              <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                <p className="font-semibold text-gray-800">De noite (automático)</p>
                <ul className="mt-1 space-y-0.5 list-disc list-inside">
                  <li>
                    <strong>Espelho</strong> — Full Sync copia CRM → Postgres local
                    {status?.night_cron
                      ? status.night_cron.cache_enabled
                        ? ` · ${String(status.night_cron.cache_full_hour_utc).padStart(2, '0')}:00 UTC${
                            status.night_cron.cache_next_ms != null
                              ? ` (em ${fmtDurationMs(status.night_cron.cache_next_ms)})`
                              : ''
                          }`
                        : ' · OFF'
                      : ''}
                  </li>
                  <li>
                    <strong>Att campos</strong> — matriculados D−1 preenche curso/polo/etc. em
                    quem já está no funil
                    {status?.night_cron
                      ? status.night_cron.fields_enabled
                        ? ` · ${String(status.night_cron.fields_hour_utc).padStart(2, '0')}:00 UTC`
                        : ' · OFF (NOVO_CRM_FIELDS_SYNC_ENABLED≠1)'
                      : ''}
                    {lastFields?.finished_at
                      ? ` · última ${fmtDt(lastFields.finished_at)} · ${Number(lastFields.fields_updated || 0).toLocaleString('pt-BR')} campos · ${Number(lastFields.stages_moved || 0).toLocaleString('pt-BR')} etapas${lastFields.cancelled ? ' · cancelada' : ''}`
                      : ''}
                  </li>
                  {status?.night_cron?.fetch_deal_fields ? (
                    <li className="text-amber-700">
                      GET por deal ligado (FETCH_DEAL_FIELDS=1) — Full noturno fica horas. Preferir 0.
                    </li>
                  ) : null}
                  {status?.night_cron && !status.night_cron.api_configured ? (
                    <li className="text-rose-700">API do CRM não configurada — cron de espelho não sobe</li>
                  ) : null}
                </ul>
              </div>
              <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 px-3 py-2">
                <p className="font-semibold text-indigo-900">De dia (manual)</p>
                <ul className="mt-1 space-y-0.5 list-disc list-inside">
                  <li>
                    <strong>Full Sync</strong> — atualiza o espelho agora
                  </li>
                  <li>
                    <strong>Att de etapas</strong> — flags + move etapa
                  </li>
                  <li>
                    <strong>Leads novos</strong> — SIAA diário sem negócio no CRM
                  </li>
                  <li>
                    <strong>Dedupe</strong> — incompletos / duplicados
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadStatus()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar status
          </button>
        </div>

        <p className="mt-5 text-xs font-semibold text-gray-700 uppercase tracking-wide">
          Ações manuais
        </p>
        <div className="mt-2">
          <NovoCrmSyncQueueCarousel
            order={queueOrder}
            running={queueRunning}
            currentIndex={queueIndex}
            message={queueMsg}
            confirmOpen={queueConfirm}
            dedupeScopeLabel={dedupeScope}
            disabled={
              Boolean(status?.running) ||
              flagsRunning ||
              provisionRunning ||
              dedupeRunning
            }
            onToggle={(id) =>
              setQueueOrder((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
              )
            }
            onSelectAll={() => setQueueOrder([...NOVO_CRM_SYNC_QUEUE_DEFAULT])}
            onClear={() => {
              setQueueOrder([]);
              setQueueConfirm(false);
            }}
            onAskRun={() => setQueueConfirm(true)}
            onConfirmRun={() => void runQueue()}
            onCancelConfirm={() => setQueueConfirm(false)}
            onStop={() => void stopQueue()}
          />
        </div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          <div className="rounded-xl border border-gray-200 bg-white p-4 flex flex-col gap-2 h-full">
            <p className="text-xs font-semibold text-gray-900">1. Full Sync</p>
            <p className="text-[11px] text-gray-500 flex-1">
              Reespelha o CRM no cache local. Use quando o painel estiver desatualizado.
            </p>
            <div className="flex flex-wrap gap-2 mt-auto">
              <button
                type="button"
                onClick={() => void runFullSync()}
                disabled={Boolean(status?.running) || syncBusy || queueRunning}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status?.running || syncBusy ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Database className="w-3.5 h-3.5" />
                )}
                {status?.running ? 'Sincronizando…' : 'Full Sync'}
              </button>
              {status?.running && (
                <button
                  type="button"
                  onClick={() => void stopFullSync()}
                  disabled={syncStopping}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 rounded-lg disabled:opacity-50"
                >
                  <Square className="w-3 h-3 fill-current" />
                  {syncStopping ? 'Parando…' : 'Parar'}
                </button>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4 flex flex-col gap-2 h-full">
            <p className="text-xs font-semibold text-gray-900">2. Att de etapas</p>
            <p className="text-[11px] text-gray-500 flex-1">
              Flags (Doc, Financeiro, Situação Financeira/inad vencidos, BB, Evasão) + etapa. CAA→Retenção
              só ≤72h; depois SIAA/Perdido. Não toca Ganho/Cancelado nem Retenção manual (sem CAA open).
              Preenche flag vazia só quando a base pede Sim.
            </p>
            {lastFlags?.finished_at ? (
              <div className="text-[12px] space-y-0.5 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-2 text-gray-800">
                <p className="font-semibold text-gray-900">
                  Última Att (resultado real)
                  {lastFlags.cancelled
                    ? ' · cancelada (parcial)'
                    : lastFlags.abort_reason
                      ? ' · erro'
                      : lastFlags.aborted || lastFlags.ok === false
                        ? ' · incompleta'
                        : ''}
                </p>
                <p className="tabular-nums font-medium">{fmtDt(lastFlags.finished_at)}</p>
                <p className="tabular-nums font-semibold">
                  {Number(lastFlags.scanned || 0).toLocaleString('pt-BR')} deals ·{' '}
                  {Number(lastFlags.matched || 0).toLocaleString('pt-BR')} match ·{' '}
                  {Number(lastFlags.flags_updated || 0).toLocaleString('pt-BR')} flags ·{' '}
                  {Number(lastFlags.stages_moved || 0).toLocaleString('pt-BR')} etapas
                  {lastFlags.stages_skipped_untouchable
                    ? ` · ${Number(lastFlags.stages_skipped_untouchable).toLocaleString('pt-BR')} intocáveis`
                    : ''}
                  {lastFlags.errors
                    ? ` · ${Number(lastFlags.errors).toLocaleString('pt-BR')} erros`
                    : ''}
                </p>
                {(Number(lastFlags.write_queue || 0) > 0 ||
                  Number(lastFlags.flags_queued || 0) > 0 ||
                  Number(lastFlags.stages_queued || 0) > 0) && (
                  <p className="tabular-nums text-[11px] font-medium opacity-95">
                    Fila no stop: {Number(lastFlags.write_queue || 0).toLocaleString('pt-BR')}
                    {lastFlags.flags_queued != null
                      ? ` · ${Number(lastFlags.flags_queued).toLocaleString('pt-BR')} flags na fila`
                      : ''}
                    {lastFlags.stages_queued != null
                      ? ` · ${Number(lastFlags.stages_queued).toLocaleString('pt-BR')} etapas na fila`
                      : ''}
                  </p>
                )}
                {(lastFlags.phase || lastFlags.abort_reason) && (
                  <p className="text-[11px] font-medium opacity-95">
                    {lastFlags.phase ? `Fase: ${phaseLabel(lastFlags.phase)}` : ''}
                    {lastFlags.phase && lastFlags.abort_reason ? ' · ' : ''}
                    {lastFlags.abort_reason || ''}
                  </p>
                )}
                {lastFlags.cancelled &&
                  !Number(lastFlags.scanned || 0) &&
                  !Number(lastFlags.flags_updated || 0) && (
                    <p className="text-[11px] font-medium opacity-90">
                      Cancelou antes da varredura (zeros reais).
                    </p>
                  )}
              </div>
            ) : (
              <p className="text-[11px] text-gray-400">
                Sem Att registrada neste ambiente.
              </p>
            )}
            <div className="flex flex-wrap gap-2 mt-auto">
              <button
                type="button"
                onClick={() => void runFlagsStageSync()}
                disabled={flagsBusy || flagsRunning || queueRunning}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {flagsBusy || flagsRunning ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                {fieldsJobRunning ? 'Fields rodando…' : flagsRunning ? 'Att rodando…' : 'Att de etapas'}
              </button>
              {flagsRunning && (
                <button
                  type="button"
                  onClick={() => void stopFlagsStage()}
                  disabled={flagsStopping || Boolean(fj?.cancel_requested)}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 rounded-lg disabled:opacity-50"
                >
                  <Square className="w-3 h-3 fill-current" />
                  {flagsStopping || fj?.cancel_requested ? 'Parando…' : 'Parar'}
                </button>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4 flex flex-col gap-2 h-full">
            <p className="text-xs font-semibold text-gray-900">3. Criação de leads novos</p>
            <p className="text-[11px] text-gray-500 flex-1">
              Quem está na Relação e ainda não tem negócio daquele RGM — pessoa nova ou 2ª
              matrícula de quem já está no CRM (o deal nasce no contato existente). A prévia
              filtra o espelho e só consulta o CRM no que falta. Até{' '}
              {PROVISION_NEW_MAX.toLocaleString('pt-BR')} por vez.
            </p>
            <div className="flex flex-wrap gap-2 mt-auto">
              <button
                type="button"
                onClick={() => void runProvisionPreview()}
                disabled={provisionBusy || provisionRunning || queueRunning}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {provisionBusy || provisionRunning ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <UserPlus className="w-3.5 h-3.5" />
                )}
                {provisionRunning
                  ? provisionMode === 'apply'
                    ? 'Criando…'
                    : 'Prévia rodando…'
                  : 'Prévia leads novos'}
              </button>
              {provisionRunning && (
                <button
                  type="button"
                  onClick={() => void stopProvision()}
                  disabled={provisionStopping || Boolean(pj?.cancel_requested)}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 rounded-lg disabled:opacity-50"
                >
                  <Square className="w-3 h-3 fill-current" />
                  {provisionStopping || pj?.cancel_requested ? 'Parando…' : 'Parar'}
                </button>
              )}
            </div>
            {pj && provisionRunning && (
              <p className="text-[11px] text-gray-600">
                {phaseLabel(pj.phase)} · {Number(pj.processed || 0).toLocaleString('pt-BR')}
                {pj.total ? ` / ${Number(pj.total).toLocaleString('pt-BR')}` : ''}
              </p>
            )}
            {provisionMsg && !provisionPreview && (
              <p className="text-[11px] font-medium text-gray-700">{provisionMsg}</p>
            )}
            {provisionPreview && (
              <div className="mt-1 text-[11px] text-gray-700 space-y-0.5">
                <p>
                  Criar:{' '}
                  <strong>
                    {Number(
                      provisionPreview.created_contacts || 0
                    ).toLocaleString('pt-BR')}
                  </strong>{' '}
                  contatos ·{' '}
                  <strong>
                    {Number(provisionPreview.created_deals || 0).toLocaleString('pt-BR')}
                  </strong>{' '}
                  negócios
                  {provisionPreview.filled_existing_deals
                    ? ` · ${Number(provisionPreview.filled_existing_deals).toLocaleString('pt-BR')} preencher deal vazio`
                    : ''}
                  {provisionPreview.created_extra_deals
                    ? ` · ${Number(provisionPreview.created_extra_deals).toLocaleString('pt-BR')} 2º RGM`
                    : ''}
                  {provisionPreview.updated_existing
                    ? ` · ${Number(provisionPreview.updated_existing).toLocaleString('pt-BR')} já cobertos`
                    : ''}
                </p>
                <p>
                  Já no espelho: {Number(provisionPreview.skipped_cache || 0).toLocaleString('pt-BR')} CPF ·{' '}
                  {Number(provisionPreview.skipped_cache_rgm || 0).toLocaleString('pt-BR')} RGM
                  {Number(provisionPreview.skipped_cache_email || 0) ||
                  Number(provisionPreview.skipped_cache_phone || 0)
                    ? ` · ${Number(provisionPreview.skipped_cache_email || 0).toLocaleString('pt-BR')} e-mail · ${Number(provisionPreview.skipped_cache_phone || 0).toLocaleString('pt-BR')} tel`
                    : ''}
                </p>
                {provisionPreview.errors ? (
                  <div className="text-rose-700 space-y-0.5">
                    <p>{Number(provisionPreview.errors).toLocaleString('pt-BR')} erros</p>
                    {(provisionPreview.error_samples || []).slice(0, 5).map((s, i) => (
                      <p key={`${s.cpf || i}-${s.error}`} className="text-[10px] font-normal break-all">
                        {s.cpf ? `cpf ${s.cpf}: ` : ''}
                        {s.error}
                      </p>
                    ))}
                  </div>
                ) : null}
                {provisionApplied ? (
                  <p className="pt-1 font-semibold text-gray-900">Aplicado no CRM.</p>
                ) : (
                  <div className="flex flex-wrap gap-2 pt-1.5">
                    {(provisionPreview.to_create?.length || 0) > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          downloadProvisionCsv(
                            provisionPreview.to_create || [],
                            `leads-novos-previa-${new Date().toISOString().slice(0, 10)}.csv`
                          )
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 rounded-lg"
                      >
                        <FileDown className="w-3.5 h-3.5" />
                        CSV ({Number(provisionPreview.to_create_count || provisionPreview.to_create?.length || 0).toLocaleString('pt-BR')})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void confirmProvisionApply()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded-lg"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      Aplicar{' '}
                      {Number(
                        (provisionPreview.created_deals || 0) +
                          (provisionPreview.filled_existing_deals || 0) ||
                          provisionPreview.created_contacts ||
                          0
                      ).toLocaleString('pt-BR')}{' '}
                      ações
                    </button>
                    <button
                      type="button"
                      onClick={dismissProvisionPreview}
                      className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 rounded-lg"
                    >
                      Descartar
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4 flex flex-col gap-2 h-full">
            <p className="text-xs font-semibold text-gray-900">
              4. Dedupe incompletos/duplicados
            </p>
            <p className="text-[11px] text-gray-500 flex-1">
              Incompletos só preenchem CPF/RGM (e irmãos fracos vão a Perdido). Duplicados: 2+ cartões → mantém 1. Leads novos ficam no card 3.
            </p>
            <label className="flex flex-col gap-0.5 text-[11px] text-gray-700">
              <span className="font-medium">Escopo</span>
              <select
                value={dedupeScope}
                disabled={dedupeBusy || dedupeRunning || queueRunning}
                onChange={(e) =>
                  setDedupeScope(e.target.value as 'incomplete' | 'duplicates' | 'both')
                }
                className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 disabled:opacity-50"
              >
                <option value="incomplete">Incompletos (CPF/RGM) — default</option>
                <option value="duplicates">Duplicados → Perdido</option>
                <option value="both">Tudo (incompletos + duplicados)</option>
              </select>
            </label>
            <div className="flex flex-wrap gap-2 mt-auto">
              <button
                type="button"
                onClick={() => void runDedupePreview()}
                disabled={dedupeBusy || dedupeRunning || queueRunning}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-violet-700 hover:bg-violet-800 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {dedupeBusy || dedupeRunning ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <UserRound className="w-3.5 h-3.5" />
                )}
                {dedupeRunning
                  ? dedupeMode === 'apply'
                    ? 'Aplicando…'
                    : 'Prévia rodando…'
                  : `Prévia (${dedupeScope})`}
              </button>
              {dedupeRunning && (
                <button
                  type="button"
                  onClick={() => void stopDedupe()}
                  disabled={dedupeStopping || Boolean(dj?.cancel_requested)}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 rounded-lg disabled:opacity-50"
                >
                  <Square className="w-3 h-3 fill-current" />
                  {dedupeStopping || dj?.cancel_requested ? 'Parando…' : 'Parar'}
                </button>
              )}
            </div>
            {lastDedupe?.finished_at && !dedupeRunning && (
              <div className="text-[12px] space-y-0.5 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-2 text-gray-800">
                <p className="font-semibold text-gray-900">
                  Última {lastDedupe.dry_run ? 'prévia' : 'apply'}
                  {lastDedupe.cancelled
                    ? ' · cancelada (parcial)'
                    : lastDedupe.status === 'failed'
                      ? ' · erro'
                      : lastDedupe.ok === false
                        ? ' · incompleta'
                        : ''}
                  {lastDedupe.scope ? ` · ${lastDedupe.scope}` : ''}
                </p>
                <p className="tabular-nums font-medium">{fmtDt(lastDedupe.finished_at)}</p>
                {lastDedupe.status === 'failed' && lastDedupe.error && (
                  <p className="text-[11px] font-medium text-rose-700 dark:text-rose-300 truncate">
                    {lastDedupe.error}
                  </p>
                )}
                <p className="tabular-nums font-semibold">
                  Incompletos enriq.:{' '}
                  {Number(lastDedupe.incomplete_enriched || 0).toLocaleString('pt-BR')}
                  {' · '}dups Perdido:{' '}
                  {Number(
                    lastDedupe.dup_deals_moved_perdido ??
                      lastDedupe.dup_deals_would_move_perdido ??
                      lastDedupe.dup_to_perdido ??
                      0
                  ).toLocaleString('pt-BR')}
                  {lastDedupe.errors
                    ? ` · ${Number(lastDedupe.errors).toLocaleString('pt-BR')} erros`
                    : ''}
                  {lastDedupe.tag_name ? ` · tag ${lastDedupe.tag_name}` : ''}
                  {Number(lastDedupe.tags_failed || 0) > 0
                    ? ` · ${Number(lastDedupe.tags_failed).toLocaleString('pt-BR')} sem tag`
                    : lastDedupe.tags_applied
                      ? ` · ${Number(lastDedupe.tags_applied).toLocaleString('pt-BR')} tags`
                      : ''}
                </p>
              </div>
            )}
            {dedupeMsg && !dedupeRunning && (
              <p className="text-[11px] font-medium text-gray-700">{dedupeMsg}</p>
            )}
            {dedupePreview && (
              <div className="mt-1 text-[11px] text-gray-700 space-y-0.5">
                <p>
                  Sem negócio no espelho: <strong>{dedupePreview.orphans_total.toLocaleString('pt-BR')}</strong> ·
                  já tinham negócio no CRM: <strong>{(dedupePreview.skipped_already_has_deal_live ?? 0).toLocaleString('pt-BR')}</strong>
                  {dedupePreview.warmed_cache ? ` (${dedupePreview.warmed_cache.toLocaleString('pt-BR')} corrigidos no espelho)` : ''}
                </p>
                <p>
                  Criação de negócios pelo dedupe: <strong>desativada</strong>
                </p>
                <p>
                  Com negócio mas sem CPF/RGM:{' '}
                  <strong>{dedupePreview.incomplete_total.toLocaleString('pt-BR')}</strong> ·
                  duplicados para Perdido:{' '}
                  <strong>{dedupePreview.dup_to_perdido.toLocaleString('pt-BR')}</strong> (
                  {(dedupePreview.deals_would_move_perdido ?? dedupePreview.deals_moved_perdido ?? 0).toLocaleString('pt-BR')}{' '}
                  negócios) · só preencher campos:{' '}
                  <strong>{dedupePreview.incomplete_enriched.toLocaleString('pt-BR')}</strong>
                </p>
                <p>
                  Mesma pessoa com 2+ cartões:{' '}
                  <strong>{(dedupePreview.dup_deal_groups ?? 0).toLocaleString('pt-BR')}</strong> ·
                  cartões a mandar para Perdido:{' '}
                  <strong>
                    {(
                      dedupePreview.dup_deals_would_move_perdido ??
                      dedupePreview.dup_deals_moved_perdido ??
                      0
                    ).toLocaleString('pt-BR')}
                  </strong>
                  {dedupePreview.dup_cross_contact
                    ? ` · ${dedupePreview.dup_cross_contact.toLocaleString('pt-BR')} em cadastros diferentes`
                    : ''}
                  {dedupePreview.dup_resolved_live
                    ? ` · ${dedupePreview.dup_resolved_live.toLocaleString('pt-BR')} já resolvidos no CRM`
                    : ''}
                </p>
                <p>Casados por e-mail: {dedupePreview.matched_email.toLocaleString('pt-BR')} · por telefone: {dedupePreview.matched_phone.toLocaleString('pt-BR')}</p>
                <p className="text-gray-500">
                  Barrados pela conferência: {(dedupePreview.incomplete_live_already_ok ?? 0).toLocaleString('pt-BR')} já
                  preenchidos no CRM · {(dedupePreview.incomplete_ambiguous ?? 0).toLocaleString('pt-BR')} e-mail/telefone de
                  mais de um aluno · {(dedupePreview.incomplete_name_mismatch ?? 0).toLocaleString('pt-BR')} nome divergente
                  {dedupePreview.incomplete_live_conflict
                    ? ` · ${dedupePreview.incomplete_live_conflict.toLocaleString('pt-BR')} valor diferente no CRM (não sobrescrito)`
                    : ''}
                </p>
                {dedupeApplied ? (
                  <p className="pt-1 font-semibold text-gray-900">
                    Aplicado:{' '}
                    {(
                      (dedupePreview.deals_moved_perdido ?? 0) +
                      (dedupePreview.dup_deals_moved_perdido ?? 0)
                    ).toLocaleString('pt-BR')}{' '}
                    movidos para Perdido ·{' '}
                    {dedupePreview.incomplete_enriched.toLocaleString('pt-BR')} campos preenchidos
                    {dedupePreview.errors
                      ? ` · ${dedupePreview.errors.toLocaleString('pt-BR')} falhas`
                      : ''}
                    {dedupePreview.tag_name ? ` · ${dedupePreview.tag_name}` : ''}
                    {Number(dedupePreview.tags_failed || 0) > 0
                      ? ` · ${Number(dedupePreview.tags_failed).toLocaleString('pt-BR')} sem tag`
                      : ''}
                  </p>
                ) : (
                  <div className="flex gap-2 pt-1.5">
                    <button
                      type="button"
                      onClick={() => void confirmDedupeApply()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-violet-700 hover:bg-violet-800 rounded-lg"
                    >
                      <UserRound className="w-3.5 h-3.5" />
                      Aplicar
                    </button>
                    <button
                      type="button"
                      onClick={dismissDedupePreview}
                      className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 rounded-lg"
                    >
                      Descartar
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        {syncMsg && !status?.running && !/em andamento/i.test(syncMsg) && (
          <p className="mt-3 text-sm text-indigo-700 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {syncMsg}
          </p>
        )}
        {flagsMsg && !flagsRunning && (
          <p className="mt-3 text-sm text-emerald-800 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {flagsMsg}
          </p>
        )}

        {status?.running && (
          <div className="mt-4 max-w-xl rounded-xl border border-indigo-200 bg-indigo-50/50 p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-xs font-medium text-indigo-900">
                Full Sync ({running?.mode || 'full'})
                {indexingDeals ? ' · indexando negócios' : live?.phase === 'contacts' ? ' · copiando contatos' : ' em andamento'}
              </p>
              <button
                type="button"
                onClick={() => void stopFullSync()}
                disabled={syncStopping}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-rose-700 border border-rose-300 rounded-md hover:bg-rose-50 disabled:opacity-50"
              >
                <Square className="w-2.5 h-2.5 fill-current" />
                Parar
              </button>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-indigo-100">
              <div
                className={`h-full rounded-full bg-indigo-600 transition-[width] duration-500 ${
                  pct == null ? 'animate-pulse w-1/3' : ''
                }`}
                style={pct == null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-gray-600 tabular-nums">
              {live?.status_message
                ? live.status_message
                : pct != null
                  ? `${pct}% · ${seen.toLocaleString('pt-BR')} de ${(total ?? 0).toLocaleString('pt-BR')} ${indexingDeals ? 'negócios' : 'contatos'}`
                  : `${seen.toLocaleString('pt-BR')} processados…`}
              {!live?.status_message && running?.cache_upserted != null
                ? ` · ${Number(running.cache_upserted).toLocaleString('pt-BR')} upserts`
                : ''}
            </p>
          </div>
        )}

        {flagsRunning && (
          <div className="mt-4 max-w-xl rounded-xl border border-emerald-300/70 dark:border-emerald-400/50 bg-emerald-50/80 dark:bg-emerald-900/45 p-3.5">
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-300">
                {fieldsJobRunning ? 'Att campos (madrugada)' : 'Att de etapas'} · {phaseLabel(fj?.phase)}
                {fj?.cancel_requested ? ' · cancelando…' : ''}
              </p>
              <button
                type="button"
                onClick={() => void stopFlagsStage()}
                disabled={flagsStopping || Boolean(fj?.cancel_requested)}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-400/50 rounded-md hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
              >
                <Square className="w-2.5 h-2.5 fill-current" />
                Parar
              </button>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-emerald-200/90 dark:bg-black/55 ring-1 ring-inset ring-emerald-600/15 dark:ring-emerald-400/35">
              <div
                className={`h-full rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.45)] transition-[width] duration-500 ${
                  flagsPct == null ? 'animate-pulse w-1/3' : ''
                }`}
                style={flagsPct == null ? undefined : { width: `${flagsPct}%` }}
              />
            </div>
            <div className="mt-2 space-y-1 tabular-nums">
              <p className="text-sm font-semibold text-emerald-950 dark:text-slate-100">
                {flagsPct != null
                  ? `${flagsPct}% · ${Number(fj?.processed || 0).toLocaleString('pt-BR')} / ${Number(fj?.total || 0).toLocaleString('pt-BR')}`
                  : `${Number(fj?.processed || 0).toLocaleString('pt-BR')} processados…`}
                {fj?.matched != null
                  ? ` · match ${Number(fj.matched).toLocaleString('pt-BR')}`
                  : ''}
              </p>
              <p className="text-[13px] font-medium text-emerald-950 dark:text-[#e6edf6]">
                {fieldsJobRunning
                  ? `Campos gravados: ${Number(fj?.fields_updated || 0).toLocaleString('pt-BR')}`
                  : `Flags gravadas: ${Number(fj?.flags_updated || 0).toLocaleString('pt-BR')}`}
                {' · '}
                Etapas: {Number(fj?.stages_moved || 0).toLocaleString('pt-BR')}
                {flagsElapsed ? ` · decorrido ${flagsElapsed}` : ''}
                {flagsEta ? ` · ETA ~${flagsEta}` : ''}
              </p>
              {fj?.status_message && (
                <p className="text-xs font-medium text-emerald-950/90 dark:text-slate-200/90 truncate">
                  {fj.status_message}
                </p>
              )}
            </div>
          </div>
        )}

        {dedupeRunning && (
          <div className="mt-4 max-w-xl rounded-xl border border-violet-300/70 dark:border-violet-400/50 bg-violet-50/80 dark:bg-violet-900/40 p-3.5">
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-sm font-semibold text-violet-900 dark:text-violet-200">
                {dj?.dry_run === false ? 'Dedupe (apply)' : 'Prévia dedupe'} · {phaseLabel(dj?.phase)}
                {dj?.cancel_requested ? ' · cancelando…' : ''}
              </p>
              <button
                type="button"
                onClick={() => void stopDedupe()}
                disabled={dedupeStopping || Boolean(dj?.cancel_requested)}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-400/50 rounded-md hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
              >
                <Square className="w-2.5 h-2.5 fill-current" />
                Parar
              </button>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-violet-200/90 dark:bg-black/55 ring-1 ring-inset ring-violet-600/15 dark:ring-violet-400/35">
              <div
                className={`h-full rounded-full bg-violet-500 dark:bg-violet-400 shadow-[0_0_10px_rgba(167,139,250,0.45)] transition-[width] duration-500 ${
                  dedupePct == null ? 'animate-pulse w-1/3' : ''
                }`}
                style={dedupePct == null ? undefined : { width: `${dedupePct}%` }}
              />
            </div>
            <div className="mt-2 space-y-1 tabular-nums">
              <p className="text-sm font-semibold text-violet-950 dark:text-slate-100">
                {dedupePct != null
                  ? `${dedupePct}% · ${Number(dj?.processed || 0).toLocaleString('pt-BR')} / ${Number(dj?.total || 0).toLocaleString('pt-BR')}`
                  : `${Number(dj?.processed || 0).toLocaleString('pt-BR')} processados…`}
              </p>
              <p className="text-[13px] font-medium text-violet-950 dark:text-[#e6edf6]">
                Criação de negócios: desativada
              </p>
              <p className="text-[12px] font-medium text-violet-900/90 dark:text-slate-200">
                {dj?.phase === 'apply_plan'
                  ? dj.status_message || 'Aplicando ações da prévia…'
                  : `Incompletos: ${Number(dj?.incomplete_processed ?? 0).toLocaleString('pt-BR')}${
                      dj?.incomplete_total != null && dj.incomplete_total > 0
                        ? `/${Number(dj.incomplete_total).toLocaleString('pt-BR')}`
                        : ''
                    } · dup grupos: ${Number(dj?.dup_groups_processed ?? 0).toLocaleString('pt-BR')}${
                      dj?.dup_groups != null && dj.dup_groups > 0
                        ? `/${Number(dj.dup_groups).toLocaleString('pt-BR')}`
                        : ''
                    }`}
                {dj?.phase !== 'apply_plan' && Number(dj?.deal_not_found || 0) > 0
                  ? ` · not_found ${Number(dj?.deal_not_found).toLocaleString('pt-BR')}`
                  : ''}
                {Number(dj?.errors || 0) > 0
                  ? ` · erros ${Number(dj?.errors).toLocaleString('pt-BR')}`
                  : ''}
                {dedupeElapsed ? ` · decorrido ${dedupeElapsed}` : ''}
                {dedupeEta ? ` · ETA ~${dedupeEta}` : ''}
              </p>
              {dj?.status_message && dj.phase !== 'apply_plan' && (
                <p className="text-xs font-medium text-violet-950/90 dark:text-slate-200/90 truncate">
                  {dj.status_message}
                </p>
              )}
            </div>
          </div>
        )}

        <p className="mt-6 text-xs font-semibold text-gray-700 uppercase tracking-wide">
          Status do espelho (só indicadores — não enriquecem)
        </p>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tiles.map((t) => {
            const Icon = t.icon;
            const clickable = Boolean(t.onClick);
            const Comp = clickable ? 'button' : 'div';
            return (
              <Comp
                key={t.id}
                type={clickable ? 'button' : undefined}
                onClick={t.onClick}
                className={`text-left rounded-xl border p-4 ${t.accent} ${
                  clickable ? 'transition-all cursor-pointer' : ''
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-white/80 border border-black/5 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-gray-700" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-500">{t.label}</p>
                    <p className="text-xl font-semibold text-gray-900 tabular-nums mt-0.5 truncate">
                      {loading && !status ? '…' : t.value}
                    </p>
                    <p className="text-[11px] text-gray-500 mt-1">{t.hint}</p>
                  </div>
                </div>
              </Comp>
            );
          })}
        </div>
      </div>

      {alertsPreview && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 bg-black/40 overflow-y-auto">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-gray-100 my-8">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Alertas de perda de dados</h3>
              <button
                type="button"
                onClick={() => setAlertsPreview(null)}
                className="p-1 rounded-lg text-gray-400 hover:bg-gray-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 text-sm text-gray-700 space-y-3 max-h-[60vh] overflow-y-auto">
              {alertsPreview.loading && <p className="text-gray-500">Carregando…</p>}
              {alertsPreview.error && <p className="text-rose-600">{alertsPreview.error}</p>}
              {alertsPreview.alerts && (
                <div className="space-y-2">
                  {alertsPreview.alerts.length === 0 ? (
                    <p className="text-emerald-700">Nenhum alerta aberto.</p>
                  ) : (
                    alertsPreview.alerts.map((ev) => (
                      <div
                        key={String(ev.id)}
                        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs"
                      >
                        <p className="font-medium">
                          #{ev.id} · {ev.contact_id || '—'}
                        </p>
                        <p className="text-gray-500 mt-0.5">{fmtDt(ev.detected_at)}</p>
                        <button
                          type="button"
                          className="mt-2 text-indigo-700 font-medium hover:underline"
                          onClick={() =>
                            void maintenanceApi.ackNovoCrmRegression(ev.id).then(() => {
                              void openAlertsPreview();
                              void loadStatus();
                            })
                          }
                        >
                          Marcar como visto
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="px-5 py-4 border-t border-gray-100 flex justify-end">
              <button
                type="button"
                onClick={() => setAlertsPreview(null)}
                className="px-3 py-2 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
