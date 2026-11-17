/**
 * Historical price analytics over the observation ledger: daily price series, timelines, period
 * comparisons, descriptive statistics and volatility.
 *
 * Method notes (shown to users where relevant)
 *   * The daily price of a listing is its last priced observation on that market-local calendar day.
 *   * Group values are simple averages of the member listings' daily prices on days they were observed.
 *   * Prices in different currencies are never averaged together: series are split per currency, or all
 *     values are converted to one currency with a stated exchange rate (rate, timestamp and source returned).
 *   * Unit prices on different bases (per 100 ml / per 100 g / per unit) are never mixed either.
 */
import type { AppContext } from '../../context.ts';
import { OBS_FROM, obsWhere, type ObsFilter } from '../obs-filter.ts';
import { makeConverter, type Conversion } from '../fx.ts';
import { addDays } from '../../lib/time.ts';
import {
  basisLabel, computeStats, demoNote, loadListings, mean, pctChange, round, unitPriceOf, type DateRange, type DemoNote, type ListingInfo, type Stats,
} from './common.ts';
import type { SeriesRef, GroupBy, Metric, TimelinePoint, TimelineSeries, TimelineResult, PeriodStats, CompareRow, PeriodCompareResult as CompareResult, HistorySummary, VolatilityRow } from '../../../shared/api/analytics.ts';
export type { SeriesRef, GroupBy, Metric, TimelinePoint, TimelineSeries, TimelineResult, PeriodStats, CompareRow, CompareResult, HistorySummary, VolatilityRow };

export interface DailyRow {
  listing_id: number;
  date: string;
  current_price: number | null;
  regular_price: number | null;
  is_promo: number;
  discount_pct: number | null;
  availability: string;
  currency_code: string;
  is_demo: number;
  data_class: string;
  obs_in_day: number;
}

/** One row per listing per market-local day: the last priced observation of that day. */
export function dailySeries(ctx: AppContext, filter: ObsFilter): DailyRow[] {
  const where = obsWhere(filter);
  return ctx.db.all<DailyRow>(
    `SELECT listing_id, date, current_price, regular_price, is_promo, discount_pct, availability, currency_code, is_demo, data_class, obs_in_day
     FROM (
       SELECT o.listing_id, o.observed_local_date AS date, o.current_price, o.regular_price, o.is_promo, o.discount_pct, o.availability,
         o.currency_code, o.is_demo, o.data_class,
         ROW_NUMBER() OVER (PARTITION BY o.listing_id, o.observed_local_date ORDER BY (o.current_price IS NULL), o.observed_at DESC, o.id DESC) AS rn,
         COUNT(*) OVER (PARTITION BY o.listing_id, o.observed_local_date) AS obs_in_day
       ${OBS_FROM} ${where.sql}
     ) WHERE rn = 1
     ORDER BY listing_id, date`,
    where.params,
  );
}

export const GROUP_BYS: GroupBy[] = ['listing', 'product', 'retailer', 'brand', 'market', 'category', 'ownership'];
export const METRICS: Metric[] = ['price', 'unit_price', 'regular_price', 'discount'];

interface GroupMeta {
  key: string;
  label: string;
  sublabel: string | null;
  ownership: 'own' | 'competitor' | 'mixed' | null;
  currency: string | null;
  basis: string | null;
  ref: SeriesRef;
}

function groupMeta(info: ListingInfo, groupBy: GroupBy): Omit<GroupMeta, 'currency' | 'basis'> {
  switch (groupBy) {
    case 'listing':
      return {
        key: `L${info.listing_id}`,
        label: info.product_name ?? info.listing_title ?? info.listing_code,
        sublabel: [info.retailer_name, info.market_name, info.variant_name].filter(Boolean).join(' · '),
        ownership: info.ownership,
        ref: { listing_id: info.listing_id, product_id: info.product_id, retailer_id: info.retailer_id, market_id: info.market_id },
      };
    case 'product':
      return {
        key: `P${info.product_id ?? `u${info.listing_id}`}`,
        label: info.product_name ?? info.listing_title ?? 'Unmatched listing',
        sublabel: info.brand_name,
        ownership: info.ownership,
        ref: { product_id: info.product_id, brand_id: info.brand_id },
      };
    case 'retailer':
      return { key: `R${info.retailer_id}`, label: info.retailer_name, sublabel: info.market_name, ownership: null, ref: { retailer_id: info.retailer_id, market_id: info.market_id } };
    case 'brand':
      return { key: `B${info.brand_id ?? 0}`, label: info.brand_name ?? 'Unmatched', sublabel: info.ownership === 'own' ? 'Own brand' : info.ownership === 'competitor' ? 'Competitor' : null, ownership: info.ownership, ref: { brand_id: info.brand_id } };
    case 'market':
      return { key: `M${info.market_id}`, label: info.market_name, sublabel: info.currency_code, ownership: null, ref: { market_id: info.market_id } };
    case 'category': {
      const id = info.subcategory_id ?? info.category_id;
      return { key: `C${id ?? 0}`, label: info.subcategory_name ?? info.category_name ?? 'Uncategorised', sublabel: info.subcategory_name ? info.category_name : null, ownership: null, ref: { category_id: id } };
    }
    case 'ownership':
      return { key: `O${info.ownership ?? 'none'}`, label: info.ownership === 'own' ? 'Own brands' : info.ownership === 'competitor' ? 'Competitors' : 'Unmatched', sublabel: null, ownership: info.ownership, ref: {} };
  }
}

