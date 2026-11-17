/**
 * Response types of the Brand Explorer API (GET /brand-explorer and GET /brand-explorer/:id).
 * Shared by the server (which produces them) and the web client (which renders them). Types only — no runtime code.
 *
 * Rules every figure here follows
 *   * "Current" figures (price ranges, promotion share, cheapest retailer, matrix marks) use FRESH listings only:
 *     listings observed recently enough for their source's schedule. Stale and never-observed listings are counted
 *     separately and never mixed in.
 *   * Prices in different currencies are never blended: there is one figure per currency, unless a comparison
 *     currency was requested — then every value is converted and the rates used are returned (`conversions`).
 *   * Unit prices are per 100 ml / 100 g / unit; different bases are never averaged together.
 *   * Indexed trends are unit-free (each listing's first price in the period = 100), so they may span currencies.
 */
import type { Conversion, DateRange, DemoNote, TimelineResult } from './analytics.ts';

/** Current selling-price range of the fresh, priced listings in ONE currency. */
export interface BrandPriceRange {
  currency: string;
  /** Fresh listings with a price — what the three figures are computed from. */
  listings: number;
  min: number;
  median: number;
  max: number;
}

export interface BrandFreshness {
  /** Observed recently enough for their source's collection schedule. */
  fresh: number;
  /** Observed, but longer ago than the schedule allows. Left out of every "current" figure. */
  stale: number;
  never_observed: number;
  last_observed_at: string | null;
}

export interface BrandPromo {
  /** Fresh listings currently on promotion. */
  listings: number;
  /** Share of fresh listings on promotion, in %. Null when there is no fresh listing. */
  share_pct: number | null;
  /** Average discount of the current promotions that state a discount. */
  avg_discount_pct: number | null;
  deepest_discount_pct: number | null;
}

/** Selling-price changes (price_change events) in a period. */
export interface BrandMoves {
  increases: number;
  decreases: number;
}

export interface BrandTrendPoint {
  date: string;
  /** Average of the listing-level indices on that day (each listing's first price in the period = 100). */
  index: number;
  /** Listings contributing on that day. */
  listings: number;
}

export interface BrandPriceIndex {
  /** own ÷ competitor × 100 over mapped same-retailer pairs. 100 = parity; above 100 the OWN side is more expensive. */
  index: number | null;
  premium_pct: number | null;
  /** Pairs with a usable index. */
  pairs: number;
  cheaper_pairs: number;
  dearer_pairs: number;
  /** Mapped pairs measured in different units (g vs ml): no index is stated for them. */
  not_comparable_pairs: number;
  /**
   * Who is compared with whom. `own_vs_competitors`: this own brand against its mapped competitor products.
   * `own_vs_this_brand`: mapped own products against this competitor brand.
   */
  perspective: 'own_vs_competitors' | 'own_vs_this_brand';
}

export interface BrandCategoryCount {
  id: number | null;
  name: string;
  parent_name: string | null;
  /** Listed products of the brand in this category. */
  products: number;
}

/** One brand in a scope (markets / retailers / categories). */
export interface BrandExplorerRow {
  id: number;
  name: string;
  ownership: 'own' | 'competitor';
  manufacturer: string | null;
  is_demo: number;
  /** Distinct products with at least one active listing in scope. */
  products: number;
  listings: number;
  retailers: number;
  markets: number;
  /** The three categories with most listed products. */
  categories: BrandCategoryCount[];
  category_count: number;
  freshness: BrandFreshness;
  /** One entry per currency (most listings first); a single entry in the comparison currency when converted. */
  price_ranges: BrandPriceRange[];
  promo: BrandPromo;
  moves_7d: BrandMoves;
  moves_30d: BrandMoves;
  /** Indexed price trend of the last 30 days (see BrandTrendPoint). */
  trend: BrandTrendPoint[];
  /** Last trend value − 100: average price change of the brand's listings over the period, in %. */
  trend_change_pct: number | null;
  /** Null when no approved mapping of the brand has a current same-retailer price pair. */
  price_index: BrandPriceIndex | null;
  /**
   * Deal tags and badges (keys such as "limited_time_deal", "best_seller") carried by the latest observation of
   * the brand's FRESH listings, most frequent first. The three fields are absent when no fresh listing is tagged.
   */
  tags?: string[];
  /** Fresh listings per tag. */
  tag_counts?: Record<string, number>;
  /** Fresh listings carrying at least one tag. */
  tagged_listings?: number;
}

