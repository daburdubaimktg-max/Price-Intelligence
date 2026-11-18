/**
 * Deals: the listings that are on offer right now, each with the price context of its own stored history
 * (30 / 90-day averages, 90-day low and high, how long the deal has been running).
 *
 * Method notes (shown to users where relevant)
 *   * Only a fresh latest observation says something about the present: stale listings are not deals. They
 *     are counted, and listed on request only, flagged as stale and after the fresh ones.
 *   * A deal carries an offer tag, is on promotion, or sells below its regular price. Badges (best seller,
 *     retailer's choice, selling fast, other tag) are shown with a deal but do not make one, unless asked for.
 *   * "Lowest price in N days" as a tag is the retailer's own statement. `is_lowest_90d` is what this
 *     system's stored history says; the two are kept apart.
 *   * History figures use the daily price of the listing: its last priced observation on a market-local
 *     calendar day, on the days it was actually observed. Nothing is interpolated.
 *   * Everything is in the listing's own currency. Summaries only count and average percentages; prices
 *     in different currencies are never added up, averaged or ranked against each other.
 */
import type { AppContext } from '../../context.ts';
import type { SqlValue } from '../../db/sqlite.ts';
import { placeholders } from '../../db/sqlite.ts';
import type { Page } from '../../lib/http.ts';
import { paged } from '../../lib/http.ts';
import { addDays, localDate } from '../../lib/time.ts';
import { listingConditions, obsSignalColumns, type ObsFilter } from '../obs-filter.ts';
import { ageHoursSql, basisLabel, demoNote, round, STALE_HOURS_SQL, unitPriceOf } from './common.ts';
import { DEAL_OFFER_TAGS, DEAL_TAGS, parseDealTags, type ContentDimension, type DealTag } from '../../../shared/constants.ts';
import {
  DEAL_DISCOUNT_BANDS, DEAL_SORTS,
  type DealBrandCount, type DealCompareBrand, type DealCompareCell, type DealCompareGroup, type DealRetailerCount, type DealRow, type DealShare,
  type DealSort, type DealsComparison, type DealsResponse, type DealsSummary, type DealTrendSeries,
} from '../../../shared/api/deals.ts';
import type { Ownership } from '../../../shared/constants.ts';
export type { DealRow, DealsComparison, DealsResponse, DealsSummary };

export interface DealsOptions {
  /** Deals carrying at least one of these tags. */
  tags?: DealTag[];
  /** Minimum discount against the regular price, in %. */
  minDiscount?: number;
  /** Only deals at their 90-day low. */
  lowestOnly?: boolean;
  /** Also list fresh listings that only carry a badge (best seller, retailer's choice, selling fast, other tag). */
  includeBadges?: boolean;
  /** Also list offers whose latest observation is stale (flagged, after the fresh ones). */
  includeStale?: boolean;
  availability?: string[];
  /** One of DEAL_SORTS, "-" prefix = descending. Default "-discount". */
  sort?: string;
}

/** Days of history behind the context figures. */
const SHORT_WINDOW_DAYS = 30;
const LONG_WINDOW_DAYS = 90;
/** Observed days needed before a price is called the 90-day low. */
const MIN_DAYS_FOR_LOWEST = 7;

const OFFER_TAG_LIST = DEAL_OFFER_TAGS.map((tag) => `'${tag}'`).join(', ');

/** SQL: the observation `alias` qualifies as a deal. Never NULL, so it can be negated. */
export function dealConditionSql(alias: string, includeBadges = false): string {
  const tagged = includeBadges
    ? `${alias}.tags <> '[]'`
    : `(${alias}.tags <> '[]' AND EXISTS (SELECT 1 FROM json_each(${alias}.tags) WHERE value IN (${OFFER_TAG_LIST})))`;
  return `(${alias}.is_promo = 1
    OR (${alias}.regular_price IS NOT NULL AND ${alias}.current_price IS NOT NULL AND ${alias}.current_price < ${alias}.regular_price)
    OR ${tagged})`;
}

interface ObservationFacts {
  is_promo: number;
  current_price: number | null;
  regular_price: number | null;
  tags: DealTag[];
}

