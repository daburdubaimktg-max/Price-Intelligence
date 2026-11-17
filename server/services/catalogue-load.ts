/**
 * Bulk catalogue load.
 *
 * Brings a prepared snapshot of retailer listings into the system in one pass: the retailers, the canonical
 * products the listings belong to, the listings themselves and — when the snapshot carries one — the price
 * that was observed for each listing, with its deal tags, rating, sales rank and seller.
 *
 * It exists for first loads and large back-fills (for example the datasets of a third-party collection
 * provider), where creating thousands of products by hand is not an option. The rules of the ledger are the
 * same as everywhere else:
 *   * observations enter through `ingestObservations` — append-only, validated, de-duplicated;
 *   * every observation points at a `source_evidence` row that says where the data came from;
 *   * a listing is only linked to a product when the snapshot states the basis of the match, and that basis
 *     is kept with the listing (as an approved match suggestion) so a person can review or undo it;
 *   * nothing is ever flagged as DEMO and nothing simulated can be loaded this way.
 *
 * The load is idempotent: running it again creates nothing twice (retailers by name and market, brands and
 * categories by name, products through their barcode or their existing listings, listings by the retailer's
 * item id, observations by their identity).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext, AuthUser } from '../context.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { nowIso } from '../lib/time.ts';
import { AVAILABILITY, PACK_UNITS, PROMO_TYPES, normaliseDealTags } from '../../shared/constants.ts';
import { audit } from './core.ts';
import { ingestObservations, type ObservationInput, type RejectedObservation } from './ingestion.ts';
import { normaliseGtin, promoteBrandToReal, promoteCategoryToReal } from './matching.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullish();

const observationSchema = z.object({
  observed_at: z.string().min(10),
  current_price: z.number().positive().nullish(),
  regular_price: z.number().positive().nullish(),
  promo_type: z.enum(PROMO_TYPES).nullish(),
  promo_description: optionalText(500),
  availability: z.enum(AVAILABILITY).default('unknown'),
  /** The retailer's own wording of every tag shown with the price; mapped to tag keys by `normaliseDealTags`. */
  tag_texts: z.array(z.string()).default([]),
  rating: z.number().min(0).max(5).nullish(),
  review_count: z.number().int().min(0).nullish(),
  sales_rank: z.number().int().min(0).nullish(),
  sales_rank_label: optionalText(200),
  seller_name: optionalText(200),
  note: optionalText(1000),
  confidence: z.number().min(0).max(1).nullish(),
  evidence_key: optionalText(100),
});

export const catalogueSnapshotSchema = z.object({
  version: z.literal(1),
  source: z.object({ label: text(300), note: optionalText(2000) }),
  retailers: z.array(
    z.object({
      name: text(200),
      market: text(10),
      website: optionalText(500),
      notes: optionalText(2000),
      collection_method: z.enum(['official_api', 'product_feed', 'web_extraction', 'third_party', 'csv_import', 'manual']).default('third_party'),
      /** Non-secret connector settings to pre-fill for a NEW retailer (field mapping, endpoint). Credentials are never part of a file. */
      connector_config: z.record(z.string(), z.unknown()).nullish(),
    }),
  ),
  evidence: z
    .array(
      z.object({
        key: text(100),
        kind: z.enum(['api_response', 'feed_item', 'csv_file', 'document', 'url', 'note']).default('api_response'),
        reference: text(2000),
        captured_at: z.string().nullish(),
        note: optionalText(1000),
        excerpt: optionalText(2000),
        /** Path of a raw file to retain with the evidence (copied into the evidence directory). */
        file: optionalText(1000),
      }),
    )
    .default([]),
  brand_competitors: z.array(z.object({ own: text(200), competitor: text(200) })).default([]),
  /**
   * Listings of an earlier load that should no longer be monitored (for example an item that turned out not to
   * belong to the catalogue). They are switched off, never deleted: their observations stay in the ledger.
   */
  retired_listings: z.array(z.object({ retailer: text(200), market: text(10), external_id: text(200), reason: text(300) })).default([]),
  products: z.array(
    z.object({
      key: text(100),
      brand: text(200),
      ownership: z.enum(['own', 'competitor']),
      manufacturer: optionalText(200),
      category: text(200),
      subcategory: optionalText(200),
      name: text(300),
      gtin: optionalText(20),
      pack_size: z.number().positive().nullish(),
      pack_unit: z.enum(PACK_UNITS).nullish(),
      units_per_pack: z.number().int().min(1).default(1),
      description: optionalText(2000),
    }),
  ),
  listings: z.array(
    z.object({
      retailer: text(200),
      market: text(10),
      external_id: text(200),
      url: optionalText(2000),
      title: optionalText(500),
      gtin: optionalText(20),
      product_key: optionalText(100),
      /** Why this listing belongs to the product (shown with the listing; required to link it). */
      match_reason: optionalText(500),
      match_score: z.number().min(0).max(1).nullish(),
      observation: observationSchema.nullish(),
    }),
  ),
});

