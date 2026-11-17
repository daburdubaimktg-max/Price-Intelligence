/**
 * Response types of the analytics API (overview, monitor, events, history, competitors, promotions,
 * market intelligence). Shared by the server (which produces them) and the web client (which renders them).
 * Types only — no runtime code.
 */

export interface Stats {
  n: number;
  avg: number;
  median: number;
  min: number;
  max: number;
  stddev: number;
  /** Coefficient of variation in % (stddev / mean) — the volatility measure used across the product. */
  volatility_pct: number;
  first: number;
  last: number;
  /** % movement from the first to the last value. */
  change_pct: number | null;
}

export interface DateRange {
  from: string;
  to: string;
}

/** Summary of how much of a result is DEMO data, attached to analytics responses for honest labelling. */
export interface DemoNote {
  demo_rows: number;
  total_rows: number;
  all_demo: boolean;
  any_demo: boolean;
}

export interface Conversion {
  from: string;
  to: string;
  /** Multiply an amount in `from` by this to get `to`. */
  rate: number;
  /** Timestamp of the oldest rate leg used. */
  as_of: string;
  sources: string[];
  is_demo: boolean;
}

/** What a series / comparison row refers to, so the UI can link to it. */
export interface SeriesRef {
  listing_id?: number;
  product_id?: number | null;
  retailer_id?: number;
  brand_id?: number | null;
  market_id?: number;
  category_id?: number | null;
}

export type GroupBy = 'listing' | 'product' | 'retailer' | 'brand' | 'market' | 'category' | 'ownership';

export type Metric = 'price' | 'unit_price' | 'regular_price' | 'discount';

export interface TimelinePoint {
  date: string;
  value: number;
  /** Listings contributing on this day. */
  n: number;
  /** Share of contributing listings on promotion (0–1). */
  promo: number;
}

export interface TimelineSeries {
  key: string;
  label: string;
  sublabel: string | null;
  ownership: 'own' | 'competitor' | 'mixed' | null;
  currency: string | null;
  basis: string | null;
  ref: SeriesRef;
  listing_count: number;
  is_demo: boolean;
  points: TimelinePoint[];
  stats: Stats | null;
}

export interface TimelineResult {
  group_by: GroupBy;
  metric: Metric;
  bucket: 'day' | 'week';
  currency_mode: 'native' | 'converted';
  target_currency: string | null;
  series: TimelineSeries[];
  total_series: number;
  truncated: boolean;
  conversions: Conversion[];
  missing_rates: string[];
  demo: DemoNote;
  from: string | null;
  to: string | null;
}

export interface PeriodStats {
  avg: number;
  median: number;
  min: number;
  max: number;
  /** Listing-days observed. */
  points: number;
  days: number;
  listings: number;
  promo_share_pct: number;
  volatility_pct: number;
}

export interface CompareRow {
  key: string;
  label: string;
  sublabel: string | null;
  ownership: 'own' | 'competitor' | 'mixed' | null;
  currency: string | null;
  basis: string | null;
  ref: SeriesRef;
  is_demo: boolean;
  a: PeriodStats | null;
  b: PeriodStats | null;
  delta_abs: number | null;
  delta_pct: number | null;
}

export interface PeriodCompareResult {
  group_by: GroupBy;
  metric: Metric;
  period_a: DateRange;
  period_b: DateRange;
  currency_mode: 'native' | 'converted';
  target_currency: string | null;
  rows: CompareRow[];
  summary: {
    groups: number;
    comparable: number;
    increased: number;
    decreased: number;
    unchanged: number;
    avg_change_pct: number | null;
    only_in_a: number;
    only_in_b: number;
  };
  conversions: Conversion[];
  missing_rates: string[];
  demo: DemoNote;
}

export interface HistorySummary {
  observations: number;
  listings: number;
  products: number;
  retailers: number;
  markets: number;
  brands: number;
  first_observed_at: string | null;
  last_observed_at: string | null;
  promo_observations: number;
  promo_share_pct: number | null;
  by_data_class: Array<{ data_class: string; observations: number }>;
  /** Selling-price statistics per currency (never blended across currencies). */
  by_currency: Array<{ currency: string; observations: number; avg: number; median: number; min: number; max: number; volatility_pct: number }>;
  demo_observations: number;
}