/** The same rule as dealConditionSql, for observations already in memory. */
export function qualifiesAsDeal(obs: ObservationFacts, includeBadges = false): boolean {
  if (obs.is_promo) return true;
  if (obs.regular_price !== null && obs.current_price !== null && obs.current_price < obs.regular_price) return true;
  return includeBadges ? obs.tags.length > 0 : obs.tags.some((tag) => DEAL_OFFER_TAGS.includes(tag));
}

interface BaseRow extends Omit<DealRow, 'tags' | 'is_stale' | 'discount_pct' | 'unit_price' | 'unit_basis' | 'avg_30d' | 'avg_90d' | 'low_90d' | 'high_90d' | 'drop_vs_avg_30d_pct' | 'is_lowest_90d' | 'history_days' | 'deal_since'> {
  tags: unknown;
  content_amount: number | null;
  content_dimension: ContentDimension | null;
  unit_factor: number | null;
}

interface HistoryRow {
  listing_id: number;
  observed_at: string;
  date: string;
  current_price: number | null;
  regular_price: number | null;
  is_promo: number;
  tags: string;
}

const BASE_SELECT = `
  li.listing_id, li.listing_code, li.listing_title, COALESCE(o.product_url, li.listing_url) AS listing_url, li.external_id,
  li.product_id, li.product_code, li.product_name, li.image_url, li.sku, li.brand_id, li.brand_name, li.ownership,
  li.category_id, li.category_name, li.subcategory_id, li.subcategory_name, li.variant_name, li.pack_size, li.pack_unit, li.units_per_pack,
  li.content_amount, li.content_dimension, li.unit_factor,
  li.retailer_id, li.retailer_name, li.market_id, li.market_code, li.market_name, li.timezone, o.currency_code,
  o.id AS observation_id, o.observed_at, ${ageHoursSql('s.last_observed_at')} AS age_hours, ${STALE_HOURS_SQL} AS stale_after_hours,
  o.data_class, o.is_demo, o.current_price, o.regular_price, o.discount_pct AS promo_discount_pct,
  o.is_promo, o.promo_type, o.promo_description, o.promo_ends_on, o.availability,
  ${obsSignalColumns('o')},
  s.first_observed_at`;

const BASE_FROM = `
  FROM v_listing_info li
  JOIN listing_state s ON s.listing_id = li.listing_id
  JOIN price_observations o ON o.id = s.latest_obs_id`;

const mean = (values: number[]): number | null => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** History of the given listings since `since`, oldest first, grouped per listing. Voided observations are left out. */
function loadHistory(ctx: AppContext, listingIds: number[], since: string): Map<number, HistoryRow[]> {
  const out = new Map<number, HistoryRow[]>();
  for (let i = 0; i < listingIds.length; i += 400) {
    const chunk = listingIds.slice(i, i + 400);
    const rows = ctx.db.all<HistoryRow>(
      `SELECT o.listing_id, o.observed_at, o.observed_local_date AS date, o.current_price, o.regular_price, o.is_promo, o.tags
       FROM v_observations o
       WHERE o.listing_id IN (${placeholders(chunk.length)}) AND o.observed_at >= ?
       ORDER BY o.listing_id, o.observed_at, o.id`,
      [...chunk, since],
    );
    for (const row of rows) {
      const list = out.get(row.listing_id);
      if (list) list.push(row);
      else out.set(row.listing_id, [row]);
    }
  }
  return out;
}

/**
 * Start of the current uninterrupted run of deal observations. `history` holds the listing's recent
 * observations (oldest first, ending with the latest one); older history is only read when the run
 * reaches back beyond it.
 */
