/** Analytics API: overview, live monitor, price events, history, competitor, promotion and market intelligence. */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { badRequest } from '../lib/errors.ts';
import { idList, idParam, optBool, optNumber, paged, pagination, strList } from '../lib/http.ts';
import { addDays, isIsoDate } from '../lib/time.ts';
import { getSetting } from '../services/core.ts';
import { parseObsFilter } from '../services/obs-filter.ts';
import { lastDays, marketToday, previousRange, type DateRange } from '../services/analytics/common.ts';
import { compareProduct, latestPairs, ownProductPositions, positioning } from '../services/analytics/competitors.ts';
import { comparePeriods, GROUP_BYS, historySummary, METRICS, timeline, volatilityRanking, type GroupBy, type Metric } from '../services/analytics/history.ts';
import { crossMarketGroup, crossMarketProduct, marketOverview } from '../services/analytics/markets.ts';
import { eventBreakdown, monitor, priceEvents, type PriceEventRow } from '../services/analytics/monitor.ts';
import { overview } from '../services/analytics/overview.ts';
import { listPromotions, promotionCalendar, promotionSummary, promotionTimeline } from '../services/analytics/promotions.ts';
import { AVAILABILITY, DATA_CLASSES, PROMO_TYPES } from '../../shared/constants.ts';

type Query = Record<string, unknown>;

/** 'native' | 'reporting' | ISO code → resolved currency mode. */
function currencyParam(ctx: AppContext, value: unknown, fallback: 'native' | 'reporting' = 'native'): 'native' | string {
  const raw = typeof value === 'string' && value ? value : fallback;
  if (raw === 'native') return 'native';
  if (raw === 'reporting') return getSetting(ctx, 'reporting_currency');
  const code = raw.toUpperCase();
  if (!ctx.db.get('SELECT 1 FROM currencies WHERE code = ?', [code])) throw badRequest(`Unknown currency "${raw}"`);
  return code;
}

