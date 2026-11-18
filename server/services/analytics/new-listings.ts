/**
 * New products: listings that appeared at a retailer recently.
 *
 * Method notes (shown to users where relevant)
 *   * "First seen" is when this system first saw a listing — not when the retailer put it on sale. A listing
 *     that was already on the shelf when its retailer was first loaded says nothing about a launch.
 *   * Baseline rule: a listing counts as new only if it was first seen more than 48 hours after the first
 *     listing of its retailer was first seen and, where its brand is known, more than 48 hours after the
 *     first listing of that brand at that retailer. The first load of a retailer, or of a brand at a
 *     retailer (for example when a brand is added to a source's search list), is a baseline, not a launch.
 *   * Two kinds are kept apart. `new_product`: nothing says the product was on sale anywhere before (the
 *     listing is unmatched, or every other listing of its product is just as new). `new_at_retailer`: the
 *     product was already listed somewhere else — a distribution change.
 *   * An unmatched listing has no product and therefore no brand. Its brand is recognised from the title
 *     (or, failing that, the page address) by the names in the brands table. That is a guess for display
 *     and for the baseline rule; it is never stored and never matches a listing to a product.
 */
import type { AppContext } from '../../context.ts';
import { placeholders, type SqlValue } from '../../db/sqlite.ts';
import type { Page } from '../../lib/http.ts';
import { paged } from '../../lib/http.ts';
import { addDays, localDate } from '../../lib/time.ts';
import { parseDealTags, type CollectionMethod, type DataClass, type Ownership } from '../../../shared/constants.ts';
import {
  NEW_LISTING_BASELINE_HOURS,
  NEW_LISTING_SORTS,
  type BrandBasis,
  type DiscoveryState,
  type NewListingBaseline,
  type NewListingBrandCount,
  type NewListingKind,
  type NewListingPeriod,
  type NewListingRetailerCount,
  type NewListingRow,
  type NewListingSort,
  type NewListingSource,
  type NewListingsResponse,
  type NewListingsSeries,
  type NewListingsSummary,
  type ReviewState,
} from '../../../shared/api/new-listings.ts';
import { demoNote } from './common.ts';
export type { NewListingRow, NewListingsResponse };

const BASELINE_MS = NEW_LISTING_BASELINE_HOURS * 3_600_000;
/** When this system first saw a listing. */
const SEEN_SQL = 'COALESCE(l.first_seen_at, l.created_at)';
/** Sources that read a whole feed and can therefore meet items they do not know. */
const DISCOVERING_METHODS: CollectionMethod[] = ['official_api', 'product_feed', 'third_party'];
const MAX_SERIES_BRANDS = 7;

// ---------------------------------------------------------------------------------------------
// Brand recognition (a guess from the retailer's wording)
// ---------------------------------------------------------------------------------------------
export interface BrandRef {
  id: number;
  name: string;
  ownership: Ownership;
}

export interface RecognisedBrand {
  brand_id: number;
  brand_name: string;
  ownership: Ownership;
  basis: 'title' | 'url';
}

/** The words of a text: lower-case letters and digits, accents removed, "&" and "and" dropped. */
export function brandWords(text: string): string[] {
  return text
    .replace(/&amp;/gi, ' ')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '' && word !== 'and');
}

function pathOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const path = new URL(url).pathname;
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  } catch {
    return null;
  }
}

/**
 * Recognises a brand by its name appearing as whole words, in order, in the title — or, failing that, in the
 * page address. The longest name wins ("Dabur Amla" before "Dabur"); among equally long names the one that
 * appears first.
 */