function dealSince(ctx: AppContext, base: BaseRow, history: HistoryRow[], includeBadges: boolean): string {
  let start = base.observed_at;
  let index = history.length - 1;
  for (; index >= 0; index--) {
    const row = history[index]!;
    if (!qualifiesAsDeal({ ...row, tags: parseDealTags(row.tags) }, includeBadges)) break;
    start = row.observed_at;
  }
  const reachedLoadedStart = index < 0;
  if (!reachedLoadedStart || !base.first_observed_at || start <= base.first_observed_at) return start;
  // The run is older than the loaded window: find the last observation before it that was not a deal.
  const lastPlain = ctx.db.scalar<string>(
    `SELECT MAX(o.observed_at) FROM v_observations o WHERE o.listing_id = ? AND o.observed_at < ? AND NOT ${dealConditionSql('o', includeBadges)}`,
    [base.listing_id, start],
  );
  if (!lastPlain) return base.first_observed_at;
  return ctx.db.scalar<string>('SELECT MIN(o.observed_at) FROM v_observations o WHERE o.listing_id = ? AND o.observed_at > ?', [base.listing_id, lastPlain]) ?? start;
}

function toDealRow(ctx: AppContext, base: BaseRow, history: HistoryRow[], now: Date, includeBadges: boolean): DealRow {
  const today = localDate(now, base.timezone);
  const from30 = addDays(today, -(SHORT_WINDOW_DAYS - 1));
  const from90 = addDays(today, -(LONG_WINDOW_DAYS - 1));
  // Daily price: the last priced observation of each market-local day (rows arrive oldest first).
  const daily = new Map<string, number>();
  for (const row of history) {
    if (row.current_price !== null && row.date >= from90 && row.date <= today) daily.set(row.date, row.current_price);
  }
  const days90 = [...daily.values()];
  const days30 = [...daily.entries()].filter(([date]) => date >= from30).map(([, price]) => price);
  const avg30 = mean(days30);
  const avg90 = mean(days90);
  const low90 = days90.length ? Math.min(...days90) : null;
  const high90 = days90.length ? Math.max(...days90) : null;
  const current = base.current_price;
  const unitPrice = unitPriceOf(current, base);
  const { content_amount: _amount, content_dimension: dimension, unit_factor: _factor, ...row } = base;
  return {
    ...row,
    age_hours: round(base.age_hours, 1) ?? 0,
    is_stale: base.age_hours > base.stale_after_hours,
    tags: parseDealTags(base.tags),
    discount_pct: base.regular_price !== null && base.regular_price > 0 && current < base.regular_price ? round(((base.regular_price - current) / base.regular_price) * 100, 2) : null,
    unit_price: round(unitPrice, 4),
    unit_basis: unitPrice === null ? null : basisLabel(dimension),
    avg_30d: round(avg30, 4),
    avg_90d: round(avg90, 4),
    low_90d: low90,
    high_90d: high90,
    drop_vs_avg_30d_pct: days30.length >= 2 && avg30 !== null && avg30 > 0 ? round(((avg30 - current) / avg30) * 100, 2) : null,
    is_lowest_90d: days90.length >= MIN_DAYS_FOR_LOWEST && low90 !== null && high90 !== null && high90 > low90 && current <= low90 + 1e-9,
    history_days: days90.length,
    deal_since: dealSince(ctx, base, history, includeBadges),
  };
}

type SortValue = (row: DealRow) => number | string | null;
const SORT_VALUES: Record<DealSort, SortValue> = {
  discount: (r) => r.discount_pct,
  drop: (r) => r.drop_vs_avg_30d_pct,
  price: (r) => r.current_price,
  observed: (r) => r.observed_at,
  rating: (r) => r.rating,
  rank: (r) => r.sales_rank,
};

/** Reads a sort parameter ("-discount", "price", …); anything unknown falls back to the default. */
export function parseDealSort(sort: string | undefined): { key: DealSort; descending: boolean } {
  const descending = !!sort && sort.startsWith('-');
  const key = (descending ? sort!.slice(1) : sort) as DealSort | undefined;
  return key && DEAL_SORTS.includes(key) ? { key, descending } : { key: 'discount', descending: true };
}

