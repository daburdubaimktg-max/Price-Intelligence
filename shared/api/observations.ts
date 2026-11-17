/**
 * API types for observations, evidence, imports (CSV / Excel) and the Excel database workbook.
 * Types only — no runtime code.
 */
import type { Availability, CollectionMethod, DataClass, DealTag, Ownership, PromoType } from '../constants.ts';

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

/** One price observation joined with everything needed to display it. */
export interface ObservationRecord {
  id: number;
  listing_id: number;
  listing_code: string;
  listing_title: string | null;
  listing_url: string | null;
  external_id: string | null;
  product_id: number | null;
  product_code: string | null;
  product_name: string | null;
  sku: string | null;
  gtin: string | null;
  image_url: string | null;
  brand_id: number | null;
  brand_name: string | null;
  ownership: Ownership | null;
  category_id: number | null;
  category_name: string | null;
  subcategory_id: number | null;
  subcategory_name: string | null;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  /** IANA time zone of the market — use it to display `observed_at` in local market time. */
  timezone: string;
  country_code: string;
  currency_code: string;
  pack_size: number | null;
  pack_unit: string | null;
  units_per_pack: number | null;
  variant_name: string | null;
  content_amount: number | null;
  content_dimension: 'volume' | 'mass' | 'count' | null;
  regular_price: number | null;
  current_price: number | null;
  promo_price: number | null;
  discount_pct: number | null;
  is_promo: 0 | 1;
  promo_type: PromoType | null;
  promo_description: string | null;
  promo_starts_on: string | null;
  promo_ends_on: string | null;
  availability: Availability;
  product_url: string | null;
  /** UTC instant the price was true. */
  observed_at: string;
  /** 'exact' = real timestamp, 'date_only' = only the day is known, 'import_time' = original date unknown. */
  observed_basis: 'exact' | 'date_only' | 'import_time';
  /** Calendar date in the market's time zone. */
  observed_local_date: string;
  collected_at: string;
  source_timestamp: string | null;
  source_method: CollectionMethod;
  data_class: DataClass;
  collection_status: 'complete' | 'partial';
  confidence: number | null;
  evidence_id: number | null;
  job_id: number | null;
  import_batch_id: number | null;
  entered_by: number | null;
  note: string | null;
  /** 1 = illustrative DEMO record, never a real market observation. */
  is_demo: 0 | 1;
  /** Deal tags / badges the retailer showed with this price (keys of DEAL_TAGS, canonical order; empty = none). */
  tags: DealTag[];
  /** The retailer's own wording of the tag, e.g. "Early Yellow Friday Deal". */
  tag_text: string | null;
  /** Average customer rating (0–5) and the number of ratings / reviews, as shown at that moment. */
  rating: number | null;
  review_count: number | null;
  /** Position in the retailer's sales ranking and the list it refers to, e.g. 3 and "#3 in Shampoos". */
  sales_rank: number | null;
  sales_rank_label: string | null;
  /** Who sold the item on the listing (the retailer itself or a marketplace seller). */
  seller_name: string | null;
  /** Price per 100 ml / 100 g / unit (see content_dimension); null when the pack content is unknown. */
  unit_price: number | null;
  /** 1 when the observation was voided (kept in the ledger, excluded from analytics). */
  voided: 0 | 1;
  void_reason: string | null;
}

export interface ObservationBrief {
  id: number;
  observed_at: string;
  observed_local_date: string;
  regular_price: number | null;
  current_price: number | null;
  promo_price: number | null;
  discount_pct: number | null;
  is_promo: 0 | 1;
  availability: Availability;
  source_method: CollectionMethod;
  data_class: DataClass;
}

export type EvidenceKind = 'csv_file' | 'screenshot' | 'document' | 'url' | 'api_response' | 'feed_item' | 'html_snapshot' | 'note' | 'simulated';

export interface EvidenceRecord {
  id: number;
  kind: EvidenceKind;
  /** URL, file name or free-text description. */
  reference: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  excerpt: string | null;
  captured_at: string | null;
  uploaded_by: number | null;
  uploaded_by_name: string | null;
  note: string | null;
  is_demo: 0 | 1;
  created_at: string;
  /** True when a file is retained and can be fetched from GET /api/evidence/:id/file. */
  has_file: boolean;
  /** Number of observations that cite this evidence. */
  observation_count?: number;
}

