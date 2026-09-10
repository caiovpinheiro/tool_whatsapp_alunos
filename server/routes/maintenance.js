/**
 * Rotas de manutenção operacional. Protegidas por requireApiKey (decisão de
 * 26/05/2026 — hardening).
 */
import { Router } from 'express';
import { requireApiKey } from '../middleware/requireApiKey.js';
import { cleanStaleOrigemAtivacao } from '../services/activationOrigemCleanupService.js';
import { cleanStaleActivationTags } from '../services/activationNovoCrmTagCleanupService.js';
import { syncCaaDesfechos } from '../services/crmDesfechoSyncService.js';
import { syncResponseConsultores } from '../services/crmConsultorSyncService.js';
import { runFullSync, startFullSyncBackground } from '../services/datacrazyLeadCacheSyncService.js';
import * as datacrazyLeadCacheRepo from '../repositories/datacrazyLeadCacheRepository.js';
import {
  runNovoCrmCacheSync,
  startNovoCrmCacheSyncBackground,
  requestCancelNovoCrmCacheSync,
  getRunningNovoCrmCacheSyncJob,
  getNovoCrmNightCronStatus,
} from '../services/novoCrmPersonCacheSyncService.js';
import * as novoCrmPersonCacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import {
  previewEnrichment,
  startEnrichmentApplyBackground,
  getEnrichmentJob,
  getRunningEnrichmentJob,
} from '../services/novoCrmEnrichmentService.js';
import {
  previewOrphanAlunoProvision,
  startOrphanAlunoProvisionApplyBackground,
  getOrphanAlunoProvisionJob,
  getRunningOrphanAlunoProvisionJob,
  requestCancelOrphanAlunoProvision,
} from '../services/novoCrmOrphanAlunoProvisionService.js';
import {
  runMatriculadosProvision,
  runMatriculadosProvisionLocked,
  startMatriculadosProvisionApplyBackground,
  isMatriculadosProvisionRunning,
  getMatriculadosProvisionJob,
  getRunningMatriculadosProvisionJob,
  requestCancelMatriculadosProvision,
  isProvisionAllowedOnThisHost,
  isNovoCrmWriteAllowedOnThisHost,
} from '../services/novoCrmMatriculadosProvisionService.js';
import {
  runFlagsStageSync,
  runFlagsStageSyncLocked,
  startFlagsStageSyncBackground,
  isFlagsStageSyncRunning,
  getFlagsStageSyncJob,
  getRunningFlagsStageSyncJob,
  requestCancelFlagsStageSync,
} from '../services/novoCrmFlagsStageSyncService.js';
import * as activationResponseRepo from '../repositories/activationResponseRepository.js';
import { query } from '../db/client.js';
import { migrateMeuPainelLegacyFromLive } from '../repositories/meuPainelLegacyRepository.js';

const router = Router();

/**
 * POST /api/maintenance/clean-stale-origem-ativacao
 *
 * Limpa `origem_ativacao` no CRM para leads que tiveram um SET há mais de
 * `journey_settings.origem_ativacao_stale_hours` (default 72h) sem CLEAR
 * posterior. Idempotente.
 *
 * Query: ?dry_run=true  -> só conta, não chama CRM.
 * Body : { "dry_run": true } -> idem.
 *
 * Response:
 *   { scanned, cleaned, failed, errors[], stale_window_hours, dry_run, ran_at }
 */
