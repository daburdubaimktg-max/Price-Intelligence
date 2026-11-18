/**
 * Collection health: what is configured, what actually ran, what failed and where the data in the ledger
 * came from. Real and simulated activity are always reported separately, and a source that has not been
 * configured — or has never run — is never presented as healthy.
 */
import type { AppContext } from '../../context.ts';
import { placeholders } from '../../db/sqlite.ts';
import { likePattern } from '../../lib/http.ts';
import { notFound } from '../../lib/errors.ts';
import {
  COLLECTION_METHOD_LABELS,
  DATA_CLASS_LABELS,
  DATA_CLASSES,
  FREQUENCIES,
  staleAfterHours,
  type DataClass,
} from '../../../shared/constants.ts';
import type {
  CollectionDailyStats,
  CollectionHealth,
  CollectionJob,
  CollectionSource,
  JobClassStats,
  JobDataClass,
  ProvenanceRow,
  SourceConfigStatus,
  SourceStatus,
} from '../../../shared/api/collection.ts';
import { engineCounts } from './runner.ts';
import { checkSource, JOB_SELECT, loadRetailer, mapJob, RETAILER_SELECT } from './sources.ts';
import type { SourceRetailer } from './types.ts';

export interface SourceFilters {
  market_ids?: number[];
  methods?: string[];
  statuses?: string[];
  search?: string;
  include_inactive?: boolean;
  retailer_ids?: number[];
}

interface ListingStats {
  retailer_id: number;
  active: number;
  unmatched: number;
  never_observed: number;
  stale: number;
  last_observed_at: string | null;
}

function listingStats(ctx: AppContext, now: Date): Map<number, ListingStats> {
  const cutoff = (frequency: (typeof FREQUENCIES)[number]) => new Date(now.getTime() - staleAfterHours(frequency) * 3_600_000).toISOString();
  const rows = ctx.db.all<ListingStats>(
    `SELECT l.retailer_id,
       SUM(CASE WHEN l.is_active = 1 AND l.match_status <> 'ignored' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN l.is_active = 1 AND l.match_status = 'unmatched' THEN 1 ELSE 0 END) AS unmatched,
       SUM(CASE WHEN l.is_active = 1 AND l.match_status <> 'ignored' AND s.last_observed_at IS NULL THEN 1 ELSE 0 END) AS never_observed,
       SUM(CASE WHEN l.is_active = 1 AND l.match_status <> 'ignored' AND (s.last_observed_at IS NULL OR s.last_observed_at <
             CASE COALESCE(r.collection_frequency, m.default_frequency)
               WHEN '6h' THEN ? WHEN '12h' THEN ? WHEN 'daily' THEN ? WHEN 'weekly' THEN ? ELSE ? END)
           THEN 1 ELSE 0 END) AS stale,
       MAX(s.last_observed_at) AS last_observed_at
     FROM retailer_listings l
     JOIN retailers r ON r.id = l.retailer_id
     JOIN markets m ON m.id = r.market_id
     LEFT JOIN listing_state s ON s.listing_id = l.id
     GROUP BY l.retailer_id`,
    [cutoff('6h'), cutoff('12h'), cutoff('daily'), cutoff('weekly'), cutoff('manual')],
  );
  return new Map(rows.map((r) => [r.retailer_id, r]));
}

function latestJobs(ctx: AppContext, onlyAttempts: boolean): Map<number, CollectionJob> {
  const filter = onlyAttempts ? `WHERE status IN ('succeeded', 'partial', 'failed')` : '';
  const rows = ctx.db.all<Omit<CollectionJob, 'duration_ms'>>(
    `${JOB_SELECT} WHERE j.id IN (SELECT MAX(id) FROM collection_jobs ${filter} GROUP BY retailer_id)`,
  );
  return new Map(rows.map((r) => [r.retailer_id, mapJob(r)]));
}

function credentialRetailers(ctx: AppContext): Set<number> {
  const ids = new Set<number>();
  for (const row of ctx.db.all<{ name: string }>(`SELECT name FROM secrets WHERE name LIKE 'retailer:%:credential'`)) {
    const id = Number(row.name.split(':')[1]);
    if (Number.isInteger(id)) ids.add(id);
  }
  return ids;
}

