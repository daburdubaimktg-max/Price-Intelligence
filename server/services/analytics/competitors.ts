/**
 * Competitor intelligence: own products against their mapped competitor products.
 *
 * Rules
 *   * Only APPROVED mappings are compared unless suggestions are explicitly requested.
 *   * A comparison is made within the same retailer (same shelf, same currency) whenever both are listed there.
 *   * "Equivalent" mappings with the same pack content compare shelf prices like-for-like; everything else is
 *     compared on unit price (per 100 ml / 100 g / unit) and labelled NON-EQUIVALENT.
 *   * Products measured in different dimensions (ml vs g) are never given a unit-price gap.
 *   * gap_pct > 0 means the own product is more expensive than the competitor.
 */
import type { AppContext } from '../../context.ts';
import type { SqlValue } from '../../db/sqlite.ts';
import { placeholders } from '../../db/sqlite.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import { makeConverter, type Conversion } from '../fx.ts';
import {
  basisLabel, computeStats, demoNote, lastDays, loadListings, marketToday, mean, packLabel, round, unitPriceOf, type DateRange, type DemoNote,
} from './common.ts';
import { dailySeries } from './history.ts';
import { monitorRowsFor, type MonitorRow } from './monitor.ts';
import type { GapBasis, PairRow, PositionGroup, Positioning, OwnProductPosition, CompareListingRow, CompetitorSummary, CompetitorCompareResult as CompareResult } from '../../../shared/api/analytics.ts';
export type { GapBasis, PairRow, PositionGroup, Positioning, OwnProductPosition, CompareListingRow, CompetitorSummary, CompareResult };

export interface PairFilter {
  market_ids?: number[];
  retailer_ids?: number[];
  own_brand_ids?: number[];
  category_ids?: number[];
  own_product_ids?: number[];
  includeSuggested?: boolean;
  /** Ignore prices older than this many days (stale prices do not describe the current position). */
  maxAgeDays?: number;
}

interface RawPair {
  mapping_id: number;
  equivalence: 'equivalent' | 'comparable';
  mapping_status: string;
  own_listing_id: number;
  comp_listing_id: number;
  own_product_id: number;
  own_product_name: string;
  own_brand_id: number;
  own_brand_name: string;
  own_category_id: number | null;
  own_category_name: string | null;
  comp_product_id: number;
  comp_product_name: string;
  comp_brand_id: number;
  comp_brand_name: string;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_name: string;
  currency_code: string;
  own_price: number;
  comp_price: number;
  own_content: number | null;
  comp_content: number | null;
  own_dimension: 'volume' | 'mass' | 'count' | null;
  comp_dimension: 'volume' | 'mass' | 'count' | null;
  own_unit_factor: number | null;
  comp_unit_factor: number | null;
  own_pack_size: number | null;
  own_pack_unit: string | null;
  own_units_per_pack: number;
  comp_pack_size: number | null;
  comp_pack_unit: string | null;
  comp_units_per_pack: number;
  own_is_promo: number;
  comp_is_promo: number;
  own_observed_at: string;
  comp_observed_at: string;
  own_is_demo: number;
  comp_is_demo: number;
}

/** Decides how two packs may be compared. */
export function comparisonBasis(
  equivalence: 'equivalent' | 'comparable',
  own: { content: number | null; dimension: string | null },
  comp: { content: number | null; dimension: string | null },
): GapBasis {
  if (!own.content || !comp.content || !own.dimension || !comp.dimension || own.dimension !== comp.dimension) return 'not_comparable';
  const sameContent = Math.abs(own.content - comp.content) / comp.content <= 0.01;
  return equivalence === 'equivalent' && sameContent ? 'shelf' : 'unit';
}

