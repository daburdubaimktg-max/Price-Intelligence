/**
 * API contract for the catalogue and source-management endpoints
 * (/reference, /brands, /categories, /markets, /currencies, /products, /variants, /retailers,
 *  /listings, /matching, /mappings). Types only — no runtime code.
 */
import type {
  Availability,
  CollectionMethod,
  ContentDimension,
  DataClass,
  Frequency,
  Ownership,
  PackUnit,
  PromoType,
} from '../constants.ts';

/** Shape of every paginated list response. */
export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

// ---------------------------------------------------------------------------------------------
// Reference data (filter controls)
// ---------------------------------------------------------------------------------------------
export interface MarketRef {
  id: number;
  code: string;
  name: string;
  country_code: string;
  country_name: string;
  region: string | null;
  currency_code: string;
  timezone: string;
  default_frequency: Frequency;
  is_active: number;
  sort_order: number;
}

export interface RetailerRef {
  id: number;
  name: string;
  market_id: number;
  currency_code: string;
  collection_method: CollectionMethod;
  is_active: number;
  is_demo: number;
}

export interface BrandRef {
  id: number;
  name: string;
  ownership: Ownership;
  is_active: number;
  is_demo: number;
}

export interface CategoryRef {
  id: number;
  name: string;
  parent_id: number | null;
}

export interface CurrencyRef {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
}

export interface ReferenceData {
  markets: MarketRef[];
  retailers: RetailerRef[];
  brands: BrandRef[];
  categories: CategoryRef[];
  currencies: CurrencyRef[];
}

// ---------------------------------------------------------------------------------------------
// Brands, categories, markets
// ---------------------------------------------------------------------------------------------
export interface BrandRow extends BrandRef {
  manufacturer: string | null;
  product_count: number;
  /** For an own brand: the competitor brands it is benchmarked against. */
  competitor_brand_ids: number[];
  /** For a competitor brand: the own brands that benchmark against it. */
  benchmarked_by_brand_ids: number[];
  created_at: string;
  updated_at: string;
}

export interface CategoryRow extends CategoryRef {
  parent_name: string | null;
  /** Products using this row as their category or subcategory. */
  product_count: number;
  child_count: number;
  is_demo: number;
  created_at: string;
}