export function createBrandRecogniser(brands: BrandRef[]): (title: string | null | undefined, url?: string | null) => RecognisedBrand | null {
  const entries = brands
    .map((brand) => ({ brand, needle: ` ${brandWords(brand.name).join(' ')} ` }))
    .filter((entry) => entry.needle.trim() !== '')
    .sort((a, b) => b.needle.length - a.needle.length || a.brand.id - b.brand.id);

  const find = (text: string | null | undefined): BrandRef | null => {
    if (!text) return null;
    const words = brandWords(text);
    if (words.length === 0) return null;
    const hay = ` ${words.join(' ')} `;
    let best: BrandRef | null = null;
    let bestAt = Infinity;
    let bestLength = 0;
    for (const entry of entries) {
      if (entry.needle.length < bestLength) break;
      const at = hay.indexOf(entry.needle);
      if (at >= 0 && at < bestAt) {
        best = entry.brand;
        bestAt = at;
        bestLength = entry.needle.length;
      }
    }
    return best;
  };

  return (title, url) => {
    const fromTitle = find(title);
    if (fromTitle) return { brand_id: fromTitle.id, brand_name: fromTitle.name, ownership: fromTitle.ownership, basis: 'title' };
    const fromUrl = find(pathOf(url));
    if (fromUrl) return { brand_id: fromUrl.id, brand_name: fromUrl.name, ownership: fromUrl.ownership, basis: 'url' };
    return null;
  };
}

/** A recogniser over the active brands of the catalogue. */
export function brandRecogniser(ctx: AppContext): ReturnType<typeof createBrandRecogniser> {
  return createBrandRecogniser(ctx.db.all<BrandRef>('SELECT id, name, ownership FROM brands WHERE is_active = 1 ORDER BY id'));
}

// ---------------------------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------------------------
interface Baselines {
  /** retailer id → first sighting of any of its listings (epoch ms). */
  retailer: Map<number, number>;
  /** "retailer:brand" → first sighting of that brand at that retailer (epoch ms). */
  brand: Map<string, number>;
}

const brandKey = (retailerId: number, brandId: number) => `${retailerId}:${brandId}`;

function loadBaselines(ctx: AppContext, recognise: ReturnType<typeof createBrandRecogniser>): Baselines {
  const retailer = new Map<number, number>();
  for (const row of ctx.db.all<{ retailer_id: number; at: string }>(`SELECT l.retailer_id, MIN(${SEEN_SQL}) AS at FROM retailer_listings l GROUP BY l.retailer_id`)) {
    retailer.set(row.retailer_id, Date.parse(row.at));
  }
  const brand = new Map<string, number>();
  const note = (retailerId: number, brandId: number, at: number) => {
    const key = brandKey(retailerId, brandId);
    const known = brand.get(key);
    if (known === undefined || at < known) brand.set(key, at);
  };
  for (const row of ctx.db.all<{ retailer_id: number; brand_id: number; at: string }>(
    `SELECT l.retailer_id, p.brand_id, MIN(${SEEN_SQL}) AS at
     FROM retailer_listings l JOIN products p ON p.id = l.product_id
     GROUP BY l.retailer_id, p.brand_id`,
  )) {
    note(row.retailer_id, row.brand_id, Date.parse(row.at));
  }
  // Unmatched listings carry their brand only as a guess; it still tells when a brand was first met at a retailer.
  for (const row of ctx.db.all<{ retailer_id: number; title: string | null; url: string | null; at: string }>(
    `SELECT l.retailer_id, l.title, l.url, ${SEEN_SQL} AS at FROM retailer_listings l WHERE l.product_id IS NULL`,
  )) {
    const guess = recognise(row.title, row.url);
    if (guess) note(row.retailer_id, guess.brand_id, Date.parse(row.at));
  }
  return { retailer, brand };
}