function describeStatus(
  retailer: SourceRetailer,
  runnable: boolean,
  configOk: boolean,
  missing: string[],
  latestAttempt: CollectionJob | undefined,
  stats: ListingStats | undefined,
): { status: SourceStatus; reason: string } {
  if (!retailer.is_active) return { status: 'paused', reason: 'This retailer is inactive.' };
  if (!runnable) {
    const how = retailer.collection_method === 'manual' ? 'Prices are entered manually by your team' : 'Prices are uploaded as CSV / Excel files';
    const last = stats?.last_observed_at ? `; the latest observation is from ${stats.last_observed_at.slice(0, 10)}` : '; no observation has been recorded yet';
    return { status: 'manual', reason: `${how} — nothing is collected automatically${last}.` };
  }
  if (!retailer.is_enabled) return { status: 'paused', reason: 'Collection is paused for this source.' };
  if (!configOk) return { status: 'not_configured', reason: `Not configured — nothing is being collected. Required: ${missing.join('; ')}.` };
  if (retailer.collection_method === 'simulated') {
    const lastFailed = latestAttempt?.status === 'failed' ? ' Its last run was a simulated failure (demo).' : '';
    return { status: 'simulated', reason: `Simulated demo source: generates illustrative DEMO data and is not a real integration.${lastFailed}` };
  }
  if (!latestAttempt) {
    // "Nothing captured" is only said when it is true: listings may already hold observations from an import,
    // manual entry or a run that was cancelled part-way.
    const stored = stats?.last_observed_at
      ? ` Its listings already hold observations (latest ${stats.last_observed_at.slice(0, 10)}) from an import, manual entry or an interrupted run.`
      : ' Nothing has been captured from this source so far.';
    return { status: 'pending', reason: `Configured, but no collection run has finished yet.${stored}` };
  }
  if (latestAttempt.status === 'failed') {
    const streak = retailer.consecutive_failures > 1 ? ` (${retailer.consecutive_failures} failed runs in a row)` : '';
    return { status: 'failing', reason: `Last run failed${streak}: ${latestAttempt.error_message ?? 'no details recorded'}` };
  }
  if (latestAttempt.status === 'partial') {
    const total = Math.max(1, latestAttempt.listings_total);
    const share = latestAttempt.listings_succeeded / total;
    const text = `Last run captured ${latestAttempt.listings_succeeded} of ${latestAttempt.listings_total} listings: ${latestAttempt.error_message ?? 'some listings were not captured'}`;
    return { status: share >= 0.5 ? 'healthy' : 'failing', reason: text };
  }
  return { status: 'healthy', reason: `Last run captured all ${latestAttempt.listings_succeeded} listing(s).` };
}

/** Every source with its computed status. */

/** The provider price per 1,000 items entered in a source's settings (USD), or null when absent or not a sensible number. */
function costPer1000(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 10_000) / 10_000 : null;
}

