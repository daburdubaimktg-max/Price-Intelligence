/**
 * Catalogue linking service:
 *   * listing rows (a retailer listing joined with its canonical product, pack and latest price)
 *   * listing → product match suggestions (never auto-approved: identical names do not imply identical SKUs)
 *   * competitor equivalence mappings and their suggestions (equivalent vs explicitly non-equivalent)
 *   * "promotion" of DEMO catalogue rows that real records start to depend on
 */
import type { AppContext, AuthUser } from '../context.ts';
import type { SqlParam } from '../db/sqlite.ts';
import { placeholders } from '../db/sqlite.ts';
import { notFound, unprocessable } from '../lib/errors.ts';
import { nowIso } from '../lib/time.ts';
import { formatPack, packContent, parsePackFromText, unitBasisLabel, type PackContent } from '../../shared/units.ts';
import type {
  Comparability,
  LatestObservation,
  ListingRow,
  MappingProductSide,
  MappingRow,
  MatchSuggestion,
} from '../../shared/api/catalogue.ts';
import { audit } from './core.ts';

// ---------------------------------------------------------------------------------------------
// Listing rows
// ---------------------------------------------------------------------------------------------
export const LISTING_FROM = `
  FROM v_listing_info li
  JOIN retailer_listings l ON l.id = li.listing_id
  LEFT JOIN listing_state s ON s.listing_id = li.listing_id
  LEFT JOIN price_observations o ON o.id = s.latest_obs_id
  LEFT JOIN price_observations po ON po.id = s.prev_obs_id`;

const LISTING_COLUMNS = `
  li.listing_id AS id, li.listing_code AS code, li.retailer_id, li.retailer_name, li.market_id, li.market_code, li.market_name,
  li.timezone, li.country_code, li.currency_code, li.collection_method, li.collection_frequency,
  li.product_id, li.product_code, li.product_name, li.brand_id, li.brand_name, li.ownership, li.category_name,
  li.subcategory_name, li.sku, li.gtin AS product_gtin, li.variant_id, li.variant_name,
  li.pack_size, li.pack_unit, li.units_per_pack, li.content_amount, li.content_dimension,
  li.external_id, li.listing_url AS url, li.listing_title AS title, l.gtin, li.match_status, l.matched_by, l.matched_at,
  li.listing_active AS is_active, li.listing_is_demo AS is_demo, l.first_seen_at, l.last_seen_at, l.created_at, l.updated_at,
  COALESCE(s.obs_count, 0) AS obs_count, s.first_observed_at, s.last_observed_at, s.last_price_change_at,
  o.id AS latest_observation_id, o.current_price, o.regular_price, o.promo_price, o.is_promo, o.discount_pct, o.promo_type,
  o.availability, o.observed_at, o.data_class, o.source_method,
  (o.current_price * li.unit_factor / NULLIF(li.content_amount, 0)) AS unit_price,
  po.current_price AS previous_price, po.observed_at AS previous_observed_at`;

type RawListing = Omit<ListingRow, 'latest' | 'pack_label'> & {
  latest_observation_id: number | null;
  current_price: number | null;
  regular_price: number | null;
  promo_price: number | null;
  is_promo: number | null;
  discount_pct: number | null;
  promo_type: LatestObservation['promo_type'];
  availability: LatestObservation['availability'] | null;
  observed_at: string | null;
  data_class: LatestObservation['data_class'] | null;
  source_method: LatestObservation['source_method'] | null;
  unit_price: number | null;
};

function mapListing(raw: RawListing): ListingRow {
  const {
    latest_observation_id, current_price, regular_price, promo_price, is_promo, discount_pct, promo_type, availability,
    observed_at, data_class, source_method, unit_price, ...rest
  } = raw;
  const latest: LatestObservation | null =
    latest_observation_id === null
      ? null
      : {
          observation_id: latest_observation_id,
          current_price,
          regular_price,
          promo_price,
          is_promo: is_promo ?? 0,
          discount_pct,
          promo_type,
          availability: availability ?? 'unknown',
          observed_at: observed_at!,
          data_class: data_class!,
          source_method: source_method!,
          unit_price,
        };
  return {
    ...rest,
    units_per_pack: rest.product_id === null ? null : rest.units_per_pack,
    pack_label: formatPack(rest.pack_size, rest.pack_unit, rest.units_per_pack),
    latest,
  };
}

export function fetchListings(
  ctx: AppContext,
  options: { where?: string[]; params?: SqlParam[]; order?: string; limit?: number; offset?: number } = {},
): ListingRow[] {
  const where = options.where?.length ? `WHERE ${options.where.join(' AND ')}` : '';
  const limit = options.limit !== undefined ? `LIMIT ${Math.floor(options.limit)} OFFSET ${Math.floor(options.offset ?? 0)}` : '';
  const rows = ctx.db.all<RawListing>(
    `SELECT ${LISTING_COLUMNS} ${LISTING_FROM} ${where} ORDER BY ${options.order ?? 'li.retailer_name, li.product_name, li.listing_id'} ${limit}`,
    options.params ?? [],
  );
  return rows.map(mapListing);
}

