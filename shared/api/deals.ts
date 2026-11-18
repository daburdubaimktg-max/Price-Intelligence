/**
 * Response types of the Deals API (GET /api/deals): listings that are on offer right now, with the price
 * context of their own stored history — and of the comparison built on the same deals (GET /api/deals/compare).
 * Types only, plus the list of sort keys and the discount bands.
 */
import type { Availability, DataClass, DealTag, Ownership, PromoType } from '../constants.ts';
import type { DemoNote } from './analytics.ts';

/** Sort keys of GET /api/deals. Prefix with "-" for descending; the default is "-discount". */
export type DealSort = 'discount' | 'drop' | 'price' | 'observed' | 'rating' | 'rank';
export const DEAL_SORTS: readonly DealSort[] = ['discount', 'drop', 'price', 'observed', 'rating', 'rank'];

/**
 * One deal: a listing whose latest observation is fresh (not stale by its source's schedule), has a price, and
 *   * carries an offer tag (DEAL_OFFER_TAGS: limited-time deal, sale-event deal, lowest price in N days, deal,
 *     coupon / extra discount, multi-buy offer), or
 *   * is on promotion, or
 *   * sells below its regular price.
 * Badges (DEAL_BADGE_TAGS: best seller, retailer's choice, selling fast, other tag) are shown but do not make a
 * listing a deal on their own, unless the request asks for them with `include_badges=true`.
 *
 * Offers whose latest observation is stale are left out: nobody knows whether they still apply. They are counted
 * in the summary (`stale_deals`) and can be listed with `include_stale=true`, flagged `is_stale` and placed after
 * the fresh ones.
 */
export interface DealRow {
  listing_id: number;
  listing_code: string;
  listing_title: string | null;
  /** Page of the listing at the retailer (the URL the price was seen on, else the configured listing URL). */
  listing_url: string | null;
  external_id: string | null;
  product_id: number | null;
  product_code: string | null;
  product_name: string | null;
  image_url: string | null;
  sku: string | null;
  brand_id: number | null;
  brand_name: string | null;
  ownership: Ownership | null;
  category_id: number | null;
  category_name: string | null;
  subcategory_id: number | null;
  subcategory_name: string | null;
  variant_name: string | null;
  pack_size: number | null;
  pack_unit: string | null;
  units_per_pack: number | null;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  /** IANA time zone of the market. */
  timezone: string;
  /** Currency of every price in this row. */
  currency_code: string;

  /** The latest observation, which all "current" figures come from. */
  observation_id: number;
  observed_at: string;
  /** Age of that observation, and the age after which its source counts as stale (twice its collection interval). */
  age_hours: number;
  stale_after_hours: number;
  /** True only on rows listed because of `include_stale=true`: the offer was last seen too long ago to be relied on. */
  is_stale: boolean;
  data_class: DataClass;
  /** 1 = illustrative DEMO record, never a real market observation. */
  is_demo: 0 | 1;
  current_price: number;
  regular_price: number | null;
  /** How far the current price is below the regular price, in %. Null when it is not below it (or no regular price is known). */
  discount_pct: number | null;
  /** The discount stated with the promotion itself; for coupons and multi-buy offers it can exist without a lower shelf price. */
  promo_discount_pct: number | null;
  /** Price per 100 ml / 100 g / unit, and what it is per ("per 100ml", …). Null when the pack content is unknown. */
  unit_price: number | null;
  unit_basis: string | null;
  tags: DealTag[];
  /** The retailer's own wording of the tag, e.g. "Early Yellow Friday Deal". */
  tag_text: string | null;
  is_promo: 0 | 1;
  promo_type: PromoType | null;
  promo_description: string | null;
  promo_ends_on: string | null;
  availability: Availability;
  rating: number | null;
  review_count: number | null;
  sales_rank: number | null;
  sales_rank_label: string | null;
  seller_name: string | null;

  // ---- context from the listing's own stored history (daily price = last priced observation of a market-local day) ----
  /** Average daily price over the last 30 / 90 days, on the days the listing was observed. */
  avg_30d: number | null;
  avg_90d: number | null;
  /** Lowest / highest daily price of the last 90 days. */
  low_90d: number | null;
  high_90d: number | null;
  /** How far the current price is below its 30-day average, in % (negative = above). Null with fewer than 2 observed days in those 30 days. */
  drop_vs_avg_30d_pct: number | null;
  /** The current price is the lowest of the last 90 days. Only ever true with at least 7 observed days and a price that moved. */
  is_lowest_90d: boolean;
  /** Days with a priced observation in the last 90 days — how much history the context figures rest on. */
  history_days: number;
  /** When the listing was first observed at all. */
  first_observed_at: string | null;
  /** Start of the current uninterrupted run of observations that qualify as a deal. */
  deal_since: string;
}

export interface DealBrandCount {
  brand_id: number | null;
  brand_name: string;
  ownership: Ownership | null;
  deals: number;
  /** Average / deepest discount against the regular price, in % (unit-free, so it is safe across currencies). */
  avg_discount_pct: number | null;
  max_discount_pct: number | null;
}

export interface DealRetailerCount {
  retailer_id: number;
  retailer_name: string;
  market_code: string;
  market_name: string;
  currency_code: string;
  deals: number;
  avg_discount_pct: number | null;
  max_discount_pct: number | null;
}

