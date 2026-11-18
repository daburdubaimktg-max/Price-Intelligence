/**
 * New products: listings that appear at a retailer after its baseline, the "new product" alert that a
 * collection run raises for them, and the recognition of a brand in the title of an unmatched listing.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { evaluateDiscovered } from '../server/services/alerts.ts';
import { brandWords, createBrandRecogniser, describeDiscovered } from '../server/services/analytics/new-listings.ts';
import { runRetailerNow } from '../server/services/collection/runner.ts';
import { retailerSecretName, setSecret } from '../server/services/core.ts';
import { flushNotifications } from '../server/services/notifications.ts';
import { nowIso } from '../server/lib/time.ts';
import type { NewListingPayload } from '../shared/api/alerts.ts';
import type { NewListingRow, NewListingsResponse } from '../shared/api/new-listings.ts';
import { ago, createFixture, createTestApp, type Fixture, type TestApp } from './helpers.ts';

let t: TestApp;
let origin: string;
let server: http.Server;
let dataset: unknown[] = [];
const hook = { url: '', requests: [] as Array<{ body: any }> };
let hookServer: http.Server;

before(async () => {
  t = await createTestApp();
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(dataset));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  hookServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hook.requests.push({ body: JSON.parse(raw || 'null') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
  hook.url = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hooks/abc`;
});
after(async () => {
  await flushNotifications(t.ctx);
  server.closeAllConnections();
  hookServer.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => hookServer.close(() => resolve()));
  await t.close();
});

const db = () => t.ctx.db;

function brand(name: string, ownership: 'own' | 'competitor'): number {
  const now = nowIso();
  return (
    db().get<{ id: number }>('SELECT id FROM brands WHERE name = ?', [name])?.id ??
    db().run('INSERT INTO brands (name, ownership, created_at, updated_at) VALUES (?, ?, ?, ?)', [name, ownership, now, now]).lastInsertRowid
  );
}

/** Every listing of the retailer was first seen `days` days ago: its first load lies in the past. */
function backdate(retailerId: number, days: number): void {
  const at = ago(days);
  db().run('UPDATE retailer_listings SET first_seen_at = ?, created_at = ? WHERE retailer_id = ?', [at, at, retailerId]);
}

let seq = 0;
function listing(retailerId: number, options: { title: string; seenAt: string; productId?: number | null; url?: string | null; status?: 'unmatched' | 'ignored' }): number {
  const id = `nl-${++seq}`;
  const productId = options.productId ?? null;
  return db().run(
    `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, first_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [retailerId, productId, id, options.url === undefined ? `https://shop.example/p/${id}` : options.url, options.title, productId ? 'matched' : (options.status ?? 'unmatched'), options.seenAt, options.seenAt, options.seenAt],
  ).lastInsertRowid;
}

function product(brandId: number, name: string, categoryId: number): number {
  const now = nowIso();
  return db().run(`INSERT INTO products (brand_id, name, category_id, pack_size, pack_unit, created_at, updated_at) VALUES (?, ?, ?, 100, 'ml', ?, ?)`, [brandId, name, categoryId, now, now]).lastInsertRowid;
}

async function list(query: string, as: 'admin' | 'viewer' = 'admin'): Promise<NewListingsResponse> {
  const res = await t.api('GET', `/new-listings${query}`, { as });
  assert.equal(res.status, 200, res.raw);
  return res.body as NewListingsResponse;
}
const titles = (rows: NewListingRow[]) => rows.map((r) => r.listing_title).sort();