export function countListings(ctx: AppContext, where: string[] = [], params: SqlParam[] = []): number {
  return ctx.db.scalar<number>(`SELECT COUNT(*) ${LISTING_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params) ?? 0;
}

export function getListing(ctx: AppContext, id: number): ListingRow {
  const row = fetchListings(ctx, { where: ['li.listing_id = ?'], params: [id] })[0];
  if (!row) throw notFound('Listing');
  return row;
}

// ---------------------------------------------------------------------------------------------
// Promotion of DEMO catalogue rows
// ---------------------------------------------------------------------------------------------
// A real (non-demo) record must never depend on a DEMO row, otherwise removing the demo dataset would
// either fail or take real data with it. When real data starts using a demo brand, category or product,
// that catalogue row stops being demo data (its simulated listings and prices stay flagged as DEMO).

export function promoteBrandToReal(ctx: AppContext, brandId: number): void {
  ctx.db.run('UPDATE brands SET is_demo = 0, updated_at = ? WHERE id = ? AND is_demo = 1', [nowIso(), brandId]);
}

export function promoteCategoryToReal(ctx: AppContext, categoryId: number | null | undefined): void {
  if (!categoryId) return;
  const row = ctx.db.get<{ id: number; parent_id: number | null; is_demo: number }>('SELECT id, parent_id, is_demo FROM categories WHERE id = ?', [categoryId]);
  if (!row) return;
  if (row.is_demo) ctx.db.run('UPDATE categories SET is_demo = 0 WHERE id = ?', [categoryId]);
  if (row.parent_id) promoteCategoryToReal(ctx, row.parent_id);
}

/** Returns true when the product was a DEMO row and has now become a regular catalogue entry. */
export function promoteProductToReal(ctx: AppContext, productId: number): boolean {
  const product = ctx.db.get<{ id: number; brand_id: number; category_id: number; subcategory_id: number | null; is_demo: number }>(
    'SELECT id, brand_id, category_id, subcategory_id, is_demo FROM products WHERE id = ?',
    [productId],
  );
  if (!product || !product.is_demo) return false;
  ctx.db.run('UPDATE products SET is_demo = 0, updated_at = ? WHERE id = ?', [nowIso(), productId]);
  promoteBrandToReal(ctx, product.brand_id);
  promoteCategoryToReal(ctx, product.category_id);
  promoteCategoryToReal(ctx, product.subcategory_id);
  // A mapping is demo data only while one of its two products is.
  ctx.db.run(
    `UPDATE competitor_mappings SET is_demo = 0
     WHERE (own_product_id = ? OR competitor_product_id = ?) AND is_demo = 1
       AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id IN (own_product_id, competitor_product_id) AND p.is_demo = 1)`,
    [productId, productId],
  );
  return true;
}

// ---------------------------------------------------------------------------------------------
// Matching a listing to a canonical product
// ---------------------------------------------------------------------------------------------
export function normaliseGtin(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length ? digits : null;
}

const gtinKey = (value: string | null | undefined) => normaliseGtin(value)?.replace(/^0+/, '') || null;

export function matchListing(
  ctx: AppContext,
  input: { listingId: number; productId: number; variantId?: number | null; user: AuthUser | null; via: 'manual' | 'suggestion' | 'create' | 'edit'; ip?: string | null },
): void {
  const listing = ctx.db.get<{
    id: number; product_id: number | null; variant_id: number | null; is_demo: number; gtin: string | null; title: string | null; url: string | null; market_id: number;
  }>(
    `SELECT l.id, l.product_id, l.variant_id, l.is_demo, l.gtin, l.title, l.url, r.market_id
     FROM retailer_listings l JOIN retailers r ON r.id = l.retailer_id WHERE l.id = ?`,
    [input.listingId],
  );
  if (!listing) throw notFound('Listing');
  const product = ctx.db.get<{ id: number; status: string; is_demo: number }>('SELECT id, status, is_demo FROM products WHERE id = ?', [input.productId]);
  if (!product) throw unprocessable('The selected product does not exist');
  if (product.status === 'archived') throw unprocessable('Archived products cannot be mapped to listings — restore the product first');
  let variantId = input.variantId ?? null;
  if (variantId) {
    const variant = ctx.db.get<{ product_id: number }>('SELECT product_id FROM product_variants WHERE id = ?', [variantId]);
    if (!variant || variant.product_id !== product.id) throw unprocessable('The pack variant does not belong to the selected product');
  } else if (input.via === 'suggestion') {
    variantId = impliedVariant(ctx, product.id, listing);
  }
  const now = nowIso();
  ctx.db.tx(() => {
    if (!listing.is_demo && product.is_demo) promoteProductToReal(ctx, product.id);
    ctx.db.run(
      `UPDATE retailer_listings SET product_id = ?, variant_id = ?, match_status = 'matched', matched_by = ?, matched_at = ?, updated_at = ? WHERE id = ?`,
      [product.id, variantId, input.user?.id ?? null, now, now, listing.id],
    );
    // A product listed by a retailer of a market is, by definition, available in that market.
    ctx.db.run('INSERT OR IGNORE INTO product_markets (product_id, market_id) VALUES (?, ?)', [product.id, listing.market_id]);
    // Close the open questions for this listing: the chosen product's suggestion is approved, the rest rejected.
    ctx.db.run(
      `UPDATE listing_match_suggestions SET status = CASE WHEN product_id = ? THEN 'approved' ELSE 'rejected' END, decided_by = ?, decided_at = ?
       WHERE listing_id = ? AND status = 'pending'`,
      [product.id, input.user?.id ?? null, now, listing.id],
    );
    audit(ctx, input.user, 'listing.matched', 'listing', listing.id, {
      product_id: product.id,
      variant_id: variantId,
      previous_product_id: listing.product_id,
      via: input.via,
    }, input.ip);
  });
}

/**
 * The pack variant a listing evidently refers to, when approving a suggestion: the variant carrying the
 * listing's barcode, or — when the listing states a pack that differs from the product's base pack — the
 * single active variant with exactly that content. null = the product's base pack.
 */
function impliedVariant(ctx: AppContext, productId: number, listing: { gtin: string | null; title: string | null; url: string | null }): number | null {
  const variants = ctx.db.all<{ id: number; gtin: string | null; pack_size: number; pack_unit: string; units_per_pack: number }>(
    'SELECT id, gtin, pack_size, pack_unit, units_per_pack FROM product_variants WHERE product_id = ? AND is_active = 1',
    [productId],
  );
  if (variants.length === 0) return null;
  const key = gtinKey(listing.gtin);
  if (key) {
    const byBarcode = variants.find((v) => gtinKey(v.gtin) === key);
    if (byBarcode) return byBarcode.id;
  }
  const parsed = parsePackFromText(listingText(listing.title, listing.url));
  const stated = parsed ? packContent(parsed.packSize, parsed.packUnit, parsed.unitsPerPack) : null;
  if (!stated) return null;
  const base = ctx.db.get<{ pack_size: number | null; pack_unit: string | null; units_per_pack: number }>(
    'SELECT pack_size, pack_unit, units_per_pack FROM products WHERE id = ?',
    [productId],
  )!;
  const baseContent = packContent(base.pack_size, base.pack_unit, base.units_per_pack);
  if (baseContent && sameContent(stated, baseContent)) return null;
  const sameSize = variants.filter((v) => {
    const content = packContent(v.pack_size, v.pack_unit, v.units_per_pack);
    return content !== null && sameContent(stated, content);
  });
  return sameSize.length === 1 ? sameSize[0]!.id : null;
}

export function unmatchListing(ctx: AppContext, listingId: number, user: AuthUser | null, ip?: string | null): void {
  const listing = ctx.db.get<{ id: number; product_id: number | null; match_status: string }>(
    'SELECT id, product_id, match_status FROM retailer_listings WHERE id = ?',
    [listingId],
  );
  if (!listing) throw notFound('Listing');
  if (listing.match_status === 'unmatched') return; // already in the review queue
  const now = nowIso();
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE retailer_listings SET product_id = NULL, variant_id = NULL, match_status = 'unmatched', matched_by = NULL, matched_at = NULL, updated_at = ? WHERE id = ?`,
      [now, listingId],
    );
    if (listing.product_id) {
      // The mapping was judged wrong: do not offer the same product again.
      ctx.db.run(
        `INSERT INTO listing_match_suggestions (listing_id, product_id, score, reasons, status, decided_by, decided_at, created_at)
         VALUES (?, ?, 0, '["Previously matched, then unmatched by a user"]', 'rejected', ?, ?, ?)
         ON CONFLICT(listing_id, product_id) DO UPDATE SET status = 'rejected', decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
        [listingId, listing.product_id, user?.id ?? null, now, now],
      );
    }
    audit(ctx, user, 'listing.unmatched', 'listing', listingId, { previous_product_id: listing.product_id, previous_status: listing.match_status }, ip);
  });
}

// ---------------------------------------------------------------------------------------------
// Listing → product match suggestions
// ---------------------------------------------------------------------------------------------
const STOP_WORDS = new Set(['the', 'and', 'with', 'for', 'of', 'in', 'by', 'new', 'pack', 'pcs', 'pc', 'per', 'to']);
const SIZE_RE = /(?:\d+\s*[x×]\s*)?\d+(?:[.,]\d+)?\s*(?:ml|ltr|litres?|liters?|l|gms?|kg|g)\b/gi;

/** Lower-cased, accent-free word tokens without pack sizes, stop words or plural endings. */
export function tokenise(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(SIZE_RE, ' ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
    .map((t) => (t.length >= 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const tokensMatch = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && withinOneEdit(a, b));

/**
 * Number of `needles` that find a distinct partner in `haystack`. Also pairs compounds written apart
 * or together ("toothpaste" ↔ "tooth paste", "hairfall" ↔ "hair fall").
 */
function matchedCount(needles: string[], haystack: string[]): number {
  const used = new Array<boolean>(haystack.length).fill(false);
  const found = new Array<boolean>(needles.length).fill(false);
  needles.forEach((n, ni) => {
    const idx = haystack.findIndex((h, i) => !used[i] && tokensMatch(n, h));
    if (idx >= 0) {
      used[idx] = true;
      found[ni] = true;
    }
  });
  for (let ni = 0; ni < needles.length; ni++) {
    if (found[ni]) continue;
    for (let i = 0; i + 1 < haystack.length; i++) {
      if (!used[i] && !used[i + 1] && haystack[i]! + haystack[i + 1]! === needles[ni]) {
        used[i] = true;
        used[i + 1] = true;
        found[ni] = true;
        break;
      }
    }
    if (found[ni] || ni + 1 >= needles.length || found[ni + 1]) continue;
    const joined = needles[ni]! + needles[ni + 1]!;
    const idx = haystack.findIndex((h, i) => !used[i] && h === joined);
    if (idx >= 0) {
      used[idx] = true;
      found[ni] = true;
      found[ni + 1] = true;
    }
  }
  return found.filter(Boolean).length;
}

const sameContent = (a: PackContent, b: PackContent) => a.dimension === b.dimension && Math.abs(a.amount / b.amount - 1) <= 0.01;

interface Candidate {
  id: number;
  gtinKey: string | null;
  gtin: string | null;
  brandName: string;
  brandTokens: string[];
  tokens: string[];
  content: PackContent | null;
  packLabel: string;
  variants: Array<{ name: string; content: PackContent | null; packLabel: string; gtinKey: string | null }>;
}

function loadCandidates(ctx: AppContext): Candidate[] {
  const products = ctx.db.all<{
    id: number; name: string; gtin: string | null; pack_size: number | null; pack_unit: string | null; units_per_pack: number; brand_name: string;
  }>(
    `SELECT p.id, p.name, p.gtin, p.pack_size, p.pack_unit, p.units_per_pack, b.name AS brand_name
     FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.status <> 'archived'`,
  );
  const variantsByProduct = new Map<number, Candidate['variants']>();
  for (const v of ctx.db.all<{ product_id: number; name: string; pack_size: number; pack_unit: string; units_per_pack: number; gtin: string | null }>(
    'SELECT product_id, name, pack_size, pack_unit, units_per_pack, gtin FROM product_variants WHERE is_active = 1',
  )) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push({
      name: v.name,
      content: packContent(v.pack_size, v.pack_unit, v.units_per_pack),
      packLabel: formatPack(v.pack_size, v.pack_unit, v.units_per_pack),
      gtinKey: gtinKey(v.gtin),
    });
    variantsByProduct.set(v.product_id, list);
  }
  return products.map((p) => {
    const brandTokens = tokenise(p.brand_name);
    const nameTokens = tokenise(p.name);
    // "Dabur Amla" + "Dabur Amla Hair Oil" → every word counted once.
    const tokens = [...brandTokens, ...nameTokens.filter((t) => !brandTokens.includes(t))];
    return {
      id: p.id,
      gtinKey: gtinKey(p.gtin),
      gtin: p.gtin,
      brandName: p.brand_name,
      brandTokens,
      tokens,
      content: packContent(p.pack_size, p.pack_unit, p.units_per_pack),
      packLabel: formatPack(p.pack_size, p.pack_unit, p.units_per_pack),
      variants: variantsByProduct.get(p.id) ?? [],
    };
  });
}

export interface ScoredMatch {
  product_id: number;
  score: number;
  reasons: string[];
}

function listingText(title: string | null, url: string | null): string {
  if (title && title.trim()) return title;
  if (!url) return '';
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_/+.]+/g, ' ');
  } catch {
    return '';
  }
}

/** Pure scoring of one listing against one product candidate. Returns null when there is nothing in common. */
function scoreCandidate(text: string, listingTokens: string[], listingGtinKey: string | null, c: Candidate): ScoredMatch | null {
  if (listingGtinKey && c.gtinKey && listingGtinKey === c.gtinKey) {
    return { product_id: c.id, score: 1, reasons: [`Barcode (GTIN ${c.gtin}) matches exactly`] };
  }
  if (listingGtinKey) {
    const variant = c.variants.find((v) => v.gtinKey === listingGtinKey);
    if (variant) return { product_id: c.id, score: 1, reasons: [`Barcode matches the pack variant "${variant.name}" (${variant.packLabel})`] };
  }
  if (listingTokens.length === 0 || c.tokens.length === 0) return null;
  const matched = matchedCount(c.tokens, listingTokens);
  if (matched === 0) return null;
  // How much of the product's wording the listing contains, tempered by how much else the listing says.
  const coverage = matched / c.tokens.length;
  const dice = (2 * matched) / (c.tokens.length + listingTokens.length);
  const name = 0.65 * coverage + 0.35 * dice;
  const reasons = [`Name similarity ${Math.round(name * 100)}% (${matched} of ${c.tokens.length} product words found)`];

  // Weights add up to 0.99 for a perfect name + brand + pack match; 1.0 is reserved for a barcode match.
  let score = NAME_WEIGHT * name;
  const brandKnown = c.brandTokens.length > 0;
  const brandPresent = brandKnown && matchedCount(c.brandTokens, listingTokens) === c.brandTokens.length;
  if (brandPresent) {
    score += BRAND_BONUS;
    reasons.push(`Brand "${c.brandName}" appears in the listing`);
  } else if (brandKnown) {
    score *= 0.6;
    reasons.push(`Brand "${c.brandName}" not found in the listing`);
  }
  // A pack-size coincidence must not rescue a weak, different-brand name match.
  const packCounts = brandPresent || name >= 0.6;

  const parsed = parsePackFromText(text);
  const listingContent = parsed ? packContent(parsed.packSize, parsed.packUnit, parsed.unitsPerPack) : null;
  const listingPackLabel = parsed ? formatPack(parsed.packSize, parsed.packUnit, parsed.unitsPerPack) : '';
  if (listingContent && c.content) {
    const variant = c.variants.find((v) => v.content && sameContent(listingContent, v.content));
    const perUnit = parsed && parsed.unitsPerPack > 1 ? packContent(parsed.packSize, parsed.packUnit, 1) : null;
    if (sameContent(listingContent, c.content)) {
      if (packCounts) score += PACK_BONUS;
      reasons.push(`Pack size matches (${c.packLabel})`);
    } else if (variant) {
      if (packCounts) score += VARIANT_BONUS;
      reasons.push(`Pack size matches the pack variant "${variant.name}" (${variant.packLabel})`);
    } else if (perUnit && sameContent(perUnit, c.content)) {
      score = Math.min(score, 0.7);
      reasons.push(`Listing is a multi-pack (${listingPackLabel}) of this product's ${c.packLabel} pack — match it through a pack variant so unit prices stay correct`);
    } else {
      // Same name, different size = a different SKU until a person says otherwise.
      score = Math.min(score, 0.5);
      reasons.push(`Pack size differs (listing ${listingPackLabel} vs product ${c.packLabel})`);
    }
  } else if (!listingContent) {
    score = Math.min(score, 0.8);
    reasons.push('No pack size found in the listing title — size could not be verified');
  } else {
    score = Math.min(score, 0.8);
    reasons.push('The product has no pack size on record — size could not be verified');
  }
  if (brandKnown && !brandPresent) score = Math.min(score, 0.45);
  return { product_id: c.id, score: Math.round(Math.min(0.99, Math.max(0, score)) * 1000) / 1000, reasons };
}

