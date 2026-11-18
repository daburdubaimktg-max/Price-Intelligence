/**
 * Collection runner: owns the life cycle of a collection job.
 *
 *   queued → running → succeeded | partial | failed | not_configured | cancelled
 *
 * A job only ever reports what really happened:
 *   * `not_configured` — nothing was attempted because something required is missing (no network call)
 *   * `failed`         — an attempt was made and nothing could be captured
 *   * `partial`        — some listings were captured, others failed or were not returned
 *   * `succeeded`      — every listing was captured
 * Jobs of the simulated demo source are tagged data_class = 'simulated' and are never counted as real.
 */
import type { AppContext } from '../../context.ts';
import { fireHook } from '../../context.ts';
import { SqliteError } from '../../db/sqlite.ts';
import { AppError, conflict, notFound } from '../../lib/errors.ts';
import { nowIso } from '../../lib/time.ts';
import { COLLECTION_METHOD_LABELS, FREQUENCY_HOURS } from '../../../shared/constants.ts';
import type {
  CollectionJob,
  CollectionTestListingResult,
  CollectionTestResult,
  JobStatus,
  JobTrigger,
} from '../../../shared/api/collection.ts';
import { getSecret, getSetting, retailerSecretName } from '../core.ts';
import { ingestObservations, validateObservations, type ObservationInput } from '../ingestion.ts';
import { connectorFor } from './registry.ts';
import { checkSource, getJob, loadCurrencyCodes, loadKnownIdentifiers, loadListings, loadRetailer } from './sources.ts';
import type { CollectResult, EvidenceDraft, RunLog, SourceListing, SourceRetailer } from './types.ts';

const MAX_CONCURRENT_JOBS = 2;
const MAX_LOG_ROWS_PER_JOB = 1500;

/** Failures that will not go away by trying again: fix the configuration instead. */
export const NON_RETRIABLE_CODES = new Set(['auth_failed', 'config_invalid', 'items_not_found', 'invalid_url', 'blocked_host', 'not_applicable']);

/** Minutes to wait before automatic retry number `attempt` (1 = the first try that failed). */
export function retryBackoffMinutes(attempt: number): number {
  return [2, 10, 30][Math.max(0, attempt - 1)] ?? 60;
}