function daysParam(value: unknown, fallback: number, max = 365): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Period from explicit from/to, else the last `days` days. */
function periodParam(ctx: AppContext, query: Query, defaultDays: number): DateRange {
  const today = marketToday(ctx);
  const from = query.from;
  const to = query.to;
  if (from || to) {
    if (from && !isIsoDate(from)) throw badRequest('"from" must be a date in YYYY-MM-DD format');
    if (to && !isIsoDate(to)) throw badRequest('"to" must be a date in YYYY-MM-DD format');
    const end = (to as string | undefined) ?? today;
    const start = (from as string | undefined) ?? addDays(end, -(defaultDays - 1));
    if (start > end) throw badRequest('The start date is after the end date');
    return { from: start, to: end };
  }
  return lastDays(today, daysParam(query.days, defaultDays));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export default async function analyticsRoutes(app: FastifyInstance) {
  const { ctx } = app;

  /** Date helpers for the client so every screen uses the same "today" and presets. */
  app.get('/analytics/dates', async () => {
    const today = marketToday(ctx);
    const range = (days: number) => {
      const a = lastDays(today, days);
      return { a, b: previousRange(a) };
    };
    return {
      today,
      presets: {
        today_vs_yesterday: { a: { from: today, to: today }, b: { from: addDays(today, -1), to: addDays(today, -1) } },
        last_7_days: range(7),
        last_30_days: range(30),
        last_90_days: range(90),
      },
      reporting_currency: getSetting(ctx, 'reporting_currency'),
      first_observation_date: ctx.db.scalar<string>('SELECT MIN(observed_local_date) FROM v_observations') ?? null,
    };
  });

  app.get('/overview', async (req) => {
    const q = req.query as Query;
    return overview(ctx, { days: daysParam(q.days, 30, 180), market_ids: idList(q.market_id) });
  });

  // ---- live price monitor -----------------------------------------------------------------------
  app.get('/monitor', async (req) => {
    const q = req.query as Query;
    const page = pagination(q, 50, 500);
    const filter = parseObsFilter(q);
    const direction = q.direction === 'up' || q.direction === 'down' ? q.direction : undefined;
    const result = monitor(
      ctx,
      filter,
      {
        promo: filter.promo,
        availability: strList(q.availability)?.filter((a) => (AVAILABILITY as readonly string[]).includes(a)),
        dataClasses: strList(q.data_class)?.filter((c) => (DATA_CLASSES as readonly string[]).includes(c)),
        stale: optBool(q.stale),
        neverObserved: optBool(q.never_observed),
        changedWithinHours: optNumber(q.changed_within_hours, 'changed_within_hours'),
        direction,
        priceMin: filter.price_min,
        priceMax: filter.price_max,
        sort: typeof q.sort === 'string' ? q.sort : undefined,
      },
      page,
    );
    return { ...paged(result.rows, result.total, page), facets: result.facets };
  });

  app.get('/events', async (req) => {
    const q = req.query as Query;
    const page = pagination(q, 50, 500);
    const kinds = strList(q.kind)?.filter((k): k is PriceEventRow['kind'] =>
      ['price_change', 'availability_change', 'promo_start', 'promo_end'].includes(k),
    );
    const sinceHours = optNumber(q.since_hours, 'since_hours');
    const result = priceEvents(ctx, parseObsFilter(q), {
      kinds,
      direction: q.direction === 'up' || q.direction === 'down' ? q.direction : undefined,
      minAbsPct: optNumber(q.min_pct, 'min_pct'),
      since: sinceHours ? new Date(Date.now() - sinceHours * 3_600_000).toISOString() : undefined,
      sort: q.sort === 'largest' ? 'largest' : 'recent',
      limit: page.pageSize,
      offset: page.offset,
    });
    return paged(result.rows, result.total, page);
  });

  /** Price changes of a period counted per retailer, market, brand, category or product. */
  app.get('/events/summary', async (req) => {
    const q = req.query as Query;
    const filter = parseObsFilter(q);
    if (!filter.date_from && !filter.date_to) {
      const p = lastDays(marketToday(ctx), daysParam(q.days, 30));
      filter.date_from = p.from;
      filter.date_to = p.to;
    }
    return eventBreakdown(ctx, filter, oneOf(q.group_by, ['retailer', 'market', 'brand', 'category', 'product'] as const, 'retailer'));
  });

  // ---- historical price explorer ----------------------------------------------------------------
  app.get('/history/timeline', async (req) => {
    const q = req.query as Query;
    const filter = parseObsFilter(q);
    if (!filter.date_from && !filter.date_to) {
      const p = lastDays(marketToday(ctx), daysParam(q.days, 90));
      filter.date_from = p.from;
      filter.date_to = p.to;
    }
    return timeline(ctx, filter, {
      groupBy: oneOf<GroupBy>(q.group_by, GROUP_BYS, 'listing'),
      metric: oneOf<Metric>(q.metric, METRICS, 'price'),
      currency: currencyParam(ctx, q.currency),
      bucket: q.bucket === 'week' ? 'week' : 'day',
      maxSeries: Math.min(Math.max(Number(q.max_series ?? 30) || 30, 1), 100),
    });
  });

  app.get('/history/compare', async (req) => {
    const q = req.query as Query;
    const today = marketToday(ctx);
    let a: DateRange;
    let b: DateRange;
    const preset = typeof q.preset === 'string' ? q.preset : q.a_from ? 'custom' : 'last_30_days';
    if (preset === 'today_vs_yesterday') {
      a = { from: today, to: today };
      b = { from: addDays(today, -1), to: addDays(today, -1) };
    } else if (preset === 'last_7_days' || preset === 'last_30_days' || preset === 'last_90_days') {
      a = lastDays(today, preset === 'last_7_days' ? 7 : preset === 'last_30_days' ? 30 : 90);
      b = previousRange(a);
    } else if (preset === 'custom') {
      for (const key of ['a_from', 'a_to', 'b_from', 'b_to']) {
        if (!isIsoDate(q[key])) throw badRequest(`"${key}" must be a date in YYYY-MM-DD format`);
      }
      a = { from: q.a_from as string, to: q.a_to as string };
      b = { from: q.b_from as string, to: q.b_to as string };
      if (a.from > a.to || b.from > b.to) throw badRequest('A period starts after it ends');
    } else {
      throw badRequest('Unknown comparison preset');
    }
    return {
      preset,
      ...comparePeriods(ctx, parseObsFilter(q), a, b, {
        groupBy: oneOf<GroupBy>(q.group_by, GROUP_BYS, 'product'),
        metric: oneOf<Metric>(q.metric, METRICS, 'price'),
        currency: currencyParam(ctx, q.currency),
      }),
    };
  });

  app.get('/history/summary', async (req) => historySummary(ctx, parseObsFilter(req.query as Query)));

  app.get('/history/volatility', async (req) => {
    const q = req.query as Query;
    const filter = parseObsFilter(q);
    if (!filter.date_from && !filter.date_to) {
      const p = lastDays(marketToday(ctx), daysParam(q.days, 30));
      filter.date_from = p.from;
      filter.date_to = p.to;
    }
    return {
      period: { from: filter.date_from ?? null, to: filter.date_to ?? null },
      rows: volatilityRanking(ctx, filter, { groupBy: q.group_by === 'product' ? 'product' : 'listing', limit: Math.min(Number(q.limit ?? 25) || 25, 200) }),
    };
  });

  // ---- competitor intelligence ------------------------------------------------------------------
  const pairFilter = (q: Query) => ({
    market_ids: idList(q.market_id),
    retailer_ids: idList(q.retailer_id),
    own_brand_ids: idList(q.brand_id),
    category_ids: idList(q.category_id),
    own_product_ids: idList(q.product_id),
    includeSuggested: optBool(q.include_suggested) === true,
  });

  app.get('/competitors/overview', async (req) => {
    const filter = pairFilter(req.query as Query);
    return { products: ownProductPositions(ctx, filter), positioning: positioning(ctx, filter) };
  });

  app.get('/competitors/pairs', async (req) => ({ rows: latestPairs(ctx, pairFilter(req.query as Query)) }));

  app.get('/competitors/compare', async (req) => {
    const q = req.query as Query;
    return compareProduct(ctx, idParam(q.product_id, 'product_id'), {
      market_ids: idList(q.market_id),
      retailer_ids: idList(q.retailer_id),
      days: daysParam(q.days, 30),
      currency: currencyParam(ctx, q.currency),
      includeSuggested: optBool(q.include_suggested) === true,
    });
  });

  // ---- promotion intelligence -------------------------------------------------------------------
  app.get('/promotions/summary', async (req) => {
    const q = req.query as Query;
    const period = periodParam(ctx, q, 30);
    const filter = parseObsFilter({ ...q, from: undefined, to: undefined });
    return promotionSummary(ctx, filter, period);
  });

  app.get('/promotions', async (req) => {
    const q = req.query as Query;
    const page = pagination(q, 50, 500);
    const status = q.status === 'active' || q.status === 'ended' || q.status === 'current' ? q.status : undefined;
    const result = listPromotions(
      ctx,
      parseObsFilter(q),
      {
        status,
        types: strList(q.type)?.filter((t) => (PROMO_TYPES as readonly string[]).includes(t)),
        minDiscount: optNumber(q.min_discount, 'min_discount'),
        sort: typeof q.sort === 'string' ? q.sort : undefined,
      },
      page,
    );
    return paged(result.rows, result.total, page);
  });

  app.get('/promotions/timeline', async (req) => {
    const q = req.query as Query;
    const period = periodParam(ctx, q, 60);
    const filter = parseObsFilter({ ...q, from: undefined, to: undefined });
    return promotionTimeline(ctx, filter, period, oneOf(q.group_by, ['brand', 'product', 'retailer'] as const, 'brand'));
  });

  app.get('/promotions/calendar', async (req) => {
    const q = req.query as Query;
    const period = periodParam(ctx, q, 60);
    const filter = parseObsFilter({ ...q, from: undefined, to: undefined });
    return { period, days: promotionCalendar(ctx, filter, period) };
  });

  // ---- market intelligence ----------------------------------------------------------------------
  app.get('/market-intel/overview', async (req) => ({ markets: marketOverview(ctx, daysParam((req.query as Query).days, 30)) }));

  app.get('/market-intel/cross-market', async (req) => {
    const q = req.query as Query;
    const currency = currencyParam(ctx, q.currency, 'reporting');
    if (currency === 'native') throw badRequest('Cross-market comparison needs a comparison currency');
    if (q.product_id) {
      return {
        mode: 'product' as const,
        ...crossMarketProduct(ctx, idParam(q.product_id, 'product_id'), {
          currency,
          days: daysParam(q.days, 30),
          baseMarketId: q.base_market_id ? idParam(q.base_market_id, 'base_market_id') : undefined,
        }),
      };
    }
    const categoryIds = idList(q.category_id);
    const brandIds = idList(q.brand_id);
    if (!categoryIds && !brandIds) throw badRequest('Choose a product, a category or a brand to compare across markets');
    return { mode: 'group' as const, ...crossMarketGroup(ctx, { category_ids: categoryIds, brand_ids: brandIds }, currency) };
  });
}