export interface ObservationDetail {
  observation: ObservationRecord;
  void: { reason: string; voided_at: string; voided_by: number | null; voided_by_name: string | null; import_batch_id: number | null } | null;
  evidence: EvidenceRecord | null;
  job: { id: number; status: string; method: string; data_class: 'real' | 'simulated'; trigger_type: string; started_at: string | null; finished_at: string | null } | null;
  import_batch: { id: number; file_name: string; status: string; created_at: string } | null;
  entered_by: { id: number; name: string; email: string } | null;
  /** Neighbouring (non-voided) observations of the same listing. */
  previous: ObservationBrief | null;
  next: ObservationBrief | null;
}

/** Body of POST /api/observations (manual price entry). */
export interface ManualObservationInput {
  listing_id: number;
  /** ISO instant ("2026-11-17T08:15:00Z"), or a wall-clock time in the market's time zone ("2026-11-17T12:15"). */
  observed_at?: string | null;
  /** Alternative to observed_at: market-local date (YYYY-MM-DD) and optional time (HH:mm). Date only → flagged "date only". */
  observed_date?: string | null;
  observed_time?: string | null;
  regular_price?: number | null;
  current_price?: number | null;
  promo_price?: number | null;
  discount_pct?: number | null;
  is_promo?: boolean | null;
  promo_type?: PromoType | null;
  promo_description?: string | null;
  promo_starts_on?: string | null;
  promo_ends_on?: string | null;
  availability?: Availability | null;
  product_url?: string | null;
  /** 0–1. Defaults to 0.95 for manual entry. */
  confidence?: number | null;
  note?: string | null;
  /** Deal tags / badges seen with the price (keys of DEAL_TAGS). */
  tags?: DealTag[] | null;
  /** The retailer's own wording of the tag. */
  tag_text?: string | null;
  /** Average customer rating, 0–5. */
  rating?: number | null;
  review_count?: number | null;
  sales_rank?: number | null;
  sales_rank_label?: string | null;
  seller_name?: string | null;
  /** Evidence uploaded beforehand through POST /api/evidence… */
  evidence_id?: number | null;
  /** …or described inline. */
  evidence?: { kind: 'url' | 'note' | 'screenshot'; reference: string } | null;
}

export interface ManualObservationResponse {
  observation: ObservationRecord;
  /** Older observations for the same listing and instant that this entry superseded (voided, not deleted). */
  superseded: number;
}

// ---------------------------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------------------------
export type ImportKind = 'observations' | 'products';
export type ImportStatus = 'staged' | 'validated' | 'committed' | 'failed' | 'voided';

export interface ImportBatch {
  id: number;
  kind: ImportKind;
  file_name: string;
  sha256: string | null;
  size_bytes: number | null;
  status: ImportStatus;
  mapping: Record<string, string>;
  options: Record<string, unknown>;
  row_count: number;
  valid_count: number;
  inserted_count: number;
  duplicate_count: number;
  error_count: number;
  evidence_id: number | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  committed_at: string | null;
  voided_by: number | null;
  voided_by_name: string | null;
  voided_at: string | null;
  void_reason: string | null;
  is_demo: 0 | 1;
}

export interface ImportIssue {
  /** Row number as shown in the spreadsheet (header row = 1). */
  row: number;
  field?: string;
  message: string;
}

export interface ImportFieldInfo {
  field: string;
  label: string;
  group: string;
  /** 'yes' = must be mapped, 'conditional' = one of several alternatives, 'no' = optional. */
  required: 'yes' | 'conditional' | 'no';
  description: string;
}

export interface ObservationImportOptions {
  /** How to read dates such as 03/04/2026. 'auto' refuses ambiguous dates. */
  date_order: 'auto' | 'dmy' | 'mdy';
  /** Time zone of timestamps without an offset: the market's own zone, or UTC. */
  timezone_mode: 'market' | 'utc';
  /** Confidence (0–1) for rows without their own value. */
  default_confidence: number;
  default_availability: Availability;
  /** Prices use a decimal comma (12,50) and dots for thousands. */
  decimal_comma: boolean;
  /** What the imported figures were taken from. */
  evidence_kind: 'csv_file' | 'screenshot' | 'document';
  evidence_note: string | null;
  /** Rows without a date use the import time (flagged "import time") instead of being rejected. */
  allow_missing_dates: boolean;
  /** Create a listing when the retailer and product are known but no listing exists yet. */
  create_missing_listings: boolean;
  /** Excel only: worksheet to read. */
  sheet?: string | null;
}

