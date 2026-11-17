/**
 * Reports. Each report is a composition of the analytics services over a period and scope, returned as
 * summary figures plus sections (chart and/or table). The same structure feeds the on-screen report and the
 * CSV / Excel exports, so an export always contains exactly what was shown.
 */
import type { AppContext, AuthUser } from '../context.ts';
import { placeholders } from '../db/sqlite.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { idList } from '../lib/http.ts';
import { addDays, isIsoDate, nowIso } from '../lib/time.ts';
import type { Conversion, DateRange, DemoNote } from '../../shared/api/analytics.ts';
import type { ReportColumn, ReportDefinition, ReportResult, ReportRun, ReportSection, ReportTable, ReportType } from '../../shared/api/reports.ts';
import { DATA_CLASS_LABELS, PROMO_TYPE_LABELS, type DataClass, type PromoType } from '../../shared/constants.ts';
import { csvCell, toCsv } from '../lib/tabular.ts';
import { buildXlsx, provenanceSheet, type ColumnSpec, type SheetSpec } from './export.ts';
import { getSetting } from './core.ts';
import type { ObsFilter } from './obs-filter.ts';
import { lastDays, marketToday, mean, packLabel, previousRange, round } from './analytics/common.ts';
import { compareProduct, latestPairs, positioning, positioningHistory } from './analytics/competitors.ts';
import { comparePeriods, timeline } from './analytics/history.ts';
import { marketOverview } from './analytics/markets.ts';
import { eventCountsByDay, monitorRowsFor, priceEvents } from './analytics/monitor.ts';
import { overview } from './analytics/overview.ts';
import { listPromotions, promotionCalendar, promotionSummary } from './analytics/promotions.ts';

export const REPORT_DEFINITIONS: ReportDefinition[] = [
  {
    type: 'weekly_competitor_pricing',
    title: 'Weekly competitor pricing report',
    description: 'Competitor and own price changes during the week, current price positioning and the competitor promotions now running.',
    default_days: 7,
    params: ['period', 'market', 'retailer', 'category'],
    required: [],
  },
  {
    type: 'monthly_market_pricing',
    title: 'Monthly market pricing report',
    description: 'Price movement, promotional intensity, positioning and data coverage for each market, with the largest movers of the month.',
    default_days: 30,
    params: ['period', 'market', 'category'],
    required: [],
  },
  {
    type: 'brand_report',
    title: 'Brand report',
    description: 'One brand: current prices by product and market, change against the previous period, promotions and position against the other side.',
    default_days: 30,
    params: ['brand', 'period', 'market', 'retailer', 'currency'],
    required: ['brand'],
  },
  {
    type: 'product_report',
    title: 'Product report',
    description: 'One product: current prices at every retailer, price history, promotions, price changes and the comparison with mapped competitors.',
    default_days: 90,
    params: ['product', 'period', 'market', 'retailer', 'currency'],
    required: ['product'],
  },
  {
    type: 'promotion_analysis',
    title: 'Promotion analysis',
    description: 'Discount depth, duration and frequency of promotions by brand, retailer and type, with promotional intensity over time.',
    default_days: 30,
    params: ['period', 'market', 'retailer', 'brand', 'category'],
    required: [],
  },
  {
    type: 'competitor_price_movement',
    title: 'Competitor price movement report',
    description: 'How competitor prices moved: every change, movement by brand, period-on-period averages and the own products affected.',
    default_days: 30,
    params: ['period', 'market', 'retailer', 'brand', 'category'],
    required: [],
  },
];

export interface ReportParams {
  period: DateRange;
  market_ids?: number[];
  retailer_ids?: number[];
  brand_ids?: number[];
  category_ids?: number[];
  product_id?: number;
  currency: string;
}

