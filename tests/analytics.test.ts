/**
 * Analytics over a small price history whose every figure can be checked by hand (see ingestKnownPrices):
 * charts, comparisons, unit prices, competitor gaps, promotions and currency handling must all come from stored
 * observations and agree with the arithmetic.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, createTestApp, ingestKnownPrices, type Fixture, type KnownPrices, type TestApp } from './helpers.ts';
import { ingestObservations } from '../server/services/ingestion.ts';
import { recordRate } from '../server/services/fx.ts';
import { nowIso } from '../server/lib/time.ts';

let t: TestApp;
let fx: Fixture;
let known: KnownPrices;

const get = async (url: string, as?: 'admin' | 'analyst' | 'viewer' | null) => {
  const res = await t.api('GET', url, as === undefined ? {} : { as });
  assert.equal(res.status, 200, `${url} → ${res.status} ${res.raw.slice(0, 200)}`);
  return res.body;
};

before(async () => {
  t = await createTestApp();
  fx = createFixture(t.ctx);
  known = await ingestKnownPrices(t.ctx, fx);
});
after(async () => {
  await t.close();
});

describe('price events and the live monitor', () => {
  it('derives every selling-price change between consecutive observations', async () => {
    const body = await get('/events?page_size=50');
    const events = body.rows
      .map((r: any) => ({ listing: r.listing_id, from: r.old_price, to: r.new_price, pct: r.change_pct, dir: r.direction, date: r.occurred_local_date }))
      .sort((a: any, b: any) => a.date.localeCompare(b.date) || a.listing - b.listing);
    assert.deepEqual(events, [
      { listing: fx.ownListingId, from: 20, to: 22, pct: 10, dir: 'up', date: known.date(6) },
      { listing: fx.compListingId, from: 30, to: 27, pct: -10, dir: 'down', date: known.date(6) },
      { listing: fx.ownListingId, from: 22, to: 17.6, pct: -20, dir: 'down', date: known.date(2) },
      { listing: fx.ownListingId, from: 17.6, to: 22, pct: 25, dir: 'up', date: known.date(1) },
    ]);
    const downs = await get('/events?direction=down&ownership=competitor');
    assert.equal(downs.total, 1);
    assert.equal(downs.rows[0].product_id, fx.compProductId);
  });

  it('counts price changes per brand, retailer and market', async () => {
    const byBrand = await get('/events/summary?group_by=brand&days=14');
    assert.deepEqual(byBrand.totals, { increases: 2, decreases: 2, groups: 2 });
    const own = byBrand.rows.find((r: any) => r.id === fx.ownBrandId);
    assert.deepEqual([own.increases, own.decreases, own.avg_increase_pct, own.avg_decrease_pct, own.ownership], [2, 1, 17.5, -20, 'own']);
    const rival = byBrand.rows.find((r: any) => r.id === fx.compBrandId);
    assert.deepEqual([rival.increases, rival.decreases, rival.avg_increase_pct, rival.avg_decrease_pct], [0, 1, null, -10]);
    assert.equal(byBrand.demo.any_demo, false);

    const byRetailer = await get('/events/summary?group_by=retailer&days=14');
    assert.deepEqual(byRetailer.rows.map((r: any) => [r.label, r.sublabel, r.listings, r.increases, r.decreases]), [['Test Mart', 'UAE', 2, 2, 2]]);
    const byMarket = await get(`/events/summary?group_by=market&from=${known.date(3)}&to=${known.today}`);
    assert.deepEqual(byMarket.rows.map((r: any) => [r.label, r.increases, r.decreases]), [['UAE', 1, 1]]);
    assert.equal((await get('/events/summary?group_by=product&ownership=competitor&days=14')).rows.length, 1);
  });

  it('shows the latest price, price per 100 ml and provenance of each listing', async () => {
    const body = await get('/monitor?sort=product');
    assert.equal(body.total, 2);
    const own = body.rows.find((r: any) => r.listing_id === fx.ownListingId);
    const rival = body.rows.find((r: any) => r.listing_id === fx.compListingId);
    assert.equal(own.current_price, 22);
    assert.equal(own.unit_price, 11); // 22.00 / 200 ml × 100
    assert.equal(own.currency_code, 'AED');
    assert.equal(own.data_class, 'manual');
    assert.equal(own.is_demo, 0);
    assert.equal(own.observed_at, known.at(1));
    assert.equal(own.change_old_price, 17.6);
    assert.equal(own.change_pct, 25);
    assert.equal(rival.current_price, 27);
    assert.equal(rival.unit_price, 9); // 27.00 / 300 ml × 100
    assert.equal(body.facets.listings, 2);
    assert.equal(body.facets.observed, 2);
    assert.equal(body.facets.never_observed, 0);
    assert.equal(body.facets.on_promo, 0);
    assert.equal(body.facets.demo_listings, 0);
  });

  it('filters and sorts on the server', async () => {
    assert.equal((await get('/monitor?ownership=own')).total, 1);
    assert.equal((await get(`/monitor?brand_id=${fx.compBrandId}`)).rows[0].listing_id, fx.compListingId);
    assert.equal((await get('/monitor?q=Rival')).total, 1);
    assert.equal((await get('/monitor?q=no-such-product')).total, 0);
    assert.equal((await get('/monitor?price_min=25')).rows[0].listing_id, fx.compListingId);
    assert.equal((await get('/monitor?promo=true')).total, 0);
    const byPrice = await get('/monitor?sort=-price');
    assert.deepEqual(byPrice.rows.map((r: any) => r.current_price), [27, 22]);
  });
});

describe('historical price explorer', () => {
  it('returns the daily price series of a product with its statistics', async () => {
    const body = await get(`/history/timeline?product_id=${fx.ownProductId}&days=14`);
    assert.equal(body.series.length, 1);
    const s = body.series[0];
    assert.equal(s.currency, 'AED');
    assert.deepEqual(
      s.points.map((p: any) => [p.date, p.value, p.promo]),
      [
        [known.date(10), 20, 0],
        [known.date(8), 20, 0],
        [known.date(6), 22, 0],
        [known.date(4), 22, 0],
        [known.date(2), 17.6, 1],
        [known.date(1), 22, 0],
      ],
    );
    assert.equal(s.stats.avg, 20.6); // (20 + 20 + 22 + 22 + 17.6 + 22) / 6
    assert.equal(s.stats.median, 21);
    assert.equal(s.stats.min, 17.6);
    assert.equal(s.stats.max, 22);
    assert.equal(s.stats.first, 20);
    assert.equal(s.stats.last, 22);
    assert.equal(s.stats.change_pct, 10);
    assert.equal(body.demo.any_demo, false);
    assert.deepEqual(body.conversions, []);
  });

  it('computes price per 100 ml for products of different pack sizes', async () => {
    const body = await get('/history/timeline?days=14&metric=unit_price&group_by=product');
    const own = body.series.find((s: any) => s.ref.product_id === fx.ownProductId);
    const rival = body.series.find((s: any) => s.ref.product_id === fx.compProductId);
    assert.equal(own.basis, 'per 100ml');
    assert.deepEqual(own.points.map((p: any) => p.value), [10, 10, 11, 11, 8.8, 11]);
    assert.deepEqual(rival.points.map((p: any) => p.value), [10, 9]);
  });

  it('filters by date range, retailer and brand', async () => {
    const ranged = await get(`/history/timeline?product_id=${fx.ownProductId}&from=${known.date(6)}&to=${known.date(4)}`);
    assert.deepEqual(ranged.series[0].points.map((p: any) => p.date), [known.date(6), known.date(4)]);
    const byBrand = await get(`/history/timeline?brand_id=${fx.compBrandId}&days=14`);
    assert.deepEqual(byBrand.series.map((s: any) => s.ref.product_id), [fx.compProductId]);
    const otherRetailer = await get(`/history/timeline?retailer_id=${fx.retailerId + 999}&days=14`);
    assert.equal(otherRetailer.series.length, 0);
  });

  it('compares the last 7 days with the 7 days before', async () => {
    const body = await get('/history/compare?preset=last_7_days&group_by=product');
    assert.deepEqual(body.period_a, { from: known.date(6), to: known.today });
    assert.deepEqual(body.period_b, { from: known.date(13), to: known.date(7) });
    const own = body.rows.find((r: any) => r.ref.product_id === fx.ownProductId);
    const rival = body.rows.find((r: any) => r.ref.product_id === fx.compProductId);
    assert.equal(own.a.avg, 20.9); // (22 + 22 + 17.6 + 22) / 4
    assert.equal(own.b.avg, 20);
    assert.equal(own.delta_pct, 4.5);
    assert.equal(own.a.promo_share_pct, 25);
    assert.equal(rival.a.avg, 27);
    assert.equal(rival.b.avg, 30);
    assert.equal(rival.delta_pct, -10);
    assert.equal(body.summary.increased, 1);
    assert.equal(body.summary.decreased, 1);
  });

  it('compares custom periods and rejects malformed ones', async () => {
    const body = await get(
      `/history/compare?preset=custom&a_from=${known.date(2)}&a_to=${known.date(1)}&b_from=${known.date(10)}&b_to=${known.date(8)}&product_id=${fx.ownProductId}`,
    );
    assert.equal(body.rows[0].a.avg, 19.8); // (17.6 + 22) / 2
    assert.equal(body.rows[0].b.avg, 20);
    assert.equal(body.rows[0].delta_pct, -1);
    assert.equal((await t.api('GET', '/history/compare?preset=custom&a_from=yesterday')).status, 400);
    assert.equal((await t.api('GET', '/history/compare?preset=nonsense')).status, 400);
  });

  it('summarises the stored history and ranks volatility', async () => {
    const summary = await get('/history/summary');
    assert.equal(summary.observations, 8);
    assert.equal(summary.listings, 2);
    assert.equal(summary.promo_observations, 1);
    assert.deepEqual(summary.by_data_class, [{ data_class: 'manual', observations: 8 }]);
    assert.equal(summary.demo_observations, 0);
    assert.equal(summary.first_observed_at, known.at(10));
    assert.equal(summary.last_observed_at, known.at(1));
    const vol = await get('/history/volatility?days=14');
    const own = vol.rows.find((r: any) => r.listing_id === fx.ownListingId);
    assert.equal(own.price_changes, 3);
    assert.equal(own.range_pct, 25); // (22 − 17.6) / 17.6
    assert.equal(own.volatility_pct, 8.57);
  });
});

describe('competitor intelligence', () => {
  it('compares a product with its mapped competitor on unit price and labels the mapping as non-equivalent', async () => {
    const body = await get(`/competitors/compare?product_id=${fx.ownProductId}&days=14`);
    assert.equal(body.product.unit_basis, 'per 100ml');
    assert.equal(body.competitors.length, 1);
    const c = body.competitors[0];
    assert.equal(c.equivalence, 'comparable');
    assert.equal(c.comparable, true);
    assert.match(c.note, /non-equivalent/i);
    assert.equal(c.avg_gap_pct, 22.2); // (11 − 9) / 9
    assert.equal(c.own_dearer_at, 1);
    const row = body.rows.find((r: any) => r.role === 'competitor');
    assert.equal(row.gap_basis, 'unit');
    assert.equal(row.gap_pct, 22.2);
    assert.equal(row.unit_price, 9);
    assert.deepEqual(row.own_reference, { scope: 'same_retailer', price: 22, unit_price: 11 });
    assert.deepEqual(row.period, { min: 27, max: 30, avg: 28.5, days: 2 });
    const own = body.rows.find((r: any) => r.role === 'own');
    assert.deepEqual(own.period, { min: 17.6, max: 22, avg: 20.6, days: 6 });
    assert.equal(body.history.metric, 'unit_price');
    assert.equal(body.history.series.length, 2);
  });

  it('reports the own-vs-competitor price index', async () => {
    const body = await get('/competitors/overview');
    assert.equal(body.positioning.overall.index, 122.2);
    assert.equal(body.positioning.overall.premium_pct, 22.2);
    assert.equal(body.positioning.overall.pairs, 1);
    assert.equal(body.positioning.overall.dearer_pairs, 1);
    assert.equal(body.products[0].position, 'premium');
    assert.equal(body.products[0].approved_mappings, 1);
  });

  it('never computes a gap between products measured in different units', async () => {
    const now = nowIso();
    const creamId = t.ctx.db.run(
      `INSERT INTO products (brand_id, name, category_id, pack_size, pack_unit, created_at, updated_at) VALUES (?, 'Rival Hair Cream 150g', ?, 150, 'g', ?, ?)`,
      [fx.compBrandId, fx.categoryId, now, now],
    ).lastInsertRowid;
    const creamListing = t.ctx.db.run(
      `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, created_at, updated_at)
       VALUES (?, ?, 'rival-cream-150', 'https://testmart.example/p/rival-cream-150', 'Rival Hair Cream 150g', 'matched', ?, ?)`,
      [fx.retailerId, creamId, now, now],
    ).lastInsertRowid;
    t.ctx.db.run(
      `INSERT INTO competitor_mappings (own_product_id, competitor_product_id, equivalence, status, created_at, updated_at) VALUES (?, ?, 'comparable', 'approved', ?, ?)`,
      [fx.ownProductId, creamId, now, now],
    );
    ingestObservations(t.ctx, [{ listing_id: creamListing, observed_at: known.at(1), current_price: 12, regular_price: 12, availability: 'in_stock' }], { sourceMethod: 'manual', userId: 1 });

    const body = await get(`/competitors/compare?product_id=${fx.ownProductId}&days=14`);
    const cream = body.competitors.find((c: any) => c.product_id === creamId);
    assert.equal(cream.comparable, false);
    assert.equal(cream.avg_gap_pct, null);
    const row = body.rows.find((r: any) => r.product_id === creamId);
    assert.equal(row.gap_basis, 'not_comparable');
    assert.equal(row.gap_pct, null);
    const overview = await get('/competitors/overview');
    assert.equal(overview.positioning.not_comparable_pairs, 1);
    assert.equal(overview.positioning.overall.pairs, 1, 'the ml-vs-g pair is excluded from the index');
    assert.equal(overview.positioning.overall.index, 122.2);
  });

  it('requires a product for the comparison', async () => {
    assert.equal((await t.api('GET', '/competitors/compare')).status, 400);
  });
});

describe('promotion intelligence', () => {
  it('turns consecutive promotional observations into a promotion episode', async () => {
    const list = await get('/promotions');
    assert.equal(list.total, 1);
    const p = list.rows[0];
    assert.equal(p.listing_id, fx.ownListingId);
    assert.equal(p.promo_type, 'price_cut');
    assert.equal(p.regular_price, 22);
    assert.equal(p.min_promo_price, 17.6);
    assert.equal(p.max_discount_pct, 20);
    assert.equal(p.status, 'ended');
    assert.equal(p.end_reason, 'price_restored');
    assert.equal(p.start_local_date, known.date(2));
    assert.equal(p.is_current, 0);
    assert.equal((await get('/promotions?status=current')).total, 0);
    assert.equal((await get('/promotions?min_discount=25')).total, 0);
  });

  it('summarises discount depth and time on promotion', async () => {
    const body = await get('/promotions/summary?days=14');
    assert.equal(body.kpis.episodes, 1);
    assert.equal(body.kpis.current, 0);
    assert.equal(body.kpis.avg_discount_pct, 20);
    assert.equal(body.kpis.highest_discount_pct, 20);
    assert.equal(body.kpis.promo_listing_days, 1);
    assert.equal(body.kpis.observed_listing_days, 9); // 6 own + 2 rival + 1 cream listing-days
    assert.deepEqual(body.by_type.map((r: any) => [r.key, r.label, r.episodes]), [['price_cut', 'Price cut', 1]]);
    assert.deepEqual(body.by_ownership.map((r: any) => [r.key, r.episodes]), [['own', 1]]);
    const calendar = await get('/promotions/calendar?days=5');
    const promoDay = calendar.days.find((d: any) => d.date === known.date(2));
    assert.equal(promoDay.own_on_promo, 1);
    assert.equal(promoDay.own_share_pct, 100);
    assert.equal(promoDay.avg_discount_pct, 20);
  });
});

describe('overview', () => {
  it('builds every headline figure from stored records', async () => {
    const body = await get('/overview?days=7');
    assert.deepEqual(body.period, { from: known.date(6), to: known.today });
    assert.equal(body.kpis.products_total, 3);
    assert.equal(body.kpis.products_monitored, 3);
    assert.equal(body.kpis.retailers_monitored, 1);
    assert.equal(body.kpis.brands_own, 1);
    assert.equal(body.kpis.brands_competitor, 1);
    assert.equal(body.kpis.markets_with_data, 1);
    assert.equal(body.kpis.observations_total, 9);
    assert.equal(body.kpis.price_increases, 2);
    assert.equal(body.kpis.price_decreases, 2);
    assert.equal(body.kpis.active_promotions, 0);
    assert.equal(body.kpis.latest_observation_at, known.at(1));
    assert.deepEqual(body.provenance.map((p: any) => [p.data_class, p.observations, p.share_pct]), [['manual', 9, 100]]);
    assert.equal(body.demo.present, false);
    assert.equal(body.positioning.overall.index, 122.2);
    assert.equal(body.recent_changes[0].new_price, 22);
    assert.equal(body.recent_changes[0].old_price, 17.6);
  });

  it('reports real and simulated collection separately and claims no run that did not happen', async () => {
    const body = await get('/overview?days=30');
    assert.equal(body.kpis.collection.real.runs, 0);
    assert.equal(body.kpis.collection.real.success_rate_pct, null);
    assert.equal(body.kpis.collection.simulated.runs, 0);
    const market = (await get('/market-intel/overview')).markets.find((m: any) => m.code === 'AE');
    assert.equal(market.collection.real.runs, 0);
    assert.equal(market.listings.active, 3);
    assert.equal(market.demo_only, false);
  });

  it('is readable by every signed-in role and by nobody else', async () => {
    assert.equal((await t.api('GET', '/overview', { as: 'viewer' })).status, 200);
    assert.equal((await t.api('GET', '/monitor', { as: 'analyst' })).status, 200);
    assert.equal((await t.api('GET', '/overview', { as: null })).status, 401);
    assert.equal((await t.api('GET', '/history/timeline', { as: null })).status, 401);
  });
});

describe('voided observations', () => {
  it('disappear from analytics while remaining in the ledger, and return when restored', async () => {
    const voided = await t.api('POST', `/observations/${known.promoObservationId}/void`, { body: { reason: 'Entered against the wrong listing' } });
    assert.equal(voided.status, 200);
    const timeline = await get(`/history/timeline?product_id=${fx.ownProductId}&days=14`);
    assert.deepEqual(timeline.series[0].points.map((p: any) => p.value), [20, 20, 22, 22, 22]);
    assert.equal(timeline.series[0].stats.avg, 21.2);
    assert.equal((await get('/promotions')).total, 0);
    const events = await get(`/events?listing_id=${fx.ownListingId}`);
    assert.deepEqual(events.rows.map((r: any) => r.change_pct), [10]);
    assert.equal(t.ctx.db.scalar('SELECT COUNT(*) FROM price_observations WHERE id = ?', [known.promoObservationId]), 1, 'the row itself is retained');

    const restored = await t.api('POST', `/observations/${known.promoObservationId}/restore`);
    assert.equal(restored.status, 200);
    const again = await get(`/history/timeline?product_id=${fx.ownProductId}&days=14`);
    assert.deepEqual(again.series[0].points.map((p: any) => p.value), [20, 20, 22, 22, 17.6, 22]);
    assert.equal((await get('/promotions')).total, 1);
  });
});

describe('currencies', () => {
  let saListing: number;
  let saMarketId: number;

  before(() => {
    const now = nowIso();
    const sa = t.ctx.db.get<{ id: number }>(`SELECT id FROM markets WHERE code = 'SA'`)!;
    saMarketId = sa.id;
    const retailer = t.ctx.db.run(
      `INSERT INTO retailers (name, website, country_code, market_id, currency_code, collection_method, collection_frequency, created_at, updated_at)
       VALUES ('Riyadh Mart', 'https://riyadhmart.example', 'SA', ?, 'SAR', 'manual', 'daily', ?, ?)`,
      [sa.id, now, now],
    ).lastInsertRowid;
    saListing = t.ctx.db.run(
      `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, created_at, updated_at)
       VALUES (?, ?, 'own-oil-200', 'https://riyadhmart.example/p/own-oil-200', 'Own Oil 200ml', 'matched', ?, ?)`,
      [retailer, fx.ownProductId, now, now],
    ).lastInsertRowid;
    const res = ingestObservations(t.ctx, [{ listing_id: saListing, observed_at: known.at(1), current_price: 24, regular_price: 24, availability: 'in_stock' }], { sourceMethod: 'manual', userId: 1 });
    assert.equal(res.inserted, 1);
  });

  it('stores each observation in the currency of its market', () => {
    const row = t.ctx.db.get<{ currency_code: string }>('SELECT currency_code FROM price_observations WHERE listing_id = ?', [saListing]);
    assert.equal(row!.currency_code, 'SAR');
  });

  it('keeps currencies in separate series instead of averaging raw prices together', async () => {
    const body = await get(`/history/timeline?product_id=${fx.ownProductId}&group_by=product&days=14`);
    assert.deepEqual(body.series.map((s: any) => s.currency).sort(), ['AED', 'SAR']);
    const sar = body.series.find((s: any) => s.currency === 'SAR');
    assert.deepEqual(sar.points.map((p: any) => p.value), [24]);
    const summary = await get(`/history/summary?product_id=${fx.ownProductId}`);
    assert.deepEqual(summary.by_currency.map((c: any) => c.currency).sort(), ['AED', 'SAR']);
  });

  it('refuses to convert without an exchange rate and says which rate is missing', async () => {
    const body = await get(`/market-intel/cross-market?product_id=${fx.ownProductId}&currency=AED`);
    assert.deepEqual(body.missing_rates, ['SAR']);
    const sa = body.rows.find((r: any) => r.market_id === saMarketId);
    assert.equal(sa.native.avg, 24);
    assert.deepEqual(sa.converted, { avg: null, min: null, max: null, unit_avg: null });
    assert.equal(sa.conversion, null);
    assert.equal(sa.index, null);
    const timeline = await get(`/history/timeline?product_id=${fx.ownProductId}&group_by=product&days=14&currency=AED`);
    assert.deepEqual(timeline.missing_rates, ['SAR']);
    assert.ok(timeline.series.every((s: any) => s.currency === 'AED'), 'nothing unconverted is shown as AED');
    assert.ok(!timeline.series.some((s: any) => s.points.some((p: any) => p.value === 24)), 'the SAR price is not passed off as AED');
  });

  it('converts with a recorded rate and discloses the rate, its timestamp and its source', async () => {
    const asOf = known.at(1);
    recordRate(t.ctx, { quote: 'AED', rate: 3.6725, as_of: asOf, source: 'test-desk' });
    recordRate(t.ctx, { quote: 'SAR', rate: 3.75, as_of: asOf, source: 'test-desk' });
    const body = await get(`/market-intel/cross-market?product_id=${fx.ownProductId}&currency=AED`);
    assert.deepEqual(body.missing_rates, []);
    const sa = body.rows.find((r: any) => r.market_id === saMarketId);
    assert.equal(sa.native.avg, 24);
    assert.equal(sa.converted.avg, 23.504); // 24 SAR × 3.6725 / 3.75
    assert.equal(sa.index, 106.8); // 23.504 / 22
    assert.equal(sa.conversion.from, 'SAR');
    assert.equal(sa.conversion.to, 'AED');
    assert.ok(Math.abs(sa.conversion.rate - 3.6725 / 3.75) < 1e-6);
    assert.equal(sa.conversion.as_of, asOf);
    assert.deepEqual(sa.conversion.sources, ['test-desk']);
    assert.equal(sa.conversion.is_demo, false);

    const timeline = await get(`/history/timeline?product_id=${fx.ownProductId}&group_by=product&days=14&currency=AED`);
    assert.equal(timeline.series.length, 1);
    assert.equal(timeline.target_currency, 'AED');
    const conversion = timeline.conversions.find((c: any) => c.from === 'SAR');
    assert.equal(conversion.as_of, asOf);
    assert.deepEqual(conversion.sources, ['test-desk']);
  });

  it('prefers a real exchange rate over an illustrative demo rate, whatever their dates', async () => {
    // a demo rate that is NEWER than the real one must not shadow it
    recordRate(t.ctx, { quote: 'SAR', rate: 9.99, as_of: known.at(0).replace('T08', 'T00'), source: 'DEMO illustrative rate', isDemo: true });
    const body = await get(`/market-intel/cross-market?product_id=${fx.ownProductId}&currency=AED`);
    const sa = body.rows.find((r: any) => r.market_id === saMarketId);
    assert.equal(sa.converted.avg, 23.504);
    assert.equal(sa.conversion.is_demo, false);
    assert.deepEqual(sa.conversion.sources, ['test-desk']);
    // a currency with only demo rates still converts, and says so
    recordRate(t.ctx, { quote: 'KWD', rate: 0.3, as_of: known.at(1), source: 'DEMO illustrative rate', isDemo: true });
    const { makeConverter } = await import('../server/services/fx.ts');
    const converter = makeConverter(t.ctx, 'AED');
    assert.ok(Math.abs(converter.convert(1, 'KWD')! - 3.6725 / 0.3) < 1e-6);
    assert.equal(converter.used().find((c) => c.from === 'KWD')!.is_demo, true);
  });

  it('needs a comparison currency and a subject for cross-market comparison', async () => {
    assert.equal((await t.api('GET', `/market-intel/cross-market?product_id=${fx.ownProductId}&currency=native`)).status, 400);
    assert.equal((await t.api('GET', '/market-intel/cross-market')).status, 400);
    assert.equal((await t.api('GET', `/market-intel/cross-market?product_id=${fx.ownProductId}&currency=XXX`)).status, 400);
  });
});

describe('out-of-stock frequency', () => {
  before(() => {
    const res = ingestObservations(
      t.ctx,
      [
        { listing_id: fx.compListingId, observed_at: known.at(5), current_price: null, availability: 'out_of_stock' },
        { listing_id: fx.compListingId, observed_at: known.at(3), current_price: 27, regular_price: 27, availability: 'out_of_stock' },
      ],
      { sourceMethod: 'manual', userId: 1 },
    );
    assert.deepEqual(res.rejected, []);
    assert.equal(res.inserted, 2);
  });

  it('is reported for the stored history, per series and per period', async () => {
    // rival listing-days: T-10 in stock · T-6 in stock · T-5 out of stock (no price) · T-3 out of stock (priced)
    const summary = await get(`/history/summary?product_id=${fx.compProductId}`);
    assert.equal(summary.observations, 4);
    assert.equal(summary.out_of_stock_observations, 2);
    assert.equal(summary.out_of_stock_share_pct, 50);

    const timeline = await get(`/history/timeline?product_id=${fx.compProductId}&days=14`);
    const series = timeline.series[0];
    assert.equal(series.observed_listing_days, 4);
    assert.equal(series.out_of_stock_share_pct, 50);
    assert.deepEqual(series.points.map((p: any) => [p.date, p.value]), [[known.date(10), 30], [known.date(6), 27], [known.date(3), 27]], 'an unpriced day adds no price point');

    const compare = await get(`/history/compare?preset=last_7_days&group_by=product&product_id=${fx.compProductId}`);
    assert.equal(compare.rows[0].a.out_of_stock_share_pct, 66.7); // T-6 in · T-5 out · T-3 out
    assert.equal(compare.rows[0].b.out_of_stock_share_pct, 0);
    assert.equal(compare.rows[0].a.avg, 27);

    const own = await get(`/history/timeline?product_id=${fx.ownProductId}&market_id=${fx.marketId}&days=14`);
    assert.equal(own.series[0].out_of_stock_share_pct, 0);
  });

  it('records the availability change as an event', async () => {
    const events = await get(`/events?listing_id=${fx.compListingId}&kind=availability_change`);
    assert.ok(events.rows.some((r: any) => r.old_availability === 'in_stock' && r.new_availability === 'out_of_stock'));
    const monitor = await get(`/monitor?availability=out_of_stock`);
    assert.deepEqual(monitor.rows.map((r: any) => r.listing_id), [fx.compListingId]);
  });
});
