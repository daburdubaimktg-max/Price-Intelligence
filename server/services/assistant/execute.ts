/**
 * Runs a QueryPlan against the stored records and composes the answer.
 *
 * Every figure in an answer is computed here from the database. The language model (when one is used)
 * only decides WHICH query to run — it never writes numbers — so an answer cannot contain a price that
 * was not observed. When nothing matches, the answer says so.
 */
import type { AppContext } from '../../context.ts';
import type { AssistantAnswer, AssistantChart, AssistantEvidence, AssistantTable, QueryPlan } from '../../../shared/api/assistant.ts';
import type { DemoNote } from '../../../shared/api/analytics.ts';
import { DATA_CLASS_LABELS, PROMO_TYPE_LABELS, type DataClass, type PromoType } from '../../../shared/constants.ts';
import { getSetting } from '../core.ts';
import { OBS_FROM, obsWhere, type ObsFilter } from '../obs-filter.ts';
import { demoNote, mean, round } from '../analytics/common.ts';
import { latestPairs, positioning, positioningHistory } from '../analytics/competitors.ts';
import { timeline, volatilityRanking } from '../analytics/history.ts';
import { crossMarketProduct } from '../analytics/markets.ts';
import { monitorRowsFor, priceEvents } from '../analytics/monitor.ts';
import { promotionSummary } from '../analytics/promotions.ts';
import {
  INTENT_LABELS, resolveBrands, resolveCategories, resolveMarkets, resolvePeriod, resolveProducts, resolveRetailers, type Catalogue, type ResolvedPeriod,
} from './interpret.ts';

export type AnswerCore = Pick<AssistantAnswer, 'status' | 'answer' | 'highlights' | 'tables' | 'chart' | 'evidence' | 'notes' | 'demo'> & {
  interpretation: AssistantAnswer['interpretation'];
};

interface Scope {
  productIds: number[];
  productNames: string[];
  brandIds: number[];
  brandNames: string[];
  retailerIds: number[];
  retailerNames: string[];
  marketIds: number[];
  marketNames: string[];
  categoryIds: number[];
  categoryNames: string[];
  unresolved: string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return 'n/a';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};
