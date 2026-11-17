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
import { DEAL_SORTS, type DealBrandCount, type DealRetailerCount, type DealRow, type DealSort, type DealsResponse, type DealsSummary } from '../../../shared/api/deals.ts';
export type { DealRow, DealsResponse, DealsSummary };

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

/** Current deals within the listing scope of `filter` (its dimension filters; date and price filters do not apply). */
export function deals(ctx: AppContext, filter: ObsFilter, options: DealsOptions, page: Page, now: Date = new Date()): DealsResponse {
  const includeBadges = options.includeBadges === true;
  const { conditions, params } = listingConditions(filter);
  const sqlParams: SqlValue[] = [...params];
  conditions.push('li.listing_active = 1', 'li.retailer_active = 1', 'o.current_price IS NOT NULL', dealConditionSql('o', includeBadges));
  if (options.availability?.length) {
    conditions.push(`o.availability IN (${placeholders(options.availability.length)})`);
    sqlParams.push(...options.availability);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const fresh = `${ageHoursSql('s.last_observed_at')} <= ${STALE_HOURS_SQL}`;
  const base = ctx.db.all<BaseRow>(`SELECT ${BASE_SELECT} ${BASE_FROM} ${where}${options.includeStale ? '' : ` AND ${fresh}`} ORDER BY li.listing_id`, sqlParams);
  const staleDeals = ctx.db.scalar<number>(`SELECT COUNT(*) ${BASE_FROM} ${where} AND NOT (${fresh})`, sqlParams) ?? 0;

  // One day more than the long window, so the first market-local day is complete in every time zone.
  const since = new Date(now.getTime() - (LONG_WINDOW_DAYS + 1) * 86_400_000).toISOString();
  const history = loadHistory(ctx, base.map((row) => row.listing_id), since);
  let scope = base.map((row) => toDealRow(ctx, row, history.get(row.listing_id) ?? [], now, includeBadges));
  const minDiscount = options.minDiscount ?? 0;
  if (minDiscount > 0) scope = scope.filter((row) => row.discount_pct !== null && row.discount_pct >= minDiscount);
  if (options.lowestOnly) scope = scope.filter((row) => row.is_lowest_90d);
  const wanted = options.tags;
  const matching = wanted?.length ? scope.filter((row) => row.tags.some((tag) => wanted.includes(tag))) : scope;

  const sorted = sortDeals(matching, options.sort);
  return { ...paged(sorted.slice(page.offset, page.offset + page.pageSize), sorted.length, page), summary: summarise(matching, scope, staleDeals) };
}