const NAME_WEIGHT = 0.74;
const BRAND_BONUS = 0.1;
const PACK_BONUS = 0.15;
const VARIANT_BONUS = 0.1;
const SUGGESTION_MIN_SCORE = 0.3;
const SUGGESTION_KEEP = 3;

/** Ranks product candidates for a listing (best first). */
function scoreListing(
  listing: { title: string | null; url: string | null; gtin: string | null },
  candidates: Candidate[],
  exclude: Set<number> = new Set(),
): ScoredMatch[] {
  const text = listingText(listing.title, listing.url);
  const tokens = tokenise(text);
  const key = gtinKey(listing.gtin);
  const scored: ScoredMatch[] = [];
  for (const c of candidates) {
    if (exclude.has(c.id)) continue;
    const s = scoreCandidate(text, tokens, key, c);
    if (s && s.score >= SUGGESTION_MIN_SCORE) scored.push(s);
  }
  scored.sort((a, b) => b.score - a.score || a.product_id - b.product_id);
  return scored.slice(0, SUGGESTION_KEEP);
}

/**
 * (Re)computes pending match suggestions for unmatched listings — all of them, or the given ids.
 * Decisions already taken are respected: a rejected product is never suggested again for that listing.
 * Nothing is ever approved automatically. Returns the number of pending suggestions now on record
 * for the processed listings.
 */