const pct = (value: number | null | undefined, signed = false): string => {
  if (value === null || value === undefined) return 'n/a';
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
};
const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? word : pluralWord}`;
const list = (items: string[], max = 4): string => {
  if (items.length <= max) return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
};

function moneyFormatter(ctx: AppContext): (value: number | null | undefined, currency: string | null | undefined) => string {
  const decimals = new Map(ctx.db.all<{ code: string; decimals: number }>('SELECT code, decimals FROM currencies').map((c) => [c.code, c.decimals]));
  return (value, currency) => {
    if (value === null || value === undefined) return 'n/a';
    const d = currency ? (decimals.get(currency) ?? 2) : 2;
    const text = value.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
    return currency ? `${currency} ${text}` : text;
  };
}

function resolveScope(plan: QueryPlan, catalogue: Catalogue): Scope {
  const markets = resolveMarkets(catalogue, plan.markets);
  const retailers = resolveRetailers(catalogue, plan.retailers, markets.ids);
  const products = resolveProducts(catalogue, plan.products);
  const brands = resolveBrands(catalogue, plan.brands);
  const categories = resolveCategories(catalogue, plan.categories);
  // subcategories filter through their own id; a parent category also covers its children via the product's category_id
  return {
    productIds: products.ids,
    productNames: products.names,
    brandIds: brands.ids,
    brandNames: brands.names,
    retailerIds: retailers.ids,
    retailerNames: retailers.names,
    marketIds: markets.ids,
    marketNames: markets.names,
    categoryIds: categories.ids,
    categoryNames: categories.names,
    unresolved: [...products.unresolved, ...brands.unresolved, ...retailers.unresolved, ...markets.unresolved, ...categories.unresolved],
  };
}

function scopeFilter(scope: Scope, plan: QueryPlan, period?: ResolvedPeriod): ObsFilter {
  return {
    product_ids: scope.productIds.length ? scope.productIds : undefined,
    brand_ids: scope.brandIds.length ? scope.brandIds : undefined,
    retailer_ids: scope.retailerIds.length ? scope.retailerIds : undefined,
    market_ids: scope.marketIds.length ? scope.marketIds : undefined,
    category_ids: scope.categoryIds.length ? scope.categoryIds : undefined,
    ownership: plan.ownership === 'any' ? undefined : plan.ownership,
    date_from: period?.from,
    date_to: period?.to,
  };
}

function scopeSummary(plan: QueryPlan, scope: Scope, period: ResolvedPeriod | null): string {
  const parts: string[] = [INTENT_LABELS[plan.intent]];
  if (scope.productNames.length) parts.push(`Product: ${list(scope.productNames, 3)}`);
  if (scope.brandNames.length) parts.push(`Brand: ${list(scope.brandNames, 3)}`);
  if (scope.categoryNames.length) parts.push(`Category: ${list(scope.categoryNames, 3)}`);
  if (scope.retailerNames.length) parts.push(`Retailer: ${list(scope.retailerNames, 3)}`);
  if (scope.marketNames.length) parts.push(`Market: ${list(scope.marketNames, 3)}`);
  if (plan.ownership !== 'any') parts.push(plan.ownership === 'own' ? 'Own brands' : 'Competitors');
  if (plan.direction !== 'any') parts.push(plan.direction === 'up' ? 'Increases' : 'Decreases');
  if (period) parts.push(`Period: ${fmtDate(period.from)} – ${fmtDate(period.to)}`);
  return parts.join(' · ');
}

function historyLink(filter: ObsFilter, label = 'Open these records in the Historical Price Explorer'): { label: string; href: string } {
  const params = new URLSearchParams();
  const set = (key: string, values?: Array<number | string>) => values?.length && params.set(key, values.join(','));
  set('product_id', filter.product_ids);
  set('brand_id', filter.brand_ids);
  set('retailer_id', filter.retailer_ids);
  set('market_id', filter.market_ids);
  set('category_id', filter.category_ids);
  if (filter.ownership) params.set('ownership', filter.ownership);
  if (filter.date_from) params.set('from', filter.date_from);
  if (filter.date_to) params.set('to', filter.date_to);
  return { label, href: `/history?${params.toString()}` };
}

/** What the answer rests on: the stored observations in scope, by source class, with a sample of ids. */
function buildEvidence(ctx: AppContext, filter: ObsFilter, extraLinks: Array<{ label: string; href: string }> = [], linkFilter?: ObsFilter | null): { evidence: AssistantEvidence; demo: DemoNote } {
  const where = obsWhere(filter);
  const totals = ctx.db.get<{ n: number; first: string | null; last: string | null; demo: number | null }>(
    `SELECT COUNT(*) AS n, MIN(o.observed_at) AS first, MAX(o.observed_at) AS last, SUM(o.is_demo) AS demo ${OBS_FROM} ${where.sql}`,
    where.params,
  )!;
  const sources = ctx.db.all<{ data_class: string; observations: number }>(
    `SELECT o.data_class, COUNT(*) AS observations ${OBS_FROM} ${where.sql} GROUP BY o.data_class ORDER BY observations DESC`,
    where.params,
  );
  const retailers = ctx.db.all<{ retailer_name: string; market_name: string }>(
    `SELECT DISTINCT li.retailer_name, li.market_name ${OBS_FROM} ${where.sql} ORDER BY li.retailer_name LIMIT 40`,
    where.params,
  );
  const ids = ctx.db.all<{ id: number }>(`SELECT o.id ${OBS_FROM} ${where.sql} ORDER BY o.observed_at DESC, o.id DESC LIMIT 25`, where.params).map((r) => r.id);
  return {
    evidence: {
      observations: totals.n,
      first_observed_at: totals.first,
      last_observed_at: totals.last,
      retailers: [...new Set(retailers.map((r) => r.retailer_name))],
      markets: [...new Set(retailers.map((r) => r.market_name))],
      sources,
      observation_ids: ids,
      links: [...(linkFilter === null ? [] : [historyLink(linkFilter ?? filter)]), ...extraLinks],
    },
    demo: { demo_rows: totals.demo ?? 0, total_rows: totals.n, all_demo: totals.n > 0 && (totals.demo ?? 0) === totals.n, any_demo: (totals.demo ?? 0) > 0 },
  };
}

const DEMO_SENTENCE = 'These figures come from the illustrative DEMO dataset — the prices are fictional, not market observations.';
const sourceSentence = (evidence: AssistantEvidence): string =>
  evidence.observations
    ? `Based on ${plural(evidence.observations, 'stored observation')} (${evidence.sources.map((s) => `${s.observations.toLocaleString('en-GB')} ${(DATA_CLASS_LABELS[s.data_class as DataClass] ?? s.data_class).toLowerCase()}`).join(', ')}) from ${fmtDate(evidence.first_observed_at)} to ${fmtDate(evidence.last_observed_at)}.`
    : '';

interface Built {
  status: AssistantAnswer['status'];
  paragraphs: string[];
  highlights?: AssistantAnswer['highlights'];
  tables?: AssistantTable[];
  chart?: AssistantChart | null;
  evidenceFilter?: ObsFilter | null;
  /** Filter for the "open in History Explorer" link when it differs from the evidence filter (null = no such link). */
  linkFilter?: ObsFilter | null;
  links?: Array<{ label: string; href: string }>;
  notes?: string[];
  demoOverride?: DemoNote | null;
}

function noData(scope: Scope, period: ResolvedPeriod | null, what: string): Built {
  const where: string[] = [];
  if (scope.productNames.length) where.push(list(scope.productNames, 3));
  if (scope.brandNames.length) where.push(list(scope.brandNames, 3));
  if (scope.retailerNames.length) where.push(`at ${list(scope.retailerNames, 3)}`);
  if (scope.marketNames.length) where.push(`in ${list(scope.marketNames, 3)}`);
  return {
    status: 'no_data',
    paragraphs: [
      `No stored ${what} ${where.length ? `for ${where.join(' ')} ` : ''}${period ? `between ${fmtDate(period.from)} and ${fmtDate(period.to)}` : ''}.`.replace(/\s+\./, '.'),
      'The data is unavailable: nothing has been collected, imported or entered for this selection, so there is no price I can report.',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Intent handlers
// ---------------------------------------------------------------------------------------------
function priceHistory(ctx: AppContext, plan: QueryPlan, scope: Scope, period: ResolvedPeriod, money: ReturnType<typeof moneyFormatter>): Built {
  const filter = scopeFilter(scope, plan, period);
  const result = timeline(ctx, filter, { groupBy: 'listing', metric: 'price', maxSeries: 40 });
  if (!result.series.length) return noData(scope, period, 'price observations');
  const series = result.series.filter((s) => s.stats);
  const paragraphs: string[] = [];
  const lead = scope.productNames.length === 1 ? scope.productNames[0]! : `${plural(scope.productNames.length, 'product')}`;
  if (series.length === 1) {
    const s = series[0]!;
    const st = s.stats!;
    const last = s.points[s.points.length - 1]!;
    paragraphs.push(
      `${s.label} at ${s.sublabel}: between ${fmtDate(period.from)} and ${fmtDate(period.to)} the selling price ranged from ${money(st.min, s.currency)} to ${money(st.max, s.currency)}, averaging ${money(st.avg, s.currency)}. It started at ${money(st.first, s.currency)} and the latest observed price is ${money(st.last, s.currency)} on ${fmtDate(last.date)}${last.promo > 0 ? ' (on promotion)' : ''}${st.change_pct !== null && Math.abs(st.change_pct) >= 0.05 ? `, a ${pct(st.change_pct, true)} movement over the period` : ', unchanged over the period'}.`,
    );
  } else {
    paragraphs.push(`${lead}: ${plural(result.total_series, 'listing')} with observations between ${fmtDate(period.from)} and ${fmtDate(period.to)}.`);
    for (const s of series.slice(0, 6)) {
      const st = s.stats!;
      const last = s.points[s.points.length - 1]!;
      paragraphs.push(
        `• ${scope.productNames.length > 1 ? `${s.label}, ` : ''}${s.sublabel}: ${money(st.min, s.currency)}–${money(st.max, s.currency)}, average ${money(st.avg, s.currency)}; latest ${money(st.last, s.currency)} on ${fmtDate(last.date)}${last.promo > 0 ? ' (on promotion)' : ''}.`,
      );
    }
    if (series.length > 6) paragraphs.push(`…and ${series.length - 6} more in the table below.`);
  }
  const currencies = [...new Set(series.map((s) => s.currency))];
  const chartSeries = series.filter((s) => s.currency === currencies[0]).slice(0, 8);
  const notes: string[] = ['Daily price = the last priced observation of each market-local day.'];
  if (currencies.length > 1) notes.push(`Listings are priced in ${currencies.length} currencies (${currencies.join(', ')}); the chart shows the ${currencies[0]} listings only — prices in different currencies are not compared directly.`);
  return {
    status: 'answered',
    paragraphs,
    highlights:
      series.length === 1
        ? [
            { label: 'Latest', value: money(series[0]!.stats!.last, series[0]!.currency) },
            { label: 'Average', value: money(series[0]!.stats!.avg, series[0]!.currency) },
            { label: 'Lowest', value: money(series[0]!.stats!.min, series[0]!.currency) },
            { label: 'Highest', value: money(series[0]!.stats!.max, series[0]!.currency) },
          ]
        : [],
    tables: [
      {
        title: 'Price history by listing',
        columns: [
          { key: 'product', label: 'Product' },
          { key: 'where', label: 'Retailer · market' },
          { key: 'currency', label: 'Currency' },
          { key: 'first', label: 'First', align: 'right' },
          { key: 'last', label: 'Latest', align: 'right' },
          { key: 'min', label: 'Lowest', align: 'right' },
          { key: 'max', label: 'Highest', align: 'right' },
          { key: 'avg', label: 'Average', align: 'right' },
          { key: 'change', label: 'Change', align: 'right' },
          { key: 'days', label: 'Days observed', align: 'right' },
        ],
        rows: series.map((s) => ({
          product: s.label,
          where: s.sublabel ?? '',
          currency: s.currency ?? '',
          first: money(s.stats!.first, null),
          last: money(s.stats!.last, null),
          min: money(s.stats!.min, null),
          max: money(s.stats!.max, null),
          avg: money(s.stats!.avg, null),
          change: pct(s.stats!.change_pct, true),
          days: s.stats!.n,
        })),
      },
    ],
    chart: {
      title: 'Selling price',
      subtitle: `${currencies[0] ?? ''} · daily`,
      unit: currencies[0] ?? '',
      series: chartSeries.map((s) => ({ key: s.key, label: s.label, sublabel: s.sublabel, points: s.points.map((p) => ({ date: p.date, value: p.value })) })),
    },
    evidenceFilter: filter,
    notes,
  };
}

function currentPrices(ctx: AppContext, plan: QueryPlan, scope: Scope, money: ReturnType<typeof moneyFormatter>, lowest: boolean): Built {
  const filter = scopeFilter(scope, plan);
  const all = monitorRowsFor(ctx, filter);
  const priced = all.filter((r) => r.current_price !== null);
  if (!priced.length) return noData(scope, null, 'current prices');
  const fresh = priced.filter((r) => r.is_stale === 0);
  const rows = (fresh.length ? fresh : priced).filter((r) => !lowest || !r.variant_name);
  const staleExcluded = priced.length - fresh.length;
  const paragraphs: string[] = [];
  const notes: string[] = [];
  if (!fresh.length) notes.push('Every matching listing is stale (no fresh observation within its expected window); the last known prices are shown.');
  else if (staleExcluded) notes.push(`${plural(staleExcluded, 'listing')} without a fresh observation ${staleExcluded === 1 ? 'is' : 'are'} left out.`);
  const byMarket = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.market_name}|${r.currency_code}${scope.productIds.length === 1 ? '' : `|${r.product_name}`}`;
    const group = byMarket.get(key);
    if (group) group.push(r);
    else byMarket.set(key, [r]);
  }
  if (lowest) {
    const lines: string[] = [];
    for (const [key, group] of byMarket) {
      const [market] = key.split('|');
      const sorted = [...group].sort((a, b) => a.current_price! - b.current_price!);
      const low = sorted[0]!;
      const high = sorted[sorted.length - 1]!;
      const ties = sorted.filter((r) => r.current_price === low.current_price);
      lines.push(
        `In ${market}, the lowest current price${scope.productIds.length === 1 ? '' : ` for ${low.product_name}`} is ${money(low.current_price, low.currency_code)} at ${list(ties.map((t) => t.retailer_name), 3)}${low.is_promo ? ' (promotional price)' : ''}, observed ${fmtDate(low.observed_at)}${sorted.length > 1 && high.current_price !== low.current_price ? `; the highest is ${money(high.current_price, high.currency_code)} at ${high.retailer_name}` : sorted.length === 1 ? ' — the only retailer with a current price' : ''}.`,
      );
    }
    paragraphs.push(...lines.slice(0, 8));
    if (lines.length > 8) paragraphs.push(`…and ${lines.length - 8} more markets in the table below.`);
    if (byMarket.size > 1) notes.push('Each market is compared in its own currency. Use Market Intelligence → Cross-market comparison for a currency-normalised view.');
    if (all.some((r) => r.variant_name)) notes.push('Pack variants (twin packs, bonus packs) are excluded so that only the standard pack is compared.');
  } else {
    const latest = rows.map((r) => r.observed_at!).sort().pop();
    paragraphs.push(`${plural(rows.length, 'current price')} across ${plural(new Set(rows.map((r) => r.retailer_id)).size, 'retailer')}; the most recent observation is from ${fmtDate(latest)}.`);
    for (const r of rows.slice(0, 6)) {
      paragraphs.push(`• ${r.product_name ?? r.listing_title} at ${r.retailer_name} (${r.market_name}): ${money(r.current_price, r.currency_code)}${r.is_promo && r.regular_price ? `, on promotion from ${money(r.regular_price, r.currency_code)}` : ''}.`);
    }
    if (rows.length > 6) paragraphs.push(`…and ${rows.length - 6} more in the table below.`);
  }
  const sorted = [...rows].sort((a, b) => a.market_name.localeCompare(b.market_name) || a.current_price! - b.current_price!);
  return {
    status: 'answered',
    paragraphs,
    tables: [
      {
        title: lowest ? 'Current prices, lowest first within each market' : 'Current prices',
        columns: [
          { key: 'product', label: 'Product' },
          { key: 'retailer', label: 'Retailer' },
          { key: 'market', label: 'Market' },
          { key: 'price', label: 'Selling price', align: 'right' },
          { key: 'regular', label: 'Regular', align: 'right' },
          { key: 'promo', label: 'Promotion' },
          { key: 'observed', label: 'Observed' },
          { key: 'source', label: 'Source' },
        ],
        rows: sorted.slice(0, 80).map((r) => ({
          product: `${r.product_name ?? r.listing_title ?? ''}${r.variant_name ? ` (${r.variant_name})` : ''}`,
          retailer: r.retailer_name,
          market: r.market_name,
          price: money(r.current_price, r.currency_code),
          regular: money(r.regular_price, null),
          promo: r.is_promo ? `${r.discount_pct !== null ? `${pct(r.discount_pct)} off` : (PROMO_TYPE_LABELS[r.promo_type as PromoType] ?? 'Offer')}` : '—',
          observed: fmtDate(r.observed_at),
          source: DATA_CLASS_LABELS[r.data_class as DataClass] ?? r.data_class ?? '',
        })),
        note: sorted.length > 80 ? `Showing 80 of ${sorted.length} listings.` : null,
      },
    ],
    evidenceFilter: { ...filter, listing_ids: rows.map((r) => r.listing_id).slice(0, 400), date_from: rows.map((r) => r.observed_at!.slice(0, 10)).sort()[0] },
    linkFilter: { ...filter, date_from: rows.map((r) => r.observed_at!.slice(0, 10)).sort()[0] },
    links: [{ label: 'Open in the Live Price Monitor', href: historyLink(filter).href.replace('/history?', '/monitor?') }],
    notes,
    demoOverride: demoNote(rows),
  };
}