function sortDeals(rows: DealRow[], sort: string | undefined): DealRow[] {
  const { key, descending } = parseDealSort(sort);
  const value = SORT_VALUES[key];
  const direction = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    // Stale offers (listed on request only) never rank above an offer that is known to apply now.
    if (a.is_stale !== b.is_stale) return a.is_stale ? 1 : -1;
    // Prices in different currencies cannot be ranked against each other: a price sort keeps currencies apart.
    if (key === 'price' && a.currency_code !== b.currency_code) return a.currency_code < b.currency_code ? -1 : 1;
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1; // rows without the figure always come last
    } else if (va !== vb) {
      return (va < vb ? -1 : 1) * direction;
    }
    if (key === 'rating' && (a.review_count ?? -1) !== (b.review_count ?? -1)) return (b.review_count ?? -1) - (a.review_count ?? -1);
    return a.listing_id - b.listing_id;
  });
}

function discountStats(rows: DealRow[]): { avg_discount_pct: number | null; max_discount_pct: number | null } {
  const discounts = rows.map((r) => r.discount_pct).filter((d): d is number => d !== null);
  return { avg_discount_pct: round(mean(discounts), 1), max_discount_pct: discounts.length ? Math.max(...discounts) : null };
}

function summarise(rows: DealRow[], tagScope: DealRow[], staleDeals: number): DealsSummary {
  const byTag = Object.fromEntries(DEAL_TAGS.map((tag) => [tag, 0])) as Record<DealTag, number>;
  for (const row of tagScope) for (const tag of row.tags) byTag[tag] += 1;

  const brands = new Map<number | null, DealRow[]>();
  const retailers = new Map<number, DealRow[]>();
  for (const row of rows) {
    const brand = brands.get(row.brand_id);
    if (brand) brand.push(row);
    else brands.set(row.brand_id, [row]);
    const retailer = retailers.get(row.retailer_id);
    if (retailer) retailer.push(row);
    else retailers.set(row.retailer_id, [row]);
  }
  const byBrand: DealBrandCount[] = [...brands.entries()]
    .map(([brandId, list]) => ({ brand_id: brandId, brand_name: list[0]!.brand_name ?? 'Unmatched listings', ownership: list[0]!.ownership, deals: list.length, ...discountStats(list) }))
    .sort((a, b) => b.deals - a.deals || a.brand_name.localeCompare(b.brand_name))
    .slice(0, 12);
  const byRetailer: DealRetailerCount[] = [...retailers.entries()]
    .map(([retailerId, list]) => ({
      retailer_id: retailerId,
      retailer_name: list[0]!.retailer_name,
      market_code: list[0]!.market_code,
      market_name: list[0]!.market_name,
      currency_code: list[0]!.currency_code,
      deals: list.length,
      ...discountStats(list),
    }))
    .sort((a, b) => b.deals - a.deals || a.retailer_name.localeCompare(b.retailer_name) || a.retailer_id - b.retailer_id);

  let deepest: DealRow | null = null;
  let latest: string | null = null;
  for (const row of rows) {
    if (row.discount_pct !== null && (deepest === null || row.discount_pct > deepest.discount_pct! || (row.discount_pct === deepest.discount_pct && row.listing_id < deepest.listing_id))) deepest = row;
    if (latest === null || row.observed_at > latest) latest = row.observed_at;
  }
  return {
    total: rows.length,
    own: rows.filter((r) => r.ownership === 'own').length,
    competitor: rows.filter((r) => r.ownership === 'competitor').length,
    lowest_90d: rows.filter((r) => r.is_lowest_90d).length,
    stale_deals: staleDeals,
    by_tag: byTag,
    by_brand: byBrand,
    by_retailer: byRetailer,
    deepest: deepest && {
      listing_id: deepest.listing_id,
      product_id: deepest.product_id,
      product_name: deepest.product_name,
      brand_name: deepest.brand_name,
      retailer_name: deepest.retailer_name,
      market_code: deepest.market_code,
      currency_code: deepest.currency_code,
      current_price: deepest.current_price,
      regular_price: deepest.regular_price,
      discount_pct: deepest.discount_pct,
    },
    currencies: [...new Set(rows.map((r) => r.currency_code))].sort(),
    latest_observation_at: latest,
    demo: demoNote(rows),
  };
}