export interface BrandExplorerSummary {
  brands: number;
  own_brands: number;
  competitor_brands: number;
  products: number;
  own_products: number;
  competitor_products: number;
  listings: number;
  fresh_listings: number;
  stale_listings: number;
  never_observed_listings: number;
  retailers: number;
  markets: number;
  currencies: string[];
  /** Catalogue brands matching the ownership / search filter that have no listed product in this scope. */
  brands_without_listings: number;
}

export interface CurrencyDisclosure {
  currency_mode: 'native' | 'converted';
  target_currency: string | null;
  /** Rates used for converted figures: rate, timestamp and source of each. */
  conversions: Conversion[];
  /** Currencies without an exchange rate — their listings are left out of converted figures. */
  missing_rates: string[];
}

export interface BrandExplorerResult extends CurrencyDisclosure {
  generated_at: string;
  today: string;
  trend_period: DateRange;
  sort: string;
  rows: BrandExplorerRow[];
  summary: BrandExplorerSummary;
  demo: DemoNote;
}

// ---------------------------------------------------------------------------------------------
// Brand page
// ---------------------------------------------------------------------------------------------
/** Current price of one product in ONE currency: standard-pack listings with a fresh price. */
export interface BrandRangePrice {
  currency: string;
  listings: number;
  min: number;
  avg: number;
  max: number;
  /** Average price per 100 ml / 100 g / unit over the same listings (basis: BrandRangeRow.unit_basis). */
  avg_unit_price: number | null;
}

export interface BrandCheapest {
  market_id: number;
  market_code: string;
  market_name: string;
  retailer_id: number;
  retailer_name: string;
  listing_id: number;
  /** In `currency` (the comparison currency when converted, else the retailer's own). */
  price: number;
  currency: string;
  native_price: number;
  native_currency: string;
  is_promo: boolean;
  /** Retailers of the market with a fresh price for the product. 1 = the only one, so nothing was compared. */
  compared: number;
  /** Other retailers at exactly the same lowest price. */
  tied: number;
}

export interface BrandRangeRow {
  product_id: number;
  code: string | null;
  name: string;
  sku: string | null;
  status: string;
  pack: string;
  /** 'per 100ml' | 'per 100g' | 'per unit' | null when the pack content is unknown. */
  unit_basis: string | null;
  category_id: number | null;
  category_name: string | null;
  subcategory_name: string | null;
  image_url: string | null;
  is_demo: number;
  /** Active listings in scope (0 = not listed in this scope). */
  listings: number;
  retailers: number;
  markets: number;
  fresh: number;
  stale: number;
  never_observed: number;
  /** Listings of pack variants (twin packs, bonus packs…): left out of shelf-price figures, they differ by construction. */
  variant_listings: number;
  /** One entry per currency; a single entry in the comparison currency when converted. */
  prices: BrandRangePrice[];
  /** Lowest fresh shelf price per market. */
  cheapest: BrandCheapest[];
  promo_listings: number;
  deepest_discount_pct: number | null;
  deepest_discount_retailer: string | null;
  /** Average change of its listings' prices over the last 30 days (each against its own first price), in %. */
  change_30d_pct: number | null;
  trend: BrandTrendPoint[];
  last_observed_at: string | null;
  /** Deal tags and badges of the product's fresh listings (see BrandExplorerRow.tags). Absent when there are none. */
  tags?: string[];
  tag_counts?: Record<string, number>;
  tagged_listings?: number;
}

export interface BrandMatrixListing {
  listing_id: number;
  variant_name: string | null;
  current_price: number | null;
  unit_price: number | null;
  is_promo: boolean;
  is_stale: boolean;
  never_observed: boolean;
}

/** One product at one retailer. */
export interface BrandMatrixCell extends BrandMatrixListing {
  currency: string;
  /** Regular (list) price — only when the listing currently sells below it. */
  regular_price: number | null;
  discount_pct: number | null;
  promo_type: string | null;
  availability: string | null;
  observed_at: string | null;
  /** The cell shows a pack variant because the retailer lists no standard pack: not part of the shelf-price comparison. */
  is_variant: boolean;
  /** Lowest fresh shelf price of the product among the retailers shown. Only set when at least two were compared. */
  is_cheapest: boolean;
  /** Further listings of the same product at this retailer (pack variants, duplicates). */
  more_listings: BrandMatrixListing[];
  is_demo: number;
  /** Deal tags and badges of the latest observation — only for a fresh listing, absent when it carries none. */
  tags?: string[];
  /** The retailer's own wording of the tags, e.g. "Early Yellow Friday Deal". */
  tag_text?: string;
}

