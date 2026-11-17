/**
 * Promotion intelligence. Works from promotion episodes (runs of consecutive promotional observations of a
 * listing, maintained in the `promotions` table) and from the daily price series.
 *
 * Everything is observation-based: "promotional days" are days on which a promotion was actually observed,
 * and a promotion is only called "current" while its listing is still being observed.
 */
import type { AppContext } from '../../context.ts';
import type { SqlValue } from '../../db/sqlite.ts';
import { placeholders } from '../../db/sqlite.ts';
import type { Page } from '../../lib/http.ts';
import { orderBy } from '../../lib/http.ts';
import { diffDays } from '../../lib/time.ts';
import { listingConditions, OBS_FROM, obsWhere, type ObsFilter } from '../obs-filter.ts';
import { ageHoursSql, demoNote, loadListings, mean, round, STALE_HOURS_SQL, type DateRange, type DemoNote, type ListingInfo } from './common.ts';
import { dailySeries, type DailyRow } from './history.ts';
import type { PromotionRecord, PromoBreakdown, PromotionSummary, PromoTimelineRow, PromoCalendarDay } from '../../../shared/api/analytics.ts';
import { PROMO_TYPE_LABELS, type PromoType } from '../../../shared/constants.ts';
export type { PromotionRecord, PromoBreakdown, PromotionSummary, PromoTimelineRow, PromoCalendarDay };

export interface PromotionOptions {
  status?: 'active' | 'ended' | 'current';
  types?: string[];
  minDiscount?: number;
  sort?: string;
}

const PROMO_SELECT = `
  pr.id, pr.listing_id, pr.promo_type, pr.description, pr.status,
  (CASE WHEN pr.status = 'active' AND ${ageHoursSql('pr.last_seen_at')} <= ${STALE_HOURS_SQL} THEN 1 ELSE 0 END) AS is_current,
  pr.end_reason, pr.started_at, pr.last_seen_at, pr.ended_at, pr.start_local_date, pr.end_local_date, pr.duration_days,
  pr.promo_days_observed, pr.observation_count, pr.currency_code, pr.regular_price, pr.min_promo_price, pr.max_discount_pct,
  pr.avg_discount_pct, pr.stated_start, pr.stated_end, pr.is_demo,
  li.product_id, li.product_name, li.brand_id, li.brand_name, li.ownership, li.category_name, li.subcategory_name,
  li.variant_name, li.pack_size, li.pack_unit, li.units_per_pack, li.retailer_id, li.retailer_name, li.market_id, li.market_code, li.market_name, li.timezone`;
const PROMO_FROM = `FROM promotions pr JOIN v_listing_info li ON li.listing_id = pr.listing_id`;

const PROMO_SORTS: Record<string, string> = {
  started: 'pr.started_at',
  discount: 'pr.max_discount_pct',
  duration: 'pr.duration_days',
  product: 'li.product_name COLLATE NOCASE',
  retailer: 'li.retailer_name COLLATE NOCASE',
  brand: 'li.brand_name COLLATE NOCASE',
};

function promoWhere(filter: ObsFilter, options: PromotionOptions): { sql: string; params: SqlValue[] } {
  const { conditions, params } = listingConditions(filter);
  // a promotion is in range when it overlaps the range
  if (filter.date_to) {
    conditions.push('pr.start_local_date <= ?');
    params.push(filter.date_to);
  }
  if (filter.date_from) {
    conditions.push('pr.end_local_date >= ?');
    params.push(filter.date_from);
  }
  if (options.status === 'active' || options.status === 'ended') {
    conditions.push('pr.status = ?');
    params.push(options.status);
  } else if (options.status === 'current') {
    conditions.push(`pr.status = 'active' AND ${ageHoursSql('pr.last_seen_at')} <= ${STALE_HOURS_SQL}`);
  }
  if (options.types?.length) {
    conditions.push(`pr.promo_type IN (${placeholders(options.types.length)})`);
    params.push(...options.types);
  }
  if (options.minDiscount !== undefined) {
    conditions.push('pr.max_discount_pct >= ?');
    params.push(options.minDiscount);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : 'WHERE 1 = 1', params };
}

