/** Database access for sources (retailers), their listings and their collection jobs. */
import type { AppContext } from '../../context.ts';
import type { CollectionJob, CollectionLog } from '../../../shared/api/collection.ts';
import { retailerSecretName, secretStatus } from '../core.ts';
import { connectorFor } from './registry.ts';
import type { ConfigCheck, Connector, SourceListing, SourceRetailer } from './types.ts';
import { normaliseGtin, normaliseUrlKey } from './util.ts';

export const RETAILER_SELECT = `SELECT r.id, r.name, r.website, r.country_code, r.market_id, m.code AS market_code, m.name AS market_name,
  m.timezone, r.currency_code, r.collection_method, r.collection_frequency,
  COALESCE(r.collection_frequency, m.default_frequency) AS effective_frequency,
  r.is_enabled, r.is_active, r.is_demo, r.connector_config, r.rate_limit_ms, r.permission_attested,
  r.last_attempt_at, r.last_success_at, r.next_run_at, r.consecutive_failures
  FROM retailers r JOIN markets m ON m.id = r.market_id`;

export function loadRetailer(ctx: AppContext, retailerId: number): SourceRetailer | undefined {
  return ctx.db.get<SourceRetailer>(`${RETAILER_SELECT} WHERE r.id = ?`, [retailerId]);
}

/**
 * Listings a run collects: active and not explicitly ignored (unmatched listings are collected too).
 * Least recently observed first, so a run that is cut short (time limit, rate limiting) makes progress
 * on the stalest listings instead of always re-reading the same ones.
 */
export function loadListings(ctx: AppContext, retailerId: number): SourceListing[] {
  return ctx.db.all<SourceListing>(
    `SELECT l.id, l.code, l.retailer_id, l.product_id, l.external_id, l.url, l.title,
       COALESCE(l.gtin, p.gtin) AS gtin, p.sku, l.match_status, l.is_demo
     FROM retailer_listings l
     LEFT JOIN products p ON p.id = l.product_id
     LEFT JOIN listing_state s ON s.listing_id = l.id
     WHERE l.retailer_id = ? AND l.is_active = 1 AND l.match_status <> 'ignored'
     ORDER BY s.last_observed_at ASC NULLS FIRST, l.id ASC`,
    [retailerId],
  );
}

/** Identifiers of every listing of the retailer, whatever its status — so discovery never re-adds one. */
export function loadKnownIdentifiers(ctx: AppContext, retailerId: number): { externalIds: Set<string>; urls: Set<string>; gtins: Set<string> } {
  const rows = ctx.db.all<{ external_id: string | null; url: string | null; gtin: string | null }>(
    `SELECT l.external_id, l.url, COALESCE(l.gtin, p.gtin) AS gtin
     FROM retailer_listings l LEFT JOIN products p ON p.id = l.product_id WHERE l.retailer_id = ?`,
    [retailerId],
  );
  const known = { externalIds: new Set<string>(), urls: new Set<string>(), gtins: new Set<string>() };
  for (const row of rows) {
    if (row.external_id) known.externalIds.add(row.external_id.trim().toLowerCase());
    const url = normaliseUrlKey(row.url);
    if (url) known.urls.add(url);
    const gtin = normaliseGtin(row.gtin);
    if (gtin) known.gtins.add(gtin);
  }
  return known;
}

export function loadCurrencyCodes(ctx: AppContext): Set<string> {
  return new Set(ctx.db.all<{ code: string }>('SELECT code FROM currencies').map((c) => c.code));
}

export function parseConnectorConfig(retailer: Pick<SourceRetailer, 'connector_config'>): { config: Record<string, unknown>; error: string | null } {
  try {
    const parsed = JSON.parse(retailer.connector_config || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: {}, error: 'The connector configuration must be a JSON object' };
    }
    return { config: parsed as Record<string, unknown>, error: null };
  } catch {
    return { config: {}, error: 'The connector configuration is not valid JSON' };
  }
}

export interface SourceCheck {
  connector: Connector;
  config: Record<string, unknown>;
  check: ConfigCheck;
  credentialPresent: boolean;
  activeListings: number;
}

/**
 * Decides — without touching the network — whether a source could be collected right now, and if not,
 * what exactly is missing. Used by the scheduler, the runner, the health views and the status endpoint.
 */
export function checkSource(
  ctx: AppContext,
  retailer: SourceRetailer,
  known: { credentialPresent?: boolean; activeListings?: number } = {},
): SourceCheck {
  const connector = connectorFor(retailer.collection_method);
  const { config, error } = parseConnectorConfig(retailer);
  const credentialPresent = known.credentialPresent ?? secretStatus(ctx, retailerSecretName(retailer.id)).configured;
  const activeListings =
    known.activeListings ??
    ctx.db.scalar<number>(
      `SELECT COUNT(*) FROM retailer_listings WHERE retailer_id = ? AND is_active = 1 AND match_status <> 'ignored'`,
      [retailer.id],
    ) ??
    0;
  if (!connector.runnable) {
    return { connector, config, check: { ok: true, missing: [], warnings: [] }, credentialPresent, activeListings };
  }
  const base = connector.checkConfig(ctx, retailer, config, credentialPresent);
  const missing = [...base.missing];
  if (error) missing.unshift(error);
  if (missing.length === 0 && activeListings === 0 && !connector.canRunWithoutListings(config)) {
    missing.push('No active listings are configured for this source');
  }
  return { connector, config, check: { ok: missing.length === 0, missing, warnings: base.warnings }, credentialPresent, activeListings };
}

// ---------------------------------------------------------------------------------------------
// Jobs and logs
// ---------------------------------------------------------------------------------------------

export const JOB_SELECT = `SELECT j.id, j.retailer_id, r.name AS retailer_name, r.market_id, m.code AS market_code, m.name AS market_name,
  j.method, j.trigger_type, j.data_class, j.status, j.attempt, j.parent_job_id, j.scheduled_for, j.started_at, j.finished_at,
  j.listings_total, j.listings_succeeded, j.listings_failed, j.listings_missing, j.observations_created, j.duplicates_skipped,
  j.error_code, j.error_message, j.requested_by, u.name AS requested_by_name, j.is_demo, j.created_at
  FROM collection_jobs j
  JOIN retailers r ON r.id = j.retailer_id
  JOIN markets m ON m.id = r.market_id
  LEFT JOIN users u ON u.id = j.requested_by`;

type JobRow = Omit<CollectionJob, 'duration_ms'>;

export function mapJob(row: JobRow): CollectionJob {
  const duration = row.started_at && row.finished_at ? Math.max(0, Date.parse(row.finished_at) - Date.parse(row.started_at)) : null;
  return { ...row, duration_ms: duration };
}

export function getJob(ctx: AppContext, jobId: number): CollectionJob | undefined {
  const row = ctx.db.get<JobRow>(`${JOB_SELECT} WHERE j.id = ?`, [jobId]);
  return row ? mapJob(row) : undefined;
}

export const LOG_SELECT = `SELECT g.id, g.job_id, g.retailer_id, r.name AS retailer_name, g.listing_id, l.code AS listing_code,
  l.title AS listing_title, g.level, g.code, g.message, g.detail, g.created_at, j.data_class AS job_data_class
  FROM collection_logs g
  JOIN retailers r ON r.id = g.retailer_id
  JOIN collection_jobs j ON j.id = g.job_id
  LEFT JOIN retailer_listings l ON l.id = g.listing_id`;

export function mapLog(row: Omit<CollectionLog, 'detail'> & { detail: string | null }): CollectionLog {
  let detail: unknown = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = row.detail;
    }
  }
  return { ...row, detail };
}