/** Parses report parameters from a query / body object (ids may be comma-separated strings). */
export function parseReportParams(ctx: AppContext, type: ReportType, raw: Record<string, unknown>): ReportParams {
  const def = REPORT_DEFINITIONS.find((d) => d.type === type);
  if (!def) throw badRequest('Unknown report type');
  const today = marketToday(ctx);
  let period: DateRange;
  if (raw.from || raw.to) {
    if (raw.from && !isIsoDate(raw.from)) throw badRequest('"from" must be a date in YYYY-MM-DD format');
    if (raw.to && !isIsoDate(raw.to)) throw badRequest('"to" must be a date in YYYY-MM-DD format');
    const to = (raw.to as string | undefined) ?? today;
    const from = (raw.from as string | undefined) ?? addDays(to, -(def.default_days - 1));
    if (from > to) throw badRequest('The start date is after the end date');
    period = { from, to };
  } else {
    const days = Math.min(Math.max(Number(raw.days ?? def.default_days) || def.default_days, 1), 366);
    period = lastDays(today, days);
  }
  const productIds = idList(raw.product_id);
  const params: ReportParams = {
    period,
    market_ids: idList(raw.market_id),
    retailer_ids: idList(raw.retailer_id),
    brand_ids: idList(raw.brand_id),
    category_ids: idList(raw.category_id),
    product_id: productIds?.[0],
    currency: getSetting(ctx, 'reporting_currency'),
  };
  if (typeof raw.currency === 'string' && raw.currency && raw.currency !== 'reporting') {
    const code = raw.currency.toUpperCase();
    if (!ctx.db.get('SELECT 1 FROM currencies WHERE code = ?', [code])) throw badRequest(`Unknown currency "${raw.currency}"`);
    params.currency = code;
  }
  if (def.required.includes('brand') && !params.brand_ids?.length) throw new AppError(422, 'validation_failed', 'Choose a brand for this report');
  if (def.required.includes('product') && !params.product_id) throw new AppError(422, 'validation_failed', 'Choose a product for this report');
  return params;
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
const col = (key: string, label: string, type: ReportColumn['type'] = 'text', currency_key?: string): ReportColumn => ({ key, label, type, ...(currency_key ? { currency_key } : {}) });
const fmtDate = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`;
};
const pctText = (v: number | null | undefined, signed = false) => (v === null || v === undefined ? 'n/a' : `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}${Math.abs(v).toFixed(1)}%`);
const count = (n: number) => n.toLocaleString('en-GB');

function names(ctx: AppContext, table: 'markets' | 'retailers' | 'brands' | 'categories', ids: number[] | undefined): string[] {
  if (!ids?.length) return [];
  return ctx.db.all<{ name: string }>(`SELECT name FROM ${table} WHERE id IN (${placeholders(ids.length)}) ORDER BY name`, ids).map((r) => r.name);
}

function scopeLines(ctx: AppContext, params: ReportParams, extra: string[] = []): string[] {
  const lines = [...extra];
  const add = (label: string, list: string[]) => list.length && lines.push(`${label}: ${list.join(', ')}`);
  add('Markets', names(ctx, 'markets', params.market_ids));
  add('Retailers', names(ctx, 'retailers', params.retailer_ids));
  add('Brands', names(ctx, 'brands', params.brand_ids));
  add('Categories', names(ctx, 'categories', params.category_ids));
  if (!lines.length) lines.push('All monitored markets, retailers and brands');
  return lines;
}

function baseFilter(params: ReportParams, extra: Partial<ObsFilter> = {}): ObsFilter {
  return {
    market_ids: params.market_ids,
    retailer_ids: params.retailer_ids,
    brand_ids: params.brand_ids,
    category_ids: params.category_ids,
    ...extra,
  };
}

function mergeDemo(...notes: Array<DemoNote | null | undefined>): DemoNote {
  let demo = 0;
  let total = 0;
  for (const n of notes) {
    if (!n) continue;
    demo += n.demo_rows;
    total += n.total_rows;
  }
  return { demo_rows: demo, total_rows: total, any_demo: demo > 0, all_demo: total > 0 && demo === total };
}

const EVENT_COLUMNS: ReportColumn[] = [
  col('date', 'Date', 'date'),
  col('product', 'Product'),
  col('pack', 'Pack'),
  col('brand', 'Brand'),
  col('retailer', 'Retailer'),
  col('market', 'Market'),
  col('currency', 'Currency'),
  col('old_price', 'Previous price', 'money', 'currency'),
  col('new_price', 'New price', 'money', 'currency'),
  col('change_pct', 'Change', 'signed_percent'),
  col('promo', 'Promotion'),
  col('source', 'Data source'),
];

function eventTable(ctx: AppContext, filter: ObsFilter, limit = 300): { table: ReportTable; total: number; ups: number; downs: number; demo: DemoNote; rows: ReturnType<typeof priceEvents>['rows'] } {
  const { rows, total } = priceEvents(ctx, filter, { limit, sort: 'largest' });
  const demoRows = rows.filter((r) => r.is_demo).length;
  return {
    total,
    ups: rows.filter((r) => r.direction === 'up').length,
    downs: rows.filter((r) => r.direction === 'down').length,
    rows,
    demo: { demo_rows: demoRows, total_rows: rows.length, any_demo: demoRows > 0, all_demo: rows.length > 0 && demoRows === rows.length },
    table: {
      columns: EVENT_COLUMNS,
      rows: rows.map((r) => ({
        date: r.occurred_local_date,
        product: r.product_name,
        pack: r.variant_name ?? packLabel(r),
        brand: r.brand_name,
        retailer: r.retailer_name,
        market: r.market_name,
        currency: r.currency_code,
        old_price: r.old_price,
        new_price: r.new_price,
        change_pct: r.change_pct,
        promo: r.is_promo ? 'Promotion started' : '',
        source: (DATA_CLASS_LABELS[r.data_class as DataClass] ?? r.data_class) + (r.is_demo ? ' (DEMO)' : ''),
      })),
      note: total > rows.length ? `Showing the ${rows.length} largest of ${count(total)} changes.` : null,
    },
  };
}

function brandMovement(rows: ReturnType<typeof priceEvents>['rows']): ReportTable {
  const groups = new Map<string, { ups: number[]; downs: number[] }>();
  for (const r of rows) {
    const key = r.brand_name ?? 'Unmatched';
    const g = groups.get(key) ?? { ups: [], downs: [] };
    if (r.direction === 'up') g.ups.push(r.change_pct ?? 0);
    else if (r.direction === 'down') g.downs.push(r.change_pct ?? 0);
    groups.set(key, g);
  }
  return {
    columns: [col('brand', 'Brand'), col('increases', 'Increases', 'integer'), col('avg_increase', 'Average increase', 'signed_percent'), col('decreases', 'Decreases', 'integer'), col('avg_decrease', 'Average decrease', 'signed_percent'), col('net', 'Net changes (up − down)', 'integer')],
    rows: [...groups.entries()]
      .map(([brand, g]) => ({ brand, increases: g.ups.length, avg_increase: round(mean(g.ups), 1), decreases: g.downs.length, avg_decrease: round(mean(g.downs), 1), net: g.ups.length - g.downs.length }))
      .sort((a, b) => b.increases + b.decreases - (a.increases + a.decreases)),
  };
}

function positioningSection(ctx: AppContext, params: ReportParams, historyDays: number, extra: { own_brand_ids?: number[]; own_product_ids?: number[] } = {}): { section: ReportSection; index: number | null; pairs: number; demo: DemoNote } {
  const pairFilter = { market_ids: params.market_ids, retailer_ids: params.retailer_ids, category_ids: params.category_ids, ...extra };
  const now = positioning(ctx, pairFilter);
  const history = positioningHistory(ctx, pairFilter, { from: addDays(params.period.to, -(historyDays - 1)), to: params.period.to });
  return {
    index: now.overall.index,
    pairs: now.overall.pairs,
    demo: now.demo,
    section: {
      id: 'positioning',
      title: 'Price positioning against mapped competitors',
      description: 'Index of own price to competitor price at the same retailer (100 = parity; above 100 = own products are more expensive). Unit prices are used where pack sizes differ.',
      chart: history.length > 1 ? { kind: 'line', unit: 'index', reference: { value: 100, label: 'Parity' }, series: [{ key: 'index', label: 'Own vs competitors', role: 'own', points: history.map((h) => ({ date: h.date, value: h.index })) }] } : null,
      table: {
        columns: [col('group', 'Group'), col('name', 'Name'), col('index', 'Index', 'index'), col('premium_pct', 'Own vs competitors', 'signed_percent'), col('pairs', 'Price pairs', 'integer'), col('cheaper', 'Own cheaper', 'integer'), col('dearer', 'Own dearer', 'integer')],
        rows: [
          { group: 'Overall', name: 'All mapped pairs', index: now.overall.index, premium_pct: now.overall.premium_pct, pairs: now.overall.pairs, cheaper: now.overall.cheaper_pairs, dearer: now.overall.dearer_pairs },
          ...now.by_brand.map((g) => ({ group: 'Own brand', name: g.label, index: g.index, premium_pct: g.premium_pct, pairs: g.pairs, cheaper: g.cheaper_pairs, dearer: g.dearer_pairs })),
          ...now.by_category.map((g) => ({ group: 'Category', name: g.label, index: g.index, premium_pct: g.premium_pct, pairs: g.pairs, cheaper: g.cheaper_pairs, dearer: g.dearer_pairs })),
          ...now.by_market.map((g) => ({ group: 'Market', name: g.label, index: g.index, premium_pct: g.premium_pct, pairs: g.pairs, cheaper: g.cheaper_pairs, dearer: g.dearer_pairs })),
        ],
      },
      notes: now.not_comparable_pairs ? [`${now.not_comparable_pairs} mapped pairs measured in different units are excluded.`] : [],
    },
  };
}

const PROMO_COLUMNS: ReportColumn[] = [
  col('product', 'Product'),
  col('pack', 'Pack'),
  col('brand', 'Brand'),
  col('ownership', 'Own / competitor'),
  col('retailer', 'Retailer'),
  col('market', 'Market'),
  col('type', 'Type'),
  col('description', 'Offer'),
  col('currency', 'Currency'),
  col('regular_price', 'Regular price', 'money', 'currency'),
  col('promo_price', 'Promotional price', 'money', 'currency'),
  col('discount', 'Highest discount', 'percent'),
  col('start', 'Started', 'date'),
  col('end', 'Last seen', 'date'),
  col('days', 'Days', 'integer'),
  col('status', 'Status'),
];
function promoRows(rows: ReturnType<typeof listPromotions>['rows']): ReportTable['rows'] {
  return rows.map((p) => ({
    product: p.product_name,
    pack: p.variant_name ?? packLabel(p),
    brand: p.brand_name,
    ownership: p.ownership === 'own' ? 'Own' : p.ownership === 'competitor' ? 'Competitor' : '',
    retailer: p.retailer_name,
    market: p.market_name,
    type: PROMO_TYPE_LABELS[p.promo_type as PromoType] ?? p.promo_type,
    description: p.description,
    currency: p.currency_code,
    regular_price: p.regular_price,
    promo_price: p.min_promo_price,
    discount: p.max_discount_pct,
    start: p.start_local_date,
    end: p.end_local_date,
    days: p.duration_days,
    status: (p.is_current ? 'Running' : p.status === 'active' ? 'Active (not recently observed)' : 'Ended') + (p.is_demo ? ' · DEMO' : ''),
  }));
}

const COMPARE_COLUMNS: ReportColumn[] = [
  col('name', 'Item'),
  col('detail', 'Detail'),
  col('currency', 'Currency'),
  col('avg_a', 'Average this period', 'money', 'currency'),
  col('avg_b', 'Average previous period', 'money', 'currency'),
  col('delta_pct', 'Change', 'signed_percent'),
  col('min_a', 'Lowest', 'money', 'currency'),
  col('max_a', 'Highest', 'money', 'currency'),
  col('promo_a', 'On promotion (this period)', 'percent'),
  col('promo_b', 'On promotion (previous)', 'percent'),
  col('days', 'Days observed', 'integer'),
];
function compareTable(result: ReturnType<typeof comparePeriods>, limit = 200): ReportTable {
  return {
    columns: COMPARE_COLUMNS,
    rows: result.rows.slice(0, limit).map((r) => ({
      name: r.label,
      detail: [r.sublabel, r.basis].filter(Boolean).join(' · '),
      currency: r.currency,
      avg_a: r.a?.avg ?? null,
      avg_b: r.b?.avg ?? null,
      delta_pct: r.delta_pct,
      min_a: r.a?.min ?? null,
      max_a: r.a?.max ?? null,
      promo_a: r.a?.promo_share_pct ?? null,
      promo_b: r.b?.promo_share_pct ?? null,
      days: r.a?.days ?? null,
    })),
    note: result.rows.length > limit ? `Showing ${limit} of ${result.rows.length} rows.` : null,
  };
}

// ---------------------------------------------------------------------------------------------
// report builders
// ---------------------------------------------------------------------------------------------
type Built = Omit<ReportResult, 'type' | 'title' | 'generated_at' | 'generated_by' | 'organisation' | 'period' | 'run_id'>;

function weeklyCompetitorPricing(ctx: AppContext, params: ReportParams): Built {
  const { period } = params;
  const filter = baseFilter(params, { date_from: period.from, date_to: period.to });
  const comp = eventTable(ctx, { ...filter, ownership: 'competitor' });
  const own = eventTable(ctx, { ...filter, ownership: 'own' });
  const pos = positioningSection(ctx, params, 28);
  const promos = listPromotions(ctx, { ...baseFilter(params), ownership: 'competitor' }, { status: 'current', sort: '-discount' }, { page: 1, pageSize: 200, offset: 0 });
  const started = listPromotions(ctx, { ...baseFilter(params), ownership: 'competitor', date_from: period.from, date_to: period.to }, {}, { page: 1, pageSize: 500, offset: 0 }).rows.filter(
    (p) => p.start_local_date >= period.from,
  );
  return {
    subtitle: `${fmtDate(period.from)} – ${fmtDate(period.to)}`,
    scope: scopeLines(ctx, params),
    summary: [
      { label: 'Competitor price increases', value: count(comp.ups), detail: comp.total > comp.rows.length ? 'among the largest changes' : null },
      { label: 'Competitor price decreases', value: count(comp.downs) },
      { label: 'Own price changes', value: count(own.total), detail: `${own.ups} up · ${own.downs} down` },
      { label: 'Competitor promotions started', value: count(started.length) },
      { label: 'Competitor promotions running', value: count(promos.total) },
      { label: 'Price index vs competitors', value: pos.index === null ? 'n/a' : String(pos.index), detail: pos.index === null ? 'no comparable pairs' : `100 = parity · ${pos.pairs} pairs` },
    ],
    sections: [
      { id: 'competitor_changes', title: 'Competitor price changes', description: 'Changes in selling price between consecutive observations of a competitor listing, largest first.', table: comp.table },
      { id: 'competitor_by_brand', title: 'Competitor movement by brand', table: brandMovement(comp.rows) },
      { id: 'own_changes', title: 'Own price changes', table: own.table },
      pos.section,
      { id: 'competitor_promotions', title: 'Competitor promotions running now', table: { columns: PROMO_COLUMNS, rows: promoRows(promos.rows), note: promos.total > promos.rows.length ? `Showing ${promos.rows.length} of ${promos.total}.` : null } },
    ],
    notes: ['Promotional price cuts and their endings count as price changes.'],
    conversions: [],
    demo: mergeDemo(comp.demo, own.demo, pos.demo),
  };
}

function monthlyMarketPricing(ctx: AppContext, params: ReportParams): Built {
  const { period } = params;
  const prev = previousRange(period);
  const days = Math.round((Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / 86_400_000) + 1;
  const markets = marketOverview(ctx, days).filter((m) => m.is_active && (!params.market_ids || params.market_ids.includes(m.id)));
  const marketRows: ReportTable['rows'] = [];
  const categoryRows: ReportTable['rows'] = [];
  const demos: DemoNote[] = [];
  let totalUp = 0;
  let totalDown = 0;
  for (const m of markets) {
    const scope = baseFilter({ ...params, market_ids: [m.id] });
    const products = comparePeriods(ctx, scope, period, prev, { groupBy: 'product', metric: 'price' });
    const promo = promotionSummary(ctx, scope, period);
    const events = eventCountsByDay(ctx, { ...scope, date_from: period.from, date_to: period.to, include_unmatched: true });
    const ups = events.reduce((acc, e) => acc + e.increases, 0);
    const downs = events.reduce((acc, e) => acc + e.decreases, 0);
    totalUp += ups;
    totalDown += downs;
    demos.push(products.demo);
    marketRows.push({
      market: m.name,
      currency: m.currency_code,
      retailers: m.retailers.total,
      listings: m.listings.active,
      products: m.products.own + m.products.competitor,
      avg_change: products.summary.avg_change_pct,
      increased: products.summary.increased,
      decreased: products.summary.decreased,
      price_increases: ups,
      price_decreases: downs,
      promo_share: promo.kpis.promo_day_share_pct,
      avg_discount: promo.kpis.avg_discount_pct,
      index: m.position?.index ?? null,
      fresh: m.listings.active ? round((m.listings.fresh / m.listings.active) * 100, 1) : null,
    });
    const categories = comparePeriods(ctx, scope, period, prev, { groupBy: 'category', metric: 'unit_price' });
    for (const r of categories.rows) {
      categoryRows.push({
        market: m.name,
        category: r.label,
        basis: r.basis,
        currency: r.currency,
        avg_a: r.a?.avg ?? null,
        avg_b: r.b?.avg ?? null,
        delta_pct: r.delta_pct,
        promo_a: r.a?.promo_share_pct ?? null,
        listings: r.a?.listings ?? null,
      });
    }
  }
  const movers = comparePeriods(ctx, baseFilter(params), period, prev, { groupBy: 'product', metric: 'price' });
  const ov = overview(ctx, { days, market_ids: params.market_ids });
  demos.push(movers.demo);
  return {
    subtitle: `${fmtDate(period.from)} – ${fmtDate(period.to)} compared with ${fmtDate(prev.from)} – ${fmtDate(prev.to)}`,
    scope: scopeLines(ctx, params),
    summary: [
      { label: 'Markets covered', value: count(markets.length) },
      { label: 'Price increases', value: count(totalUp) },
      { label: 'Price decreases', value: count(totalDown) },
      { label: 'Average product price change', value: pctText(movers.summary.avg_change_pct, true), detail: 'vs previous period' },
      { label: 'Products up / down', value: `${movers.summary.increased} / ${movers.summary.decreased}` },
    ],
    sections: [
      {
        id: 'markets',
        title: 'Market summary',
        description: 'Average change is the mean period-on-period change of each product\'s average selling price in its own currency.',
        table: {
          columns: [
            col('market', 'Market'), col('currency', 'Currency'), col('retailers', 'Retailers', 'integer'), col('listings', 'Listings', 'integer'), col('products', 'Products', 'integer'),
            col('avg_change', 'Average price change', 'signed_percent'), col('increased', 'Products up', 'integer'), col('decreased', 'Products down', 'integer'),
            col('price_increases', 'Price increases', 'integer'), col('price_decreases', 'Price decreases', 'integer'), col('promo_share', 'Share of listing-days on promotion', 'percent'),
            col('avg_discount', 'Average discount', 'percent'), col('index', 'Own vs competitor index', 'index'), col('fresh', 'Listings with fresh data', 'percent'),
          ],
          rows: marketRows,
        },
      },
      {
        id: 'index',
        title: 'Price movement: own brands vs competitors',
        description: 'Average price level of listings relative to their first price in the period (= 100).',
        chart: {
          kind: 'line',
          unit: 'index',
          reference: { value: 100, label: 'Period start' },
          series: [
            { key: 'own', label: 'Own brands', role: 'own', points: ov.price_movement.filter((p) => p.own_index !== null).map((p) => ({ date: p.date, value: p.own_index! })) },
            { key: 'competitor', label: 'Competitors', role: 'competitor', points: ov.price_movement.filter((p) => p.competitor_index !== null).map((p) => ({ date: p.date, value: p.competitor_index! })) },
          ],
        },
      },
      {
        id: 'changes_by_day',
        title: 'Price changes per day',
        chart: { kind: 'diverging', positive_label: 'Increases', negative_label: 'Decreases', data: ov.price_movement.map((p) => ({ date: p.date, positive: p.increases, negative: p.decreases })) },
      },
      {
        id: 'categories',
        title: 'Average unit price by market and category',
        description: 'Unit prices (per 100 ml / 100 g / unit) in each market\'s own currency; categories containing several unit bases are listed per basis.',
        table: {
          columns: [
            col('market', 'Market'), col('category', 'Category'), col('basis', 'Unit basis'), col('currency', 'Currency'), col('avg_a', 'Average this period', 'money', 'currency'),
            col('avg_b', 'Average previous period', 'money', 'currency'), col('delta_pct', 'Change', 'signed_percent'), col('promo_a', 'On promotion', 'percent'), col('listings', 'Listings', 'integer'),
          ],
          rows: categoryRows,
        },
      },
      { id: 'movers', title: 'Largest product price movers', description: 'Average selling price this period against the previous period, per product and currency.', table: compareTable(movers, 60) },
      {
        id: 'coverage',
        title: 'Data coverage and collection',
        description: 'Real collection and simulated demo runs are reported separately and never blended.',
        table: {
          columns: [
            col('market', 'Market'), col('status', 'Status'), col('fresh', 'Fresh listings', 'integer'), col('stale', 'Stale listings', 'integer'), col('never', 'Never observed', 'integer'),
            col('last', 'Last observation (UTC)', 'datetime'), col('real_runs', 'Real collection runs', 'integer'), col('real_rate', 'Real success rate', 'percent'),
            col('sim_runs', 'Simulated demo runs', 'integer'), col('sim_rate', 'Simulated success rate', 'percent'),
          ],
          rows: markets.map((m) => ({
            market: m.name, status: m.status_reason, fresh: m.listings.fresh, stale: m.listings.stale, never: m.listings.never_observed, last: m.last_observation_at,
            real_runs: m.collection.real.runs, real_rate: m.collection.real.success_rate_pct, sim_runs: m.collection.simulated.runs, sim_rate: m.collection.simulated.success_rate_pct,
          })),
        },
      },
    ],
    notes: ['Prices are compared within each market in its own currency; nothing in this report compares raw prices across currencies.'],
    conversions: [],
    demo: mergeDemo(...demos),
  };
}

function brandReport(ctx: AppContext, params: ReportParams): Built {
  const { period } = params;
  const prev = previousRange(period);
  const brands = ctx.db.all<{ id: number; name: string; ownership: 'own' | 'competitor'; manufacturer: string | null }>(
    `SELECT id, name, ownership, manufacturer FROM brands WHERE id IN (${placeholders(params.brand_ids!.length)}) ORDER BY name`,
    params.brand_ids!,
  );
  if (!brands.length) throw new AppError(404, 'not_found', 'Brand not found');
  const filter = baseFilter(params);
  const snapshot = monitorRowsFor(ctx, filter).filter((r) => r.current_price !== null);
  const groups = new Map<string, typeof snapshot>();
  for (const r of snapshot) {
    const key = `${r.product_id}|${r.market_id}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const current: ReportTable['rows'] = [...groups.values()]
    .map((g) => {
      const f = g[0]!;
      const prices = g.map((r) => r.current_price!);
      const low = g.reduce((a, b) => (b.current_price! < a.current_price! ? b : a));
      return {
        product: f.product_name, pack: packLabel(f), market: f.market_name, currency: f.currency_code, retailers: g.length,
        min: Math.min(...prices), avg: round(mean(prices), 4), max: Math.max(...prices), cheapest: low.retailer_name,
        on_promo: g.filter((r) => r.is_promo).length, stale: g.filter((r) => r.is_stale).length, last: g.map((r) => r.observed_at!).sort().pop() ?? null,
      };
    })
    .sort((a, b) => String(a.product).localeCompare(String(b.product)) || String(a.market).localeCompare(String(b.market)));
  const compare = comparePeriods(ctx, filter, period, prev, { groupBy: 'product', metric: 'price' });
  const chart = timeline(ctx, { ...filter, date_from: period.from, date_to: period.to }, { groupBy: 'product', metric: 'unit_price', currency: params.currency, maxSeries: 8 });
  const promo = promotionSummary(ctx, filter, period);
  const allOwn = brands.every((b) => b.ownership === 'own');
  const allComp = brands.every((b) => b.ownership === 'competitor');
  let pairs = latestPairs(ctx, { market_ids: params.market_ids, retailer_ids: params.retailer_ids, own_brand_ids: allOwn ? params.brand_ids : undefined });
  if (allComp) pairs = pairs.filter((p) => params.brand_ids!.includes(p.comp_brand_id));
  const usable = pairs.filter((p) => p.index !== null);
  const index = round(mean(usable.map((p) => p.index!)), 1);
  const bases = [...new Set(chart.series.map((s) => s.basis))];
  const chartSeries = chart.series.filter((s) => s.basis === bases[0]);
  return {
    subtitle: `${brands.map((b) => b.name).join(', ')} · ${fmtDate(period.from)} – ${fmtDate(period.to)}`,
    scope: scopeLines(ctx, params, [`Brand type: ${allOwn ? 'own brand' : allComp ? 'competitor' : 'mixed'}`]),
    summary: [
      { label: 'Products with a current price', value: count(new Set(snapshot.map((r) => r.product_id)).size) },
      { label: 'Listings', value: count(snapshot.length), detail: `${new Set(snapshot.map((r) => r.market_id)).size} markets` },
      { label: 'Average price change', value: pctText(compare.summary.avg_change_pct, true), detail: 'vs previous period' },
      { label: 'Promotions in period', value: count(promo.kpis.episodes), detail: `${pctText(promo.kpis.promo_day_share_pct)} of listing-days` },
      { label: 'Average discount', value: pctText(promo.kpis.avg_discount_pct) },
      { label: allComp ? 'Own products vs this brand' : 'Price index vs competitors', value: index === null ? 'n/a' : String(index), detail: index === null ? 'no comparable pairs' : `100 = parity · ${usable.length} pairs` },
    ],
    sections: [
      {
        id: 'current',
        title: 'Current prices by product and market',
        table: {
          columns: [
            col('product', 'Product'), col('pack', 'Pack'), col('market', 'Market'), col('currency', 'Currency'), col('retailers', 'Retailers', 'integer'), col('min', 'Lowest', 'money', 'currency'),
            col('avg', 'Average', 'money', 'currency'), col('max', 'Highest', 'money', 'currency'), col('cheapest', 'Cheapest at'), col('on_promo', 'On promotion', 'integer'),
            col('stale', 'Stale listings', 'integer'), col('last', 'Last observation (UTC)', 'datetime'),
          ],
          rows: current,
        },
      },
      {
        id: 'trend',
        title: `Average unit price by product (${params.currency})`,
        description: `Daily average unit price ${bases[0] ?? ''} across listings, converted to ${params.currency}.${chart.truncated ? ` Showing the ${chartSeries.length} products with most observations.` : ''}`,
        chart: chartSeries.length ? { kind: 'line', unit: params.currency, series: chartSeries.map((s) => ({ key: s.key, label: s.label, sublabel: s.sublabel, role: s.ownership === 'mixed' ? null : s.ownership, points: s.points.map((p) => ({ date: p.date, value: p.value })) })) } : null,
        notes: bases.length > 1 ? [`Products on other unit bases (${bases.slice(1).join(', ')}) are not drawn on this chart.`] : [],
      },
      { id: 'compare', title: 'Price by product: this period vs previous period', table: compareTable(compare) },
      {
        id: 'promotions',
        title: 'Promotions by retailer',
        table: {
          columns: [col('retailer', 'Retailer'), col('episodes', 'Promotions', 'integer'), col('current', 'Running now', 'integer'), col('avg', 'Average discount', 'percent'), col('max', 'Highest discount', 'percent'), col('days', 'Average days', 'number'), col('share', 'Share of listing-days on promotion', 'percent')],
          rows: promo.by_retailer.map((r) => ({ retailer: r.label, episodes: r.episodes, current: r.current, avg: r.avg_discount_pct, max: r.max_discount_pct, days: r.avg_duration_days, share: r.promo_day_share_pct })),
        },
      },
      {
        id: 'positioning',
        title: allComp ? 'Own products against this brand' : 'Position against mapped competitors',
        description: 'Same-retailer pairs from approved competitor mappings. Gap > 0 means the own product is more expensive.',
        table: {
          columns: [
            col('own', 'Own product'), col('competitor', 'Competitor product'), col('retailer', 'Retailer'), col('market', 'Market'), col('currency', 'Currency'), col('own_price', 'Own price', 'money', 'currency'),
            col('comp_price', 'Competitor price', 'money', 'currency'), col('basis', 'Compared on'), col('gap_pct', 'Own vs competitor', 'signed_percent'),
          ],
          rows: pairs.slice(0, 400).map((p) => ({
            own: p.own_product_name, competitor: p.comp_product_name, retailer: p.retailer_name, market: p.market_name, currency: p.currency_code, own_price: p.own_price, comp_price: p.comp_price,
            basis: p.basis === 'shelf' ? 'Shelf price (equivalent)' : p.basis === 'unit' ? `Unit price ${p.unit_basis ?? ''} (non-equivalent)` : 'Not comparable (different units)', gap_pct: p.gap_pct,
          })),
          note: pairs.length > 400 ? `Showing 400 of ${pairs.length} pairs.` : null,
        },
      },
    ],
    notes: chart.missing_rates.length ? [`No exchange rate for ${chart.missing_rates.join(', ')}: those listings are missing from the trend chart.`] : [],
    conversions: chart.conversions,
    demo: mergeDemo(compare.demo, chart.demo, promo.demo),
  };
}