interface LoadedDeals {
  /** Deals of the listing scope after the discount and 90-day-low filters (the scope tag counts are taken from). */
  scope: DealRow[];
  /** Deals matching every filter, tags included. */
  matching: DealRow[];
  staleDeals: number;
  includeBadges: boolean;
  /** Conditions of the range the deals belong to (listing scope, active, priced, availability) — without the deal rule. */
  rangeWhere: string;
  rangeParams: SqlValue[];
  /** SQL: the latest observation is fresh by its source's schedule. */
  fresh: string;
}

function loadDeals(ctx: AppContext, filter: ObsFilter, options: DealsOptions, now: Date): LoadedDeals {
  const includeBadges = options.includeBadges === true;
  const { conditions, params } = listingConditions(filter);
  const rangeParams: SqlValue[] = [...params];
  conditions.push('li.listing_active = 1', 'li.retailer_active = 1', 'o.current_price IS NOT NULL');
  if (options.availability?.length) {
    conditions.push(`o.availability IN (${placeholders(options.availability.length)})`);
    rangeParams.push(...options.availability);
  }
  const rangeWhere = `WHERE ${conditions.join(' AND ')}`;
  const where = `${rangeWhere} AND ${dealConditionSql('o', includeBadges)}`;
  const fresh = `${ageHoursSql('s.last_observed_at')} <= ${STALE_HOURS_SQL}`;
  const base = ctx.db.all<BaseRow>(`SELECT ${BASE_SELECT} ${BASE_FROM} ${where}${options.includeStale ? '' : ` AND ${fresh}`} ORDER BY li.listing_id`, rangeParams);
  const staleDeals = ctx.db.scalar<number>(`SELECT COUNT(*) ${BASE_FROM} ${where} AND NOT (${fresh})`, rangeParams) ?? 0;

  // One day more than the long window, so the first market-local day is complete in every time zone.
  const since = new Date(now.getTime() - (LONG_WINDOW_DAYS + 1) * 86_400_000).toISOString();
  const history = loadHistory(ctx, base.map((row) => row.listing_id), since);
  let scope = base.map((row) => toDealRow(ctx, row, history.get(row.listing_id) ?? [], now, includeBadges));
  const minDiscount = options.minDiscount ?? 0;
  if (minDiscount > 0) scope = scope.filter((row) => row.discount_pct !== null && row.discount_pct >= minDiscount);
  if (options.lowestOnly) scope = scope.filter((row) => row.is_lowest_90d);
  const wanted = options.tags;
  const matching = wanted?.length ? scope.filter((row) => row.tags.some((tag) => wanted.includes(tag))) : scope;
  return { scope, matching, staleDeals, includeBadges, rangeWhere, rangeParams, fresh };
}

/** Current deals within the listing scope of `filter` (its dimension filters; date and price filters do not apply). */
export function deals(ctx: AppContext, filter: ObsFilter, options: DealsOptions, page: Page, now: Date = new Date()): DealsResponse {
  const { scope, matching, staleDeals } = loadDeals(ctx, filter, options, now);
  const sorted = sortDeals(matching, options.sort);
  return { ...paged(sorted.slice(page.offset, page.offset + page.pageSize), sorted.length, page), summary: summarise(matching, scope, staleDeals) };
}

// ---- comparison ----------------------------------------------------------------------------------------------

/** Brands listed in a comparison (largest ranges first). */
const COMPARE_BRAND_LIMIT = 40;
/** Days of the comparison's trend. */
const TREND_DAYS = 30;

/** Listings of a range and the deals among them. */
class Tally {
  listings = 0;
  deals = 0;
  discounts: number[] = [];

  addListings(count: number): void {
    this.listings += count;
  }
  addDeal(row: DealRow): void {
    this.deals += 1;
    if (row.discount_pct !== null) this.discounts.push(row.discount_pct);
  }
  share(): DealShare {
    return {
      listings: this.listings,
      deals: this.deals,
      share_pct: this.listings > 0 ? round((this.deals / this.listings) * 100, 1) : null,
      avg_discount_pct: round(mean(this.discounts), 1),
      max_discount_pct: this.discounts.length ? Math.max(...this.discounts) : null,
    };
  }
  median(): number | null {
    if (!this.discounts.length) return null;
    const sorted = [...this.discounts].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2, 1);
  }
}