export interface VolatilityRow {
  key: string;
  label: string;
  sublabel: string | null;
  ownership: 'own' | 'competitor' | null;
  currency: string;
  product_id: number | null;
  listing_id: number | null;
  retailer_name: string | null;
  market_name: string | null;
  days: number;
  price_changes: number;
  avg: number;
  min: number;
  max: number;
  range_pct: number | null;
  volatility_pct: number;
  is_demo: boolean;
}

export interface MonitorRow {
  listing_id: number;
  listing_code: string;
  listing_title: string | null;
  listing_url: string | null;
  external_id: string | null;
  match_status: string;
  product_id: number | null;
  product_code: string | null;
  product_name: string | null;
  sku: string | null;
  brand_id: number | null;
  brand_name: string | null;
  ownership: 'own' | 'competitor' | null;
  category_name: string | null;
  subcategory_name: string | null;
  variant_name: string | null;
  pack_size: number | null;
  pack_unit: string | null;
  units_per_pack: number;
  content_dimension: string | null;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  timezone: string;
  currency_code: string;
  collection_method: string;
  collection_frequency: string;
  retailer_enabled: number;
  is_demo: number;
  observation_id: number | null;
  regular_price: number | null;
  current_price: number | null;
  promo_price: number | null;
  discount_pct: number | null;
  is_promo: number | null;
  promo_type: string | null;
  promo_description: string | null;
  promo_ends_on: string | null;
  availability: string | null;
  unit_price: number | null;
  observed_at: string | null;
  collected_at: string | null;
  source_method: string | null;
  data_class: string | null;
  confidence: number | null;
  obs_count: number;
  first_observed_at: string | null;
  /** Price of the immediately preceding observation. */
  prev_price: number | null;
  prev_observed_at: string | null;
  /** Most recent actual change of the selling price. */
  change_old_price: number | null;
  change_new_price: number | null;
  change_abs: number | null;
  change_pct: number | null;
  change_direction: 'up' | 'down' | null;
  changed_at: string | null;
  age_hours: number | null;
  stale_after_hours: number;
  is_stale: number;
}

export interface MonitorFacets {
  listings: number;
  observed: number;
  never_observed: number;
  stale: number;
  on_promo: number;
  out_of_stock: number;
  changed_24h: number;
  increases_24h: number;
  decreases_24h: number;
  latest_observation_at: string | null;
  demo_listings: number;
}

export interface PriceEventRow {
  id: number;
  kind: 'price_change' | 'availability_change' | 'promo_start' | 'promo_end';
  direction: 'up' | 'down' | null;
  old_price: number | null;
  new_price: number | null;
  change_abs: number | null;
  change_pct: number | null;
  old_availability: string | null;
  new_availability: string | null;
  occurred_at: string;
  occurred_local_date: string;
  observation_id: number;
  prev_observation_id: number;
  listing_id: number;
  product_id: number | null;
  product_name: string | null;
  brand_name: string | null;
  ownership: 'own' | 'competitor' | null;
  pack_size: number | null;
  pack_unit: string | null;
  units_per_pack: number;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  timezone: string;
  currency_code: string;
  data_class: string;
  source_method: string;
  is_promo: number;
  promo_type: string | null;
  promo_description: string | null;
  discount_pct: number | null;
  is_demo: number;
}

export type GapBasis = 'shelf' | 'unit' | 'not_comparable';