function productReport(ctx: AppContext, params: ReportParams): Built {
  const { period } = params;
  const product = ctx.db.get<{ id: number; code: string; name: string; brand_name: string; ownership: string; pack_size: number | null; pack_unit: string | null; units_per_pack: number; is_demo: number }>(
    `SELECT p.id, p.code, p.name, b.name AS brand_name, b.ownership, p.pack_size, p.pack_unit, p.units_per_pack, p.is_demo FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id = ?`,
    [params.product_id!],
  );
  if (!product) throw new AppError(404, 'not_found', 'Product not found');
  const filter: ObsFilter = { product_ids: [product.id], market_ids: params.market_ids, retailer_ids: params.retailer_ids };
  const snapshot = monitorRowsFor(ctx, filter);
  const native = timeline(ctx, { ...filter, date_from: period.from, date_to: period.to }, { groupBy: 'listing', metric: 'price', maxSeries: 100 });
  const currencies = [...new Set(native.series.map((s) => s.currency))];
  const chartSource = currencies.length > 1 ? timeline(ctx, { ...filter, date_from: period.from, date_to: period.to }, { groupBy: 'listing', metric: 'price', currency: params.currency, maxSeries: 8 }) : native;
  const events = eventTable(ctx, { ...filter, date_from: period.from, date_to: period.to });
  const promos = listPromotions(ctx, { ...filter, date_from: period.from, date_to: period.to }, {}, { page: 1, pageSize: 500, offset: 0 });
  const sections: ReportSection[] = [
    {
      id: 'current',
      title: 'Current prices',
      table: {
        columns: [
          col('retailer', 'Retailer'), col('market', 'Market'), col('variant', 'Pack'), col('currency', 'Currency'), col('price', 'Selling price', 'money', 'currency'), col('regular', 'Regular price', 'money', 'currency'),
          col('discount', 'Discount', 'percent'), col('unit_price', 'Unit price', 'money', 'currency'), col('availability', 'Availability'), col('observed', 'Observed (UTC)', 'datetime'), col('fresh', 'Freshness'), col('source', 'Data source'),
        ],
        rows: snapshot.map((r) => ({
          retailer: r.retailer_name, market: r.market_name, variant: r.variant_name ?? packLabel(r), currency: r.currency_code, price: r.current_price, regular: r.regular_price, discount: r.is_promo ? r.discount_pct : null,
          unit_price: round(r.unit_price, 4), availability: r.availability, observed: r.observed_at, fresh: r.observed_at ? (r.is_stale ? 'Stale' : 'Fresh') : 'Never observed',
          source: r.data_class ? (DATA_CLASS_LABELS[r.data_class as DataClass] ?? r.data_class) + (r.is_demo ? ' (DEMO)' : '') : '',
        })),
      },
    },
    {
      id: 'history',
      title: currencies.length > 1 ? `Price history (converted to ${params.currency})` : `Price history (${currencies[0] ?? ''})`,
      description: 'Last priced observation of each market-local day, per retailer listing.' + (chartSource.truncated ? ` Showing the ${chartSource.series.length} listings with most observations.` : ''),
      chart: chartSource.series.length ? { kind: 'line', unit: currencies.length > 1 ? params.currency : (currencies[0] ?? ''), series: chartSource.series.slice(0, 8).map((s) => ({ key: s.key, label: s.sublabel ?? s.label, points: s.points.map((p) => ({ date: p.date, value: p.value })) })) } : null,
    },
    {
      id: 'statistics',
      title: 'Price statistics by listing',
      table: {
        columns: [
          col('where', 'Retailer · market'), col('currency', 'Currency'), col('first', 'First', 'money', 'currency'), col('last', 'Latest', 'money', 'currency'), col('min', 'Lowest', 'money', 'currency'),
          col('max', 'Highest', 'money', 'currency'), col('avg', 'Average', 'money', 'currency'), col('median', 'Median', 'money', 'currency'), col('volatility', 'Volatility', 'percent'), col('change', 'Change', 'signed_percent'), col('days', 'Days observed', 'integer'),
        ],
        rows: native.series.filter((s) => s.stats).map((s) => ({
          where: s.sublabel, currency: s.currency, first: s.stats!.first, last: s.stats!.last, min: s.stats!.min, max: s.stats!.max, avg: s.stats!.avg, median: s.stats!.median,
          volatility: s.stats!.volatility_pct, change: s.stats!.change_pct, days: s.stats!.n,
        })),
      },
    },
    { id: 'changes', title: 'Price changes', table: events.table },
    { id: 'promotions', title: 'Promotions', table: { columns: PROMO_COLUMNS, rows: promoRows(promos.rows) } },
  ];
  const notes: string[] = [];
  let competitorDemo: DemoNote | null = null;
  if (product.ownership === 'own') {
    const comparison = compareProduct(ctx, product.id, { market_ids: params.market_ids, retailer_ids: params.retailer_ids, days: Math.min(366, Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86_400_000) + 1) });
    competitorDemo = comparison.demo;
    notes.push(...comparison.notes);
    sections.push({
      id: 'competitors',
      title: 'Comparison with mapped competitors',
      description: 'Gap > 0 means the own product is more expensive than the competitor listing.',
      table: {
        columns: [
          col('role', 'Role'), col('product', 'Product'), col('pack', 'Pack'), col('equivalence', 'Mapping'), col('retailer', 'Retailer'), col('market', 'Market'), col('currency', 'Currency'),
          col('price', 'Selling price', 'money', 'currency'), col('unit_price', 'Unit price', 'money', 'currency'), col('basis', 'Compared on'), col('gap_pct', 'Own vs competitor', 'signed_percent'),
          col('low', 'Lowest in period', 'money', 'currency'), col('high', 'Highest in period', 'money', 'currency'), col('avg', 'Average in period', 'money', 'currency'),
        ],
        rows: comparison.rows.map((r) => ({
          role: r.role === 'own' ? 'Own' : 'Competitor', product: r.product_name, pack: r.variant_name ?? r.pack, equivalence: r.equivalence === 'equivalent' ? 'Equivalent' : r.equivalence === 'comparable' ? 'Non-equivalent' : '',
          retailer: r.retailer_name, market: r.market_name, currency: r.currency_code, price: r.price, unit_price: r.unit_price,
          basis: r.gap_basis === 'shelf' ? 'Shelf price' : r.gap_basis === 'unit' ? `Unit price ${r.unit_basis ?? ''}` : r.gap_basis === 'not_comparable' ? 'Not comparable' : '',
          gap_pct: r.gap_pct, low: r.period?.min ?? null, high: r.period?.max ?? null, avg: r.period?.avg ?? null,
        })),
      },
    });
  }
  const priced = snapshot.filter((r) => r.current_price !== null);
  return {
    subtitle: `${product.name} (${product.code}) · ${product.brand_name} · ${fmtDate(period.from)} – ${fmtDate(period.to)}`,
    scope: scopeLines(ctx, params, [`Product: ${product.name}${product.is_demo ? ' (DEMO)' : ''}`, `Pack: ${packLabel(product) || 'not specified'}`]),
    summary: [
      { label: 'Retailer listings', value: count(snapshot.length), detail: `${new Set(snapshot.map((r) => r.market_id)).size} markets` },
      { label: 'With a current price', value: count(priced.length), detail: `${snapshot.filter((r) => r.is_stale).length} stale` },
      { label: 'On promotion now', value: count(priced.filter((r) => r.is_promo).length) },
      { label: 'Price changes in period', value: count(events.total), detail: `${events.ups} up · ${events.downs} down` },
      { label: 'Promotions in period', value: count(promos.total) },
    ],
    sections,
    notes,
    conversions: currencies.length > 1 ? chartSource.conversions : [],
    demo: mergeDemo(native.demo, events.demo, competitorDemo),
  };
}