/** A range, retailer or market with its own-brand and competitor halves. */
class GroupTally {
  readonly id: number;
  readonly name: string;
  readonly note: string | null;
  readonly all = new Tally();
  readonly own = new Tally();
  readonly competitor = new Tally();
  constructor(id: number, name: string, note: string | null) {
    this.id = id;
    this.name = name;
    this.note = note;
  }
  private halves(ownership: Ownership | null): Tally[] {
    return ownership === 'own' ? [this.all, this.own] : ownership === 'competitor' ? [this.all, this.competitor] : [this.all];
  }
  addListings(ownership: Ownership | null, count: number): void {
    for (const tally of this.halves(ownership)) tally.addListings(count);
  }
  addDeal(row: DealRow): void {
    for (const tally of this.halves(row.ownership)) tally.addDeal(row);
  }
  result(): DealCompareGroup {
    return { id: this.id, name: this.name, note: this.note, all: this.all.share(), own: this.own.share(), competitor: this.competitor.share() };
  }
}

interface RangeRow {
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
  listings: number;
}

/** Index of the DEAL_DISCOUNT_BANDS entry a deal belongs to. */
export function discountBandIndex(discountPct: number | null): number {
  if (discountPct === null) return 0;
  for (let i = DEAL_DISCOUNT_BANDS.length - 1; i >= 1; i--) {
    if (discountPct >= DEAL_DISCOUNT_BANDS[i]!.min!) return i;
  }
  return 1;
}

const brandKey = (brandId: number | null): string => (brandId === null ? 'none' : String(brandId));

/**
 * The deals of `filter`'s listing scope as a comparison (see DealsComparison). The deals are exactly those of
 * `deals()` for the same request; the ranges they are measured against are the fresh, priced, active listings
 * of the same scope.
 */