export function listPromotions(ctx: AppContext, filter: ObsFilter, options: PromotionOptions, page: Page): { rows: PromotionRecord[]; total: number } {
  const where = promoWhere(filter, options);
  const total = ctx.db.scalar<number>(`SELECT COUNT(*) ${PROMO_FROM} ${where.sql}`, where.params) ?? 0;
  const rows = ctx.db.all<PromotionRecord>(
    `SELECT ${PROMO_SELECT} ${PROMO_FROM} ${where.sql}
     ORDER BY ${orderBy(options.sort, PROMO_SORTS, 'pr.started_at DESC')} NULLS LAST, pr.id DESC LIMIT ? OFFSET ?`,
    [...where.params, page.pageSize, page.offset],
  );
  return { rows, total };
}

export interface PromotionCounts {
  total: number;
  own: number;
  competitor: number;
  /** Distinct catalogue products with a matching promotion. */
  products: number;
  /** Average of the deepest discount of each promotion, in % (promotions without a discount figure are left out). */
  avg_max_discount_pct: number | null;
}

/** Counts over every promotion that matches the filter — never over one page of them. */
export function promotionCounts(ctx: AppContext, filter: ObsFilter, options: PromotionOptions): PromotionCounts {
  const where = promoWhere(filter, options);
  const row = ctx.db.get<{ total: number; own: number | null; competitor: number | null; products: number; avg: number | null }>(
    `SELECT COUNT(*) AS total, SUM(li.ownership = 'own') AS own, SUM(li.ownership = 'competitor') AS competitor,
       COUNT(DISTINCT li.product_id) AS products, AVG(pr.max_discount_pct) AS avg
     ${PROMO_FROM} ${where.sql}`,
    where.params,
  )!;
  return { total: row.total, own: row.own ?? 0, competitor: row.competitor ?? 0, products: row.products, avg_max_discount_pct: round(row.avg, 1) };
}