function promotionAnalysis(ctx: AppContext, params: ReportParams): Built {
  const { period } = params;
  const filter = baseFilter(params);
  const summary = promotionSummary(ctx, filter, period);
  const calendar = promotionCalendar(ctx, filter, period);
  const episodes = listPromotions(ctx, { ...filter, date_from: period.from, date_to: period.to }, { sort: '-discount' }, { page: 1, pageSize: 500, offset: 0 });
  const k = summary.kpis;
  const breakdownColumns = (label: string): ReportColumn[] => [
    col('name', label), col('episodes', 'Promotions', 'integer'), col('current', 'Running now', 'integer'), col('avg', 'Average discount', 'percent'), col('max', 'Highest discount', 'percent'),
    col('days', 'Average duration (days)', 'number'), col('share', 'Share of listing-days on promotion', 'percent'), col('listing_days', 'Listing-days on promotion', 'integer'),
  ];
  const breakdownRows = (rows: typeof summary.by_brand, name: (r: (typeof rows)[number]) => string) =>
    rows.map((r) => ({ name: name(r), episodes: r.episodes, current: r.current, avg: r.avg_discount_pct, max: r.max_discount_pct, days: r.avg_duration_days, share: r.promo_day_share_pct, listing_days: r.promo_listing_days }));
  return {
    subtitle: `${fmtDate(period.from)} – ${fmtDate(period.to)}`,
    scope: scopeLines(ctx, params),
    summary: [
      { label: 'Promotions', value: count(k.episodes), detail: `${k.current} running now` },
      { label: 'Average discount', value: pctText(k.avg_discount_pct) },
      { label: 'Highest discount', value: pctText(k.highest_discount_pct), detail: k.highest_discount ? `${k.highest_discount.product_name} · ${k.highest_discount.retailer_name}` : null },
      { label: 'Promotional days', value: count(k.promo_calendar_days), detail: `${count(k.promo_listing_days)} listing-days` },
      { label: 'Observations on promotion', value: pctText(k.promo_observation_share_pct) },
      { label: 'Average duration', value: k.avg_duration_days === null ? 'n/a' : `${k.avg_duration_days} days` },
      { label: 'Promotions per listing / 30 days', value: k.frequency_per_listing_30d === null ? 'n/a' : String(k.frequency_per_listing_30d) },
      { label: 'Average days between promotions', value: k.avg_days_between === null ? 'n/a' : String(k.avg_days_between) },
    ],
    sections: [
      {
        id: 'intensity',
        title: 'Promotional intensity over time',
        description: 'Share of observed listings on promotion each day.',
        chart: {
          kind: 'line',
          unit: '%',
          series: [
            { key: 'own', label: 'Own brands', role: 'own', points: calendar.filter((d) => d.own_share_pct !== null).map((d) => ({ date: d.date, value: d.own_share_pct! })) },
            { key: 'competitor', label: 'Competitors', role: 'competitor', points: calendar.filter((d) => d.competitor_share_pct !== null).map((d) => ({ date: d.date, value: d.competitor_share_pct! })) },
          ],
        },
      },
      { id: 'by_ownership', title: 'Own brands vs competitors', table: { columns: breakdownColumns('Group'), rows: breakdownRows(summary.by_ownership, (r) => r.label) } },
      { id: 'by_brand', title: 'By brand', table: { columns: breakdownColumns('Brand'), rows: breakdownRows(summary.by_brand, (r) => `${r.label}${r.ownership === 'own' ? ' (own)' : ''}`) } },
      { id: 'by_retailer', title: 'By retailer', table: { columns: breakdownColumns('Retailer'), rows: breakdownRows(summary.by_retailer, (r) => r.label) } },
      { id: 'by_type', title: 'By promotion type', table: { columns: breakdownColumns('Type'), rows: breakdownRows(summary.by_type, (r) => PROMO_TYPE_LABELS[r.key as PromoType] ?? r.label) } },
      { id: 'episodes', title: 'Promotions, deepest first', table: { columns: PROMO_COLUMNS, rows: promoRows(episodes.rows), note: episodes.total > episodes.rows.length ? `Showing ${episodes.rows.length} of ${count(episodes.total)}.` : null } },
    ],
    notes: [
      'A promotion is a run of consecutive promotional observations of one listing. Promotional days are days on which a promotion was actually observed.',
      'Bundle offers without a stated discount count as promotions but carry no discount percentage.',
    ],
    conversions: [],
    demo: summary.demo,
  };
}