export function refreshListingSuggestions(ctx: AppContext, listingIds?: number[]): number {
  const where = ["l.match_status = 'unmatched'"];
  const params: SqlParam[] = [];
  if (listingIds) {
    if (listingIds.length === 0) return 0;
    where.push(`l.id IN (${placeholders(listingIds.length)})`);
    params.push(...listingIds);
  }
  const listings = ctx.db.all<{ id: number; title: string | null; url: string | null; gtin: string | null }>(
    `SELECT l.id, l.title, l.url, l.gtin FROM retailer_listings l WHERE ${where.join(' AND ')}`,
    params,
  );
  if (listings.length === 0) return 0;
  const candidates = loadCandidates(ctx);
  const now = nowIso();
  let pending = 0;
  ctx.db.tx(() => {
    for (const listing of listings) {
      const decided = new Set(
        ctx.db
          .all<{ product_id: number }>(`SELECT product_id FROM listing_match_suggestions WHERE listing_id = ? AND status <> 'pending'`, [listing.id])
          .map((r) => r.product_id),
      );
      const top = scoreListing(listing, candidates, decided);
      if (top.length === 0) {
        ctx.db.run(`DELETE FROM listing_match_suggestions WHERE listing_id = ? AND status = 'pending'`, [listing.id]);
        continue;
      }
      ctx.db.run(
        `DELETE FROM listing_match_suggestions WHERE listing_id = ? AND status = 'pending' AND product_id NOT IN (${placeholders(top.length)})`,
        [listing.id, ...top.map((s) => s.product_id)],
      );
      for (const s of top) {
        ctx.db.run(
          `INSERT INTO listing_match_suggestions (listing_id, product_id, score, reasons, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)
           ON CONFLICT(listing_id, product_id) DO UPDATE SET score = excluded.score, reasons = excluded.reasons WHERE status = 'pending'`,
          [listing.id, s.product_id, s.score, JSON.stringify(s.reasons), now],
        );
        pending++;
      }
    }
  });
  return pending;
}