export function listSources(ctx: AppContext, filters: SourceFilters = {}, now: Date = new Date()): CollectionSource[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (!filters.include_inactive) conditions.push('r.is_active = 1');
  if (filters.market_ids?.length) {
    conditions.push(`r.market_id IN (${placeholders(filters.market_ids.length)})`);
    params.push(...filters.market_ids);
  }
  if (filters.retailer_ids?.length) {
    conditions.push(`r.id IN (${placeholders(filters.retailer_ids.length)})`);
    params.push(...filters.retailer_ids);
  }
  if (filters.methods?.length) {
    conditions.push(`r.collection_method IN (${placeholders(filters.methods.length)})`);
    params.push(...filters.methods);
  }
  if (filters.search) {
    conditions.push(`(r.name LIKE ? ESCAPE '\\' OR r.website LIKE ? ESCAPE '\\')`);
    const pattern = likePattern(filters.search);
    params.push(pattern, pattern);
  }
  const retailers = ctx.db.all<SourceRetailer>(
    `${RETAILER_SELECT} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY m.sort_order, m.name, r.name`,
    params,
  );
  const stats = listingStats(ctx, now);
  const latestAny = latestJobs(ctx, false);
  const latestAttempts = latestJobs(ctx, true);
  const credentials = credentialRetailers(ctx);

  const sources: CollectionSource[] = retailers.map((retailer) => {
    const st = stats.get(retailer.id);
    const credentialPresent = credentials.has(retailer.id);
    const source = checkSource(ctx, retailer, { credentialPresent, activeListings: st?.active ?? 0 });
    const attempt = latestAttempts.get(retailer.id);
    const { status, reason } = describeStatus(retailer, source.connector.runnable, source.check.ok, source.check.missing, attempt, st);
    return {
      retailer_id: retailer.id,
      name: retailer.name,
      website: retailer.website,
      market_id: retailer.market_id,
      market_code: retailer.market_code,
      market_name: retailer.market_name,
      country_code: retailer.country_code,
      currency_code: retailer.currency_code,
      timezone: retailer.timezone,
      method: retailer.collection_method,
      method_label: COLLECTION_METHOD_LABELS[retailer.collection_method],
      frequency: retailer.effective_frequency,
      frequency_inherited: retailer.collection_frequency === null,
      is_enabled: retailer.is_enabled,
      is_active: retailer.is_active,
      is_demo: retailer.is_demo,
      status,
      status_reason: reason,
      runnable: source.connector.runnable,
      config_ok: source.check.ok,
      missing: source.check.missing,
      credential_configured: credentialPresent,
      permission_attested: retailer.permission_attested,
      last_attempt_at: retailer.last_attempt_at,
      last_success_at: retailer.last_success_at,
      next_run_at: source.connector.runnable && retailer.is_enabled && retailer.effective_frequency !== 'manual' ? retailer.next_run_at : null,
      consecutive_failures: retailer.consecutive_failures,
      listings_active: st?.active ?? 0,
      listings_unmatched: st?.unmatched ?? 0,
      listings_captured_last_run: attempt ? attempt.listings_succeeded : null,
      listings_missing_last_run: attempt ? attempt.listings_missing : null,
      listings_failed_last_run: attempt ? attempt.listings_failed : null,
      listings_stale: st?.stale ?? 0,
      listings_never_observed: st?.never_observed ?? 0,
      cost_per_1000: costPer1000(source.config.cost_per_1000),
      last_observed_at: st?.last_observed_at ?? null,
      latest_job: latestAny.get(retailer.id) ?? null,
    };
  });
  return filters.statuses?.length ? sources.filter((s) => filters.statuses!.includes(s.status)) : sources;
}

interface ProvenanceAggregate {
  data_class: DataClass;
  total: number;
  voided: number;
  listings: number;
  demo: number;
  first_observed_at: string | null;
  last_observed_at: string | null;
}

const provenanceCache = new WeakMap<AppContext, { key: string; at: number; rows: ProvenanceAggregate[] }>();
const PROVENANCE_MAX_AGE_MS = 5 * 60_000;

/**
 * Where the observations in the ledger came from. This is a full scan, so the result is reused while
 * the ledger is unchanged. The ledger only changes by appending rows, voiding rows, or purging the DEMO
 * dataset (which also removes the per-listing state rows) — all three are visible in the cheap key below.
 */
function ledgerProvenance(ctx: AppContext): ProvenanceAggregate[] {
  const key = [
    ctx.db.scalar<number>('SELECT MAX(id) FROM price_observations') ?? 0,
    ctx.db.scalar<number>('SELECT MIN(id) FROM price_observations') ?? 0,
    ctx.db.scalar<number>('SELECT COUNT(*) FROM observation_voids') ?? 0,
    ctx.db.scalar<number>('SELECT COUNT(*) FROM listing_state') ?? 0,
  ].join(':');
  const cached = provenanceCache.get(ctx);
  if (cached && cached.key === key && Date.now() - cached.at < PROVENANCE_MAX_AGE_MS) return cached.rows;
  const rows = ctx.db.all<ProvenanceAggregate>(
    `SELECT o.data_class, COUNT(*) AS total, COUNT(v.observation_id) AS voided, COUNT(DISTINCT o.listing_id) AS listings,
       COALESCE(SUM(o.is_demo), 0) AS demo, MIN(o.observed_at) AS first_observed_at, MAX(o.observed_at) AS last_observed_at
     FROM price_observations o LEFT JOIN observation_voids v ON v.observation_id = o.id
     GROUP BY o.data_class`,
  );
  provenanceCache.set(ctx, { key, at: Date.now(), rows });
  return rows;
}

function emptyClassStats(dataClass: JobDataClass): JobClassStats {
  return {
    data_class: dataClass,
    attempts: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    not_configured: 0,
    cancelled: 0,
    success_rate: null,
    observations_created: 0,
    listings_failed: 0,
    listings_missing: 0,
  };
}