function priceChanges(ctx: AppContext, plan: QueryPlan, scope: Scope, period: ResolvedPeriod, money: ReturnType<typeof moneyFormatter>): Built {
  const filter = scopeFilter(scope, plan, period);
  const direction = plan.direction === 'any' ? undefined : plan.direction;
  const { rows, total } = priceEvents(ctx, filter, { direction, limit: 200, sort: 'largest' });
  const word = direction === 'up' ? 'price increase' : direction === 'down' ? 'price decrease' : 'price change';
  const where = [
    plan.ownership === 'competitor' ? 'among competitor products' : plan.ownership === 'own' ? 'among own-brand products' : '',
    scope.marketNames.length ? `across ${list(scope.marketNames, 3)}` : '',
    scope.retailerNames.length ? `at ${list(scope.retailerNames, 3)}` : '',
    scope.brandNames.length ? `for ${list(scope.brandNames, 3)}` : '',
    scope.productNames.length ? `for ${list(scope.productNames, 2)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const between = `${where ? `${where} ` : ''}between ${fmtDate(period.from)} and ${fmtDate(period.to)}`;
  if (!total) {
    const anyObs = ctx.db.scalar<number>(`SELECT COUNT(*) ${OBS_FROM} ${obsWhere(filter).sql}`, obsWhere(filter).params) ?? 0;
    return {
      status: anyObs ? 'answered' : 'no_data',
      paragraphs: [
        anyObs
          ? `No ${word} was detected ${between}. ${plural(anyObs, 'observation')} in that scope show${anyObs === 1 ? 's' : ''} no change in selling price in that direction.`
          : `No stored observations ${between}, so price changes cannot be assessed — the data is unavailable.`,
      ],
      evidenceFilter: anyObs ? filter : null,
    };
  }
  const ups = rows.filter((r) => r.direction === 'up');
  const downs = rows.filter((r) => r.direction === 'down');
  const biggest = rows[0]!;
  const paragraphs = [
    `${plural(total, word)} ${between}${direction ? '' : ` (${ups.length} up, ${downs.length} down${total > rows.length ? ' among the largest 200' : ''})`}.`,
    `The largest: ${biggest.product_name} at ${biggest.retailer_name} (${biggest.market_name}) moved from ${money(biggest.old_price, biggest.currency_code)} to ${money(biggest.new_price, biggest.currency_code)} (${pct(biggest.change_pct, true)}) on ${fmtDate(biggest.occurred_local_date)}.`,
  ];
  // "Which competitor …" is answered by brand: who moved, and how often.
  const byBrand = new Map<string, number>();
  for (const r of rows) if (r.brand_name) byBrand.set(r.brand_name, (byBrand.get(r.brand_name) ?? 0) + 1);
  if (byBrand.size > 0 && scope.brandNames.length !== 1 && scope.productNames.length === 0) {
    const ranked = [...byBrand.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    paragraphs.push(
      `By brand${total > rows.length ? ' (largest 200 changes)' : ''}: ${ranked.slice(0, 6).map(([name, n]) => `${name} (${n})`).join(', ')}${ranked.length > 6 ? ` and ${ranked.length - 6} more` : ''}.`,
    );
  }
  const avgAbs = mean(rows.map((r) => Math.abs(r.change_pct ?? 0)));
  return {
    status: 'answered',
    paragraphs,
    highlights: [
      { label: direction === 'down' ? 'Decreases' : direction === 'up' ? 'Increases' : 'Changes', value: total.toLocaleString('en-GB') },
      { label: 'Average size', value: pct(avgAbs) },
      { label: 'Largest', value: pct(biggest.change_pct, true), detail: biggest.product_name },
      { label: 'Products affected', value: String(new Set(rows.map((r) => r.product_id)).size) },
    ],
    tables: [
      {
        title: `${direction === 'up' ? 'Price increases' : direction === 'down' ? 'Price decreases' : 'Price changes'}, largest first`,
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'product', label: 'Product' },
          { key: 'retailer', label: 'Retailer' },
          { key: 'market', label: 'Market' },
          { key: 'from', label: 'Previous', align: 'right' },
          { key: 'to', label: 'New', align: 'right' },
          { key: 'change', label: 'Change', align: 'right' },
          { key: 'note', label: 'Note' },
        ],
        rows: rows.slice(0, 60).map((r) => ({
          date: fmtDate(r.occurred_local_date),
          product: r.product_name ?? '',
          retailer: r.retailer_name,
          market: r.market_name,
          from: money(r.old_price, r.currency_code),
          to: money(r.new_price, null),
          change: pct(r.change_pct, true),
          note: r.is_promo ? 'Promotion started' : '',
        })),
        note: total > 60 ? `Showing the 60 largest of ${total}.` : null,
      },
    ],
    evidenceFilter: { ...filter, include_unmatched: false },
    notes: ['A price change is a difference in selling price between two consecutive observations of the same listing; promotional price cuts and their endings are included.'],
    demoOverride: demoNote(rows),
  };
}

function discountRanking(ctx: AppContext, plan: QueryPlan, scope: Scope, period: ResolvedPeriod): Built {
  const filter = scopeFilter(scope, plan);
  const summary = promotionSummary(ctx, filter, period);
  if (!summary.kpis.episodes) return noData(scope, period, 'promotions');
  const who = plan.ownership === 'competitor' ? 'competitor' : plan.ownership === 'own' ? 'own' : '';
  const brands = summary.by_brand.filter((b) => b.avg_discount_pct !== null);
  const byAvg = [...brands].sort((a, b) => b.avg_discount_pct! - a.avg_discount_pct!);
  const byMax = [...brands].sort((a, b) => (b.max_discount_pct ?? 0) - (a.max_discount_pct ?? 0));
  const byShare = [...summary.by_brand].filter((b) => b.promo_day_share_pct !== null).sort((a, b) => b.promo_day_share_pct! - a.promo_day_share_pct!);
  const paragraphs: string[] = [];
  if (byAvg.length) {
    const top = byAvg[0]!;
    paragraphs.push(
      `Between ${fmtDate(period.from)} and ${fmtDate(period.to)}, ${top.label} discounted the deepest among ${who ? `${who} ` : ''}brands: an average discount of ${pct(top.avg_discount_pct)} across ${plural(top.episodes, 'promotion')} (highest ${pct(top.max_discount_pct)}).`,
    );
    const others = byAvg.slice(1, 4).map((b) => `${b.label} (${pct(b.avg_discount_pct)} average, ${plural(b.episodes, 'promotion')})`);
    if (others.length) paragraphs.push(`Next: ${list(others, 3)}.`);
  }
  if (byMax.length && byMax[0]!.key !== byAvg[0]?.key) paragraphs.push(`The single highest discount was ${pct(byMax[0]!.max_discount_pct)}, by ${byMax[0]!.label}.`);
  if (byShare.length) paragraphs.push(`Measured by time on promotion, ${byShare[0]!.label} led with ${pct(byShare[0]!.promo_day_share_pct)} of its observed listing-days on promotion.`);
  const top = summary.top_discounts[0];
  return {
    status: 'answered',
    paragraphs,
    highlights: [
      { label: 'Promotions in period', value: summary.kpis.episodes.toLocaleString('en-GB') },
      { label: 'Average discount', value: pct(summary.kpis.avg_discount_pct) },
      { label: 'Highest discount', value: pct(summary.kpis.highest_discount_pct), detail: top ? `${top.product_name} · ${top.retailer_name}` : null },
      { label: 'Share of observations on promotion', value: pct(summary.kpis.promo_observation_share_pct) },
    ],
    tables: [
      {
        title: 'Discounting by brand',
        columns: [
          { key: 'brand', label: 'Brand' },
          { key: 'type', label: 'Own / competitor' },
          { key: 'episodes', label: 'Promotions', align: 'right' },
          { key: 'avg', label: 'Average discount', align: 'right' },
          { key: 'max', label: 'Highest', align: 'right' },
          { key: 'duration', label: 'Average days', align: 'right' },
          { key: 'share', label: 'Listing-days on promotion', align: 'right' },
        ],
        rows: byAvg.concat(summary.by_brand.filter((b) => b.avg_discount_pct === null)).map((b) => ({
          brand: b.label,
          type: b.ownership === 'own' ? 'Own' : 'Competitor',
          episodes: b.episodes,
          avg: pct(b.avg_discount_pct),
          max: pct(b.max_discount_pct),
          duration: b.avg_duration_days ?? 'n/a',
          share: pct(b.promo_day_share_pct),
        })),
      },
      {
        title: 'Deepest individual promotions',
        columns: [
          { key: 'product', label: 'Product' },
          { key: 'retailer', label: 'Retailer · market' },
          { key: 'type', label: 'Type' },
          { key: 'discount', label: 'Discount', align: 'right' },
          { key: 'start', label: 'Started' },
          { key: 'days', label: 'Days', align: 'right' },
        ],
        rows: summary.top_discounts.map((p) => ({
          product: p.product_name ?? '',
          retailer: `${p.retailer_name} · ${p.market_name}`,
          type: PROMO_TYPE_LABELS[p.promo_type as PromoType] ?? p.promo_type,
          discount: pct(p.max_discount_pct),
          start: fmtDate(p.start_local_date),
          days: p.duration_days,
        })),
      },
    ],
    evidenceFilter: { ...filter, date_from: period.from, date_to: period.to, promo: true },
    links: [{ label: 'Open Promotion Intelligence', href: `/promotions?from=${period.from}&to=${period.to}${plan.ownership !== 'any' ? `&ownership=${plan.ownership}` : ''}` }],
    notes: ['Bundle offers without a stated discount count as promotions but carry no discount percentage.'],
    demoOverride: summary.demo,
  };
}

function promotionFrequency(ctx: AppContext, plan: QueryPlan, scope: Scope, period: ResolvedPeriod): Built {
  const filter = scopeFilter(scope, plan);
  const summary = promotionSummary(ctx, filter, period);
  const subject = scope.productNames.length ? list(scope.productNames, 2) : scope.brandNames.length ? list(scope.brandNames, 3) : plan.ownership === 'competitor' ? 'Competitor brands' : plan.ownership === 'own' ? 'Own brands' : 'All monitored brands';
  if (!summary.kpis.listings_observed) return noData(scope, period, 'observations');
  const k = summary.kpis;
  if (!k.episodes) {
    return {
      status: 'answered',
      paragraphs: [`${subject} ran no promotion between ${fmtDate(period.from)} and ${fmtDate(period.to)} in the stored observations (${plural(k.listings_observed, 'listing')} observed, ${plural(k.observations, 'observation')}).`],
      evidenceFilter: { ...filter, date_from: period.from, date_to: period.to },
      demoOverride: summary.demo,
    };
  }
  const paragraphs = [
    `${subject}: ${plural(k.episodes, 'promotion')} across ${plural(k.listings_with_promo, 'listing')} between ${fmtDate(period.from)} and ${fmtDate(period.to)} — about ${k.frequency_per_listing_30d ?? 'n/a'} promotions per listing per 30 days.`,
    `A promotion lasted ${k.avg_duration_days ?? 'n/a'} days on average${k.avg_days_between !== null ? `, with ${k.avg_days_between} days between the end of one and the start of the next on the same listing` : ''}. ${pct(k.promo_day_share_pct)} of observed listing-days and ${pct(k.promo_observation_share_pct)} of observations showed promotional pricing; the average discount was ${pct(k.avg_discount_pct)}.`,
  ];
  if (k.current) paragraphs.push(`${plural(k.current, 'promotion')} ${k.current === 1 ? 'is' : 'are'} running now.`);
  const multiBrand = summary.by_brand.length > 1 && !scope.productIds.length;
  return {
    status: 'answered',
    paragraphs,
    highlights: [
      { label: 'Promotions', value: k.episodes.toLocaleString('en-GB') },
      { label: 'Per listing / 30 days', value: String(k.frequency_per_listing_30d ?? 'n/a') },
      { label: 'Average duration', value: k.avg_duration_days !== null ? `${k.avg_duration_days} days` : 'n/a' },
      { label: 'Days between promotions', value: k.avg_days_between !== null ? `${k.avg_days_between} days` : 'n/a' },
    ],
    tables: [
      {
        title: multiBrand ? 'Promotion frequency by brand' : 'Promotion frequency by retailer',
        columns: [
          { key: 'name', label: multiBrand ? 'Brand' : 'Retailer' },
          { key: 'episodes', label: 'Promotions', align: 'right' },
          { key: 'current', label: 'Running now', align: 'right' },
          { key: 'avg', label: 'Average discount', align: 'right' },
          { key: 'duration', label: 'Average days', align: 'right' },
          { key: 'share', label: 'Listing-days on promotion', align: 'right' },
        ],
        rows: (multiBrand ? summary.by_brand : summary.by_retailer).slice(0, 30).map((b) => ({
          name: b.label,
          episodes: b.episodes,
          current: b.current,
          avg: pct(b.avg_discount_pct),
          duration: b.avg_duration_days ?? 'n/a',
          share: pct(b.promo_day_share_pct),
        })),
      },
      {
        title: 'By promotion type',
        columns: [
          { key: 'type', label: 'Type' },
          { key: 'episodes', label: 'Promotions', align: 'right' },
          { key: 'avg', label: 'Average discount', align: 'right' },
          { key: 'duration', label: 'Average days', align: 'right' },
        ],
        rows: summary.by_type.map((t) => ({ type: PROMO_TYPE_LABELS[t.key as PromoType] ?? t.label, episodes: t.episodes, avg: pct(t.avg_discount_pct), duration: t.avg_duration_days ?? 'n/a' })),
      },
    ],
    evidenceFilter: { ...filter, date_from: period.from, date_to: period.to },
    links: [{ label: 'Open Promotion Intelligence', href: `/promotions?from=${period.from}&to=${period.to}${filter.brand_ids ? `&brand_id=${filter.brand_ids.join(',')}` : ''}` }],
    notes: ['Frequency counts promotions that started in the period; a promotion is a run of consecutive promotional observations of one listing.'],
    demoOverride: summary.demo,
  };
}

function positioningAnswer(ctx: AppContext, plan: QueryPlan, scope: Scope, period: ResolvedPeriod): Built {
  // the subject is the own side: named own brands / products, otherwise every own brand
  const ownBrandIds = scope.brandIds.filter((id) => ctx.db.get(`SELECT 1 FROM brands WHERE id = ? AND ownership = 'own'`, [id]));
  const competitorOnly = scope.brandIds.length > 0 && ownBrandIds.length === 0;
  const pairFilter = {
    market_ids: scope.marketIds.length ? scope.marketIds : undefined,
    retailer_ids: scope.retailerIds.length ? scope.retailerIds : undefined,
    own_brand_ids: ownBrandIds.length ? ownBrandIds : undefined,
    own_product_ids: scope.productIds.length ? scope.productIds : undefined,
    category_ids: scope.categoryIds.length ? scope.categoryIds : undefined,
  };
  let pairs = latestPairs(ctx, pairFilter);
  if (competitorOnly) pairs = pairs.filter((p) => scope.brandIds.includes(p.comp_brand_id));
  const usable = pairs.filter((p) => p.index !== null);
  const subject = scope.productNames.length ? list(scope.productNames, 2) : ownBrandIds.length ? list(scope.brandNames.filter((_, i) => ownBrandIds.includes(scope.brandIds[i]!)), 3) : 'Own brands';
  if (!usable.length) {
    return {
      status: 'no_data',
      paragraphs: [
        `There is no comparable price pair for ${subject}${scope.marketNames.length ? ` in ${list(scope.marketNames, 3)}` : ''}: positioning needs an approved competitor mapping with both products currently priced at the same retailer.`,
        pairs.length ? `${plural(pairs.length, 'mapped pair')} exist${pairs.length === 1 ? 's' : ''}, but the products are measured in different units (for example grams against millilitres), so no price gap is calculated.` : 'Add or approve competitor mappings in Product Catalogue → Competitor mappings.',
      ],
    };
  }
  const now = positioning(ctx, pairFilter);
  const currentIndex = competitorOnly ? round(mean(usable.map((p) => p.index!)), 1)! : now.overall.index!;
  const history = competitorOnly ? [] : positioningHistory(ctx, pairFilter, period);
  const reading = (index: number) => (Math.abs(index - 100) < 0.5 ? 'at parity with' : index > 100 ? `${pct(index - 100)} above` : `${pct(100 - index)} below`);
  const subjectPlural = subject === 'Own brands' || scope.productNames.length > 1 || ownBrandIds.length > 1;
  const paragraphs = [
    `${subject} ${subjectPlural ? 'are' : 'is'} currently priced ${reading(currentIndex)} mapped competitors${competitorOnly ? ` (${list(scope.brandNames, 3)})` : ''} — a price index of ${currentIndex} where 100 is parity — based on ${plural(usable.length, 'same-retailer price pair')} across ${plural(new Set(usable.map((p) => p.retailer_id)).size, 'retailer')}.`,
  ];
  let chart: AssistantChart | null = null;
  const highlights: AssistantAnswer['highlights'] = [{ label: 'Price index now', value: String(currentIndex), detail: '100 = parity' }];
  if (history.length >= 4) {
    const head = history.slice(0, Math.min(7, Math.floor(history.length / 2)));
    const tail = history.slice(-Math.min(7, Math.floor(history.length / 2)));
    const start = round(mean(head.map((h) => h.index)), 1)!;
    const end = round(mean(tail.map((h) => h.index)), 1)!;
    const delta = round(end - start, 1)!;
    paragraphs.push(
      `Over ${period.label} the index moved from ${start} (average of the first ${head.length} days) to ${end} (last ${tail.length} days): ${Math.abs(delta) < 0.3 ? 'essentially unchanged' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} points, meaning ${subject} became ${delta > 0 ? 'more expensive' : 'cheaper'} relative to competitors`}.`,
    );
    highlights.push({ label: 'Start of period', value: String(start) }, { label: 'End of period', value: String(end) }, { label: 'Change', value: `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta)} pts` });
    chart = {
      title: 'Price index vs mapped competitors',
      subtitle: '100 = parity · above 100 = own is more expensive',
      unit: 'index',
      series: [{ key: 'index', label: subject, points: history.map((h) => ({ date: h.date, value: h.index })) }],
    };
  } else if (!competitorOnly) {
    paragraphs.push(`There are too few days with both sides observed in ${period.label} to describe how the position changed.`);
  }
  const byCompetitor = new Map<string, number[]>();
  for (const p of usable) {
    const arr = byCompetitor.get(p.comp_brand_name);
    if (arr) arr.push(p.index!);
    else byCompetitor.set(p.comp_brand_name, [p.index!]);
  }
  const excluded = pairs.length - usable.length;
  return {
    status: 'answered',
    paragraphs,
    highlights,
    tables: [
      {
        title: 'Current position by competitor brand',
        columns: [
          { key: 'brand', label: 'Competitor brand' },
          { key: 'pairs', label: 'Price pairs', align: 'right' },
          { key: 'index', label: 'Index', align: 'right' },
          { key: 'gap', label: 'Own vs competitor', align: 'right' },
        ],
        rows: [...byCompetitor.entries()]
          .map(([brand, values]) => ({ brand, pairs: values.length, index: round(mean(values), 1)!, gap: pct(round(mean(values)! - 100, 1), true) }))
          .sort((a, b) => b.index - a.index),
      },
      ...(competitorOnly
        ? []
        : [
            {
              title: 'Current position by own brand',
              columns: [
                { key: 'brand', label: 'Own brand' },
                { key: 'pairs', label: 'Price pairs', align: 'right' as const },
                { key: 'index', label: 'Index', align: 'right' as const },
                { key: 'gap', label: 'Own vs competitors', align: 'right' as const },
              ],
              rows: now.by_brand.map((b) => ({ brand: b.label, pairs: b.pairs, index: b.index ?? 'n/a', gap: pct(b.premium_pct, true) })),
            },
          ]),
    ],
    chart,
    evidenceFilter: { listing_ids: [...new Set(usable.flatMap((p) => [p.own_listing_id, p.comp_listing_id]))].slice(0, 500), date_from: period.from, date_to: period.to },
    linkFilter: null,
    links: [{ label: 'Open Competitor Intelligence', href: scope.productIds.length === 1 ? `/competitors?product_id=${scope.productIds[0]}` : '/competitors' }],
    notes: [
      'Each own product is compared with its approved competitor mappings at the same retailer: shelf price for equivalent packs, unit price where pack sizes differ.',
      ...(excluded ? [`${plural(excluded, 'mapped pair')} measured in different units ${excluded === 1 ? 'is' : 'are'} excluded.`] : []),
    ],
    demoOverride: demoNote(usable.map((p) => ({ is_demo: p.is_demo ? 1 : 0 }))),
  };
}

