/**
 * Provider snapshots through the structured connector: tags, badges, ratings, rank and seller travel with the
 * price, alternative fields are understood, and a snapshot is dated by the provider's own timestamp so that
 * reading it twice adds nothing.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setSecret, retailerSecretName } from '../server/services/core.ts';
import { runRetailerNow } from '../server/services/collection/runner.ts';
import { describeConnectors } from '../server/services/collection/registry.ts';
import { readField, readStructuredConfig } from '../server/services/collection/structured.ts';
import { ago, createFixture, createTestApp, type Fixture, type TestApp } from './helpers.ts';

let t: TestApp;
let origin: string;
let server: http.Server;
let dataset: unknown[] = [];
let requests = 0;
let seq = 0;

before(async () => {
  t = await createTestApp();
  server = http.createServer((req, res) => {
    requests++;
    if (req.headers.authorization !== 'Bearer provider-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorised"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(dataset));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.close();
});
beforeEach(() => {
  requests = 0;
});

const db = () => t.ctx.db;

/** The mapping of the "marketplace listings with badges" template, pointed at the fixture. */
const marketplaceConfig = (overrides: Record<string, unknown> = {}) => ({
  mode: 'bulk',
  format: 'json',
  url: `${origin}/datasets/last`,
  auth: { type: 'bearer' },
  match: { listing_key: 'external_id', field: 'sku' },
  fields: {
    current_price: 'sale_price || price',
    regular_price: 'price',
    availability: 'is_buyable',
    currency: 'currency',
    title: 'name',
    url: 'productUrl',
    item_id: 'sku',
    source_timestamp: '_scrapedAt',
    rating: 'product_rating.value',
    review_count: 'product_rating.count',
    sales_rank: 'best_seller_rank',
    seller_name: 'store_name',
  },
  tags: ['deal_tag.text', 'nudges'],
  flag_tags: { is_bestseller: 'Best seller' },
  observed_time: 'source',
  ...overrides,
});

function source(config: Record<string, unknown>): Fixture {
  const f = createFixture(t.ctx, { retailerName: `Provider ${++seq}`, method: 'third_party' });
  db().run('UPDATE retailers SET connector_config = ?, rate_limit_ms = 250, next_run_at = NULL WHERE id = ?', [JSON.stringify(config), f.retailerId]);
  setSecret(t.ctx, retailerSecretName(f.retailerId), 'provider-token');
  return f;
}

const run = (retailerId: number) => runRetailerNow(t.ctx, retailerId, { trigger: 'manual' });
const observations = (retailerId: number) =>
  db().all<Record<string, any>>(
    `SELECT o.*, l.external_id FROM price_observations o JOIN retailer_listings l ON l.id = o.listing_id WHERE o.retailer_id = ? ORDER BY l.external_id, o.id`,
    [retailerId],
  );

const scrapedAt = ago(0, 2);

const items = () => [
  {
    sku: 'own-oil-200', name: 'Own Oil 200ml', price: 20, sale_price: 15, currency: 'AED', is_buyable: true, productUrl: 'https://market.example/p/own-oil-200',
    _scrapedAt: scrapedAt, is_bestseller: true, best_seller_rank: '#14',
    product_rating: { value: 4.6, count: 1280 }, store_name: 'Market Grocery',
    deal_tag: { text: 'Early Yellow Friday Deal ⏳' },
    nudges: [{ text: 'Lowest price in 30 days' }, { text: '#3 in Hair Oils' }, { text: 'Selling out fast' }],
  },
  {
    sku: 'rival-oil-300', name: 'Rival Oil 300ml', price: 30, sale_price: null, currency: 'AED', is_buyable: false, productUrl: 'https://market.example/p/rival-oil-300',
    _scrapedAt: scrapedAt, is_bestseller: false, best_seller_rank: null, product_rating: { value: 0, count: 0 }, store_name: 'Seller Two', deal_tag: null, nudges: [],
  },
];

