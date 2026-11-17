/** Executive overview: every figure is computed from stored records at request time — nothing is hardcoded. */
import type { AppContext } from '../../context.ts';
import type { SqlValue } from '../../db/sqlite.ts';
import { placeholders } from '../../db/sqlite.ts';
import {
  ageHoursSql, lastDays, loadListings, marketToday, round, STALE_HOURS_SQL, type DateRange,
} from './common.ts';
import { positioning, type Positioning } from './competitors.ts';
import { dailySeries } from './history.ts';
import { marketOverview, runStats, type MarketOverviewRow, type RunStats } from './markets.ts';
import { eventCountsByDay, priceEvents, type PriceEventRow } from './monitor.ts';
import { calendarFromDaily, listPromotions, type PromoCalendarDay, type PromotionRecord } from './promotions.ts';
import type { OverviewResult } from '../../../shared/api/analytics.ts';
export type { OverviewResult };

export function overview(ctx: AppContext, options: { days?: number; market_ids?: number[] } = {}): OverviewResult {
  const { db } = ctx;
  const days = Math.min(Math.max(options.days ?? 30, 1), 365);
  const today = marketToday(ctx);
  const period = lastDays(today, days);
  const marketIds = options.market_ids?.length ? options.market_ids : null;
  const filter = { market_ids: marketIds ?? undefined, date_from: period.from, date_to: period.to };

  const marketClause = (column: string): { sql: string; params: SqlValue[] } =>
    marketIds ? { sql: ` AND ${column} IN (${placeholders(marketIds.length)})`, params: marketIds } : { sql: '', params: [] };

  // ---- coverage ---------------------------------------------------------------------------------
  const liMarket = marketClause('li.market_id');
  const coverage = db.get<{
    listings_active: number; products_monitored: number; retailers_monitored: number; markets_with_data: number;
    listings_stale: number; listings_never_observed: number; products_missing_or_stale: number; latest_observation_at: string | null;
  }>(
    `SELECT COUNT(*) AS listings_active,
       COUNT(DISTINCT li.product_id) AS products_monitored,
       COUNT(DISTINCT li.retailer_id) AS retailers_monitored,
       COUNT(DISTINCT CASE WHEN s.last_observed_at IS NOT NULL THEN li.market_id END) AS markets_with_data,
       SUM(CASE WHEN s.last_observed_at IS NOT NULL AND ${ageHoursSql('s.last_observed_at')} > ${STALE_HOURS_SQL} THEN 1 ELSE 0 END) AS listings_stale,
       SUM(s.last_observed_at IS NULL) AS listings_never_observed,
       COUNT(DISTINCT CASE WHEN s.last_observed_at IS NULL OR ${ageHoursSql('s.last_observed_at')} > ${STALE_HOURS_SQL} THEN li.product_id END) AS products_missing_or_stale,
       MAX(s.last_observed_at) AS latest_observation_at
     FROM v_listing_info li LEFT JOIN listing_state s ON s.listing_id = li.listing_id
     WHERE li.listing_active = 1 AND li.retailer_active = 1 AND li.product_id IS NOT NULL${liMarket.sql}`,
    liMarket.params,
  )!;

  const productsTotal = marketIds
    ? (db.scalar<number>(
        `SELECT COUNT(*) FROM products p WHERE p.status <> 'archived' AND EXISTS (SELECT 1 FROM product_markets pm WHERE pm.product_id = p.id AND pm.market_id IN (${placeholders(marketIds.length)}))`,
        marketIds,
      ) ?? 0)
    : (db.scalar<number>(`SELECT COUNT(*) FROM products WHERE status <> 'archived'`) ?? 0);
  const rMarket = marketClause('market_id');
  const retailersTotal = db.scalar<number>(`SELECT COUNT(*) FROM retailers WHERE is_active = 1${rMarket.sql}`, rMarket.params) ?? 0;
  // Brands with at least one live product — within the selected markets when a market filter is set.
  const bMarket = marketClause('li.market_id');
  const brands = db.all<{ ownership: string; n: number }>(
    `SELECT b.ownership, COUNT(*) AS n FROM brands b
     WHERE b.is_active = 1 AND EXISTS (
       SELECT 1 FROM products p WHERE p.brand_id = b.id AND p.status <> 'archived'${
         marketIds?.length ? ` AND EXISTS (SELECT 1 FROM v_listing_info li WHERE li.product_id = p.id AND li.listing_active = 1${bMarket.sql})` : ''
       })
     GROUP BY b.ownership`,
    marketIds?.length ? bMarket.params : [],
  );
  const mMarket = marketClause('id');
  const marketsActive = db.scalar<number>(`SELECT COUNT(*) FROM markets WHERE is_active = 1${mMarket.sql}`, mMarket.params) ?? 0;

  // ---- ledger volume ----------------------------------------------------------------------------
  const oMarket = marketClause('o.market_id');
  const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const volume = db.get<{ total: number; last_24h: number | null; in_period: number | null; demo: number | null }>(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN o.observed_at >= ? THEN 1 ELSE 0 END) AS last_24h,
       SUM(CASE WHEN o.observed_local_date >= ? AND o.observed_local_date <= ? THEN 1 ELSE 0 END) AS in_period,
       SUM(o.is_demo) AS demo
     FROM v_observations o WHERE 1 = 1${oMarket.sql}`,
    [dayAgo, period.from, period.to, ...oMarket.params],
  )!;
  const provenance = db.all<{ data_class: string; observations: number; last_observed_at: string | null }>(
    `SELECT o.data_class, COUNT(*) AS observations, MAX(o.observed_at) AS last_observed_at
     FROM v_observations o WHERE 1 = 1${oMarket.sql} GROUP BY o.data_class ORDER BY observations DESC`,
    oMarket.params,
  );

  // ---- price movement ---------------------------------------------------------------------------
  const eventDays = eventCountsByDay(ctx, { ...filter, include_unmatched: true });
  const daily = dailySeries(ctx, filter);
  const listings = loadListings(ctx, daily.map((d) => d.listing_id));
  const firstPrice = new Map<number, number>();
  const indexDays = new Map<string, { own: number[]; competitor: number[] }>();
  for (const d of daily) {
    if (d.current_price === null) continue;
    const info = listings.get(d.listing_id);
    if (!info?.ownership) continue;
    // Regular-price based so temporary promotions do not distort the underlying trend less than they should:
    // the selling price is what shoppers pay, so the index follows the selling price.
    let base = firstPrice.get(d.listing_id);
    if (base === undefined) {
      base = d.current_price;
      firstPrice.set(d.listing_id, base);
    }
    if (!(base > 0)) continue;
    const day = indexDays.get(d.date) ?? { own: [], competitor: [] };
    day[info.ownership].push((d.current_price / base) * 100);
    indexDays.set(d.date, day);
  }
  const avg = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 2) : null);
  const eventByDate = new Map(eventDays.map((e) => [e.date, e]));
  const allDates = [...new Set([...indexDays.keys(), ...eventByDate.keys()])].sort();
  const priceMovement = allDates.map((date) => {
    const e = eventByDate.get(date);
    const idx = indexDays.get(date);
    return {
      date,
      increases: e?.increases ?? 0,
      decreases: e?.decreases ?? 0,
      avg_increase_pct: e?.avg_increase_pct ?? null,
      avg_decrease_pct: e?.avg_decrease_pct ?? null,
      own_index: idx ? avg(idx.own) : null,
      competitor_index: idx ? avg(idx.competitor) : null,
    };
  });
  const increases = eventDays.reduce((acc, e) => acc + e.increases, 0);
  const decreases = eventDays.reduce((acc, e) => acc + e.decreases, 0);

  // ---- promotions -------------------------------------------------------------------------------
  const current = listPromotions(ctx, { market_ids: marketIds ?? undefined }, { status: 'current', sort: '-discount' }, { page: 1, pageSize: 500, offset: 0 });
  const currentDiscounts = current.rows.map((p) => p.max_discount_pct).filter((v): v is number => v !== null);

  // ---- collection -------------------------------------------------------------------------------
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const jMarket = marketClause('r.market_id');
  const jobs = db.all<{ data_class: string; status: string; n: number }>(
    `SELECT j.data_class, j.status, COUNT(*) AS n FROM collection_jobs j JOIN retailers r ON r.id = j.retailer_id
     WHERE j.created_at >= ?${jMarket.sql} GROUP BY j.data_class, j.status`,
    [since, ...jMarket.params],
  );

  const markets = marketOverview(ctx, days).filter((m) => !marketIds || marketIds.includes(m.id));
  const total = volume.total;
  return {
    generated_at: new Date().toISOString(),
    today,
    period,
    period_days: days,
    market_ids: marketIds,
    kpis: {
      products_monitored: coverage.products_monitored,
      products_total: productsTotal,
      retailers_monitored: coverage.retailers_monitored,
      retailers_total: retailersTotal,
      brands_total: brands.reduce((acc, b) => acc + b.n, 0),
      brands_own: brands.find((b) => b.ownership === 'own')?.n ?? 0,
      brands_competitor: brands.find((b) => b.ownership === 'competitor')?.n ?? 0,
      markets_active: marketsActive,
      markets_with_data: coverage.markets_with_data,
      listings_active: coverage.listings_active,
      observations_total: total,
      observations_24h: volume.last_24h ?? 0,
      observations_period: volume.in_period ?? 0,
      latest_observation_at: coverage.latest_observation_at,
      price_increases: increases,
      price_decreases: decreases,
      active_promotions: current.total,
      active_promotion_products: new Set(current.rows.map((p) => p.product_id).filter(Boolean)).size,
      listings_stale: coverage.listings_stale ?? 0,
      listings_never_observed: coverage.listings_never_observed ?? 0,
      products_missing_or_stale: coverage.products_missing_or_stale,
      collection: {
        real: runStats(jobs.filter((j) => j.data_class === 'real')),
        simulated: runStats(jobs.filter((j) => j.data_class === 'simulated')),
      },
    },
    provenance: provenance.map((p) => ({ ...p, share_pct: total ? round((p.observations / total) * 100, 1)! : 0 })),
    demo: { observations: volume.demo ?? 0, share_pct: total ? round(((volume.demo ?? 0) / total) * 100, 1)! : 0, present: (volume.demo ?? 0) > 0 },
    price_movement: priceMovement,
    positioning: positioning(ctx, { market_ids: marketIds ?? undefined }),
    recent_changes: priceEvents(ctx, { market_ids: marketIds ?? undefined, date_from: period.from, date_to: period.to }, { limit: 15 }).rows,
    promotions: {
      current: current.rows.slice(0, 10),
      calendar: calendarFromDaily(daily, listings),
      own_current: current.rows.filter((p) => p.ownership === 'own').length,
      competitor_current: current.rows.filter((p) => p.ownership === 'competitor').length,
      avg_current_discount_pct: currentDiscounts.length ? round(currentDiscounts.reduce((a, b) => a + b, 0) / currentDiscounts.length, 1) : null,
    },
    markets,
  };
}