function volatilityAnswer(ctx: AppContext, plan: QueryPlan, scope: Scope, period: ResolvedPeriod, money: ReturnType<typeof moneyFormatter>): Built {
  const filter = scopeFilter(scope, plan, period);
  const limit = Math.min(Math.max(plan.limit ?? 10, 1), 50);
  const rows = volatilityRanking(ctx, filter, { groupBy: 'product', limit });
  if (!rows.length) return noData(scope, period, 'price observations (at least five observed days per listing are needed)');
  const top = rows[0]!;
  const paragraphs = [
    `Between ${fmtDate(period.from)} and ${fmtDate(period.to)}, ${top.label} showed the highest price volatility: ${pct(top.volatility_pct)} (standard deviation relative to its average price), with ${plural(top.price_changes, 'price change')} and a range of ${money(top.min, top.currency)}–${money(top.max, top.currency)}.`,
  ];
  const place = (r: (typeof rows)[number]) => (r.market_name ? ` in ${r.market_name}` : ` (${r.currency})`);
  paragraphs[0] = paragraphs[0]!.replace(`${top.label} showed`, `${top.label}${place(top)} showed`);
  if (rows.length > 1) paragraphs.push(`Next: ${list(rows.slice(1, 4).map((r) => `${r.label}${place(r)} (${pct(r.volatility_pct)})`), 3)}.`);
  return {
    status: 'answered',
    paragraphs,
    tables: [
      {
        title: 'Most volatile products',
        columns: [
          { key: 'product', label: 'Product' },
          { key: 'scope', label: 'Listings · markets' },
          { key: 'currency', label: 'Currency' },
          { key: 'vol', label: 'Volatility', align: 'right' },
          { key: 'changes', label: 'Price changes', align: 'right' },
          { key: 'min', label: 'Lowest', align: 'right' },
          { key: 'max', label: 'Highest', align: 'right' },
        ],
        rows: rows.map((r) => ({ product: r.label, scope: r.sublabel ?? '', currency: r.currency, vol: pct(r.volatility_pct), changes: r.price_changes, min: money(r.min, null), max: money(r.max, null) })),
      },
    ],
    evidenceFilter: filter,
    links: [{ label: 'Open the volatility ranking in the Historical Price Explorer', href: historyLink(filter).href }],
    notes: ['Volatility is the coefficient of variation of daily selling prices; promotional price cuts count as movement. Products are ranked within their own currency.'],
    demoOverride: demoNote(rows.map((r) => ({ is_demo: r.is_demo ? 1 : 0 }))),
  };
}