/** Every (own listing, competitor listing) pair at the same retailer, with the latest prices of both. */
export function latestPairs(ctx: AppContext, filter: PairFilter = {}): PairRow[] {
  const conditions: string[] = [
    filter.includeSuggested ? `cm.status IN ('approved', 'suggested')` : `cm.status = 'approved'`,
    '(cm.market_id IS NULL OR cm.market_id = own.market_id)',
    'oo.current_price IS NOT NULL',
    'co.current_price IS NOT NULL',
    'own.listing_active = 1 AND comp.listing_active = 1 AND own.retailer_active = 1',
  ];
  const params: SqlValue[] = [];
  const inList = (column: string, values?: number[]) => {
    if (!values?.length) return;
    conditions.push(`${column} IN (${placeholders(values.length)})`);
    params.push(...values);
  };
  inList('own.market_id', filter.market_ids);
  inList('own.retailer_id', filter.retailer_ids);
  inList('own.brand_id', filter.own_brand_ids);
  inList('cm.own_product_id', filter.own_product_ids);
  if (filter.category_ids?.length) {
    const ph = placeholders(filter.category_ids.length);
    conditions.push(`(own.category_id IN (${ph}) OR own.subcategory_id IN (${ph}))`);
    params.push(...filter.category_ids, ...filter.category_ids);
  }
  const maxAge = filter.maxAgeDays ?? 30;
  const cutoff = new Date(Date.now() - maxAge * 86_400_000).toISOString();
  conditions.push('oo.observed_at >= ? AND co.observed_at >= ?');
  params.push(cutoff, cutoff);

  const raw = ctx.db.all<RawPair>(
    `SELECT cm.id AS mapping_id, cm.equivalence, cm.status AS mapping_status,
       own.listing_id AS own_listing_id, comp.listing_id AS comp_listing_id,
       own.product_id AS own_product_id, own.product_name AS own_product_name, own.brand_id AS own_brand_id, own.brand_name AS own_brand_name,
       COALESCE(own.subcategory_id, own.category_id) AS own_category_id, COALESCE(own.subcategory_name, own.category_name) AS own_category_name,
       comp.product_id AS comp_product_id, comp.product_name AS comp_product_name, comp.brand_id AS comp_brand_id, comp.brand_name AS comp_brand_name,
       own.retailer_id, own.retailer_name, own.market_id, own.market_name, own.currency_code,
       oo.current_price AS own_price, co.current_price AS comp_price,
       own.content_amount AS own_content, comp.content_amount AS comp_content,
       own.content_dimension AS own_dimension, comp.content_dimension AS comp_dimension,
       own.unit_factor AS own_unit_factor, comp.unit_factor AS comp_unit_factor,
       own.pack_size AS own_pack_size, own.pack_unit AS own_pack_unit, own.units_per_pack AS own_units_per_pack,
       comp.pack_size AS comp_pack_size, comp.pack_unit AS comp_pack_unit, comp.units_per_pack AS comp_units_per_pack,
       oo.is_promo AS own_is_promo, co.is_promo AS comp_is_promo,
       oo.observed_at AS own_observed_at, co.observed_at AS comp_observed_at,
       oo.is_demo AS own_is_demo, co.is_demo AS comp_is_demo
     FROM competitor_mappings cm
     JOIN v_listing_info own ON own.product_id = cm.own_product_id
     JOIN v_listing_info comp ON comp.product_id = cm.competitor_product_id AND comp.retailer_id = own.retailer_id
     JOIN listing_state os ON os.listing_id = own.listing_id
     JOIN price_observations oo ON oo.id = os.latest_obs_id
     JOIN listing_state cs ON cs.listing_id = comp.listing_id
     JOIN price_observations co ON co.id = cs.latest_obs_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY own.product_name, comp.product_name, own.market_name, own.retailer_name`,
    params,
  );
  return raw.map((r) => {
    const basis = comparisonBasis(r.equivalence, { content: r.own_content, dimension: r.own_dimension }, { content: r.comp_content, dimension: r.comp_dimension });
    const ownUnit = unitPriceOf(r.own_price, { content_amount: r.own_content, unit_factor: r.own_unit_factor });
    const compUnit = unitPriceOf(r.comp_price, { content_amount: r.comp_content, unit_factor: r.comp_unit_factor });
    let index: number | null = null;
    let gapAbs: number | null = null;
    if (basis === 'shelf' && r.comp_price > 0) {
      index = (r.own_price / r.comp_price) * 100;
      gapAbs = r.own_price - r.comp_price;
    } else if (basis === 'unit' && ownUnit !== null && compUnit !== null && compUnit > 0) {
      index = (ownUnit / compUnit) * 100;
      gapAbs = ownUnit - compUnit;
    }
    return {
      mapping_id: r.mapping_id,
      equivalence: r.equivalence,
      mapping_status: r.mapping_status,
      own_listing_id: r.own_listing_id,
      comp_listing_id: r.comp_listing_id,
      own_product_id: r.own_product_id,
      own_product_name: r.own_product_name,
      own_brand_id: r.own_brand_id,
      own_brand_name: r.own_brand_name,
      own_category_id: r.own_category_id,
      own_category_name: r.own_category_name,
      comp_product_id: r.comp_product_id,
      comp_product_name: r.comp_product_name,
      comp_brand_id: r.comp_brand_id,
      comp_brand_name: r.comp_brand_name,
      retailer_id: r.retailer_id,
      retailer_name: r.retailer_name,
      market_id: r.market_id,
      market_name: r.market_name,
      currency_code: r.currency_code,
      own_price: r.own_price,
      comp_price: r.comp_price,
      own_unit_price: round(ownUnit, 4),
      comp_unit_price: round(compUnit, 4),
      own_pack: packLabel({ pack_size: r.own_pack_size, pack_unit: r.own_pack_unit, units_per_pack: r.own_units_per_pack }),
      comp_pack: packLabel({ pack_size: r.comp_pack_size, pack_unit: r.comp_pack_unit, units_per_pack: r.comp_units_per_pack }),
      unit_basis: r.own_dimension === r.comp_dimension ? basisLabel(r.own_dimension) : null,
      own_is_promo: r.own_is_promo,
      comp_is_promo: r.comp_is_promo,
      own_observed_at: r.own_observed_at,
      comp_observed_at: r.comp_observed_at,
      basis,
      index: round(index, 1),
      gap_pct: index === null ? null : round(index - 100, 1),
      gap_abs: round(gapAbs, 4),
      is_demo: r.own_is_demo === 1 || r.comp_is_demo === 1,
    };
  });
}