function competitorPriceMovement(ctx: AppContext, params: ReportParams): Built {
  const { period } = params;
  const prev = previousRange(period);
  const days = Math.round((Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / 86_400_000) + 1;
  const filter = baseFilter(params, { ownership: 'competitor' });
  const events = eventTable(ctx, { ...filter, date_from: period.from, date_to: period.to }, 400);
  const compare = comparePeriods(ctx, filter, period, prev, { groupBy: 'product', metric: 'price' });
  const ov = overview(ctx, { days: Math.min(days, 365), market_ids: params.market_ids });
  // own products whose mapped competitor moved in the period, with the gap as it stands now
  const moved = new Map<number, { ups: number; downs: number }>();
  for (const e of events.rows) {
    if (!e.product_id) continue;
    const m = moved.get(e.product_id) ?? { ups: 0, downs: 0 };
    if (e.direction === 'up') m.ups++;
    else if (e.direction === 'down') m.downs++;
    moved.set(e.product_id, m);
  }
  const exposed = latestPairs(ctx, { market_ids: params.market_ids, retailer_ids: params.retailer_ids }).filter((p) => moved.has(p.comp_product_id) && (!params.brand_ids || params.brand_ids.includes(p.comp_brand_id)));
  return {
    subtitle: `${fmtDate(period.from)} – ${fmtDate(period.to)} compared with ${fmtDate(prev.from)} – ${fmtDate(prev.to)}`,
    scope: scopeLines(ctx, params, ['Competitor products only']),
    summary: [
      { label: 'Competitor price increases', value: count(events.ups) },
      { label: 'Competitor price decreases', value: count(events.downs) },
      { label: 'Average competitor price change', value: pctText(compare.summary.avg_change_pct, true), detail: 'product averages vs previous period' },
      { label: 'Competitor products up / down', value: `${compare.summary.increased} / ${compare.summary.decreased}` },
      { label: 'Own listings facing a moved competitor', value: count(new Set(exposed.map((p) => p.own_listing_id)).size) },
    ],
    sections: [
      {
        id: 'index',
        title: 'Price movement: competitors vs own brands',
        description: 'Average price level of listings relative to their first price in the period (= 100).',
        chart: {
          kind: 'line',
          unit: 'index',
          reference: { value: 100, label: 'Period start' },
          series: [
            { key: 'competitor', label: 'Competitors', role: 'competitor', points: ov.price_movement.filter((p) => p.competitor_index !== null).map((p) => ({ date: p.date, value: p.competitor_index! })) },
            { key: 'own', label: 'Own brands', role: 'own', points: ov.price_movement.filter((p) => p.own_index !== null).map((p) => ({ date: p.date, value: p.own_index! })) },
          ],
        },
        notes: params.brand_ids || params.category_ids || params.retailer_ids ? ['The index lines cover the selected markets as a whole; brand, category and retailer filters apply to the tables.'] : [],
      },
      { id: 'by_brand', title: 'Movement by competitor brand', table: brandMovement(events.rows) },
      { id: 'changes', title: 'Competitor price changes', table: events.table },
      { id: 'compare', title: 'Competitor products: this period vs previous period', table: compareTable(compare) },
      {
        id: 'exposure',
        title: 'Own products facing competitors that moved',
        description: 'Current gap between each own listing and a mapped competitor listing at the same retailer whose price changed in the period. Gap > 0 means the own product is more expensive.',
        table: {
          columns: [
            col('own', 'Own product'), col('competitor', 'Competitor product'), col('retailer', 'Retailer'), col('market', 'Market'), col('currency', 'Currency'), col('own_price', 'Own price', 'money', 'currency'),
            col('comp_price', 'Competitor price now', 'money', 'currency'), col('moves', 'Competitor moves in period'), col('basis', 'Compared on'), col('gap_pct', 'Own vs competitor now', 'signed_percent'),
          ],
          rows: exposed
            .sort((a, b) => (b.gap_pct ?? -999) - (a.gap_pct ?? -999))
            .slice(0, 300)
            .map((p) => ({
              own: p.own_product_name, competitor: p.comp_product_name, retailer: p.retailer_name, market: p.market_name, currency: p.currency_code, own_price: p.own_price, comp_price: p.comp_price,
              moves: `${moved.get(p.comp_product_id)!.ups} up · ${moved.get(p.comp_product_id)!.downs} down`,
              basis: p.basis === 'shelf' ? 'Shelf price (equivalent)' : p.basis === 'unit' ? `Unit price ${p.unit_basis ?? ''} (non-equivalent)` : 'Not comparable (different units)', gap_pct: p.gap_pct,
            })),
        },
      },
    ],
    notes: ['Promotional price cuts and their endings count as price changes.'],
    conversions: [],
    demo: mergeDemo(events.demo, compare.demo),
  };
}

const BUILDERS: Record<ReportType, (ctx: AppContext, params: ReportParams) => Built> = {
  weekly_competitor_pricing: weeklyCompetitorPricing,
  monthly_market_pricing: monthlyMarketPricing,
  brand_report: brandReport,
  product_report: productReport,
  promotion_analysis: promotionAnalysis,
  competitor_price_movement: competitorPriceMovement,
};

export function generateReport(ctx: AppContext, type: ReportType, params: ReportParams, user: Pick<AuthUser, 'id' | 'name'> | null, record = true): ReportResult {
  const def = REPORT_DEFINITIONS.find((d) => d.type === type);
  if (!def) throw badRequest('Unknown report type');
  const built = BUILDERS[type](ctx, params);
  const generatedAt = nowIso();
  const rowCount = built.sections.reduce((acc, s) => acc + (s.table?.rows.length ?? 0), 0);
  let runId: number | null = null;
  if (record && user) {
    const stored: Record<string, string> = { from: params.period.from, to: params.period.to };
    if (params.market_ids?.length) stored.market_id = params.market_ids.join(',');
    if (params.retailer_ids?.length) stored.retailer_id = params.retailer_ids.join(',');
    if (params.brand_ids?.length) stored.brand_id = params.brand_ids.join(',');
    if (params.category_ids?.length) stored.category_id = params.category_ids.join(',');
    if (params.product_id) stored.product_id = String(params.product_id);
    if (def.params.includes('currency')) stored.currency = params.currency;
    runId = ctx.db.run(`INSERT INTO report_runs (type, title, params, row_count, generated_by, generated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      type, `${def.title} — ${built.subtitle}`.slice(0, 300), JSON.stringify(stored), rowCount, user.id, generatedAt,
    ]).lastInsertRowid;
    ctx.db.run(`DELETE FROM report_runs WHERE id NOT IN (SELECT id FROM report_runs ORDER BY id DESC LIMIT 200)`);
  }
  return {
    type,
    title: def.title,
    generated_at: generatedAt,
    generated_by: user?.name ?? null,
    organisation: getSetting(ctx, 'organisation_name'),
    period: params.period,
    run_id: runId,
    ...built,
  };
}

export function listReportRuns(ctx: AppContext, limit = 30): ReportRun[] {
  return ctx.db
    .all<{ id: number; type: ReportType; title: string; params: string; row_count: number; generated_by: string | null; generated_at: string }>(
      `SELECT r.id, r.type, r.title, r.params, r.row_count, u.name AS generated_by, r.generated_at FROM report_runs r LEFT JOIN users u ON u.id = r.generated_by ORDER BY r.id DESC LIMIT ?`,
      [limit],
    )
    .map((r) => ({ ...r, params: JSON.parse(r.params) as Record<string, string> }));
}

// ---------------------------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------------------------
const XLSX_TYPES: Record<ReportColumn['type'], ColumnSpec['type']> = {
  text: 'text', integer: 'integer', number: 'number', money: 'money', percent: 'percent', signed_percent: 'percent', date: 'date', datetime: 'datetime', index: 'number',
};

function provenanceLines(report: ReportResult): Array<string | [string, unknown]> {
  return [
    ['Report', report.title],
    ['Period', `${report.period.from} to ${report.period.to}`],
    ['Generated at (UTC)', report.generated_at],
    ['Generated by', report.generated_by ?? ''],
    ...(report.organisation ? [['Organisation', report.organisation] as [string, unknown]] : []),
    ...report.scope.map((s) => ['Scope', s] as [string, unknown]),
    ...(report.demo.any_demo
      ? [['DEMO DATA', report.demo.all_demo ? 'Every figure in this report comes from the illustrative demo dataset. Prices are fictional.' : 'Part of this report comes from the illustrative demo dataset; affected rows are marked DEMO where a source column exists.'] as [string, unknown]]
      : []),
    ...report.conversions.map((c) => ['Exchange rate', `1 ${c.from} = ${c.rate} ${c.to} (as of ${c.as_of}; source: ${c.sources.join(', ') || 'n/a'}${c.is_demo ? '; ILLUSTRATIVE demo rate' : ''})`] as [string, unknown]),
    ...report.notes.map((n) => ['Note', n] as [string, unknown]),
    ['System of record', 'Price Intelligence OS relational database (append-only price ledger). This file is a copy.'],
  ];
}

export async function reportToXlsx(report: ReportResult): Promise<Buffer> {
  const sheets: SheetSpec[] = [
    provenanceSheet(`${report.title} — ${report.subtitle}`, provenanceLines(report), 'About this report'),
    {
      name: 'Summary',
      columns: [
        { key: 'label', header: 'Measure', type: 'text', width: 44 },
        { key: 'value', header: 'Value', type: 'text', width: 22 },
        { key: 'detail', header: 'Detail', type: 'text', width: 50 },
      ],
      rows: report.summary.map((s) => ({ label: s.label, value: s.value, detail: s.detail ?? '' })),
    },
  ];
  for (const section of report.sections) {
    const notes = [section.title, ...(section.description ? [section.description] : []), ...(section.notes ?? []), ...(section.table?.note ? [section.table.note] : [])];
    if (section.table) {
      sheets.push({
        name: section.title,
        notes,
        columns: section.table.columns.map((c) => ({ key: c.key, header: c.label, type: XLSX_TYPES[c.type] })),
        rows: section.table.rows,
      });
    }
    if (section.chart) {
      // the data behind every chart is exported too
      if (section.chart.kind === 'line') {
        const dates = [...new Set(section.chart.series.flatMap((s) => s.points.map((p) => p.date)))].sort();
        const lookup = section.chart.series.map((s) => new Map(s.points.map((p) => [p.date, p.value])));
        sheets.push({
          name: `${section.title} (chart data)`,
          notes: [`${section.title} — chart data (${section.chart.unit})`],
          columns: [{ key: 'date', header: 'Date', type: 'date' }, ...section.chart.series.map((s, i) => ({ key: `s${i}`, header: s.sublabel ? `${s.label} · ${s.sublabel}` : s.label, type: 'number' as const }))],
          rows: dates.map((date) => Object.fromEntries([['date', date], ...lookup.map((m, i) => [`s${i}`, m.get(date) ?? null])])),
        });
      } else if (section.chart.kind === 'diverging') {
        sheets.push({
          name: `${section.title} (chart data)`,
          notes: [`${section.title} — chart data`],
          columns: [{ key: 'date', header: 'Date', type: 'date' }, { key: 'positive', header: section.chart.positive_label, type: 'integer' }, { key: 'negative', header: section.chart.negative_label, type: 'integer' }],
          rows: section.chart.data,
        });
      } else {
        sheets.push({
          name: `${section.title} (chart data)`,
          notes: [`${section.title} — chart data (${section.chart.unit})`],
          columns: [{ key: 'label', header: 'Item', type: 'text' }, { key: 'value', header: 'Value', type: 'number' }],
          rows: section.chart.data,
        });
      }
    }
  }
  return buildXlsx(sheets, { title: report.title });
}

/** CSV of one section's table (or, with no section given, of every table one after another). */
export function reportToCsv(report: ReportResult, sectionId?: string): string {
  const sections = report.sections.filter((s) => s.table && (!sectionId || s.id === sectionId));
  if (!sections.length) throw new AppError(404, 'not_found', 'This report has no table with that name');
  if (sections.length === 1) {
    const t = sections[0]!.table!;
    return toCsv(t.columns.map((c) => ({ key: c.key, header: c.label })), t.rows);
  }
  // several tables in one file: a title line, then that table, then a blank line
  let out = '\uFEFF';
  for (const s of sections) {
    const t = s.table!;
    out += `${csvCell(`# ${s.title}`)}\r\n`;
    out += toCsv(t.columns.map((c) => ({ key: c.key, header: c.label })), t.rows).replace(/^\uFEFF/, '');
    out += '\r\n';
  }
  return out;
}