describe('alternative fields', () => {
  it('uses the first alternative that has a value', () => {
    assert.equal(readField({ sale_price: 15, price: 20 }, 'sale_price || price'), 15);
    assert.equal(readField({ sale_price: null, price: 20 }, 'sale_price || price'), 20);
    assert.equal(readField({ sale_price: '', price: 20 }, 'sale_price||price'), 20);
    assert.equal(readField({ a: { b: 0 } }, 'missing || a.b'), 0);
    assert.equal(readField({ price: 20 }, 'x || y'), undefined);
    assert.equal(readField({ price: 20 }, null), undefined);
  });
});

describe('provider snapshots with tags and signals', () => {
  it('stores tags, badges, rank, rating, reviews and seller with the price, dated by the provider', async () => {
    dataset = items();
    const s = source(marketplaceConfig());
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    const [own, rival] = observations(s.retailerId);

    assert.equal(own!.current_price, 15);
    assert.equal(own!.regular_price, 20);
    assert.equal(own!.is_promo, 1);
    assert.equal(own!.discount_pct, 25);
    assert.equal(own!.availability, 'in_stock');
    assert.equal(own!.source_method, 'third_party');
    // dated when the provider saw the price, not when it was read
    assert.equal(own!.observed_at, new Date(scrapedAt).toISOString());
    assert.equal(own!.source_timestamp, new Date(scrapedAt).toISOString());
    assert.ok(own!.collected_at > own!.observed_at);

    const tags = JSON.parse(own!.tags) as string[];
    assert.ok(tags.includes('event_deal'), `tags: ${own!.tags}`);
    assert.ok(tags.includes('best_seller'));
    assert.ok(!tags.includes('other'));
    // the retailer's own wording is kept, without the emoji; the rank wording is not a tag
    assert.equal(own!.tag_text, 'Early Yellow Friday Deal · Lowest price in 30 days · Selling out fast · Best seller');
    assert.equal(own!.sales_rank, 14);
    assert.equal(own!.sales_rank_label, '#3 in Hair Oils');
    assert.equal(own!.rating, 4.6);
    assert.equal(own!.review_count, 1280);
    assert.equal(own!.seller_name, 'Market Grocery');

    // no sale price: the list price is what the shopper pays, and nothing is invented
    assert.equal(rival!.current_price, 30);
    assert.equal(rival!.regular_price, 30);
    assert.equal(rival!.is_promo, 0);
    assert.equal(rival!.availability, 'out_of_stock');
    assert.equal(rival!.tags, '[]');
    assert.equal(rival!.tag_text, null);
    assert.equal(rival!.sales_rank, null);
    assert.equal(rival!.seller_name, 'Seller Two');
    // a rating of 0 with no reviews means "not rated", not a zero-star product
    assert.equal(rival!.rating, null);
    assert.equal(rival!.review_count, 0);
  });

  it('reading the same snapshot again adds nothing; a new snapshot adds a new observation', async () => {
    dataset = items();
    const s = source(marketplaceConfig());
    assert.equal((await run(s.retailerId)).status, 'succeeded');
    const second = await run(s.retailerId);
    assert.equal(second.status, 'succeeded');
    assert.equal(second.observations_created, 0);
    assert.equal(second.duplicates_skipped, 2);
    assert.equal(observations(s.retailerId).length, 2);

    const later = new Date(Date.parse(scrapedAt) + 60 * 60 * 1000).toISOString();
    dataset = items().map((item) => ({ ...item, _scrapedAt: later, sale_price: item.sku === 'own-oil-200' ? 14 : null, deal_tag: null, nudges: [] }));
    const third = await run(s.retailerId);
    assert.equal(third.observations_created, 2);
    const history = observations(s.retailerId).filter((o) => o.external_id === 'own-oil-200');
    assert.deepEqual(history.map((o) => o.current_price), [15, 14]);
    // the tag is history too: it stays with the earlier observation and is gone from the later one
    assert.ok(JSON.parse(history[0]!.tags).includes('event_deal'));
    assert.deepEqual(JSON.parse(history[1]!.tags), ['best_seller']);
  });

  it('dates an item by the time it was read when its own timestamp is missing or in the future', async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    dataset = [
      { ...items()[0]!, _scrapedAt: undefined },
      { ...items()[1]!, _scrapedAt: future },
    ];
    const s = source(marketplaceConfig());
    const before = Date.now();
    assert.equal((await run(s.retailerId)).status, 'succeeded');
    for (const o of observations(s.retailerId)) {
      const observed = Date.parse(o.observed_at);
      assert.ok(observed >= before - 1000 && observed <= Date.now() + 1000, `${o.external_id} observed at ${o.observed_at}`);
    }
  });

  it('adds unknown items as unmatched listings that carry their tags', async () => {
    dataset = [
      ...items(),
      { sku: 'new-shampoo-400', name: 'New Shampoo 400ml', price: 12, currency: 'AED', is_buyable: true, _scrapedAt: scrapedAt, deal_tag: { text: 'Deal' }, nudges: [{ text: 'Buy 2 get 1 free' }], store_name: 'Seller Three' },
    ];
    const s = source(marketplaceConfig({ discover_listings: true }));
    assert.equal((await run(s.retailerId)).status, 'succeeded');
    const found = db().get<Record<string, any>>(
      `SELECT l.match_status, l.product_id, l.title, o.tags, o.tag_text, o.seller_name FROM retailer_listings l JOIN price_observations o ON o.listing_id = l.id
       WHERE l.retailer_id = ? AND l.external_id = 'new-shampoo-400'`,
      [s.retailerId],
    )!;
    assert.deepEqual([found.match_status, found.product_id, found.title], ['unmatched', null, 'New Shampoo 400ml']);
    assert.deepEqual(JSON.parse(found.tags), ['multi_buy']);
    assert.equal(found.tag_text, 'Deal · Buy 2 get 1 free');
    assert.equal(found.seller_name, 'Seller Three');
  });

  it('reads tags given as plain texts and lists, and badges given as yes/no words', async () => {
    dataset = [
      { ...items()[0]!, deal_tag: undefined, nudges: undefined, badge: 'Limited time deal', labels: ['Extra 10% off', "Amazon's Choice"], is_bestseller: 'no', choice: 'Yes', best_seller_rank: 7, product_rating: { value: '4,5 out of 5', count: '1.2K' } },
      items()[1]!,
    ];
    const s = source(marketplaceConfig({ tags: ['badge', 'labels'], flag_tags: { is_bestseller: 'Best seller', choice: 'Retailer choice' } }));
    assert.equal((await run(s.retailerId)).status, 'succeeded');
    const own = observations(s.retailerId)[0]!;
    assert.deepEqual(JSON.parse(own.tags), ['limited_time_deal', 'coupon', 'retailer_choice']);
    assert.equal(own.tag_text, "Limited time deal · Extra 10% off · Amazon's Choice · Retailer choice");
    assert.deepEqual([own.sales_rank, own.sales_rank_label, own.rating, own.review_count], [7, null, 4.5, 1200]);
  });

  it('leaves out wording that only states a price cut, and a "list price" below the selling price', async () => {
    dataset = [
      { ...items()[0]!, deal_tag: undefined, nudges: undefined, is_bestseller: false, promoMessages: ['Save 44%', 'Buy 3 For 27.38 AED'], price: 15, sale_price: null, list: 4.2 },
      items()[1]!,
    ];
    const config = marketplaceConfig({ tags: ['promoMessages'] });
    (config.fields as Record<string, unknown>).regular_price = 'list';
    (config.fields as Record<string, unknown>).promo_description = 'promoMessages';
    const s = source(config);
    assert.equal((await run(s.retailerId)).status, 'succeeded');
    const own = observations(s.retailerId)[0]!;
    assert.deepEqual(JSON.parse(own.tags), ['multi_buy']);
    assert.equal(own.tag_text, 'Buy 3 For 27.38 AED');
    assert.equal(own.current_price, 15);
    assert.equal(own.regular_price, null);
  });

  it('does not store a list price that is more than ten times the selling price, and says so on the observation', async () => {
    dataset = [
      { ...items()[0]!, price: 2552, sale_price: 25.52 }, // a lost decimal point at the source
      { ...items()[1]!, price: 100, sale_price: 24.5 }, // a steep but possible "was" price is kept as shown
    ];
    const s = source(marketplaceConfig());
    assert.equal((await run(s.retailerId)).status, 'succeeded');
    const [own, rival] = observations(s.retailerId);
    assert.deepEqual([own!.current_price, own!.regular_price, own!.is_promo, own!.discount_pct], [25.52, null, 0, null]);
    assert.match(own!.note, /list price \(2552\) is more than 10 times/);
    assert.deepEqual([rival!.current_price, rival!.regular_price, rival!.is_promo, rival!.discount_pct], [24.5, 100, 1, 75.5]);
    assert.equal(rival!.note, null);
  });

  it('a mapping without tag fields stores no tags, and observations stay dated by the read time by default', async () => {
    dataset = items();
    const s = source(marketplaceConfig({ tags: undefined, flag_tags: undefined, observed_time: undefined }));
    const before = Date.now();
    assert.equal((await run(s.retailerId)).status, 'succeeded');
    const own = observations(s.retailerId)[0]!;
    assert.equal(own.tags, '[]');
    assert.equal(own.tag_text, null);
    assert.ok(Date.parse(own.observed_at) >= before - 1000);
    assert.equal(own.source_timestamp, new Date(scrapedAt).toISOString());
  });

  it('says what is missing instead of running: source dating without a timestamp field, a missing token, a placeholder', async () => {
    dataset = items();
    const noTimestamp = marketplaceConfig();
    (noTimestamp.fields as Record<string, unknown>).source_timestamp = undefined;
    const a = source(noTimestamp);
    const jobA = await run(a.retailerId);
    assert.equal(jobA.status, 'not_configured');
    assert.match(String(jobA.error_message), /item timestamp/i);

    const b = source(marketplaceConfig({ url: 'https://api.apify.com/v2/actor-tasks/<TASK_ID>/runs/last/dataset/items?status=SUCCEEDED' }));
    const jobB = await run(b.retailerId);
    assert.equal(jobB.status, 'not_configured');
    assert.match(String(jobB.error_message), /placeholder/i);

    const c = source(marketplaceConfig());
    db().run('DELETE FROM secrets WHERE name = ?', [retailerSecretName(c.retailerId)]);
    const jobC = await run(c.retailerId);
    assert.equal(jobC.status, 'not_configured');
    assert.equal(requests, 0, 'nothing is requested from a source that is not configured');
    assert.equal(observations(a.retailerId).length + observations(b.retailerId).length + observations(c.retailerId).length, 0);
  });

  it('describes the new mapping options and ships a template that is valid once the placeholder is replaced', () => {
    const thirdParty = describeConnectors().find((c) => c.method === 'third_party')!;
    const keys = thirdParty.config_fields.map((f) => f.key);
    for (const key of ['tags', 'flag_tags', 'fields.rating', 'fields.review_count', 'fields.sales_rank', 'fields.seller_name', 'observed_time']) {
      assert.ok(keys.includes(key), `config field ${key}`);
    }
    const template = thirdParty.examples.find((e) => /deal tags/i.test(e.title))!;
    assert.ok(template, 'a template with deal tags exists');
    const { config, problems } = readStructuredConfig(template.config);
    assert.deepEqual(problems, []);
    assert.equal(config.observed_time, 'source');
    assert.deepEqual(config.tags, ['deal_tag.text', 'nudges']);
    assert.deepEqual(config.flag_tags, { is_bestseller: 'Best seller' });
  });
});