export function dealsComparison(ctx: AppContext, filter: ObsFilter, options: DealsOptions, now: Date = new Date()): DealsComparison {
  const { matching, includeBadges, rangeWhere, rangeParams, fresh } = loadDeals(ctx, filter, options, now);

  // ---- the ranges: every fresh, priced, active listing of the scope, on offer or not ------------------------
  const ranges = ctx.db.all<RangeRow>(
    `SELECT li.brand_id, li.brand_name, li.ownership, li.category_id, li.category_name, li.subcategory_id, li.subcategory_name,
            li.retailer_id, li.retailer_name, li.market_id, li.market_code, li.market_name, COUNT(*) AS listings
     ${BASE_FROM} ${rangeWhere}${options.includeStale ? '' : ` AND ${fresh}`}
     GROUP BY li.brand_id, li.category_id, li.subcategory_id, li.retailer_id`,
    rangeParams,
  );

  const totals = new GroupTally(0, 'All', null);
  const brands = new Map<string, { id: number | null; name: string; ownership: Ownership | null; tally: Tally; bands: number[]; tags: Record<DealTag, number> }>();
  const rangeGroups = new Map<number, GroupTally>();
  const retailerGroups = new Map<number, GroupTally>();
  const marketGroups = new Map<number, GroupTally>();
  const cells = new Map<string, { brand_id: number | null; retailer_id: number; tally: Tally }>();

  const brandOf = (id: number | null, name: string | null, ownership: Ownership | null) => {
    const key = brandKey(id);
    let entry = brands.get(key);
    if (!entry) {
      entry = {
        id,
        name: name ?? 'Unmatched listings',
        ownership,
        tally: new Tally(),
        bands: DEAL_DISCOUNT_BANDS.map(() => 0),
        tags: Object.fromEntries(DEAL_TAGS.map((tag) => [tag, 0])) as Record<DealTag, number>,
      };
      brands.set(key, entry);
    }
    return entry;
  };
  const groupOf = (map: Map<number, GroupTally>, id: number | null, name: string | null, note: string | null): GroupTally | null => {
    if (id === null) return null;
    let group = map.get(id);
    if (!group) {
      group = new GroupTally(id, name ?? '—', note);
      map.set(id, group);
    }
    return group;
  };
  const cellOf = (brandId: number | null, retailerId: number) => {
    const key = `${brandKey(brandId)}|${retailerId}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { brand_id: brandId, retailer_id: retailerId, tally: new Tally() };
      cells.set(key, cell);
    }
    return cell;
  };
  /** A product's range is its subcategory, or its category when it has none. */
  const rangeOf = (row: Pick<RangeRow, 'category_id' | 'category_name' | 'subcategory_id' | 'subcategory_name'>) =>
    row.subcategory_id !== null
      ? groupOf(rangeGroups, row.subcategory_id, row.subcategory_name, row.category_name)
      : groupOf(rangeGroups, row.category_id, row.category_name, null);

  for (const row of ranges) {
    totals.addListings(row.ownership, row.listings);
    brandOf(row.brand_id, row.brand_name, row.ownership).tally.addListings(row.listings);
    rangeOf(row)?.addListings(row.ownership, row.listings);
    groupOf(retailerGroups, row.retailer_id, row.retailer_name, row.market_code)?.addListings(row.ownership, row.listings);
    groupOf(marketGroups, row.market_id, row.market_name, null)?.addListings(row.ownership, row.listings);
    cellOf(row.brand_id, row.retailer_id).tally.addListings(row.listings);
  }

  let latest: string | null = null;
  for (const deal of matching) {
    totals.addDeal(deal);
    const brand = brandOf(deal.brand_id, deal.brand_name, deal.ownership);
    brand.tally.addDeal(deal);
    brand.bands[discountBandIndex(deal.discount_pct)]! += 1;
    for (const tag of deal.tags) brand.tags[tag] += 1;
    rangeOf(deal)?.addDeal(deal);
    groupOf(retailerGroups, deal.retailer_id, deal.retailer_name, deal.market_code)?.addDeal(deal);
    groupOf(marketGroups, deal.market_id, deal.market_name, null)?.addDeal(deal);
    cellOf(deal.brand_id, deal.retailer_id).tally.addDeal(deal);
    if (latest === null || deal.observed_at > latest) latest = deal.observed_at;
  }

  const allBrands = [...brands.values()].sort((a, b) => b.tally.listings - a.tally.listings || a.name.localeCompare(b.name));
  const listed = allBrands.slice(0, COMPARE_BRAND_LIMIT);
  const listedKeys = new Set(listed.map((b) => brandKey(b.id)));
  const brandRows: DealCompareBrand[] = listed.map((b) => ({
    brand_id: b.id,
    brand_name: b.name,
    ownership: b.ownership,
    ...b.tally.share(),
    median_discount_pct: b.tally.median(),
    bands: b.bands,
    tags: b.tags,
  }));
  const bySize = (a: GroupTally, b: GroupTally) => b.all.listings - a.all.listings || a.name.localeCompare(b.name) || a.id - b.id;
  const cellRows: DealCompareCell[] = [...cells.values()]
    .filter((cell) => listedKeys.has(brandKey(cell.brand_id)) && cell.tally.listings > 0)
    .map((cell) => ({ brand_id: cell.brand_id, retailer_id: cell.retailer_id, ...cell.tally.share() }));

  return {
    totals: { all: totals.all.share(), own: totals.own.share(), competitor: totals.competitor.share() },
    brands: brandRows,
    brands_omitted: allBrands.length - listed.length,
    ranges: [...rangeGroups.values()].sort(bySize).map((g) => g.result()),
    retailers: [...retailerGroups.values()].sort(bySize).map((g) => g.result()),
    markets: [...marketGroups.values()].sort(bySize).map((g) => g.result()),
    cells: cellRows,
    trend: dealTrend(ctx, filter, options, includeBadges, listed.map((b) => ({ id: b.id, name: b.name, ownership: b.ownership })), now),
    latest_observation_at: latest,
    demo: demoNote(matching),
  };
}

interface TrendRow {
  brand_id: number | null;
  date: string;
  listings: number;
  deals: number;
  avg_discount: number | null;
}

/**
 * Per market-local day of the last 30 days and per brand: the listings observed with a price that day, and how
 * many of them were on offer by their last observation of the day. Days without observations have no point.
 */
function dealTrend(
  ctx: AppContext,
  filter: ObsFilter,
  options: DealsOptions,
  includeBadges: boolean,
  brands: Array<{ id: number | null; name: string; ownership: Ownership | null }>,
  now: Date,
): DealsComparison['trend'] {
  const { conditions, params } = listingConditions(filter);
  const dailyParams: SqlValue[] = [...params];
  conditions.push('li.listing_active = 1', 'li.retailer_active = 1', 'o.current_price IS NOT NULL');
  if (options.availability?.length) {
    conditions.push(`o.availability IN (${placeholders(options.availability.length)})`);
    dailyParams.push(...options.availability);
  }
  // One day more than the window, so its first market-local day is complete in every time zone.
  const since = new Date(now.getTime() - (TREND_DAYS + 1) * 86_400_000).toISOString();
  conditions.push('o.observed_at >= ?');
  dailyParams.push(since);

  const dealParts = [dealConditionSql('d', includeBadges)];
  const dealParams: SqlValue[] = [];
  if (options.tags?.length) {
    dealParts.push(`EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value IN (${placeholders(options.tags.length)}))`);
    dealParams.push(...options.tags);
  }
  if ((options.minDiscount ?? 0) > 0) {
    dealParts.push('(d.regular_price IS NOT NULL AND d.regular_price > 0 AND d.current_price < d.regular_price AND (d.regular_price - d.current_price) * 100.0 / d.regular_price >= ?)');
    dealParams.push(options.minDiscount!);
  }

  const rows = ctx.db.all<TrendRow>(
    `WITH daily AS (
       SELECT o.listing_id, o.observed_local_date AS date, o.is_promo, o.current_price, o.regular_price, o.tags,
              ROW_NUMBER() OVER (PARTITION BY o.listing_id, o.observed_local_date ORDER BY o.observed_at DESC, o.id DESC) AS rn
       FROM v_observations o
       JOIN v_listing_info li ON li.listing_id = o.listing_id
       WHERE ${conditions.join(' AND ')}
     ), flagged AS (
       SELECT d.listing_id, d.date, d.current_price, d.regular_price,
              CASE WHEN ${dealParts.join(' AND ')} THEN 1 ELSE 0 END AS is_deal
       FROM daily d
       WHERE d.rn = 1
     )
     SELECT li.brand_id, f.date, COUNT(*) AS listings, SUM(f.is_deal) AS deals,
            AVG(CASE WHEN f.is_deal = 1 AND f.regular_price IS NOT NULL AND f.regular_price > 0 AND f.current_price < f.regular_price
                     THEN (f.regular_price - f.current_price) * 100.0 / f.regular_price END) AS avg_discount
     FROM flagged f
     JOIN v_listing_info li ON li.listing_id = f.listing_id
     GROUP BY li.brand_id, f.date
     ORDER BY f.date`,
    [...dailyParams, ...dealParams],
  );

  const today = rows.length ? rows[rows.length - 1]!.date : localDate(now, 'UTC');
  const from = addDays(today, -(TREND_DAYS - 1));
  const byBrand = new Map<string, DealTrendSeries>(brands.map((b) => [brandKey(b.id), { brand_id: b.id, brand_name: b.name, ownership: b.ownership, points: [] }]));
  const days = new Set<string>();
  for (const row of rows) {
    if (row.date < from) continue;
    days.add(row.date);
    byBrand.get(brandKey(row.brand_id))?.points.push({
      date: row.date,
      listings: row.listings,
      deals: row.deals,
      share_pct: row.listings > 0 ? round((row.deals / row.listings) * 100, 1) : null,
      avg_discount_pct: round(row.avg_discount, 1),
    });
  }
  return {
    from,
    to: today,
    observed_days: days.size,
    series: [...byBrand.values()].filter((s) => s.points.length > 0),
    not_applied: options.lowestOnly ? ['90-day low only'] : [],
  };
}