export interface ValueContext {
  metric: Metric;
  /** 'native' keeps each listing's own currency (groups are split per currency). */
  currency: 'native' | string;
  convert: (amount: number | null, from: string) => number | null;
  /** Leave pack variants out of shelf-price values (set when grouping by product). */
  excludeVariants?: boolean;
}

/** The metric value of one daily row, or null when it is not available. */
function metricValue(row: DailyRow, info: ListingInfo, vc: ValueContext): number | null {
  if (vc.metric === 'discount') return row.is_promo && row.discount_pct !== null ? row.discount_pct : null;
  // A pack variant (twin pack, bonus pack) has a different shelf price by construction: it only joins
  // product-level averages on a unit-price basis.
  if (vc.excludeVariants && info.variant_id !== null && vc.metric !== 'unit_price') return null;
  const price = vc.metric === 'regular_price' ? (row.regular_price ?? row.current_price) : row.current_price;
  if (price === null) return null;
  const money = vc.currency === 'native' ? price : vc.convert(price, row.currency_code);
  if (money === null) return null;
  return vc.metric === 'unit_price' ? unitPriceOf(money, info) : money;
}

function fullKey(base: Omit<GroupMeta, 'currency' | 'basis'>, row: DailyRow, info: ListingInfo, vc: ValueContext): GroupMeta {
  const currency = vc.metric === 'discount' ? null : vc.currency === 'native' ? row.currency_code : vc.currency;
  const basis = vc.metric === 'unit_price' ? basisLabel(info.content_dimension) : null;
  return { ...base, key: `${base.key}|${currency ?? ''}|${basis ?? ''}`, currency, basis };
}

function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(date, -offset);
}

