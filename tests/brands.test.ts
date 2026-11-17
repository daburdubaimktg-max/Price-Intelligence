/**
 * Brand Explorer over a catalogue whose every figure can be checked by hand.
 *
 * Fixture (T = today in the markets; all prices entered manually, so a listing is stale after 7 days):
 *
 *   UAE (AED)
 *     Test Mart      Own Oil 200 ml   T-10 20.00 · T-8 20.00 · T-6 22.00 · T-4 22.00 · T-2 17.60 promo · T-1 22.00   (see ingestKnownPrices)
 *                    Rival Oil 300 ml T-10 30.00 · T-6 27.00
 *                    Own Cream 100 g  T-9 9.00                                   → STALE (older than 7 days)
 *     Second Store   Own Oil 200 ml   T-12 20.00 · T-9 21.00 · T-5 21.00 · T-1 19.80 on promotion (regular 22.00 → 10 % off)
 *                    Own Cream 100 g  never observed
 *     Third Shop     Own Cream 100 g  T-3 8.00 · T-1 8.50
 *                    Own Oil 200 ml   listing deactivated → not part of anything
 *     Empty Outlet   lists nothing of either brand
 *   Saudi Arabia (SAR)
 *     Riyadh Mart    Own Oil 200 ml   T-1 24.00
 *
 * "Test Own" therefore has 2 listed products and 6 active listings at 4 retailers in 2 markets: 4 fresh, 1 stale,
 * 1 never observed. Fresh prices: AED 22.00, 19.80, 8.50 and SAR 24.00.
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
const ids = {} as {
  sa: number; second: number; third: number; empty: number; riyadh: number; cream: number; creamCategory: number; ghostBrand: number;
  oilSecond: number; oilRiyadh: number; creamMart: number; creamSecond: number; creamThird: number;
};

const get = async (url: string, as?: 'admin' | 'analyst' | 'viewer' | null) => {
  const res = await t.api('GET', url, as === undefined ? {} : { as });
  assert.equal(res.status, 200, `${url} → ${res.status} ${res.raw.slice(0, 200)}`);
  return res.body;
};
const brandRow = (body: any, id: number) => body.rows.find((r: any) => r.id === id);

before(async () => {
  t = await createTestApp();
  fx = createFixture(t.ctx);
  known = await ingestKnownPrices(t.ctx, fx);
  const { db } = t.ctx;
  const now = nowIso();
  ids.sa = db.get<{ id: number }>(`SELECT id FROM markets WHERE code = 'SA'`)!.id;
  const retailer = (name: string, country: 'AE' | 'SA') =>
    db.run(
      `INSERT INTO retailers (name, website, country_code, market_id, currency_code, collection_method, collection_frequency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'manual', 'daily', ?, ?)`,
      [name, `https://${name.toLowerCase().replace(/\s+/g, '')}.example`, country, country === 'AE' ? fx.marketId : ids.sa, country === 'AE' ? 'AED' : 'SAR', now, now],
    ).lastInsertRowid as number;
  const listing = (retailerId: number, productId: number | null, slug: string, title = slug) =>
    db.run(
      `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [retailerId, productId, slug, `https://shop.example/${retailerId}/${slug}`, title, productId ? 'matched' : 'unmatched', now, now],
    ).lastInsertRowid as number;

  ids.creamCategory = db.run('INSERT INTO categories (name, created_at) VALUES (?, ?)', ['Hair Cream', now]).lastInsertRowid as number;
  ids.cream = db.run(
    `INSERT INTO products (brand_id, name, category_id, pack_size, pack_unit, created_at, updated_at) VALUES (?, 'Own Cream 100g', ?, 100, 'g', ?, ?)`,
    [fx.ownBrandId, ids.creamCategory, now, now],
  ).lastInsertRowid as number;
  db.run(`UPDATE brands SET manufacturer = 'Rival Industries' WHERE id = ?`, [fx.compBrandId]);
  // a catalogue brand with a product but no listing anywhere
  ids.ghostBrand = db.run(`INSERT INTO brands (name, ownership, created_at, updated_at) VALUES ('Ghost Brand', 'competitor', ?, ?)`, [now, now]).lastInsertRowid as number;
  db.run(`INSERT INTO products (brand_id, name, category_id, pack_size, pack_unit, created_at, updated_at) VALUES (?, 'Ghost Oil 100ml', ?, 100, 'ml', ?, ?)`, [
    ids.ghostBrand, fx.categoryId, now, now,
  ]);

  ids.second = retailer('Second Store', 'AE');
  ids.third = retailer('Third Shop', 'AE');
  ids.empty = retailer('Empty Outlet', 'AE');
  ids.riyadh = retailer('Riyadh Mart', 'SA');
  ids.oilSecond = listing(ids.second, fx.ownProductId, 'own-oil-second');
  ids.oilRiyadh = listing(ids.riyadh, fx.ownProductId, 'own-oil-riyadh');
  ids.creamMart = listing(fx.retailerId, ids.cream, 'own-cream-mart');
  ids.creamSecond = listing(ids.second, ids.cream, 'own-cream-second');
  ids.creamThird = listing(ids.third, ids.cream, 'own-cream-third');
  const retired = listing(ids.third, fx.ownProductId, 'own-oil-retired');
  db.run('UPDATE retailer_listings SET is_active = 0 WHERE id = ?', [retired]);
  // unmatched listings: one whose title names the brand, one that does not
  listing(fx.retailerId, null, 'unmatched-1', 'TEST OWN herbal oil 500ml');
  listing(fx.retailerId, null, 'unmatched-2', 'Some other oil 500ml');

  const price = (listing_id: number, k: number, current: number, extra: Record<string, unknown> = {}) => ({
    listing_id, observed_at: known.at(k), current_price: current, regular_price: current, availability: 'in_stock' as const, ...extra,
  });
  const res = ingestObservations(
    t.ctx,
    [
      price(ids.oilSecond, 12, 20),
      price(ids.oilSecond, 9, 21),
      price(ids.oilSecond, 5, 21),
      price(ids.oilSecond, 1, 19.8, { regular_price: 22, promo_price: 19.8, is_promo: true, promo_type: 'price_cut', promo_description: 'Save 10%' }),
      price(ids.oilRiyadh, 1, 24),
      price(ids.creamMart, 9, 9),
      price(ids.creamThird, 3, 8),
      price(ids.creamThird, 1, 8.5),
    ],
    { sourceMethod: 'manual', userId: 1 },
  );
  assert.equal(res.inserted, 8, JSON.stringify(res.rejected));
});
after(async () => {
  await t.close();
});

describe('GET /brand-explorer — one row per brand with listed products', () => {
  it('counts products, listings, retailers and markets, and splits listings into fresh, stale and never observed', async () => {
    const body = await get('/brand-explorer');
    assert.deepEqual(body.rows.map((r: any) => r.name), ['Test Own', 'Test Rival'], 'own brands first; a brand without listings has no row');
    const own = brandRow(body, fx.ownBrandId);
    assert.deepEqual(
      { ownership: own.ownership, products: own.products, listings: own.listings, retailers: own.retailers, markets: own.markets, is_demo: own.is_demo },
      { ownership: 'own', products: 2, listings: 6, retailers: 4, markets: 2, is_demo: 0 },
    );
    assert.deepEqual(own.freshness, { fresh: 4, stale: 1, never_observed: 1, last_observed_at: known.at(1) });
    assert.deepEqual(own.categories.map((c: any) => [c.name, c.products]), [['Hair Cream', 1], ['Hair Oil', 1]]);
    assert.equal(own.category_count, 2);

    const rival = brandRow(body, fx.compBrandId);
    assert.deepEqual(
      { ownership: rival.ownership, manufacturer: rival.manufacturer, products: rival.products, listings: rival.listings, retailers: rival.retailers, markets: rival.markets },
      { ownership: 'competitor', manufacturer: 'Rival Industries', products: 1, listings: 1, retailers: 1, markets: 1 },
    );
    assert.deepEqual(rival.freshness, { fresh: 1, stale: 0, never_observed: 0, last_observed_at: known.at(6) });

    assert.deepEqual(body.summary, {
      brands: 2, own_brands: 1, competitor_brands: 1, products: 3, own_products: 2, competitor_products: 1,
      listings: 7, fresh_listings: 5, stale_listings: 1, never_observed_listings: 1, retailers: 4, markets: 2,
      currencies: ['AED', 'SAR'], brands_without_listings: 1,
    });
    assert.equal(body.sort, 'default');
    assert.equal(body.demo.any_demo, false);
  });

  it('keeps one current price range per currency and leaves stale prices out', async () => {
    const own = brandRow(await get('/brand-explorer'), fx.ownBrandId);
    // AED: 8.50 · 19.80 · 22.00 (the stale 9.00 is not a current price)   SAR: 24.00
    assert.deepEqual(own.price_ranges, [
      { currency: 'AED', listings: 3, min: 8.5, median: 19.8, max: 22 },
      { currency: 'SAR', listings: 1, min: 24, median: 24, max: 24 },
    ]);
    const rival = brandRow(await get('/brand-explorer'), fx.compBrandId);
    assert.deepEqual(rival.price_ranges, [{ currency: 'AED', listings: 1, min: 27, median: 27, max: 27 }]);

    // only the stale listing in scope: no current figure at all, but it is still counted
    const staleOnly = brandRow(await get(`/brand-explorer?retailer_id=${fx.retailerId}&category_id=${ids.creamCategory}`), fx.ownBrandId);
    assert.deepEqual([staleOnly.listings, staleOnly.freshness.fresh, staleOnly.freshness.stale], [1, 0, 1]);
    assert.deepEqual(staleOnly.price_ranges, []);
    assert.equal(staleOnly.promo.share_pct, null);
  });

  it('reports the promotion share of fresh listings and the price moves of 7 and 30 days', async () => {
    const body = await get('/brand-explorer');
    const own = brandRow(body, fx.ownBrandId);
    // 1 of 4 fresh listings is on promotion: 19.80 against a regular 22.00 = 10 % off
    assert.deepEqual(own.promo, { listings: 1, share_pct: 25, avg_discount_pct: 10, deepest_discount_pct: 10 });
    // last 7 days (T-6…T): Test Mart ↑ T-6, ↓ T-2, ↑ T-1 · Second Store ↓ T-1 · Third Shop ↑ T-1; 30 days add Second Store ↑ T-9
    assert.deepEqual(own.moves_7d, { increases: 3, decreases: 2 });
    assert.deepEqual(own.moves_30d, { increases: 4, decreases: 2 });
    const rival = brandRow(body, fx.compBrandId);
    assert.deepEqual(rival.promo, { listings: 0, share_pct: 0, avg_discount_pct: null, deepest_discount_pct: null });
    assert.deepEqual(rival.moves_7d, { increases: 0, decreases: 1 });
  });

  it('draws a unit-free index: every listing starts at 100 and holds its price between observations', async () => {
    const body = await get('/brand-explorer');
    assert.deepEqual(body.trend_period, { from: known.date(29), to: known.today });
    const own = brandRow(body, fx.ownBrandId);
    const at = (k: number) => own.trend.find((p: any) => p.date === known.date(k));
    assert.equal(own.trend.length, 12, 'one point per day from the first observation (T-12) to the last (T-1)');
    assert.deepEqual(at(12), { date: known.date(12), index: 100, listings: 1 });
    // T-2: Test Mart oil 17.60/20 = 88 · Second Store oil 21/20 = 105 (held) · Third Shop cream 100 (held) · Test Mart cream 100 (held, day 7)
    assert.deepEqual(at(2), { date: known.date(2), index: 98.25, listings: 4 });
    // T-1: 110 · 99 · 106.25 · Riyadh 100; the stale cream is no longer held → 415.25 / 4
    assert.deepEqual(at(1), { date: known.date(1), index: 103.81, listings: 4 });
    assert.equal(own.trend_change_pct, 3.81);

    const rival = brandRow(body, fx.compBrandId);
    assert.deepEqual(rival.trend.map((p: any) => p.index), [100, 100, 100, 100, 90], 'T-10…T-7 at 30.00, T-6 at 27.00; the line ends on the last observed day');
    assert.equal(rival.trend_change_pct, -10);
  });

  it('states the price index against mapped competitors from current same-retailer pairs', async () => {
    const body = await get('/brand-explorer');
    // own 22.00 / 200 ml = 11.00 per 100 ml against rival 27.00 / 300 ml = 9.00 per 100 ml → 122.2
    assert.deepEqual(brandRow(body, fx.ownBrandId).price_index, {
      index: 122.2, premium_pct: 22.2, pairs: 1, cheaper_pairs: 0, dearer_pairs: 1, not_comparable_pairs: 0, perspective: 'own_vs_competitors',
    });
    assert.deepEqual(
      [brandRow(body, fx.compBrandId).price_index.index, brandRow(body, fx.compBrandId).price_index.perspective],
      [122.2, 'own_vs_this_brand'],
    );
    // no rival listing in Saudi Arabia → nothing to compare there
    assert.equal(brandRow(await get(`/brand-explorer?market_id=${ids.sa}`), fx.ownBrandId).price_index, null);
  });

  it('filters by market, retailer, category, ownership and brand search', async () => {
    const saudi = await get(`/brand-explorer?market_id=${ids.sa}`);
    assert.deepEqual(saudi.rows.map((r: any) => [r.name, r.products, r.listings]), [['Test Own', 1, 1]]);
    assert.deepEqual(saudi.rows[0].price_ranges, [{ currency: 'SAR', listings: 1, min: 24, median: 24, max: 24 }]);
    assert.deepEqual([saudi.summary.listings, saudi.summary.currencies], [1, ['SAR']]);

    const second = brandRow(await get(`/brand-explorer?retailer_id=${ids.second}`), fx.ownBrandId);
    assert.deepEqual([second.listings, second.freshness.fresh, second.freshness.never_observed, second.promo.share_pct], [2, 1, 1, 100]);
    assert.deepEqual(second.price_ranges, [{ currency: 'AED', listings: 1, min: 19.8, median: 19.8, max: 19.8 }]);
    assert.deepEqual(second.moves_30d, { increases: 1, decreases: 1 });

    const cream = await get(`/brand-explorer?category_id=${ids.creamCategory}`);
    assert.deepEqual(cream.rows.map((r: any) => [r.name, r.products, r.listings]), [['Test Own', 1, 3]]);

    assert.deepEqual((await get('/brand-explorer?ownership=competitor')).rows.map((r: any) => r.name), ['Test Rival']);
    assert.deepEqual((await get('/brand-explorer?ownership=own')).rows.map((r: any) => r.name), ['Test Own']);
    assert.deepEqual((await get('/brand-explorer?q=rival')).rows.map((r: any) => r.name), ['Test Rival']);
    assert.deepEqual((await get('/brand-explorer?q=industries')).rows.map((r: any) => r.name), ['Test Rival'], 'the manufacturer is searched too');
    const ghost = await get('/brand-explorer?q=ghost');
    assert.deepEqual([ghost.rows.length, ghost.summary.brands_without_listings], [0, 1]);
  });

  it('sorts by the requested figure and keeps the default of own brands first', async () => {
    const names = async (sort: string) => (await get(`/brand-explorer?sort=${sort}`)).rows.map((r: any) => r.name);
    assert.deepEqual(await names('-listings'), ['Test Own', 'Test Rival']);
    assert.deepEqual(await names('listings'), ['Test Rival', 'Test Own']);
    assert.deepEqual(await names('-name'), ['Test Rival', 'Test Own']);
    assert.deepEqual(await names('promo_share'), ['Test Rival', 'Test Own']);
    assert.deepEqual(await names('-moves'), ['Test Own', 'Test Rival']);
    assert.deepEqual(await names('last_observation'), ['Test Rival', 'Test Own']);
    assert.deepEqual(await names('-trend'), ['Test Own', 'Test Rival']);
    assert.equal((await get('/brand-explorer?sort=-listings')).sort, '-listings');
    assert.equal((await get('/brand-explorer?sort=nonsense')).sort, 'default');
  });
});

describe('GET /brand-explorer/:id — one brand in depth', () => {
  it('lists the product range with per-currency prices, the cheapest retailer per market and the 30-day change', async () => {
    const body = await get(`/brand-explorer/${fx.ownBrandId}`);
    assert.deepEqual(
      { name: body.brand.name, products: body.brand.products, products_total: body.brand.products_total, listings: body.brand.listings, is_active: body.brand.is_active },
      { name: 'Test Own', products: 2, products_total: 2, listings: 6, is_active: 1 },
    );
    assert.deepEqual(body.range.map((r: any) => r.name), ['Own Cream 100g', 'Own Oil 200ml AE-Test Mart']);
    const [cream, oil] = body.range;

    assert.deepEqual(
      { pack: oil.pack, basis: oil.unit_basis, category: oil.category_name, listings: oil.listings, retailers: oil.retailers, markets: oil.markets, fresh: oil.fresh, stale: oil.stale, never: oil.never_observed },
      { pack: '200ml', basis: 'per 100ml', category: 'Hair Oil', listings: 3, retailers: 3, markets: 2, fresh: 3, stale: 0, never: 0 },
    );
    // AED: (22.00 + 19.80) / 2 = 20.90 → 10.45 per 100 ml;  SAR: 24.00 → 12.00 per 100 ml
    assert.deepEqual(oil.prices, [
      { currency: 'AED', listings: 2, min: 19.8, avg: 20.9, max: 22, avg_unit_price: 10.45 },
      { currency: 'SAR', listings: 1, min: 24, avg: 24, max: 24, avg_unit_price: 12 },
    ]);
    assert.deepEqual(
      oil.cheapest.map((c: any) => [c.market_code, c.retailer_name, c.price, c.currency, c.is_promo, c.compared, c.tied, c.listing_id]),
      [
        ['SA', 'Riyadh Mart', 24, 'SAR', false, 1, 0, ids.oilRiyadh],
        ['AE', 'Second Store', 19.8, 'AED', true, 2, 0, ids.oilSecond],
      ],
    );
    assert.deepEqual([oil.promo_listings, oil.deepest_discount_pct, oil.deepest_discount_retailer], [1, 10, 'Second Store']);
    assert.equal(oil.change_30d_pct, 3, '(110 + 99 + 100) / 3 − 100');
    assert.equal(oil.last_observed_at, known.at(1));

    assert.deepEqual(
      { pack: cream.pack, basis: cream.unit_basis, category: cream.category_name, listings: cream.listings, retailers: cream.retailers, markets: cream.markets, fresh: cream.fresh, stale: cream.stale, never: cream.never_observed },
      { pack: '100g', basis: 'per 100g', category: 'Hair Cream', listings: 3, retailers: 3, markets: 1, fresh: 1, stale: 1, never: 1 },
    );
    assert.deepEqual(cream.prices, [{ currency: 'AED', listings: 1, min: 8.5, avg: 8.5, max: 8.5, avg_unit_price: 8.5 }], 'the stale 9.00 is not a current price');
    assert.deepEqual(cream.cheapest.map((c: any) => [c.retailer_name, c.price, c.compared]), [['Third Shop', 8.5, 1]]);
    assert.deepEqual([cream.promo_listings, cream.deepest_discount_pct, cream.change_30d_pct], [0, null, 6.25]);
  });

  it('builds the price matrix of the market with most listings and marks the cheapest retailer', async () => {
    const body = await get(`/brand-explorer/${fx.ownBrandId}`);
    assert.deepEqual(body.markets.map((m: any) => [m.code, m.currency_code, m.listings, m.products, m.retailers]), [['AE', 'AED', 5, 2, 3], ['SA', 'SAR', 1, 1, 1]]);
    const m = body.matrix;
    assert.deepEqual([m.market.code, m.currency, m.other_currencies], ['AE', 'AED', []]);
    assert.deepEqual(m.retailers.map((r: any) => [r.name, r.listings, r.products, r.cheapest_count]), [['Second Store', 2, 2, 1], ['Test Mart', 2, 2, 0], ['Third Shop', 1, 1, 0]]);
    assert.deepEqual(m.rows.map((r: any) => r.name), ['Own Cream 100g', 'Own Oil 200ml AE-Test Mart']);
    const [cream, oil] = m.rows;

    // Own Oil: Second Store 19.80 (regular 22.00) is cheaper than Test Mart 22.00; Third Shop does not list it
    const [oilSecond, oilMart, oilThird] = oil.cells;
    assert.deepEqual(
      { listing: oilSecond.listing_id, price: oilSecond.current_price, regular: oilSecond.regular_price, unit: oilSecond.unit_price, promo: oilSecond.is_promo, discount: oilSecond.discount_pct, cheapest: oilSecond.is_cheapest, stale: oilSecond.is_stale },
      { listing: ids.oilSecond, price: 19.8, regular: 22, unit: 9.9, promo: true, discount: 10, cheapest: true, stale: false },
    );
    assert.deepEqual(
      { listing: oilMart.listing_id, price: oilMart.current_price, regular: oilMart.regular_price, unit: oilMart.unit_price, promo: oilMart.is_promo, cheapest: oilMart.is_cheapest, observed: oilMart.observed_at },
      { listing: fx.ownListingId, price: 22, regular: null, unit: 11, promo: false, cheapest: false, observed: known.at(1) },
    );
    assert.equal(oilThird, null, 'not listed (the deactivated listing does not count)');
    assert.deepEqual(
      { listed: oil.listed_at, compared: oil.compared, winners: oil.cheapest_retailer_ids, min: oil.min_price, max: oil.max_price, spread: oil.spread_pct },
      { listed: 2, compared: 2, winners: [ids.second], min: 19.8, max: 22, spread: 11.1 },
    );

    // Own Cream: never observed at Second Store, stale at Test Mart, one fresh price at Third Shop → nothing to compare
    const [creamSecond, creamMart, creamThird] = cream.cells;
    assert.deepEqual([creamSecond.never_observed, creamSecond.current_price, creamSecond.is_cheapest], [true, null, false]);
    assert.deepEqual([creamMart.is_stale, creamMart.current_price, creamMart.is_cheapest], [true, 9, false]);
    assert.deepEqual([creamThird.current_price, creamThird.unit_price, creamThird.is_stale, creamThird.is_cheapest], [8.5, 8.5, false, false]);
    assert.deepEqual({ listed: cream.listed_at, compared: cream.compared, winners: cream.cheapest_retailer_ids, spread: cream.spread_pct }, { listed: 3, compared: 1, winners: [], spread: null });

    assert.deepEqual(m.retailers_without_brand.map((r: any) => r.name), ['Empty Outlet']);
    assert.deepEqual(m.products_not_listed, []);
  });

  it('shows another market on request and names the products not listed there', async () => {
    const picked = await get(`/brand-explorer/${fx.ownBrandId}?matrix_market_id=${ids.sa}`);
    assert.equal(picked.range.length, 2, 'the matrix market does not narrow the rest of the page');
    assert.deepEqual([picked.matrix.market.code, picked.matrix.currency], ['SA', 'SAR']);
    assert.deepEqual(picked.matrix.retailers.map((r: any) => r.name), ['Riyadh Mart']);
    assert.deepEqual(picked.matrix.rows.map((r: any) => [r.name, r.cells[0].current_price, r.cells[0].currency, r.cells[0].is_cheapest]), [['Own Oil 200ml AE-Test Mart', 24, 'SAR', false]]);
    assert.deepEqual(picked.matrix.products_not_listed.map((p: any) => p.name), ['Own Cream 100g']);

    const scoped = await get(`/brand-explorer/${fx.ownBrandId}?market_id=${ids.sa}`);
    assert.equal(scoped.matrix.market.code, 'SA', 'a single market in scope is the matrix market');
    assert.deepEqual([scoped.brand.listings, scoped.brand.markets, scoped.markets.length], [1, 1, 1]);
    const scopedOil = scoped.range.find((r: any) => r.name.startsWith('Own Oil'));
    const scopedCream = scoped.range.find((r: any) => r.name.startsWith('Own Cream'));
    assert.deepEqual(scopedOil.prices, [{ currency: 'SAR', listings: 1, min: 24, avg: 24, max: 24, avg_unit_price: 12 }]);
    assert.deepEqual([scopedCream.listings, scopedCream.prices, scopedCream.cheapest], [0, [], []], 'not listed in this scope, still part of the range');

    const byRetailer = await get(`/brand-explorer/${fx.ownBrandId}?retailer_id=${fx.retailerId},${ids.third}&category_id=${ids.creamCategory}`);
    assert.deepEqual(byRetailer.range.map((r: any) => [r.name, r.listings]), [['Own Cream 100g', 2]]);
    assert.deepEqual(byRetailer.matrix.retailers.map((r: any) => r.name), ['Test Mart', 'Third Shop']);
    assert.deepEqual(byRetailer.matrix.retailers_without_brand, [], 'only retailers inside the retailer filter are named');
  });

  it('charts the unit price per category per currency and the index against competing brands', async () => {
    const body = await get(`/brand-explorer/${fx.ownBrandId}`);
    assert.deepEqual([body.trend.days, body.trend.period], [30, { from: known.date(29), to: known.today }]);
    const series = body.trend.by_category.series.map((s: any) => [s.label, s.currency, s.basis]).sort();
    assert.deepEqual(series, [['Hair Cream', 'AED', 'per 100g'], ['Hair Oil', 'AED', 'per 100ml'], ['Hair Oil', 'SAR', 'per 100ml']]);
    const oilAed = body.trend.by_category.series.find((s: any) => s.label === 'Hair Oil' && s.currency === 'AED');
    // T-1: Test Mart 11.00 and Second Store 9.90 per 100 ml → 10.45
    assert.deepEqual(oilAed.points.find((p: any) => p.date === known.date(1)), { date: known.date(1), value: 10.45, n: 2, promo: 0.5 });
    assert.deepEqual(body.trend.index.map((s: any) => [s.name, s.is_self, s.change_pct]), [['Test Own', true, 3.81], ['Test Rival', false, -10]]);

    const long = await get(`/brand-explorer/${fx.ownBrandId}?days=90`);
    assert.deepEqual([long.trend.days, long.trend.period.from], [90, known.date(89)]);
    assert.equal((await get(`/brand-explorer/${fx.ownBrandId}?days=1`)).trend.days, 7, 'the period is clamped to 7–365 days');
  });

  it('lists competing brands with their mappings and the index between the two brands', async () => {
    const own = await get(`/brand-explorer/${fx.ownBrandId}`);
    assert.equal(own.competitors.length, 1);
    const c = own.competitors[0];
    assert.deepEqual(
      { brand: c.brand.name, products: c.brand.products, listings: c.brand.listings, benchmark: c.is_benchmark, approved: c.approved_mappings, suggested: c.suggested_mappings, own: c.own_brand_name, competitor: c.competitor_brand_name, index: c.index, premium: c.premium_pct, pairs: c.pairs },
      { brand: 'Test Rival', products: 1, listings: 1, benchmark: false, approved: 1, suggested: 0, own: 'Test Own', competitor: 'Test Rival', index: 122.2, premium: 22.2, pairs: 1 },
    );

    // seen from the competitor: the same comparison, still own ÷ competitor
    const rival = await get(`/brand-explorer/${fx.compBrandId}`);
    assert.deepEqual(
      rival.competitors.map((r: any) => [r.brand.name, r.own_brand_name, r.competitor_brand_name, r.index, r.is_benchmark]),
      [['Test Own', 'Test Own', 'Test Rival', 122.2, false]],
    );
    assert.deepEqual(rival.range.map((r: any) => [r.name, r.listings, r.prices[0].min]), [['Rival Oil 300ml AE-Test Mart', 1, 27]]);

    // declared as a benchmark in the catalogue
    t.ctx.db.run('INSERT INTO brand_competitors (own_brand_id, competitor_brand_id) VALUES (?, ?)', [fx.ownBrandId, fx.compBrandId]);
    assert.equal((await get(`/brand-explorer/${fx.ownBrandId}`)).competitors[0].is_benchmark, true);
    assert.equal((await get(`/brand-explorer/${fx.compBrandId}`)).competitors[0].is_benchmark, true);

    // a brand with products but no listing still has a page, with nothing current on it
    const ghost = await get(`/brand-explorer/${ids.ghostBrand}`);
    assert.deepEqual(
      [ghost.brand.products, ghost.brand.products_total, ghost.brand.listings, ghost.brand.price_ranges, ghost.matrix, ghost.markets, ghost.competitors],
      [0, 1, 0, [], null, [], []],
    );
    assert.deepEqual(ghost.range.map((r: any) => [r.name, r.listings, r.prices]), [['Ghost Oil 100ml', 0, []]]);
  });

  it('counts unmatched listings whose title names the brand without adding them to any figure', async () => {
    const body = await get(`/brand-explorer/${fx.ownBrandId}`);
    assert.deepEqual(body.unmatched, { count: 1, search: 'Test Own' });
    assert.equal(body.brand.listings, 6);
    assert.equal((await get(`/brand-explorer/${fx.ownBrandId}?market_id=${ids.sa}`)).unmatched.count, 0);
    assert.equal((await get(`/brand-explorer/${fx.compBrandId}`)).unmatched.count, 0);
  });

  it('answers 404 for an unknown brand and 400 for an invalid id', async () => {
    assert.equal((await t.api('GET', '/brand-explorer/999999')).status, 404);
    assert.equal((await t.api('GET', '/brand-explorer/abc')).status, 400);
    assert.equal((await t.api('GET', `/brand-explorer?market_id=x`)).status, 400);
  });
});

describe('access', () => {
  it('is readable by every signed-in role and closed to anonymous requests', async () => {
    for (const role of ['admin', 'analyst', 'viewer'] as const) {
      assert.equal((await get('/brand-explorer', role)).rows.length, 2);
      assert.equal((await get(`/brand-explorer/${fx.ownBrandId}`, role)).brand.name, 'Test Own');
    }
    assert.equal((await t.api('GET', '/brand-explorer', { as: null })).status, 401);
    assert.equal((await t.api('GET', `/brand-explorer/${fx.ownBrandId}`, { as: null })).status, 401);
  });
});

describe('currencies are never blended', () => {
  it('converts only on request, drops currencies without a rate and names them', async () => {
    // no exchange rate is stored yet: SAR prices cannot be expressed in AED and are left out — never guessed
    const list = await get('/brand-explorer?currency=AED');
    assert.deepEqual([list.currency_mode, list.target_currency, list.conversions, list.missing_rates], ['converted', 'AED', [], ['SAR']]);
    assert.deepEqual(brandRow(list, fx.ownBrandId).price_ranges, [{ currency: 'AED', listings: 3, min: 8.5, median: 19.8, max: 22 }]);
    const native = await get('/brand-explorer');
    assert.deepEqual([native.currency_mode, native.target_currency, native.conversions, native.missing_rates], ['native', null, [], []]);
    assert.equal((await t.api('GET', '/brand-explorer?currency=XXX')).status, 400);
  });

  it('discloses rate, timestamp and source of every conversion', async () => {
    const asOf = known.at(1);
    recordRate(t.ctx, { quote: 'AED', rate: 3.6725, as_of: asOf, source: 'test-desk' });
    recordRate(t.ctx, { quote: 'SAR', rate: 3.75, as_of: asOf, source: 'test-desk' });
    const list = await get('/brand-explorer?currency=AED');
    // 24.00 SAR × 3.6725 / 3.75 = 23.504 AED → 8.50 · 19.80 · 22.00 · 23.504
    assert.deepEqual(brandRow(list, fx.ownBrandId).price_ranges, [{ currency: 'AED', listings: 4, min: 8.5, median: 20.9, max: 23.504 }]);
    assert.deepEqual(list.missing_rates, []);
    assert.equal(list.conversions.length, 1);
    const conversion = list.conversions[0];
    assert.deepEqual([conversion.from, conversion.to, conversion.as_of, conversion.sources, conversion.is_demo], ['SAR', 'AED', asOf, ['test-desk'], false]);
    assert.ok(Math.abs(conversion.rate - 3.6725 / 3.75) < 1e-9);

    const detail = await get(`/brand-explorer/${fx.ownBrandId}?currency=AED`);
    const oil = detail.range.find((r: any) => r.name.startsWith('Own Oil'));
    // (22.00 + 19.80 + 23.504) / 3 = 21.768 → 10.884 per 100 ml
    assert.deepEqual(oil.prices, [{ currency: 'AED', listings: 3, min: 19.8, avg: 21.768, max: 23.504, avg_unit_price: 10.884 }]);
    const saudi = oil.cheapest.find((c: any) => c.market_code === 'SA');
    assert.deepEqual([saudi.price, saudi.currency, saudi.native_price, saudi.native_currency], [23.504, 'AED', 24, 'SAR']);
    assert.deepEqual(detail.conversions.map((c: any) => [c.from, c.to]), [['SAR', 'AED']]);
    const oilSeries = detail.trend.by_category.series.filter((s: any) => s.label === 'Hair Oil');
    assert.deepEqual(oilSeries.map((s: any) => [s.currency, s.basis]), [['AED', 'per 100ml']], 'one converted series instead of one per currency');
    assert.deepEqual(oilSeries[0].points.find((p: any) => p.date === known.date(1)).value, 10.884);
    // the matrix of a market always stays in that market's own currency
    const matrix = (await get(`/brand-explorer/${fx.ownBrandId}?currency=AED&matrix_market_id=${ids.sa}`)).matrix;
    assert.deepEqual([matrix.currency, matrix.rows[0].cells[0].current_price], ['SAR', 24]);

    // without a comparison currency nothing is converted, whatever rates exist
    const nativeOil = (await get(`/brand-explorer/${fx.ownBrandId}`)).range.find((r: any) => r.name.startsWith('Own Oil'));
    assert.deepEqual(nativeOil.prices.map((p: any) => [p.currency, p.max]), [['AED', 22], ['SAR', 24]]);
  });
});

describe('pack variants', () => {
  it('keeps a twin pack out of shelf-price figures and of the cheapest-retailer comparison', async () => {
    const { db } = t.ctx;
    const now = nowIso();
    // Empty Outlet starts listing the own oil as a twin pack only: 2 × 200 ml for 30.00 → 7.50 per 100 ml
    const variantId = db.run(`INSERT INTO product_variants (product_id, name, pack_size, pack_unit, units_per_pack, created_at) VALUES (?, 'Twin pack', 200, 'ml', 2, ?)`, [fx.ownProductId, now]).lastInsertRowid as number;
    const twin = db.run(
      `INSERT INTO retailer_listings (retailer_id, product_id, variant_id, external_id, url, title, match_status, created_at, updated_at) VALUES (?, ?, ?, 'own-oil-twin', 'https://shop.example/twin', 'Own Oil twin pack', 'matched', ?, ?)`,
      [ids.empty, fx.ownProductId, variantId, now, now],
    ).lastInsertRowid as number;
    const res = ingestObservations(t.ctx, [{ listing_id: twin, observed_at: known.at(1), current_price: 30, regular_price: 30, availability: 'in_stock' }], { sourceMethod: 'manual', userId: 1 });
    assert.equal(res.inserted, 1, JSON.stringify(res.rejected));

    const body = await get(`/brand-explorer/${fx.ownBrandId}`);
    const oil = body.range.find((r: any) => r.name.startsWith('Own Oil'));
    assert.deepEqual([oil.listings, oil.retailers, oil.variant_listings, oil.fresh], [4, 4, 1, 4]);
    // the shelf prices of the standard pack are unchanged, and Second Store is still the cheapest retailer in the UAE
    assert.deepEqual(oil.prices[0], { currency: 'AED', listings: 2, min: 19.8, avg: 20.9, max: 22, avg_unit_price: 10.45 });
    assert.deepEqual(oil.cheapest.filter((c: any) => c.market_code === 'AE').map((c: any) => [c.retailer_name, c.price, c.compared]), [['Second Store', 19.8, 2]]);

    const m = body.matrix;
    assert.deepEqual(m.retailers.map((r: any) => r.name), ['Empty Outlet', 'Second Store', 'Test Mart', 'Third Shop']);
    assert.deepEqual(m.retailers_without_brand, []);
    const row = m.rows.find((r: any) => r.name.startsWith('Own Oil'));
    const [outlet, second] = row.cells;
    assert.deepEqual(
      { listing: outlet.listing_id, variant: outlet.variant_name, isVariant: outlet.is_variant, price: outlet.current_price, unit: outlet.unit_price, cheapest: outlet.is_cheapest },
      { listing: twin, variant: 'Twin pack', isVariant: true, price: 30, unit: 7.5, cheapest: false },
    );
    assert.equal(second.is_cheapest, true);
    // listed at three retailers of the UAE (the fourth listing is in Saudi Arabia); two of them have a comparable shelf price
    assert.deepEqual([row.listed_at, row.compared, row.min_price, row.max_price, row.spread_pct], [3, 2, 19.8, 22, 11.1]);

    // the brand-level range spans every fresh listing of the brand, the twin pack included
    const own = brandRow(await get('/brand-explorer'), fx.ownBrandId);
    assert.deepEqual(own.price_ranges[0], { currency: 'AED', listings: 4, min: 8.5, median: 20.9, max: 30 });
  });
});

describe('deal tags', () => {
  it('reports the tags of fresh listings — and only of fresh listings — on brand rows, range rows and matrix cells', async (test) => {
    // Tags are stored with observations from the "signals" schema on; an older ledger has none to report.
    const stored = t.ctx.db.all<{ name: string }>('PRAGMA table_info(price_observations)').some((column) => column.name === 'tags');
    if (!stored) return test.skip('this ledger stores no deal tags');
    assert.equal(brandRow(await get('/brand-explorer'), fx.ownBrandId).tags, undefined, 'nothing is tagged yet');

    // Second Store now shows "Limited time deal" on the oil (same price); the stale cream at Test Mart was a best seller eight days ago
    const observations: Array<Record<string, unknown>> = [
      { listing_id: ids.oilSecond, observed_at: new Date(Date.now() - 60_000).toISOString(), current_price: 19.8, regular_price: 22, promo_price: 19.8, is_promo: true, promo_type: 'price_cut', availability: 'in_stock', tags: ['limited_time_deal'], tag_text: 'Limited time deal' },
      { listing_id: ids.creamMart, observed_at: known.at(8), current_price: 9, regular_price: 9, availability: 'in_stock', tags: ['best_seller'] },
    ];
    const res = ingestObservations(t.ctx, observations as never, { sourceMethod: 'manual', userId: 1 });
    assert.equal(res.inserted, 2, JSON.stringify(res.rejected));

    const own = brandRow(await get('/brand-explorer'), fx.ownBrandId);
    assert.deepEqual([own.tags, own.tag_counts, own.tagged_listings], [['limited_time_deal'], { limited_time_deal: 1 }, 1]);
    assert.equal(own.freshness.stale, 1, 'the cream at Test Mart is still stale');
    assert.equal(brandRow(await get('/brand-explorer'), fx.compBrandId).tags, undefined);

    const detail = await get(`/brand-explorer/${fx.ownBrandId}`);
    const oil = detail.range.find((r: any) => r.name.startsWith('Own Oil'));
    const cream = detail.range.find((r: any) => r.name.startsWith('Own Cream'));
    assert.deepEqual([oil.tags, oil.tagged_listings, cream.tags], [['limited_time_deal'], 1, undefined]);
    const column = (name: string) => detail.matrix.retailers.findIndex((r: any) => r.name === name);
    const oilRow = detail.matrix.rows.find((r: any) => r.name.startsWith('Own Oil'));
    const creamRow = detail.matrix.rows.find((r: any) => r.name.startsWith('Own Cream'));
    assert.deepEqual([oilRow.cells[column('Second Store')].tags, oilRow.cells[column('Second Store')].tag_text], [['limited_time_deal'], 'Limited time deal']);
    assert.equal(oilRow.cells[column('Test Mart')].tags, undefined);
    assert.deepEqual([creamRow.cells[column('Test Mart')].is_stale, creamRow.cells[column('Test Mart')].tags], [true, undefined], 'a stale badge is not a current badge');
  });
});
