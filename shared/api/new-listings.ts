/**
 * Response types of the New Products API (GET /api/new-listings): listings that appeared at a retailer
 * recently — after that retailer's baseline. Types and a few constants only.
 */
import type { CollectionMethod, DataClass, DealTag, Ownership } from '../constants.ts';
import type { DemoNote } from './analytics.ts';

/**
 * A listing counts as new only if it was first seen more than this many hours after the first listing of its
 * retailer — and, where its brand is known, of that brand at that retailer — was first seen. A first load is a
 * baseline, not a launch.
 */
export const NEW_LISTING_BASELINE_HOURS = 48;

export const NEW_LISTING_PERIODS = [7, 30, 90] as const;
export type NewListingPeriod = (typeof NEW_LISTING_PERIODS)[number];

/**
 * `new_product`      the listing is not matched to a product yet, or every other listing of its product is just
 *                    as new: nothing says the product was on sale anywhere before.
 * `new_at_retailer`  its product was already listed somewhere else before: a distribution change, not a launch.
 */
export type NewListingKind = 'new_product' | 'new_at_retailer';
export const NEW_LISTING_KINDS: readonly NewListingKind[] = ['new_product', 'new_at_retailer'];

/** Where the brand of a row comes from. `title` and `url` are guesses from the retailer's wording, never stored. */
export type BrandBasis = 'product' | 'title' | 'url';

export type ReviewState = 'needs_review' | 'matched' | 'ignored';

export type NewListingSort = 'first_seen' | 'brand' | 'retailer';
export const NEW_LISTING_SORTS: readonly NewListingSort[] = ['first_seen', 'brand', 'retailer'];

export interface NewListingRow {
  listing_id: number;
  listing_code: string | null;
  /** Title as the retailer shows it. */
  listing_title: string | null;
  listing_url: string | null;
  external_id: string | null;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  /** IANA time zone of the market. */
  timezone: string;
  currency_code: string;
  /** When this system first saw the listing. */
  first_seen_at: string;
  kind: NewListingKind;
  review_state: ReviewState;
  product_id: number | null;
  product_code: string | null;
  product_name: string | null;
  image_url: string | null;
  category_name: string | null;
  /** Brand of the matched product, or — for an unmatched listing — the brand recognised in its title or address. */
  brand_id: number | null;
  brand_name: string | null;
  ownership: Ownership | null;
  /** How the brand is known. Null when no brand could be recognised. */
  brand_basis: BrandBasis | null;
  /** For `new_at_retailer`: the retailers that already listed the product before (names with market code), at most five. */
  listed_before_at: string[];
  listed_before_count: number;
  /** The first priced observation of the listing; null when the item had no readable price. */
  first_price: number | null;
  first_regular_price: number | null;
  first_observed_at: string | null;
  tags: DealTag[];
  tag_text: string | null;
  data_class: DataClass | null;
  /** 1 = illustrative DEMO record, never a real market observation. */
  is_demo: 0 | 1;
}

export interface NewListingBrandCount {
  /** Null = no brand recognised. */
  brand_id: number | null;
  brand_name: string;
  ownership: Ownership | null;
  count: number;
  new_products: number;
  new_at_retailer: number;
  /** How many of them carry the brand as a guess from the title or address (unmatched listings). */
  recognised: number;
}

export interface NewListingRetailerCount {
  retailer_id: number;
  retailer_name: string;
  market_code: string;
  market_name: string;
  count: number;
  new_products: number;
  new_at_retailer: number;
}

/** A first load inside the period: counted as a baseline, never as launches. */
export interface NewListingBaseline {
  scope: 'retailer' | 'brand';
  retailer_id: number;
  retailer_name: string;
  market_code: string;
  /** Set for `brand` baselines (a brand seen at a retailer for the first time). */
  brand_id: number | null;
  brand_name: string | null;
  ownership: Ownership | null;
  /** First sighting, and when the baseline window ends (first sighting + NEW_LISTING_BASELINE_HOURS). */
  started_at: string;
  ends_at: string;
  /** Listings that belong to this baseline. */
  listings: number;
}

/** Whether a source can find products it does not know yet. */
export type DiscoveryState = 'on' | 'off' | 'not_supported';

export interface NewListingSource {
  retailer_id: number;
  retailer_name: string;
  market_code: string;
  collection_method: CollectionMethod;
  /**
   * `on` / `off`: the setting "Add unknown items as unmatched listings" of a feed, API or provider source.
   * `not_supported`: the source only reads the listings it is given (website extraction, imports, manual entry).
   */
  discovery: DiscoveryState;
  listings: number;
  /** First sighting of any listing of this retailer; null when it has none. */
  baseline_started_at: string | null;
  baseline_ends_at: string | null;
  is_demo: 0 | 1;
}

/** Describes every row that matches the request except the `kind` filter, so the two kinds keep their numbers while one is selected. */
export interface NewListingsSummary {
  total: number;
  new_products: number;
  new_at_retailer: number;
  needs_review: number;
  own: number;
  competitor: number;
  /** Rows without a recognised brand. */
  unrecognised: number;
  /** Ignored listings in the same scope; they are left out unless the request says `include_ignored=true`. */
  ignored: number;
  by_brand: NewListingBrandCount[];
  by_retailer: NewListingRetailerCount[];
  latest_first_seen_at: string | null;
  demo: DemoNote;
}

export interface NewListingsSeries {
  /** `day` for the 7-day period, otherwise calendar weeks starting on Monday (market-local dates). */
  bucket: 'day' | 'week';
  /** First day of every bucket (ISO date), oldest first. */
  starts: string[];
  /** At most seven brands: own brands first, then competitors, each by number of new listings. */
  brands: Array<{ key: string; brand_id: number; brand_name: string; ownership: Ownership | null; counts: number[] }>;
  /** Every other recognised brand together, and the rows without a recognised brand. */
  other: number[];
  unrecognised: number[];
}

export interface NewListingsResponse {
  rows: NewListingRow[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
  summary: NewListingsSummary;
  series: NewListingsSeries;
  period: { days: NewListingPeriod; from: string; to: string };
  baseline_hours: number;
  /** First loads that fall inside the period (within the market / retailer filters). */
  baselines: NewListingBaseline[];
  /** The sources within the market / retailer filters and whether they can find unknown products. */
  sources: NewListingSource[];
}