function jobTimeoutMs(): number {
  const minutes = Number(process.env.PIOS_JOB_TIMEOUT_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000;
}

interface ActiveJob {
  retailerId: number;
  controller: AbortController;
  cancelRequested: boolean;
  done: Promise<CollectionJob>;
}

interface PendingJob {
  jobId: number;
  resolve: (job: CollectionJob) => void;
}

interface EngineState {
  active: Map<number, ActiveJob>;
  pending: PendingJob[];
  stopping: boolean;
  schedulerRunning: boolean;
}

const engines = new WeakMap<AppContext, EngineState>();

export function engine(ctx: AppContext): EngineState {
  let state = engines.get(ctx);
  if (!state) {
    state = { active: new Map(), pending: [], stopping: false, schedulerRunning: false };
    engines.set(ctx, state);
  }
  return state;
}

export function engineCounts(ctx: AppContext): { running: number; queued: number; schedulerRunning: boolean } {
  const state = engine(ctx);
  return { running: state.active.size, queued: state.pending.length, schedulerRunning: state.schedulerRunning };
}

// ---------------------------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------------------------

export interface EnqueueOptions {
  trigger: JobTrigger;
  requestedBy?: number | null;
  parentJobId?: number | null;
  attempt?: number;
  scheduledFor?: string | null;
}

/** Creates a queued job. Refuses people-driven sources and a second job for a retailer that already has one in flight. */
export function enqueueJob(ctx: AppContext, retailerId: number, options: EnqueueOptions): CollectionJob {
  const retailer = loadRetailer(ctx, retailerId);
  if (!retailer) throw notFound('Retailer');
  const connector = connectorFor(retailer.collection_method);
  if (!connector.runnable) {
    throw new AppError(
      409,
      'not_applicable',
      `${retailer.name} is updated through ${COLLECTION_METHOD_LABELS[retailer.collection_method].toLowerCase()}; there is nothing to collect automatically.`,
    );
  }
  if (!retailer.is_active) throw conflict('This retailer is inactive. Reactivate it before collecting.');
  // A job left behind by a process that died long ago must not block this source forever.
  recoverInterruptedJobs(ctx, { retailerId, olderThanMs: jobTimeoutMs() + 5 * 60_000 });
  const inFlight = ctx.db.get<{ id: number }>(
    `SELECT id FROM collection_jobs WHERE retailer_id = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`,
    [retailerId],
  );
  if (inFlight) throw conflict('A collection job is already queued or running for this source', { job_id: inFlight.id });
  const id = ctx.db.run(
    `INSERT INTO collection_jobs (retailer_id, method, trigger_type, data_class, status, attempt, parent_job_id, scheduled_for,
       requested_by, is_demo, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    [
      retailerId,
      retailer.collection_method,
      options.trigger,
      connector.dataClass,
      options.attempt ?? 1,
      options.parentJobId ?? null,
      options.scheduledFor ?? null,
      options.requestedBy ?? null,
      retailer.is_demo,
      nowIso(),
    ],
  ).lastInsertRowid;
  return getJob(ctx, id)!;
}

/** Runs a queued job as soon as a slot is free. Resolves with the finished job; never rejects. */
export function startJob(ctx: AppContext, jobId: number): Promise<CollectionJob> {
  const state = engine(ctx);
  return new Promise<CollectionJob>((resolve) => {
    state.pending.push({ jobId, resolve });
    pump(ctx);
  });
}

function pump(ctx: AppContext): void {
  const state = engine(ctx);
  while (!state.stopping && state.active.size < MAX_CONCURRENT_JOBS && state.pending.length > 0) {
    const next = state.pending.shift()!;
    const controller = new AbortController();
    const entry: ActiveJob = { retailerId: 0, controller, cancelRequested: false, done: Promise.resolve(null as unknown as CollectionJob) };
    state.active.set(next.jobId, entry);
    entry.done = executeJob(ctx, next.jobId, entry).finally(() => {
      state.active.delete(next.jobId);
      pump(ctx);
    });
    void entry.done.then(next.resolve);
  }
}

/** Enqueue + run + wait. Convenience for the scheduler, the API and tests. */
export async function runRetailerNow(ctx: AppContext, retailerId: number, options: EnqueueOptions): Promise<CollectionJob> {
  const job = enqueueJob(ctx, retailerId, options);
  return startJob(ctx, job.id);
}

/** Manual retry of a job that did not fully succeed (typically after the configuration was fixed). */
export function enqueueRetry(ctx: AppContext, jobId: number, requestedBy: number | null): CollectionJob {
  const job = getJob(ctx, jobId);
  if (!job) throw notFound('Collection job');
  if (!['failed', 'partial', 'not_configured', 'cancelled'].includes(job.status)) {
    throw conflict(job.status === 'succeeded' ? 'This job succeeded; there is nothing to retry.' : 'This job is still in progress.');
  }
  return enqueueJob(ctx, job.retailer_id, { trigger: 'retry', requestedBy, parentJobId: job.id, attempt: job.attempt + 1 });
}

/** Stops a queued job before it starts, or asks a running job to stop after its current request. */
export function cancelJob(ctx: AppContext, jobId: number): CollectionJob {
  const job = getJob(ctx, jobId);
  if (!job) throw notFound('Collection job');
  const state = engine(ctx);
  const active = state.active.get(jobId);
  if (active && job.status === 'running') {
    active.cancelRequested = true;
    active.controller.abort();
    return job;
  }
  if (job.status === 'queued') {
    const index = state.pending.findIndex((p) => p.jobId === jobId);
    const pending = index >= 0 ? state.pending.splice(index, 1)[0] : undefined;
    ctx.db.run(
      `UPDATE collection_jobs SET status = 'cancelled', error_code = 'cancelled', error_message = 'Cancelled before it started', finished_at = ? WHERE id = ? AND status = 'queued'`,
      [nowIso(), jobId],
    );
    const cancelled = getJob(ctx, jobId)!;
    pending?.resolve(cancelled);
    return cancelled;
  }
  throw conflict('Only queued or running jobs can be cancelled');
}

/**
 * Jobs that a previous process left queued or running can never finish: mark them failed ("interrupted").
 * Recent ones are picked up again by the automatic retry rule.
 *
 * Called without options when the scheduler starts (the server process owns collection). With
 * `olderThanMs` only jobs that have outlived the maximum job duration are touched — used where another
 * process might legitimately still be running them.
 */
export function recoverInterruptedJobs(ctx: AppContext, options: { olderThanMs?: number; retailerId?: number } = {}): number {
  const state = engine(ctx);
  const mine = new Set<number>([...state.active.keys(), ...state.pending.map((p) => p.jobId)]);
  const cutoff = options.olderThanMs === undefined ? null : new Date(Date.now() - options.olderThanMs).toISOString();
  const orphans = ctx.db
    .all<{ id: number; retailer_id: number; created_at: string; started_at: string | null }>(
      `SELECT id, retailer_id, created_at, started_at FROM collection_jobs WHERE status IN ('queued', 'running')`,
    )
    .filter((j) => !mine.has(j.id))
    .filter((j) => options.retailerId === undefined || j.retailer_id === options.retailerId)
    .filter((j) => cutoff === null || (j.started_at ?? j.created_at) < cutoff);
  if (orphans.length === 0) return 0;
  const now = nowIso();
  const message = 'The server stopped while this job was queued or running, so no result was recorded for it.';
  ctx.db.tx(() => {
    for (const job of orphans) {
      ctx.db.run(`UPDATE collection_jobs SET status = 'failed', error_code = 'interrupted', error_message = ?, finished_at = ? WHERE id = ?`, [
        message,
        now,
        job.id,
      ]);
      ctx.db.run(
        `INSERT INTO collection_logs (job_id, retailer_id, listing_id, level, code, message, detail, created_at) VALUES (?, ?, NULL, 'error', 'interrupted', ?, NULL, ?)`,
        [job.id, job.retailer_id, message, now],
      );
    }
  });
  return orphans.length;
}

/** Waits for running jobs to finish (bounded); remaining ones are asked to stop. */
export async function drainJobs(ctx: AppContext, timeoutMs = 20_000): Promise<void> {
  const state = engine(ctx);
  state.stopping = true;
  for (const pending of state.pending.splice(0)) {
    ctx.db.run(
      `UPDATE collection_jobs SET status = 'cancelled', error_code = 'cancelled', error_message = 'The server was shutting down before this job started', finished_at = ? WHERE id = ? AND status = 'queued'`,
      [nowIso(), pending.jobId],
    );
    const job = getJob(ctx, pending.jobId);
    if (job) pending.resolve(job);
  }
  const running = [...state.active.values()].map((a) => a.done.catch(() => undefined));
  if (running.length > 0) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([Promise.all(running).then(() => 'done' as const), timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      for (const active of state.active.values()) active.controller.abort();
      await Promise.race([Promise.all(running), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    }
  }
  state.stopping = false;
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

interface FinishInfo {
  status: JobStatus;
  errorCode: string | null;
  errorMessage: string | null;
  listingsTotal: number;
  listingsSucceeded: number;
  listingsFailed: number;
  listingsMissing: number;
  observationsCreated: number;
  duplicatesSkipped: number;
  logs: RunLog[];
}

const blankFinish = (status: JobStatus, code: string | null, message: string | null, logs: RunLog[] = []): FinishInfo => ({
  status,
  errorCode: code,
  errorMessage: message,
  listingsTotal: 0,
  listingsSucceeded: 0,
  listingsFailed: 0,
  listingsMissing: 0,
  observationsCreated: 0,
  duplicatesSkipped: 0,
  logs,
});

export function computeNextRun(retailer: Pick<SourceRetailer, 'effective_frequency' | 'next_run_at'>, now: Date): string | null {
  const hours = FREQUENCY_HOURS[retailer.effective_frequency];
  if (!hours) return null;
  const interval = hours * 3_600_000;
  const base = retailer.next_run_at ? Date.parse(retailer.next_run_at) : Number.NaN;
  // Keep the cadence anchored to the planned time when the run was on time; re-anchor after a long gap.
  const anchored = Number.isFinite(base) && base <= now.getTime() && now.getTime() - base < interval;
  return new Date((anchored ? base : now.getTime()) + interval).toISOString();
}

async function executeJob(ctx: AppContext, jobId: number, entry: ActiveJob): Promise<CollectionJob> {
  let finish: FinishInfo;
  let retailer: SourceRetailer | undefined;
  let trigger: JobTrigger = 'manual';
  const startedAt = nowIso();
  try {
    const row = ctx.db.get<{ id: number; retailer_id: number; status: string; attempt: number; trigger_type: JobTrigger }>(
      'SELECT id, retailer_id, status, attempt, trigger_type FROM collection_jobs WHERE id = ?',
      [jobId],
    );
    if (!row) throw new Error(`Collection job ${jobId} does not exist`);
    if (row.status !== 'queued') return getJob(ctx, jobId)!;
    trigger = row.trigger_type;
    entry.retailerId = row.retailer_id;
    retailer = loadRetailer(ctx, row.retailer_id);
    if (!retailer) throw new Error(`Retailer ${row.retailer_id} does not exist`);
    ctx.db.run(`UPDATE collection_jobs SET status = 'running', started_at = ? WHERE id = ?`, [startedAt, jobId]);
    finish = await runCollection(ctx, jobId, row.attempt, retailer, entry);
  } catch (err) {
    ctx.log.error({ err, jobId }, 'collection job crashed');
    const message = `Unexpected error while collecting: ${(err as Error).message}`;
    finish = blankFinish('failed', 'internal_error', message, [{ level: 'error', code: 'internal_error', message }]);
  }
  try {
    finishJob(ctx, jobId, trigger, retailer, startedAt, finish);
    fireHook(ctx, ctx.hooks.collectionJobFinished, jobId);
  } catch (err) {
    ctx.log.error({ err, jobId }, 'could not record the result of a collection job');
  }
  return getJob(ctx, jobId) ?? ({ id: jobId, status: finish.status } as CollectionJob);
}

async function runCollection(ctx: AppContext, jobId: number, attempt: number, retailer: SourceRetailer, entry: ActiveJob): Promise<FinishInfo> {
  const source = checkSource(ctx, retailer);
  if (!source.check.ok) {
    const message = `Not configured — no collection was attempted. Required: ${source.check.missing.join('; ')}.`;
    return blankFinish('not_configured', 'not_configured', message, [
      { level: 'warn', code: 'not_configured', message, detail: { missing: source.check.missing } },
    ]);
  }
  const credential = getSecret(ctx, retailerSecretName(retailer.id));
  if (source.credentialPresent && credential === null) {
    const message = 'Not configured — the stored credential could not be decrypted (has the encryption key changed?). Store the credential again.';
    return blankFinish('not_configured', 'not_configured', message, [{ level: 'warn', code: 'not_configured', message }]);
  }

  const listings = loadListings(ctx, retailer.id);
  const known = loadKnownIdentifiers(ctx, retailer.id);
  const timeout = jobTimeoutMs();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    entry.controller.abort();
  }, timeout);
  let result: CollectResult;
  try {
    result = await source.connector.collect({
      ctx,
      retailer,
      config: source.config,
      credential,
      listings,
      known,
      currencies: loadCurrencyCodes(ctx),
      dryRun: false,
      attempt,
      now: new Date(),
      signal: entry.controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  return persistResult(ctx, jobId, retailer, listings, result, {
    cancelled: entry.cancelRequested,
    timedOut: timedOut && !entry.cancelRequested,
    timeoutMinutes: Math.round(timeout / 60_000),
  });
}

function insertEvidence(ctx: AppContext, draft: EvidenceDraft, isDemo: number): number {
  return ctx.db.run(
    `INSERT INTO source_evidence (kind, reference, sha256, size_bytes, excerpt, captured_at, note, is_demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      draft.kind,
      draft.reference.slice(0, 2000),
      draft.sha256 ?? null,
      draft.size_bytes ?? null,
      draft.excerpt ? draft.excerpt.slice(0, 1000) : null,
      draft.captured_at,
      draft.note ?? null,
      isDemo,
      nowIso(),
    ],
  ).lastInsertRowid;
}

function persistResult(
  ctx: AppContext,
  jobId: number,
  retailer: SourceRetailer,
  listings: SourceListing[],
  result: CollectResult,
  flags: { cancelled: boolean; timedOut: boolean; timeoutMinutes: number },
): FinishInfo {
  const logs: RunLog[] = [...result.logs];
  const failureCodes = new Map<string, number>();
  let firstFailure: string | null = null;
  let failed = 0;
  let missing = 0;
  const inputs: ObservationInput[] = [];
  /** For each input: the configured listing it belongs to, or null for a newly discovered listing. */
  const owners: Array<number | null> = [];
  let discoveredCreated = 0;
  const discoveredListingIds: number[] = [];

  const noteFailure = (code: string, message: string, listingId: number) => {
    failed++;
    failureCodes.set(code, (failureCodes.get(code) ?? 0) + 1);
    firstFailure ??= message;
    logs.push({ level: 'error', code, message, listing_id: listingId });
  };

  ctx.db.tx(() => {
    const evidenceIds = new Map<number, number>();
    const evidenceIdFor = (index: number | undefined): number | null => {
      if (index === undefined) return null;
      const draft = result.evidence[index];
      if (!draft) return null;
      let id = evidenceIds.get(index);
      if (id === undefined) {
        id = insertEvidence(ctx, draft, retailer.is_demo);
        evidenceIds.set(index, id);
      }
      return id;
    };

    for (const outcome of result.outcomes) {
      if (outcome.status === 'ok' && outcome.observation) {
        inputs.push({ ...outcome.observation, listing_id: outcome.listing_id, evidence_id: evidenceIdFor(outcome.evidence) });
        owners.push(outcome.listing_id);
      } else if (outcome.status === 'missing') {
        missing++;
        logs.push({
          level: 'warn',
          code: outcome.code ?? 'listing_missing',
          message: outcome.message ?? 'The source did not return this listing.',
          listing_id: outcome.listing_id,
        });
      } else {
        noteFailure(outcome.code ?? 'failed', outcome.message ?? 'The listing could not be collected.', outcome.listing_id);
      }
    }

    const now = nowIso();
    for (const item of result.discovered) {
      let listingId: number;
      try {
        listingId = ctx.db.run(
          `INSERT INTO retailer_listings (retailer_id, external_id, url, title, gtin, match_status, is_active, is_demo, first_seen_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'unmatched', 1, ?, ?, ?, ?)`,
          [retailer.id, item.external_id, item.url, item.title, item.gtin, retailer.is_demo, now, now, now],
        ).lastInsertRowid;
      } catch (err) {
        if (err instanceof SqliteError && err.code === 'UNIQUE') continue; // already known under another identifier
        throw err;
      }
      discoveredCreated++;
      discoveredListingIds.push(listingId);
      if (item.observation) {
        inputs.push({ ...item.observation, listing_id: listingId, evidence_id: evidenceIdFor(item.evidence) });
        owners.push(null);
      }
    }
  });

  const discoveredWithoutPrice = result.discovered.filter((d) => !d.observation).length;
  if (discoveredCreated > 0 && discoveredWithoutPrice > 0) {
    logs.push({
      level: 'warn',
      code: 'discovered_without_price',
      message: `${discoveredWithoutPrice} newly found item(s) had no readable price; the listings were added without an observation.`,
    });
  }
  if (discoveredCreated > 0) {
    logs.push({
      level: 'info',
      code: 'listings_discovered',
      message: `${discoveredCreated} new listing(s) found at the source were added as unmatched. Review them in Product Catalogue → Matching; they are never matched automatically.`,
    });
  }

  const ingest = ingestObservations(ctx, inputs, { sourceMethod: retailer.collection_method, jobId });
  if (discoveredListingIds.length > 0) {
    // After ingestion, so subscribers (the "new product" alert) can read the first observation of each listing.
    fireHook(ctx, ctx.hooks.listingsDiscovered, {
      jobId,
      retailerId: retailer.id,
      listingIds: discoveredListingIds,
      sourceMethod: retailer.collection_method,
      isDemo: !!retailer.is_demo,
    });
  }
  const rejected = new Set<number>();
  for (const rejection of ingest.rejected) {
    rejected.add(rejection.index);
    const owner = owners[rejection.index];
    if (owner !== null && owner !== undefined) noteFailure('rejected', `The value read from the source was rejected: ${rejection.reason}`, owner);
    else logs.push({ level: 'warn', code: 'rejected', message: `A value for a newly discovered listing was rejected: ${rejection.reason}`, listing_id: rejection.listing_id });
  }
  // Every accepted reading belongs to exactly one listing (configured or newly discovered).
  const accepted = inputs.length - rejected.size;
  const succeeded = accepted;

  const info: FinishInfo = {
    status: 'succeeded',
    errorCode: null,
    errorMessage: null,
    listingsTotal: listings.length + discoveredCreated,
    listingsSucceeded: succeeded,
    listingsFailed: failed,
    listingsMissing: missing,
    observationsCreated: ingest.inserted,
    duplicatesSkipped: ingest.duplicates,
    logs,
  };

  const summariseFailures = (): { code: string; message: string } => {
    const ranked = [...failureCodes.entries()].sort((a, b) => b[1] - a[1]);
    const code = ranked[0]?.[0] ?? 'listing_missing';
    const parts: string[] = [];
    if (failed > 0) parts.push(`${failed} of ${listings.length} listing(s) failed (${ranked.map(([c, n]) => `${c}: ${n}`).join(', ')})`);
    if (missing > 0) parts.push(`${missing} listing(s) were not returned by the source`);
    return { code, message: `${parts.join('; ')}.${firstFailure ? ` First error: ${firstFailure}` : ''}` };
  };

  const notAttempted = listings.length - result.outcomes.length;
  if (notAttempted > 0 && (flags.cancelled || flags.timedOut || result.fatal)) {
    logs.push({
      level: 'warn',
      code: 'not_attempted',
      message: `${notAttempted} listing(s) were not attempted because the run stopped early.`,
    });
  }

  if (flags.cancelled) {
    info.status = 'cancelled';
    info.errorCode = 'cancelled';
    info.errorMessage = `Cancelled by a user.${ingest.inserted > 0 ? ` ${ingest.inserted} observation(s) captured before the stop were kept.` : ''}`;
    logs.push({ level: 'warn', code: 'cancelled', message: info.errorMessage });
  } else if (flags.timedOut || result.fatal) {
    const fatal = flags.timedOut
      ? {
          code: 'timeout',
          message: `The run exceeded the maximum duration of ${flags.timeoutMinutes} minutes and was stopped. Listings not reached are tried first on the next run.`,
        }
      : result.fatal!;
    info.status = accepted > 0 ? 'partial' : 'failed';
    info.errorCode = fatal.code;
    info.errorMessage = fatal.message;
    logs.push({ level: 'error', code: fatal.code, message: fatal.message });
  } else if (accepted === 0) {
    info.status = 'failed';
    if (failed + missing > 0) {
      const summary = summariseFailures();
      info.errorCode = summary.code;
      info.errorMessage = summary.message;
    } else {
      info.errorCode = 'no_items';
      info.errorMessage = 'The source returned nothing that could be collected.';
      logs.push({ level: 'error', code: 'no_items', message: info.errorMessage });
    }
  } else if (failed + missing > 0) {
    const summary = summariseFailures();
    info.status = 'partial';
    info.errorCode = summary.code;
    info.errorMessage = summary.message;
  }

  const simulated = retailer.collection_method === 'simulated';
  logs.push({
    level: 'info',
    code: 'run_summary',
    message:
      `${simulated ? 'Simulated demo run' : 'Run'} finished: ${info.listingsSucceeded} listing(s) captured, ${failed} failed, ${missing} missing; ` +
      `${ingest.inserted} observation(s) stored, ${ingest.duplicates} identical re-read(s) skipped` +
      `${ingest.superseded > 0 ? `, ${ingest.superseded} superseded` : ''}; ${result.requests} request(s) made` +
      `${result.itemsFound !== null && !simulated ? `, ${result.itemsFound} item(s) returned by the source` : ''}.`,
  });
  return info;
}

function finishJob(
  ctx: AppContext,
  jobId: number,
  trigger: JobTrigger,
  retailer: SourceRetailer | undefined,
  startedAt: string,
  info: FinishInfo,
): void {
  const finishedAt = nowIso();
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE collection_jobs SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ?, listings_total = ?, listings_succeeded = ?,
         listings_failed = ?, listings_missing = ?, observations_created = ?, duplicates_skipped = ?, error_code = ?, error_message = ?
       WHERE id = ?`,
      [
        info.status,
        startedAt,
        finishedAt,
        info.listingsTotal,
        info.listingsSucceeded,
        info.listingsFailed,
        info.listingsMissing,
        info.observationsCreated,
        info.duplicatesSkipped,
        info.errorCode,
        info.errorMessage ? info.errorMessage.slice(0, 2000) : null,
        jobId,
      ],
    );
    if (!retailer) return;

    const logs = info.logs.length > MAX_LOG_ROWS_PER_JOB ? info.logs.slice(0, MAX_LOG_ROWS_PER_JOB) : info.logs;
    for (const log of logs) {
      ctx.db.run(
        `INSERT INTO collection_logs (job_id, retailer_id, listing_id, level, code, message, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          jobId,
          retailer.id,
          log.listing_id ?? null,
          log.level,
          log.code,
          log.message.slice(0, 2000),
          log.detail === undefined ? null : JSON.stringify(log.detail),
          finishedAt,
        ],
      );
    }
    if (info.logs.length > MAX_LOG_ROWS_PER_JOB) {
      ctx.db.run(
        `INSERT INTO collection_logs (job_id, retailer_id, listing_id, level, code, message, detail, created_at) VALUES (?, ?, NULL, 'warn', 'logs_truncated', ?, NULL, ?)`,
        [jobId, retailer.id, `${info.logs.length - MAX_LOG_ROWS_PER_JOB} further log entries of this run were not stored individually.`, finishedAt],
      );
    }

    // Source bookkeeping. `not_configured` made no attempt, so it neither counts as an attempt nor as a failure.
    const attempted = info.status !== 'not_configured';
    const success = info.status === 'succeeded' || info.status === 'partial';
    const current = loadRetailer(ctx, retailer.id) ?? retailer;
    let nextRun = current.next_run_at;
    if (trigger === 'schedule' || (current.next_run_at === null && attempted && info.status !== 'cancelled')) {
      nextRun = computeNextRun(current, new Date(finishedAt));
    }
    ctx.db.run(
      `UPDATE retailers SET
         last_attempt_at = CASE WHEN ? = 1 THEN ? ELSE last_attempt_at END,
         last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
         consecutive_failures = CASE WHEN ? = 1 THEN 0 WHEN ? = 1 THEN consecutive_failures + 1 ELSE consecutive_failures END,
         next_run_at = ?
       WHERE id = ?`,
      [attempted, startedAt, success, finishedAt, success, info.status === 'failed', nextRun, retailer.id],
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Dry run ("test connection")
// ---------------------------------------------------------------------------------------------

/**
 * Fetches and parses exactly as a real run would — with as few requests as possible — but stores
 * nothing: no observations, no evidence, no listings, no job. Returns what it found and why anything failed.
 */
export async function testRetailer(ctx: AppContext, retailerId: number, options: { limit?: number } = {}): Promise<CollectionTestResult> {
  const retailer = loadRetailer(ctx, retailerId);
  if (!retailer) throw notFound('Retailer');
  const source = checkSource(ctx, retailer);
  if (!source.connector.runnable) {
    throw new AppError(
      409,
      'not_applicable',
      `${retailer.name} is updated through ${COLLECTION_METHOD_LABELS[retailer.collection_method].toLowerCase()}; there is no connection to test.`,
    );
  }
  const started = Date.now();
  const base: CollectionTestResult = {
    retailer_id: retailer.id,
    method: retailer.collection_method,
    dry_run: true,
    configured: source.check.ok,
    missing: source.check.missing,
    ok: false,
    requests: 0,
    duration_ms: 0,
    items_found: null,
    listings_tested: 0,
    listings_matched: 0,
    listings_missing: 0,
    listings_failed: 0,
    would_discover: 0,
    fatal: null,
    results: [],
    sample_items: [],
    logs: [],
    note: 'Test run: nothing was stored.',
  };
  if (!source.check.ok) {
    base.note = 'Not configured — no request was made and nothing was stored.';
    return base;
  }
  const credential = getSecret(ctx, retailerSecretName(retailer.id));
  if (source.credentialPresent && credential === null) {
    base.configured = false;
    base.missing = ['The stored credential could not be decrypted — store it again'];
    base.note = 'Not configured — no request was made and nothing was stored.';
    return base;
  }

  const allListings = loadListings(ctx, retailer.id);
  const limit = Math.min(10, Math.max(1, options.limit ?? 3));
  const listings = source.connector.requestsPerListing(source.config) ? allListings.slice(0, limit) : allListings;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let result: CollectResult;
  try {
    result = await source.connector.collect({
      ctx,
      retailer,
      config: source.config,
      credential,
      listings,
      known: loadKnownIdentifiers(ctx, retailer.id),
      currencies: loadCurrencyCodes(ctx),
      dryRun: true,
      attempt: 1,
      now: new Date(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  // Run the same validation a real run applies, without writing anything.
  const okOutcomes = result.outcomes.filter((o) => o.status === 'ok' && o.observation);
  const validation = validateObservations(
    ctx,
    okOutcomes.map((o) => ({ ...o.observation!, listing_id: o.listing_id })),
  );
  const normalised = new Map(validation.valid.map((v) => [okOutcomes[v.index]!.listing_id, v.row]));
  const rejections = new Map(validation.rejected.map((r) => [okOutcomes[r.index]!.listing_id, r.reason]));
  const byId = new Map(allListings.map((l) => [l.id, l]));

  const results: CollectionTestListingResult[] = result.outcomes.map((outcome) => {
    const listing = byId.get(outcome.listing_id);
    const row = normalised.get(outcome.listing_id);
    const rejection = rejections.get(outcome.listing_id);
    const status = outcome.status === 'ok' && rejection ? 'failed' : outcome.status;
    return {
      listing_id: outcome.listing_id,
      listing_code: listing?.code ?? null,
      title: listing?.title ?? null,
      url: listing?.url ?? null,
      status,
      code: rejection ? 'rejected' : (outcome.code ?? null),
      message: rejection ? `The value read from the source would be rejected: ${rejection}` : (outcome.message ?? null),
      strategy: outcome.strategy ?? null,
      observation:
        status === 'ok' && row
          ? {
              current_price: row.current_price,
              regular_price: row.regular_price,
              promo_price: row.promo_price,
              discount_pct: row.discount_pct,
              availability: row.availability,
              currency_code: row.currency_code,
              confidence: row.confidence,
            }
          : null,
      excerpt: outcome.excerpt ?? null,
    };
  });
  for (const item of result.discovered.slice(0, 25)) {
    results.push({
      listing_id: null,
      listing_code: null,
      title: item.title,
      url: item.url,
      status: 'would_discover',
      code: null,
      message: `Not a configured listing${item.external_id ? ` (item id ${item.external_id})` : ''}; a real run would add it as an unmatched listing.`,
      strategy: null,
      observation: item.observation
        ? {
            current_price: item.observation.current_price ?? null,
            regular_price: item.observation.regular_price ?? null,
            promo_price: item.observation.promo_price ?? null,
            discount_pct: item.observation.discount_pct ?? null,
            availability: item.observation.availability ?? null,
            currency_code: item.observation.currency_code ?? null,
            confidence: item.observation.confidence ?? null,
          }
        : null,
      excerpt: null,
    });
  }

  const matched = results.filter((r) => r.status === 'ok').length;
  const logs = result.logs.map((l) => ({ level: l.level, code: l.code, message: l.message }));
  if (source.connector.requestsPerListing(source.config) && allListings.length > listings.length) {
    logs.push({ level: 'info', code: 'dry_run_sample', message: `Test run: ${listings.length} of ${allListings.length} listings were tried to keep the number of requests small.` });
  }
  return {
    ...base,
    ok: matched > 0 && !result.fatal,
    requests: result.requests,
    duration_ms: Date.now() - started,
    items_found: result.itemsFound,
    listings_tested: listings.length,
    listings_matched: matched,
    listings_missing: results.filter((r) => r.status === 'missing').length,
    listings_failed: results.filter((r) => r.status === 'failed').length,
    would_discover: result.discovered.length,
    fatal: result.fatal,
    results,
    sample_items: result.sample,
    logs,
    note:
      retailer.collection_method === 'simulated'
        ? 'Test run of the simulated demo source: these are illustrative DEMO values, not real prices. Nothing was stored.'
        : 'Test run: nothing was stored.',
  };
}

export function maxAutomaticRetries(ctx: AppContext): number {
  const value = Number(getSetting(ctx, 'collection_max_retries'));
  return Number.isFinite(value) ? Math.min(5, Math.max(0, Math.floor(value))) : 2;
}