describe('recognising a brand in a title', () => {
  const recognise = createBrandRecogniser([
    { id: 1, name: 'Dabur', ownership: 'own' },
    { id: 2, name: 'Dabur Amla', ownership: 'own' },
    { id: 3, name: 'Vatika', ownership: 'own' },
    { id: 4, name: 'Head & Shoulders', ownership: 'competitor' },
    { id: 5, name: 'L’Oréal', ownership: 'competitor' },
    { id: 6, name: 'Parachute', ownership: 'competitor' },
  ]);

  it('takes the longest brand name that appears as whole words', () => {
    assert.equal(recognise('Dabur Amla Hair Oil 200ml')?.brand_name, 'Dabur Amla');
    assert.equal(recognise('DABUR herbal toothpaste 150 g')?.brand_name, 'Dabur');
    assert.equal(recognise('Hair Oil by Dabur Amla, 300ml')?.brand_name, 'Dabur Amla');
    assert.deepEqual(recognise('Parachute Advansed Coconut Oil'), { brand_id: 6, brand_name: 'Parachute', ownership: 'competitor', basis: 'title' });
  });

  it('prefers the earlier name among equally long ones and ignores case, accents and "&" / "and"', () => {
    assert.equal(recognise('Head and Shoulders Classic Clean')?.brand_name, 'Head & Shoulders');
    assert.equal(recognise('HEAD&SHOULDERS 2in1')?.brand_name, 'Head & Shoulders');
    assert.equal(recognise('Head &amp; Shoulders Menthol 400ml')?.brand_name, 'Head & Shoulders');
    assert.equal(recognise("L'OREAL Elvive Shampoo")?.brand_name, 'L’Oréal');
    assert.deepEqual(brandWords('Head &amp; Shoulders — 2-in-1'), ['head', 'shoulders', '2', 'in', '1']);
  });

  it('needs whole words: part of a longer word is not a brand', () => {
    assert.equal(recognise('Vatikan City Travel Guide'), null);
    assert.equal(recognise('Parachutes for beginners'), null);
    assert.equal(recognise('Coconut hair oil 200ml'), null);
    assert.equal(recognise(null), null);
    assert.equal(recognise(''), null);
  });

  it('falls back to the page address when the title names no brand (for example an Arabic title)', () => {
    const guess = recognise('شامبو ضد القشرة ٤٠٠ مل', 'https://shop.example/en-ae/head-shoulders-smooth-silky-400ml/p/184225/');
    assert.deepEqual(guess, { brand_id: 4, brand_name: 'Head & Shoulders', ownership: 'competitor', basis: 'url' });
    assert.equal(recognise('شامبو', 'https://shop.example/dp/B07NY2VDKH'), null);
    assert.equal(recognise('Vatika Shampoo', 'https://shop.example/parachute-oil')?.basis, 'title', 'the title wins over the address');
    assert.equal(recognise('شامبو', 'not a url'), null);
  });
});