export interface PairRow {
  mapping_id: number;
  equivalence: 'equivalent' | 'comparable';
  mapping_status: string;
  own_listing_id: number;
  comp_listing_id: number;
  own_product_id: number;
  own_product_name: string;
  own_brand_id: number;
  own_brand_name: string;
  own_category_id: number | null;
  own_category_name: string | null;
  comp_product_id: number;
  comp_product_name: string;
  comp_brand_id: number;
  comp_brand_name: string;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_name: string;
  currency_code: string;
  own_price: number;
  comp_price: number;
  own_unit_price: number | null;
  comp_unit_price: number | null;
  own_pack: string;
  comp_pack: string;
  unit_basis: string | null;
  own_is_promo: number;
  comp_is_promo: number;
  own_observed_at: string;
  comp_observed_at: string;
  basis: GapBasis;
  /** own ÷ competitor × 100 on the stated basis. 100 = parity, above 100 = own is more expensive. */
  index: number | null;
  gap_pct: number | null;
  /** own − competitor in the retailer currency, on the stated basis. */
  gap_abs: number | null;
  is_demo: boolean;
}

export interface PositionGroup {
  key: string;
  label: string;
  /** Average of the pair indices. 100 = parity with mapped competitors. */
  index: number | null;
  premium_pct: number | null;
  pairs: number;
  own_products: number;
  competitor_products: number;
  retailers: number;
  cheaper_pairs: number;
  dearer_pairs: number;
}

export interface Positioning {
  overall: PositionGroup;
  by_category: PositionGroup[];
  by_brand: PositionGroup[];
  by_market: PositionGroup[];
  not_comparable_pairs: number;
  demo: DemoNote;
}

export interface OwnProductPosition {
  product_id: number;
  product_code: string;
  product_name: string;
  brand_name: string;
  category_name: string | null;
  pack: string;
  is_demo: boolean;
  approved_mappings: number;
  suggested_mappings: number;
  listings: number;
  index: number | null;
  premium_pct: number | null;
  pairs: number;
  retailers: number;
  markets: number;
  cheapest_vs: { product_name: string; gap_pct: number } | null;
  dearest_vs: { product_name: string; gap_pct: number } | null;
  /** not_comparable: mapped competitors exist but are measured in different units, so no index can be stated. */
  position: 'premium' | 'parity' | 'discount' | 'no_data' | 'not_comparable' | 'not_mapped';
}

export interface CompareListingRow {
  role: 'own' | 'competitor';
  mapping_id: number | null;
  equivalence: 'equivalent' | 'comparable' | null;
  mapping_status: string | null;
  listing_id: number;
  product_id: number;
  product_name: string;
  brand_name: string;
  variant_name: string | null;
  pack: string;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_name: string;
  timezone: string;
  currency_code: string;
  price: number | null;
  regular_price: number | null;
  is_promo: boolean;
  discount_pct: number | null;
  promo_description: string | null;
  availability: string | null;
  observed_at: string | null;
  is_stale: boolean;
  data_class: string | null;
  is_demo: boolean;
  unit_price: number | null;
  unit_basis: string | null;
  /** Lowest / highest / average selling price observed in the period (daily prices). */
  period: { min: number; max: number; avg: number; days: number } | null;
  /** Reference own price this competitor row is compared against. */
  own_reference: { scope: 'same_retailer' | 'market_average'; price: number; unit_price: number | null } | null;
  gap_basis: GapBasis | null;
  gap_abs: number | null;
  gap_pct: number | null;
  /** Values converted to the requested comparison currency (null when native or no rate). */
  converted: { currency: string; price: number | null; unit_price: number | null } | null;
}

export interface CompetitorSummary {
  product_id: number;
  product_name: string;
  brand_name: string;
  pack: string;
  equivalence: 'equivalent' | 'comparable';
  mapping_status: string;
  mapping_id: number;
  rationale: string | null;
  comparable: boolean;
  note: string | null;
  listings: number;
  compared_listings: number;
  avg_gap_pct: number | null;
  min_gap_pct: number | null;
  max_gap_pct: number | null;
  own_cheaper_at: number;
  own_dearer_at: number;
}