function crossMarket(ctx: AppContext, scope: Scope, money: ReturnType<typeof moneyFormatter>): Built {
  const currency = getSetting(ctx, 'reporting_currency');
  const result = crossMarketProduct(ctx, scope.productIds[0]!, { currency });
  const priced = result.rows.filter((r) => r.native);
  if (!priced.length) return noData(scope, null, 'current prices in any market');
  const converted = priced.filter((r) => r.converted?.avg !== null && r.converted?.avg !== undefined).sort((a, b) => a.converted!.avg! - b.converted!.avg!);
  const paragraphs = [`${result.product.name} is currently priced in ${plural(priced.length, 'market')}.`];
  if (converted.length >= 2) {
    const low = converted[0]!;
    const high = converted[converted.length - 1]!;
    paragraphs.push(
      `Converted to ${currency}, it is cheapest in ${low.market_name} at ${money(low.converted!.avg, currency)} (${money(low.native!.avg, low.currency_code)}) and most expensive in ${high.market_name} at ${money(high.converted!.avg, currency)} (${money(high.native!.avg, high.currency_code)}) — a spread of ${pct(((high.converted!.avg! - low.converted!.avg!) / low.converted!.avg!) * 100)}.`,
    );
  }
  const rates = priced.map((r) => r.conversion).filter((c): c is NonNullable<typeof c> => !!c && c.from !== c.to);
  const notes = [...result.notes];
  if (rates.length) {
    notes.unshift(
      `Exchange rates used (as of ${fmtDate(rates.map((r) => r.as_of).sort()[0])}, source: ${[...new Set(rates.flatMap((r) => r.sources))].join(', ')}): ${rates.map((r) => `1 ${r.from} = ${r.rate >= 1 ? r.rate.toFixed(4) : r.rate.toPrecision(4)} ${r.to}`).join('; ')}.`,
    );
  }
  return {
    status: 'answered',
    paragraphs,
    tables: [
      {
        title: `Latest average price by market (converted to ${currency})`,
        columns: [
          { key: 'market', label: 'Market' },
          { key: 'retailers', label: 'Retailers', align: 'right' },
          { key: 'native', label: 'Local average', align: 'right' },
          { key: 'converted', label: `In ${currency}`, align: 'right' },
          { key: 'unit', label: `Unit price (${currency} ${result.product.unit_basis ?? ''})`, align: 'right' },
          { key: 'index', label: 'Index', align: 'right' },
          { key: 'promo', label: 'On promotion', align: 'right' },
        ],
        rows: result.rows.map((r) => ({
          market: r.market_name,
          retailers: r.retailers,
          native: r.native ? money(r.native.avg, r.currency_code) : 'no fresh price',
          converted: money(r.converted?.avg, null),
          unit: money(r.converted?.unit_avg, null),
          index: r.index ?? 'n/a',
          promo: r.on_promo,
        })),
        note: result.base_market_id ? `Index: ${result.rows.find((r) => r.market_id === result.base_market_id)?.market_name} = 100.` : null,
      },
    ],
    evidenceFilter: { product_ids: scope.productIds, date_from: result.period.from, date_to: result.period.to },
    links: [{ label: 'Open the cross-market comparison', href: `/markets?view=cross&product_id=${scope.productIds[0]}` }],
    notes,
    demoOverride: result.demo,
  };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------
export function executePlan(ctx: AppContext, plan: QueryPlan, catalogue: Catalogue, today: string, clarification: string | null = null): AnswerCore {
  const scope = resolveScope(plan, catalogue);
  const needsPeriod = !['current_prices', 'lowest_price', 'cross_market', 'unsupported'].includes(plan.intent);
  const period = needsPeriod ? resolvePeriod(plan, today) : null;
  const money = moneyFormatter(ctx);
  const interpretation: AnswerCore['interpretation'] = { intent: plan.intent, summary: scopeSummary(plan, scope, period), plan, unresolved: scope.unresolved };
  /** Statements that must lead the answer (e.g. a named retailer that is not monitored). */
  const preface: string[] = [];
  const finish = (built: Built): AnswerCore => {
    const notes = [...(built.notes ?? [])];
    let evidence: AssistantEvidence | null = null;
    let demo: DemoNote | null = built.demoOverride ?? null;
    if (built.evidenceFilter) {
      const e = buildEvidence(ctx, built.evidenceFilter, built.links, built.linkFilter);
      evidence = e.evidence;
      demo = built.demoOverride ?? e.demo;
    }
    const paragraphs = [...preface, ...built.paragraphs];
    if (built.status === 'answered' && evidence?.observations) paragraphs.push(sourceSentence(evidence));
    if (demo?.any_demo) paragraphs.push(demo.all_demo ? DEMO_SENTENCE : 'Part of this answer rests on the illustrative DEMO dataset; those records are marked DEMO.');
    if (scope.unresolved.length) notes.unshift(`Not recognised in the catalogue and therefore ignored: ${scope.unresolved.join(', ')}.`);
    return {
      status: built.status,
      answer: paragraphs.filter(Boolean).join('\n\n'),
      highlights: built.highlights ?? [],
      tables: (built.tables ?? []).filter((t) => t.rows.length > 0),
      chart: built.chart && built.chart.series.some((s) => s.points.length > 1) ? built.chart : null,
      evidence,
      notes,
      demo,
      interpretation,
    };
  };

  if (clarification) return finish({ status: 'needs_clarification', paragraphs: [clarification] });
  if (plan.intent === 'unsupported') {
    return finish({
      status: 'unsupported',
      paragraphs: [
        plan.reason ?? 'This question cannot be answered from the stored price records.',
        'Nothing has been assumed or estimated. Try asking about a product, brand, retailer or market that is being monitored.',
      ],
    });
  }
  const needsProduct = ['price_history', 'lowest_price', 'cross_market'].includes(plan.intent) || (plan.intent === 'current_prices' && !scope.brandIds.length && !scope.categoryIds.length);
  if (needsProduct && !scope.productIds.length) {
    const hint = scope.brandIds.length
      ? ` Products of ${list(scope.brandNames, 2)}: ${list(catalogue.products.filter((p) => scope.brandIds.includes(p.brand_id)).map((p) => p.name), 6)}.`
      : '';
    return finish({
      status: 'needs_clarification',
      paragraphs: [
        plan.products.length
          ? `I could not find a product matching "${plan.products.join('", "')}" in the catalogue, so there is no price to report.${hint}`
          : `Which product do you mean? Name it as it appears in the catalogue and ask again.${hint}`,
      ],
    });
  }
  // A named retailer or market that is not monitored is never silently widened to "everything".
  const unknownRetailers = resolveRetailers(catalogue, plan.retailers, scope.marketIds).unresolved;
  if (unknownRetailers.length && scope.retailerIds.length) {
    preface.push(`No monitored retailer matches "${unknownRetailers.join('", "')}" — there is no data for it. The answer below covers ${list(scope.retailerNames, 4)} only.`);
  } else if (plan.retailers.length && (unknownRetailers.length || !scope.retailerIds.length)) {
    return finish({
      status: 'no_data',
      paragraphs: [
        `No monitored retailer matches "${(unknownRetailers.length ? unknownRetailers : plan.retailers).join('", "')}"${scope.marketNames.length ? ` in ${list(scope.marketNames, 3)}` : ''}, so no observation exists for it. The data is unavailable.`,
        'Retailers are added in Administration → Retailers; prices appear here once observations have been collected, imported or entered for them.',
      ],
    });
  }
  const unknownMarkets = resolveMarkets(catalogue, plan.markets).unresolved;
  if (unknownMarkets.length && scope.marketIds.length) {
    preface.push(`"${unknownMarkets.join('", "')}" is not a configured market — there is no data for it. The answer below covers ${list(scope.marketNames, 4)} only.`);
  } else if (plan.markets.length && (unknownMarkets.length || !scope.marketIds.length)) {
    return finish({
      status: 'no_data',
      paragraphs: [`"${(unknownMarkets.length ? unknownMarkets : plan.markets).join('", "')}" is not a configured market, so no observation exists for it. The data is unavailable.`],
    });
  }

  switch (plan.intent) {
    case 'price_history':
      return finish(priceHistory(ctx, plan, scope, period!, money));
    case 'current_prices':
      return finish(currentPrices(ctx, plan, scope, money, false));
    case 'lowest_price':
      return finish(currentPrices(ctx, plan, scope, money, true));
    case 'price_changes':
      return finish(priceChanges(ctx, plan, scope, period!, money));
    case 'discount_ranking':
      return finish(discountRanking(ctx, plan, scope, period!));
    case 'promotion_frequency':
      return finish(promotionFrequency(ctx, plan, scope, period!));
    case 'positioning':
      return finish(positioningAnswer(ctx, plan, scope, period!));
    case 'volatility':
      return finish(volatilityAnswer(ctx, plan, scope, period!, money));
    case 'cross_market':
      return finish(crossMarket(ctx, scope, money));
  }
}

/** Counts used by the status endpoint to say honestly what the assistant can draw on. */
export function ledgerFacts(ctx: AppContext): { observations: number; products: number; retailers: number } {
  return {
    observations: ctx.db.scalar<number>('SELECT COUNT(*) FROM v_observations') ?? 0,
    products: ctx.db.scalar<number>(`SELECT COUNT(*) FROM products WHERE status <> 'archived'`) ?? 0,
    retailers: ctx.db.scalar<number>('SELECT COUNT(*) FROM retailers WHERE is_active = 1') ?? 0,
  };
}