export function collectionHealth(ctx: AppContext, windowDays = 14, now: Date = new Date()): CollectionHealth {
  const days = Math.min(365, Math.max(1, Math.floor(windowDays) || 14));
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const sources = listSources(ctx, {}, now);

  const count = (status: SourceStatus) => sources.filter((s) => s.status === status).length;
  const healthy = count('healthy');
  const failing = count('failing');
  const pending = count('pending');

  // ---- job statistics in the window, per data class (never blended) --------------------------
  const window: Record<JobDataClass, JobClassStats> = { real: emptyClassStats('real'), simulated: emptyClassStats('simulated') };
  const statusRows = ctx.db.all<{ data_class: JobDataClass; status: string; n: number; observations: number; failed: number; missing: number }>(
    `SELECT data_class, status, COUNT(*) AS n, COALESCE(SUM(observations_created), 0) AS observations,
       COALESCE(SUM(listings_failed), 0) AS failed, COALESCE(SUM(listings_missing), 0) AS missing
     FROM collection_jobs WHERE created_at >= ? GROUP BY data_class, status`,
    [since],
  );
  for (const row of statusRows) {
    const stats = window[row.data_class];
    if (!stats) continue;
    if (row.status === 'succeeded' || row.status === 'partial' || row.status === 'failed') {
      stats[row.status] += row.n;
      stats.attempts += row.n;
    } else if (row.status === 'not_configured' || row.status === 'cancelled') {
      stats[row.status] += row.n;
    }
    stats.observations_created += row.observations;
    stats.listings_failed += row.failed;
    stats.listings_missing += row.missing;
  }
  for (const stats of Object.values(window)) {
    stats.success_rate = stats.attempts > 0 ? Math.round((stats.succeeded / stats.attempts) * 1000) / 1000 : null;
  }

  // ---- latest run of every source ------------------------------------------------------------
  const latest: CollectionHealth['latest_runs'] = {
    real: { sources: 0, listings_captured: 0, products_captured: 0, listings_missing: 0, listings_failed: 0 },
    simulated: { sources: 0, listings_captured: 0, products_captured: 0, listings_missing: 0, listings_failed: 0 },
  };
  const latestRows = ctx.db.all<{ id: number; data_class: JobDataClass; listings_succeeded: number; listings_missing: number; listings_failed: number }>(
    `SELECT j.id, j.data_class, j.listings_succeeded, j.listings_missing, j.listings_failed
     FROM collection_jobs j JOIN retailers r ON r.id = j.retailer_id
     WHERE r.is_active = 1
       AND j.id IN (SELECT MAX(id) FROM collection_jobs WHERE status IN ('succeeded', 'partial', 'failed') GROUP BY retailer_id)`,
  );
  for (const row of latestRows) {
    const bucket = latest[row.data_class];
    if (!bucket) continue;
    bucket.sources++;
    bucket.listings_captured += row.listings_succeeded;
    bucket.listings_missing += row.listings_missing;
    bucket.listings_failed += row.listings_failed;
  }
  for (const dataClass of ['real', 'simulated'] as const) {
    const ids = latestRows.filter((r) => r.data_class === dataClass).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      latest[dataClass].products_captured +=
        ctx.db.scalar<number>(
          `SELECT COUNT(DISTINCT l.product_id) FROM price_observations o JOIN retailer_listings l ON l.id = o.listing_id
           WHERE o.job_id IN (${placeholders(chunk.length)}) AND l.product_id IS NOT NULL`,
          chunk,
        ) ?? 0;
    }
  }

  // ---- provenance of the ledger --------------------------------------------------------------
  const provenanceRows = ledgerProvenance(ctx);
  const provenance: ProvenanceRow[] = DATA_CLASSES.map((dataClass) => {
    const row = provenanceRows.find((r) => r.data_class === dataClass);
    return {
      data_class: dataClass,
      label: DATA_CLASS_LABELS[dataClass],
      observations: row ? row.total - row.voided : 0,
      voided: row?.voided ?? 0,
      listings: row?.listings ?? 0,
      demo_observations: row?.demo ?? 0,
      first_observed_at: row?.first_observed_at ?? null,
      last_observed_at: row?.last_observed_at ?? null,
    };
  });

  // ---- per-day activity ----------------------------------------------------------------------
  const dailyRows = ctx.db.all<{ date: string; data_class: JobDataClass; status: string; n: number; observations: number }>(
    `SELECT substr(created_at, 1, 10) AS date, data_class, status, COUNT(*) AS n, COALESCE(SUM(observations_created), 0) AS observations
     FROM collection_jobs WHERE created_at >= ? GROUP BY date, data_class, status ORDER BY date`,
    [since],
  );
  const dailyMap = new Map<string, CollectionDailyStats>();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    dailyMap.set(date, {
      date,
      real_succeeded: 0,
      real_partial: 0,
      real_failed: 0,
      real_not_configured: 0,
      simulated_succeeded: 0,
      simulated_partial: 0,
      simulated_failed: 0,
      real_observations: 0,
      simulated_observations: 0,
    });
  }
  for (const row of dailyRows) {
    const day = dailyMap.get(row.date);
    if (!day) continue;
    const key = `${row.data_class}_${row.status}` as keyof CollectionDailyStats;
    if (key in day && key !== 'date') (day[key] as number) += row.n;
    if (row.data_class === 'real') day.real_observations += row.observations;
    else day.simulated_observations += row.observations;
  }

  const engineState = engineCounts(ctx);
  return {
    generated_at: now.toISOString(),
    window_days: days,
    sources: {
      total: sources.length,
      active: healthy + failing + pending,
      healthy,
      failing,
      not_configured: count('not_configured'),
      paused: count('paused'),
      manual: count('manual'),
      simulated: count('simulated'),
      pending,
    },
    last_real_success_at:
      ctx.db.scalar<string | null>(`SELECT MAX(finished_at) FROM collection_jobs WHERE data_class = 'real' AND status IN ('succeeded', 'partial')`) ?? null,
    last_simulated_run_at:
      ctx.db.scalar<string | null>(`SELECT MAX(finished_at) FROM collection_jobs WHERE data_class = 'simulated' AND status IN ('succeeded', 'partial')`) ?? null,
    latest_runs: latest,
    window,
    stale: {
      real: sources.filter((s) => s.runnable && s.method !== 'simulated').reduce((sum, s) => sum + s.listings_stale, 0),
      simulated: sources.filter((s) => s.method === 'simulated').reduce((sum, s) => sum + s.listings_stale, 0),
      manual: sources.filter((s) => !s.runnable).reduce((sum, s) => sum + s.listings_stale, 0),
      never_observed: sources.reduce((sum, s) => sum + s.listings_never_observed, 0),
    },
    provenance,
    daily: [...dailyMap.values()],
    scheduler: { enabled: engineState.schedulerRunning, running_jobs: engineState.running, queued_jobs: engineState.queued },
  };
}