export type CatalogueSnapshot = z.input<typeof catalogueSnapshotSchema>;
type ParsedSnapshot = z.output<typeof catalogueSnapshotSchema>;

export interface CatalogueLoadOptions {
  user?: Pick<AuthUser, 'id' | 'email'> | null;
  /** Directory against which relative `evidence[].file` paths are resolved. */
  baseDir?: string;
  /** Validate and report only: everything is rolled back. */
  dryRun?: boolean;
  /**
   * Also bring products that are already on record in line with the file (brand, category, name, pack, description).
   * Off by default, so a repeated load never overwrites what a person edited in the catalogue.
   */
  updateExisting?: boolean;
}

export interface CatalogueLoadResult {
  dry_run: boolean;
  retailers_created: number;
  brands_created: number;
  categories_created: number;
  products_created: number;
  products_reused: number;
  products_updated: number;
  listings_created: number;
  listings_existing: number;
  listings_unmatched: number;
  listings_retired: number;
  products_archived: number;
  evidence_created: number;
  observations_inserted: number;
  observations_duplicate: number;
  observations_rejected: Array<RejectedObservation & { retailer: string; external_id: string }>;
  tagged_observations: number;
  warnings: string[];
}

class DryRunRollback extends Error {}

const WARNING_LIMIT = 200;

