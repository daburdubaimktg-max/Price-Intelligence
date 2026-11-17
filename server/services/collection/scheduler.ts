/**
 * Always-on scheduler.
 *
 * Once a minute it:
 *   1. fires the `schedulerTick` hook (periodic alert checks, Excel mirror refresh, … subscribe to it)
 *   2. starts a collection job for every source that is due
 *   3. retries recently failed jobs after a back-off (bounded by the "maximum automatic retries" setting)
 *
 * Sources that are not fully configured are skipped without creating a job: no attempt is made, so no
 * job is recorded. They show up as "not configured" in the collection health views and are picked up
 * automatically within a minute of being configured.
 */
import type { AppContext } from '../../context.ts';
import { fireHook } from '../../context.ts';
import { placeholders } from '../../db/sqlite.ts';
import { AppError } from '../../lib/errors.ts';
import type { CollectionJob, RunDueResult } from '../../../shared/api/collection.ts';
import { runnableMethods } from './registry.ts';
import {
  drainJobs,
  engine,
  enqueueJob,
  maxAutomaticRetries,
  NON_RETRIABLE_CODES,
  recoverInterruptedJobs,
  retryBackoffMinutes,
  startJob,
} from './runner.ts';
import { checkSource, RETAILER_SELECT } from './sources.ts';
import type { SourceRetailer } from './types.ts';

const TICK_INTERVAL_MS = 60_000;
const FIRST_TICK_DELAY_MS = 5_000;
/** Failures older than this are not retried automatically (e.g. after the server was down for days). */
const RETRY_WINDOW_HOURS = 24;
const MAX_STARTS_PER_TICK = 50;

export interface TickOptions {
  /** Wait for the jobs started by this tick to finish (tests, "run due now"). */
  wait?: boolean;
  /** Skip the schedulerTick hook (used by the "run due sources now" endpoint). */
  skipHooks?: boolean;
}

export interface TickResult extends RunDueResult {
  /** Final state of the started jobs — only when `wait` was requested. */
  finished: CollectionJob[];
}

/** Sources whose schedule says they should run now. */
export function dueRetailers(ctx: AppContext, now: Date): SourceRetailer[] {
  const methods = runnableMethods();
  if (methods.length === 0) return [];
  return ctx.db.all<SourceRetailer>(
    `${RETAILER_SELECT}
     WHERE r.is_active = 1 AND r.is_enabled = 1
       AND r.collection_method IN (${placeholders(methods.length)})
       AND COALESCE(r.collection_frequency, m.default_frequency) <> 'manual'
       AND (r.next_run_at IS NULL OR r.next_run_at <= ?)
       AND NOT EXISTS (SELECT 1 FROM collection_jobs j WHERE j.retailer_id = r.id AND j.status IN ('queued', 'running'))
     ORDER BY COALESCE(r.next_run_at, '') ASC, r.id ASC`,
    [...methods, now.toISOString()],
  );
}

interface RetryCandidate {
  id: number;
  retailer_id: number;
  attempt: number;
  finished_at: string;
  error_code: string | null;
}

/** Failed jobs that are the latest job of their source and whose back-off has elapsed. */
export function retryCandidates(ctx: AppContext, now: Date): RetryCandidate[] {
  const maxRetries = maxAutomaticRetries(ctx);
  if (maxRetries <= 0) return [];
  const since = new Date(now.getTime() - RETRY_WINDOW_HOURS * 3_600_000).toISOString();
  const rows = ctx.db.all<RetryCandidate>(
    `SELECT j.id, j.retailer_id, j.attempt, j.finished_at, j.error_code
     FROM collection_jobs j JOIN retailers r ON r.id = j.retailer_id
     WHERE j.status = 'failed' AND j.attempt <= ? AND j.finished_at IS NOT NULL AND j.finished_at >= ?
       AND r.is_active = 1 AND r.is_enabled = 1
       AND j.id = (SELECT MAX(j2.id) FROM collection_jobs j2 WHERE j2.retailer_id = j.retailer_id)
     ORDER BY j.finished_at ASC
     LIMIT ${MAX_STARTS_PER_TICK}`,
    [maxRetries, since],
  );
  return rows.filter(
    (job) =>
      !(job.error_code && NON_RETRIABLE_CODES.has(job.error_code)) &&
      Date.parse(job.finished_at) + retryBackoffMinutes(job.attempt) * 60_000 <= now.getTime(),
  );
}