describe('GET /api/new-listings', () => {
  let a: Fixture; // "Launch Mart": first load 10 days ago
  let b: Fixture; // "Other Mart": first load 10 days ago
  let rivalBrand: number;
  let ownBrand: number;
  let newBrand: number;

  before(() => {
    a = createFixture(t.ctx, { retailerName: 'Launch Mart', method: 'third_party' });
    b = createFixture(t.ctx, { retailerName: 'Other Mart' });
    rivalBrand = a.compBrandId;
    ownBrand = a.ownBrandId;
    newBrand = brand('Newbrand', 'competitor');
    db().run('UPDATE retailers SET connector_config = ? WHERE id = ?', [JSON.stringify({ discover_listings: true }), a.retailerId]);
    backdate(a.retailerId, 10);
    backdate(b.retailerId, 10);

    // unmatched, brand named in the title, long after the first load → a new product
    listing(a.retailerId, { title: 'Test Rival Coconut Oil 500ml', seenAt: ago(2) });
    // matched to a product that Other Mart has listed since its first load → new at this retailer only
    listing(a.retailerId, { title: 'Rival Oil 300ml at Launch Mart', seenAt: ago(1), productId: b.compProductId });
    // a product that appears at both retailers within the period → a new product at both
    const launched = product(ownBrand, 'Own Serum 100ml', a.categoryId);
    listing(a.retailerId, { title: 'Own Serum 100ml (Launch Mart)', seenAt: ago(1), productId: launched });
    listing(b.retailerId, { title: 'Own Serum 100ml (Other Mart)', seenAt: ago(0, 12), productId: launched });
    // the 48-hour rule, measured from the first listing of the retailer (10 days ago)
    listing(a.retailerId, { title: 'Mystery Item inside the baseline', seenAt: ago(8, 1) }); // 47 h after the first load
    listing(a.retailerId, { title: 'Mystery Item after the baseline', seenAt: ago(7, 23) }); // 49 h after the first load
    // a brand that this retailer never carried: its first sightings are that brand's baseline …
    listing(a.retailerId, { title: 'Newbrand Shampoo 200ml', seenAt: ago(3) });
    listing(a.retailerId, { title: 'Newbrand Shampoo 400ml', seenAt: ago(3) });
    listing(a.retailerId, { title: 'Newbrand Conditioner 200ml', seenAt: ago(2, 12) });
    // … and only what follows more than 48 hours later is new
    listing(a.retailerId, { title: 'Newbrand Hair Mask 250ml', seenAt: ago(0, 6) });
    // reviewed and set aside
    listing(a.retailerId, { title: 'Test Rival Unrelated Accessory', seenAt: ago(1), status: 'ignored' });
  });

  it('lists what was first seen after the baseline of its retailer and of its brand there', async () => {
    const res = await list(`?days=30&retailer_id=${a.retailerId},${b.retailerId}`);
    assert.deepEqual(titles(res.rows), [
      'Mystery Item after the baseline',
      'Newbrand Hair Mask 250ml',
      'Own Serum 100ml (Launch Mart)',
      'Own Serum 100ml (Other Mart)',
      'Rival Oil 300ml at Launch Mart',
      'Test Rival Coconut Oil 500ml',
    ]);
    assert.equal(res.baseline_hours, 48);
    assert.equal(res.period.days, 30);
    // newest first
    assert.equal(res.rows[0]!.listing_title, 'Newbrand Hair Mask 250ml');
    assert.ok(res.rows.every((r, i) => i === 0 || res.rows[i - 1]!.first_seen_at >= r.first_seen_at));
  });

  it('keeps a new product apart from a product that is only new at one retailer', async () => {
    const res = await list(`?days=30&retailer_id=${a.retailerId},${b.retailerId}`);
    const byTitle = Object.fromEntries(res.rows.map((r) => [r.listing_title, r]));

    const unmatched = byTitle['Test Rival Coconut Oil 500ml']!;
    assert.equal(unmatched.kind, 'new_product');
    assert.equal(unmatched.review_state, 'needs_review');
    assert.equal(unmatched.product_id, null);
    assert.deepEqual([unmatched.brand_id, unmatched.brand_name, unmatched.ownership, unmatched.brand_basis], [rivalBrand, 'Test Rival', 'competitor', 'title']);
    assert.equal(unmatched.first_price, null, 'no observation yet: no price is invented');

    const moved = byTitle['Rival Oil 300ml at Launch Mart']!;
    assert.equal(moved.kind, 'new_at_retailer');
    assert.equal(moved.review_state, 'matched');
    assert.equal(moved.brand_basis, 'product');
    assert.deepEqual(moved.listed_before_at, ['Other Mart (AE)']);
    assert.equal(moved.listed_before_count, 1);

    for (const title of ['Own Serum 100ml (Launch Mart)', 'Own Serum 100ml (Other Mart)']) {
      assert.equal(byTitle[title]!.kind, 'new_product', 'every other listing of the product is just as new');
      assert.deepEqual(byTitle[title]!.listed_before_at, []);
      assert.equal(byTitle[title]!.ownership, 'own');
    }
    assert.equal(byTitle['Mystery Item after the baseline']!.brand_id, null);
    assert.equal(byTitle['Mystery Item after the baseline']!.brand_basis, null);

    assert.equal(res.summary.total, 6);
    assert.equal(res.summary.new_products, 5);
    assert.equal(res.summary.new_at_retailer, 1);
    assert.equal(res.summary.needs_review, 3);
    assert.equal(res.summary.own, 2);
    assert.equal(res.summary.competitor, 3);
    assert.equal(res.summary.unrecognised, 1);
    assert.equal(res.summary.ignored, 1);
    assert.equal(res.summary.demo.any_demo, false);
    const rival = res.summary.by_brand.find((x) => x.brand_id === rivalBrand)!;
    assert.deepEqual([rival.count, rival.new_products, rival.new_at_retailer, rival.recognised], [2, 1, 1, 1]);
    assert.equal(res.summary.by_brand.find((x) => x.brand_id === null)!.brand_name, 'Brand not recognised');
    assert.deepEqual(
      res.summary.by_retailer.map((r) => [r.retailer_name, r.count]),
      [
        ['Launch Mart', 5],
        ['Other Mart', 1],
      ],
    );
  });

  it('reports first loads inside the period as baselines, not as launches', async () => {
    const res = await list(`?days=30&retailer_id=${a.retailerId},${b.retailerId}`);
    const retailerLoads = res.baselines.filter((x) => x.scope === 'retailer');
    assert.deepEqual(retailerLoads.map((x) => [x.retailer_name, x.listings]).sort(), [
      ['Launch Mart', 3], // the two fixture listings and the item seen 47 hours later
      ['Other Mart', 2],
    ]);
    const brandLoads = res.baselines.filter((x) => x.scope === 'brand');
    assert.equal(brandLoads.length, 1);
    assert.deepEqual([brandLoads[0]!.retailer_name, brandLoads[0]!.brand_name, brandLoads[0]!.brand_id, brandLoads[0]!.listings], ['Launch Mart', 'Newbrand', newBrand, 3]);
    assert.equal(Date.parse(brandLoads[0]!.ends_at) - Date.parse(brandLoads[0]!.started_at), 48 * 3_600_000);

    // a shorter period no longer contains the first loads of the two retailers
    const week = await list(`?days=7&retailer_id=${a.retailerId},${b.retailerId}`);
    assert.equal(week.baselines.filter((x) => x.scope === 'retailer').length, 0);
    assert.ok(!titles(week.rows).includes('Mystery Item after the baseline'), 'first seen almost eight days ago');
    assert.equal(week.rows.length, 5);
    assert.equal(week.series.bucket, 'day');
  });

  it('says for every source whether it can find unknown products', async () => {
    const res = await list(`?days=30&retailer_id=${a.retailerId},${b.retailerId}`);
    assert.deepEqual(
      res.sources.map((s) => [s.retailer_name, s.collection_method, s.discovery]),
      [
        ['Launch Mart', 'third_party', 'on'],
        ['Other Mart', 'manual', 'not_supported'],
      ],
    );
    assert.ok(res.sources.every((s) => s.baseline_started_at !== null && Date.parse(s.baseline_ends_at!) - Date.parse(s.baseline_started_at!) === 48 * 3_600_000));
    db().run('UPDATE retailers SET connector_config = ? WHERE id = ?', ['{}', a.retailerId]);
    assert.equal((await list(`?retailer_id=${a.retailerId}`)).sources[0]!.discovery, 'off');
    db().run('UPDATE retailers SET connector_config = ? WHERE id = ?', [JSON.stringify({ discover_listings: true }), a.retailerId]);
  });

  it('filters by brand (also a recognised one), ownership, kind, search and review state', async () => {
    const scope = `retailer_id=${a.retailerId},${b.retailerId}&days=30`;
    assert.deepEqual(titles((await list(`?${scope}&brand_id=${rivalBrand}`)).rows), ['Rival Oil 300ml at Launch Mart', 'Test Rival Coconut Oil 500ml']);
    assert.deepEqual(titles((await list(`?${scope}&brand_id=${newBrand}`)).rows), ['Newbrand Hair Mask 250ml']);
    assert.deepEqual(titles((await list(`?${scope}&ownership=own`)).rows), ['Own Serum 100ml (Launch Mart)', 'Own Serum 100ml (Other Mart)']);
    assert.deepEqual(titles((await list(`?days=30&q=serum&retailer_id=${b.retailerId}`)).rows), ['Own Serum 100ml (Other Mart)']);
    assert.deepEqual(titles((await list(`?${scope}&q=SERUM`)).rows), ['Own Serum 100ml (Launch Mart)', 'Own Serum 100ml (Other Mart)']);

    const onlyMoved = await list(`?${scope}&kind=new_at_retailer`);
    assert.deepEqual(titles(onlyMoved.rows), ['Rival Oil 300ml at Launch Mart']);
    assert.equal(onlyMoved.total, 1);
    assert.equal(onlyMoved.summary.new_products, 5, 'the kinds keep their numbers while one of them is selected');
    assert.equal(onlyMoved.summary.total, 6);

    const withIgnored = await list(`?${scope}&include_ignored=true`);
    assert.equal(withIgnored.rows.length, 7);
    assert.equal(withIgnored.rows.find((r) => r.listing_title === 'Test Rival Unrelated Accessory')!.review_state, 'ignored');

    const sorted = await list(`?${scope}&sort=brand`);
    assert.deepEqual(sorted.rows.map((r) => r.brand_name), ['Newbrand', 'Test Own', 'Test Own', 'Test Rival', 'Test Rival', null]);
    const paged = await list(`?${scope}&page_size=2&page=2`);
    assert.deepEqual([paged.rows.length, paged.total, paged.pages, paged.page], [2, 6, 3, 2]);
  });

  it('counts the new listings per week by brand, own brands first', async () => {
    const res = await list(`?days=30&retailer_id=${a.retailerId},${b.retailerId}`);
    assert.equal(res.series.bucket, 'week');
    assert.ok(res.series.starts.length >= 5 && res.series.starts.length <= 6);
    assert.ok(res.series.starts.every((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1), 'weeks start on Monday');
    assert.deepEqual(res.series.brands.map((x) => x.brand_name), ['Test Own', 'Test Rival', 'Newbrand']);
    const total = (counts: number[]) => counts.reduce((x, y) => x + y, 0);
    assert.deepEqual(res.series.brands.map((x) => total(x.counts)), [2, 2, 1]);
    assert.equal(total(res.series.unrecognised), 1);
    assert.equal(total(res.series.other), 0);
    assert.equal(total(res.series.brands.flatMap((x) => x.counts)) + total(res.series.unrecognised) + total(res.series.other), res.total);
  });

  it('is readable by every signed-in role and checks its parameters', async () => {
    assert.equal((await list(`?retailer_id=${a.retailerId}`, 'viewer')).summary.total, 5);
    assert.equal((await t.api('GET', '/new-listings', { as: null })).status, 401);
    assert.equal((await t.api('GET', '/new-listings?days=14')).status, 400);
    assert.equal((await t.api('GET', '/new-listings?kind=launch')).status, 400);
    assert.equal((await t.api('GET', '/new-listings?ownership=theirs')).status, 400);
  });

  it('shows nothing as new while every listing belongs to a first load', async () => {
    const fresh = createFixture(t.ctx, { retailerName: 'Brand New Mart' });
    listing(fresh.retailerId, { title: 'Test Rival Something', seenAt: nowIso() });
    const res = await list(`?retailer_id=${fresh.retailerId}`);
    assert.equal(res.total, 0);
    assert.equal(res.summary.total, 0);
    assert.deepEqual(res.baselines.map((x) => [x.scope, x.listings]), [['retailer', 3]]);
  });
});

describe('the "new product" alert of a collection run', () => {
  let s: Fixture;
  let marketName: string;
  let freshBrand: number;
  const config = () => ({
    mode: 'bulk',
    format: 'json',
    url: `${origin}/feed`,
    auth: { type: 'bearer' },
    match: { listing_key: 'external_id', field: 'sku' },
    fields: { current_price: 'price', title: 'name', url: 'link', item_id: 'sku' },
    discover_listings: true,
  });
  const item = (sku: string, name: string, price: number | null = 12.5) => ({ sku, name, price, link: `https://feed.example/p/${sku}` });
  const known = () => [item('own-oil-200', 'Own Oil 200ml', 20), item('rival-oil-300', 'Rival Oil 300ml', 30)];
  const run = () => runRetailerNow(t.ctx, s.retailerId, { trigger: 'manual' });
  const alerts = () =>
    db()
      .all<{ id: number; rule_id: number; type: string; severity: string; title: string; message: string; payload: string; retailer_id: number; market_id: number; job_id: number; listing_id: number | null; is_demo: number }>(
        `SELECT * FROM alerts WHERE type = 'new_listing' AND retailer_id = ? ORDER BY id`,
        [s.retailerId],
      )
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) as NewListingPayload }));
  const defaultRule = () => db().get<{ id: number }>(`SELECT id FROM alert_rules WHERE type = 'new_listing' ORDER BY id LIMIT 1`)!.id;

  before(() => {
    s = createFixture(t.ctx, { retailerName: 'Feed Mart', method: 'third_party' });
    db().run('UPDATE retailers SET connector_config = ?, rate_limit_ms = 250, next_run_at = NULL WHERE id = ?', [JSON.stringify(config()), s.retailerId]);
    setSecret(t.ctx, retailerSecretName(s.retailerId), 'provider-token');
    marketName = db().get<{ name: string }>('SELECT name FROM markets WHERE id = ?', [s.marketId])!.name;
    freshBrand = brand('Freshbrand', 'competitor');
  });

  it('ships with a default rule: in-app, informational, from one new listing', () => {
    const rule = db().get<{ name: string; severity: string; threshold_count: number; is_enabled: number; channels: string }>(
      `SELECT name, severity, threshold_count, is_enabled, channels FROM alert_rules WHERE type = 'new_listing'`,
    )!;
    assert.deepEqual({ ...rule }, { name: 'New products found at a retailer', severity: 'info', threshold_count: 1, is_enabled: 1, channels: '["in_app"]' });
  });

  it('does not alert for the first load of a retailer', async () => {
    dataset = [...known(), item('first-1', 'Test Rival Almond Oil 100ml'), item('first-2', 'Mystery Lotion')];
    const job = await run();
    assert.equal(job.status, 'succeeded', JSON.stringify(job));
    assert.equal(db().scalar<number>(`SELECT COUNT(*) FROM retailer_listings WHERE retailer_id = ? AND match_status = 'unmatched'`, [s.retailerId]), 2, 'the items are stored for review');
    assert.equal(alerts().length, 0);
    const facts = describeDiscovered(t.ctx, s.retailerId, db().all<{ id: number }>('SELECT id FROM retailer_listings WHERE retailer_id = ?', [s.retailerId]).map((r) => r.id));
    assert.deepEqual([facts.fresh.length, facts.baseline.retailer], [0, 4]);
  });

  it('raises one alert per run with the retailer, the count, the recognised brands and the first titles', async () => {
    backdate(s.retailerId, 5);
    dataset = [...dataset, item('new-1', 'Test Rival Argan Oil 250ml', 18), item('new-2', 'Test Rival Argan Oil 500ml', 31.5), item('new-3', 'Mystery Hair Tonic', null)];
    const job = await run();
    assert.equal(job.status, 'succeeded');
    const [alert, ...rest] = alerts();
    assert.equal(rest.length, 0, 'exactly one alert for the run');
    assert.equal(alert!.title, `3 new products found at Feed Mart (${marketName})`);
    assert.equal(alert!.severity, 'info');
    assert.equal(alert!.rule_id, defaultRule());
    assert.deepEqual([alert!.retailer_id, alert!.market_id, alert!.job_id, alert!.listing_id, alert!.is_demo], [s.retailerId, s.marketId, job.id, null, 0]);
    assert.equal(
      alert!.message,
      `Collection run #${job.id} found 3 listings at Feed Mart, ${marketName} that were not there before — by the brand named in the title: Test Rival 2, brand not recognised 1. ` +
        'Titles: “Test Rival Argan Oil 250ml”, “Test Rival Argan Oil 500ml”, “Mystery Hair Tonic”. ' +
        'They are stored as unmatched and nothing is matched automatically: review them under New Products.',
    );
    const p = alert!.payload;
    assert.deepEqual([p.count, p.threshold, p.retailer_id, p.retailer_name, p.market_code, p.job_id, p.unrecognised, p.baseline_skipped], [3, 1, s.retailerId, 'Feed Mart', 'AE', job.id, 1, 0]);
    assert.deepEqual(p.brands, [{ brand_id: s.compBrandId, brand_name: 'Test Rival', ownership: 'competitor', count: 2 }]);
    assert.deepEqual(p.titles, ['Test Rival Argan Oil 250ml', 'Test Rival Argan Oil 500ml', 'Mystery Hair Tonic']);
    assert.equal(p.listing_ids.length, 3);
    assert.equal(p.link, `/new-products?retailer_id=${s.retailerId}&days=7`);

    // the same listings are what the New Products page shows for this retailer
    const page = await list(`?retailer_id=${s.retailerId}&days=7`);
    assert.deepEqual(page.rows.map((r) => r.listing_id).sort(), [...p.listing_ids].sort());
    const priced = page.rows.find((r) => r.listing_title === 'Test Rival Argan Oil 500ml')!;
    assert.deepEqual([priced.first_price, priced.currency_code, priced.kind, priced.review_state], [31.5, 'AED', 'new_product', 'needs_review']);
    assert.equal(page.rows.find((r) => r.listing_title === 'Mystery Hair Tonic')!.first_price, null);
  });

  it('stays silent when a later run finds nothing new', async () => {
    const job = await run();
    // "partial": the item without a price is a known listing by now and its reading fails — that is not a discovery
    assert.equal(job.status, 'partial');
    assert.equal(alerts().length, 1);
  });

  it('treats the first sightings of a brand at a retailer as that brand’s baseline', async () => {
    dataset = [...dataset, item('fb-1', 'Freshbrand Shampoo 200ml'), item('fb-2', 'Freshbrand Shampoo 400ml'), item('fb-3', 'Freshbrand Mask'), item('new-4', 'Test Rival Castor Oil 100ml')];
    const job = await run();
    const latest = alerts().at(-1)!;
    assert.equal(alerts().length, 2);
    assert.equal(latest.job_id, job.id);
    assert.equal(latest.title, `1 new product found at Feed Mart (${marketName})`);
    assert.equal(latest.payload.count, 1);
    assert.equal(latest.payload.baseline_skipped, 3);
    assert.match(latest.message, /found 1 listing at Feed Mart, .* that was not there before — by the brand named in the title: Test Rival 1\. Title: “Test Rival Castor Oil 100ml”\. It is stored as unmatched/);
    assert.match(latest.message, /3 more listings of this run belong to a first load and are not counted\.$/);
    const page = await list(`?retailer_id=${s.retailerId}&days=7`);
    assert.ok(!page.rows.some((r) => r.brand_id === freshBrand));
    assert.deepEqual(page.baselines.filter((x) => x.scope === 'brand').map((x) => [x.brand_name, x.listings]), [['Freshbrand', 3]]);
  });

  it('honours a rule’s brand scope and minimum, and delivers through the configured channels', async () => {
    const created = await t.api('POST', '/alert-rules', {
      body: { name: 'Three or more new Test Rival products', type: 'new_listing', brand_id: s.compBrandId, threshold_count: 3, severity: 'warning', channels: ['in_app', 'webhook', 'email'] },
    });
    assert.equal(created.status, 201, created.raw);
    const ruleId = created.body.id as number;
    const put = await t.api('PUT', '/integrations/webhook', { body: { url: hook.url } });
    assert.equal(put.status, 200, put.raw);
    const ofRule = () => alerts().filter((x) => x.rule_id === ruleId);

    dataset = [...dataset, item('new-5', 'Test Rival Onion Oil'), item('new-6', 'Test Rival Sesame Oil'), item('new-7', 'Mystery Cream')];
    await run();
    assert.equal(ofRule().length, 0, 'two Test Rival listings are below the minimum of three');
    assert.equal(alerts().at(-1)!.payload.count, 3, 'the default rule counts all three');

    dataset = [...dataset, item('new-8', 'Test Rival Oil A'), item('new-9', 'Test Rival Oil B'), item('new-10', 'Test Rival Oil C'), item('new-11', 'Mystery Soap')];
    hook.requests.length = 0;
    const job = await run();
    const [scoped] = ofRule();
    assert.equal(ofRule().length, 1);
    assert.equal(scoped!.severity, 'warning');
    assert.equal(scoped!.payload.count, 3, 'only the listings of the rule’s brand are counted');
    assert.equal(scoped!.payload.unrecognised, 0);
    assert.equal(scoped!.payload.threshold, 3);

    await flushNotifications(t.ctx);
    const notifications = db().all<{ channel: string; status: string; error: string | null }>('SELECT channel, status, error FROM alert_notifications WHERE alert_id = ? ORDER BY id', [scoped!.id]);
    assert.deepEqual(notifications.map((n) => [n.channel, n.status]), [
      ['in_app', 'delivered'],
      ['webhook', 'delivered'],
      ['email', 'not_configured'],
    ]);
    assert.equal(hook.requests.length, 1, 'one webhook call for the run');
    const sent = hook.requests[0]!.body;
    const delivered = sent.alerts.find((x: any) => x.id === scoped!.id);
    assert.equal(delivered.type, 'new_listing');
    assert.equal(delivered.retailer, 'Feed Mart');
    assert.equal(delivered.title, `3 new products found at Feed Mart (${marketName})`);
    assert.equal(delivered.details.count, 3);
    assert.equal(delivered.details.job_id, job.id);

    // the alert is listed in the Alerts Centre like any other
    const listed = await t.api('GET', `/alerts?type=new_listing&retailer_id=${s.retailerId}`);
    assert.equal(listed.status, 200, listed.raw);
    assert.ok(listed.body.rows.some((row: any) => row.id === scoped!.id && row.retailer_name === 'Feed Mart' && row.payload.count === 3));
  });

  it('never alerts for demo or simulated sources, or without new listings', () => {
    const ids = db().all<{ id: number }>(`SELECT id FROM retailer_listings WHERE retailer_id = ? AND match_status = 'unmatched'`, [s.retailerId]).map((r) => r.id);
    const before = alerts().length;
    assert.equal(evaluateDiscovered(t.ctx, { jobId: 999_001, retailerId: s.retailerId, listingIds: ids, sourceMethod: 'third_party', isDemo: true }), 0);
    assert.equal(evaluateDiscovered(t.ctx, { jobId: 999_002, retailerId: s.retailerId, listingIds: ids, sourceMethod: 'simulated', isDemo: false }), 0);
    assert.equal(evaluateDiscovered(t.ctx, { jobId: 999_003, retailerId: s.retailerId, listingIds: [], sourceMethod: 'third_party', isDemo: false }), 0);
    assert.equal(alerts().length, before);
  });

  it('accepts only the scopes and thresholds that make sense for the rule', async () => {
    const base = { name: 'x', type: 'new_listing' };
    assert.equal((await t.api('POST', '/alert-rules', { body: { ...base, category_id: s.categoryId } })).status, 422);
    assert.equal((await t.api('POST', '/alert-rules', { body: { ...base, product_id: s.ownProductId } })).status, 422);
    assert.equal((await t.api('POST', '/alert-rules', { body: { ...base, threshold_pct: 10 } })).status, 422);
    assert.equal((await t.api('POST', '/alert-rules', { body: { ...base, threshold_count: 0 } })).status, 422);
    const ok = await t.api('POST', '/alert-rules', { body: { ...base, name: 'New at Feed Mart', retailer_id: s.retailerId } });
    assert.equal(ok.status, 201, ok.raw);
    assert.equal(ok.body.threshold_count, 1, 'the minimum defaults to one');
  });
});
