import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadCatalogue, type CatalogueSnapshot } from '../server/services/catalogue-load.ts';
import { createTestApp, type TestApp } from './helpers.ts';

/** A small snapshot shaped like a provider dataset: two retailers in two markets, one product seen at both. */
function snapshot(overrides: Partial<CatalogueSnapshot> = {}): CatalogueSnapshot {
  return {
    version: 1,
    source: { label: 'Test provider datasets', note: 'Loaded by the test suite' },
    retailers: [
      { name: 'Bulk Mart', market: 'AE', website: 'https://bulkmart.example', notes: 'Loaded from provider datasets' },
      { name: 'Bulk Mart', market: 'SA', website: 'https://bulkmart.example/sa', connector_config: { mode: 'bulk', format: 'json', url: 'https://provider.example/tasks/<TASK_ID>/last', auth: { type: 'bearer' }, match: { listing_key: 'external_id', field: 'sku' }, fields: { current_price: 'price' } } },
    ],
    evidence: [{ key: 'ds-ae', reference: 'Provider dataset AE-1 (run R1)', captured_at: '2026-03-01T08:00:00Z', note: 'JSON dataset' }],
    brand_competitors: [{ own: 'Bulk Own', competitor: 'Bulk Rival' }],
    products: [
      { key: 'P1', brand: 'Bulk Own', ownership: 'own', manufacturer: 'Own Co', category: 'Hair Care', subcategory: 'Hair Oil', name: 'Bulk Own Hair Oil', gtin: '6291000000017', pack_size: 200, pack_unit: 'ml', units_per_pack: 1 },
      { key: 'P2', brand: 'Bulk Rival', ownership: 'competitor', category: 'Hair Care', subcategory: 'Hair Oil', name: 'Bulk Rival Hair Oil', pack_size: 300, pack_unit: 'ml', units_per_pack: 2 },
      { key: 'P3', brand: 'Bulk Rival', ownership: 'competitor', category: 'Hair Care', subcategory: 'Shampoo', name: 'Bulk Rival Shampoo', gtin: '6291000000017' },
    ],
    listings: [
      {
        retailer: 'Bulk Mart', market: 'AE', external_id: 'A-1', url: 'https://bulkmart.example/p/a-1', title: 'Bulk Own Hair Oil 200ml', gtin: '6291000000017', product_key: 'P1',
        match_reason: 'Product created from this listing',
        observation: {
          observed_at: '2026-03-01T07:55:00Z', current_price: 12.5, regular_price: 15, availability: 'in_stock', tag_texts: ['Limited time deal', 'Best seller'],
          rating: 4.6, review_count: 1280, sales_rank: 3, sales_rank_label: '#3 in Hair Oils', seller_name: 'Bulk Mart', note: 'Coupon shown on the listing: Extra 10% off', confidence: 0.9, evidence_key: 'ds-ae',
        },
      },
      {
        retailer: 'Bulk Mart', market: 'SA', external_id: 'A-1', url: 'https://bulkmart.example/sa/p/a-1', title: 'Bulk Own Hair Oil 200ml', product_key: 'P1',
        match_reason: "Same article number (A-1) on the retailer's other country site", match_score: 0.98,
        observation: { observed_at: '2026-03-01T07:56:00Z', current_price: 13, availability: 'out_of_stock' },
      },
      {
        retailer: 'Bulk Mart', market: 'AE', external_id: 'A-2', url: 'https://bulkmart.example/p/a-2', title: 'Bulk Rival Hair Oil 2 x 300ml', product_key: 'P2',
        match_reason: 'Product created from this listing',
        observation: { observed_at: '2026-03-01T07:57:00Z', current_price: 30, availability: 'in_stock', promo_type: 'multi_buy', promo_description: 'Buy 3 For 80 AED', tag_texts: ['Buy 3 For 80 AED'] },
      },
      // no product: stays in the matching queue
      { retailer: 'Bulk Mart', market: 'AE', external_id: 'A-3', title: 'Unknown item', observation: { observed_at: '2026-03-01T07:58:00Z', current_price: 5, availability: 'in_stock' } },
      // a listing whose observation cannot be accepted (no price while in stock)
      { retailer: 'Bulk Mart', market: 'AE', external_id: 'A-4', title: 'Bulk Rival Shampoo', product_key: 'P3', match_reason: 'Product created from this listing', observation: { observed_at: '2026-03-01T07:59:00Z', availability: 'in_stock' } },
    ],
    ...overrides,
  };
}

