/**
 * API contracts of the Data Collection Centre (`/api/collection/*`). Types only.
 *
 * Honesty rules encoded in these shapes:
 *   * real and simulated runs are reported in separate buckets (`data_class`), never blended
 *   * `not_configured` is its own job status — a run that made no attempt is never a success
 *   * success rates are `null` ("n/a") when no real attempt was made, never a default 100 %
 */
import type { Availability, CollectionMethod, DataClass, Frequency } from '../constants.ts';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'not_configured' | 'cancelled';
export type JobTrigger = 'schedule' | 'manual' | 'retry';
export type JobDataClass = 'real' | 'simulated';

/** Computed state of a source. `pending` = fully configured but no collection has run yet. */
export type SourceStatus = 'healthy' | 'failing' | 'not_configured' | 'paused' | 'manual' | 'simulated' | 'pending';

export interface CollectionJob {
  id: number;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  method: CollectionMethod;
  trigger_type: JobTrigger;
  data_class: JobDataClass;
  status: JobStatus;
  attempt: number;
  parent_job_id: number | null;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  listings_total: number;
  listings_succeeded: number;
  listings_failed: number;
  listings_missing: number;
  observations_created: number;
  duplicates_skipped: number;
  error_code: string | null;
  error_message: string | null;
  requested_by: number | null;
  requested_by_name: string | null;
  is_demo: number;
  created_at: string;
}

export interface CollectionLog {
  id: number;
  job_id: number;
  retailer_id: number;
  retailer_name: string;
  listing_id: number | null;
  listing_code: string | null;
  listing_title: string | null;
  level: 'info' | 'warn' | 'error';
  /** Stable machine code, e.g. `robots_disallowed`, `auth_failed`, `no_price_found`, `listing_missing`. */
  code: string;
  message: string;
  detail: unknown;
  created_at: string;
  /** Present on list endpoints so rows can be labelled without another lookup. */
  job_data_class?: JobDataClass;
}

export interface CollectionJobDetail {
  job: CollectionJob;
  logs: CollectionLog[];
  /** The whole retry chain this job belongs to (oldest attempt first), including the job itself. */
  chain: CollectionJob[];
  /** Whether POST /collection/jobs/:id/retry is currently possible. */
  can_retry: boolean;
  can_cancel: boolean;
}

export interface CollectionSource {
  retailer_id: number;
  name: string;
  website: string | null;
  market_id: number;
  market_code: string;
  market_name: string;
  country_code: string;
  currency_code: string;
  timezone: string;
  method: CollectionMethod;
  method_label: string;
  /** Effective frequency (the retailer's own, or inherited from the market). */
  frequency: Frequency;
  frequency_inherited: boolean;
  is_enabled: number;
  is_active: number;
  is_demo: number;
  status: SourceStatus;
  /** Plain-language explanation of the status: what is missing, the last error, etc. */
  status_reason: string;
  /** Whether the scheduler can run this source (automated method). */
  runnable: boolean;
  config_ok: boolean;
  /** What must be provided before the source can run. Empty when `config_ok`. */
  missing: string[];
  credential_configured: boolean;
  permission_attested: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  consecutive_failures: number;
  listings_active: number;
  listings_unmatched: number;
  /** Counters of the most recent finished job (null when the source has never run). */
  listings_captured_last_run: number | null;
  listings_missing_last_run: number | null;
  listings_failed_last_run: number | null;
  /** Active listings whose latest observation is older than the expected timeframe, or that were never observed. */
  listings_stale: number;
  listings_never_observed: number;
  /**
   * What the data provider charges per 1,000 items it returns, in USD, as entered in the source's settings.
   * Only the cost planner uses it: this system neither pays nor measures provider charges. Null when not entered.
   */
  cost_per_1000: number | null;
  last_observed_at: string | null;
  latest_job: CollectionJob | null;
}

export interface JobClassStats {
  data_class: JobDataClass;
  /** Runs that actually made an attempt (succeeded + partial + failed). */
  attempts: number;
  succeeded: number;
  partial: number;
  failed: number;
  not_configured: number;
  cancelled: number;
  /** succeeded / attempts. `null` when there was no attempt — never shown as 100 %. */
  success_rate: number | null;
  observations_created: number;
  listings_failed: number;
  listings_missing: number;
}

export interface ProvenanceRow {
  data_class: DataClass;
  label: string;
  /** Observations in the ledger (voided ones excluded). */
  observations: number;
  voided: number;
  listings: number;
  demo_observations: number;
  first_observed_at: string | null;
  last_observed_at: string | null;
}

export interface CollectionDailyStats {
  date: string;
  real_succeeded: number;
  real_partial: number;
  real_failed: number;
  real_not_configured: number;
  simulated_succeeded: number;
  simulated_partial: number;
  simulated_failed: number;
  real_observations: number;
  simulated_observations: number;
}