export interface BrandMatrixRow {
  product_id: number;
  code: string | null;
  name: string;
  pack: string;
  unit_basis: string | null;
  category_name: string | null;
  is_demo: number;
  /** One entry per retailer column, in the same order. null = the retailer does not list the product. */
  cells: Array<BrandMatrixCell | null>;
  /** Retailers listing the product. */
  listed_at: number;
  /** Retailers whose fresh shelf price entered the comparison. */
  compared: number;
  cheapest_retailer_ids: number[];
  min_price: number | null;
  max_price: number | null;
  /** (highest − lowest) ÷ lowest × 100 across the compared retailers. */
  spread_pct: number | null;
}

export interface BrandMatrixRetailer {
  id: number;
  name: string;
  is_demo: number;
  /** Listings / products of the brand at this retailer (in scope). */
  listings: number;
  products: number;
  /** Rows in which this retailer has the lowest fresh price. */
  cheapest_count: number;
}

export interface BrandMatrix {
  market: { id: number; code: string; name: string; currency_code: string; timezone: string };
  /** Currency of the comparison (the market's retailers share it; any other is listed in `other_currencies`). */
  currency: string;
  other_currencies: string[];
  retailers: BrandMatrixRetailer[];
  rows: BrandMatrixRow[];
  /** Active retailers of the market that list none of the brand's products in scope. */
  retailers_without_brand: Array<{ id: number; name: string }>;
  /** Products of the brand (in scope) that no retailer of this market lists. */
  products_not_listed: Array<{ product_id: number; name: string }>;
}

export interface BrandMarketOption {
  id: number;
  code: string;
  name: string;
  currency_code: string;
  listings: number;
  products: number;
  retailers: number;
}

export interface BrandIndexSeries {
  brand_id: number;
  name: string;
  ownership: 'own' | 'competitor';
  /** The brand of the page (the others are its benchmark brands). */
  is_self: boolean;
  is_demo: number;
  points: BrandTrendPoint[];
  change_pct: number | null;
}

export interface BrandTrend {
  days: number;
  period: DateRange;
  /** Daily average unit price per category of the brand: one series per category × currency × unit basis. */
  by_category: TimelineResult;
  /** Unit-free price index of the brand and of its benchmark brands (at most 8 series). */
  index: BrandIndexSeries[];
}

/** A brand this brand competes with: declared as a benchmark in the catalogue and / or linked by product mappings. */
export interface BrandCompetitorRow {
  /** That brand in the same scope. */
  brand: BrandExplorerRow;
  /** Declared in the catalogue (brand_competitors). */
  is_benchmark: boolean;
  approved_mappings: number;
  suggested_mappings: number;
  /** The own brand and the competitor brand of the comparison — the index is always own ÷ competitor × 100. */
  own_brand_name: string;
  competitor_brand_name: string;
  index: number | null;
  premium_pct: number | null;
  pairs: number;
  cheaper_pairs: number;
  dearer_pairs: number;
  not_comparable_pairs: number;
}

export interface BrandDetailResult extends CurrencyDisclosure {
  generated_at: string;
  today: string;
  brand: BrandExplorerRow & {
    is_active: number;
    /** Products of the brand in the catalogue (not archived), in the category scope. */
    products_total: number;
  };
  scope: { market_ids: number[] | null; retailer_ids: number[] | null; category_ids: number[] | null };
  range: BrandRangeRow[];
  /** Markets in scope where the brand is listed (most listings first) — the choices for the price matrix. */
  markets: BrandMarketOption[];
  /** Products × retailers of ONE market. Null when the brand has no listing in scope. */
  matrix: BrandMatrix | null;
  trend: BrandTrend;
  competitors: BrandCompetitorRow[];
  /** Unmatched listings whose title contains the brand name (they are not part of any figure above). */
  unmatched: { count: number; search: string };
  demo: DemoNote;
}
