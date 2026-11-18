/**
 * Brand Explorer: every brand with listed products (GET /brand-explorer) and one brand in depth
 * (GET /brand-explorer/:id — product range, price matrix of one market, trend, competing brands).
 *
 * Method notes (shown to users where relevant)
 *   * A listing is FRESH when its latest observation is younger than its source's schedule allows (the same rule as
 *     the Live Price Monitor). "Current" figures — price ranges, promotion share, cheapest retailer — use fresh
 *     listings only; stale and never-observed listings are counted separately.
 *   * Prices in different currencies are never blended: figures are kept per currency unless a comparison currency
 *     is requested, in which case every price is converted and the rates used are returned.
 *   * Pack variants (twin packs, bonus packs) differ in shelf price by construction: they are left out of a
 *     product's shelf-price figures and of the cheapest-retailer comparison.
 *   * Indexed trend: each listing's daily price (last priced observation of the market-local day) is divided by its
 *     first price in the period (= 100) and held for up to CARRY_DAYS days between observations; the line is the
 *     average over the listings of the group. It is unit-free, so it may combine currencies and pack sizes.
 *   * The price index (own ÷ competitor × 100) comes from the competitor engine: approved mappings, same retailer,
 *     current prices no older than 30 days.
 *   * Deal tags ("Limited-time deal", "Best seller" …) are those of a listing's latest observation and are reported
 *     for fresh listings only. They are read from the Live Price Monitor's rows — this module never selects the
 *     signal columns itself, so a database or build without them simply reports no tags.
 */
import type { AppContext } from '../../context.ts';
import type { SqlValue } from '../../db/sqlite.ts';
import { placeholders } from '../../db/sqlite.ts';
import { notFound } from '../../lib/errors.ts';
import { likePattern } from '../../lib/http.ts';
import { makeConverter, type Converter } from '../fx.ts';
import { listingConditions, type ObsFilter } from '../obs-filter.ts';
import { packContent, unitPrice } from '../../../shared/units.ts';
import type { ContentDimension } from '../../../shared/constants.ts';
import {
  ageHoursSql, basisLabel, demoNote, lastDays, loadListings, marketToday, mean, packLabel, round, STALE_HOURS_SQL, unitPriceOf,
  type DateRange, type ListingInfo,
} from './common.ts';
import { latestPairs, type PairRow } from './competitors.ts';
import { dailySeries, timeline } from './history.ts';
import { monitorRowsFor } from './monitor.ts';
import type { Conversion } from '../../../shared/api/analytics.ts';
import type {
  BrandCategoryCount, BrandCheapest, BrandCompetitorRow, BrandDetailResult, BrandExplorerResult, BrandExplorerRow, BrandExplorerSummary,
  BrandIndexSeries, BrandMarketOption, BrandMatrix, BrandMatrixCell, BrandMatrixListing, BrandMatrixRow, BrandMoves, BrandPriceIndex,
  BrandPriceRange, BrandRangePrice, BrandRangeRow, BrandTrendPoint,
} from '../../../shared/api/brands.ts';
export type { BrandDetailResult, BrandExplorerResult, BrandExplorerRow };

/** Days a listing's last observed price is held in the indexed trend when no newer observation exists. */
export const CARRY_DAYS = 7;
/** Period of the sparkline and of the "30-day change". */
export const TREND_DAYS = 30;
/** Series drawn in the brand-vs-benchmarks index chart (the palette has eight hues). */
const MAX_INDEX_SERIES = 8;

export interface BrandScope {
  market_ids?: number[];
  retailer_ids?: number[];
  category_ids?: number[];
  ownership?: 'own' | 'competitor';
  /** Brand name or manufacturer contains this text. */
  q?: string;
  brand_ids?: number[];
}

export const BRAND_SORTS = ['name', 'products', 'listings', 'retailers', 'markets', 'promo_share', 'moves', 'trend', 'index', 'last_observation'] as const;
export type BrandSort = (typeof BRAND_SORTS)[number];

/** One active listing with its latest observation. */
interface ListingNow {
  listing_id: number;
  product_id: number;
  product_name: string;
  variant_id: number | null;
  variant_name: string | null;
  brand_id: number;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  timezone: string;
  currency_code: string;
  category_id: number | null;
  category_name: string | null;
  subcategory_id: number | null;
  subcategory_name: string | null;
  content_amount: number | null;
  content_dimension: ContentDimension | null;
  unit_factor: number | null;
  is_demo: number;
  current_price: number | null;
  regular_price: number | null;
  is_promo: number;
  discount_pct: number | null;
  promo_type: string | null;
  availability: string | null;
  observed_at: string | null;
  last_observed_at: string | null;
  never_observed: number;
  is_stale: number;
}

const isFresh = (l: ListingNow) => !l.never_observed && !l.is_stale;
/** Fresh and priced: eligible for "current" price figures. */
const hasCurrentPrice = (l: ListingNow): l is ListingNow & { current_price: number } => isFresh(l) && l.current_price !== null;

const toFilter = (scope: BrandScope): ObsFilter => ({
  market_ids: scope.market_ids,
  retailer_ids: scope.retailer_ids,
  category_ids: scope.category_ids,
  ownership: scope.ownership,
  brand_ids: scope.brand_ids,
});