describe('bulk catalogue load', () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  after(async () => {
    await t.close();
  });

  const count = (sql: string, params: unknown[] = []) => t.ctx.db.scalar<number>(sql, params as never) ?? 0;

  it('a dry run reports what would happen and stores nothing', () => {
    const result = loadCatalogue(t.ctx, snapshot(), { dryRun: true });
    assert.equal(result.dry_run, true);
    assert.equal(result.products_created, 3);
    assert.equal(result.listings_created, 5);
    assert.equal(result.observations_inserted, 4);
    assert.equal(count('SELECT COUNT(*) FROM retailers'), 0);
    assert.equal(count('SELECT COUNT(*) FROM products'), 0);
    assert.equal(count('SELECT COUNT(*) FROM price_observations'), 0);
    assert.equal(count(`SELECT COUNT(*) FROM audit_log WHERE action = 'catalogue.bulk_load'`), 0);
  });

  it('creates retailers, products, listings and observations with their provenance', () => {
    const result = loadCatalogue(t.ctx, snapshot());
    assert.deepEqual(
      [result.retailers_created, result.brands_created, result.categories_created, result.products_created, result.listings_created, result.listings_unmatched, result.evidence_created],
      [2, 2, 3, 3, 5, 1, 1],
    );
    assert.equal(result.observations_inserted, 4);
    assert.equal(result.observations_rejected.length, 1);
    assert.match(result.observations_rejected[0]!.reason, /selling price is required/i);
    assert.equal(result.observations_rejected[0]!.external_id, 'A-4');
    assert.equal(result.tagged_observations, 2);
    // the second product asking for the same barcode is created without it, and says so
    assert.ok(result.warnings.some((w) => /6291000000017/.test(w)));

    // nothing loaded this way is demo data, and the retailer is a third-party source that is not scheduled
    assert.equal(count('SELECT COUNT(*) FROM retailers WHERE is_demo = 1') + count('SELECT COUNT(*) FROM products WHERE is_demo = 1') + count('SELECT COUNT(*) FROM price_observations WHERE is_demo = 1'), 0);
    const retailer = t.ctx.db.get<{ collection_method: string; collection_frequency: string; currency_code: string; next_run_at: string | null }>(
      `SELECT r.collection_method, r.collection_frequency, r.currency_code, r.next_run_at FROM retailers r JOIN markets m ON m.id = r.market_id WHERE r.name = 'Bulk Mart' AND m.code = 'SA'`,
    )!;
    assert.deepEqual({ ...retailer }, { collection_method: 'third_party', collection_frequency: 'manual', currency_code: 'SAR', next_run_at: null });

    // a pre-filled mapping leaves the source honestly "not configured" until the token and the real endpoint are added
    const sa = t.ctx.db.get<{ id: number; connector_config: string }>(`SELECT r.id, r.connector_config FROM retailers r JOIN markets m ON m.id = r.market_id WHERE r.name = 'Bulk Mart' AND m.code = 'SA'`)!;
    assert.equal(JSON.parse(sa.connector_config).fields.current_price, 'price');
    assert.equal(count('SELECT COUNT(*) FROM secrets'), 0);

    const obs = t.ctx.db.get<Record<string, unknown>>(
      `SELECT o.current_price, o.regular_price, o.is_promo, o.promo_type, o.discount_pct, o.availability, o.source_method, o.data_class, o.tags, o.tag_text, o.rating,
         o.review_count, o.sales_rank, o.sales_rank_label, o.seller_name, o.note, o.confidence, o.observed_at, e.reference AS evidence
       FROM price_observations o JOIN retailer_listings l ON l.id = o.listing_id JOIN retailers r ON r.id = l.retailer_id JOIN markets m ON m.id = r.market_id
       LEFT JOIN source_evidence e ON e.id = o.evidence_id
       WHERE l.external_id = 'A-1' AND m.code = 'AE'`,
    )!;
    assert.equal(obs.current_price, 12.5);
    assert.equal(obs.regular_price, 15);
    assert.equal(obs.is_promo, 1);
    assert.equal(obs.promo_type, 'price_cut');
    assert.equal(obs.source_method, 'third_party');
    assert.equal(obs.data_class, 'collected');
    assert.deepEqual(JSON.parse(obs.tags as string), ['limited_time_deal', 'best_seller']);
    assert.equal(obs.tag_text, 'Limited time deal · Best seller');
    assert.deepEqual([obs.rating, obs.review_count, obs.sales_rank, obs.sales_rank_label, obs.seller_name], [4.6, 1280, 3, '#3 in Hair Oils', 'Bulk Mart']);
    assert.equal(obs.evidence, 'Provider dataset AE-1 (run R1)');
    assert.equal(obs.observed_at, '2026-03-01T07:55:00.000Z');

    // the multi-buy offer is stored as a promotion and as a tag
    const multi = t.ctx.db.get<{ promo_type: string; promo_description: string; tags: string }>(
      `SELECT o.promo_type, o.promo_description, o.tags FROM price_observations o JOIN retailer_listings l ON l.id = o.listing_id WHERE l.external_id = 'A-2'`,
    )!;
    assert.deepEqual([multi.promo_type, multi.promo_description, JSON.parse(multi.tags)], ['multi_buy', 'Buy 3 For 80 AED', ['multi_buy']]);

    // the basis of each match is kept with the listing, and the product is on record for both markets
    const basis = t.ctx.db.all<{ external_id: string; code: string; reasons: string; status: string; score: number }>(
      `SELECT l.external_id, m.code, s.reasons, s.status, s.score FROM listing_match_suggestions s JOIN retailer_listings l ON l.id = s.listing_id
       JOIN retailers r ON r.id = l.retailer_id JOIN markets m ON m.id = r.market_id WHERE l.external_id = 'A-1' ORDER BY m.code`,
    );
    assert.deepEqual(basis.map((b) => [b.code, b.status, b.score]), [['AE', 'approved', 1], ['SA', 'approved', 0.98]]);
    assert.match(JSON.parse(basis[1]!.reasons)[0], /other country site/);
    assert.equal(count(`SELECT COUNT(*) FROM product_markets pm JOIN products p ON p.id = pm.product_id WHERE p.name = 'Bulk Own Hair Oil'`), 2);
    assert.equal(count(`SELECT COUNT(*) FROM retailer_listings WHERE external_id = 'A-3' AND match_status = 'unmatched' AND product_id IS NULL`), 1);
    assert.equal(count('SELECT COUNT(*) FROM brand_competitors'), 1);
    assert.equal(count(`SELECT COUNT(*) FROM audit_log WHERE action = 'catalogue.bulk_load'`), 1);
    // a first load raises no alerts
    assert.equal(count('SELECT COUNT(*) FROM alerts'), 0);
  });

  it('loading the same file again creates nothing twice', () => {
    const before = {
      products: count('SELECT COUNT(*) FROM products'),
      listings: count('SELECT COUNT(*) FROM retailer_listings'),
      observations: count('SELECT COUNT(*) FROM price_observations'),
      evidence: count('SELECT COUNT(*) FROM source_evidence'),
      brands: count('SELECT COUNT(*) FROM brands'),
    };
    const result = loadCatalogue(t.ctx, snapshot());
    assert.deepEqual([result.retailers_created, result.brands_created, result.products_created, result.listings_created, result.evidence_created, result.observations_inserted], [0, 0, 0, 0, 0, 0]);
    assert.equal(result.products_reused, 3);
    assert.equal(result.listings_existing, 5);
    assert.equal(result.observations_duplicate, 4);
    assert.deepEqual(
      {
        products: count('SELECT COUNT(*) FROM products'),
        listings: count('SELECT COUNT(*) FROM retailer_listings'),
        observations: count('SELECT COUNT(*) FROM price_observations'),
        evidence: count('SELECT COUNT(*) FROM source_evidence'),
        brands: count('SELECT COUNT(*) FROM brands'),
      },
      before,
    );
  });

  it('a later snapshot adds a new observation to the same listing instead of replacing the first', () => {
    const next = snapshot();
    next.listings = [
      { ...next.listings[0]!, observation: { observed_at: '2026-03-02T07:55:00Z', current_price: 15, availability: 'in_stock', tag_texts: [], evidence_key: 'ds-ae' } },
    ];
    const result = loadCatalogue(t.ctx, next);
    assert.equal(result.observations_inserted, 1);
    const history = t.ctx.db.all<{ current_price: number; tags: string }>(
      `SELECT o.current_price, o.tags FROM price_observations o JOIN retailer_listings l ON l.id = o.listing_id JOIN retailers r ON r.id = l.retailer_id
       JOIN markets m ON m.id = r.market_id WHERE l.external_id = 'A-1' AND m.code = 'AE' ORDER BY o.observed_at`,
    );
    assert.deepEqual(history.map((h) => [h.current_price, h.tags]), [[12.5, '["limited_time_deal","best_seller"]'], [15, '[]']]);
  });

  it('leaves existing products alone unless asked, then brings them in line with the file', () => {
    const changed = snapshot();
    changed.products = changed.products.map((p) =>
      p.key === 'P2' ? { ...p, brand: 'Bulk Third', name: 'Bulk Third Hair Oil Twin Pack', subcategory: 'Hair Treatment', pack_size: 250, description: 'Corrected' } : p,
    );
    const read = () =>
      t.ctx.db.get<Record<string, unknown>>(
        `SELECT p.name, b.name AS brand, sc.name AS subcategory, p.pack_size, p.description FROM retailer_listings l JOIN products p ON p.id = l.product_id
         JOIN brands b ON b.id = p.brand_id LEFT JOIN categories sc ON sc.id = p.subcategory_id WHERE l.external_id = 'A-2'`,
      )!;

    const plain = loadCatalogue(t.ctx, changed);
    assert.equal(plain.products_updated, 0);
    assert.deepEqual({ ...read() }, { name: 'Bulk Rival Hair Oil', brand: 'Bulk Rival', subcategory: 'Hair Oil', pack_size: 300, description: null });

    const updated = loadCatalogue(t.ctx, changed, { updateExisting: true });
    assert.equal(updated.products_updated, 1, 'only the product that differs is touched');
    assert.equal(updated.products_created, 0);
    assert.deepEqual({ ...read() }, { name: 'Bulk Third Hair Oil Twin Pack', brand: 'Bulk Third', subcategory: 'Hair Treatment', pack_size: 250, description: 'Corrected' });
    // its history is untouched
    assert.equal(count(`SELECT COUNT(*) FROM price_observations o JOIN retailer_listings l ON l.id = o.listing_id WHERE l.external_id = 'A-2'`), 1);
    assert.equal(loadCatalogue(t.ctx, changed, { updateExisting: true }).products_updated, 0);
  });

  it('retires a listing without deleting anything, and archives a product that is listed nowhere else', () => {
    const observationsBefore = count('SELECT COUNT(*) FROM price_observations');
    const s = snapshot({
      retired_listings: [
        { retailer: 'Bulk Mart', market: 'AE', external_id: 'A-2', reason: 'Outside the monitored categories' }, // the only listing of its product
        { retailer: 'Bulk Mart', market: 'SA', external_id: 'A-1', reason: 'Duplicate listing' }, // its product is still listed in AE
        { retailer: 'Bulk Mart', market: 'AE', external_id: 'NOT-THERE', reason: 'Never loaded' },
      ],
    });
    s.listings = s.listings.filter((l) => !(l.external_id === 'A-2' || (l.external_id === 'A-1' && l.market === 'SA')));
    const result = loadCatalogue(t.ctx, s);
    assert.deepEqual([result.listings_retired, result.products_archived], [2, 1]);
    const listing = (id: string, market: string) =>
      t.ctx.db.get<{ is_active: number; status: string }>(
        `SELECT l.is_active, p.status FROM retailer_listings l JOIN products p ON p.id = l.product_id JOIN retailers r ON r.id = l.retailer_id
         JOIN markets m ON m.id = r.market_id WHERE l.external_id = ? AND m.code = ?`,
        [id, market],
      )!;
    assert.deepEqual({ ...listing('A-2', 'AE') }, { is_active: 0, status: 'archived' });
    assert.deepEqual({ ...listing('A-1', 'SA') }, { is_active: 0, status: 'active' });
    assert.deepEqual({ ...listing('A-1', 'AE') }, { is_active: 1, status: 'active' });
    assert.equal(count('SELECT COUNT(*) FROM price_observations'), observationsBefore, 'observations of a retired listing stay in the ledger');
    assert.equal(count(`SELECT COUNT(*) FROM audit_log WHERE action = 'listing.retired'`), 2);
    // retiring again changes nothing
    assert.deepEqual([loadCatalogue(t.ctx, s).listings_retired, loadCatalogue(t.ctx, s).products_archived], [0, 0]);
  });

  it('retains the raw file named as evidence', () => {
    const raw = path.join(t.dataDir, 'provider-dataset.json');
    fs.writeFileSync(raw, JSON.stringify([{ id: 'B-1', price: 9 }]));
    const s = snapshot({
      evidence: [{ key: 'raw', reference: 'Provider dataset RAW-1', file: 'provider-dataset.json' }],
      products: [{ key: 'PX', brand: 'Bulk Rival', ownership: 'competitor', category: 'Hair Care', subcategory: 'Shampoo', name: 'Bulk Rival Mini Shampoo', pack_size: 90, pack_unit: 'ml' }],
      listings: [
        { retailer: 'Bulk Mart', market: 'AE', external_id: 'B-1', title: 'Bulk Rival Mini Shampoo 90ml', product_key: 'PX', match_reason: 'Product created from this listing',
          observation: { observed_at: '2026-03-03T07:00:00Z', current_price: 9, availability: 'in_stock', evidence_key: 'raw' } },
      ],
    });
    const result = loadCatalogue(t.ctx, s, { baseDir: t.dataDir });
    assert.equal(result.evidence_created, 1);
    const evidence = t.ctx.db.get<{ file_path: string; file_name: string; size_bytes: number; sha256: string }>(
      `SELECT file_path, file_name, size_bytes, sha256 FROM source_evidence WHERE reference = 'Provider dataset RAW-1'`,
    )!;
    assert.equal(evidence.file_name, 'provider-dataset.json');
    assert.equal(evidence.size_bytes, fs.statSync(raw).size);
    assert.ok(fs.existsSync(path.join(t.dataDir, evidence.file_path)), 'the raw file is kept inside the evidence directory');
    assert.match(evidence.file_path, /^evidence[\\/]/);
  });

  it('refuses a malformed file, an unknown market and a match without a stated basis — and changes nothing', () => {
    const before = count('SELECT COUNT(*) FROM retailer_listings');
    assert.throws(() => loadCatalogue(t.ctx, { version: 2 }), /not valid/);
    assert.throws(() => loadCatalogue(t.ctx, snapshot({ retailers: [{ name: 'Nowhere Mart', market: 'ZZ' }], listings: [] })), /Market "ZZ" does not exist/);
    const noBasis = snapshot();
    noBasis.listings = [{ retailer: 'Bulk Mart', market: 'AE', external_id: 'Z-9', title: 'x', product_key: 'P1' }];
    assert.throws(() => loadCatalogue(t.ctx, noBasis), /basis of the match/);
    const simulated = snapshot() as unknown as { retailers: Array<Record<string, unknown>> };
    simulated.retailers[0]!.collection_method = 'simulated';
    assert.throws(() => loadCatalogue(t.ctx, simulated), /not valid/);
    assert.equal(count('SELECT COUNT(*) FROM retailer_listings'), before);
  });

  it('the loaded listings are served by the API like any other listing', async () => {
    const res = await t.api('GET', '/observations?page_size=50');
    assert.equal(res.status, 200);
    const tagged = (res.body.rows as Array<{ tags: string[]; data_class: string; source_method: string }>).filter((o) => o.tags.length > 0);
    assert.ok(tagged.length >= 2);
    assert.ok(tagged.every((o) => o.data_class === 'collected' && o.source_method === 'third_party'));
  });
});