router.post('/clean-stale-origem-ativacao', requireApiKey, async (req, res, next) => {
  try {
    const dryRun =
      req.query?.dry_run === 'true' ||
      req.query?.dry_run === '1' ||
      req.body?.dry_run === true;
    const result = await cleanStaleOrigemAtivacao({ dryRun });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/maintenance/clean-stale-activation-tags
 *
 * Remove tags ativacao-* no CRM EduIT para SETs no log local há mais de
 * `journey_settings.origem_ativacao_stale_hours` (mesma janela da origem)
 * sem CLEAR posterior. Idempotente.
 *
 * Query/body: dry_run=true → só conta.
 */
router.post('/clean-stale-activation-tags', requireApiKey, async (req, res, next) => {
  try {
    const dryRun =
      req.query?.dry_run === 'true' ||
      req.query?.dry_run === '1' ||
      req.body?.dry_run === true;
    const result = await cleanStaleActivationTags({ dryRun });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/maintenance/sync-crm-desfechos
 *
 * Lê o campo de desfecho CAA (DATACRAZY_DESFECHO_CAA_FIELD_ID) no CRM
 * para cada lead CAA disparado recentemente. Valores "Sim"/"Não" viram
 * entradas em `activation_manual_outcomes` e o campo é limpo no CRM.
 *
 * Query: ?dry_run=true  -> conta sem gravar.
 *        ?days=N        -> janela de lookback em dias (default: env ou 14).
 *
 * Response:
 *   { scanned, synced_revertido, synced_confirmado, ignored, failed,
 *     errors[], lookback_days, dry_run, ran_at, crm_rate_per_second }
 */
router.post('/sync-crm-desfechos', requireApiKey, async (req, res, next) => {
  try {
    const dryRun =
      req.query?.dry_run === 'true' ||
      req.query?.dry_run === '1' ||
      req.body?.dry_run === true;
    const days = req.query?.days ? Number(req.query.days) : null;
    const result = await syncCaaDesfechos({ dryRun, days });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/maintenance/datacrazy-cache-status
 *
 * Contagem do cache + último sync + se há sync em andamento.
 */
router.get('/datacrazy-cache-status', requireApiKey, async (req, res) => {
  try {
    await datacrazyLeadCacheRepo.closeStaleRunningSyncs();
    const stats = await datacrazyLeadCacheRepo.getCacheStats();
    res.json({
      ok: true,
      cache_count: stats.cache_count,
      running: Boolean(stats.running),
      running_since: stats.running?.started_at ?? null,
      last_sync: stats.last_sync
        ? {
            id: String(stats.last_sync.id),
            started_at: stats.last_sync.started_at,
            finished_at: stats.last_sync.finished_at,
            pages: stats.last_sync.pages_scanned,
            leads_seen: stats.last_sync.leads_seen,
            leads_upserted: stats.last_sync.leads_upserted,
            leads_skipped: stats.last_sync.leads_skipped,
            status: stats.last_sync.status,
            error_message: stats.last_sync.error_message,
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/maintenance/sync-datacrazy-cache
 *
 * Dispara o sync completo do cache cpf → datacrazy_lead_id varrendo todas as
 * páginas da API DataCrazy. Idempotente — pode ser chamado a qualquer hora.
 *
 * Query: ?dryRun=1  → conta sem persistir.
 *        ?async=1   → 202 imediato, sync em background (recomendado na UI).
 *
 * Response:
 *   { logId, pages, leadsSeen, upserted, skipped, durationMs, dry_run }
 */
router.post('/sync-datacrazy-cache', requireApiKey, async (req, res) => {
  try {
    const dryRun = req.query.dryRun === '1';
    const asyncMode = req.query.async === '1' || req.query.async === 'true';

    if (asyncMode) {
      await datacrazyLeadCacheRepo.closeStaleRunningSyncs();
      const stats = await datacrazyLeadCacheRepo.getCacheStats();
      if (stats.running) {
        return res.status(409).json({ error: 'Sync já em andamento', running_since: stats.running.started_at });
      }
      const started = startFullSyncBackground({ dryRun });
      if (!started) {
        return res.status(409).json({ error: 'Sync já em andamento' });
      }
      return res.status(202).json({ ok: true, status: 'running', dry_run: dryRun });
    }

    const result = await runFullSync({ dryRun });
    res.json(result);
  } catch (err) {
    console.error('[sync-datacrazy-cache]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/maintenance/novo-crm-cache-status
 *
 * Status do espelho local do CRM EduIT: contagem, último sync, cursor e
 * regressões abertas.
 */
router.get('/novo-crm-cache-status', requireApiKey, async (_req, res) => {
  try {
    await novoCrmPersonCacheRepo.closeStaleRunningSyncs();
    const stats = await novoCrmPersonCacheRepo.getCacheStats();
    const flagsJob = getRunningFlagsStageSyncJob();
    const orphanJob = getRunningOrphanAlunoProvisionJob();
    const provisionJob = getRunningMatriculadosProvisionJob();
    res.json({
      ok: true,
      cache_total: stats.total,
      cache_active: stats.active,
      missing_cpf: stats.missing_cpf ?? 0,
      missing_rgm: stats.missing_rgm ?? 0,
      incomplete_fields: stats.incomplete_fields ?? 0,
      running: Boolean(stats.running) || Boolean(getRunningNovoCrmCacheSyncJob()),
      running_sync: stats.running,
      running_cache: getRunningNovoCrmCacheSyncJob(),
      night_cron: getNovoCrmNightCronStatus(),
      last_sync: stats.last_sync,
      last_flags_sync: stats.last_flags_sync || null,
      last_fields_sync: stats.last_fields_sync || null,
      last_orphan_dedupe: stats.last_orphan_dedupe || null,
      running_flags: flagsJob
        ? {
            jobId: flagsJob.jobId,
            mode: flagsJob.mode,
            status: flagsJob.status,
            dry_run: flagsJob.dry_run,
            total: flagsJob.total,
            processed: flagsJob.processed,
            sent: flagsJob.sent,
            matched: flagsJob.matched ?? 0,
            flags_updated: flagsJob.flags_updated ?? 0,
            fields_updated: flagsJob.fields_updated ?? 0,
            stages_moved: flagsJob.stages_moved ?? 0,
            eta_ms: flagsJob.eta_ms ?? null,
            phase: flagsJob.phase,
            status_message: flagsJob.status_message,
            started_at: flagsJob.started_at,
            cancel_requested: Boolean(flagsJob.cancel_requested),
          }
        : null,
      running_orphan_dedupe: orphanJob
        ? {
            jobId: orphanJob.jobId,
            status: orphanJob.status,
            dry_run: Boolean(orphanJob.dry_run),
            total: orphanJob.total ?? 0,
            processed: orphanJob.processed ?? 0,
            sent: orphanJob.sent ?? 0,
            failed: orphanJob.failed ?? orphanJob.errors ?? 0,
            eta_ms: orphanJob.eta_ms ?? null,
            phase: orphanJob.phase,
            status_message: orphanJob.status_message,
            started_at: orphanJob.started_at,
            cancel_requested: Boolean(orphanJob.cancel_requested),
            orphans_total: orphanJob.orphans_total ?? 0,
            orphans_processed: orphanJob.orphans_processed ?? 0,
            incomplete_total: orphanJob.incomplete_total ?? 0,
            incomplete_processed: orphanJob.incomplete_processed ?? 0,
            dup_groups: orphanJob.dup_groups ?? 0,
            dup_groups_processed: orphanJob.dup_groups_processed ?? 0,
            already_has_deal: orphanJob.already_has_deal ?? 0,
            would_create: orphanJob.would_create ?? 0,
            live_ok: orphanJob.live_ok ?? 0,
            deal_not_found: orphanJob.deal_not_found ?? 0,
            errors: orphanJob.errors ?? orphanJob.failed ?? 0,
          }
        : null,
      running_provision: provisionJob
        ? {
            jobId: provisionJob.jobId,
            mode: provisionJob.mode,
            status: provisionJob.status,
            dry_run: provisionJob.dry_run,
            total: provisionJob.total ?? 0,
            processed: provisionJob.processed ?? 0,
            sent: provisionJob.sent ?? 0,
            failed: provisionJob.failed ?? 0,
            phase: provisionJob.phase,
            status_message: provisionJob.status_message,
            started_at: provisionJob.started_at,
            cancel_requested: Boolean(provisionJob.cancel_requested),
          }
        : null,
      state: stats.state,
      open_data_loss_events: stats.open_data_loss_events,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/sync-novo-crm-cache?mode=full|incremental&async=1
 *
 * Full é intencionalmente "sem pressa" para rodar de madrugada. Use async=1
 * na operação normal.
 */
router.post('/sync-novo-crm-cache', requireApiKey, async (req, res) => {
  try {
    const mode = req.query.mode === 'full' || req.body?.mode === 'full' ? 'full' : 'incremental';
    const dryRun =
      req.query.dryRun === '1' ||
      req.query.dry_run === 'true' ||
      req.body?.dryRun === true ||
      req.body?.dry_run === true;
    const asyncMode = req.query.async === '1' || req.query.async === 'true' || req.body?.async === true;
    const samplePctRaw = req.query.sample_pct ?? req.query.samplePct ?? req.body?.sample_pct ?? req.body?.samplePct;
    const maxContactsRaw = req.query.max_contacts ?? req.query.maxContacts ?? req.body?.max_contacts ?? req.body?.maxContacts;
    const samplePct = samplePctRaw != null && String(samplePctRaw).trim() !== '' ? Number(samplePctRaw) : null;
    const maxContacts =
      maxContactsRaw != null && String(maxContactsRaw).trim() !== '' ? Number(maxContactsRaw) : null;
    const syncOpts = { mode, dryRun, samplePct, maxContacts };

    if (asyncMode) {
      await novoCrmPersonCacheRepo.closeStaleRunningSyncs();
      const stats = await novoCrmPersonCacheRepo.getCacheStats();
      if (stats.running) {
        return res.status(409).json({
          error: 'Sync Novo CRM já em andamento',
          running_since: stats.running.started_at,
        });
      }
      const started = startNovoCrmCacheSyncBackground(syncOpts);
      if (!started) return res.status(409).json({ error: 'Sync Novo CRM já em andamento' });
      return res.status(202).json({
        ok: true,
        status: 'running',
        mode,
        dry_run: dryRun,
        sample_pct: samplePct,
        max_contacts: maxContacts,
      });
    }

    const result = await runNovoCrmCacheSync(syncOpts);
    res.json(result);
  } catch (err) {
    console.error('[sync-novo-crm-cache]', err);
    const status = err?.status && Number(err.status) >= 400 ? Number(err.status) : 500;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/maintenance/novo-crm-cache-regressions
 */
router.get('/novo-crm-cache-regressions', requireApiKey, async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const acknowledged = req.query.acknowledged === '1' || req.query.acknowledged === 'true';
    const events = await novoCrmPersonCacheRepo.listDataLossEvents({ limit, acknowledged });
    res.json({ ok: true, events });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/novo-crm-cache-regressions/:id/ack
 */
router.post('/novo-crm-cache-regressions/:id/ack', requireApiKey, async (req, res) => {
  try {
    const event = await novoCrmPersonCacheRepo.acknowledgeDataLossEvent(
      req.params.id,
      req.body?.acknowledged_by || req.body?.user || null
    );
    if (!event) return res.status(404).json({ error: 'Evento não encontrado' });
    res.json({ ok: true, event });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/enrich-novo-crm?scope=cpf|rgm|incomplete|all_mapped&dry_run=1|0&async=1
 *
 * dry_run=1 (default): prévia síncrona.
 * dry_run=0&async=1: grava em background.
 */
router.post('/enrich-novo-crm', requireApiKey, async (req, res) => {
  try {
    const scope = String(req.query.scope || req.body?.scope || 'incomplete').trim();
    const forceWrite =
      req.query.dry_run === '0' ||
      req.query.dry_run === 'false' ||
      req.body?.dry_run === false ||
      req.body?.dryRun === false;
    const isDry = !forceWrite;
    const asyncMode =
      req.query.async === '1' || req.query.async === 'true' || req.body?.async === true;

    if (isDry) {
      const preview = await previewEnrichment({ scope });
      return res.json(preview);
    }

    const running = getRunningEnrichmentJob();
    if (running) {
      return res.status(409).json({
        error: 'Enriquecimento já em andamento',
        jobId: running.jobId,
      });
    }
    const started = startEnrichmentApplyBackground({ scope });
    if (!started.started) {
      return res.status(409).json({
        error: started.error || 'Enriquecimento já em andamento',
        jobId: started.jobId,
      });
    }
    return res.status(202).json({
      ok: true,
      status: 'running',
      jobId: started.jobId,
      scope,
      dry_run: false,
      async: Boolean(asyncMode),
    });
  } catch (err) {
    console.error('[enrich-novo-crm]', err);
    const status = err?.status && Number(err.status) >= 400 ? Number(err.status) : 500;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/provision-matriculados-novo-crm
 * ?dry_run=1|0&mode=new|all&max=200&async=1
 *
 * mode=new: snapshot atual ausente do espelho (+ live check). Manual no Sync.
 * mode=all: backlog completo (exige NOVO_CRM_PROVISION_ENABLED=1).
 *
 * Escrita manual: gate de host (ALLOW_PROD). Cron noturno continua exigindo
 * NOVO_CRM_PROVISION_ENABLED=1 (deve ficar OFF em PROD — ver AGENTS.md).
 */
router.post('/provision-matriculados-novo-crm', requireApiKey, async (req, res) => {
  try {
    if (!isProvisionAllowedOnThisHost()) {
      return res.status(403).json({
        error:
          'Provision só no CRM DEV (crm-dev…). Ou NOVO_CRM_PROVISION_ALLOW_PROD=1.',
      });
    }
    const forceWrite =
      req.query.dry_run === '0' ||
      req.query.dry_run === 'false' ||
      req.body?.dry_run === false ||
      req.body?.dryRun === false;
    const reallyDry = !forceWrite;
    const modeRaw = String(req.query.mode || req.body?.mode || 'new').trim().toLowerCase();
    const mode = modeRaw === 'all' || modeRaw === 'full' || modeRaw === 'backfill' ? 'all' : 'new';
    const maxCreates = Number(req.query.max || req.body?.max || req.body?.maxCreates) || undefined;
    const asyncMode =
      req.query.async === '1' || req.query.async === 'true' || req.body?.async === true;

    if (reallyDry) {
      if (asyncMode) {
        const started = startMatriculadosProvisionApplyBackground({
          dryRun: true,
          maxCreates: maxCreates || (mode === 'new' ? 200 : 50),
          mode,
        });
        if (!started.started) {
          return res.status(409).json({
            error: started.error || 'Verificação de leads já em andamento',
            jobId: started.jobId,
          });
        }
        return res.status(202).json({
          ok: true,
          status: 'running',
          jobId: started.jobId,
          dry_run: true,
          mode,
          max_creates: maxCreates || null,
        });
      }
      const preview = await runMatriculadosProvision({
        dryRun: true,
        maxCreates: maxCreates || (mode === 'new' ? 50 : 50),
        mode,
      });
      return res.json(preview);
    }

    // mode=all (backfill) exige PROVISION_ENABLED como kill-switch extra.
    if (
      mode === 'all' &&
      String(process.env.NOVO_CRM_PROVISION_ENABLED || '').trim() !== '1'
    ) {
      return res.status(403).json({
        error: 'mode=all exige NOVO_CRM_PROVISION_ENABLED=1 (backfill controlado).',
      });
    }

    if (isMatriculadosProvisionRunning()) {
      const running = getRunningMatriculadosProvisionJob();
      return res.status(409).json({
        error: 'Provision já em andamento',
        jobId: running?.jobId || null,
      });
    }

    if (asyncMode) {
      const started = startMatriculadosProvisionApplyBackground({
        dryRun: false,
        maxCreates,
        mode,
      });
      if (!started.started) {
        return res.status(409).json({
          error: started.error || 'Provision já em andamento',
          jobId: started.jobId,
        });
      }
      return res.status(202).json({
        ok: true,
        status: 'running',
        jobId: started.jobId,
        dry_run: false,
        mode,
        max_creates: maxCreates || null,
      });
    }

    const result = await runMatriculadosProvisionLocked({ dryRun: false, maxCreates, mode });
    res.json(result);
  } catch (err) {
    console.error('[provision-matriculados-novo-crm]', err);
    const status = err?.status && Number(err.status) >= 400 ? Number(err.status) : 500;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/maintenance/provision-matriculados-novo-crm-status?jobId=
 */
router.get('/provision-matriculados-novo-crm-status', requireApiKey, async (req, res) => {
  try {
    const jobId = req.query.jobId ? String(req.query.jobId) : null;
    const job = jobId
      ? getMatriculadosProvisionJob(jobId)
      : getRunningMatriculadosProvisionJob();
    if (!job) {
      return res.json({ ok: true, running: false, job: null });
    }
    res.json({
      ok: true,
      running: job.status === 'running',
      job: {
        jobId: job.jobId,
        mode: job.mode,
        status: job.status,
        dry_run: job.dry_run,
        total: job.total,
        processed: job.processed,
        sent: job.sent,
        failed: job.failed,
        phase: job.phase,
        status_message: job.status_message,
        started_at: job.started_at,
        finished_at: job.finished_at,
        cancel_requested: Boolean(job.cancel_requested),
        error: job.error,
        result: job.result,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/provision-matriculados-novo-crm-stop?jobId=
 */
router.post('/provision-matriculados-novo-crm-stop', requireApiKey, async (req, res) => {
  try {
    const jobId = req.query.jobId ? String(req.query.jobId) : undefined;
    const r = requestCancelMatriculadosProvision(jobId);
    if (!r.ok) {
      return res.status(404).json({ error: r.error || 'Nenhuma criação/prévia em andamento' });
    }
    res.json({ ok: true, status: r.status, jobId: r.jobId });
  } catch (err) {
    console.error('[provision-matriculados-novo-crm-stop]', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/sync-flags-stage-novo-crm
 * ?dry_run=1|0&mode=flags_stage|fields|both&async=1&max=
 *
 * Atualiza flags (Sim/Não) e/ou move etapa dos deals existentes.
 * Intocáveis: Ganho, Cancelado; Retenção sem CAA open (manual).
 * CAA→Retenção só ≤72h (NOVO_CRM_CAA_RETENCAO_HOURS). Preferir dry_run=1 primeiro.
 */
router.post('/sync-flags-stage-novo-crm', requireApiKey, async (req, res) => {
  try {
    if (!isProvisionAllowedOnThisHost()) {
      return res.status(403).json({
        error:
          'Sync fields/flags bloqueado neste host. Use CRM DEV ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL explícita.',
      });
    }
    const forceWrite =
      req.query.dry_run === '0' ||
      req.query.dry_run === 'false' ||
      req.body?.dry_run === false ||
      req.body?.dryRun === false;
    const reallyDry = !forceWrite;
    const modeRaw = String(req.query.mode || req.body?.mode || 'flags_stage').trim();
    const mode = ['flags_stage', 'fields', 'both'].includes(modeRaw) ? modeRaw : 'flags_stage';
    const maxDeals = Number(req.query.max || req.body?.max || req.body?.maxDeals) || undefined;
    const asyncMode =
      req.query.async === '1' || req.query.async === 'true' || req.body?.async === true;

    if (reallyDry) {
      // Sem max explícito usa 50000 (varrida real, não amostra ~2k que “travava” em ~1900 match).
      const preview = await runFlagsStageSync({
        dryRun: true,
        mode,
        maxDeals: maxDeals || 50000,
      });
      return res.json(preview);
    }

    // Escrita manual (botão «Att de etapas»): só gate de host (check acima).
    // Cron noturno continua exigindo FLAGS_SYNC_ENABLED=1 (manter OFF em PROD).

    if (isFlagsStageSyncRunning()) {
      return res.status(409).json({ error: 'Sync de flags/etapa já em andamento' });
    }

    if (asyncMode) {
      const started = startFlagsStageSyncBackground({
        dryRun: false,
        mode,
        maxDeals,
      });
      if (!started.started) {
        return res.status(409).json({ error: started.error || 'Já em andamento', jobId: started.jobId });
      }
      return res.status(202).json({
        ok: true,
        status: 'running',
        jobId: started.jobId,
        dry_run: false,
        mode,
      });
    }

    const result = await runFlagsStageSyncLocked({ dryRun: false, mode, maxDeals });
    res.json(result);
  } catch (err) {
    console.error('[sync-flags-stage-novo-crm]', err);
    const status = err?.status && Number(err.status) >= 400 ? Number(err.status) : 500;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/sync-flags-stage-novo-crm-stop?jobId=
 * Cancel cooperativo do Att de etapas em andamento.
 */
router.post('/sync-flags-stage-novo-crm-stop', requireApiKey, async (req, res) => {
  try {
    const jobId = req.query.jobId || req.body?.jobId || null;
    const r = requestCancelFlagsStageSync(jobId ? String(jobId) : undefined);
    if (!r.ok) return res.status(409).json(r);
    res.json({ ok: true, status: 'cancelling', jobId: r.jobId });
  } catch (err) {
    console.error('[sync-flags-stage-novo-crm-stop]', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/sync-novo-crm-cache-stop
 * Cancel cooperativo do Full Sync do espelho.
 */
router.post('/sync-novo-crm-cache-stop', requireApiKey, async (_req, res) => {
  try {
    const r = await requestCancelNovoCrmCacheSync();
    if (!r.ok) return res.status(409).json(r);
    res.json({ ok: true, status: r.status || 'cancelling', closed: r.closed });
  } catch (err) {
    console.error('[sync-novo-crm-cache-stop]', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/maintenance/sync-flags-stage-novo-crm-status?jobId=
 */
router.get('/sync-flags-stage-novo-crm-status', requireApiKey, async (req, res) => {
  try {
    const jobId = req.query.jobId ? String(req.query.jobId) : null;
    const job = jobId ? getFlagsStageSyncJob(jobId) : getRunningFlagsStageSyncJob();
    if (!job) {
      return res.json({ ok: true, running: false, job: null });
    }
    res.json({
      ok: true,
      running: job.status === 'running',
      job: {
        jobId: job.jobId,
        mode: job.mode,
        status: job.status,
        dry_run: job.dry_run,
        total: job.total,
        processed: job.processed,
        sent: job.sent,
        matched: job.matched ?? 0,
        flags_updated: job.flags_updated ?? 0,
        stages_moved: job.stages_moved ?? 0,
        eta_ms: job.eta_ms ?? null,
        phase: job.phase,
        status_message: job.status_message,
        started_at: job.started_at,
        finished_at: job.finished_at,
        cancel_requested: Boolean(job.cancel_requested),
        result: job.result,
        error: job.error,
      },
    });
  } catch (err) {
    console.error('[sync-flags-stage-novo-crm-status]', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/maintenance/enrich-novo-crm-status?jobId=
 */
router.get('/enrich-novo-crm-status', requireApiKey, async (req, res) => {
  try {
    const jobId = req.query.jobId ? String(req.query.jobId) : null;
    const job = jobId ? getEnrichmentJob(jobId) : getRunningEnrichmentJob();
    if (!job) {
      return res.json({ ok: true, running: false, job: null });
    }
    res.json({
      ok: true,
      running: job.status === 'running',
      job: {
        jobId: job.jobId,
        scope: job.scope,
        status: job.status,
        dry_run: job.dry_run,
        total: job.total,
        processed: job.processed,
        sent: job.sent,
        failed: job.failed,
        skipped: job.skipped,
        phase: job.phase,
        status_message: job.status_message,
        started_at: job.started_at,
        finished_at: job.finished_at,
        error: job.error,
        result: job.result,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/provision-orphan-alunos-novo-crm?dry_run=1|0&async=1&max=&scope=
 *
 * scope=orphans (legado): não cria deals; criação desativada no backend.
 * scope=incomplete: dedupe contacts COM deal mas sem CPF/RGM —
 *   sibling mais completo → move deals do ruim para Perdido;
 *   sem sibling → empty-only fill CPF/RGM.
 * scope=duplicates: mesma pessoa (mesmo RGM) com 2+ cartões em etapa mexível —
 *   mantém 1 por score (dono → campos → e-mail → telefone → conversa → mais
 *   antigo) e move os outros para Perdido.
 * scope=both: incompletos + duplicados; órfãos são ignorados.
 *
 * Match por e-mail OU telefone. Nunca cria segundo contact.
 * dry_run=1 (default): prévia síncrona.
 * dry_run=0&async=1: grava em background.
 */
router.post('/provision-orphan-alunos-novo-crm', requireApiKey, async (req, res) => {
  try {
    const forceWrite =
      req.query.dry_run === '0' ||
      req.query.dry_run === 'false' ||
      req.body?.dry_run === false ||
      req.body?.dryRun === false;
    const isDry = !forceWrite;
    const maxCreates = Number(req.query.max || req.body?.max || req.body?.maxCreates) || undefined;
    const asyncMode =
      req.query.async === '1' || req.query.async === 'true' || req.body?.async === true;
    // scope: orphans | incomplete | duplicates | both (default orphans para compat; dedupe UI usa both)
    const scopeRaw = String(req.query.scope || req.body?.scope || 'orphans').trim().toLowerCase();
    const scope = ['orphans', 'incomplete', 'duplicates', 'both'].includes(scopeRaw)
      ? scopeRaw
      : 'orphans';

    if (isDry) {
      // A prévia consulta o CRM ao vivo por contact (o espelho gera falsos
      // órfãos), então demora minutos — async=1 devolve jobId para polling.
      if (asyncMode) {
        const started = startOrphanAlunoProvisionApplyBackground({
          maxCreates,
          scope,
          dryRun: true,
        });
        if (!started.started) {
          return res.status(409).json({
            error: started.error || 'Prévia de dedupe já em andamento',
            jobId: started.jobId,
          });
        }
        return res.status(202).json({
          ok: true,
          status: 'running',
          jobId: started.jobId,
          dry_run: true,
          scope,
          max_creates: maxCreates || null,
        });
      }
      const preview = await previewOrphanAlunoProvision({ maxCreates, scope });
      return res.json(preview);
    }

    if (!isNovoCrmWriteAllowedOnThisHost()) {
      return res.status(403).json({
        error:
          'Provisionamento de órfãos bloqueado neste host. Use CRM DEV ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL explícita.',
      });
    }

    const running = getRunningOrphanAlunoProvisionJob();
    if (running) {
      return res.status(409).json({
        error: 'Provisionamento de órfãos já em andamento',
        jobId: running.jobId,
      });
    }
    const started = startOrphanAlunoProvisionApplyBackground({ maxCreates, scope });
    if (!started.started) {
      return res.status(409).json({
        error: started.error || 'Provisionamento de órfãos já em andamento',
        jobId: started.jobId,
      });
    }
    return res.status(202).json({
      ok: true,
      status: 'running',
      jobId: started.jobId,
      dry_run: false,
      async: Boolean(asyncMode),
      scope,
      max_creates: maxCreates || null,
    });
  } catch (err) {
    console.error('[provision-orphan-alunos-novo-crm]', err);
    const status = err?.status && Number(err.status) >= 400 ? Number(err.status) : 500;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/maintenance/provision-orphan-alunos-novo-crm-status?jobId=
 */
router.get('/provision-orphan-alunos-novo-crm-status', requireApiKey, async (req, res) => {
  try {
    const jobId = req.query.jobId ? String(req.query.jobId) : null;
    const job = jobId ? getOrphanAlunoProvisionJob(jobId) : getRunningOrphanAlunoProvisionJob();
    if (!job) {
      return res.json({ ok: true, running: false, job: null });
    }
    res.json({
      ok: true,
      running: job.status === 'running',
      job: {
        jobId: job.jobId,
        status: job.status,
        dry_run: job.dry_run,
        total: job.total ?? 0,
        processed: job.processed ?? 0,
        sent: job.sent ?? 0,
        failed: job.failed ?? job.errors ?? 0,
        eta_ms: job.eta_ms ?? null,
        phase: job.phase,
        status_message: job.status_message,
        started_at: job.started_at,
        finished_at: job.finished_at,
        cancel_requested: Boolean(job.cancel_requested),
        orphans_total: job.orphans_total ?? 0,
        orphans_processed: job.orphans_processed ?? 0,
        incomplete_total: job.incomplete_total ?? 0,
        incomplete_processed: job.incomplete_processed ?? 0,
        dup_groups: job.dup_groups ?? 0,
        dup_groups_processed: job.dup_groups_processed ?? 0,
        already_has_deal: job.already_has_deal ?? 0,
        would_create: job.would_create ?? 0,
        live_ok: job.live_ok ?? 0,
        deal_not_found: job.deal_not_found ?? 0,
        errors: job.errors ?? job.failed ?? 0,
        error: job.error,
        result: job.result,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/provision-orphan-alunos-novo-crm-stop?jobId=
 * Cancel cooperativo da prévia/apply de dedupe órfãos.
 */
router.post('/provision-orphan-alunos-novo-crm-stop', requireApiKey, async (req, res) => {
  try {
    const jobId = req.query.jobId || req.body?.jobId || null;
    const r = requestCancelOrphanAlunoProvision(jobId ? String(jobId) : undefined);
    if (!r.ok) return res.status(409).json(r);
    res.json({ ok: true, status: 'cancelling', jobId: r.jobId });
  } catch (err) {
    console.error('[provision-orphan-alunos-novo-crm-stop]', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/invalidate-datacrazy-cache
 *
 * Invalida entradas do cache. Útil para forçar re-consulta à API.
 *
 * Query: ?all=1       → apaga todo o cache.
 *        ?cpf=<cpf>   → apaga entrada de um CPF específico.
 */
router.post('/invalidate-datacrazy-cache', requireApiKey, async (req, res) => {
  try {
    const cpf = req.query.cpf;
    const all = req.query.all === '1';
    if (all) {
      await query('delete from datacrazy_lead_cache');
      return res.json({ ok: true, invalidated: 'all' });
    }
    if (cpf) {
      await query(
        'delete from datacrazy_lead_cache where cpf = $1',
        [String(cpf).replace(/\D/g, '')]
      );
      return res.json({ ok: true, invalidated: cpf });
    }
    res.status(400).json({ error: 'cpf or all=1 required' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/maintenance/backfill-response-identity
 *
 * Preenche consultor_responsavel_nome, rgm, master_key, datacrazy_lead_id e
 * origem_ativacao faltantes em `activation_responses` usando raw_payload,
 * mv_aluno_por_telefone, datacrazy_lead_cache e activation_dispatch_events.
 *
 * Query:
 *   ?days=N       → janela em dias (default 30)
 *   ?category=X   → filtra por categoria (ex: processos-caa)
 *
 * Response:
 *   { ok, lead_id_payload, consultor, rgm_payload, rgm_lk, rgm_dispatch,
 *     rgm_cache_lead_id, days, category, ran_at }
 */
router.post('/backfill-response-identity', requireApiKey, async (req, res, next) => {
  try {
    const days = req.query.days ? Math.max(1, parseInt(String(req.query.days), 10) || 30) : 30;
    const category = req.query.category ? String(req.query.category).trim() : null;
    const result = await activationResponseRepo.backfillResponsesMissingIdentity({ days, category });
    res.json({ ok: true, ...result, days, category, ran_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/maintenance/sync-response-consultores
 *
 * Backfill consultor de raw_payload + leitura do campo CRM quando vazio.
 * Query: ?days=N (default 30), ?category=processos-caa, ?crm_limit=500
 */
router.post('/sync-response-consultores', requireApiKey, async (req, res, next) => {
  try {
    const days = req.query.days ? Math.max(1, parseInt(String(req.query.days), 10) || 30) : 30;
    const category = req.query.category ? String(req.query.category).trim() : 'processos-caa';
    const crmLimit = req.query.crm_limit
      ? Math.min(Math.max(parseInt(String(req.query.crm_limit), 10) || 500, 1), 2000)
      : 500;
    const result = await syncResponseConsultores({ days, category, crm_limit: crmLimit });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/maintenance/migrate-meu-painel-legacy
 *
 * Snapshot idempotente de activation_responses + outcomes manuais →
 * meu_painel_legacy_outcomes (leitura no Meu Painel Novo CRM).
 */
router.post('/migrate-meu-painel-legacy', requireApiKey, async (req, res) => {
  try {
    const result = await migrateMeuPainelLegacyFromLive();
    res.json({ ok: true, ...result, ran_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

export default router;