/** Describes every deal that matches the request (all pages), never just the page returned. Counts and percentages only: prices in different currencies are never added up or averaged. */
export interface DealsSummary {
  total: number;
  own: number;
  competitor: number;
  /** Deals at their 90-day low. */
  lowest_90d: number;
  /**
   * Listings in the same scope whose latest observation would qualify as a deal but is stale. They are not listed
   * (and not counted in `total`) unless the request says `include_stale=true`. Only the scope filters apply to this count.
   */
  stale_deals: number;
  /** Deals carrying each tag. Counted with every filter applied except `tag`, so tag chips keep their numbers while one is selected. */
  by_tag: Record<DealTag, number>;
  /** The 12 brands with the most deals. */
  by_brand: DealBrandCount[];
  by_retailer: DealRetailerCount[];
  /** The deal with the deepest discount against its regular price. */
  deepest: Pick<
    DealRow,
    'listing_id' | 'product_id' | 'product_name' | 'brand_name' | 'retailer_name' | 'market_code' | 'currency_code' | 'current_price' | 'regular_price' | 'discount_pct'
  > | null;
  /** Currencies present among the deals. */
  currencies: string[];
  latest_observation_at: string | null;
  demo: DemoNote;
}

export interface DealsResponse {
  rows: DealRow[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
  summary: DealsSummary;
}

// ---- comparison (GET /api/deals/compare) -------------------------------------------------------------------

/**
 * Discount bands of the comparison, shallowest first. A deal is counted in exactly one band by its discount
 * against the regular price (`min` inclusive, `max` exclusive); the first band holds offers without a lower
 * shelf price (an offer tag, coupon or multi-buy offer only).
 */
export const DEAL_DISCOUNT_BANDS = [
  { key: 'none', label: 'Offer without a price cut', short: 'No price cut', min: null, max: null },
  { key: 'lt10', label: 'Under 10% off', short: '< 10%', min: 0, max: 10 },
  { key: '10_20', label: '10 to under 20% off', short: '10–20%', min: 10, max: 20 },
  { key: '20_30', label: '20 to under 30% off', short: '20–30%', min: 20, max: 30 },
  { key: '30_50', label: '30 to under 50% off', short: '30–50%', min: 30, max: 50 },
  { key: '50_plus', label: '50% off or more', short: '50% +', min: 50, max: null },
] as const;

/**
 * How much of a range is on offer. The range is every active listing in the selection whose latest observation
 * is fresh and has a price — on offer or not — so brands and retailers of different sizes can be compared.
 */
export interface DealShare {
  /** Listings in the range (the base of `share_pct`). */
  listings: number;
  /** Of those, the listings on offer, with every deal filter of the request applied. */
  deals: number;
  /** deals / listings in %. Null without listings. */
  share_pct: number | null;
  /** Average / deepest discount against the regular price among the deals that have a price cut, in %. */
  avg_discount_pct: number | null;
  max_discount_pct: number | null;
}

export interface DealCompareBrand extends DealShare {
  brand_id: number | null;
  brand_name: string;
  ownership: Ownership | null;
  median_discount_pct: number | null;
  /** Deals per entry of DEAL_DISCOUNT_BANDS, in the same order. */
  bands: number[];
  /** Deals carrying each tag (a deal can carry several). */
  tags: Record<DealTag, number>;
}

/** One product range, retailer or market, with own brands and competitors side by side. */
export interface DealCompareGroup {
  /** Value for the matching filter of GET /api/deals (category_id, retailer_id or market_id). */
  id: number;
  name: string;
  /** Parent category of a range; market code of a retailer; null for markets. */
  note: string | null;
  all: DealShare;
  own: DealShare;
  competitor: DealShare;
}

export interface DealCompareCell extends DealShare {
  brand_id: number | null;
  retailer_id: number;
}

export interface DealTrendPoint {
  /** Market-local calendar day. */
  date: string;
  /** Listings with a priced observation on that day, and how many of them were on offer (by the last observation of the day). */
  listings: number;
  deals: number;
  share_pct: number | null;
  avg_discount_pct: number | null;
}

export interface DealTrendSeries {
  brand_id: number | null;
  brand_name: string;
  ownership: Ownership | null;
  points: DealTrendPoint[];
}

/**
 * The deals of a selection as a comparison: who has how much of the range on offer, how deep, where, and how
 * that moved. Percentages and counts only — prices in different currencies are never combined.
 */
export interface DealsComparison {
  totals: { all: DealShare; own: DealShare; competitor: DealShare };
  /** Brands with listings in the selection, largest range first (at most 40). */
  brands: DealCompareBrand[];
  /** Brands in the selection that are not listed because of that limit. */
  brands_omitted: number;
  /** Product ranges: the subcategory of a product, or its category when it has none. */
  ranges: DealCompareGroup[];
  retailers: DealCompareGroup[];
  markets: DealCompareGroup[];
  /** Brand × retailer, for the listed brands; pairs without listings are absent. */
  cells: DealCompareCell[];
  trend: {
    /** First and last market-local day of the window (the last 30 days). */
    from: string;
    to: string;
    /** Days in the window on which anything in the selection was observed. */
    observed_days: number;
    series: DealTrendSeries[];
    /** Deal filters of the request that the daily figures cannot apply (e.g. "90-day low only"). */
    not_applied: string[];
  };
  latest_observation_at: string | null;
  demo: DemoNote;
}