export interface CompetitorCompareResult {
  product: {
    id: number; code: string; name: string; brand_name: string; ownership: string; category_name: string | null; pack: string;
    unit_basis: string | null; is_demo: boolean;
  };
  period: DateRange;
  currency_mode: 'native' | 'converted';
  target_currency: string | null;
  rows: CompareListingRow[];
  competitors: CompetitorSummary[];
  history: {
    metric: 'unit_price' | 'price';
    currency: string | null;
    basis: string | null;
    series: Array<{ product_id: number; label: string; role: 'own' | 'competitor'; equivalence: string | null; points: Array<{ date: string; value: number; n: number }> }>;
    note: string | null;
  };
  conversions: Conversion[];
  missing_rates: string[];
  notes: string[];
  demo: DemoNote;
}

export interface PromotionRecord {
  id: number;
  listing_id: number;
  promo_type: string;
  description: string | null;
  status: 'active' | 'ended';
  /** Active and its listing was observed recently enough to trust that it is still running. */
  is_current: number;
  end_reason: string | null;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  start_local_date: string;
  end_local_date: string;
  duration_days: number;
  promo_days_observed: number;
  observation_count: number;
  currency_code: string;
  regular_price: number | null;
  min_promo_price: number | null;
  max_discount_pct: number | null;
  avg_discount_pct: number | null;
  stated_start: string | null;
  stated_end: string | null;
  is_demo: number;
  product_id: number | null;
  product_name: string | null;
  brand_id: number | null;
  brand_name: string | null;
  ownership: 'own' | 'competitor' | null;
  category_name: string | null;
  subcategory_name: string | null;
  pack_size: number | null;
  pack_unit: string | null;
  units_per_pack: number;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  timezone: string;
}

export interface PromoBreakdown {
  key: string;
  label: string;
  ownership?: 'own' | 'competitor' | null;
  episodes: number;
  current: number;
  avg_discount_pct: number | null;
  max_discount_pct: number | null;
  avg_duration_days: number | null;
  /** Share of observed listing-days on promotion in the period (0–100). */
  promo_day_share_pct: number | null;
  promo_listing_days: number;
}

export interface PromotionSummary {
  period: DateRange;
  kpis: {
    episodes: number;
    current: number;
    listings_with_promo: number;
    listings_observed: number;
    avg_discount_pct: number | null;
    highest_discount_pct: number | null;
    highest_discount: { product_name: string | null; retailer_name: string; market_name: string; started_at: string; promo_type: string } | null;
    /** Calendar days in the period on which at least one promotion was observed. */
    promo_calendar_days: number;
    /** Listing-days on promotion (a listing observed on promotion on a given day counts once). */
    promo_listing_days: number;
    observed_listing_days: number;
    promo_day_share_pct: number | null;
    /** % of raw observations in the period that showed promotional pricing. */
    promo_observation_share_pct: number | null;
    observations: number;
    avg_duration_days: number | null;
    /** Promotions started per observed listing per 30 days. */
    frequency_per_listing_30d: number | null;
    /** Average number of days between the end of one promotion and the start of the next (same listing). */
    avg_days_between: number | null;
  };
  by_type: PromoBreakdown[];
  by_ownership: PromoBreakdown[];
  by_brand: PromoBreakdown[];
  by_retailer: PromoBreakdown[];
  top_discounts: PromotionRecord[];
  demo: DemoNote;
}

export interface PromoTimelineRow {
  key: string;
  label: string;
  sublabel: string | null;
  ownership: 'own' | 'competitor' | null;
  episodes: Array<{
    id: number;
    start: string;
    end: string;
    promo_type: string;
    max_discount_pct: number | null;
    status: string;
    is_current: number;
    product_name: string | null;
    retailer_name: string;
    market_code: string;
    description: string | null;
    is_demo: number;
  }>;
}

export interface PromoCalendarDay {
  date: string;
  own_on_promo: number;
  own_observed: number;
  competitor_on_promo: number;
  competitor_observed: number;
  own_share_pct: number | null;
  competitor_share_pct: number | null;
  avg_discount_pct: number | null;
}

export interface RunStats {
  runs: number;
  succeeded: number;
  partial: number;
  failed: number;
  not_configured: number;
  /** (succeeded + partial) ÷ finished attempts, in %. Null when there were no attempts. */
  success_rate_pct: number | null;
}