function aggregate(key: string, label: string, pairs: PairRow[]): PositionGroup {
  const usable = pairs.filter((p) => p.index !== null);
  const idx = mean(usable.map((p) => p.index!));
  return {
    key,
    label,
    index: round(idx, 1),
    premium_pct: idx === null ? null : round(idx - 100, 1),
    pairs: usable.length,
    own_products: new Set(usable.map((p) => p.own_product_id)).size,
    competitor_products: new Set(usable.map((p) => p.comp_product_id)).size,
    retailers: new Set(usable.map((p) => p.retailer_id)).size,
    cheaper_pairs: usable.filter((p) => p.index! < 99.5).length,
    dearer_pairs: usable.filter((p) => p.index! > 100.5).length,
  };
}

function groupPairs(pairs: PairRow[], keyOf: (p: PairRow) => [string, string]): PositionGroup[] {
  const groups = new Map<string, { label: string; pairs: PairRow[] }>();
  for (const p of pairs) {
    const [key, label] = keyOf(p);
    const g = groups.get(key);
    if (g) g.pairs.push(p);
    else groups.set(key, { label, pairs: [p] });
  }
  return [...groups.entries()]
    .map(([key, g]) => aggregate(key, g.label, g.pairs))
    .filter((g) => g.pairs > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Average price position of own brands against mapped competitors, from current same-retailer pairs. */
export function positioning(ctx: AppContext, filter: PairFilter = {}): Positioning {
  const pairs = latestPairs(ctx, filter);
  return {
    overall: aggregate('all', 'All mapped pairs', pairs),
    by_category: groupPairs(pairs, (p) => [`C${p.own_category_id ?? 0}`, p.own_category_name ?? 'Uncategorised']),
    by_brand: groupPairs(pairs, (p) => [`B${p.own_brand_id}`, p.own_brand_name]),
    by_market: groupPairs(pairs, (p) => [`M${p.market_id}`, p.market_name]),
    not_comparable_pairs: pairs.filter((p) => p.index === null).length,
    demo: demoNote(pairs.map((p) => ({ is_demo: p.is_demo ? 1 : 0 }))),
  };
}

/** One row per own product: mapping coverage and current position against its mapped competitors. */
export function ownProductPositions(ctx: AppContext, filter: PairFilter = {}): OwnProductPosition[] {
  const conditions: string[] = [`b.ownership = 'own'`, `p.status <> 'archived'`];
  const params: SqlValue[] = [];
  if (filter.own_brand_ids?.length) {
    conditions.push(`p.brand_id IN (${placeholders(filter.own_brand_ids.length)})`);
    params.push(...filter.own_brand_ids);
  }
  if (filter.category_ids?.length) {
    const ph = placeholders(filter.category_ids.length);
    conditions.push(`(p.category_id IN (${ph}) OR p.subcategory_id IN (${ph}))`);
    params.push(...filter.category_ids, ...filter.category_ids);
  }
  if (filter.own_product_ids?.length) {
    conditions.push(`p.id IN (${placeholders(filter.own_product_ids.length)})`);
    params.push(...filter.own_product_ids);
  }
  if (filter.market_ids?.length) {
    conditions.push(`EXISTS (SELECT 1 FROM retailer_listings l JOIN retailers r ON r.id = l.retailer_id WHERE l.product_id = p.id AND r.market_id IN (${placeholders(filter.market_ids.length)}))`);
    params.push(...filter.market_ids);
  }
  const products = ctx.db.all<{
    id: number; code: string; name: string; brand_name: string; category_name: string | null; pack_size: number | null; pack_unit: string | null;
    units_per_pack: number; is_demo: number; approved: number; suggested: number; listings: number;
  }>(
    `SELECT p.id, p.code, p.name, b.name AS brand_name, COALESCE(sc.name, c.name) AS category_name, p.pack_size, p.pack_unit, p.units_per_pack, p.is_demo,
       (SELECT COUNT(*) FROM competitor_mappings m WHERE m.own_product_id = p.id AND m.status = 'approved') AS approved,
       (SELECT COUNT(*) FROM competitor_mappings m WHERE m.own_product_id = p.id AND m.status = 'suggested') AS suggested,
       (SELECT COUNT(*) FROM retailer_listings l WHERE l.product_id = p.id AND l.is_active = 1) AS listings
     FROM products p JOIN brands b ON b.id = p.brand_id
     LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories sc ON sc.id = p.subcategory_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY b.name, p.name`,
    params,
  );
  const pairs = latestPairs(ctx, filter);
  const byProduct = new Map<number, PairRow[]>();
  for (const pair of pairs) {
    const list = byProduct.get(pair.own_product_id);
    if (list) list.push(pair);
    else byProduct.set(pair.own_product_id, [pair]);
  }
  return products.map((p) => {
    const allPairs = byProduct.get(p.id) ?? [];
    const list = allPairs.filter((x) => x.index !== null);
    const idx = mean(list.map((x) => x.index!));
    const byCompetitor = new Map<string, number[]>();
    for (const x of list) {
      const arr = byCompetitor.get(x.comp_product_name);
      if (arr) arr.push(x.gap_pct!);
      else byCompetitor.set(x.comp_product_name, [x.gap_pct!]);
    }
    const competitorGaps = [...byCompetitor.entries()].map(([name, gaps]) => ({ product_name: name, gap_pct: round(mean(gaps), 1)! }));
    competitorGaps.sort((a, b) => a.gap_pct - b.gap_pct);
    let position: OwnProductPosition['position'];
    if (p.approved === 0) position = 'not_mapped';
    else if (idx === null) position = allPairs.length > 0 ? 'not_comparable' : 'no_data';
    else if (idx > 102) position = 'premium';
    else if (idx < 98) position = 'discount';
    else position = 'parity';
    return {
      product_id: p.id,
      product_code: p.code,
      product_name: p.name,
      brand_name: p.brand_name,
      category_name: p.category_name,
      pack: packLabel(p),
      is_demo: p.is_demo === 1,
      approved_mappings: p.approved,
      suggested_mappings: p.suggested,
      listings: p.listings,
      index: round(idx, 1),
      premium_pct: idx === null ? null : round(idx - 100, 1),
      pairs: list.length,
      retailers: new Set(list.map((x) => x.retailer_id)).size,
      markets: new Set(list.map((x) => x.market_id)).size,
      // most negative gap = the competitor we are cheapest against; most positive = the one we are dearest against
      cheapest_vs: competitorGaps.length ? competitorGaps[0]! : null,
      dearest_vs: competitorGaps.length ? competitorGaps[competitorGaps.length - 1]! : null,
      position,
    };
  });
}

/** Full comparison of one own product against its mapped competitor products. */
export function compareProduct(
  ctx: AppContext,
  productId: number,
  options: { market_ids?: number[]; retailer_ids?: number[]; days?: number; currency?: 'native' | string; includeSuggested?: boolean } = {},
): CompareResult {
  const product = ctx.db.get<{
    id: number; code: string; name: string; brand_name: string; ownership: string; category_name: string | null; pack_size: number | null;
    pack_unit: string | null; units_per_pack: number; is_demo: number;
  }>(
    `SELECT p.id, p.code, p.name, b.name AS brand_name, b.ownership, COALESCE(sc.name, c.name) AS category_name, p.pack_size, p.pack_unit, p.units_per_pack, p.is_demo
     FROM products p JOIN brands b ON b.id = p.brand_id LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories sc ON sc.id = p.subcategory_id
     WHERE p.id = ?`,
    [productId],
  );
  if (!product) throw notFound('Product');
  if (product.ownership !== 'own') {
    throw new AppError(400, 'bad_request', 'Competitor comparison starts from an own-brand product. Select one of your own products.');
  }
  const days = Math.min(Math.max(options.days ?? 30, 1), 365);
  const today = marketToday(ctx);
  const period = lastDays(today, days);
  const currency = options.currency ?? 'native';

  const mappings = ctx.db.all<{
    id: number; competitor_product_id: number; equivalence: 'equivalent' | 'comparable'; status: string; rationale: string | null; market_id: number | null;
    name: string; brand_name: string; pack_size: number | null; pack_unit: string | null; units_per_pack: number;
  }>(
    `SELECT m.id, m.competitor_product_id, m.equivalence, m.status, m.rationale, m.market_id, p.name, b.name AS brand_name, p.pack_size, p.pack_unit, p.units_per_pack
     FROM competitor_mappings m JOIN products p ON p.id = m.competitor_product_id JOIN brands b ON b.id = p.brand_id
     WHERE m.own_product_id = ? AND ${options.includeSuggested ? `m.status IN ('approved', 'suggested')` : `m.status = 'approved'`}
     ORDER BY m.equivalence DESC, p.name`,
    [productId],
  );
  // One mapping per competitor product is used for labelling (market-specific ones win inside their market).
  const mappingFor = (competitorId: number, marketId: number) =>
    mappings.find((m) => m.competitor_product_id === competitorId && m.market_id === marketId) ??
    mappings.find((m) => m.competitor_product_id === competitorId && m.market_id === null) ??
    null;

  const productIds = [productId, ...new Set(mappings.map((m) => m.competitor_product_id))];
  const snapshot = monitorRowsFor(ctx, { product_ids: productIds, market_ids: options.market_ids, retailer_ids: options.retailer_ids });
  const listingIds = snapshot.map((s) => s.listing_id);
  const info = loadListings(ctx, listingIds);
  const converter = currency === 'native' ? null : makeConverter(ctx, currency);

  // period statistics per listing
  const daily = listingIds.length ? dailySeries(ctx, { listing_ids: listingIds, date_from: period.from, date_to: period.to, include_unmatched: true }) : [];
  const perListing = new Map<number, number[]>();
  for (const d of daily) {
    if (d.current_price === null) continue;
    const list = perListing.get(d.listing_id);
    if (list) list.push(d.current_price);
    else perListing.set(d.listing_id, [d.current_price]);
  }

  const ownRows = snapshot.filter((s) => s.product_id === productId);
  const ownAtRetailer = new Map<number, MonitorRow>();
  for (const row of ownRows) {
    if (row.current_price === null) continue;
    const existing = ownAtRetailer.get(row.retailer_id);
    // prefer the standard pack over pack variants as the retailer's reference listing
    if (!existing || (existing.variant_name && !row.variant_name)) ownAtRetailer.set(row.retailer_id, row);
  }
  const ownMarketAvg = new Map<number, { price: number; unit: number | null }>();
  for (const marketId of new Set(ownRows.map((r) => r.market_id))) {
    const priced = ownRows.filter((r) => r.market_id === marketId && r.current_price !== null && !r.variant_name);
    const pool = priced.length ? priced : ownRows.filter((r) => r.market_id === marketId && r.current_price !== null);
    if (!pool.length) continue;
    const units = pool.map((r) => r.unit_price).filter((u): u is number => u !== null);
    ownMarketAvg.set(marketId, { price: mean(pool.map((r) => r.current_price!))!, unit: mean(units) });
  }

  const rows: CompareListingRow[] = snapshot.map((s) => {
    const li = info.get(s.listing_id)!;
    const role: 'own' | 'competitor' = s.product_id === productId ? 'own' : 'competitor';
    const mapping = role === 'competitor' ? mappingFor(s.product_id!, s.market_id) : null;
    const stats = computeStats(perListing.get(s.listing_id) ?? []);
    const row: CompareListingRow = {
      role,
      mapping_id: mapping?.id ?? null,
      equivalence: mapping?.equivalence ?? null,
      mapping_status: mapping?.status ?? null,
      listing_id: s.listing_id,
      product_id: s.product_id!,
      product_name: s.product_name!,
      brand_name: s.brand_name!,
      variant_name: s.variant_name,
      pack: packLabel(s),
      retailer_id: s.retailer_id,
      retailer_name: s.retailer_name,
      market_id: s.market_id,
      market_name: s.market_name,
      timezone: s.timezone,
      currency_code: s.currency_code,
      price: s.current_price,
      regular_price: s.regular_price,
      is_promo: s.is_promo === 1,
      discount_pct: s.discount_pct,
      promo_description: s.promo_description,
      availability: s.availability,
      observed_at: s.observed_at,
      is_stale: s.is_stale === 1,
      data_class: s.data_class,
      is_demo: s.is_demo === 1,
      unit_price: round(s.unit_price, 4),
      unit_basis: basisLabel(li.content_dimension) || null,
      period: stats ? { min: stats.min, max: stats.max, avg: round(stats.avg, 4)!, days: stats.n } : null,
      own_reference: null,
      gap_basis: null,
      gap_abs: null,
      gap_pct: null,
      converted: converter
        ? { currency: converter.to, price: round(converter.convert(s.current_price, s.currency_code), 4), unit_price: round(converter.convert(s.unit_price, s.currency_code), 4) }
        : null,
    };
    if (role === 'competitor' && mapping && s.current_price !== null) {
      const sameRetailer = ownAtRetailer.get(s.retailer_id);
      const ownInfo = sameRetailer ? info.get(sameRetailer.listing_id)! : ownRows.length ? info.get(ownRows[0]!.listing_id)! : null;
      const reference = sameRetailer
        ? { scope: 'same_retailer' as const, price: sameRetailer.current_price!, unit_price: sameRetailer.unit_price }
        : ownMarketAvg.has(s.market_id)
          ? { scope: 'market_average' as const, price: ownMarketAvg.get(s.market_id)!.price, unit_price: ownMarketAvg.get(s.market_id)!.unit }
          : null;
      if (reference && ownInfo) {
        const basis = comparisonBasis(mapping.equivalence, { content: ownInfo.content_amount, dimension: ownInfo.content_dimension }, { content: li.content_amount, dimension: li.content_dimension });
        row.own_reference = { scope: reference.scope, price: round(reference.price, 4)!, unit_price: round(reference.unit_price, 4) };
        row.gap_basis = basis;
        if (basis === 'shelf') {
          row.gap_abs = round(reference.price - s.current_price, 4);
          row.gap_pct = round(((reference.price - s.current_price) / s.current_price) * 100, 1);
        } else if (basis === 'unit' && reference.unit_price !== null && s.unit_price !== null && s.unit_price > 0) {
          row.gap_abs = round(reference.unit_price - s.unit_price, 4);
          row.gap_pct = round(((reference.unit_price - s.unit_price) / s.unit_price) * 100, 1);
        }
      }
    }
    return row;
  });
  rows.sort(
    (a, b) =>
      a.market_name.localeCompare(b.market_name) || a.retailer_name.localeCompare(b.retailer_name) ||
      (a.role === b.role ? a.product_name.localeCompare(b.product_name) : a.role === 'own' ? -1 : 1),
  );

  const ownInfoAny = ownRows.length ? info.get(ownRows[0]!.listing_id)! : null;
  const ownDimension = ownInfoAny?.content_dimension ?? (product.pack_unit === 'ml' || product.pack_unit === 'l' ? 'volume' : product.pack_unit === 'g' || product.pack_unit === 'kg' ? 'mass' : product.pack_unit === 'unit' ? 'count' : null);
  const seen = new Set<number>();
  const competitors: CompetitorSummary[] = [];
  for (const m of mappings) {
    if (seen.has(m.competitor_product_id)) continue;
    seen.add(m.competitor_product_id);
    const list = rows.filter((r) => r.role === 'competitor' && r.product_id === m.competitor_product_id);
    const gaps = list.map((r) => r.gap_pct).filter((g): g is number => g !== null);
    const compDimension = m.pack_unit === 'ml' || m.pack_unit === 'l' ? 'volume' : m.pack_unit === 'g' || m.pack_unit === 'kg' ? 'mass' : m.pack_unit === 'unit' ? 'count' : null;
    const comparable = !!ownDimension && ownDimension === compDimension;
    competitors.push({
      product_id: m.competitor_product_id,
      product_name: m.name,
      brand_name: m.brand_name,
      pack: packLabel(m),
      equivalence: m.equivalence,
      mapping_status: m.status,
      mapping_id: m.id,
      rationale: m.rationale,
      comparable,
      note: !comparable
        ? 'Measured in different units — shelf prices are shown, but no price gap is calculated.'
        : m.equivalence === 'comparable'
          ? 'Non-equivalent product — compared on unit price only.'
          : null,
      listings: list.length,
      compared_listings: gaps.length,
      avg_gap_pct: round(mean(gaps), 1),
      min_gap_pct: gaps.length ? Math.min(...gaps) : null,
      max_gap_pct: gaps.length ? Math.max(...gaps) : null,
      own_cheaper_at: gaps.filter((g) => g < -0.5).length,
      own_dearer_at: gaps.filter((g) => g > 0.5).length,
    });
  }

  // ---- historical comparison ---------------------------------------------------------------------
  const currencies = new Set(snapshot.map((s) => s.currency_code));
  const dimensions = new Set(listingIds.map((id) => info.get(id)?.content_dimension).filter(Boolean));
  const metric: 'unit_price' | 'price' = dimensions.size === 1 ? 'unit_price' : 'price';
  const historyCurrency = currency !== 'native' ? currency : currencies.size === 1 ? [...currencies][0]! : null;
  const historyConverter = currency !== 'native' ? converter : null;
  const notes: string[] = [];
  let historyNote: string | null = null;
  const seriesMap = new Map<number, Map<string, { sum: number; n: number }>>();
  if (currency === 'native' && currencies.size > 1) {
    historyNote = 'The selection spans several currencies. Choose a comparison currency (or a single market) to see the historical chart.';
  } else {
    for (const d of daily) {
      if (d.current_price === null) continue;
      const li = info.get(d.listing_id);
      if (!li || !li.product_id) continue;
      const money = historyConverter ? historyConverter.convert(d.current_price, d.currency_code) : d.current_price;
      if (money === null) continue;
      const value = metric === 'unit_price' ? unitPriceOf(money, li) : money;
      if (value === null) continue;
      let byDate = seriesMap.get(li.product_id);
      if (!byDate) {
        byDate = new Map();
        seriesMap.set(li.product_id, byDate);
      }
      const acc = byDate.get(d.date) ?? { sum: 0, n: 0 };
      acc.sum += value;
      acc.n += 1;
      byDate.set(d.date, acc);
    }
    if (metric === 'price' && dimensions.size > 1) {
      historyNote = 'Products are measured in different units, so the chart shows shelf prices rather than unit prices.';
    }
  }
  const nameOf = new Map<number, { label: string; role: 'own' | 'competitor'; equivalence: string | null }>();
  nameOf.set(productId, { label: product.name, role: 'own', equivalence: null });
  for (const m of mappings) if (!nameOf.has(m.competitor_product_id)) nameOf.set(m.competitor_product_id, { label: m.name, role: 'competitor', equivalence: m.equivalence });
  const series = [...seriesMap.entries()]
    .map(([pid, byDate]) => ({
      product_id: pid,
      ...nameOf.get(pid)!,
      points: [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]) => ({ date, value: round(v.sum / v.n, 4)!, n: v.n })),
    }))
    .sort((a, b) => (a.role === b.role ? a.label.localeCompare(b.label) : a.role === 'own' ? -1 : 1));

  if (mappings.length === 0) notes.push('No approved competitor mapping exists for this product yet. Add or approve mappings in Product Catalogue → Matching.');
  if (rows.some((r) => r.own_reference?.scope === 'market_average')) {
    notes.push('Where the own product is not listed at the same retailer, the competitor is compared with the own market average.');
  }
  if (rows.some((r) => r.gap_basis === 'unit')) notes.push('Unit-price gaps are used where pack sizes differ or the mapping is marked non-equivalent.');
  if (rows.some((r) => r.gap_basis === 'not_comparable')) notes.push('No gap is calculated for products measured in different units (e.g. grams vs millilitres).');
  if (converter?.missing().length) notes.push(`No exchange rate is available for: ${converter.missing().join(', ')}. Those values are not converted.`);

  return {
    product: {
      id: product.id, code: product.code, name: product.name, brand_name: product.brand_name, ownership: product.ownership,
      category_name: product.category_name, pack: packLabel(product), unit_basis: basisLabel(ownDimension) || null, is_demo: product.is_demo === 1,
    },
    period,
    currency_mode: currency === 'native' ? 'native' : 'converted',
    target_currency: currency === 'native' ? null : currency,
    rows,
    competitors,
    history: {
      metric,
      currency: historyCurrency,
      basis: metric === 'unit_price' ? basisLabel([...dimensions][0] as never) : null,
      series,
      note: historyNote,
    },
    conversions: converter?.used() ?? [],
    missing_rates: converter?.missing() ?? [],
    notes,
    demo: demoNote(rows.map((r) => ({ is_demo: r.is_demo ? 1 : 0 }))),
  };
}