/** Active listings of matched products in scope, each with its latest observation and freshness. */
function currentListings(ctx: AppContext, scope: BrandScope): ListingNow[] {
  const { conditions, params } = listingConditions(toFilter(scope));
  conditions.push('li.listing_active = 1', 'li.retailer_active = 1', 'li.brand_id IS NOT NULL');
  if (scope.q) {
    const p = likePattern(scope.q);
    conditions.push(`(li.brand_name LIKE ? ESCAPE '\\' OR b.manufacturer LIKE ? ESCAPE '\\')`);
    params.push(p, p);
  }
  const age = ageHoursSql('s.last_observed_at');
  return ctx.db.all<ListingNow>(
    `SELECT li.listing_id, li.product_id, li.product_name, li.variant_id, li.variant_name, li.brand_id,
       li.retailer_id, li.retailer_name, li.market_id, li.market_code, li.market_name, li.timezone, li.currency_code,
       li.category_id, li.category_name, li.subcategory_id, li.subcategory_name,
       li.content_amount, li.content_dimension, li.unit_factor, li.listing_is_demo AS is_demo,
       o.current_price, o.regular_price, COALESCE(o.is_promo, 0) AS is_promo, o.discount_pct, o.promo_type, o.availability, o.observed_at,
       s.last_observed_at,
       (CASE WHEN s.last_observed_at IS NULL THEN 1 ELSE 0 END) AS never_observed,
       (CASE WHEN s.last_observed_at IS NOT NULL AND ${age} > ${STALE_HOURS_SQL} THEN 1 ELSE 0 END) AS is_stale
     FROM v_listing_info li
     JOIN brands b ON b.id = li.brand_id
     LEFT JOIN listing_state s ON s.listing_id = li.listing_id
     LEFT JOIN price_observations o ON o.id = s.latest_obs_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY li.brand_id, li.product_name, li.retailer_name, li.listing_id`,
    params,
  );
}

interface ListingTags {
  tags: string[];
  /** The retailer's own wording, e.g. "Early Yellow Friday Deal". */
  text: string | null;
}

/** Deal tags of each listing's latest observation, taken from the monitor rows (see the method notes). */
function currentTags(ctx: AppContext, scope: BrandScope): Map<number, ListingTags> {
  const out = new Map<number, ListingTags>();
  // The monitor row is read loosely on purpose: its signal fields exist only where the ledger stores them.
  const rows = monitorRowsFor(ctx, toFilter({ ...scope, q: undefined })) as unknown as Array<{ listing_id: number; tags?: unknown; tag_text?: unknown }>;
  for (const row of rows) {
    if (!Array.isArray(row.tags)) continue;
    const tags = row.tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '');
    if (tags.length) out.set(row.listing_id, { tags, text: typeof row.tag_text === 'string' && row.tag_text ? row.tag_text : null });
  }
  return out;
}