/** Which first load a listing belongs to, or null when it was first seen after every baseline that applies to it. */
function baselineOf(baselines: Baselines, retailerId: number, brandId: number | null, seenAt: number): 'retailer' | 'brand' | null {
  const retailerStart = baselines.retailer.get(retailerId);
  if (retailerStart === undefined || seenAt <= retailerStart + BASELINE_MS) return 'retailer';
  if (brandId !== null) {
    const brandStart = baselines.brand.get(brandKey(retailerId, brandId));
    if (brandStart === undefined || seenAt <= brandStart + BASELINE_MS) return 'brand';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The listings of one collection run (used by the "new product" alert)
// ---------------------------------------------------------------------------------------------
export interface DiscoveredListing {
  listing_id: number;
  title: string | null;
  url: string | null;
  brand: RecognisedBrand | null;
  first_price: number | null;
  currency_code: string | null;
}

export interface DiscoveredFacts {
  retailer: { id: number; name: string; market_id: number; market_code: string; market_name: string; is_demo: number; collection_method: string } | null;
  /** The listings that count as new: first seen after the baseline of the retailer and of their brand there. */
  fresh: DiscoveredListing[];
  /** The listings that belong to a first load (of the retailer, or of their brand at the retailer). */
  baseline: { retailer: number; brand: number };
}

/** Sorts the listings a run has just found into "new" and "part of a first load". */
export function describeDiscovered(ctx: AppContext, retailerId: number, listingIds: number[]): DiscoveredFacts {
  const retailer =
    ctx.db.get<NonNullable<DiscoveredFacts['retailer']>>(
      `SELECT r.id, r.name, r.market_id, m.code AS market_code, m.name AS market_name, r.is_demo, r.collection_method
       FROM retailers r JOIN markets m ON m.id = r.market_id WHERE r.id = ?`,
      [retailerId],
    ) ?? null;
  const facts: DiscoveredFacts = { retailer, fresh: [], baseline: { retailer: 0, brand: 0 } };
  if (!retailer || listingIds.length === 0) return facts;
  const recognise = brandRecogniser(ctx);
  const baselines = loadBaselines(ctx, recognise);
  for (let i = 0; i < listingIds.length; i += 400) {
    const chunk = listingIds.slice(i, i + 400);
    const rows = ctx.db.all<{ listing_id: number; title: string | null; url: string | null; at: string; brand_id: number | null; brand_name: string | null; ownership: Ownership | null; first_price: number | null; currency_code: string | null }>(
      `SELECT l.id AS listing_id, l.title, l.url, ${SEEN_SQL} AS at, p.brand_id, b.name AS brand_name, b.ownership,
              o.current_price AS first_price, o.currency_code
       FROM retailer_listings l
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN listing_state s ON s.listing_id = l.id
       LEFT JOIN price_observations o ON o.id = s.latest_obs_id
       WHERE l.retailer_id = ? AND l.id IN (${placeholders(chunk.length)})
       ORDER BY l.id`,
      [retailerId, ...chunk],
    );
    for (const row of rows) {
      const brand: RecognisedBrand | null =
        row.brand_id !== null && row.brand_name !== null && row.ownership !== null
          ? { brand_id: row.brand_id, brand_name: row.brand_name, ownership: row.ownership, basis: 'title' }
          : recognise(row.title, row.url);
      const belongsTo = baselineOf(baselines, retailerId, brand?.brand_id ?? null, Date.parse(row.at));
      if (belongsTo) facts.baseline[belongsTo] += 1;
      else facts.fresh.push({ listing_id: row.listing_id, title: row.title, url: row.url, brand, first_price: row.first_price, currency_code: row.currency_code });
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------
// GET /api/new-listings
// ---------------------------------------------------------------------------------------------
export interface NewListingsOptions {
  days: NewListingPeriod;
  marketIds?: number[];
  retailerIds?: number[];
  /** Brand of the product, or the brand recognised for an unmatched listing. */
  brandIds?: number[];
  ownership?: Ownership;
  kind?: NewListingKind;
  q?: string;
  /** Also list listings a reviewer has marked as ignored. */
  includeIgnored?: boolean;
  /** One of NEW_LISTING_SORTS, "-" prefix = descending. Default "-first_seen". */
  sort?: string;
}

interface CandidateRow {
  listing_id: number;
  listing_code: string | null;
  listing_title: string | null;
  listing_url: string | null;
  external_id: string | null;
  match_status: string;
  listing_is_demo: number;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_code: string;
  market_name: string;
  timezone: string;
  currency_code: string;
  product_id: number | null;
  product_code: string | null;
  product_name: string | null;
  image_url: string | null;
  category_name: string | null;
  brand_id: number | null;
  brand_name: string | null;
  ownership: Ownership | null;
  first_seen_at: string;
}

interface FirstObservation {
  listing_id: number;
  observed_at: string;
  current_price: number | null;
  regular_price: number | null;
  tags: string;
  tag_text: string | null;
  data_class: DataClass | null;
  is_demo: number;
}

/** Reads a sort parameter ("-first_seen", "brand", …); anything unknown falls back to the default. */
export function parseNewListingSort(sort: string | undefined): { key: NewListingSort; descending: boolean } {
  const descending = !!sort && sort.startsWith('-');
  const key = (descending ? sort!.slice(1) : sort) as NewListingSort | undefined;
  return key && NEW_LISTING_SORTS.includes(key) ? { key, descending } : { key: 'first_seen', descending: true };
}

function sortRows(rows: NewListingRow[], sort: string | undefined): NewListingRow[] {
  const { key, descending } = parseNewListingSort(sort);
  const direction = descending ? -1 : 1;
  const newestFirst = (a: NewListingRow, b: NewListingRow) =>
    a.first_seen_at === b.first_seen_at ? b.listing_id - a.listing_id : a.first_seen_at < b.first_seen_at ? 1 : -1;
  if (key === 'first_seen') return [...rows].sort((a, b) => (descending ? newestFirst(a, b) : -newestFirst(a, b)));
  const text = (row: NewListingRow) => (key === 'brand' ? row.brand_name : row.retailer_name);
  return [...rows].sort((a, b) => {
    const ta = text(a);
    const tb = text(b);
    if (ta === null || tb === null) {
      if (ta !== tb) return ta === null ? 1 : -1; // rows without the value always come last
    } else {
      const order = ta.localeCompare(tb, 'en', { sensitivity: 'base' });
      if (order !== 0) return order * direction;
    }
    return newestFirst(a, b);
  });
}

/** Monday of the week an ISO date belongs to. */
function weekStart(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(isoDate, -((day + 6) % 7));
}

function buildSeries(rows: NewListingRow[], days: NewListingPeriod, fromDate: string, toDate: string): NewListingsSeries {
  const bucket: NewListingsSeries['bucket'] = days === 7 ? 'day' : 'week';
  const startOf = (isoDate: string) => (bucket === 'day' ? isoDate : weekStart(isoDate));
  const dated = rows.map((row) => ({ row, date: localDate(row.first_seen_at, row.timezone) }));
  let first = fromDate;
  let last = toDate;
  for (const { date } of dated) {
    if (date < first) first = date;
    if (date > last) last = date;
  }
  const starts: string[] = [];
  for (let day = startOf(first); day <= startOf(last); day = addDays(day, bucket === 'day' ? 1 : 7)) starts.push(day);
  const index = new Map(starts.map((start, i) => [start, i]));

  const perBrand = new Map<number, { brand_id: number; brand_name: string; ownership: Ownership | null; total: number }>();
  for (const { row } of dated) {
    if (row.brand_id === null) continue;
    const entry = perBrand.get(row.brand_id) ?? { brand_id: row.brand_id, brand_name: row.brand_name ?? 'Brand', ownership: row.ownership, total: 0 };
    entry.total += 1;
    perBrand.set(row.brand_id, entry);
  }
  // Own brands first, then competitors, each by number of new listings.
  const ranked = [...perBrand.values()].sort(
    (a, b) => Number(b.ownership === 'own') - Number(a.ownership === 'own') || b.total - a.total || a.brand_name.localeCompare(b.brand_name),
  );
  const shown = ranked.slice(0, MAX_SERIES_BRANDS);
  const zeros = () => starts.map(() => 0);
  const brands = shown.map((b) => ({ key: `brand:${b.brand_id}`, brand_id: b.brand_id, brand_name: b.brand_name, ownership: b.ownership, counts: zeros() }));
  const slot = new Map(brands.map((b) => [b.brand_id, b]));
  const other = zeros();
  const unrecognised = zeros();
  for (const { row, date } of dated) {
    const i = index.get(startOf(date));
    if (i === undefined) continue;
    if (row.brand_id === null) unrecognised[i]! += 1;
    else if (slot.has(row.brand_id)) slot.get(row.brand_id)!.counts[i]! += 1;
    else other[i]! += 1;
  }
  return { bucket, starts, brands, other, unrecognised };
}

function summarise(scope: NewListingRow[], ignored: number): NewListingsSummary {
  const brands = new Map<number | null, NewListingBrandCount>();
  const retailers = new Map<number, NewListingRetailerCount>();
  let latest: string | null = null;
  for (const row of scope) {
    const brand =
      brands.get(row.brand_id) ??
      ({ brand_id: row.brand_id, brand_name: row.brand_name ?? 'Brand not recognised', ownership: row.ownership, count: 0, new_products: 0, new_at_retailer: 0, recognised: 0 } satisfies NewListingBrandCount);
    brand.count += 1;
    brand[row.kind === 'new_product' ? 'new_products' : 'new_at_retailer'] += 1;
    if (row.brand_basis === 'title' || row.brand_basis === 'url') brand.recognised += 1;
    brands.set(row.brand_id, brand);
    const retailer =
      retailers.get(row.retailer_id) ??
      ({ retailer_id: row.retailer_id, retailer_name: row.retailer_name, market_code: row.market_code, market_name: row.market_name, count: 0, new_products: 0, new_at_retailer: 0 } satisfies NewListingRetailerCount);
    retailer.count += 1;
    retailer[row.kind === 'new_product' ? 'new_products' : 'new_at_retailer'] += 1;
    retailers.set(row.retailer_id, retailer);
    if (latest === null || row.first_seen_at > latest) latest = row.first_seen_at;
  }
  return {
    total: scope.length,
    new_products: scope.filter((r) => r.kind === 'new_product').length,
    new_at_retailer: scope.filter((r) => r.kind === 'new_at_retailer').length,
    needs_review: scope.filter((r) => r.review_state === 'needs_review').length,
    own: scope.filter((r) => r.ownership === 'own').length,
    competitor: scope.filter((r) => r.ownership === 'competitor').length,
    unrecognised: scope.filter((r) => r.brand_id === null).length,
    ignored,
    by_brand: [...brands.values()].sort((a, b) => b.count - a.count || a.brand_name.localeCompare(b.brand_name)),
    by_retailer: [...retailers.values()].sort((a, b) => b.count - a.count || a.retailer_name.localeCompare(b.retailer_name) || a.retailer_id - b.retailer_id),
    latest_first_seen_at: latest,
    demo: demoNote(scope),
  };
}

function loadSources(ctx: AppContext, options: NewListingsOptions, baselines: Baselines): NewListingSource[] {
  const conditions = ['r.is_active = 1'];
  const params: SqlValue[] = [];
  if (options.marketIds?.length) {
    conditions.push(`r.market_id IN (${placeholders(options.marketIds.length)})`);
    params.push(...options.marketIds);
  }
  if (options.retailerIds?.length) {
    conditions.push(`r.id IN (${placeholders(options.retailerIds.length)})`);
    params.push(...options.retailerIds);
  }
  const rows = ctx.db.all<{ id: number; name: string; market_code: string; collection_method: CollectionMethod; connector_config: string | null; is_demo: number; listings: number }>(
    `SELECT r.id, r.name, m.code AS market_code, r.collection_method, r.connector_config, r.is_demo,
            (SELECT COUNT(*) FROM retailer_listings l WHERE l.retailer_id = r.id) AS listings
     FROM retailers r JOIN markets m ON m.id = r.market_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.name COLLATE NOCASE, r.id`,
    params,
  );
  return rows.map((row) => {
    let discovery: DiscoveryState = 'not_supported';
    if (DISCOVERING_METHODS.includes(row.collection_method)) {
      let config: { discover_listings?: unknown } = {};
      try {
        config = JSON.parse(row.connector_config ?? '{}') as { discover_listings?: unknown };
      } catch {
        config = {};
      }
      discovery = config.discover_listings === true ? 'on' : 'off';
    }
    const start = baselines.retailer.get(row.id);
    return {
      retailer_id: row.id,
      retailer_name: row.name,
      market_code: row.market_code,
      collection_method: row.collection_method,
      discovery,
      listings: row.listings,
      baseline_started_at: start === undefined ? null : new Date(start).toISOString(),
      baseline_ends_at: start === undefined ? null : new Date(start + BASELINE_MS).toISOString(),
      is_demo: row.is_demo ? 1 : 0,
    };
  });
}

/** Listings first seen within the period and after their baseline, newest first by default. */
export function newListings(ctx: AppContext, options: NewListingsOptions, page: Page, now: Date = new Date()): NewListingsResponse {
  const fromMs = now.getTime() - options.days * 86_400_000;
  const from = new Date(fromMs).toISOString();
  const recognise = brandRecogniser(ctx);
  const baselines = loadBaselines(ctx, recognise);

  const conditions = [`${SEEN_SQL} >= ?`, 'li.retailer_active = 1'];
  const params: SqlValue[] = [from];
  if (options.marketIds?.length) {
    conditions.push(`li.market_id IN (${placeholders(options.marketIds.length)})`);
    params.push(...options.marketIds);
  }
  if (options.retailerIds?.length) {
    conditions.push(`li.retailer_id IN (${placeholders(options.retailerIds.length)})`);
    params.push(...options.retailerIds);
  }
  const candidates = ctx.db.all<CandidateRow>(
    `SELECT li.listing_id, li.listing_code, li.listing_title, li.listing_url, li.external_id, li.match_status, li.listing_is_demo,
            li.retailer_id, li.retailer_name, li.market_id, li.market_code, li.market_name, li.timezone, li.currency_code,
            li.product_id, li.product_code, li.product_name, li.image_url, li.category_name, li.brand_id, li.brand_name, li.ownership,
            ${SEEN_SQL} AS first_seen_at
     FROM v_listing_info li JOIN retailer_listings l ON l.id = li.listing_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY li.listing_id`,
    params,
  );

  // ---- baseline rule ---------------------------------------------------------------------------
  interface Kept {
    row: CandidateRow;
    brand: { id: number; name: string; ownership: Ownership | null; basis: BrandBasis } | null;
  }
  const kept: Kept[] = [];
  const retailerLoads = new Map<number, number>();
  const brandLoads = new Map<string, { retailerId: number; brandId: number; brandName: string; ownership: Ownership | null; listings: number }>();
  const retailerOf = new Map<number, { name: string; market_code: string }>();
  for (const row of candidates) {
    retailerOf.set(row.retailer_id, { name: row.retailer_name, market_code: row.market_code });
    let brand: Kept['brand'] = null;
    if (row.brand_id !== null) brand = { id: row.brand_id, name: row.brand_name ?? 'Brand', ownership: row.ownership, basis: 'product' };
    else {
      const guess = recognise(row.listing_title, row.listing_url);
      if (guess) brand = { id: guess.brand_id, name: guess.brand_name, ownership: guess.ownership, basis: guess.basis };
    }
    const belongsTo = baselineOf(baselines, row.retailer_id, brand?.id ?? null, Date.parse(row.first_seen_at));
    if (belongsTo === 'retailer') retailerLoads.set(row.retailer_id, (retailerLoads.get(row.retailer_id) ?? 0) + 1);
    else if (belongsTo === 'brand' && brand) {
      const key = brandKey(row.retailer_id, brand.id);
      const load = brandLoads.get(key) ?? { retailerId: row.retailer_id, brandId: brand.id, brandName: brand.name, ownership: brand.ownership, listings: 0 };
      load.listings += 1;
      brandLoads.set(key, load);
    } else kept.push({ row, brand });
  }

  // ---- kind: was the product listed anywhere before? ---------------------------------------------
  const productIds = [...new Set(kept.map((k) => k.row.product_id).filter((id): id is number => id !== null))];
  const siblings = new Map<number, Array<{ listing_id: number; retailer_id: number; retailer_name: string; market_code: string; brand_id: number; at: number }>>();
  for (let i = 0; i < productIds.length; i += 400) {
    const chunk = productIds.slice(i, i + 400);
    const rows = ctx.db.all<{ listing_id: number; product_id: number; retailer_id: number; retailer_name: string; market_code: string; brand_id: number; at: string }>(
      `SELECT l.id AS listing_id, l.product_id, l.retailer_id, r.name AS retailer_name, m.code AS market_code, p.brand_id, ${SEEN_SQL} AS at
       FROM retailer_listings l
       JOIN products p ON p.id = l.product_id
       JOIN retailers r ON r.id = l.retailer_id
       JOIN markets m ON m.id = r.market_id
       WHERE l.product_id IN (${placeholders(chunk.length)})
       ORDER BY l.id`,
      chunk,
    );
    for (const row of rows) {
      const list = siblings.get(row.product_id) ?? [];
      list.push({ ...row, at: Date.parse(row.at) });
      siblings.set(row.product_id, list);
    }
  }

  // ---- first priced observation ------------------------------------------------------------------
  const firstObservation = new Map<number, FirstObservation>();
  const keptIds = kept.map((k) => k.row.listing_id);
  for (let i = 0; i < keptIds.length; i += 400) {
    const chunk = keptIds.slice(i, i + 400);
    const rows = ctx.db.all<FirstObservation>(
      `SELECT x.listing_id, x.observed_at, x.current_price, x.regular_price, x.tags, x.tag_text, x.data_class, x.is_demo FROM (
         SELECT o.listing_id, o.observed_at, o.current_price, o.regular_price, o.tags, o.tag_text, o.data_class, o.is_demo,
                ROW_NUMBER() OVER (PARTITION BY o.listing_id ORDER BY o.observed_at, o.id) AS rn
         FROM v_observations o
         WHERE o.listing_id IN (${placeholders(chunk.length)}) AND o.current_price IS NOT NULL
       ) x WHERE x.rn = 1`,
      chunk,
    );
    for (const row of rows) firstObservation.set(row.listing_id, row);
  }

  const all: NewListingRow[] = kept.map(({ row, brand }) => {
    const before =
      row.product_id === null
        ? []
        : (siblings.get(row.product_id) ?? []).filter(
            (s) => s.listing_id !== row.listing_id && (s.at < fromMs || baselineOf(baselines, s.retailer_id, s.brand_id, s.at) !== null),
          );
    const beforeAt = [...new Set(before.map((s) => `${s.retailer_name} (${s.market_code})`))];
    const obs = firstObservation.get(row.listing_id);
    const review: ReviewState = row.match_status === 'matched' ? 'matched' : row.match_status === 'ignored' ? 'ignored' : 'needs_review';
    return {
      listing_id: row.listing_id,
      listing_code: row.listing_code,
      listing_title: row.listing_title,
      listing_url: row.listing_url,
      external_id: row.external_id,
      retailer_id: row.retailer_id,
      retailer_name: row.retailer_name,
      market_id: row.market_id,
      market_code: row.market_code,
      market_name: row.market_name,
      timezone: row.timezone,
      currency_code: row.currency_code,
      first_seen_at: row.first_seen_at,
      kind: before.length > 0 ? 'new_at_retailer' : 'new_product',
      review_state: review,
      product_id: row.product_id,
      product_code: row.product_code,
      product_name: row.product_name,
      image_url: row.image_url,
      category_name: row.category_name,
      brand_id: brand?.id ?? null,
      brand_name: brand?.name ?? null,
      ownership: brand?.ownership ?? null,
      brand_basis: brand?.basis ?? null,
      listed_before_at: beforeAt.slice(0, 5),
      listed_before_count: beforeAt.length,
      first_price: obs?.current_price ?? null,
      first_regular_price: obs?.regular_price ?? null,
      first_observed_at: obs?.observed_at ?? null,
      tags: obs ? parseDealTags(obs.tags) : [],
      tag_text: obs?.tag_text ?? null,
      data_class: obs?.data_class ?? null,
      is_demo: row.listing_is_demo || obs?.is_demo ? 1 : 0,
    };
  });

  // ---- filters that need the recognised brand ----------------------------------------------------
  const brandIds = options.brandIds?.length ? new Set(options.brandIds) : null;
  const needle = options.q?.trim().toLowerCase() || null;
  const matches = (row: NewListingRow) => {
    if (brandIds && (row.brand_id === null || !brandIds.has(row.brand_id))) return false;
    if (options.ownership && row.ownership !== options.ownership) return false;
    if (needle) {
      const hay = [row.listing_title, row.product_name, row.brand_name, row.retailer_name, row.external_id, row.listing_code].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  };
  const inScope = all.filter(matches);
  const ignored = inScope.filter((row) => row.review_state === 'ignored').length;
  const scope = options.includeIgnored ? inScope : inScope.filter((row) => row.review_state !== 'ignored');
  const rows = sortRows(options.kind ? scope.filter((row) => row.kind === options.kind) : scope, options.sort);

  // ---- first loads inside the period -------------------------------------------------------------
  const baselineList: NewListingBaseline[] = [];
  for (const [retailerId, listings] of retailerLoads) {
    const start = baselines.retailer.get(retailerId);
    const info = retailerOf.get(retailerId);
    if (start === undefined || !info || start < fromMs) continue;
    baselineList.push({
      scope: 'retailer', retailer_id: retailerId, retailer_name: info.name, market_code: info.market_code, brand_id: null, brand_name: null, ownership: null,
      started_at: new Date(start).toISOString(), ends_at: new Date(start + BASELINE_MS).toISOString(), listings,
    });
  }
  for (const load of brandLoads.values()) {
    const start = baselines.brand.get(brandKey(load.retailerId, load.brandId));
    const info = retailerOf.get(load.retailerId);
    if (start === undefined || !info || start < fromMs) continue;
    baselineList.push({
      scope: 'brand', retailer_id: load.retailerId, retailer_name: info.name, market_code: info.market_code, brand_id: load.brandId, brand_name: load.brandName, ownership: load.ownership,
      started_at: new Date(start).toISOString(), ends_at: new Date(start + BASELINE_MS).toISOString(), listings: load.listings,
    });
  }
  baselineList.sort((a, b) => (a.started_at === b.started_at ? a.retailer_name.localeCompare(b.retailer_name) || (a.brand_name ?? '').localeCompare(b.brand_name ?? '') : a.started_at < b.started_at ? 1 : -1));

  const toDate = now.toISOString().slice(0, 10);
  return {
    ...paged(rows.slice(page.offset, page.offset + page.pageSize), rows.length, page),
    summary: summarise(scope, ignored),
    series: buildSeries(rows, options.days, from.slice(0, 10), toDate),
    period: { days: options.days, from, to: now.toISOString() },
    baseline_hours: NEW_LISTING_BASELINE_HOURS,
    baselines: baselineList,
    sources: loadSources(ctx, options, baselines),
  };
}