export interface MarketRow extends MarketRef {
  notes: string | null;
  retailer_count: number;
  active_retailer_count: number;
  listing_count: number;
  /** Products flagged as available in the market (product_markets). */
  product_count: number;
  /** Distinct products that have at least one listing at a retailer of the market. */
  listed_product_count: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------
export type ProductStatus = 'active' | 'inactive' | 'archived';

export interface ProductRow {
  id: number;
  /** Human-facing Product ID, e.g. PRD-00042. */
  code: string;
  name: string;
  product_line: string | null;
  brand_id: number;
  brand_name: string;
  ownership: Ownership;
  category_id: number;
  category_name: string;
  subcategory_id: number | null;
  subcategory_name: string | null;
  sku: string | null;
  gtin: string | null;
  pack_size: number | null;
  pack_unit: PackUnit | null;
  units_per_pack: number;
  /** "200ml", "2 × 150g", "—" */
  pack_label: string;
  image_url: string | null;
  description: string | null;
  status: ProductStatus;
  is_demo: number;
  created_at: string;
  updated_at: string;
  /** All retailer listings mapped to the product. */
  listing_count: number;
  active_listing_count: number;
  retailer_count: number;
  /** Markets the product is flagged as available in (product_markets). */
  market_count: number;
  /** Markets where the product actually has a listing. */
  listed_market_count: number;
  variant_count: number;
  last_observed_at: string | null;
}

export interface ProductOption {
  id: number;
  code: string;
  name: string;
  brand_id: number;
  brand_name: string;
  ownership: Ownership;
  category_name: string;
  pack_size: number | null;
  pack_unit: PackUnit | null;
  units_per_pack: number;
  pack_label: string;
  status: ProductStatus;
  is_demo: number;
}

export interface ProductSummaryGroup {
  /** Group id (brand / category / market id). null = "not assigned". */
  id: number | null;
  label: string;
  ownership?: Ownership;
  count: number;
}

export interface ProductSummary {
  group_by: 'brand' | 'category' | 'market';
  total: number;
  groups: ProductSummaryGroup[];
}

export interface VariantRow {
  id: number;
  product_id: number;
  name: string;
  pack_size: number;
  pack_unit: PackUnit;
  units_per_pack: number;
  pack_label: string;
  gtin: string | null;
  notes: string | null;
  is_active: number;
  created_at: string;
  listing_count: number;
}

/** Latest (non-voided) observation of a listing, as embedded in listing rows. */
export interface LatestObservation {
  observation_id: number;
  current_price: number | null;
  regular_price: number | null;
  promo_price: number | null;
  is_promo: number;
  discount_pct: number | null;
  promo_type: PromoType | null;
  availability: Availability;
  observed_at: string;
  data_class: DataClass;
  source_method: CollectionMethod;
  /** Price per 100 ml / 100 g / unit; null when the pack content is unknown. */
  unit_price: number | null;
}

export interface ListingRow {
  id: number;
  /** Unique listing identifier, e.g. LST-000123. */
  code: string;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  timezone: string;
  country_code: string;
  currency_code: string;
  collection_method: CollectionMethod;
  /** Effective frequency (retailer override or market default). */
  collection_frequency: Frequency;
  product_id: number | null;
  product_code: string | null;
  product_name: string | null;
  brand_id: number | null;
  brand_name: string | null;
  ownership: Ownership | null;
  category_name: string | null;
  subcategory_name: string | null;
  sku: string | null;
  /** Barcode of the canonical product. */
  product_gtin: string | null;
  variant_id: number | null;
  variant_name: string | null;
  /** Effective pack (variant when set, otherwise the product). */
  pack_size: number | null;
  pack_unit: PackUnit | null;
  units_per_pack: number | null;
  pack_label: string;
  content_amount: number | null;
  content_dimension: ContentDimension | null;
  /** The retailer's own item id / SKU. */
  external_id: string | null;
  url: string | null;
  /** Title as shown by the retailer. */
  title: string | null;
  /** Barcode as reported by the retailer. */
  gtin: string | null;
  match_status: 'matched' | 'unmatched' | 'ignored';
  matched_by: number | null;
  matched_at: string | null;
  is_active: number;
  is_demo: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  obs_count: number;
  first_observed_at: string | null;
  last_observed_at: string | null;
  last_price_change_at: string | null;
  latest: LatestObservation | null;
  previous_price: number | null;
  previous_observed_at: string | null;
}

export interface ProductDetail {
  product: ProductRow;
  variants: VariantRow[];
  market_ids: number[];
  markets: Array<{ id: number; code: string; name: string }>;
  listings: ListingRow[];
  mappings: {
    /** Mappings where this product is the own product (its competitors). */
    as_own: MappingRow[];
    /** Mappings where this product is the competitor (own products it is compared with). */
    as_competitor: MappingRow[];
  };
  /** Brand-level association: competitor brands of an own brand, or own brands benchmarking a competitor brand. */
  associated_brands: BrandRef[];
}

// ---------------------------------------------------------------------------------------------
// Retailers (collection sources)
// ---------------------------------------------------------------------------------------------
export interface CredentialStatus {
  configured: boolean;
  /** Last characters of the stored credential, for recognition only. null for users who cannot manage sources. */
  hint: string | null;
  updated_at: string | null;
}

export interface RetailerRow {
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
  /** Retailer-level override; null = inherit the market default. */
  collection_frequency: Frequency | null;
  market_default_frequency: Frequency;
  effective_frequency: Frequency;
  /** 0 = paused. */
  is_enabled: number;
  /** Non-secret connector settings. null for users without the sources.manage permission. */
  connector_config: Record<string, unknown> | null;
  rate_limit_ms: number;
  permission_attested: number;
  permission_attested_by: number | null;
  permission_attested_by_name: string | null;
  permission_attested_at: string | null;
  permission_note: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  consecutive_failures: number;
  notes: string | null;
  is_active: number;
  is_demo: number;
  created_at: string;
  updated_at: string;
  listing_count: number;
  active_listing_count: number;
  matched_listing_count: number;
  unmatched_listing_count: number;
  observation_count: number;
  last_observed_at: string | null;
  credential: CredentialStatus;
}

// ---------------------------------------------------------------------------------------------
// Listing ↔ product matching
// ---------------------------------------------------------------------------------------------
export interface MatchSuggestion {
  id: number;
  listing_id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  brand_name: string;
  ownership: Ownership;
  pack_label: string;
  product_gtin: string | null;
  product_is_demo: number;
  /** 0–1. 1.0 is reserved for an exact barcode match. */
  score: number;
  /** Human-readable reasons, e.g. "Pack size differs (listing 300ml vs product 200ml)". */
  reasons: string[];
  status: 'pending' | 'approved' | 'rejected';
  decided_at: string | null;
  created_at: string;
}

export interface MatchingListing extends ListingRow {
  suggestions: MatchSuggestion[];
}

export interface MatchingListResponse extends Paged<MatchingListing> {
  counts: { unmatched: number; ignored: number; pending_suggestions: number };
}

// ---------------------------------------------------------------------------------------------
// Competitor equivalence mappings
// ---------------------------------------------------------------------------------------------
export interface MappingProductSide {
  product_id: number;
  product_code: string;
  product_name: string;
  brand_id: number;
  brand_name: string;
  pack_size: number | null;
  pack_unit: PackUnit | null;
  units_per_pack: number;
  pack_label: string;
  content_amount: number | null;
  content_dimension: ContentDimension | null;
  status: ProductStatus;
  is_demo: number;
}

export interface Comparability {
  /** null when either pack is unknown. */
  same_dimension: boolean | null;
  /** Competitor content ÷ own content (same dimension only). */
  size_ratio: number | null;
  /** "per 100ml" | "per 100g" | "per unit" when unit prices can be compared, otherwise null. */
  unit_basis: string | null;
  /** True when the packs hold the same total content (±1 %). */
  same_size: boolean;
  /** True when sizes are within ±15 % in the same dimension — the bar for suggesting "equivalent". */
  within_tolerance: boolean;
  note: string;
}

export interface MappingRow {
  id: number;
  own: MappingProductSide;
  competitor: MappingProductSide;
  /** null = applies in every market. */
  market_id: number | null;
  market_name: string | null;
  /** 'equivalent' = genuinely like-for-like; 'comparable' = explicitly NOT equivalent. */
  equivalence: 'equivalent' | 'comparable';
  status: 'suggested' | 'approved' | 'rejected';
  score: number | null;
  rationale: string | null;
  decided_by: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
  comparability: Comparability;
}

export interface MappingSuggestResponse {
  created: number;
  own_products_considered: number;
  suggestions: MappingRow[];
}