export interface ProductImportOptions {
  /** Update products that already exist (matched by product code, SKU or GTIN) instead of skipping them. */
  update_existing: boolean;
  /** Create brands that do not exist yet (needs an ownership column: own / competitor). */
  create_missing_brands: boolean;
  create_missing_categories: boolean;
  sheet?: string | null;
}

export interface ImportStageResponse {
  batch: ImportBatch;
  headers: string[];
  /** First rows of the file, as text. */
  sample_rows: Record<string, string>[];
  row_count: number;
  /** field → header guesses based on the column names. */
  suggested_mapping: Record<string, string>;
  suggested_options: Partial<ObservationImportOptions & ProductImportOptions>;
  /** Fields the importer understands for this kind (for the mapping form). */
  fields: ImportFieldInfo[];
  /** Excel only: worksheet names and the one that was read. */
  sheets: string[];
  sheet: string | null;
}

export interface ObservationImportPreviewRow {
  row: number;
  listing_code: string | null;
  new_listing: boolean;
  retailer: string;
  market: string;
  product: string | null;
  observed_at: string;
  observed_basis: 'exact' | 'date_only' | 'import_time';
  observed_local_date: string;
  currency: string;
  regular_price: number | null;
  current_price: number | null;
  promo_price: number | null;
  discount_pct: number | null;
  is_promo: boolean;
  promo_type: PromoType | null;
  availability: Availability;
  confidence: number | null;
  tags: DealTag[];
  tag_text: string | null;
  rating: number | null;
  review_count: number | null;
  sales_rank: number | null;
  seller_name: string | null;
}

export interface ProductImportPreviewRow {
  row: number;
  action: 'create' | 'update';
  product_code: string | null;
  name: string;
  brand: string;
  new_brand: boolean;
  category: string;
  subcategory: string | null;
  sku: string | null;
  gtin: string | null;
  pack: string;
  markets: string[];
  status: string;
}

export interface ImportSummary {
  /** Data rows in the file. */
  rows: number;
  valid: number;
  invalid: number;
  /** Rows that repeat an earlier row of the same file. */
  duplicates_in_file: number;
  /** Observations: identical facts already in the ledger (skipped, never duplicated). Products: existing products that will be skipped. */
  already_in_ledger: number;
  /** Rows that will actually be written. */
  will_insert: number;
  /** Observations: rows that replace an existing observation for the same listing and instant (the old one is voided, not deleted). */
  will_supersede?: number;
  listings_to_create?: number;
  listings?: number;
  retailers?: number;
  date_from?: string | null;
  date_to?: string | null;
  /** Products. */
  to_create?: number;
  to_update?: number;
  brands_to_create?: number;
  categories_to_create?: number;
  /** Template example rows that were ignored. */
  example_rows_skipped: number;
}

export interface ImportValidateResponse {
  batch: ImportBatch;
  summary: ImportSummary;
  /** First 200 problems; rows with problems are not imported. */
  errors: ImportIssue[];
  error_total: number;
  /** Things worth knowing that do not block the import. */
  warnings: ImportIssue[];
  warning_total: number;
  preview: Array<ObservationImportPreviewRow | ProductImportPreviewRow>;
}

export interface ImportCommitResponse {
  batch: ImportBatch;
  inserted: number;
  updated: number;
  duplicates: number;
  superseded: number;
  skipped_invalid: number;
  listings_created: number;
  errors: ImportIssue[];
  error_total: number;
}

export interface ImportVoidResponse {
  batch: ImportBatch;
  observations_voided: number;
  observations_restored: number;
  listings_affected: number;
}

// ---------------------------------------------------------------------------------------------
// Excel database workbook
// ---------------------------------------------------------------------------------------------
export interface DatabaseMirrorStatus {
  /** False when PIOS_EXCEL_MIRROR=off. */
  enabled: boolean;
  /** True when this server process is refreshing the mirror on its own (enabled and its periodic housekeeping is running). */
  auto_refresh: boolean;
  /** Absolute path of the mirror workbook on the server. */
  path: string;
  /** True once a mirror file exists. */
  exists: boolean;
  generated_at: string | null;
  size_bytes: number | null;
  /** Price observations contained in the mirror. */
  observation_rows: number | null;
  sheets: Array<{ name: string; rows: number }>;
  duration_ms: number | null;
  /** The database changed after the mirror was generated. */
  stale: boolean;
  generating: boolean;
  /** Minutes between automatic refreshes while the data keeps changing. */
  interval_minutes: number;
  last_error: string | null;
  last_error_at: string | null;
}
