/**
 * Contracts of the collection engine.
 *
 * A *connector* knows how to talk to one kind of source (structured API/feed, permitted web page,
 * simulated demo generator). A *retailer* is pure configuration on top of a connector, so new retailers
 * are added in the UI without code changes; a new kind of source is one module plus one registry entry.
 */
import type { AppContext } from '../../context.ts';
import type { CollectionMethod, Frequency } from '../../../shared/constants.ts';
import type { ConnectorDescription } from '../../../shared/api/collection.ts';
import type { ObservationInput } from '../ingestion.ts';

export interface SourceRetailer {
  id: number;
  name: string;
  website: string | null;
  country_code: string;
  market_id: number;
  market_code: string;
  market_name: string;
  timezone: string;
  currency_code: string;
  collection_method: CollectionMethod;
  collection_frequency: Frequency | null;
  effective_frequency: Frequency;
  is_enabled: number;
  is_active: number;
  is_demo: number;
  connector_config: string;
  rate_limit_ms: number;
  permission_attested: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  consecutive_failures: number;
}

export interface SourceListing {
  id: number;
  code: string;
  retailer_id: number;
  product_id: number | null;
  external_id: string | null;
  url: string | null;
  title: string | null;
  /** Barcode reported for the listing, falling back to the canonical product's GTIN. */
  gtin: string | null;
  sku: string | null;
  match_status: string;
  is_demo: number;
}

export interface ConfigCheck {
  ok: boolean;
  /** Plain-language list of what must be provided before the source can run. */
  missing: string[];
  warnings: string[];
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface RunLog {
  level: LogLevel;
  code: string;
  message: string;
  listing_id?: number | null;
  detail?: unknown;
}

/** Evidence a connector wants recorded; the runner turns drafts into `source_evidence` rows. */
export interface EvidenceDraft {
  kind: 'api_response' | 'feed_item' | 'html_snapshot' | 'simulated';
  reference: string;
  sha256?: string | null;
  size_bytes?: number | null;
  excerpt?: string | null;
  note?: string | null;
  captured_at: string;
}

/** Observation fields produced by a connector (the runner adds listing id and evidence id). */
export type ObservationDraft = Omit<ObservationInput, 'listing_id' | 'evidence_id'>;

export interface ListingOutcome {
  listing_id: number;
  status: 'ok' | 'failed' | 'missing';
  /** Stable code for failures, e.g. `robots_disallowed`, `no_price_found`, `not_found`. */
  code?: string;
  message?: string;
  observation?: ObservationDraft;
  /** Index into CollectResult.evidence. */
  evidence?: number;
  /** How the price was obtained (`json_ld`, `meta`, `selector`, `regex`, `feed`, `api`, `simulated`). */
  strategy?: string;
  excerpt?: string | null;
}

/** An item present at the source that does not correspond to any configured listing. */
export interface DiscoveredItem {
  external_id: string | null;
  url: string | null;
  title: string | null;
  gtin: string | null;
  observation?: ObservationDraft;
  evidence?: number;
}

export interface CollectResult {
  outcomes: ListingOutcome[];
  discovered: DiscoveredItem[];
  evidence: EvidenceDraft[];
  logs: RunLog[];
  requests: number;
  /** Items returned by a feed / API (null for per-page connectors). */
  itemsFound: number | null;
  /** Run-level failure: the source as a whole could not be collected. */
  fatal: { code: string; message: string } | null;
  /** First raw items, for test diagnostics only. */
  sample: unknown[];
}

export interface CollectContext {
  ctx: AppContext;
  retailer: SourceRetailer;
  /** Parsed `retailers.connector_config`. */
  config: Record<string, unknown>;
  /** Decrypted credential, never logged. */
  credential: string | null;
  listings: SourceListing[];
  /** Every identifier already known for this retailer (any status) so discovery never duplicates. */
  known: { externalIds: Set<string>; urls: Set<string>; gtins: Set<string> };
  /** ISO codes of the currencies configured in the system (to recognise a currency written next to a price). */
  currencies: ReadonlySet<string>;
  /** Dry run: fetch and parse only, minimal number of requests, nothing is stored. */
  dryRun: boolean;
  /** Attempt number of the job (1 for the first try). */
  attempt: number;
  now: Date;
  signal: AbortSignal;
}

export interface Connector {
  methods: CollectionMethod[];
  /** False for people-driven methods (manual entry, CSV import). */
  runnable: boolean;
  /** 'real' = talks to an actual source; 'simulated' = demo generator. */
  dataClass: 'real' | 'simulated';
  describe(method: CollectionMethod): ConnectorDescription;
  /** Pure validation of configuration — never touches the network. */
  checkConfig(ctx: AppContext, retailer: SourceRetailer, config: Record<string, unknown>, credentialPresent: boolean): ConfigCheck;
  /** Whether a run makes sense without any configured listing (sources that can discover listings). */
  canRunWithoutListings(config: Record<string, unknown>): boolean;
  /** True when every listing costs its own request (a test run then only tries a few listings). */
  requestsPerListing(config: Record<string, unknown>): boolean;
  collect(cc: CollectContext): Promise<CollectResult>;
}

export function emptyResult(): CollectResult {
  return { outcomes: [], discovered: [], evidence: [], logs: [], requests: 0, itemsFound: null, fatal: null, sample: [] };
}