export interface MarketOverviewRow {
  id: number;
  code: string;
  name: string;
  country_name: string;
  region: string | null;
  currency_code: string;
  timezone: string;
  local_time: string;
  default_frequency: string;
  is_active: boolean;
  retailers: { total: number; enabled: number; paused: number; demo: number; by_method: Record<string, number>; by_frequency: Record<string, number> };
  listings: { active: number; observed: number; fresh: number; stale: number; never_observed: number; on_promo: number; unmatched: number };
  products: { own: number; competitor: number };
  last_observation_at: string | null;
  events: { increases: number; decreases: number };
  collection: { real: RunStats; simulated: RunStats };
  position: { index: number | null; premium_pct: number | null; pairs: number } | null;
  mapping_coverage: { own_products_listed: number; with_competitor_price: number };
  status: 'healthy' | 'attention' | 'no_data' | 'inactive';
  status_reason: string;
  demo_only: boolean;
}

export interface CrossMarketRow {
  market_id: number;
  market_code: string;
  market_name: string;
  currency_code: string;
  retailers: number;
  listings: number;
  /** Latest selling prices in the market's own currency. */
  native: { avg: number; min: number; max: number; unit_avg: number | null } | null;
  /** The same, converted to the comparison currency. */
  converted: { avg: number | null; min: number | null; max: number | null; unit_avg: number | null } | null;
  /** Average over the period (daily prices), converted. */
  period_avg_converted: number | null;
  on_promo: number;
  last_observed_at: string | null;
  /** Converted average price relative to the base market (= 100). */
  index: number | null;
  conversion: Conversion | null;
  is_demo: boolean;
}

export interface CrossMarketProductResult {
  product: { id: number; code: string; name: string; brand_name: string; ownership: string; pack: string; unit_basis: string | null; is_demo: boolean };
  currency: string;
  base_market_id: number | null;
  period: DateRange;
  rows: CrossMarketRow[];
  missing_rates: string[];
  notes: string[];
  demo: DemoNote;
}

export interface CrossMarketGroupRow {
  market_id: number;
  market_code: string;
  market_name: string;
  currency_code: string;
  basis: string;
  own: { unit_avg: number; products: number; listings: number } | null;
  competitor: { unit_avg: number; products: number; listings: number } | null;
  /** own ÷ competitor × 100 on converted unit prices (same basis only). */
  index: number | null;
  conversion: Conversion | null;
  is_demo: boolean;
}

export interface OverviewResult {
  generated_at: string;
  today: string;
  period: DateRange;
  period_days: number;
  market_ids: number[] | null;
  kpis: {
    products_monitored: number;
    products_total: number;
    retailers_monitored: number;
    retailers_total: number;
    brands_total: number;
    brands_own: number;
    brands_competitor: number;
    markets_active: number;
    markets_with_data: number;
    listings_active: number;
    observations_total: number;
    observations_24h: number;
    observations_period: number;
    latest_observation_at: string | null;
    price_increases: number;
    price_decreases: number;
    active_promotions: number;
    active_promotion_products: number;
    listings_stale: number;
    listings_never_observed: number;
    products_missing_or_stale: number;
    collection: { real: RunStats; simulated: RunStats };
  };
  /** How the ledger is composed, so demo / imported / manual / collected data are never confused. */
  provenance: Array<{ data_class: string; observations: number; share_pct: number; last_observed_at: string | null }>;
  demo: { observations: number; share_pct: number; present: boolean };
  price_movement: Array<{
    date: string;
    increases: number;
    decreases: number;
    avg_increase_pct: number | null;
    avg_decrease_pct: number | null;
    /** Average price level of listings relative to their first price in the period (= 100). */
    own_index: number | null;
    competitor_index: number | null;
  }>;
  positioning: Positioning;
  recent_changes: PriceEventRow[];
  promotions: { current: PromotionRecord[]; calendar: PromoCalendarDay[]; own_current: number; competitor_current: number; avg_current_discount_pct: number | null };
  markets: MarketOverviewRow[];
}
