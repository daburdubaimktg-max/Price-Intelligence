/**
 * The DEMO dataset: every record is flagged, simulated runs are never counted as real collection, real records
 * stay distinguishable, and the demo data can be removed (and reloaded) without touching anything real.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, createTestApp, ingestKnownPrices, type Fixture, type KnownPrices, type TestApp } from './helpers.ts';
import { ingestObservations } from '../server/services/ingestion.ts';
import { nowIso } from '../server/lib/time.ts';

let t: TestApp;
let fx: Fixture;
let known: KnownPrices;
let seedCounts: Record<string, number>;
let strayListingId: number;
let adoptedProductId: number;
let adoptedRetailerId: number;

const count = (sql: string, params: unknown[] = []) => t.ctx.db.scalar<number>(sql, params as never) ?? 0;
const get = async (url: string) => {
  const res = await t.api('GET', url);
  assert.equal(res.status, 200, `${url} → ${res.status} ${res.raw.slice(0, 200)}`);
  return res.body;
};
const DEMO_TABLES = ['products', 'retailers', 'retailer_listings', 'price_observations', 'collection_jobs', 'import_batches', 'alerts', 'exchange_rates', 'promotions', 'price_events', 'brands', 'categories', 'competitor_mappings'];

before(async () => {
  t = await createTestApp();
  // Real records exist before the demo dataset arrives.
  fx = createFixture(t.ctx);
  known = await ingestKnownPrices(t.ctx, fx);
  const res = await t.api('POST', '/admin/demo/seed', { body: {} });
  assert.equal(res.status, 200, res.raw.slice(0, 300));
  seedCounts = res.body.counts;
});
after(async () => {
  await t.close();
});

describe('DEMO dataset', () => {
  it('loads a catalogue, listings, months of observations, promotions, jobs and alerts', () => {
    assert.equal(seedCounts.products, 31);
    assert.equal(seedCounts.retailers, 30);
    assert.ok(seedCounts.listings! > 500);
    assert.ok(seedCounts.observations! > 50_000);
    assert.ok(seedCounts.collection_jobs! > 300);
    assert.ok(seedCounts.promotions! > 500);
    assert.ok(seedCounts.alerts! > 50);
    assert.equal(count('SELECT COUNT(DISTINCT market_id) FROM retailers WHERE is_demo = 1'), 10, 'all ten initial markets are covered');
  });

  it('flags every record it creates as DEMO', () => {
    assert.equal(count('SELECT COUNT(*) FROM products WHERE is_demo = 1'), 31);
    assert.equal(count('SELECT COUNT(*) FROM retailers WHERE is_demo = 1'), 30);
    assert.equal(count('SELECT COUNT(*) FROM retailer_listings WHERE is_demo = 1'), seedCounts.listings);
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE is_demo = 1'), seedCounts.observations);
    // No demo listing has an observation that is not flagged, and no real listing has a flagged one.
    assert.equal(count('SELECT COUNT(*) FROM price_observations o JOIN retailer_listings l ON l.id = o.listing_id WHERE l.is_demo = 1 AND o.is_demo = 0'), 0);
    assert.equal(count('SELECT COUNT(*) FROM price_observations o JOIN retailer_listings l ON l.id = o.listing_id WHERE l.is_demo = 0 AND o.is_demo = 1'), 0);
    assert.equal(count('SELECT COUNT(*) FROM promotions WHERE is_demo = 0'), 1, 'only the real fixture promotion is unflagged');
    assert.equal(count('SELECT COUNT(*) FROM alerts WHERE is_demo = 0 AND listing_id IN (SELECT id FROM retailer_listings WHERE is_demo = 1)'), 0);
    assert.equal(count(`SELECT COUNT(*) FROM exchange_rates WHERE is_demo = 1 AND source NOT LIKE '%DEMO%'`), 0, 'demo exchange rates say so in their source');
  });

  it('uses addresses that cannot be mistaken for real retailer pages', () => {
    assert.equal(count(`SELECT COUNT(*) FROM retailer_listings WHERE is_demo = 1 AND url IS NOT NULL AND url NOT LIKE 'https://demo.invalid/%'`), 0);
    assert.equal(count(`SELECT COUNT(*) FROM price_observations WHERE is_demo = 1 AND product_url IS NOT NULL AND product_url NOT LIKE 'https://demo.invalid/%'`), 0);
  });

  it('never records a simulated run as a real collection', async () => {
    assert.equal(count(`SELECT COUNT(*) FROM collection_jobs WHERE is_demo = 1 AND data_class <> 'simulated'`), 0);
    assert.equal(count(`SELECT COUNT(*) FROM collection_jobs WHERE data_class = 'real'`), 0);
    assert.equal(count(`SELECT COUNT(*) FROM price_observations WHERE data_class = 'collected'`), 0, 'nothing is labelled as really collected');
    assert.equal(count(`SELECT COUNT(*) FROM price_observations WHERE source_method = 'simulated' AND is_demo = 0`), 0);

    const overview = await get('/overview?days=30');
    assert.equal(overview.kpis.collection.real.runs, 0);
    assert.equal(overview.kpis.collection.real.success_rate_pct, null);
    assert.ok(overview.kpis.collection.simulated.runs > 0);
    assert.equal(overview.demo.present, true);
    assert.ok(!overview.provenance.some((p: any) => p.data_class === 'collected'));

    const health = await get('/collection/health');
    assert.equal(health.last_real_success_at, null);
    assert.ok(health.last_simulated_run_at);
    assert.equal(health.sources.healthy, 0, 'no source is reported as healthy real collection');
    assert.ok(health.sources.simulated > 0);
    assert.equal(health.window.real.runs ?? health.window.real.jobs ?? 0, 0);
  });

  it('refuses at database level to store a simulated observation as real data', () => {
    const real = t.ctx.db.get<Record<string, unknown>>('SELECT * FROM price_observations WHERE listing_id = ? LIMIT 1', [fx.ownListingId])!;
    assert.throws(
      () =>
        t.ctx.db.run(
          `INSERT INTO price_observations (listing_id, retailer_id, market_id, currency_code, current_price, availability, observed_at,
             observed_local_date, collected_at, source_method, dedupe_key, is_demo, created_at)
           VALUES (?, ?, ?, 'AED', 9.99, 'in_stock', ?, ?, ?, 'simulated', 'simulated-as-real', 0, ?)`,
          [real.listing_id, real.retailer_id, real.market_id, nowIso(), known.today, nowIso(), nowIso()] as never,
        ),
      /CHECK|constraint/i,
    );
  });

  it('keeps real records distinguishable from demo records everywhere', async () => {
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE is_demo = 0'), 8);
    const me = await get('/auth/me');
    assert.equal(me.app.demo_data_present, true);
    assert.equal(me.app.demo_observations, seedCounts.observations);
    assert.equal(me.app.real_observations, 8);

    const realSeries = await get(`/history/timeline?product_id=${fx.ownProductId}&days=14`);
    assert.equal(realSeries.demo.any_demo, false);
    assert.equal(realSeries.series[0].is_demo, false);
    assert.equal(realSeries.series[0].stats.avg, 20.6, 'real figures are not blended with demo prices');

    const demoProduct = t.ctx.db.get<{ id: number }>(`SELECT id FROM products WHERE is_demo = 1 ORDER BY id LIMIT 1`)!;
    const demoSeries = await get(`/history/timeline?product_id=${demoProduct.id}&days=14`);
    assert.equal(demoSeries.demo.all_demo, true);
    assert.ok(demoSeries.series.every((s: any) => s.is_demo === true));

    const monitor = await get(`/monitor?product_id=${demoProduct.id}&page_size=5`);
    assert.ok(monitor.rows.length > 0 && monitor.rows.every((r: any) => r.is_demo === 1));
    const summary = await get('/history/summary?include_unmatched=true');
    assert.equal(summary.demo_observations, count('SELECT COUNT(*) FROM v_observations WHERE is_demo = 1'));
    assert.equal(summary.observations - summary.demo_observations, 8);
  });

  it('labels demo data in reports and assistant answers', async () => {
    const mixed = await t.api('POST', '/reports/generate', { body: { type: 'weekly_competitor_pricing' } });
    assert.equal(mixed.status, 200);
    assert.equal(mixed.body.demo.any_demo, true);
    assert.equal(mixed.body.demo.all_demo, false, 'the real fixture changes are in the same report');
    const sources = new Set(mixed.body.sections.find((s: any) => s.id === 'competitor_changes').table.rows.map((r: any) => r.source));
    assert.ok(sources.has('Simulated demo (DEMO)') || sources.has('Manual entry (DEMO)') || sources.has('Imported history (DEMO)'));
    assert.ok(sources.has('Manual entry'), 'real rows carry no DEMO label');

    const demoProduct = t.ctx.db.get<{ name: string }>(`SELECT name FROM products WHERE is_demo = 1 AND name LIKE 'Dabur Amla Hair Oil 200ml%' LIMIT 1`)!;
    const answer = await t.api('POST', '/assistant/query', { body: { question: `What was the price of ${demoProduct.name} at Carrefour UAE over the last 30 days?` } });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.status, 'answered');
    assert.equal(answer.body.demo.all_demo, true);
    assert.match(answer.body.answer, /DEMO/);
    assert.ok(answer.body.evidence.sources.every((s: any) => s.data_class !== 'collected'));
  });

  it('raises alerts only from stored observations', () => {
    assert.ok(count('SELECT COUNT(*) FROM alerts WHERE is_demo = 1') > 50);
    assert.equal(count('SELECT COUNT(*) FROM alerts a WHERE a.observation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM price_observations o WHERE o.id = a.observation_id)'), 0);
    assert.equal(count('SELECT COUNT(*) FROM alerts a WHERE a.listing_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retailer_listings l WHERE l.id = a.listing_id)'), 0);
  });

  it('cannot be loaded twice, and only administrators may load or remove it', async () => {
    assert.equal((await t.api('POST', '/admin/demo/seed', { body: {} })).status, 409);
    assert.equal((await t.api('POST', '/admin/demo/purge', { body: {}, as: 'analyst' })).status, 403);
    assert.equal((await t.api('POST', '/admin/demo/seed', { body: {}, as: 'viewer' })).status, 403);
  });
});

describe('removing the DEMO dataset', () => {
  before(async () => {
    // A real listing that someone matched to a demo product, with a real observation of its own.
    const now = nowIso();
    const demoProduct = t.ctx.db.get<{ id: number }>('SELECT id FROM products WHERE is_demo = 1 ORDER BY id LIMIT 1')!;
    strayListingId = t.ctx.db.run(
      `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, created_at, updated_at)
       VALUES (?, ?, 'stray-1', 'https://testmart.example/p/stray-1', 'Shelf item matched to a demo product', 'matched', ?, ?)`,
      [fx.retailerId, demoProduct.id, now, now],
    ).lastInsertRowid;
    const res = ingestObservations(t.ctx, [{ listing_id: strayListingId, observed_at: known.at(1), current_price: 15, regular_price: 15, availability: 'in_stock' }], { sourceMethod: 'manual', userId: 1 });
    assert.equal(res.inserted, 1);

    // Through the application, real data that starts to depend on demo records adopts them as real:
    // a real listing for a demo product at the real retailer …
    adoptedProductId = t.ctx.db.get<{ id: number }>(`SELECT id FROM products WHERE is_demo = 1 AND sku = 'DEMO-PARA200'`)!.id;
    const adopt = await t.api('POST', '/listings', { body: { retailer_id: fx.retailerId, url: 'https://testmart.example/p/parachute-200', product_id: adoptedProductId } });
    assert.equal(adopt.status, 201, adopt.raw.slice(0, 200));
    // A listing added at a demo retailer through the application is itself a demo listing …
    adoptedRetailerId = t.ctx.db.get<{ id: number }>(`SELECT id FROM retailers WHERE is_demo = 1 AND name = 'Carrefour UAE'`)!.id;
    const atDemoRetailer = await t.api('POST', '/listings', { body: { retailer_id: adoptedRetailerId, url: 'https://demo.invalid/carrefour-uae/own-oil-200', product_id: fx.ownProductId } });
    assert.equal(atDemoRetailer.status, 201, atDemoRetailer.raw.slice(0, 200));
    assert.equal(atDemoRetailer.body.is_demo, 1);
    // … whereas a real listing recorded directly against a demo retailer (legacy or migrated data) makes it a real source.
    t.ctx.db.run(
      `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, is_demo, created_at, updated_at)
       VALUES (?, ?, 'legacy-own-oil', 'https://www.carrefouruae.example/p/own-oil-200', 'Own oil (legacy record)', 'matched', 0, ?, ?)`,
      [adoptedRetailerId, fx.ownProductId, now, now],
    );

    const purge = await t.api('POST', '/admin/demo/purge', { body: {} });
    assert.equal(purge.status, 200, purge.raw.slice(0, 300));
    assert.equal(purge.body.counts.observations, seedCounts.observations);
  });

  it('removes every demo record', () => {
    for (const table of DEMO_TABLES) assert.equal(count(`SELECT COUNT(*) FROM ${table} WHERE is_demo = 1`), 0, `${table} still holds demo rows`);
    assert.equal(count(`SELECT COUNT(*) FROM collection_jobs`), 0);
    assert.equal(count(`SELECT COUNT(*) FROM price_observations WHERE source_method = 'simulated'`), 0);
  });

  it('leaves every real record exactly as it was', async () => {
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE is_demo = 0'), 9);
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE listing_id IN (?, ?)', [fx.ownListingId, fx.compListingId]), 8);
    assert.ok(t.ctx.db.get('SELECT 1 FROM products WHERE id = ?', [fx.ownProductId]));
    assert.ok(t.ctx.db.get('SELECT 1 FROM retailers WHERE id = ?', [fx.retailerId]));
    assert.equal(count(`SELECT COUNT(*) FROM competitor_mappings WHERE own_product_id = ? AND status = 'approved'`, [fx.ownProductId]), 1);
    const timeline = await get(`/history/timeline?product_id=${fx.ownProductId}&days=14`);
    assert.deepEqual(timeline.series[0].points.map((p: any) => p.value), [20, 20, 22, 22, 17.6, 22]);
    const competitors = await get('/competitors/overview');
    assert.equal(competitors.positioning.overall.index, 122.2);
    assert.equal(count('SELECT COUNT(*) FROM markets'), 10, 'reference data stays');
    const me = await get('/auth/me');
    assert.equal(me.app.demo_data_present, false);
    assert.equal(me.app.real_observations, 9);
  });

  it('keeps a real observation whose listing pointed at a demo product, and un-matches the listing', () => {
    const listing = t.ctx.db.get<{ product_id: number | null; match_status: string }>('SELECT product_id, match_status FROM retailer_listings WHERE id = ?', [strayListingId])!;
    assert.equal(listing.product_id, null);
    assert.equal(listing.match_status, 'unmatched');
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE listing_id = ? AND current_price = 15', [strayListingId]), 1);
  });

  it('keeps demo records that real data adopted, as real records', () => {
    const product = t.ctx.db.get<{ is_demo: number; name: string }>('SELECT is_demo, name FROM products WHERE id = ?', [adoptedProductId])!;
    assert.equal(product.is_demo, 0);
    const retailer = t.ctx.db.get<{ is_demo: number; collection_method: string; connector_config: string }>('SELECT is_demo, collection_method, connector_config FROM retailers WHERE id = ?', [adoptedRetailerId])!;
    assert.equal(retailer.is_demo, 0);
    assert.equal(retailer.collection_method, 'manual', 'a kept source no longer simulates anything');
    assert.equal(retailer.connector_config, '{}');
    assert.equal(count('SELECT COUNT(*) FROM retailer_listings WHERE retailer_id = ?', [adoptedRetailerId]), 1, 'only the real listing remains');
  });

  it('can be loaded again afterwards, attaching to adopted products and leaving adopted retailers alone', async () => {
    const again = await t.api('POST', '/admin/demo/seed', { body: {} });
    assert.equal(again.status, 200, again.raw.slice(0, 300));
    assert.equal(again.body.counts.products, 30);
    assert.equal(again.body.counts.products_reused, 1);
    assert.equal(again.body.counts.retailers, 29);
    assert.equal(again.body.counts.retailers_skipped, 1);
    assert.equal(count(`SELECT COUNT(*) FROM products WHERE sku LIKE 'DEMO-%'`), 31, 'no duplicate catalogue entries');
    assert.equal(count('SELECT is_demo FROM products WHERE id = ?', [adoptedProductId]), 0, 'the adopted product stays real');
    assert.equal(count('SELECT COUNT(*) FROM retailer_listings WHERE retailer_id = ? AND is_demo = 1', [adoptedRetailerId]), 0, 'nothing simulated is attached to a real source');
    assert.ok(count('SELECT COUNT(*) FROM price_observations o JOIN retailer_listings l ON l.id = o.listing_id WHERE l.product_id = ? AND o.is_demo = 1', [adoptedProductId]) > 0, 'demo listings of the adopted product are still flagged DEMO');
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE is_demo = 0'), 9);
    assert.equal((await get('/auth/me')).app.demo_data_present, true);
  });
});