export function fetchSuggestions(ctx: AppContext, listingIds: number[], statuses: string[] = ['pending']): Map<number, MatchSuggestion[]> {
  const out = new Map<number, MatchSuggestion[]>();
  if (listingIds.length === 0) return out;
  for (let i = 0; i < listingIds.length; i += 400) {
    const chunk = listingIds.slice(i, i + 400);
    const rows = ctx.db.all<Omit<MatchSuggestion, 'reasons' | 'pack_label'> & { reasons: string; pack_size: number | null; pack_unit: string | null; units_per_pack: number }>(
      `SELECT s.id, s.listing_id, s.product_id, p.code AS product_code, p.name AS product_name, b.name AS brand_name, b.ownership,
         p.gtin AS product_gtin, p.is_demo AS product_is_demo, p.pack_size, p.pack_unit, p.units_per_pack,
         s.score, s.reasons, s.status, s.decided_at, s.created_at
       FROM listing_match_suggestions s JOIN products p ON p.id = s.product_id JOIN brands b ON b.id = p.brand_id
       WHERE s.listing_id IN (${placeholders(chunk.length)}) AND s.status IN (${placeholders(statuses.length)})
       ORDER BY s.score DESC, s.id`,
      [...chunk, ...statuses],
    );
    for (const { pack_size, pack_unit, units_per_pack, reasons, ...row } of rows) {
      let parsed: string[] = [];
      try {
        parsed = JSON.parse(reasons) as string[];
      } catch {
        parsed = [];
      }
      const list = out.get(row.listing_id) ?? [];
      list.push({ ...row, reasons: parsed, pack_label: formatPack(pack_size, pack_unit, units_per_pack) });
      out.set(row.listing_id, list);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Competitor equivalence mappings
// ---------------------------------------------------------------------------------------------
interface PackLike {
  pack_size: number | null;
  pack_unit: string | null;
  units_per_pack: number | null;
}

/** Tolerance within which two packs of the same dimension may be suggested as "equivalent". */
export const EQUIVALENT_SIZE_TOLERANCE = 0.15;

/** How two packs can be compared: like-for-like, on unit price only, or not at all. */
export function comparability(own: PackLike, competitor: PackLike): Comparability {
  const a = packContent(own.pack_size, own.pack_unit, own.units_per_pack);
  const b = packContent(competitor.pack_size, competitor.pack_unit, competitor.units_per_pack);
  const la = formatPack(own.pack_size, own.pack_unit, own.units_per_pack);
  const lb = formatPack(competitor.pack_size, competitor.pack_unit, competitor.units_per_pack);
  if (!a || !b) {
    return {
      same_dimension: null,
      size_ratio: null,
      unit_basis: null,
      same_size: false,
      within_tolerance: false,
      note: `Pack size unknown for ${!a && !b ? 'both products' : !a ? 'the own product' : 'the competitor product'} — equivalence and unit prices cannot be verified`,
    };
  }
  if (a.dimension !== b.dimension) {
    return {
      same_dimension: false,
      size_ratio: null,
      unit_basis: null,
      same_size: false,
      within_tolerance: false,
      note: `Units differ: ${own.pack_unit} vs ${competitor.pack_unit} (${la} vs ${lb}) — unit prices cannot be compared`,
    };
  }
  const ratio = b.amount / a.amount;
  const spread = Math.max(a.amount, b.amount) / Math.min(a.amount, b.amount) - 1;
  const basis = unitBasisLabel(a.dimension);
  const sameSize = spread <= 0.01;
  const within = spread <= EQUIVALENT_SIZE_TOLERANCE + 1e-9;
  return {
    same_dimension: true,
    size_ratio: Math.round(ratio * 1000) / 1000,
    unit_basis: basis,
    same_size: sameSize,
    within_tolerance: within,
    note: sameSize
      ? `Same pack size (${la}) — like-for-like comparison`
      : within
        ? `Pack sizes within ${Math.round(EQUIVALENT_SIZE_TOLERANCE * 100)}% (${la} vs ${lb}) — compare on price ${basis}`
        : `Size differs ${la} vs ${lb} — not like-for-like, compare on price ${basis} only`,
  };
}

const MAPPING_SELECT = `
  SELECT m.id, m.own_product_id, m.competitor_product_id, m.market_id, mk.name AS market_name, m.equivalence, m.status, m.score,
    m.rationale, m.decided_by, u.name AS decided_by_name, m.decided_at, m.is_demo, m.created_at, m.updated_at,
    op.code AS own_code, op.name AS own_name, op.brand_id AS own_brand_id, ob.name AS own_brand_name, op.pack_size AS own_pack_size,
    op.pack_unit AS own_pack_unit, op.units_per_pack AS own_units_per_pack, op.status AS own_status, op.is_demo AS own_is_demo,
    cp.code AS comp_code, cp.name AS comp_name, cp.brand_id AS comp_brand_id, cb.name AS comp_brand_name, cp.pack_size AS comp_pack_size,
    cp.pack_unit AS comp_pack_unit, cp.units_per_pack AS comp_units_per_pack, cp.status AS comp_status, cp.is_demo AS comp_is_demo
  FROM competitor_mappings m
  JOIN products op ON op.id = m.own_product_id JOIN brands ob ON ob.id = op.brand_id
  JOIN products cp ON cp.id = m.competitor_product_id JOIN brands cb ON cb.id = cp.brand_id
  LEFT JOIN markets mk ON mk.id = m.market_id
  LEFT JOIN users u ON u.id = m.decided_by`;
export const MAPPING_FROM_COUNT = `
  FROM competitor_mappings m
  JOIN products op ON op.id = m.own_product_id JOIN brands ob ON ob.id = op.brand_id
  JOIN products cp ON cp.id = m.competitor_product_id JOIN brands cb ON cb.id = cp.brand_id`;

interface RawMapping {
  id: number; own_product_id: number; competitor_product_id: number; market_id: number | null; market_name: string | null;
  equivalence: MappingRow['equivalence']; status: MappingRow['status']; score: number | null; rationale: string | null;
  decided_by: number | null; decided_by_name: string | null; decided_at: string | null; is_demo: number; created_at: string; updated_at: string;
  own_code: string; own_name: string; own_brand_id: number; own_brand_name: string; own_pack_size: number | null; own_pack_unit: string | null;
  own_units_per_pack: number; own_status: string; own_is_demo: number;
  comp_code: string; comp_name: string; comp_brand_id: number; comp_brand_name: string; comp_pack_size: number | null; comp_pack_unit: string | null;
  comp_units_per_pack: number; comp_status: string; comp_is_demo: number;
}

function side(
  id: number, code: string, name: string, brandId: number, brandName: string, packSize: number | null, packUnit: string | null,
  unitsPerPack: number, status: string, isDemo: number,
): MappingProductSide {
  const content = packContent(packSize, packUnit, unitsPerPack);
  return {
    product_id: id,
    product_code: code,
    product_name: name,
    brand_id: brandId,
    brand_name: brandName,
    pack_size: packSize,
    pack_unit: packUnit as MappingProductSide['pack_unit'],
    units_per_pack: unitsPerPack,
    pack_label: formatPack(packSize, packUnit, unitsPerPack),
    content_amount: content?.amount ?? null,
    content_dimension: content?.dimension ?? null,
    status: status as MappingProductSide['status'],
    is_demo: isDemo,
  };
}

function mapMapping(r: RawMapping): MappingRow {
  return {
    id: r.id,
    own: side(r.own_product_id, r.own_code, r.own_name, r.own_brand_id, r.own_brand_name, r.own_pack_size, r.own_pack_unit, r.own_units_per_pack, r.own_status, r.own_is_demo),
    competitor: side(r.competitor_product_id, r.comp_code, r.comp_name, r.comp_brand_id, r.comp_brand_name, r.comp_pack_size, r.comp_pack_unit, r.comp_units_per_pack, r.comp_status, r.comp_is_demo),
    market_id: r.market_id,
    market_name: r.market_name,
    equivalence: r.equivalence,
    status: r.status,
    score: r.score,
    rationale: r.rationale,
    decided_by: r.decided_by,
    decided_by_name: r.decided_by_name,
    decided_at: r.decided_at,
    is_demo: r.is_demo,
    created_at: r.created_at,
    updated_at: r.updated_at,
    comparability: comparability(
      { pack_size: r.own_pack_size, pack_unit: r.own_pack_unit, units_per_pack: r.own_units_per_pack },
      { pack_size: r.comp_pack_size, pack_unit: r.comp_pack_unit, units_per_pack: r.comp_units_per_pack },
    ),
  };
}

export function fetchMappings(
  ctx: AppContext,
  options: { where?: string[]; params?: SqlParam[]; order?: string; limit?: number; offset?: number } = {},
): MappingRow[] {
  const where = options.where?.length ? `WHERE ${options.where.join(' AND ')}` : '';
  const limit = options.limit !== undefined ? `LIMIT ${Math.floor(options.limit)} OFFSET ${Math.floor(options.offset ?? 0)}` : '';
  return ctx.db
    .all<RawMapping>(
      `${MAPPING_SELECT} ${where} ORDER BY ${options.order ?? "CASE m.status WHEN 'suggested' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, ob.name, op.name, m.score DESC, cb.name, cp.name"} ${limit}`,
      options.params ?? [],
    )
    .map(mapMapping);
}

export function getMapping(ctx: AppContext, id: number): MappingRow {
  const row = fetchMappings(ctx, { where: ['m.id = ?'], params: [id] })[0];
  if (!row) throw notFound('Mapping');
  return row;
}

interface MappingProduct {
  id: number; name: string; brand_id: number; ownership: string; category_id: number; subcategory_id: number | null;
  category_name: string; subcategory_name: string | null; pack_size: number | null; pack_unit: string | null; units_per_pack: number;
  status: string; is_demo: number;
}

export function mappingProduct(ctx: AppContext, id: number): MappingProduct | undefined {
  return ctx.db.get<MappingProduct>(
    `SELECT p.id, p.name, p.brand_id, b.ownership, p.category_id, p.subcategory_id, c.name AS category_name, sc.name AS subcategory_name,
       p.pack_size, p.pack_unit, p.units_per_pack, p.status, p.is_demo
     FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id
     LEFT JOIN categories sc ON sc.id = p.subcategory_id WHERE p.id = ?`,
    [id],
  );
}

const SUGGEST_PER_PRODUCT = 8;
const SUGGEST_PER_PRODUCT_BULK = 3;

export interface SuggestMappingOptions {
  /** Most suggestions per own product. Default: 8 for one product, 3 when suggesting for the whole catalogue. */
  perProduct?: number;
  /** Whole-catalogue runs only: consider own products listed at this many retailers or more. */
  minRetailers?: number;
}

/**
 * Proposes competitor mappings for own products (status 'suggested' — a person approves or rejects).
 * Candidates share the own product's subcategory (or, failing that, its category). A pair is proposed as
 * 'equivalent' only when both packs are measured in the same dimension and are within ±15 % of each
 * other; everything else is proposed as 'comparable', i.e. explicitly not equivalent.
 *
 * Products that are sold side by side rank first: a price position only exists where an own product and
 * its competitor are listed at the same retailer. A run over the whole catalogue therefore proposes, for an
 * own product that is listed somewhere, only competitors that share at least one retailer with it.
 */
export function suggestCompetitorMappings(
  ctx: AppContext,
  ownProductId?: number,
  options: SuggestMappingOptions = {},
): { createdIds: number[]; considered: number } {
  const bulk = ownProductId === undefined;
  const perProduct = Math.max(1, Math.min(20, options.perProduct ?? (bulk ? SUGGEST_PER_PRODUCT_BULK : SUGGEST_PER_PRODUCT)));
  const productSelect = `SELECT p.id, p.name, p.brand_id, b.ownership, p.category_id, p.subcategory_id, c.name AS category_name,
      sc.name AS subcategory_name, p.pack_size, p.pack_unit, p.units_per_pack, p.status, p.is_demo
    FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id
    LEFT JOIN categories sc ON sc.id = p.subcategory_id`;
  const retailersOf = new Map<number, Set<number>>();
  for (const row of ctx.db.all<{ product_id: number; retailer_id: number }>(
    `SELECT DISTINCT product_id, retailer_id FROM retailer_listings WHERE product_id IS NOT NULL AND match_status = 'matched' AND is_active = 1`,
  )) {
    const set = retailersOf.get(row.product_id);
    if (set) set.add(row.retailer_id);
    else retailersOf.set(row.product_id, new Set([row.retailer_id]));
  }
  const none = new Set<number>();
  const allOwn = ownProductId
    ? ctx.db.all<MappingProduct>(`${productSelect} WHERE p.id = ? AND b.ownership = 'own' AND p.status <> 'archived'`, [ownProductId])
    : ctx.db.all<MappingProduct>(`${productSelect} WHERE b.ownership = 'own' AND p.status <> 'archived' ORDER BY p.id`);
  const minRetailers = bulk ? (options.minRetailers ?? 0) : 0;
  const own = minRetailers > 0 ? allOwn.filter((o) => (retailersOf.get(o.id)?.size ?? 0) >= minRetailers) : allOwn;
  const competitors = ctx.db.all<MappingProduct>(`${productSelect} WHERE b.ownership = 'competitor' AND p.status <> 'archived' ORDER BY p.id`);
  const existing = new Set(
    ctx.db.all<{ own_product_id: number; competitor_product_id: number }>('SELECT own_product_id, competitor_product_id FROM competitor_mappings').map(
      (r) => `${r.own_product_id}:${r.competitor_product_id}`,
    ),
  );
  const associated = new Set(
    ctx.db.all<{ own_brand_id: number; competitor_brand_id: number }>('SELECT own_brand_id, competitor_brand_id FROM brand_competitors').map(
      (r) => `${r.own_brand_id}:${r.competitor_brand_id}`,
    ),
  );
  const now = nowIso();
  const createdIds: number[] = [];
  ctx.db.tx(() => {
    for (const o of own) {
      const sameSub = o.subcategory_id ? competitors.filter((c) => c.subcategory_id === o.subcategory_id) : [];
      // One product at a time, the wider category is offered when the subcategory has no competitor; a run over the whole
      // catalogue stays within the subcategory (a hair colour is not proposed against a hair oil).
      const pool = sameSub.length ? sameSub : bulk ? [] : competitors.filter((c) => c.category_id === o.category_id);
      const ownRetailers = retailersOf.get(o.id) ?? none;
      const sharedWith = (c: MappingProduct) => {
        let n = 0;
        for (const id of retailersOf.get(c.id) ?? none) if (ownRetailers.has(id)) n++;
        return n;
      };
      const proposals = pool
        .filter((c) => !existing.has(`${o.id}:${c.id}`))
        .map((c) => ({ c, shared: sharedWith(c) }))
        // across the whole catalogue: only pairs that can actually be compared at a retailer
        .filter(({ shared }) => !bulk || ownRetailers.size === 0 || shared > 0)
        .map(({ c, shared }) => {
          const cmp = comparability(o, c);
          const inSub = !!o.subcategory_id && c.subcategory_id === o.subcategory_id;
          const equivalent = cmp.same_dimension === true && cmp.within_tolerance;
          const spread = cmp.same_dimension && cmp.size_ratio ? Math.max(cmp.size_ratio, 1 / cmp.size_ratio) - 1 : null;
          const closeness = spread === null ? 0 : Math.max(0, 1 - spread);
          const brandLinked = associated.has(`${o.brand_id}:${c.brand_id}`);
          const score = Math.min(1, 0.45 + (inSub ? 0.2 : 0) + 0.3 * closeness + (brandLinked ? 0.05 : 0) + 0.02 * Math.min(shared, 5));
          const scope = inSub ? `Same subcategory (${o.category_name} › ${o.subcategory_name})` : `Same category (${o.category_name})`;
          const la = formatPack(o.pack_size, o.pack_unit, o.units_per_pack);
          const lb = formatPack(c.pack_size, c.pack_unit, c.units_per_pack);
          let size: string;
          if (cmp.same_dimension === null) size = 'pack size unknown — equivalence cannot be confirmed';
          else if (cmp.same_dimension === false) size = `units differ: ${o.pack_unit} vs ${c.pack_unit} — unit prices cannot be compared`;
          else if (cmp.same_size) size = `same pack size (${la})`;
          else if (cmp.within_tolerance) size = `pack sizes within 15% (${la} vs ${lb})`;
          else size = `size differs ${la} vs ${lb} — not equivalent, compare on price ${cmp.unit_basis}`;
          return {
            competitor: c,
            shared,
            equivalence: equivalent ? 'equivalent' : 'comparable',
            score: Math.round(score * 100) / 100,
            rationale:
              `${scope}; ${size}${brandLinked ? '; brands are benchmarked against each other' : ''}` +
              (shared > 0 ? `; listed side by side at ${shared} retailer${shared === 1 ? '' : 's'}` : ''),
          };
        })
        .sort((a, b) => b.score - a.score || b.shared - a.shared || a.competitor.id - b.competitor.id)
        .slice(0, perProduct);
      for (const p of proposals) {
        const id = ctx.db.run(
          `INSERT INTO competitor_mappings (own_product_id, competitor_product_id, market_id, equivalence, status, score, rationale, is_demo, created_at, updated_at)
           VALUES (?, ?, NULL, ?, 'suggested', ?, ?, ?, ?, ?)`,
          [o.id, p.competitor.id, p.equivalence, p.score, p.rationale, o.is_demo || p.competitor.is_demo ? 1 : 0, now, now],
        ).lastInsertRowid;
        existing.add(`${o.id}:${p.competitor.id}`);
        createdIds.push(id);
      }
    }
  });
  return { createdIds, considered: own.length };
}