export function promotionSummary(ctx: AppContext, filter: ObsFilter, period: DateRange): PromotionSummary {
  const scoped: ObsFilter = { ...filter, date_from: period.from, date_to: period.to };
  const where = promoWhere(scoped, {});
  const episodes = ctx.db.all<PromotionRecord>(`SELECT ${PROMO_SELECT} ${PROMO_FROM} ${where.sql} ORDER BY pr.started_at`, where.params);
  const daily = dailySeries(ctx, scoped);
  const listings = loadListings(ctx, daily.map((d) => d.listing_id));

  const obsWhereClause = obsWhere(scoped);
  const raw = ctx.db.get<{ n: number; promo: number | null }>(`SELECT COUNT(*) AS n, SUM(o.is_promo) AS promo ${OBS_FROM} ${obsWhereClause.sql}`, obsWhereClause.params)!;

  // listing-days observed / on promotion, per dimension
  interface DayAcc {
    total: number;
    promo: number;
  }
  const dayTotals: DayAcc = { total: 0, promo: 0 };
  const byBrandDays = new Map<string, DayAcc>();
  const byRetailerDays = new Map<string, DayAcc>();
  const byOwnershipDays = new Map<string, DayAcc>();
  const promoDates = new Set<string>();
  const observedListings = new Set<number>();
  const bump = (map: Map<string, DayAcc>, key: string, promo: boolean) => {
    const acc = map.get(key) ?? { total: 0, promo: 0 };
    acc.total += 1;
    if (promo) acc.promo += 1;
    map.set(key, acc);
  };
  for (const d of daily) {
    const info = listings.get(d.listing_id);
    if (!info) continue;
    observedListings.add(d.listing_id);
    const promo = d.is_promo === 1;
    dayTotals.total += 1;
    if (promo) {
      dayTotals.promo += 1;
      promoDates.add(d.date);
    }
    bump(byBrandDays, `B${info.brand_id ?? 0}`, promo);
    bump(byRetailerDays, `R${info.retailer_id}`, promo);
    bump(byOwnershipDays, info.ownership ?? 'none', promo);
  }

  const breakdown = (
    keyOf: (e: PromotionRecord) => [string, string, ('own' | 'competitor' | null)?],
    days?: Map<string, DayAcc>,
  ): PromoBreakdown[] => {
    const groups = new Map<string, { label: string; ownership?: 'own' | 'competitor' | null; list: PromotionRecord[] }>();
    for (const e of episodes) {
      const [key, label, ownership] = keyOf(e);
      const g = groups.get(key);
      if (g) g.list.push(e);
      else groups.set(key, { label, ownership, list: [e] });
    }
    return [...groups.entries()]
      .map(([key, g]) => {
        const discounts = g.list.map((e) => e.max_discount_pct).filter((v): v is number => v !== null);
        const d = days?.get(key);
        return {
          key,
          label: g.label,
          ownership: g.ownership,
          episodes: g.list.length,
          current: g.list.filter((e) => e.is_current === 1).length,
          avg_discount_pct: round(mean(discounts), 1),
          max_discount_pct: discounts.length ? Math.max(...discounts) : null,
          avg_duration_days: round(mean(g.list.map((e) => e.duration_days)), 1),
          promo_day_share_pct: d && d.total ? round((d.promo / d.total) * 100, 1) : null,
          promo_listing_days: d?.promo ?? g.list.reduce((acc, e) => acc + e.promo_days_observed, 0),
        };
      })
      .sort((a, b) => b.episodes - a.episodes || a.label.localeCompare(b.label));
  };

  // time between promotions: previous episode of the same listing (from any date) → episode starting in the period
  const listingIds = [...new Set(episodes.map((e) => e.listing_id))];
  const gaps: number[] = [];
  for (let i = 0; i < listingIds.length; i += 400) {
    const chunk = listingIds.slice(i, i + 400);
    const all = ctx.db.all<{ listing_id: number; start_local_date: string; end_local_date: string }>(
      `SELECT listing_id, start_local_date, end_local_date FROM promotions WHERE listing_id IN (${placeholders(chunk.length)}) ORDER BY listing_id, start_local_date`,
      chunk,
    );
    for (let j = 1; j < all.length; j++) {
      const prev = all[j - 1]!;
      const next = all[j]!;
      if (prev.listing_id !== next.listing_id) continue;
      if (next.start_local_date < period.from || next.start_local_date > period.to) continue;
      gaps.push(Math.max(0, diffDays(prev.end_local_date, next.start_local_date)));
    }
  }

  const discounts = episodes.map((e) => e.max_discount_pct).filter((v): v is number => v !== null);
  const top = [...episodes].filter((e) => e.max_discount_pct !== null).sort((a, b) => b.max_discount_pct! - a.max_discount_pct! || (a.started_at < b.started_at ? 1 : -1));
  const startedInPeriod = episodes.filter((e) => e.start_local_date >= period.from && e.start_local_date <= period.to).length;
  const periodDays = diffDays(period.from, period.to) + 1;
  const best = top[0] ?? null;

  return {
    period,
    kpis: {
      episodes: episodes.length,
      current: episodes.filter((e) => e.is_current === 1).length,
      listings_with_promo: listingIds.length,
      listings_observed: observedListings.size,
      avg_discount_pct: round(mean(discounts), 1),
      highest_discount_pct: best?.max_discount_pct ?? null,
      highest_discount: best
        ? { product_name: best.product_name, retailer_name: best.retailer_name, market_name: best.market_name, started_at: best.started_at, promo_type: best.promo_type }
        : null,
      promo_calendar_days: promoDates.size,
      promo_listing_days: dayTotals.promo,
      observed_listing_days: dayTotals.total,
      promo_day_share_pct: dayTotals.total ? round((dayTotals.promo / dayTotals.total) * 100, 1) : null,
      promo_observation_share_pct: raw.n ? round(((raw.promo ?? 0) / raw.n) * 100, 1) : null,
      observations: raw.n,
      avg_duration_days: round(mean(episodes.map((e) => e.duration_days)), 1),
      frequency_per_listing_30d: observedListings.size && periodDays > 0 ? round((startedInPeriod / observedListings.size) * (30 / periodDays), 2) : null,
      avg_days_between: round(mean(gaps), 1),
    },
    by_type: breakdown((e) => [e.promo_type, PROMO_TYPE_LABELS[e.promo_type as PromoType] ?? e.promo_type]),
    by_ownership: breakdown((e) => [e.ownership ?? 'none', e.ownership === 'own' ? 'Own brands' : e.ownership === 'competitor' ? 'Competitors' : 'Unmatched', e.ownership], byOwnershipDays),
    by_brand: breakdown((e) => [`B${e.brand_id ?? 0}`, e.brand_name ?? 'Unmatched', e.ownership], byBrandDays),
    by_retailer: breakdown((e) => [`R${e.retailer_id}`, `${e.retailer_name} (${e.market_code})`], byRetailerDays),
    top_discounts: top.slice(0, 10),
    demo: demoNote(episodes),
  };
}