export function timeline(
  ctx: AppContext,
  filter: ObsFilter,
  options: { groupBy?: GroupBy; metric?: Metric; currency?: 'native' | string; bucket?: 'day' | 'week'; maxSeries?: number } = {},
): TimelineResult {
  const groupBy = options.groupBy ?? 'listing';
  const metric = options.metric ?? 'price';
  const currency = options.currency ?? 'native';
  const bucket = options.bucket ?? 'day';
  const rows = dailySeries(ctx, filter);
  const listings = loadListings(ctx, rows.map((r) => r.listing_id));
  const converter = currency === 'native' ? null : makeConverter(ctx, currency, filter.date_to ? `${filter.date_to}T23:59:59.999Z` : undefined);
  const vc: ValueContext = { metric, currency, convert: (amount, from) => (converter ? converter.convert(amount, from) : amount), excludeVariants: groupBy === 'product' };

  interface Acc {
    meta: GroupMeta;
    listings: Set<number>;
    demo: boolean;
    ownerships: Set<string>;
    days: Map<string, { sum: number; n: number; promo: number }>;
  }
  const groups = new Map<string, Acc>();
  for (const row of rows) {
    const info = listings.get(row.listing_id);
    if (!info) continue;
    const value = metricValue(row, info, vc);
    if (value === null) continue;
    const meta = fullKey(groupMeta(info, groupBy), row, info, vc);
    let acc = groups.get(meta.key);
    if (!acc) {
      acc = { meta, listings: new Set(), demo: false, ownerships: new Set(), days: new Map() };
      groups.set(meta.key, acc);
    }
    acc.listings.add(row.listing_id);
    if (row.is_demo) acc.demo = true;
    if (info.ownership) acc.ownerships.add(info.ownership);
    const date = bucket === 'week' ? weekStart(row.date) : row.date;
    const day = acc.days.get(date) ?? { sum: 0, n: 0, promo: 0 };
    day.sum += value;
    day.n += 1;
    day.promo += row.is_promo ? 1 : 0;
    acc.days.set(date, day);
  }

  // When one base group appears in several currencies / bases, say so in the label.
  const baseCounts = new Map<string, number>();
  for (const acc of groups.values()) {
    const base = acc.meta.key.split('|')[0]!;
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  let series: TimelineSeries[] = [...groups.values()].map((acc) => {
    const points = [...acc.days.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, d]) => ({ date, value: round(d.sum / d.n, 4)!, n: d.n, promo: round(d.promo / d.n, 3)! }));
    const split = (baseCounts.get(acc.meta.key.split('|')[0]!) ?? 1) > 1;
    const suffix = split ? [acc.meta.currency, acc.meta.basis].filter(Boolean).join(' · ') : '';
    return {
      key: acc.meta.key,
      label: acc.meta.label,
      sublabel: [acc.meta.sublabel, suffix].filter(Boolean).join(' · ') || null,
      ownership: acc.ownerships.size > 1 ? 'mixed' : acc.meta.ownership,
      currency: acc.meta.currency,
      basis: acc.meta.basis,
      ref: acc.meta.ref,
      listing_count: acc.listings.size,
      is_demo: acc.demo,
      points,
      stats: computeStats(points.map((p) => p.value)),
    };
  });
  series.sort((a, b) => b.points.length - a.points.length || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  const total = series.length;
  const max = options.maxSeries ?? 30;
  const truncated = total > max;
  if (truncated) series = series.slice(0, max);

  const dates = rows.map((r) => r.date);
  return {
    group_by: groupBy,
    metric,
    bucket,
    currency_mode: currency === 'native' ? 'native' : 'converted',
    target_currency: currency === 'native' ? null : currency,
    series,
    total_series: total,
    truncated,
    conversions: converter?.used() ?? [],
    missing_rates: converter?.missing() ?? [],
    demo: demoNote(rows),
    from: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
    to: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

/** Compares period A (the more recent one, typically) with period B for each group. */
export function comparePeriods(
  ctx: AppContext,
  filter: ObsFilter,
  a: DateRange,
  b: DateRange,
  options: { groupBy?: GroupBy; metric?: Metric; currency?: 'native' | string } = {},
): CompareResult {
  const groupBy = options.groupBy ?? 'product';
  const metric = options.metric ?? 'price';
  const currency = options.currency ?? 'native';
  const span: ObsFilter = { ...filter, date_from: a.from < b.from ? a.from : b.from, date_to: a.to > b.to ? a.to : b.to };
  const rows = dailySeries(ctx, span);
  const listings = loadListings(ctx, rows.map((r) => r.listing_id));
  const converter = currency === 'native' ? null : makeConverter(ctx, currency, `${span.date_to}T23:59:59.999Z`);
  const vc: ValueContext = { metric, currency, convert: (amount, from) => (converter ? converter.convert(amount, from) : amount), excludeVariants: groupBy === 'product' };

  interface Side {
    values: number[];
    dates: Set<string>;
    listings: Set<number>;
    promo: number;
  }
  interface Acc {
    meta: GroupMeta;
    demo: boolean;
    ownerships: Set<string>;
    a: Side;
    b: Side;
  }
  const newSide = (): Side => ({ values: [], dates: new Set(), listings: new Set(), promo: 0 });
  const groups = new Map<string, Acc>();
  const used: DailyRow[] = [];
  for (const row of rows) {
    const inA = row.date >= a.from && row.date <= a.to;
    const inB = row.date >= b.from && row.date <= b.to;
    if (!inA && !inB) continue;
    const info = listings.get(row.listing_id);
    if (!info) continue;
    const value = metricValue(row, info, vc);
    if (value === null) continue;
    used.push(row);
    const meta = fullKey(groupMeta(info, groupBy), row, info, vc);
    let acc = groups.get(meta.key);
    if (!acc) {
      acc = { meta, demo: false, ownerships: new Set(), a: newSide(), b: newSide() };
      groups.set(meta.key, acc);
    }
    if (row.is_demo) acc.demo = true;
    if (info.ownership) acc.ownerships.add(info.ownership);
    for (const side of [inA ? acc.a : null, inB ? acc.b : null]) {
      if (!side) continue;
      side.values.push(value);
      side.dates.add(row.date);
      side.listings.add(row.listing_id);
      side.promo += row.is_promo ? 1 : 0;
    }
  }
  const sideStats = (side: Side): PeriodStats | null => {
    const s = computeStats(side.values);
    if (!s) return null;
    return {
      avg: s.avg, median: s.median, min: s.min, max: s.max, points: s.n, days: side.dates.size, listings: side.listings.size,
      promo_share_pct: round((side.promo / s.n) * 100, 1)!, volatility_pct: s.volatility_pct,
    };
  };
  const baseCounts = new Map<string, number>();
  for (const acc of groups.values()) {
    const base = acc.meta.key.split('|')[0]!;
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const out: CompareRow[] = [...groups.values()].map((acc) => {
    const sa = sideStats(acc.a);
    const sb = sideStats(acc.b);
    const split = (baseCounts.get(acc.meta.key.split('|')[0]!) ?? 1) > 1;
    const suffix = split ? [acc.meta.currency, acc.meta.basis].filter(Boolean).join(' · ') : '';
    return {
      key: acc.meta.key,
      label: acc.meta.label,
      sublabel: [acc.meta.sublabel, suffix].filter(Boolean).join(' · ') || null,
      ownership: acc.ownerships.size > 1 ? 'mixed' : acc.meta.ownership,
      currency: acc.meta.currency,
      basis: acc.meta.basis,
      ref: acc.meta.ref,
      is_demo: acc.demo,
      a: sa,
      b: sb,
      delta_abs: sa && sb ? round(sa.avg - sb.avg, 4) : null,
      delta_pct: sa && sb ? pctChange(sb.avg, sa.avg) : null,
    };
  });
  out.sort((x, y) => Math.abs(y.delta_pct ?? -1) - Math.abs(x.delta_pct ?? -1) || x.label.localeCompare(y.label));
  const comparable = out.filter((r) => r.delta_pct !== null);
  const changes = comparable.map((r) => r.delta_pct!);
  return {
    group_by: groupBy,
    metric,
    period_a: a,
    period_b: b,
    currency_mode: currency === 'native' ? 'native' : 'converted',
    target_currency: currency === 'native' ? null : currency,
    rows: out,
    summary: {
      groups: out.length,
      comparable: comparable.length,
      increased: changes.filter((c) => c > 0.05).length,
      decreased: changes.filter((c) => c < -0.05).length,
      unchanged: changes.filter((c) => Math.abs(c) <= 0.05).length,
      avg_change_pct: round(mean(changes), 2),
      only_in_a: out.filter((r) => r.a && !r.b).length,
      only_in_b: out.filter((r) => !r.a && r.b).length,
    },
    conversions: converter?.used() ?? [],
    missing_rates: converter?.missing() ?? [],
    demo: demoNote(used),
  };
}

export function historySummary(ctx: AppContext, filter: ObsFilter): HistorySummary {
  const where = obsWhere(filter);
  const totals = ctx.db.get<{
    observations: number; listings: number; products: number; retailers: number; markets: number; brands: number;
    first_observed_at: string | null; last_observed_at: string | null; promo_observations: number | null; demo_observations: number | null;
  }>(
    `SELECT COUNT(*) AS observations, COUNT(DISTINCT o.listing_id) AS listings, COUNT(DISTINCT li.product_id) AS products,
       COUNT(DISTINCT o.retailer_id) AS retailers, COUNT(DISTINCT o.market_id) AS markets, COUNT(DISTINCT li.brand_id) AS brands,
       MIN(o.observed_at) AS first_observed_at, MAX(o.observed_at) AS last_observed_at,
       SUM(o.is_promo) AS promo_observations, SUM(o.is_demo) AS demo_observations
     ${OBS_FROM} ${where.sql}`,
    where.params,
  )!;
  const byClass = ctx.db.all<{ data_class: string; observations: number }>(
    `SELECT o.data_class, COUNT(*) AS observations ${OBS_FROM} ${where.sql} GROUP BY o.data_class ORDER BY observations DESC`,
    where.params,
  );
  const prices = ctx.db.all<{ currency_code: string; current_price: number }>(
    `SELECT o.currency_code, o.current_price ${OBS_FROM} ${where.sql} AND o.current_price IS NOT NULL ORDER BY o.observed_at`,
    where.params,
  );
  const perCurrency = new Map<string, number[]>();
  for (const p of prices) {
    const list = perCurrency.get(p.currency_code);
    if (list) list.push(p.current_price);
    else perCurrency.set(p.currency_code, [p.current_price]);
  }
  return {
    observations: totals.observations,
    listings: totals.listings,
    products: totals.products,
    retailers: totals.retailers,
    markets: totals.markets,
    brands: totals.brands,
    first_observed_at: totals.first_observed_at,
    last_observed_at: totals.last_observed_at,
    promo_observations: totals.promo_observations ?? 0,
    promo_share_pct: totals.observations ? round(((totals.promo_observations ?? 0) / totals.observations) * 100, 1) : null,
    by_data_class: byClass,
    by_currency: [...perCurrency.entries()]
      .map(([currency, values]) => {
        const s = computeStats(values)!;
        return { currency, observations: s.n, avg: s.avg, median: s.median, min: s.min, max: s.max, volatility_pct: s.volatility_pct };
      })
      .sort((x, y) => y.observations - x.observations),
    demo_observations: totals.demo_observations ?? 0,
  };
}

/** Ranks listings (or products within a currency) by how much their selling price moved. */
export function volatilityRanking(ctx: AppContext, filter: ObsFilter, options: { groupBy?: 'listing' | 'product'; limit?: number; minDays?: number } = {}): VolatilityRow[] {
  const rows = dailySeries(ctx, filter);
  const listings = loadListings(ctx, rows.map((r) => r.listing_id));
  const byListing = new Map<number, DailyRow[]>();
  for (const row of rows) {
    if (row.current_price === null) continue;
    const list = byListing.get(row.listing_id);
    if (list) list.push(row);
    else byListing.set(row.listing_id, [row]);
  }
  const minDays = options.minDays ?? 5;
  const perListing: VolatilityRow[] = [];
  for (const [listingId, series] of byListing) {
    const info = listings.get(listingId);
    if (!info || series.length < minDays) continue;
    const values = series.map((s) => s.current_price!);
    const stats = computeStats(values)!;
    let changes = 0;
    for (let i = 1; i < values.length; i++) if (Math.abs(values[i]! - values[i - 1]!) > 1e-9) changes++;
    perListing.push({
      key: `L${listingId}`,
      label: info.product_name ?? info.listing_title ?? info.listing_code,
      sublabel: `${info.retailer_name} · ${info.market_name}`,
      ownership: info.ownership,
      currency: info.currency_code,
      product_id: info.product_id,
      listing_id: listingId,
      retailer_name: info.retailer_name,
      market_name: info.market_name,
      days: stats.n,
      price_changes: changes,
      avg: stats.avg,
      min: stats.min,
      max: stats.max,
      range_pct: stats.min > 0 ? round(((stats.max - stats.min) / stats.min) * 100, 2) : null,
      volatility_pct: stats.volatility_pct,
      is_demo: series.some((s) => s.is_demo === 1),
    });
  }
  let out = perListing;
  if (options.groupBy === 'product') {
    const groups = new Map<string, VolatilityRow[]>();
    for (const row of perListing) {
      const key = `P${row.product_id ?? row.listing_id}|${row.currency}`;
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    out = [...groups.entries()].map(([key, list]) => {
      const first = list[0]!;
      const markets = new Set(list.map((l) => l.market_name));
      return {
        key,
        label: first.label,
        sublabel: `${list.length} listing${list.length === 1 ? '' : 's'} · ${[...markets].join(', ')}`,
        ownership: first.ownership,
        currency: first.currency,
        product_id: first.product_id,
        listing_id: null,
        retailer_name: null,
        market_name: markets.size === 1 ? first.market_name : null,
        days: Math.max(...list.map((l) => l.days)),
        price_changes: list.reduce((acc, l) => acc + l.price_changes, 0),
        avg: round(mean(list.map((l) => l.avg)), 4)!,
        min: Math.min(...list.map((l) => l.min)),
        max: Math.max(...list.map((l) => l.max)),
        range_pct: round(mean(list.map((l) => l.range_pct ?? 0)), 2),
        volatility_pct: round(mean(list.map((l) => l.volatility_pct)), 2)!,
        is_demo: list.some((l) => l.is_demo),
      };
    });
  }
  out.sort((x, y) => y.volatility_pct - x.volatility_pct || y.price_changes - x.price_changes);
  return out.slice(0, options.limit ?? 25);
}