export interface CollectionHealth {
  generated_at: string;
  window_days: number;
  sources: {
    /** Every active retailer, whatever its method. */
    total: number;
    /** Automated real sources that are enabled and fully configured. */
    active: number;
    healthy: number;
    failing: number;
    not_configured: number;
    paused: number;
    manual: number;
    simulated: number;
    pending: number;
  };
  /** Last successful collection from a REAL source. `null` until one exists. */
  last_real_success_at: string | null;
  /** Last successful run of a SIMULATED demo source (never a real collection). */
  last_simulated_run_at: string | null;
  /** Summed over the most recent finished job of every source, per data class. */
  latest_runs: Record<JobDataClass, { sources: number; listings_captured: number; products_captured: number; listings_missing: number; listings_failed: number }>;
  window: Record<JobDataClass, JobClassStats>;
  /** Listings with no fresh observation / never observed, per data class of their source. */
  stale: { real: number; simulated: number; manual: number; never_observed: number };
  provenance: ProvenanceRow[];
  daily: CollectionDailyStats[];
  scheduler: { enabled: boolean; running_jobs: number; queued_jobs: number };
}

export type ConfigFieldType = 'text' | 'url' | 'number' | 'select' | 'boolean' | 'textarea' | 'key_value' | 'string_list';

export interface ConnectorConfigField {
  /** Dot path inside `retailers.connector_config`, e.g. `fields.current_price`. */
  key: string;
  label: string;
  type: ConfigFieldType;
  group: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  default?: unknown;
  placeholder?: string;
  help?: string;
  /** Only relevant when another field has one of these values. */
  show_if?: { key: string; in: unknown[] };
}

export interface ConnectorExample {
  title: string;
  description: string;
  config: Record<string, unknown>;
  notes?: string[];
}

export interface ConnectorDescription {
  method: CollectionMethod;
  label: string;
  summary: string;
  description: string;
  /** Can be run by the scheduler / "run now". False for people-driven methods. */
  runnable: boolean;
  /** 'real' sources talk to an actual retailer system; 'simulated' is the demo generator; 'people' is manual work. */
  kind: 'real' | 'simulated' | 'people';
  requirements: string[];
  limitations: string[];
  credential: { needed: 'never' | 'depends' | 'always'; label: string; help: string };
  needs_permission_attestation: boolean;
  supports_discovery: boolean;
  config_fields: ConnectorConfigField[];
  examples: ConnectorExample[];
}

export interface SourceConfigStatus {
  retailer_id: number;
  method: CollectionMethod;
  method_label: string;
  runnable: boolean;
  configured: boolean;
  missing: string[];
  warnings: string[];
  credential_configured: boolean;
  permission_attested: boolean;
  active_listings: number;
  /** Human explanation of what is required for this kind of source. */
  explanation: string;
  requirements: string[];
}

export interface CollectionTestListingResult {
  listing_id: number | null;
  listing_code: string | null;
  title: string | null;
  url: string | null;
  status: 'ok' | 'failed' | 'missing' | 'would_discover';
  code: string | null;
  message: string | null;
  strategy: string | null;
  /** The observation that WOULD be stored (nothing is stored by a test). */
  observation: {
    current_price: number | null;
    regular_price: number | null;
    promo_price: number | null;
    discount_pct: number | null;
    availability: string | null;
    currency_code: string | null;
    confidence: number | null;
  } | null;
  excerpt: string | null;
}

export interface CollectionTestResult {
  retailer_id: number;
  method: CollectionMethod;
  dry_run: true;
  configured: boolean;
  missing: string[];
  /** True when at least one price was read and nothing fatal happened. */
  ok: boolean;
  requests: number;
  duration_ms: number;
  items_found: number | null;
  listings_tested: number;
  listings_matched: number;
  listings_missing: number;
  listings_failed: number;
  would_discover: number;
  fatal: { code: string; message: string } | null;
  results: CollectionTestListingResult[];
  /** First raw items of a feed / API response (long values shortened). */
  sample_items: unknown[];
  logs: Array<{ level: 'info' | 'warn' | 'error'; code: string; message: string }>;
  note: string;
}

export interface RunDueResult {
  started: CollectionJob[];
  skipped: Array<{ retailer_id: number; name: string; reason: string }>;
}

/**
 * Result of POST /api/collection/site-check: whether one product page of a retailer can be read directly by this
 * system, the way permitted website extraction would read it (robots.txt first, one plain request, no JavaScript).
 * It describes this one page at this moment; it is not a statement about the site's terms of use.
 */
export interface SiteCheckResult {
  url: string;
  host: string;
  checked_at: string;
  robots: {
    /** allowed: the page may be requested · disallowed: robots.txt forbids it · unreadable: robots.txt could not be read (treated as not permitted) · none: the site has no robots.txt */
    status: 'allowed' | 'disallowed' | 'unreadable' | 'none';
    detail: string;
    /** Pause the site asks for between requests, in seconds. */
    crawl_delay_s: number | null;
  };
  /** Null when the page was not requested (robots.txt did not allow it). */
  page: {
    http_status: number | null;
    outcome: 'price_found' | 'no_price' | 'verification_page' | 'refused' | 'not_found' | 'rate_limited' | 'not_a_page' | 'error';
    detail: string;
    price: number | null;
    regular_price: number | null;
    currency: string | null;
    availability: Availability | null;
    /** Where on the page the price was read from. */
    read_from: string | null;
  } | null;
  /**
   * direct: can be read directly, at no cost · needs_setup: the page opens but the price is not readable without
   * more configuration · blocked: the site does not answer automated visits · not_permitted: robots.txt rules it out.
   */
  verdict: 'direct' | 'needs_setup' | 'blocked' | 'not_permitted';
  /** What this means and what to do next, in plain language. */
  advice: string[];
}