/** Promotion episodes laid out per brand, product or retailer for a Gantt-style timeline. */
export function promotionTimeline(
  ctx: AppContext,
  filter: ObsFilter,
  period: DateRange,
  groupBy: 'brand' | 'product' | 'retailer' = 'brand',
  maxRows = 40,
): { period: DateRange; group_by: string; rows: PromoTimelineRow[]; truncated: boolean; total_rows: number; demo: DemoNote } {
  const where = promoWhere({ ...filter, date_from: period.from, date_to: period.to }, {});
  const episodes = ctx.db.all<PromotionRecord>(`SELECT ${PROMO_SELECT} ${PROMO_FROM} ${where.sql} ORDER BY pr.started_at`, where.params);
  const groups = new Map<string, PromoTimelineRow>();
  for (const e of episodes) {
    const [key, label, sublabel] =
      groupBy === 'brand'
        ? [`B${e.brand_id ?? 0}`, e.brand_name ?? 'Unmatched', e.ownership === 'own' ? 'Own brand' : e.ownership === 'competitor' ? 'Competitor' : null]
        : groupBy === 'product'
          ? [`P${e.product_id ?? `l${e.listing_id}`}`, e.product_name ?? 'Unmatched listing', e.brand_name]
          : [`R${e.retailer_id}`, e.retailer_name, e.market_name];
    let row = groups.get(key);
    if (!row) {
      row = { key, label, sublabel, ownership: groupBy === 'retailer' ? null : e.ownership, episodes: [] };
      groups.set(key, row);
    }
    row.episodes.push({
      id: e.id,
      start: e.start_local_date < period.from ? period.from : e.start_local_date,
      end: e.end_local_date > period.to ? period.to : e.end_local_date,
      promo_type: e.promo_type,
      max_discount_pct: e.max_discount_pct,
      status: e.status,
      is_current: e.is_current,
      product_name: e.product_name,
      retailer_name: e.retailer_name,
      market_code: e.market_code,
      description: e.description,
      is_demo: e.is_demo,
    });
  }
  const rows = [...groups.values()].sort(
    (a, b) => (a.ownership === b.ownership ? 0 : a.ownership === 'own' ? -1 : 1) || b.episodes.length - a.episodes.length || a.label.localeCompare(b.label),
  );
  return { period, group_by: groupBy, rows: rows.slice(0, maxRows), truncated: rows.length > maxRows, total_rows: rows.length, demo: demoNote(episodes) };
}

/** Daily promotional intensity from an already loaded daily series (own vs competitors). */
export function calendarFromDaily(daily: DailyRow[], listings: Map<number, ListingInfo>): PromoCalendarDay[] {
  const days = new Map<string, { ownP: number; ownT: number; compP: number; compT: number; discSum: number; discN: number }>();
  for (const d of daily) {
    const info = listings.get(d.listing_id);
    if (!info || !info.ownership) continue;
    const acc = days.get(d.date) ?? { ownP: 0, ownT: 0, compP: 0, compT: 0, discSum: 0, discN: 0 };
    if (info.ownership === 'own') {
      acc.ownT++;
      if (d.is_promo) acc.ownP++;
    } else {
      acc.compT++;
      if (d.is_promo) acc.compP++;
    }
    if (d.is_promo && d.discount_pct !== null) {
      acc.discSum += d.discount_pct;
      acc.discN++;
    }
    days.set(d.date, acc);
  }
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, a]) => ({
      date,
      own_on_promo: a.ownP,
      own_observed: a.ownT,
      competitor_on_promo: a.compP,
      competitor_observed: a.compT,
      own_share_pct: a.ownT ? round((a.ownP / a.ownT) * 100, 1) : null,
      competitor_share_pct: a.compT ? round((a.compP / a.compT) * 100, 1) : null,
      avg_discount_pct: a.discN ? round(a.discSum / a.discN, 1) : null,
    }));
}

/** Daily promotional intensity: how many observed listings were on promotion, own vs competitors. */
export function promotionCalendar(ctx: AppContext, filter: ObsFilter, period: DateRange): PromoCalendarDay[] {
  const daily = dailySeries(ctx, { ...filter, date_from: period.from, date_to: period.to });
  return calendarFromDaily(daily, loadListings(ctx, daily.map((d) => d.listing_id)));
}