/** Loads a snapshot. Throws (and changes nothing) when the snapshot is malformed or refers to an unknown market. */
export function loadCatalogue(ctx: AppContext, input: unknown, options: CatalogueLoadOptions = {}): CatalogueLoadResult {
  const parsed = catalogueSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || 'snapshot'}: ${issue.message}`);
    throw new Error(`The catalogue file is not valid — ${first.join('; ')}`);
  }
  const snapshot: ParsedSnapshot = parsed.data;
  const { db } = ctx;
  const userId = options.user?.id ?? null;
  const result: CatalogueLoadResult = {
    dry_run: options.dryRun === true,
    retailers_created: 0,
    brands_created: 0,
    categories_created: 0,
    products_created: 0,
    products_reused: 0,
    products_updated: 0,
    listings_created: 0,
    listings_existing: 0,
    listings_unmatched: 0,
    listings_retired: 0,
    products_archived: 0,
    evidence_created: 0,
    observations_inserted: 0,
    observations_duplicate: 0,
    observations_rejected: [],
    tagged_observations: 0,
    warnings: [],
  };
  let suppressedWarnings = 0;
  const warn = (message: string) => {
    if (result.warnings.length < WARNING_LIMIT) result.warnings.push(message);
    else suppressedWarnings++;
  };

  // ---- checks that need no write -----------------------------------------------------------------
  const markets = new Map(
    db.all<{ id: number; code: string; country_code: string; currency_code: string }>('SELECT id, code, country_code, currency_code FROM markets').map((m) => [m.code.toUpperCase(), m]),
  );
  const marketOf = (code: string) => {
    const market = markets.get(code.toUpperCase());
    if (!market) throw new Error(`Market "${code}" does not exist. Create it under Administration → Markets first.`);
    return market;
  };
  snapshot.retailers.forEach((r) => marketOf(r.market));
  const retailerKey = (name: string, market: string) => `${name.toLowerCase()}|${market.toUpperCase()}`;
  const declaredRetailers = new Set(snapshot.retailers.map((r) => retailerKey(r.name, r.market)));
  const productKeys = new Set<string>();
  for (const product of snapshot.products) {
    if (productKeys.has(product.key)) throw new Error(`Product key "${product.key}" appears more than once in the catalogue file.`);
    productKeys.add(product.key);
    if ((product.pack_size == null) !== (product.pack_unit == null)) throw new Error(`Product "${product.key}": pack size and pack unit must be given together.`);
  }
  const evidenceKeys = new Set(snapshot.evidence.map((e) => e.key));
  const seenListings = new Set<string>();
  for (const listing of snapshot.listings) {
    if (!declaredRetailers.has(retailerKey(listing.retailer, listing.market))) {
      throw new Error(`Listing ${listing.external_id}: retailer "${listing.retailer}" (${listing.market}) is not in the retailers section of the file.`);
    }
    const key = `${retailerKey(listing.retailer, listing.market)}|${listing.external_id.toLowerCase()}`;
    if (seenListings.has(key)) throw new Error(`Listing ${listing.external_id} of ${listing.retailer} appears more than once in the catalogue file.`);
    seenListings.add(key);
    if (listing.product_key && !productKeys.has(listing.product_key)) throw new Error(`Listing ${listing.external_id}: product "${listing.product_key}" is not in the file.`);
    if (listing.product_key && !listing.match_reason) throw new Error(`Listing ${listing.external_id}: a listing linked to a product must state the basis of the match.`);
    if (listing.observation?.evidence_key && !evidenceKeys.has(listing.observation.evidence_key)) {
      throw new Error(`Listing ${listing.external_id}: evidence "${listing.observation.evidence_key}" is not in the file.`);
    }
  }

  const now = nowIso();
  const copiedFiles: string[] = [];
  try {
    db.tx(() => {
      // ---- retailers -------------------------------------------------------------------------------
      const retailerIds = new Map<string, number>();
      for (const r of snapshot.retailers) {
        const market = marketOf(r.market);
        const existing = db.get<{ id: number; is_demo: number }>('SELECT id, is_demo FROM retailers WHERE name = ? AND market_id = ?', [r.name, market.id]);
        if (existing?.is_demo) throw new Error(`"${r.name}" exists as a DEMO source in ${r.market}. Remove the demo data (or rename the demo source) before loading real listings for it.`);
        const id =
          existing?.id ??
          db.run(
            `INSERT INTO retailers (name, website, country_code, market_id, currency_code, collection_method, collection_frequency, is_enabled,
               connector_config, notes, is_demo, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'manual', 1, ?, ?, 0, ?, ?)`,
            [r.name, r.website ?? null, market.country_code, market.id, market.currency_code, r.collection_method, JSON.stringify(r.connector_config ?? {}), r.notes ?? null, now, now],
          ).lastInsertRowid;
        if (!existing) result.retailers_created++;
        retailerIds.set(retailerKey(r.name, r.market), id);
      }

      // ---- brands and categories -------------------------------------------------------------------
      const brandIds = new Map<string, number>();
      const brandId = (name: string, ownership: 'own' | 'competitor', manufacturer: string | null) => {
        const key = name.toLowerCase();
        const known = brandIds.get(key);
        if (known) return known;
        const existing = db.get<{ id: number; ownership: string; is_demo: number }>('SELECT id, ownership, is_demo FROM brands WHERE name = ?', [name]);
        let id: number;
        if (existing) {
          id = existing.id;
          if (existing.is_demo) promoteBrandToReal(ctx, id);
          if (existing.ownership !== ownership) warn(`Brand "${name}" already exists as ${existing.ownership === 'own' ? 'an own brand' : 'a competitor brand'}; its ownership was left unchanged.`);
        } else {
          id = db.run('INSERT INTO brands (name, ownership, manufacturer, is_demo, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)', [name, ownership, manufacturer, now, now]).lastInsertRowid;
          result.brands_created++;
        }
        brandIds.set(key, id);
        return id;
      };
      const categoryIds = new Map<string, number>();
      const categoryId = (name: string, parentId: number | null) => {
        const key = `${parentId ?? 0}|${name.toLowerCase()}`;
        const known = categoryIds.get(key);
        if (known) return known;
        const existing = db.get<{ id: number; is_demo: number }>('SELECT id, is_demo FROM categories WHERE name = ? AND COALESCE(parent_id, 0) = ?', [name, parentId ?? 0]);
        let id: number;
        if (existing) {
          id = existing.id;
          if (existing.is_demo) promoteCategoryToReal(ctx, id);
        } else {
          id = db.run('INSERT INTO categories (name, parent_id, is_demo, created_at) VALUES (?, ?, 0, ?)', [name, parentId, now]).lastInsertRowid;
          result.categories_created++;
        }
        categoryIds.set(key, id);
        return id;
      };

      // ---- products --------------------------------------------------------------------------------
      // A product of the file is recognised again through a listing that already points at a product, or through its barcode.
      const listingsOfProduct = new Map<string, ParsedSnapshot['listings']>();
      for (const listing of snapshot.listings) {
        if (!listing.product_key) continue;
        const list = listingsOfProduct.get(listing.product_key);
        if (list) list.push(listing);
        else listingsOfProduct.set(listing.product_key, [listing]);
      }
      const findListing = (retailerId: number, externalId: string) =>
        db.get<{ id: number; product_id: number | null; match_status: string; is_demo: number }>(
          'SELECT id, product_id, match_status, is_demo FROM retailer_listings WHERE retailer_id = ? AND external_id = ?',
          [retailerId, externalId],
        );
      const productIds = new Map<string, number>();
      const claimedGtins = new Set<string>();
      for (const p of snapshot.products) {
        let id: number | null = null;
        for (const listing of listingsOfProduct.get(p.key) ?? []) {
          const existing = findListing(retailerIds.get(retailerKey(listing.retailer, listing.market))!, listing.external_id);
          if (existing?.product_id) {
            id = existing.product_id;
            break;
          }
        }
        const gtin = normaliseGtin(p.gtin);
        // a barcode recognises a product that was on record before this load, never another product of the same file
        if (id === null && gtin && !claimedGtins.has(gtin)) {
          const byBarcode = db.get<{ id: number; is_demo: number }>('SELECT id, is_demo FROM products WHERE gtin = ?', [gtin]);
          if (byBarcode && !byBarcode.is_demo) id = byBarcode.id;
        }
        if (id !== null) {
          result.products_reused++;
          productIds.set(p.key, id);
          if (gtin) claimedGtins.add(gtin);
          if (options.updateExisting) {
            const brand = brandId(p.brand, p.ownership, p.manufacturer ?? null);
            const category = categoryId(p.category, null);
            const subcategory = p.subcategory ? categoryId(p.subcategory, category) : null;
            const before = db.get<Record<string, unknown>>(
              'SELECT brand_id, name, category_id, subcategory_id, pack_size, pack_unit, units_per_pack, description FROM products WHERE id = ?',
              [id],
            )!;
            const after: Record<string, unknown> = {
              brand_id: brand, name: p.name, category_id: category, subcategory_id: subcategory, pack_size: p.pack_size ?? null, pack_unit: p.pack_unit ?? null,
              units_per_pack: p.units_per_pack, description: p.description ?? null,
            };
            if (Object.keys(after).some((key) => before[key] !== after[key])) {
              db.run(
                `UPDATE products SET brand_id = ?, name = ?, category_id = ?, subcategory_id = ?, pack_size = ?, pack_unit = ?, units_per_pack = ?, description = ?, updated_at = ?
                 WHERE id = ?`,
                [brand, p.name, category, subcategory, p.pack_size ?? null, p.pack_unit ?? null, p.units_per_pack, p.description ?? null, now, id],
              );
              result.products_updated++;
            }
          }
          continue;
        }
        let storedGtin = gtin;
        if (gtin && (claimedGtins.has(gtin) || db.get('SELECT 1 FROM products WHERE gtin = ?', [gtin]))) {
          warn(`Barcode ${gtin} is already recorded for another product; "${p.name}" was created without it (its listings keep the barcode).`);
          storedGtin = null;
        }
        if (storedGtin) claimedGtins.add(storedGtin);
        const brand = brandId(p.brand, p.ownership, p.manufacturer ?? null);
        const category = categoryId(p.category, null);
        const subcategory = p.subcategory ? categoryId(p.subcategory, category) : null;
        id = db.run(
          `INSERT INTO products (brand_id, name, category_id, subcategory_id, gtin, pack_size, pack_unit, units_per_pack, description, status, is_demo,
             created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
          [brand, p.name, category, subcategory, storedGtin, p.pack_size ?? null, p.pack_unit ?? null, p.units_per_pack, p.description ?? null, userId, now, now],
        ).lastInsertRowid;
        result.products_created++;
        productIds.set(p.key, id);
      }

      for (const link of snapshot.brand_competitors) {
        const own = db.get<{ id: number; ownership: string }>('SELECT id, ownership FROM brands WHERE name = ?', [link.own]);
        const competitor = db.get<{ id: number; ownership: string }>('SELECT id, ownership FROM brands WHERE name = ?', [link.competitor]);
        if (!own || !competitor || own.ownership !== 'own' || competitor.ownership !== 'competitor') {
          warn(`Benchmark "${link.own}" vs "${link.competitor}" was skipped: both brands must exist, the first as an own brand and the second as a competitor.`);
          continue;
        }
        db.run('INSERT OR IGNORE INTO brand_competitors (own_brand_id, competitor_brand_id) VALUES (?, ?)', [own.id, competitor.id]);
      }

      // ---- evidence --------------------------------------------------------------------------------
      const evidenceIds = new Map<string, number>();
      for (const e of snapshot.evidence) {
        let file: { relative: string; name: string; size: number; sha: string; mime: string } | null = null;
        if (e.file) {
          const source = path.resolve(options.baseDir ?? process.cwd(), e.file);
          if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Evidence "${e.key}": the file ${e.file} does not exist.`);
          const buffer = fs.readFileSync(source);
          const sha = sha256Hex(buffer);
          const extension = path.extname(source).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
          const target = path.join(ctx.config.evidenceDir, `${sha}${extension}`);
          if (!options.dryRun && !fs.existsSync(target)) {
            fs.mkdirSync(ctx.config.evidenceDir, { recursive: true });
            fs.writeFileSync(target, buffer, { mode: 0o640 });
            copiedFiles.push(target);
          }
          const mime = extension === '.json' ? 'application/json' : extension === '.gz' ? 'application/gzip' : extension === '.csv' ? 'text/csv' : 'application/octet-stream';
          file = { relative: path.relative(ctx.config.dataDir, target), name: path.basename(source), size: buffer.length, sha, mime };
        }
        const existing = db.get<{ id: number }>(
          'SELECT id FROM source_evidence WHERE kind = ? AND reference = ? AND COALESCE(sha256, \'\') = ? AND is_demo = 0',
          [e.kind, e.reference, file?.sha ?? ''],
        );
        const capturedAt = e.captured_at && !Number.isNaN(new Date(e.captured_at).getTime()) ? new Date(e.captured_at).toISOString() : null;
        const id =
          existing?.id ??
          db.run(
            `INSERT INTO source_evidence (kind, reference, file_path, file_name, mime_type, size_bytes, sha256, excerpt, captured_at, uploaded_by, note, is_demo, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            [e.kind, e.reference, file?.relative ?? null, file?.name ?? null, file?.mime ?? null, file?.size ?? null, file?.sha ?? null, e.excerpt ?? null, capturedAt, userId, e.note ?? null, now],
          ).lastInsertRowid;
        if (!existing) result.evidence_created++;
        evidenceIds.set(e.key, id);
      }

      // ---- listings --------------------------------------------------------------------------------
      const pending: Array<{ retailer: string; origin: { retailer: string; external_id: string }; input: ObservationInput }> = [];
      const usedUrls = new Set<string>();
      for (const listing of snapshot.listings) {
        const retailerId = retailerIds.get(retailerKey(listing.retailer, listing.market))!;
        const market = marketOf(listing.market);
        const productId = listing.product_key ? productIds.get(listing.product_key)! : null;
        const existing = findListing(retailerId, listing.external_id);
        let listingId: number;
        if (existing) {
          if (existing.is_demo) throw new Error(`Listing ${listing.external_id} of ${listing.retailer} exists as a DEMO listing; remove the demo data first.`);
          listingId = existing.id;
          result.listings_existing++;
          if (productId !== null && existing.product_id === null && existing.match_status === 'unmatched') {
            db.run(`UPDATE retailer_listings SET product_id = ?, match_status = 'matched', matched_by = ?, matched_at = ?, updated_at = ? WHERE id = ?`, [productId, userId, now, now, listingId]);
          } else if (productId !== null && existing.product_id !== null && existing.product_id !== productId) {
            warn(`Listing ${listing.external_id} of ${listing.retailer} is already matched to another product; the existing match was kept.`);
          }
        } else {
          let url = listing.url ?? null;
          const urlKey = url ? `${retailerId}|${url}` : null;
          if (urlKey && (usedUrls.has(urlKey) || db.get('SELECT 1 FROM retailer_listings WHERE retailer_id = ? AND url = ?', [retailerId, url]))) {
            warn(`Listing ${listing.external_id} of ${listing.retailer} repeats the URL of another listing; it was stored without a URL.`);
            url = null;
          } else if (urlKey) usedUrls.add(urlKey);
          listingId = db.run(
            `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, gtin, match_status, matched_by, matched_at, is_demo, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [retailerId, productId, listing.external_id, url, listing.title ?? null, normaliseGtin(listing.gtin), productId ? 'matched' : 'unmatched', productId ? userId : null, productId ? now : null, now, now],
          ).lastInsertRowid;
          result.listings_created++;
        }
        const linkedProduct = existing?.product_id ?? productId;
        if (linkedProduct === null) result.listings_unmatched++;
        else {
          db.run('INSERT OR IGNORE INTO product_markets (product_id, market_id) VALUES (?, ?)', [linkedProduct, market.id]);
          if (productId !== null && linkedProduct === productId && listing.match_reason) {
            // the basis of the match stays with the listing, where a reviewer finds it
            db.run(
              `INSERT INTO listing_match_suggestions (listing_id, product_id, score, reasons, status, decided_by, decided_at, created_at)
               VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)
               ON CONFLICT(listing_id, product_id) DO NOTHING`,
              [listingId, productId, listing.match_score ?? 1, JSON.stringify([listing.match_reason, `Matched by the bulk load "${snapshot.source.label}"`]), userId, now, now],
            );
          }
        }

        const o = listing.observation;
        if (!o) continue;
        const tags = normaliseDealTags(o.tag_texts);
        if (tags.length) result.tagged_observations++;
        pending.push({
          retailer: retailerKey(listing.retailer, listing.market),
          origin: { retailer: listing.retailer, external_id: listing.external_id },
          input: {
            listing_id: listingId,
            observed_at: o.observed_at,
            observed_basis: 'exact',
            current_price: o.current_price ?? null,
            regular_price: o.regular_price ?? null,
            promo_type: o.promo_type ?? null,
            promo_description: o.promo_description ?? null,
            availability: o.availability,
            product_url: listing.url ?? null,
            source_timestamp: o.observed_at,
            evidence_id: o.evidence_key ? evidenceIds.get(o.evidence_key)! : null,
            confidence: o.confidence ?? null,
            note: o.note ?? null,
            tags,
            tag_text: o.tag_texts.length ? o.tag_texts.join(' · ').slice(0, 500) : null,
            rating: o.rating ?? null,
            review_count: o.review_count ?? null,
            sales_rank: o.sales_rank ?? null,
            sales_rank_label: o.sales_rank_label ?? null,
            seller_name: o.seller_name ?? null,
          },
        });
      }

      // ---- listings that are no longer monitored ------------------------------------------------------
      for (const retired of snapshot.retired_listings) {
        const market = marketOf(retired.market);
        const listing = db.get<{ id: number; product_id: number | null; is_active: number; is_demo: number }>(
          `SELECT l.id, l.product_id, l.is_active, l.is_demo FROM retailer_listings l JOIN retailers r ON r.id = l.retailer_id
           WHERE r.name = ? AND r.market_id = ? AND l.external_id = ?`,
          [retired.retailer, market.id, retired.external_id],
        );
        if (!listing || listing.is_demo || !listing.is_active) continue; // nothing to retire
        db.run('UPDATE retailer_listings SET is_active = 0, updated_at = ? WHERE id = ?', [now, listing.id]);
        result.listings_retired++;
        audit(ctx, options.user ?? null, 'listing.retired', 'listing', listing.id, { reason: retired.reason, source: snapshot.source.label });
        // a product that is listed nowhere any more leaves the active catalogue with it
        if (listing.product_id !== null && !db.get('SELECT 1 FROM retailer_listings WHERE product_id = ? AND is_active = 1', [listing.product_id])) {
          const archived = db.run(`UPDATE products SET status = 'archived', updated_at = ? WHERE id = ? AND status <> 'archived' AND is_demo = 0`, [now, listing.product_id]);
          if (archived.changes > 0) {
            result.products_archived++;
            db.run(`UPDATE competitor_mappings SET status = 'rejected', updated_at = ? WHERE status = 'suggested' AND (own_product_id = ? OR competitor_product_id = ?)`, [
              now, listing.product_id, listing.product_id,
            ]);
          }
        }
      }

      // ---- observations ----------------------------------------------------------------------------
      // Ingested per retailer, so that each group carries the method by which that retailer's data was obtained.
      const methodByRetailer = new Map(snapshot.retailers.map((r) => [retailerKey(r.name, r.market), r.collection_method]));
      const byRetailer = new Map<string, typeof pending>();
      for (const entry of pending) {
        const list = byRetailer.get(entry.retailer);
        if (list) list.push(entry);
        else byRetailer.set(entry.retailer, [entry]);
      }
      for (const [key, entries] of byRetailer) {
        // an alert storm on a first load helps nobody: alerts start with the next observation of each listing
        const outcome = ingestObservations(ctx, entries.map((entry) => entry.input), {
          sourceMethod: methodByRetailer.get(key)!,
          userId,
          collectedAt: now,
          suppressAlerts: true,
        });
        result.observations_inserted += outcome.inserted;
        result.observations_duplicate += outcome.duplicates;
        for (const rejected of outcome.rejected) result.observations_rejected.push({ ...rejected, ...entries[rejected.index]!.origin });
      }

      audit(ctx, options.user ?? null, 'catalogue.bulk_load', 'system', null, {
        source: snapshot.source.label,
        retailers_created: result.retailers_created,
        products_created: result.products_created,
        products_updated: result.products_updated,
        listings_created: result.listings_created,
        listings_retired: result.listings_retired,
        observations_inserted: result.observations_inserted,
        observations_rejected: result.observations_rejected.length,
      });
      if (options.dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    for (const file of copiedFiles) fs.rmSync(file, { force: true });
    if (!(err instanceof DryRunRollback)) throw err;
  }
  if (suppressedWarnings > 0) result.warnings.push(`… and ${suppressedWarnings} more warning(s) of the same kinds.`);
  return result;
}