/** Fresh listings per tag (most frequent first) — stale and never-observed listings say nothing about now. */
function tagCounts(listings: ListingNow[], tags: Map<number, ListingTags>): { tags: string[]; tag_counts: Record<string, number>; tagged_listings: number } | null {
  const counts = new Map<string, number>();
  let tagged = 0;
  for (const l of listings) {
    const own = isFresh(l) ? tags.get(l.listing_id) : undefined;
    if (!own) continue;
    tagged += 1;
    for (const tag of own.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  if (tagged === 0) return null;
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { tags: ordered.map(([tag]) => tag), tag_counts: Object.fromEntries(ordered), tagged_listings: tagged };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
const DAY_MS = 86_400_000;
const dayNumber = (isoDate: string): number => Math.round(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);
const dayIso = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const latest = (values: Array<string | null>): string | null => values.reduce<string | null>((best, v) => (v && (!best || v > best) ? v : best), null);

function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/** A price in the display currency: unchanged without a converter, else converted (null when no rate exists). */
function displayPrice(price: number, currency: string, converter: Converter | null): { value: number; currency: string } | null {
  if (!converter) return { value: price, currency };
  const value = converter.convert(price, currency);
  return value === null ? null : { value: round(value, 4)!, currency: converter.to };
}

/** min / median / max of the fresh, priced listings — one entry per currency, never blended. */
function priceRanges(listings: ListingNow[], converter: Converter | null): BrandPriceRange[] {
  const byCurrency = new Map<string, number[]>();
  for (const l of listings) {
    if (!hasCurrentPrice(l)) continue;
    const shown = displayPrice(l.current_price, l.currency_code, converter);
    if (!shown) continue;
    const values = byCurrency.get(shown.currency);
    if (values) values.push(shown.value);
    else byCurrency.set(shown.currency, [shown.value]);
  }
  return [...byCurrency.entries()]
    .map(([currency, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { currency, listings: sorted.length, min: sorted[0]!, median: round(median(sorted), 4)!, max: sorted[sorted.length - 1]! };
    })
    .sort((a, b) => b.listings - a.listings || a.currency.localeCompare(b.currency));
}

/** The leaf category of a listing (its subcategory when it has one). */
const leafCategory = (l: { category_id: number | null; category_name: string | null; subcategory_id: number | null; subcategory_name: string | null }) => ({
  id: l.subcategory_id ?? l.category_id,
  name: l.subcategory_name ?? l.category_name ?? 'Uncategorised',
  parent_name: l.subcategory_id !== null ? l.category_name : null,
});

function categoryCounts(listings: ListingNow[]): BrandCategoryCount[] {
  const groups = new Map<string, BrandCategoryCount & { ids: Set<number> }>();
  for (const l of listings) {
    const leaf = leafCategory(l);
    const key = String(leaf.id ?? 0);
    let g = groups.get(key);
    if (!g) {
      g = { ...leaf, products: 0, ids: new Set() };
      groups.set(key, g);
    }
    g.ids.add(l.product_id);
  }
  return [...groups.values()]
    .map(({ ids, ...g }) => ({ ...g, products: ids.size }))
    .sort((a, b) => b.products - a.products || a.name.localeCompare(b.name));
}

function priceIndexOf(pairs: PairRow[], perspective: BrandPriceIndex['perspective']): BrandPriceIndex | null {
  if (!pairs.length) return null;
  const usable = pairs.filter((p) => p.index !== null);
  const idx = mean(usable.map((p) => p.index!));
  return {
    index: round(idx, 1),
    premium_pct: idx === null ? null : round(idx - 100, 1),
    pairs: usable.length,
    cheaper_pairs: usable.filter((p) => p.index! < 99.5).length,
    dearer_pairs: usable.filter((p) => p.index! > 100.5).length,
    not_comparable_pairs: pairs.length - usable.length,
    perspective,
  };
}

// ---------------------------------------------------------------------------------------------
// Indexed price trend
// ---------------------------------------------------------------------------------------------
/**
 * Unit-free price index per group over a period. Each listing is indexed to its own first priced observation of
 * the period (= 100); a value is held for up to CARRY_DAYS days until the listing's next observation; a group's
 * line is the plain average of its listings on each day and ends on the last day the group was actually observed.
 */
export function indexedTrends(ctx: AppContext, filter: ObsFilter, period: DateRange, keysOf: (info: ListingInfo) => string[]): Map<string, BrandTrendPoint[]> {
  const daily = dailySeries(ctx, { ...filter, date_from: period.from, date_to: period.to });
  const infos = loadListings(ctx, daily.map((d) => d.listing_id));
  const endDay = dayNumber(period.to);
  const groups = new Map<string, { days: Map<number, { sum: number; n: number }>; lastObserved: number }>();

  let i = 0;
  while (i < daily.length) {
    const listingId = daily[i]!.listing_id;
    const observed: Array<{ day: number; index: number }> = [];
    let base: number | null = null;
    for (; i < daily.length && daily[i]!.listing_id === listingId; i++) {
      const price = daily[i]!.current_price;
      if (price === null || !(price > 0)) continue;
      if (base === null) base = price;
      observed.push({ day: dayNumber(daily[i]!.date), index: (price / base) * 100 });
    }
    const info = infos.get(listingId);
    if (!info || observed.length === 0) continue;
    for (const key of keysOf(info)) {
      let group = groups.get(key);
      if (!group) {
        group = { days: new Map(), lastObserved: -Infinity };
        groups.set(key, group);
      }
      for (let k = 0; k < observed.length; k++) {
        const o = observed[k]!;
        const next = observed[k + 1];
        // held until the day before the next observation, at most CARRY_DAYS days, never beyond the period
        const until = Math.min(next ? next.day - 1 : endDay, o.day + CARRY_DAYS);
        for (let day = o.day; day <= until; day++) {
          const cell = group.days.get(day);
          if (cell) {
            cell.sum += o.index;
            cell.n += 1;
          } else group.days.set(day, { sum: o.index, n: 1 });
        }
      }
      group.lastObserved = Math.max(group.lastObserved, observed[observed.length - 1]!.day);
    }
  }

  const out = new Map<string, BrandTrendPoint[]>();
  for (const [key, group] of groups) {
    out.set(
      key,
      [...group.days.entries()]
        .filter(([day]) => day <= group.lastObserved)
        .sort((a, b) => a[0] - b[0])
        .map(([day, cell]) => ({ date: dayIso(day), index: round(cell.sum / cell.n, 2)!, listings: cell.n })),
    );
  }
  return out;
}

/** Last index − 100. Needs at least two days: one day of observations says nothing about change. */
function trendChange(points: BrandTrendPoint[]): number | null {
  return points.length >= 2 ? round(points[points.length - 1]!.index - 100, 2) : null;
}

// ---------------------------------------------------------------------------------------------
// Brand rows
// ---------------------------------------------------------------------------------------------
interface RowContext {
  today: string;
  trendPeriod: DateRange;
  converter: Converter | null;
  /** Current mapped pairs in the same market / retailer / category scope. */
  pairs: PairRow[];
}

function movesByBrand(ctx: AppContext, scope: BrandScope, today: string): Map<number, { d7: BrandMoves; d30: BrandMoves }> {
  const from30 = lastDays(today, 30).from;
  const from7 = lastDays(today, 7).from;
  const { conditions, params } = listingConditions(toFilter(scope));
  conditions.push(`e.kind = 'price_change'`, 'e.occurred_local_date >= ?', 'e.occurred_local_date <= ?');
  const rows = ctx.db.all<{ brand_id: number; up30: number; down30: number; up7: number; down7: number }>(
    `SELECT li.brand_id AS brand_id,
       SUM(CASE WHEN e.direction = 'up' THEN 1 ELSE 0 END) AS up30,
       SUM(CASE WHEN e.direction = 'down' THEN 1 ELSE 0 END) AS down30,
       SUM(CASE WHEN e.direction = 'up' AND e.occurred_local_date >= ? THEN 1 ELSE 0 END) AS up7,
       SUM(CASE WHEN e.direction = 'down' AND e.occurred_local_date >= ? THEN 1 ELSE 0 END) AS down7
     FROM price_events e JOIN v_listing_info li ON li.listing_id = e.listing_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY li.brand_id`,
    [from7, from7, ...params, from30, today],
  );
  return new Map(rows.map((r) => [r.brand_id, { d7: { increases: r.up7, decreases: r.down7 }, d30: { increases: r.up30, decreases: r.down30 } }]));
}

/**
 * One row per brand with at least one active listing in scope. Brands named in `ensure` get a row even when they
 * have no listing in scope (all counts zero).
 */
function explorerRows(
  ctx: AppContext,
  scope: BrandScope,
  rc: RowContext,
  ensure: number[] = [],
): { rows: BrandExplorerRow[]; listings: ListingNow[]; tags: Map<number, ListingTags> } {
  const listings = currentListings(ctx, scope);
  const byBrand = groupBy(listings, (l) => l.brand_id);
  const brandIds = [...new Set([...byBrand.keys(), ...ensure])];
  if (brandIds.length === 0) return { rows: [], listings, tags: new Map() };

  const meta = new Map(
    ctx.db
      .all<{ id: number; name: string; ownership: 'own' | 'competitor'; manufacturer: string | null; is_demo: number }>(
        `SELECT id, name, ownership, manufacturer, is_demo FROM brands WHERE id IN (${placeholders(brandIds.length)})`,
        brandIds,
      )
      .map((b) => [b.id, b]),
  );
  // Events and trends are read for exactly the brands of the rows (a search by name is not an observation filter).
  const narrowed: BrandScope = scope.q || scope.brand_ids || ensure.length ? { ...scope, q: undefined, brand_ids: brandIds } : scope;
  const moves = movesByBrand(ctx, narrowed, rc.today);
  const tags = listings.length ? currentTags(ctx, narrowed) : new Map<number, ListingTags>();
  const trends = indexedTrends(ctx, toFilter(narrowed), rc.trendPeriod, (info) => (info.brand_id ? [`B${info.brand_id}`] : []));
  const ownPairs = groupBy(rc.pairs, (p) => p.own_brand_id);
  const compPairs = groupBy(rc.pairs, (p) => p.comp_brand_id);

  const rows: BrandExplorerRow[] = [];
  for (const id of brandIds) {
    const brand = meta.get(id);
    if (!brand) continue;
    const mine = byBrand.get(id) ?? [];
    const fresh = mine.filter(isFresh);
    const promos = fresh.filter((l) => l.is_promo);
    const discounts = promos.map((l) => l.discount_pct).filter((d): d is number => d !== null);
    const categories = categoryCounts(mine);
    const trend = trends.get(`B${id}`) ?? [];
    const move = moves.get(id);
    rows.push({
      id,
      name: brand.name,
      ownership: brand.ownership,
      manufacturer: brand.manufacturer,
      is_demo: brand.is_demo,
      products: new Set(mine.map((l) => l.product_id)).size,
      listings: mine.length,
      retailers: new Set(mine.map((l) => l.retailer_id)).size,
      markets: new Set(mine.map((l) => l.market_id)).size,
      categories: categories.slice(0, 3),
      category_count: categories.length,
      freshness: {
        fresh: fresh.length,
        stale: mine.filter((l) => l.is_stale).length,
        never_observed: mine.filter((l) => l.never_observed).length,
        last_observed_at: latest(mine.map((l) => l.last_observed_at)),
      },
      price_ranges: priceRanges(mine, rc.converter),
      promo: {
        listings: promos.length,
        share_pct: fresh.length ? round((promos.length / fresh.length) * 100, 1) : null,
        avg_discount_pct: round(mean(discounts), 1),
        deepest_discount_pct: discounts.length ? round(Math.max(...discounts), 1) : null,
      },
      moves_7d: move?.d7 ?? { increases: 0, decreases: 0 },
      moves_30d: move?.d30 ?? { increases: 0, decreases: 0 },
      trend,
      trend_change_pct: trendChange(trend),
      price_index:
        brand.ownership === 'own' ? priceIndexOf(ownPairs.get(id) ?? [], 'own_vs_competitors') : priceIndexOf(compPairs.get(id) ?? [], 'own_vs_this_brand'),
      ...tagCounts(mine, tags),
    });
  }
  return { rows, listings, tags };
}

const SORT_VALUES: Record<BrandSort, (r: BrandExplorerRow) => number | string | null> = {
  name: (r) => r.name.toLowerCase(),
  products: (r) => r.products,
  listings: (r) => r.listings,
  retailers: (r) => r.retailers,
  markets: (r) => r.markets,
  promo_share: (r) => r.promo.share_pct,
  moves: (r) => r.moves_7d.increases + r.moves_7d.decreases,
  trend: (r) => r.trend_change_pct,
  index: (r) => r.price_index?.index ?? null,
  last_observation: (r) => r.freshness.last_observed_at,
};

/** Sorts in place. Default: own brands first, then by name. Brands without a value always sink to the bottom. */
export function sortBrandRows(rows: BrandExplorerRow[], sort: string | undefined): string {
  const byName = (a: BrandExplorerRow, b: BrandExplorerRow) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id;
  const desc = !!sort?.startsWith('-');
  const key = (sort ?? '').replace(/^-/, '') as BrandSort;
  if (!BRAND_SORTS.includes(key)) {
    rows.sort((a, b) => (a.ownership === b.ownership ? 0 : a.ownership === 'own' ? -1 : 1) || byName(a, b));
    return 'default';
  }
  const valueOf = SORT_VALUES[key];
  rows.sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va === null || vb === null) return va === vb ? byName(a, b) : va === null ? 1 : -1;
    const cmp = typeof va === 'string' ? va.localeCompare(String(vb), 'en', { sensitivity: 'base' }) : va - (vb as number);
    return (desc ? -cmp : cmp) || byName(a, b);
  });
  return `${desc ? '-' : ''}${key}`;
}

function rowContext(ctx: AppContext, scope: BrandScope, currency: 'native' | string | undefined): RowContext {
  const today = marketToday(ctx);
  return {
    today,
    trendPeriod: lastDays(today, TREND_DAYS),
    // The same cut-off as the price timeline, so every converted figure of a page uses one set of rates.
    converter: currency && currency !== 'native' ? makeConverter(ctx, currency, `${today}T23:59:59.999Z`) : null,
    pairs: latestPairs(ctx, { market_ids: scope.market_ids, retailer_ids: scope.retailer_ids, category_ids: scope.category_ids }),
  };
}

const disclosure = (converter: Converter | null, extra?: { conversions: Conversion[]; missing_rates: string[] }) => {
  const conversions = new Map<string, Conversion>();
  for (const c of [...(converter?.used() ?? []), ...(extra?.conversions ?? [])]) if (c.from !== c.to && !conversions.has(c.from)) conversions.set(c.from, c);
  return {
    currency_mode: converter ? ('converted' as const) : ('native' as const),
    target_currency: converter?.to ?? null,
    conversions: [...conversions.values()].sort((a, b) => a.from.localeCompare(b.from)),
    missing_rates: [...new Set([...(converter?.missing() ?? []), ...(extra?.missing_rates ?? [])])].sort(),
  };
};

/** Every brand with listed products in scope. */
export function brandExplorer(ctx: AppContext, scope: BrandScope, options: { sort?: string; currency?: 'native' | string } = {}): BrandExplorerResult {
  const rc = rowContext(ctx, scope, options.currency);
  const { rows, listings } = explorerRows(ctx, scope, rc);
  const sort = sortBrandRows(rows, options.sort);

  // Catalogue brands that match the brand-level filters but have nothing listed in this scope.
  const conditions: string[] = ['b.is_active = 1'];
  const params: SqlValue[] = [];
  if (scope.ownership) {
    conditions.push('b.ownership = ?');
    params.push(scope.ownership);
  }
  if (scope.q) {
    const p = likePattern(scope.q);
    conditions.push(`(b.name LIKE ? ESCAPE '\\' OR b.manufacturer LIKE ? ESCAPE '\\')`);
    params.push(p, p);
  }
  if (rows.length) {
    conditions.push(`b.id NOT IN (${placeholders(rows.length)})`);
    params.push(...rows.map((r) => r.id));
  }
  const unlisted = ctx.db.scalar<number>(`SELECT COUNT(*) FROM brands b WHERE ${conditions.join(' AND ')}`, params) ?? 0;

  const own = rows.filter((r) => r.ownership === 'own');
  const sum = (list: BrandExplorerRow[], pick: (r: BrandExplorerRow) => number) => list.reduce((acc, r) => acc + pick(r), 0);
  const summary: BrandExplorerSummary = {
    brands: rows.length,
    own_brands: own.length,
    competitor_brands: rows.length - own.length,
    products: sum(rows, (r) => r.products),
    own_products: sum(own, (r) => r.products),
    competitor_products: sum(rows, (r) => r.products) - sum(own, (r) => r.products),
    listings: listings.length,
    fresh_listings: listings.filter(isFresh).length,
    stale_listings: listings.filter((l) => l.is_stale).length,
    never_observed_listings: listings.filter((l) => l.never_observed).length,
    retailers: new Set(listings.map((l) => l.retailer_id)).size,
    markets: new Set(listings.map((l) => l.market_id)).size,
    currencies: [...new Set(listings.map((l) => l.currency_code))].sort(),
    brands_without_listings: unlisted,
  };
  return {
    generated_at: new Date().toISOString(),
    today: rc.today,
    trend_period: rc.trendPeriod,
    sort,
    rows,
    summary,
    demo: demoNote(listings),
    ...disclosure(rc.converter),
  };
}

// ---------------------------------------------------------------------------------------------
// Brand page
// ---------------------------------------------------------------------------------------------
interface ProductMeta {
  product_id: number;
  code: string | null;
  name: string;
  sku: string | null;
  status: string;
  pack_size: number | null;
  pack_unit: string | null;
  units_per_pack: number;
  image_url: string | null;
  is_demo: number;
  category_id: number | null;
  category_name: string | null;
  subcategory_name: string | null;
}

function brandProducts(ctx: AppContext, brandId: number, categoryIds: number[] | undefined, listedIds: number[]): ProductMeta[] {
  const conditions = ['p.brand_id = ?'];
  const params: SqlValue[] = [brandId];
  // Archived products are shown only while a retailer still lists them.
  if (listedIds.length) {
    conditions.push(`(p.status <> 'archived' OR p.id IN (${placeholders(listedIds.length)}))`);
    params.push(...listedIds);
  } else conditions.push(`p.status <> 'archived'`);
  if (categoryIds?.length) {
    const ph = placeholders(categoryIds.length);
    conditions.push(`(p.category_id IN (${ph}) OR p.subcategory_id IN (${ph}))`);
    params.push(...categoryIds, ...categoryIds);
  }
  return ctx.db.all<ProductMeta>(
    `SELECT p.id AS product_id, p.code, p.name, p.sku, p.status, p.pack_size, p.pack_unit, p.units_per_pack, p.image_url, p.is_demo,
       p.category_id, c.name AS category_name, sc.name AS subcategory_name
     FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN categories sc ON sc.id = p.subcategory_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY p.name COLLATE NOCASE, p.id`,
    params,
  );
}

const productBasis = (p: ProductMeta): string | null => basisLabel(packContent(p.pack_size, p.pack_unit, p.units_per_pack)?.dimension) || null;

/**
 * The lowest fresh shelf price of a product among retailers. Pack variants never take part; when a retailer lists
 * the standard pack more than once, its lowest price counts.
 */
function cheapestAmong(listings: ListingNow[]): { best: ListingNow & { current_price: number }; compared: number; winners: number[] } | null {
  const perRetailer = new Map<number, ListingNow & { current_price: number }>();
  for (const l of listings) {
    if (l.variant_id !== null || !hasCurrentPrice(l)) continue;
    const held = perRetailer.get(l.retailer_id);
    if (!held || l.current_price < held.current_price) perRetailer.set(l.retailer_id, l);
  }
  if (perRetailer.size === 0) return null;
  const candidates = [...perRetailer.values()].sort((a, b) => a.current_price - b.current_price || a.retailer_name.localeCompare(b.retailer_name));
  const best = candidates[0]!;
  return { best, compared: candidates.length, winners: candidates.filter((c) => c.current_price === best.current_price).map((c) => c.retailer_id) };
}

function rangeRows(
  products: ProductMeta[],
  listings: ListingNow[],
  trends: Map<string, BrandTrendPoint[]>,
  converter: Converter | null,
  tags: Map<number, ListingTags>,
): BrandRangeRow[] {
  const byProduct = groupBy(listings, (l) => l.product_id);
  return products.map((p) => {
    const mine = byProduct.get(p.product_id) ?? [];
    const fresh = mine.filter(isFresh);
    const content = packContent(p.pack_size, p.pack_unit, p.units_per_pack);

    // Shelf-price figures: standard pack only, per currency.
    const byCurrency = new Map<string, number[]>();
    for (const l of mine) {
      if (l.variant_id !== null || !hasCurrentPrice(l)) continue;
      const shown = displayPrice(l.current_price, l.currency_code, converter);
      if (!shown) continue;
      const values = byCurrency.get(shown.currency);
      if (values) values.push(shown.value);
      else byCurrency.set(shown.currency, [shown.value]);
    }
    const prices: BrandRangePrice[] = [...byCurrency.entries()]
      .map(([currency, values]) => {
        const avg = mean(values)!;
        return { currency, listings: values.length, min: Math.min(...values), avg: round(avg, 4)!, max: Math.max(...values), avg_unit_price: round(unitPrice(avg, content), 4) };
      })
      .sort((a, b) => b.listings - a.listings || a.currency.localeCompare(b.currency));

    const cheapest: BrandCheapest[] = [];
    for (const [, inMarket] of groupBy(mine, (l) => l.market_id)) {
      // one market can hold retailers in more than one currency: compare within the most common one only
      const priced = inMarket.filter((l) => l.variant_id === null && hasCurrentPrice(l));
      const currencies = groupBy(priced, (l) => l.currency_code);
      const main = [...currencies.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
      const found = main ? cheapestAmong(main[1]) : null;
      if (!found) continue;
      const shown = displayPrice(found.best.current_price, found.best.currency_code, converter) ?? { value: found.best.current_price, currency: found.best.currency_code };
      cheapest.push({
        market_id: found.best.market_id,
        market_code: found.best.market_code,
        market_name: found.best.market_name,
        retailer_id: found.best.retailer_id,
        retailer_name: found.best.retailer_name,
        listing_id: found.best.listing_id,
        price: shown.value,
        currency: shown.currency,
        native_price: found.best.current_price,
        native_currency: found.best.currency_code,
        is_promo: !!found.best.is_promo,
        compared: found.compared,
        tied: found.winners.length - 1,
      });
    }
    cheapest.sort((a, b) => a.market_name.localeCompare(b.market_name));

    const promos = fresh.filter((l) => l.is_promo);
    const deepest = promos.filter((l) => l.discount_pct !== null).sort((a, b) => b.discount_pct! - a.discount_pct! || a.retailer_name.localeCompare(b.retailer_name))[0];
    const trend = trends.get(`P${p.product_id}`) ?? [];
    return {
      product_id: p.product_id,
      code: p.code,
      name: p.name,
      sku: p.sku,
      status: p.status,
      pack: packLabel(p),
      unit_basis: productBasis(p),
      category_id: p.category_id,
      category_name: p.category_name,
      subcategory_name: p.subcategory_name,
      image_url: p.image_url,
      is_demo: p.is_demo,
      listings: mine.length,
      retailers: new Set(mine.map((l) => l.retailer_id)).size,
      markets: new Set(mine.map((l) => l.market_id)).size,
      fresh: fresh.length,
      stale: mine.filter((l) => l.is_stale).length,
      never_observed: mine.filter((l) => l.never_observed).length,
      variant_listings: mine.filter((l) => l.variant_id !== null).length,
      prices,
      cheapest,
      promo_listings: promos.length,
      deepest_discount_pct: deepest ? round(deepest.discount_pct, 1) : null,
      deepest_discount_retailer: deepest?.retailer_name ?? null,
      change_30d_pct: trendChange(trend),
      trend,
      last_observed_at: latest(mine.map((l) => l.last_observed_at)),
      ...tagCounts(mine, tags),
    };
  });
}

function marketOptions(listings: ListingNow[]): BrandMarketOption[] {
  return [...groupBy(listings, (l) => l.market_id).values()]
    .map((inMarket) => {
      const currencies = groupBy(inMarket, (l) => l.currency_code);
      return {
        id: inMarket[0]!.market_id,
        code: inMarket[0]!.market_code,
        name: inMarket[0]!.market_name,
        currency_code: [...currencies.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0]![0],
        listings: inMarket.length,
        products: new Set(inMarket.map((l) => l.product_id)).size,
        retailers: new Set(inMarket.map((l) => l.retailer_id)).size,
      };
    })
    .sort((a, b) => b.listings - a.listings || a.name.localeCompare(b.name));
}

const matrixListing = (l: ListingNow): BrandMatrixListing => ({
  listing_id: l.listing_id,
  variant_name: l.variant_name,
  current_price: l.current_price,
  unit_price: round(unitPriceOf(l.current_price, l), 4),
  is_promo: !!l.is_promo,
  is_stale: !!l.is_stale,
  never_observed: !!l.never_observed,
});

/** Which listing represents a product at a retailer: standard pack before variants, fresh before stale, cheapest first. */
function primaryListing(listings: ListingNow[]): ListingNow {
  const rank = (l: ListingNow) => (l.variant_id === null ? 0 : 3) + (hasCurrentPrice(l) ? 0 : l.never_observed ? 2 : 1);
  return [...listings].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      // variants are only comparable per unit of content
      (a.variant_id === null ? (a.current_price ?? Infinity) - (b.current_price ?? Infinity) : (unitPriceOf(a.current_price, a) ?? Infinity) - (unitPriceOf(b.current_price, b) ?? Infinity)) ||
      a.listing_id - b.listing_id,
  )[0]!;
}

function priceMatrix(
  ctx: AppContext,
  market: BrandMarketOption,
  listings: ListingNow[],
  products: ProductMeta[],
  scope: BrandScope,
  tags: Map<number, ListingTags>,
): BrandMatrix {
  const inMarket = listings.filter((l) => l.market_id === market.id);
  const first = inMarket[0]!;
  const byRetailer = groupBy(inMarket, (l) => l.retailer_id);
  const columns = [...byRetailer.entries()]
    .map(([id, own]) => ({ id, name: own[0]!.retailer_name, is_demo: own.some((l) => l.is_demo) ? 1 : 0, listings: own.length, products: new Set(own.map((l) => l.product_id)).size, cheapest_count: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  const currency = market.currency_code;
  const byProduct = groupBy(inMarket, (l) => l.product_id);
  const productMeta = new Map(products.map((p) => [p.product_id, p]));

  const rows: BrandMatrixRow[] = [];
  for (const [productId, own] of byProduct) {
    const meta = productMeta.get(productId);
    const atRetailer = groupBy(own, (l) => l.retailer_id);
    // only prices in the market's main currency are compared with each other
    const found = cheapestAmong(own.filter((l) => l.currency_code === currency));
    const compared = found?.compared ?? 0;
    const winners = found && compared >= 2 ? found.winners : [];
    const comparedPrices = [...atRetailer.values()]
      .map((ls) => cheapestAmong(ls.filter((l) => l.currency_code === currency))?.best.current_price ?? null)
      .filter((v): v is number => v !== null);
    const cells = columns.map((column): BrandMatrixCell | null => {
      const here = atRetailer.get(column.id);
      if (!here) return null;
      const main = primaryListing(here);
      const signal = isFresh(main) ? tags.get(main.listing_id) : undefined;
      const discounted = !!main.is_promo && main.regular_price !== null && main.current_price !== null && main.regular_price > main.current_price;
      return {
        ...matrixListing(main),
        currency: main.currency_code,
        regular_price: discounted ? main.regular_price : null,
        discount_pct: main.is_promo ? main.discount_pct : null,
        promo_type: main.is_promo ? main.promo_type : null,
        availability: main.availability,
        observed_at: main.last_observed_at,
        is_variant: main.variant_id !== null,
        is_cheapest: winners.includes(column.id) && main.variant_id === null && hasCurrentPrice(main) && main.currency_code === currency && main.current_price === found!.best.current_price,
        more_listings: here.filter((l) => l.listing_id !== main.listing_id).map(matrixListing),
        is_demo: main.is_demo,
        ...(signal ? { tags: signal.tags, ...(signal.text ? { tag_text: signal.text } : {}) } : {}),
      };
    });
    for (const id of winners) columns.find((c) => c.id === id)!.cheapest_count += 1;
    const min = comparedPrices.length ? Math.min(...comparedPrices) : null;
    const max = comparedPrices.length ? Math.max(...comparedPrices) : null;
    rows.push({
      product_id: productId,
      code: meta?.code ?? null,
      name: meta?.name ?? own[0]!.product_name,
      pack: meta ? packLabel(meta) : '',
      unit_basis: meta ? productBasis(meta) : null,
      category_name: meta ? (meta.subcategory_name ?? meta.category_name) : (own[0]!.subcategory_name ?? own[0]!.category_name),
      is_demo: meta?.is_demo ?? (own.some((l) => l.is_demo) ? 1 : 0),
      cells,
      listed_at: atRetailer.size,
      compared,
      cheapest_retailer_ids: winners,
      min_price: min,
      max_price: max,
      spread_pct: compared >= 2 && min !== null && max !== null && min > 0 ? round(((max - min) / min) * 100, 1) : null,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.product_id - b.product_id);

  const conditions = ['r.market_id = ?', 'r.is_active = 1'];
  const params: SqlValue[] = [market.id];
  if (columns.length) {
    conditions.push(`r.id NOT IN (${placeholders(columns.length)})`);
    params.push(...columns.map((c) => c.id));
  }
  if (scope.retailer_ids?.length) {
    conditions.push(`r.id IN (${placeholders(scope.retailer_ids.length)})`);
    params.push(...scope.retailer_ids);
  }
  const without = ctx.db.all<{ id: number; name: string }>(`SELECT r.id, r.name FROM retailers r WHERE ${conditions.join(' AND ')} ORDER BY r.name`, params);

  return {
    market: { id: market.id, code: market.code, name: market.name, currency_code: currency, timezone: first.timezone },
    currency,
    other_currencies: [...new Set(inMarket.map((l) => l.currency_code))].filter((c) => c !== currency).sort(),
    retailers: columns,
    rows,
    retailers_without_brand: without,
    products_not_listed: products.filter((p) => !byProduct.has(p.product_id)).map((p) => ({ product_id: p.product_id, name: p.name })),
  };
}

/** Brands this brand competes with: declared benchmarks plus brands linked by product mappings. */
function relatedBrands(ctx: AppContext, brandId: number, ownership: 'own' | 'competitor'): Map<number, { is_benchmark: boolean; approved: number; suggested: number }> {
  const related = new Map<number, { is_benchmark: boolean; approved: number; suggested: number }>();
  const entry = (id: number) => {
    let e = related.get(id);
    if (!e) {
      e = { is_benchmark: false, approved: 0, suggested: 0 };
      related.set(id, e);
    }
    return e;
  };
  const declared = ctx.db.all<{ id: number }>(
    ownership === 'own'
      ? 'SELECT competitor_brand_id AS id FROM brand_competitors WHERE own_brand_id = ?'
      : 'SELECT own_brand_id AS id FROM brand_competitors WHERE competitor_brand_id = ?',
    [brandId],
  );
  for (const d of declared) entry(d.id).is_benchmark = true;
  const mapped = ctx.db.all<{ own_brand_id: number; comp_brand_id: number; approved: number; suggested: number }>(
    `SELECT op.brand_id AS own_brand_id, cp.brand_id AS comp_brand_id,
       SUM(CASE WHEN cm.status = 'approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN cm.status = 'suggested' THEN 1 ELSE 0 END) AS suggested
     FROM competitor_mappings cm JOIN products op ON op.id = cm.own_product_id JOIN products cp ON cp.id = cm.competitor_product_id
     WHERE cm.status IN ('approved', 'suggested') AND (op.brand_id = ? OR cp.brand_id = ?)
     GROUP BY op.brand_id, cp.brand_id`,
    [brandId, brandId],
  );
  for (const m of mapped) {
    const other = m.own_brand_id === brandId ? m.comp_brand_id : m.own_brand_id;
    if (other === brandId) continue;
    const e = entry(other);
    e.approved += m.approved;
    e.suggested += m.suggested;
  }
  return related;
}

export interface BrandDetailOptions {
  market_ids?: number[];
  retailer_ids?: number[];
  category_ids?: number[];
  /** Market of the price matrix. Default: the only market in scope, else the one with most listings of the brand. */
  matrix_market_id?: number;
  /** Days of the trend charts. */
  days?: number;
  currency?: 'native' | string;
}

export function brandDetail(ctx: AppContext, brandId: number, options: BrandDetailOptions = {}): BrandDetailResult {
  const brand = ctx.db.get<{ id: number; name: string; ownership: 'own' | 'competitor'; is_active: number }>('SELECT id, name, ownership, is_active FROM brands WHERE id = ?', [brandId]);
  if (!brand) throw notFound('Brand');
  const base: BrandScope = { market_ids: options.market_ids, retailer_ids: options.retailer_ids, category_ids: options.category_ids };
  const scope: BrandScope = { ...base, brand_ids: [brandId] };
  const rc = rowContext(ctx, base, options.currency);
  const own = explorerRows(ctx, scope, rc, [brandId]);
  const listings = own.listings;
  const header = own.rows[0]!;

  // ---- (a) product range ------------------------------------------------------------------------
  const products = brandProducts(ctx, brandId, options.category_ids, [...new Set(listings.map((l) => l.product_id))]);
  const productTrends = indexedTrends(ctx, toFilter(scope), rc.trendPeriod, (info) => (info.product_id ? [`P${info.product_id}`] : []));
  const range = rangeRows(products, listings, productTrends, rc.converter, own.tags);

  // ---- (b) price matrix of one market -----------------------------------------------------------
  const markets = marketOptions(listings);
  const matrixMarket = markets.find((m) => m.id === options.matrix_market_id) ?? markets[0] ?? null;
  const matrix = matrixMarket ? priceMatrix(ctx, matrixMarket, listings, products, scope, own.tags) : null;

  // ---- (d) competing brands ---------------------------------------------------------------------
  const related = relatedBrands(ctx, brandId, brand.ownership);
  const relatedIds = [...related.keys()];
  const relatedRows = relatedIds.length ? explorerRows(ctx, { ...base, brand_ids: relatedIds }, rc, relatedIds).rows : [];
  const competitors: BrandCompetitorRow[] = relatedRows.map((row) => {
    const link = related.get(row.id)!;
    const ownId = brand.ownership === 'own' ? brandId : row.id;
    const compId = brand.ownership === 'own' ? row.id : brandId;
    const between = priceIndexOf(rc.pairs.filter((p) => p.own_brand_id === ownId && p.comp_brand_id === compId), 'own_vs_this_brand');
    return {
      brand: row,
      is_benchmark: link.is_benchmark,
      approved_mappings: link.approved,
      suggested_mappings: link.suggested,
      own_brand_name: brand.ownership === 'own' ? brand.name : row.name,
      competitor_brand_name: brand.ownership === 'own' ? row.name : brand.name,
      index: between?.index ?? null,
      premium_pct: between?.premium_pct ?? null,
      pairs: between?.pairs ?? 0,
      cheaper_pairs: between?.cheaper_pairs ?? 0,
      dearer_pairs: between?.dearer_pairs ?? 0,
      not_comparable_pairs: between?.not_comparable_pairs ?? 0,
    };
  });
  competitors.sort(
    (a, b) => Number(b.is_benchmark) - Number(a.is_benchmark) || b.pairs - a.pairs || b.brand.products - a.brand.products || a.brand.name.localeCompare(b.brand.name),
  );

  // ---- (c) trend --------------------------------------------------------------------------------
  const days = options.days ?? TREND_DAYS;
  const period = lastDays(rc.today, days);
  const byCategory = timeline(
    ctx,
    { ...toFilter(scope), date_from: period.from, date_to: period.to },
    { groupBy: 'category', metric: 'unit_price', currency: options.currency ?? 'native', bucket: 'day', maxSeries: 40 },
  );
  const charted = [brandId, ...competitors.slice(0, MAX_INDEX_SERIES - 1).map((c) => c.brand.id)];
  const indexTrends = indexedTrends(ctx, toFilter({ ...base, brand_ids: charted }), period, (info) => (info.brand_id ? [`B${info.brand_id}`] : []));
  const rowById = new Map([header, ...relatedRows].map((r) => [r.id, r]));
  const index: BrandIndexSeries[] = charted
    .map((id) => {
      const row = rowById.get(id)!;
      const points = indexTrends.get(`B${id}`) ?? [];
      return { brand_id: id, name: row.name, ownership: row.ownership, is_self: id === brandId, is_demo: row.is_demo, points, change_pct: trendChange(points) };
    })
    .filter((s) => s.is_self || s.points.length > 0);

  // ---- (e) unmatched listings that look like this brand -----------------------------------------
  const unmatchedConditions = [`li.match_status = 'unmatched'`, `li.listing_title LIKE ? ESCAPE '\\'`];
  const unmatchedParams: SqlValue[] = [likePattern(brand.name)];
  if (options.market_ids?.length) {
    unmatchedConditions.push(`li.market_id IN (${placeholders(options.market_ids.length)})`);
    unmatchedParams.push(...options.market_ids);
  }
  if (options.retailer_ids?.length) {
    unmatchedConditions.push(`li.retailer_id IN (${placeholders(options.retailer_ids.length)})`);
    unmatchedParams.push(...options.retailer_ids);
  }
  const unmatched = ctx.db.scalar<number>(`SELECT COUNT(*) FROM v_listing_info li WHERE ${unmatchedConditions.join(' AND ')}`, unmatchedParams) ?? 0;

  return {
    generated_at: new Date().toISOString(),
    today: rc.today,
    brand: { ...header, is_active: brand.is_active, products_total: products.length },
    scope: { market_ids: options.market_ids ?? null, retailer_ids: options.retailer_ids ?? null, category_ids: options.category_ids ?? null },
    range,
    markets,
    matrix,
    trend: { days, period, by_category: byCategory, index },
    competitors,
    unmatched: { count: unmatched, search: brand.name },
    demo: demoNote(listings),
    ...disclosure(rc.converter, { conversions: byCategory.conversions, missing_rates: byCategory.missing_rates }),
  };
}