/** One scheduler pass. Safe to call at any time; never starts a second job for a source that has one in flight. */
export async function runSchedulerTick(ctx: AppContext, now: Date = new Date(), options: TickOptions = {}): Promise<TickResult> {
  if (!options.skipHooks) fireHook(ctx, ctx.hooks.schedulerTick, now);

  const started: CollectionJob[] = [];
  const skipped: RunDueResult['skipped'] = [];
  const running: Array<Promise<CollectionJob>> = [];
  const startedRetailers = new Set<number>();
  if (engine(ctx).stopping) return { started, skipped, finished: [] };

  for (const retailer of dueRetailers(ctx, now)) {
    if (started.length >= MAX_STARTS_PER_TICK) break;
    const source = checkSource(ctx, retailer);
    if (!source.check.ok) {
      skipped.push({ retailer_id: retailer.id, name: retailer.name, reason: `Not configured: ${source.check.missing.join('; ')}` });
      continue;
    }
    try {
      const job = enqueueJob(ctx, retailer.id, { trigger: 'schedule', scheduledFor: retailer.next_run_at ?? now.toISOString() });
      started.push(job);
      startedRetailers.add(retailer.id);
      running.push(startJob(ctx, job.id));
    } catch (err) {
      skipped.push({ retailer_id: retailer.id, name: retailer.name, reason: err instanceof AppError ? err.message : (err as Error).message });
    }
  }

  for (const candidate of retryCandidates(ctx, now)) {
    if (started.length >= MAX_STARTS_PER_TICK) break;
    if (startedRetailers.has(candidate.retailer_id)) continue;
    try {
      const job = enqueueJob(ctx, candidate.retailer_id, {
        trigger: 'retry',
        parentJobId: candidate.id,
        attempt: candidate.attempt + 1,
        scheduledFor: new Date(Date.parse(candidate.finished_at) + retryBackoffMinutes(candidate.attempt) * 60_000).toISOString(),
      });
      started.push(job);
      startedRetailers.add(candidate.retailer_id);
      running.push(startJob(ctx, job.id));
    } catch (err) {
      ctx.log.warn({ err, jobId: candidate.id }, 'automatic retry could not be queued');
    }
  }

  const finished = options.wait ? await Promise.all(running) : [];
  return { started, skipped, finished };
}

/** Starts the background scheduler. `stop()` waits (bounded) for running jobs before resolving. */
export function startScheduler(ctx: AppContext): { stop(): Promise<void> } {
  const recovered = recoverInterruptedJobs(ctx);
  if (recovered > 0) ctx.log.warn({ recovered }, 'marked collection jobs interrupted by a previous shutdown as failed');

  const state = engine(ctx);
  state.schedulerRunning = true;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<unknown> | null = null;

  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      if (stopped) return;
      inFlight = runSchedulerTick(ctx)
        .catch((err) => ctx.log.error({ err }, 'scheduler tick failed'))
        .finally(() => {
          inFlight = null;
          if (!stopped) schedule(TICK_INTERVAL_MS);
        });
    }, delay);
    // The HTTP server keeps the process alive; the scheduler alone should not.
    timer.unref?.();
  };
  schedule(FIRST_TICK_DELAY_MS);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      state.schedulerRunning = false;
      if (inFlight) await inFlight;
      await drainJobs(ctx);
    },
  };
}
