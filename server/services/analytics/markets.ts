/**
 * Market intelligence: per-market coverage and health, and cross-market price comparison.
 * Cross-market figures are always normalised: currency via a stated exchange rate (rate, timestamp, source)
 * and pack size via unit prices.
 */
import type { AppContext } from '../../context.ts';
import { notFound } from '../../lib/errors.ts';
import { makeConverter, type Conversion } from '../fx.ts';
import {
  ageHoursSql, basisLabel, demoNote, lastDays, loadListings, marketToday, mean, packLabel, round, STALE_HOURS_SQL, type DateRange, type DemoNote,
} from './common.ts';
import { latestPairs, positioning } from './competitors.ts';
import { dailySeries } from './history.ts';
import { monitorRowsFor } from './monitor.ts';
import { zonedParts } from '../../lib/time.ts';
import type { RunStats, MarketOverviewRow, CrossMarketRow, CrossMarketProductResult, CrossMarketGroupRow } from '../../../shared/api/analytics.ts';
export type { RunStats, MarketOverviewRow, CrossMarketRow, CrossMarketProductResult, CrossMarketGroupRow };

const emptyRuns = (): RunStats => ({ runs: 0, succeeded: 0, partial: 0, failed: 0, not_configured: 0, success_rate_pct: null });

export function runStats(rows: Array<{ status: string; n: number }>): RunStats {
  const out = emptyRuns();
  for (const r of rows) {
    if (r.status === 'succeeded') out.succeeded += r.n;
    else if (r.status === 'partial') out.partial += r.n;
    else if (r.status === 'failed') out.failed += r.n;
    else if (r.status === 'not_configured') out.not_configured += r.n;
  }
  out.runs = out.succeeded + out.partial + out.failed;
  out.success_rate_pct = out.runs ? round(((out.succeeded + out.partial) / out.runs) * 100, 1) : null;
  return out;
}