/** Configuration status of one source, with a plain explanation of what its kind of source needs. */
export function sourceConfigStatus(ctx: AppContext, retailerId: number): SourceConfigStatus {
  const retailer = loadRetailer(ctx, retailerId);
  if (!retailer) throw notFound('Retailer');
  const source = checkSource(ctx, retailer);
  const description = source.connector.describe(retailer.collection_method);
  let explanation: string;
  if (!source.connector.runnable) {
    explanation = `${description.description} There is nothing to configure for automatic collection.`;
  } else if (source.check.ok) {
    explanation =
      retailer.collection_method === 'simulated'
        ? 'This is a simulated demo source. It is ready to generate illustrative DEMO data; it does not collect real prices.'
        : `Everything required is in place. ${retailer.is_enabled ? 'The scheduler collects this source at its configured frequency.' : 'Collection is currently paused.'}`;
  } else {
    explanation = `This source cannot be collected yet. Still required: ${source.check.missing.join('; ')}.`;
  }
  return {
    retailer_id: retailer.id,
    method: retailer.collection_method,
    method_label: COLLECTION_METHOD_LABELS[retailer.collection_method],
    runnable: source.connector.runnable,
    configured: source.connector.runnable ? source.check.ok : true,
    missing: source.check.missing,
    warnings: source.check.warnings,
    credential_configured: source.credentialPresent,
    permission_attested: retailer.permission_attested === 1,
    active_listings: source.activeListings,
    explanation,
    requirements: description.requirements,
  };
}