function localClock(timezone: string, now: Date): string {
  const p = zonedParts(now, timezone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function marketOverview(ctx: AppContext, days = 30): MarketOverviewRow[] {
  const { db } = ctx;
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const markets = db.all<{
    id: number; code: string; name: string; country_name: string; region: string | null; currency_code: string; timezone: string;
    default_frequency: string; is_active: number;
  }>('SELECT id, code, name, country_name, region, currency_code, timezone, default_frequency, is_active FROM markets ORDER BY sort_order, name');

  const retailers = db.all<{ market_id: number; collection_method: string; frequency: string; is_enabled: number; is_demo: number; n: number }>(
    `SELECT r.market_id, r.collection_method, COALESCE(r.collection_frequency, m.default_frequency) AS frequency, r.is_enabled, r.is_demo, COUNT(*) AS n
     FROM retailers r JOIN markets m ON m.id = r.market_id WHERE r.is_active = 1
     GROUP BY r.market_id, r.collection_method, frequency, r.is_enabled, r.is_demo`,
  );
  const listingStats = db.all<{
    market_id: number; active: number; observed: number; stale: number; never_observed: number; on_promo: number; unmatched: number;
    last_observation_at: string | null; demo: number;
  }>(
    // Freshness is counted over listings matched to a catalogue product (the same population as the overview KPIs);
    // listings still waiting to be matched are reported separately.
    `SELECT li.market_id, SUM(li.product_id IS NOT NULL) AS active,
       SUM(li.product_id IS NOT NULL AND s.last_observed_at IS NOT NULL) AS observed,
       SUM(CASE WHEN li.product_id IS NOT NULL AND s.last_observed_at IS NOT NULL AND ${ageHoursSql('s.last_observed_at')} > ${STALE_HOURS_SQL} THEN 1 ELSE 0 END) AS stale,
       SUM(li.product_id IS NOT NULL AND s.last_observed_at IS NULL) AS never_observed,
       SUM(CASE WHEN li.product_id IS NOT NULL AND o.is_promo = 1 AND ${ageHoursSql('s.last_observed_at')} <= ${STALE_HOURS_SQL} THEN 1 ELSE 0 END) AS on_promo,
       SUM(li.product_id IS NULL) AS unmatched,
       MAX(s.last_observed_at) AS last_observation_at,
       SUM(li.listing_is_demo) AS demo
     FROM v_listing_info li
     LEFT JOIN listing_state s ON s.listing_id = li.listing_id
     LEFT JOIN price_observations o ON o.id = s.latest_obs_id
     WHERE li.listing_active = 1 AND li.retailer_active = 1
     GROUP BY li.market_id`,
  );
  const products = db.all<{ market_id: number; ownership: string; n: number }>(
    `SELECT li.market_id, li.ownership, COUNT(DISTINCT li.product_id) AS n FROM v_listing_info li
     WHERE li.listing_active = 1 AND li.retailer_active = 1 AND li.product_id IS NOT NULL GROUP BY li.market_id, li.ownership`,
  );
  const events = db.all<{ market_id: number; direction: string; n: number }>(
    `SELECT market_id, direction, COUNT(*) AS n FROM price_events WHERE kind = 'price_change' AND occurred_at >= ? GROUP BY market_id, direction`,
    [since],
  );
  const jobs = db.all<{ market_id: number; data_class: string; status: string; n: number }>(
    `SELECT r.market_id, j.data_class, j.status, COUNT(*) AS n FROM collection_jobs j JOIN retailers r ON r.id = j.retailer_id
     WHERE j.created_at >= ? GROUP BY r.market_id, j.data_class, j.status`,
    [since],
  );
  const position = new Map(positioning(ctx).by_market.map((g) => [g.key, g]));
  const pairs = latestPairs(ctx);
  const ownListed = db.all<{ market_id: number; n: number }>(
    `SELECT li.market_id, COUNT(DISTINCT li.product_id) AS n FROM v_listing_info li
     WHERE li.listing_active = 1 AND li.retailer_active = 1 AND li.ownership = 'own' GROUP BY li.market_id`,
  );

  return markets.map((m) => {
    const rs = retailers.filter((r) => r.market_id === m.id);
    const byMethod: Record<string, number> = {};
    const byFrequency: Record<string, number> = {};
    for (const r of rs) {
      byMethod[r.collection_method] = (byMethod[r.collection_method] ?? 0) + r.n;
      byFrequency[r.frequency] = (byFrequency[r.frequency] ?? 0) + r.n;
    }
    const total = rs.reduce((acc, r) => acc + r.n, 0);
    const ls = listingStats.find((l) => l.market_id === m.id);
    const active = ls?.active ?? 0;
    const observed = ls?.observed ?? 0;
    const stale = ls?.stale ?? 0;
    const never = ls?.never_observed ?? 0;
    const real = runStats(jobs.filter((j) => j.market_id === m.id && j.data_class === 'real'));
    const simulated = runStats(jobs.filter((j) => j.market_id === m.id && j.data_class === 'simulated'));
    const pos = position.get(`M${m.id}`);
    const withCompetitor = new Set(pairs.filter((p) => p.market_id === m.id && p.index !== null).map((p) => p.own_product_id)).size;

    let status: MarketOverviewRow['status'] = 'healthy';
    let reason = 'Observations are fresh for the configured schedule.';
    if (!m.is_active) {
      status = 'inactive';
      reason = 'Market is switched off.';
    } else if (total === 0) {
      status = 'no_data';
      reason = 'No retailers configured for this market yet.';
    } else if (active === 0) {
      status = 'no_data';
      reason = 'Retailers exist but no product listings are configured.';
    } else if (observed === 0) {
      status = 'no_data';
      reason = 'No price observation has been captured yet.';
    } else if ((stale + never) / active > 0.25) {
      status = 'attention';
      reason = `${stale + never} of ${active} listings have no fresh observation.`;
    } else if (real.runs > 0 && real.success_rate_pct !== null && real.success_rate_pct < 80) {
      status = 'attention';
      reason = `Collection success rate is ${real.success_rate_pct}% over the last ${days} days.`;
    } else if (stale + never > 0) {
      reason = `${stale + never} of ${active} listings have no fresh observation.`;
    }
    return {
      id: m.id,
      code: m.code,
      name: m.name,
      country_name: m.country_name,
      region: m.region,
      currency_code: m.currency_code,
      timezone: m.timezone,
      local_time: localClock(m.timezone, now),
      default_frequency: m.default_frequency,
      is_active: m.is_active === 1,
      retailers: {
        total,
        enabled: rs.filter((r) => r.is_enabled).reduce((acc, r) => acc + r.n, 0),
        paused: rs.filter((r) => !r.is_enabled).reduce((acc, r) => acc + r.n, 0),
        demo: rs.filter((r) => r.is_demo).reduce((acc, r) => acc + r.n, 0),
        by_method: byMethod,
        by_frequency: byFrequency,
      },
      listings: { active, observed, fresh: observed - stale, stale, never_observed: never, on_promo: ls?.on_promo ?? 0, unmatched: ls?.unmatched ?? 0 },
      products: {
        own: products.find((p) => p.market_id === m.id && p.ownership === 'own')?.n ?? 0,
        competitor: products.find((p) => p.market_id === m.id && p.ownership === 'competitor')?.n ?? 0,
      },
      last_observation_at: ls?.last_observation_at ?? null,
      events: {
        increases: events.find((e) => e.market_id === m.id && e.direction === 'up')?.n ?? 0,
        decreases: events.find((e) => e.market_id === m.id && e.direction === 'down')?.n ?? 0,
      },
      collection: { real, simulated },
      position: pos ? { index: pos.index, premium_pct: pos.premium_pct, pairs: pos.pairs } : null,
      mapping_coverage: { own_products_listed: ownListed.find((o) => o.market_id === m.id)?.n ?? 0, with_competitor_price: withCompetitor },
      status,
      status_reason: reason,
      demo_only: active > 0 && (ls?.demo ?? 0) === active,
    };
  });
}

/** One product across markets: latest prices normalised to a single currency and to unit price. */
export function crossMarketProduct(
  ctx: AppContext,
  productId: number,
  options: { currency: string; days?: number; baseMarketId?: number },
): CrossMarketProductResult {
  const product = ctx.db.get<{
    id: number; code: string; name: string; brand_name: string; ownership: string; pack_size: number | null; pack_unit: string | null; units_per_pack: number; is_demo: number;
  }>(
    `SELECT p.id, p.code, p.name, b.name AS brand_name, b.ownership, p.pack_size, p.pack_unit, p.units_per_pack, p.is_demo
     FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id = ?`,
    [productId],
  );
  if (!product) throw notFound('Product');
  const today = marketToday(ctx);
  const period = lastDays(today, Math.min(Math.max(options.days ?? 30, 1), 365));
  // Pack variants are left out so every market compares the same pack.
  const snapshot = monitorRowsFor(ctx, { product_ids: [productId] }).filter((s) => !s.variant_name);
  const converter = makeConverter(ctx, options.currency);
  const daily = snapshot.length
    ? dailySeries(ctx, { listing_ids: snapshot.map((s) => s.listing_id), date_from: period.from, date_to: period.to })
    : [];
  const periodByMarket = new Map<number, number[]>();
  const marketOf = new Map(snapshot.map((s) => [s.listing_id, s.market_id]));
  for (const d of daily) {
    if (d.current_price === null) continue;
    const marketId = marketOf.get(d.listing_id)!;
    const list = periodByMarket.get(marketId);
    if (list) list.push(d.current_price);
    else periodByMarket.set(marketId, [d.current_price]);
  }

  const groups = new Map<number, typeof snapshot>();
  for (const s of snapshot) {
    const list = groups.get(s.market_id);
    if (list) list.push(s);
    else groups.set(s.market_id, [s]);
  }
  const rows: CrossMarketRow[] = [...groups.entries()].map(([marketId, list]) => {
    const first = list[0]!;
    const priced = list.filter((l) => l.current_price !== null && l.is_stale === 0);
    const prices = priced.map((l) => l.current_price!);
    const units = priced.map((l) => l.unit_price).filter((u): u is number => u !== null);
    const conversion = converter.conversion(first.currency_code);
    const conv = (v: number | null) => (v === null || !conversion ? null : round(v * conversion.rate, 4));
    const native = prices.length
      ? { avg: round(mean(prices), 4)!, min: Math.min(...prices), max: Math.max(...prices), unit_avg: round(mean(units), 4) }
      : null;
    const periodAvg = mean(periodByMarket.get(marketId) ?? []);
    return {
      market_id: marketId,
      market_code: first.market_code,
      market_name: first.market_name,
      currency_code: first.currency_code,
      retailers: new Set(list.map((l) => l.retailer_id)).size,
      listings: list.length,
      native,
      converted: native ? { avg: conv(native.avg), min: conv(native.min), max: conv(native.max), unit_avg: conv(native.unit_avg) } : null,
      period_avg_converted: conv(periodAvg),
      on_promo: priced.filter((l) => l.is_promo === 1).length,
      last_observed_at: list.map((l) => l.observed_at).filter(Boolean).sort().pop() ?? null,
      index: null,
      conversion,
      is_demo: list.some((l) => l.is_demo === 1),
    };
  });
  rows.sort((a, b) => a.market_name.localeCompare(b.market_name));
  const base =
    rows.find((r) => r.market_id === options.baseMarketId && r.converted?.avg) ?? rows.find((r) => r.market_code === 'AE' && r.converted?.avg) ?? rows.find((r) => r.converted?.avg) ?? null;
  if (base?.converted?.avg) {
    for (const r of rows) r.index = r.converted?.avg ? round((r.converted.avg / base.converted.avg) * 100, 1) : null;
  }
  const notes: string[] = [];
  if (converter.missing().length) notes.push(`No exchange rate is available for ${converter.missing().join(', ')} — those markets are shown in local currency only.`);
  if (rows.some((r) => r.conversion?.is_demo)) notes.push('Conversions use ILLUSTRATIVE demo exchange rates. Record real rates in Administration → Exchange rates.');
  if (rows.some((r) => r.listings > 0 && !r.native)) notes.push('Markets without a fresh price are listed without a current value.');
  const dimension = product.pack_unit === 'ml' || product.pack_unit === 'l' ? 'volume' : product.pack_unit === 'g' || product.pack_unit === 'kg' ? 'mass' : product.pack_unit === 'unit' ? 'count' : null;
  return {
    product: {
      id: product.id, code: product.code, name: product.name, brand_name: product.brand_name, ownership: product.ownership, pack: packLabel(product),
      unit_basis: basisLabel(dimension) || null, is_demo: product.is_demo === 1,
    },
    currency: options.currency,
    base_market_id: base?.market_id ?? null,
    period,
    rows,
    missing_rates: converter.missing(),
    notes,
    demo: demoNote(snapshot),
  };
}

/** A category or brand across markets: average unit price of own vs competitor listings, in one currency. */
export function crossMarketGroup(
  ctx: AppContext,
  scope: { category_ids?: number[]; brand_ids?: number[] },
  currency: string,
): { currency: string; rows: CrossMarketGroupRow[]; missing_rates: string[]; notes: string[]; demo: DemoNote } {
  const snapshot = monitorRowsFor(ctx, { category_ids: scope.category_ids, brand_ids: scope.brand_ids }).filter(
    (s) => s.current_price !== null && s.unit_price !== null && s.is_stale === 0 && s.ownership,
  );
  const info = loadListings(ctx, snapshot.map((s) => s.listing_id));
  const converter = makeConverter(ctx, currency);
  interface Acc {
    values: number[];
    products: Set<number>;
    listings: number;
  }
  const groups = new Map<string, { first: (typeof snapshot)[number]; basis: string; own: Acc; competitor: Acc; demo: boolean }>();
  for (const s of snapshot) {
    const li = info.get(s.listing_id);
    if (!li || !li.content_dimension) continue;
    const converted = converter.convert(s.unit_price, s.currency_code);
    if (converted === null) continue;
    const basis = basisLabel(li.content_dimension);
    const key = `${s.market_id}|${basis}`;
    let g = groups.get(key);
    if (!g) {
      g = { first: s, basis, own: { values: [], products: new Set(), listings: 0 }, competitor: { values: [], products: new Set(), listings: 0 }, demo: false };
      groups.set(key, g);
    }
    const side = s.ownership === 'own' ? g.own : g.competitor;
    side.values.push(converted);
    side.products.add(s.product_id!);
    side.listings++;
    if (s.is_demo) g.demo = true;
  }
  const side = (acc: Acc) => (acc.values.length ? { unit_avg: round(mean(acc.values), 4)!, products: acc.products.size, listings: acc.listings } : null);
  const rows: CrossMarketGroupRow[] = [...groups.values()]
    .map((g) => {
      const own = side(g.own);
      const competitor = side(g.competitor);
      return {
        market_id: g.first.market_id,
        market_code: g.first.market_code,
        market_name: g.first.market_name,
        currency_code: g.first.currency_code,
        basis: g.basis,
        own,
        competitor,
        index: own && competitor && competitor.unit_avg > 0 ? round((own.unit_avg / competitor.unit_avg) * 100, 1) : null,
        conversion: converter.conversion(g.first.currency_code),
        is_demo: g.demo,
      };
    })
    .sort((a, b) => a.market_name.localeCompare(b.market_name) || a.basis.localeCompare(b.basis));
  const notes = [
    'Averages cover every listed product in the scope (not only mapped pairs), so they describe the price level of the assortment rather than like-for-like gaps.',
  ];
  if (converter.missing().length) notes.push(`No exchange rate is available for ${converter.missing().join(', ')} — those markets are omitted.`);
  if (rows.some((r) => r.conversion?.is_demo)) notes.push('Conversions use ILLUSTRATIVE demo exchange rates. Record real rates in Administration → Exchange rates.');
  return { currency, rows, missing_rates: converter.missing(), notes, demo: demoNote(snapshot) };
}
