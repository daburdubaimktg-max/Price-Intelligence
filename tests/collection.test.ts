import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFixture, createTestApp, type Fixture, type TestApp } from './helpers.ts';
import { setSecret, setSetting, retailerSecretName } from '../server/services/core.ts';
import { getPath, mapAvailability, parsePrice } from '../server/services/collection/util.ts';
import { clearRobotsCache, extractFromHtml, readWebConfig } from '../server/services/collection/web.ts';
import { describeConnectors } from '../server/services/collection/registry.ts';
import { cancelJob, enqueueJob, recoverInterruptedJobs, runRetailerNow, startJob } from '../server/services/collection/runner.ts';
import { runSchedulerTick } from '../server/services/collection/scheduler.ts';
import { SIMULATED_FAILURE_CODE } from '../server/services/collection/simulated.ts';
import type { SourceListing } from '../server/services/collection/types.ts';

// ---------------------------------------------------------------------------------------------
// Local fixture "retailer" (feeds, an API and product pages)
// ---------------------------------------------------------------------------------------------

interface Hit {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  at: number;
}

interface Reply {
  status?: number;
  type?: string;
  body?: string;
  delayMs?: number;
}

interface FixtureServer {
  origin: string;
  hits: Hit[];
  state: Record<string, any>;
  /** Paths requested, in order, excluding robots.txt. */
  pages: () => string[];
  reset: () => void;
  close: () => Promise<void>;
}

async function startFixtureServer(route: (url: URL, req: http.IncomingMessage, state: Record<string, any>) => Reply | null): Promise<FixtureServer> {
  const hits: Hit[] = [];
  const state: Record<string, any> = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    hits.push({ method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, headers: req.headers, at: Date.now() });
    const reply = route(url, req, state) ?? { status: 404, body: 'not found' };
    const send = () => {
      res.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? 'text/html; charset=utf-8' });
      res.end(reply.body ?? '');
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    state,
    pages: () => hits.filter((h) => h.path !== '/robots.txt').map((h) => h.path),
    reset: () => {
      hits.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const json = (value: unknown, status = 200): Reply => ({ status, type: 'application/json', body: JSON.stringify(value) });

const productPage = (head: string, body = '<h1>Product</h1>') => `<!doctype html><html><head><title>Product page</title>${head}</head><body>${body}</body></html>`;
const jsonLd = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

function mainRoutes(url: URL, req: http.IncomingMessage, state: Record<string, any>): Reply | null {
  const path = url.pathname;
  if (path === '/robots.txt') {
    if (state.robotsStatus) return { status: state.robotsStatus, type: 'text/plain', body: 'error' };
    return { type: 'text/plain', body: state.robots ?? 'User-agent: *\nDisallow: /blocked/\n' };
  }

  // ---- feeds -------------------------------------------------------------------------------
  if (path === '/feed.json') {
    if (state.feedStatus) return json({ error: 'boom' }, state.feedStatus);
    const items: unknown[] = [
      {
        sku: 'OWN-OIL-200',
        name: 'Own Oil 200ml',
        pricing: { now: state.ownPrice ?? 'AED 12.50', was: '15.00', currency: state.feedCurrency ?? 'AED' },
        stock: { status: 'In Stock' },
        link: 'https://shop.example/p/own-oil-200',
        updated: '2026-11-16T10:00:00Z',
      },
    ];
    if (!state.omitRival) {
      items.push({ sku: 'rival-oil-300', name: 'Rival Oil 300ml', pricing: { now: 18, currency: 'AED' }, stock: { status: 'in stock' }, link: 'https://shop.example/p/rival-oil-300' });
    }
    items.push({
      sku: 'NEW-ITEM-1',
      name: 'New Shampoo 400ml',
      pricing: { now: '9.75' },
      stock: { status: 'in stock' },
      link: 'https://shop.example/p/new-shampoo-400',
      barcode: '6291000000017',
    });
    return json({ meta: { generated: '2026-11-16T10:00:00Z' }, data: { items } });
  }
  if (path === '/feed-paged.json') {
    const page = Number(url.searchParams.get('page'));
    const pages: Record<number, unknown[]> = {
      1: [{ id: 'own-oil-200', price: 10 }],
      2: [{ id: 'rival-oil-300', price: 20 }],
    };
    return json({ results: pages[page] ?? [] });
  }
  if (path === '/feed-next.json') {
    if (url.searchParams.get('cursor') === '2') return json({ items: [{ id: 'rival-oil-300', price: 21 }], links: { next: null } });
    return json({ items: [{ id: 'own-oil-200', price: 11 }], links: { next: '/feed-next.json?cursor=2' } });
  }
  if (path === '/feed-secure.json') {
    if (url.searchParams.get('api_key') !== 'query-secret') return json({ error: 'unauthorised' }, 401);
    return json([{ id: 'own-oil-200', price: 14.5 }, { id: 'rival-oil-300', price: 19.5 }]);
  }
  if (path === '/feed.csv') {
    return { type: 'text/csv', body: '﻿sku;price;was;stock\nown-oil-200;12,50;15,00;yes\nrival-oil-300;"1.234,00";;no\n' };
  }
  if (path === '/feed.xml') {
    return {
      type: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>Feed</title>
<item><g:id>own-oil-200</g:id><title>Own Oil 200ml</title><link>https://shop.example/p/own</link><g:price>15.00 AED</g:price><g:sale_price>12.00 AED</g:sale_price><g:availability>in stock</g:availability></item>
<item><g:id>rival-oil-300</g:id><title>Rival &amp; Co Oil</title><g:price>18.50 AED</g:price><g:availability>out of stock</g:availability></item>
</channel></rss>`,
    };
  }
  if (path === '/feed-broken.json') return { type: 'application/json', body: '{"items": [' };
  if (path === '/slow-feed.json') {
    state.inFlight = (state.inFlight ?? 0) + 1;
    state.maxInFlight = Math.max(state.maxInFlight ?? 0, state.inFlight);
    setTimeout(() => {
      state.inFlight -= 1;
    }, 300);
    return { ...json([{ id: 'own-oil-200', price: 10 }, { id: 'rival-oil-300', price: 20 }]), delayMs: 300 };
  }

  // ---- per-product API ------------------------------------------------------------------------
  if (path.startsWith('/api/products/')) {
    if (req.headers.authorization !== 'Bearer secret-token') return json({ error: 'invalid token' }, 401);
    const id = decodeURIComponent(path.split('/').pop() ?? '');
    const prices: Record<string, number> = { 'own-oil-200': 13.25, 'rival-oil-300': 21 };
    if (!(id in prices)) return json({ error: 'not found' }, 404);
    return json({ data: { price: { current: prices[id], list: 25 }, stock: 'in_stock', currency: 'AED', updated_at: 1794000000 } });
  }

  // ---- product pages --------------------------------------------------------------------------
  if (path === '/p/jsonld-1') {
    return {
      body: productPage(
        jsonLd({
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: 'Own Oil 200ml',
          sku: 'own-oil-200',
          offers: { '@type': 'Offer', price: state.pagePrice ?? '12.50', priceCurrency: 'AED', availability: 'https://schema.org/InStock' },
        }),
      ),
    };
  }
  if (path === '/p/jsonld-2') {
    return {
      body: productPage(
        jsonLd({
          '@context': 'https://schema.org',
          '@graph': [
            { '@type': 'BreadcrumbList', itemListElement: [] },
            { '@type': 'Product', name: 'Rival Oil 300ml', offers: { '@type': 'AggregateOffer', lowPrice: 17.75, highPrice: 19, priceCurrency: 'AED', availability: 'http://schema.org/OutOfStock' } },
          ],
        }),
      ),
    };
  }
  if (path === '/p/meta-1') {
    return {
      body: productPage(
        '<meta property="product:price:amount" content="14.00"><meta property="product:price:currency" content="AED"><meta property="product:availability" content="in stock">',
      ),
    };
  }
  if (path === '/p/selector-1') {
    return { body: productPage('', '<span class="price-now" data-amount="11.25">AED 11.25</span><span class="price-was">AED 14.00</span><div class="stock">In stock</div>') };
  }
  if (path === '/p/regex-1') return { body: productPage('', '<script>window.__STATE__ = {"price":"10.95","wasPrice":"13.00"}</script><p>Details</p>') };
  if (path === '/p/usd-1') {
    return { body: productPage(jsonLd({ '@type': 'Product', name: 'Imported', offers: { '@type': 'Offer', price: '3.99', priceCurrency: 'USD' } })) };
  }
  if (path === '/p/captcha') return { body: '<!doctype html><html><head><title>Robot Check</title></head><body><p>Are you a human? Please complete the captcha.</p></body></html>' };
  if (path === '/p/noprice') return { body: productPage('', `<p>${'This product page has plenty of descriptive text but no price. '.repeat(30)}</p>`) };
  if (path === '/p/forbidden') return { status: 403, body: 'forbidden' };
  if (path === '/p/gone') return { status: 404, body: 'gone' };
  if (path === '/p/throttle') return { status: 429, body: 'slow down' };
  if (path.startsWith('/blocked/')) return { body: productPage(jsonLd({ '@type': 'Product', offers: { price: '1.00', priceCurrency: 'AED' } })) };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

let t: TestApp;
let fx: FixtureServer;
let seq = 0;

before(async () => {
  t = await createTestApp();
  fx = await startFixtureServer(mainRoutes);
});
after(async () => {
  await fx.close();
  await t.close();
});
beforeEach(() => {
  fx.reset();
  for (const key of Object.keys(fx.state)) delete fx.state[key];
  clearRobotsCache();
});

const db = () => t.ctx.db;
const count = (sql: string, params: unknown[] = []) => db().scalar<number>(sql, params as never) ?? 0;

/** A fresh real retailer with two listings (own-oil-200, rival-oil-300), configured for `method`. */
function source(method: string, config: Record<string, unknown>, options: { attested?: boolean; marketCode?: string } = {}): Fixture {
  const f = createFixture(t.ctx, { retailerName: `Source ${++seq}`, method, marketCode: options.marketCode });
  db().run(`UPDATE retailers SET connector_config = ?, rate_limit_ms = 250, permission_attested = ?, next_run_at = NULL WHERE id = ?`, [
    JSON.stringify(config),
    options.attested ? 1 : 0,
    f.retailerId,
  ]);
  return f;
}

const setListingUrl = (listingId: number, url: string | null) => db().run('UPDATE retailer_listings SET url = ? WHERE id = ?', [url, listingId]);

const observations = (retailerId: number) =>
  db().all<Record<string, any>>(
    `SELECT o.*, l.external_id FROM price_observations o JOIN retailer_listings l ON l.id = o.listing_id WHERE o.retailer_id = ? ORDER BY o.id`,
    [retailerId],
  );

const logsOf = (jobId: number) => db().all<Record<string, any>>('SELECT * FROM collection_logs WHERE job_id = ? ORDER BY id', [jobId]);

const run = (retailerId: number) => runRetailerNow(t.ctx, retailerId, { trigger: 'manual' });

const feedConfig = (overrides: Record<string, unknown> = {}) => ({
  mode: 'bulk',
  format: 'json',
  url: `${fx.origin}/feed.json`,
  items_path: 'data.items',
  match: { listing_key: 'external_id', field: 'sku' },
  fields: {
    current_price: 'pricing.now',
    regular_price: 'pricing.was',
    availability: 'stock.status',
    currency: 'pricing.currency',
    url: 'link',
    title: 'name',
    source_timestamp: 'updated',
    gtin: 'barcode',
  },
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

describe('value parsing', () => {
  it('reads prices in the formats retailers actually publish', () => {
    assert.equal(parsePrice(12.5), 12.5);
    assert.equal(parsePrice('AED 12.50'), 12.5);
    assert.equal(parsePrice('12,50 €'), 12.5);
    assert.equal(parsePrice('1,234.50'), 1234.5);
    assert.equal(parsePrice('1.234,50'), 1234.5);
    assert.equal(parsePrice('KSh 1,250'), 1250);
    assert.equal(parsePrice('1 250,00'), 1250);
    assert.equal(parsePrice('1.250'), 1.25); // three-decimal currencies (KWD, BHD, OMR)
    assert.equal(parsePrice('1.250', { decimalSeparator: ',' }), 1250);
    assert.equal(parsePrice('د.إ. 12.50'), 12.5);
    assert.equal(parsePrice('١٢٫٥٠'), 12.5);
    assert.equal(parsePrice(1250, { divisor: 100 }), 12.5);
    assert.equal(parsePrice({ '#text': '9.99', '@_currency': 'AED' }), 9.99);
  });

  it('returns null instead of guessing when there is no usable number', () => {
    for (const value of [null, undefined, '', 'call for price', 'N/A', -5, '-12.50', true, {}, Number.NaN]) {
      assert.equal(parsePrice(value), null, `value: ${String(value)}`);
    }
  });

  it('maps availability wording and never assumes stock for unknown values', () => {
    assert.equal(mapAvailability('https://schema.org/InStock'), 'in_stock');
    assert.equal(mapAvailability('Out of stock'), 'out_of_stock');
    assert.equal(mapAvailability('LimitedAvailability'), 'limited');
    assert.equal(mapAvailability(true), 'in_stock');
    assert.equal(mapAvailability(0), 'out_of_stock');
    assert.equal(mapAvailability('7'), 'in_stock');
    assert.equal(mapAvailability('متوفر'), 'unknown');
    assert.equal(mapAvailability('متوفر', { in_stock: ['متوفر'] }), 'in_stock');
    assert.equal(mapAvailability(undefined), 'unknown');
    // free text: explicit wording only, negatives first
    assert.equal(mapAvailability('In stock (22 available)'), 'in_stock');
    assert.equal(mapAvailability('Sorry, this item is sold out'), 'out_of_stock');
    assert.equal(mapAvailability('Currently not available online'), 'out_of_stock');
    assert.equal(mapAvailability('In stock - only 2 left'), 'limited');
    assert.equal(mapAvailability('Check availability in store'), 'unknown');
    assert.equal(mapAvailability('Available from 12 December'), 'unknown');
  });

  it('follows dot paths with array indexes and exact keys', () => {
    const item = { a: { b: [{ c: 1 }, { c: 2 }] }, 'g:price': '5', 'x.y': 'exact' };
    assert.equal(getPath(item, 'a.b[1].c'), 2);
    assert.equal(getPath(item, 'a.b.0.c'), 1);
    assert.equal(getPath(item, 'a.b.c'), 1);
    assert.equal(getPath(item, 'g:price'), '5');
    assert.equal(getPath(item, 'x.y'), 'exact');
    assert.equal(getPath(item, 'a.missing.deep'), undefined);
    const list = [1, 2];
    assert.equal(getPath(list, ''), list);
    assert.equal(getPath(list, '$'), list);
    assert.equal(getPath(list, '[1]'), 2);
  });
});

// ---------------------------------------------------------------------------------------------
// Structured sources: feeds, APIs, third-party providers
// ---------------------------------------------------------------------------------------------

describe('structured connector (API / feed / third party)', () => {
  it('collects a JSON feed through a nested field mapping and records full provenance', async () => {
    const s = source('product_feed', feedConfig());
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.data_class, 'real');
    assert.equal(job.is_demo, 0);
    assert.equal(job.trigger_type, 'manual');
    assert.equal(job.listings_total, 2);
    assert.equal(job.listings_succeeded, 2);
    assert.equal(job.observations_created, 2);
    assert.equal(job.error_code, null);

    const rows = observations(s.retailerId);
    assert.equal(rows.length, 2);
    const own = rows.find((r) => r.external_id === 'own-oil-200')!;
    assert.equal(own.current_price, 12.5);
    assert.equal(own.regular_price, 15);
    assert.equal(own.is_promo, 1);
    assert.equal(own.discount_pct, 16.67);
    assert.equal(own.availability, 'in_stock');
    assert.equal(own.currency_code, 'AED');
    assert.equal(own.source_method, 'product_feed');
    assert.equal(own.data_class, 'collected');
    assert.equal(own.is_demo, 0);
    assert.equal(own.confidence, 0.95);
    assert.equal(own.job_id, job.id);
    assert.equal(own.collection_status, 'complete');
    assert.equal(own.product_url, 'https://shop.example/p/own-oil-200');
    // observed when WE fetched it; the feed's own timestamp is kept separately
    assert.equal(own.source_timestamp, '2026-11-16T10:00:00.000Z');
    assert.ok(Math.abs(Date.parse(own.observed_at) - Date.now()) < 60_000);

    const evidence = db().get<Record<string, any>>('SELECT * FROM source_evidence WHERE id = ?', [own.evidence_id])!;
    assert.equal(evidence.kind, 'feed_item');
    assert.equal(evidence.reference, `${fx.origin}/feed.json`);
    assert.match(evidence.sha256, /^[0-9a-f]{64}$/);

    const retailer = db().get<Record<string, any>>('SELECT * FROM retailers WHERE id = ?', [s.retailerId])!;
    assert.ok(retailer.last_success_at);
    assert.ok(retailer.last_attempt_at);
    assert.equal(retailer.consecutive_failures, 0);

    // the item that is not a listing is reported, not silently added (discovery is off)
    assert.ok(logsOf(job.id).some((l) => l.code === 'unmatched_items' && l.level === 'info'));
    assert.equal(count('SELECT COUNT(*) FROM retailer_listings WHERE retailer_id = ?', [s.retailerId]), 2);
  });

  it('retains an unchanged price as a new observation on every collection', async () => {
    const s = source('product_feed', feedConfig());
    await run(s.retailerId);
    const second = await run(s.retailerId);
    assert.equal(second.status, 'succeeded');
    assert.equal(second.observations_created, 2);
    assert.equal(second.duplicates_skipped, 0);
    const own = observations(s.retailerId).filter((r) => r.external_id === 'own-oil-200');
    assert.equal(own.length, 2);
    assert.equal(own[0]!.current_price, own[1]!.current_price);
    assert.notEqual(own[0]!.observed_at, own[1]!.observed_at);
    // and a changed price never overwrites history
    fx.state.ownPrice = 'AED 13.00';
    await run(s.retailerId);
    assert.deepEqual(
      observations(s.retailerId).filter((r) => r.external_id === 'own-oil-200').map((r) => r.current_price),
      [12.5, 12.5, 13],
    );
  });

  it('adds unknown items as UNMATCHED listings when discovery is enabled — never auto-matched', async () => {
    const s = source('product_feed', feedConfig({ discover_listings: true }));
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.observations_created, 3);
    assert.equal(job.listings_total, 3);
    assert.equal(job.listings_succeeded, 3);
    const discovered = db().get<Record<string, any>>(`SELECT * FROM retailer_listings WHERE retailer_id = ? AND external_id = 'NEW-ITEM-1'`, [s.retailerId])!;
    assert.equal(discovered.match_status, 'unmatched');
    assert.equal(discovered.product_id, null);
    assert.equal(discovered.title, 'New Shampoo 400ml');
    assert.equal(discovered.url, 'https://shop.example/p/new-shampoo-400');
    assert.equal(discovered.gtin, '6291000000017');
    assert.equal(discovered.is_demo, 0);
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE listing_id = ?', [discovered.id]), 1);
    assert.ok(logsOf(job.id).some((l) => l.code === 'listings_discovered'));
    // a second run collects the new listing as a normal listing and does not duplicate it
    const again = await run(s.retailerId);
    assert.equal(again.listings_total, 3);
    assert.equal(count('SELECT COUNT(*) FROM retailer_listings WHERE retailer_id = ?', [s.retailerId]), 3);
  });

  it('counts listings the source no longer returns as missing (partial run)', async () => {
    const s = source('product_feed', feedConfig());
    fx.state.omitRival = true;
    const job = await run(s.retailerId);
    assert.equal(job.status, 'partial');
    assert.equal(job.listings_succeeded, 1);
    assert.equal(job.listings_missing, 1);
    assert.equal(job.observations_created, 1);
    assert.equal(job.error_code, 'listing_missing');
    const log = logsOf(job.id).find((l) => l.code === 'listing_missing')!;
    assert.equal(log.listing_id, s.compListingId);
    assert.equal(log.level, 'warn');
  });

  it('calls a per-listing API with the stored bearer credential', async () => {
    const s = source('official_api', {
      mode: 'per_listing',
      format: 'json',
      url_template: `${fx.origin}/api/products/{external_id}`,
      auth: { type: 'bearer' },
      items_path: 'data',
      fields: { current_price: 'price.current', regular_price: 'price.list', availability: 'stock', currency: 'currency', source_timestamp: 'updated_at' },
    });
    setSecret(t.ctx, retailerSecretName(s.retailerId), 'secret-token');
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.observations_created, 2);
    assert.equal(fx.hits.length, 2);
    assert.ok(fx.hits.every((h) => h.headers.authorization === 'Bearer secret-token'));
    assert.ok(fx.hits.every((h) => h.headers['user-agent'] === t.ctx.config.userAgent));
    const rows = observations(s.retailerId);
    assert.deepEqual(rows.map((r) => r.current_price).sort(), [13.25, 21]);
    assert.ok(rows.every((r) => r.source_method === 'official_api' && r.confidence === 0.97));
    assert.equal(rows[0]!.source_timestamp, new Date(1794000000 * 1000).toISOString());
    const kinds = db().all<{ kind: string }>(`SELECT kind FROM source_evidence WHERE id IN (${rows.map((r) => r.evidence_id).join(',')})`);
    assert.deepEqual([...new Set(kinds.map((k) => k.kind))], ['api_response']);
    // requests to the same host are spaced by the configured pause
    assert.ok(fx.hits[1]!.at - fx.hits[0]!.at >= 230, `gap was ${fx.hits[1]!.at - fx.hits[0]!.at} ms`);
  });

  it('fails clearly when the source rejects the credential, storing nothing', async () => {
    const s = source('official_api', {
      mode: 'per_listing',
      format: 'json',
      url_template: `${fx.origin}/api/products/{external_id}`,
      auth: { type: 'bearer' },
      items_path: 'data',
      fields: { current_price: 'price.current' },
    });
    setSecret(t.ctx, retailerSecretName(s.retailerId), 'wrong-token');
    const job = await run(s.retailerId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'auth_failed');
    assert.match(job.error_message!, /rejected the stored credential \(HTTP 401\)/);
    assert.equal(job.observations_created, 0);
    assert.equal(observations(s.retailerId).length, 0);
    assert.equal(fx.hits.length, 1, 'stops after the first refusal');
    assert.equal(db().get<{ n: number }>('SELECT consecutive_failures AS n FROM retailers WHERE id = ?', [s.retailerId])!.n, 1);
    // the secret never appears in job or log text
    assert.ok(!JSON.stringify([job, logsOf(job.id)]).includes('wrong-token'));
  });

  it('reports "not configured" without any network call when the credential is missing', async () => {
    const s = source('official_api', {
      mode: 'per_listing',
      format: 'json',
      url_template: `${fx.origin}/api/products/{external_id}`,
      auth: { type: 'bearer' },
      fields: { current_price: 'price.current' },
    });
    const job = await run(s.retailerId);
    assert.equal(job.status, 'not_configured');
    assert.equal(job.error_code, 'not_configured');
    assert.match(job.error_message!, /credential is not stored/i);
    assert.equal(fx.hits.length, 0);
    assert.equal(job.observations_created, 0);
    const retailer = db().get<Record<string, any>>('SELECT * FROM retailers WHERE id = ?', [s.retailerId])!;
    assert.equal(retailer.last_attempt_at, null, 'no attempt was made');
    assert.equal(retailer.last_success_at, null);
    assert.equal(retailer.consecutive_failures, 0);
  });

  it('treats an incomplete configuration as not configured', async () => {
    const s = source('product_feed', { mode: 'bulk', format: 'json' });
    const job = await run(s.retailerId);
    assert.equal(job.status, 'not_configured');
    assert.match(job.error_message!, /Feed \/ API URL/);
    assert.match(job.error_message!, /fields\.current_price/);
    assert.equal(fx.hits.length, 0);
  });

  it('reads CSV feeds (delimiter detection, decimal commas)', async () => {
    const s = source('product_feed', {
      mode: 'bulk',
      format: 'csv',
      url: `${fx.origin}/feed.csv`,
      match: { listing_key: 'external_id', field: 'sku' },
      fields: { current_price: 'price', regular_price: 'was', availability: 'stock' },
    });
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    const rows = observations(s.retailerId);
    const own = rows.find((r) => r.external_id === 'own-oil-200')!;
    assert.equal(own.current_price, 12.5);
    assert.equal(own.regular_price, 15);
    assert.equal(own.availability, 'in_stock');
    const rival = rows.find((r) => r.external_id === 'rival-oil-300')!;
    assert.equal(rival.current_price, 1234);
    assert.equal(rival.availability, 'out_of_stock');
  });

  it('reads XML shopping feeds with namespaced fields and sale prices', async () => {
    const s = source('product_feed', {
      mode: 'bulk',
      format: 'xml',
      url: `${fx.origin}/feed.xml`,
      items_path: 'rss.channel.item',
      match: { listing_key: 'external_id', field: 'g:id' },
      fields: { current_price: 'g:price', promo_price: 'g:sale_price', availability: 'g:availability', title: 'title', url: 'link' },
    });
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    const rows = observations(s.retailerId);
    const own = rows.find((r) => r.external_id === 'own-oil-200')!;
    assert.equal(own.current_price, 12);
    assert.equal(own.regular_price, 15);
    assert.equal(own.promo_price, 12);
    assert.equal(own.discount_pct, 20);
    assert.equal(own.is_promo, 1);
    const rival = rows.find((r) => r.external_id === 'rival-oil-300')!;
    assert.equal(rival.current_price, 18.5);
    assert.equal(rival.availability, 'out_of_stock');
  });

  it('follows page-number pagination until an empty page', async () => {
    const s = source('official_api', {
      mode: 'bulk',
      format: 'json',
      url: `${fx.origin}/feed-paged.json`,
      items_path: 'results',
      match: { listing_key: 'external_id', field: 'id' },
      fields: { current_price: 'price' },
      pagination: { type: 'page', param: 'page', start: 1, max_pages: 10 },
    });
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.observations_created, 2);
    assert.deepEqual(fx.pages(), ['/feed-paged.json?page=1', '/feed-paged.json?page=2', '/feed-paged.json?page=3']);
  });

  it('follows next-page links', async () => {
    const s = source('official_api', {
      mode: 'bulk',
      format: 'json',
      url: `${fx.origin}/feed-next.json`,
      items_path: 'items',
      match: { listing_key: 'external_id', field: 'id' },
      fields: { current_price: 'price' },
      pagination: { type: 'next_url', path: 'links.next' },
    });
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(observations(s.retailerId).map((r) => r.current_price).sort(), [11, 21]);
    assert.deepEqual(fx.pages(), ['/feed-next.json', '/feed-next.json?cursor=2']);
  });

  it('keeps API keys sent in the URL out of evidence and logs', async () => {
    const s = source('third_party', {
      mode: 'bulk',
      format: 'json',
      url: `${fx.origin}/feed-secure.json`,
      auth: { type: 'query', query_param: 'api_key' },
      match: { listing_key: 'external_id', field: 'id' },
      fields: { current_price: 'price' },
    });
    setSecret(t.ctx, retailerSecretName(s.retailerId), 'query-secret');
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    const rows = observations(s.retailerId);
    assert.ok(rows.every((r) => r.source_method === 'third_party' && r.confidence === 0.9));
    const evidence = db().get<Record<string, any>>('SELECT * FROM source_evidence WHERE id = ?', [rows[0]!.evidence_id])!;
    assert.match(evidence.reference, /api_key=REDACTED/);
    const everything = JSON.stringify([job, logsOf(job.id), db().all('SELECT * FROM source_evidence')]);
    assert.ok(!everything.includes('query-secret'));
  });

  it('requires provider authentication for third-party sources', async () => {
    const s = source('third_party', {
      mode: 'bulk',
      format: 'json',
      url: `${fx.origin}/feed-secure.json`,
      match: { listing_key: 'external_id', field: 'id' },
      fields: { current_price: 'price' },
    });
    const job = await run(s.retailerId);
    assert.equal(job.status, 'not_configured');
    assert.equal(fx.hits.length, 0);
  });

  it('rejects prices reported in another currency', async () => {
    const s = source('product_feed', feedConfig());
    fx.state.feedCurrency = 'USD';
    const job = await run(s.retailerId);
    assert.equal(job.status, 'partial');
    assert.equal(job.listings_failed, 1);
    const log = logsOf(job.id).find((l) => l.code === 'currency_mismatch')!;
    assert.match(log.message, /USD.*AED/);
    assert.equal(observations(s.retailerId).filter((r) => r.external_id === 'own-oil-200').length, 0);
  });

  it('rejects a price whose text names another currency, even without a currency field', async () => {
    const s = source('product_feed', {
      mode: 'bulk',
      format: 'xml',
      url: `${fx.origin}/feed.xml`,
      items_path: 'rss.channel.item',
      match: { listing_key: 'external_id', field: 'g:id' },
      fields: { current_price: 'g:price' },
    });
    // the feed states "15.00 AED" / "18.50 AED"; a retailer configured for another currency must not accept it
    const other = source('product_feed', {
      mode: 'bulk',
      format: 'xml',
      url: `${fx.origin}/feed.xml`,
      items_path: 'rss.channel.item',
      match: { listing_key: 'external_id', field: 'g:id' },
      fields: { current_price: 'g:price' },
    }, { marketCode: 'SA' });
    assert.equal((await run(s.retailerId)).status, 'succeeded');
    const job = await run(other.retailerId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'currency_mismatch');
    assert.equal(observations(other.retailerId).length, 0);
  });

  it('fails on server errors and unparseable responses with the real reason', async () => {
    const s = source('product_feed', feedConfig());
    fx.state.feedStatus = 503;
    const failed = await run(s.retailerId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_code, 'source_error');
    assert.match(failed.error_message!, /HTTP 503/);

    const broken = source('product_feed', feedConfig({ url: `${fx.origin}/feed-broken.json` }));
    const job = await run(broken.retailerId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'parse_error');
    assert.match(job.error_message!, /not valid JSON/);

    fx.state.feedStatus = undefined;
    const wrongPath = source('product_feed', feedConfig({ items_path: 'data.products' }));
    const job2 = await run(wrongPath.retailerId);
    assert.equal(job2.status, 'failed');
    assert.equal(job2.error_code, 'items_not_found');
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE retailer_id IN (?, ?, ?)', [s.retailerId, broken.retailerId, wrongPath.retailerId]), 0);
  });

  it('matches feed items by barcode or URL when configured', async () => {
    const s = source('product_feed', feedConfig({ match: { listing_key: 'url', field: 'link' } }));
    setListingUrl(s.ownListingId, 'https://shop.example/p/own-oil-200/?utm_source=newsletter');
    setListingUrl(s.compListingId, 'https://SHOP.example/p/rival-oil-300');
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.observations_created, 2);
  });
});

// ---------------------------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------------------------

describe('dry-run test of a source', () => {
  it('fetches and parses without storing anything', async () => {
    const s = source('product_feed', feedConfig({ discover_listings: true }));
    const before = {
      observations: count('SELECT COUNT(*) FROM price_observations'),
      jobs: count('SELECT COUNT(*) FROM collection_jobs'),
      evidence: count('SELECT COUNT(*) FROM source_evidence'),
      listings: count('SELECT COUNT(*) FROM retailer_listings'),
    };
    const res = await t.api('POST', `/collection/retailers/${s.retailerId}/test`, { body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.dry_run, true);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.items_found, 3);
    assert.equal(res.body.listings_matched, 2);
    assert.equal(res.body.would_discover, 1);
    assert.equal(res.body.requests, 1);
    const own = res.body.results.find((r: any) => r.listing_id === s.ownListingId);
    assert.equal(own.status, 'ok');
    assert.equal(own.observation.current_price, 12.5);
    assert.equal(own.observation.regular_price, 15);
    assert.equal(own.observation.currency_code, 'AED');
    assert.ok(res.body.results.some((r: any) => r.status === 'would_discover'));
    assert.equal(res.body.sample_items.length, 3);
    assert.match(res.body.note, /nothing was stored/i);
    assert.deepEqual(
      {
        observations: count('SELECT COUNT(*) FROM price_observations'),
        jobs: count('SELECT COUNT(*) FROM collection_jobs'),
        evidence: count('SELECT COUNT(*) FROM source_evidence'),
        listings: count('SELECT COUNT(*) FROM retailer_listings'),
      },
      before,
    );
  });

  it('says what is missing instead of calling an unconfigured source', async () => {
    const s = source('official_api', { mode: 'bulk', format: 'json', url: `${fx.origin}/feed.json`, auth: { type: 'header', header_name: 'X-API-Key' }, fields: { current_price: 'p' } });
    const res = await t.api('POST', `/collection/retailers/${s.retailerId}/test`, { body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, false);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.missing.length >= 2);
    assert.equal(res.body.requests, 0);
    assert.equal(fx.hits.length, 0);
  });

  it('is restricted to administrators and unavailable for people-driven sources', async () => {
    const s = source('product_feed', feedConfig());
    assert.equal((await t.api('POST', `/collection/retailers/${s.retailerId}/test`, { as: 'analyst', body: {} })).status, 403);
    assert.equal((await t.api('POST', `/collection/retailers/${s.retailerId}/test`, { as: 'viewer', body: {} })).status, 403);
    const manual = source('manual', {});
    const res = await t.api('POST', `/collection/retailers/${manual.retailerId}/test`, { body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'not_applicable');
  });
});

// ---------------------------------------------------------------------------------------------
// Permitted website extraction
// ---------------------------------------------------------------------------------------------

describe('permitted website extraction', () => {
  const webSource = (config: Record<string, unknown> = {}, attested = true) => {
    const s = source('web_extraction', config, { attested });
    setListingUrl(s.ownListingId, `${fx.origin}/p/jsonld-1`);
    setListingUrl(s.compListingId, `${fx.origin}/p/jsonld-2`);
    return s;
  };

  it('refuses to run until access permission has been attested', async () => {
    const s = webSource({}, false);
    const job = await run(s.retailerId);
    assert.equal(job.status, 'not_configured');
    assert.match(job.error_message!, /permission has not been attested/i);
    assert.equal(fx.hits.length, 0, 'not even robots.txt is requested');
    assert.equal(observations(s.retailerId).length, 0);
  });

  it('reads schema.org structured data, after checking robots.txt, at the configured pace', async () => {
    const s = webSource();
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.data_class, 'real');
    assert.equal(fx.hits[0]!.path, '/robots.txt');
    assert.deepEqual(fx.pages(), ['/p/jsonld-1', '/p/jsonld-2']);
    assert.ok(fx.hits.every((h) => h.headers['user-agent'] === t.ctx.config.userAgent));
    const pageHits = fx.hits.filter((h) => h.path !== '/robots.txt');
    assert.ok(pageHits[1]!.at - pageHits[0]!.at >= 230, `gap was ${pageHits[1]!.at - pageHits[0]!.at} ms`);

    const rows = observations(s.retailerId);
    const own = rows.find((r) => r.external_id === 'own-oil-200')!;
    assert.equal(own.current_price, 12.5);
    assert.equal(own.availability, 'in_stock');
    assert.equal(own.source_method, 'web_extraction');
    assert.equal(own.data_class, 'collected');
    assert.equal(own.confidence, 0.92);
    assert.equal(own.product_url, `${fx.origin}/p/jsonld-1`);
    const evidence = db().get<Record<string, any>>('SELECT * FROM source_evidence WHERE id = ?', [own.evidence_id])!;
    assert.equal(evidence.kind, 'html_snapshot');
    assert.equal(evidence.reference, `${fx.origin}/p/jsonld-1`);
    assert.match(evidence.sha256, /^[0-9a-f]{64}$/);
    assert.match(evidence.excerpt, /"price":"12\.50"/);
    assert.match(evidence.note, /json_ld/);
    // @graph + AggregateOffer: lowest price, out of stock
    const rival = rows.find((r) => r.external_id === 'rival-oil-300')!;
    assert.equal(rival.current_price, 17.75);
    assert.equal(rival.availability, 'out_of_stock');
  });

  it('falls back to meta tags, configured selectors and regular expressions', async () => {
    const s = webSource({ price_selector: '.price-now', regular_price_selector: '.price-was', availability_selector: '.stock', price_regex: '"price"\\s*:\\s*"([0-9.]+)"' });
    setListingUrl(s.ownListingId, `${fx.origin}/p/meta-1`);
    setListingUrl(s.compListingId, `${fx.origin}/p/selector-1`);
    const now = new Date().toISOString();
    const third = db().run(
      `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, created_at, updated_at) VALUES (?, ?, 'regex-item', ?, 'Regex item', 'matched', ?, ?)`,
      [s.retailerId, s.ownProductId, `${fx.origin}/p/regex-1`, now, now],
    ).lastInsertRowid;
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    const byListing = new Map(observations(s.retailerId).map((r) => [r.listing_id, r]));
    const meta = byListing.get(s.ownListingId)!;
    assert.equal(meta.current_price, 14);
    assert.equal(meta.confidence, 0.85);
    assert.equal(meta.availability, 'in_stock');
    const selector = byListing.get(s.compListingId)!;
    assert.equal(selector.current_price, 11.25);
    assert.equal(selector.regular_price, 14);
    assert.equal(selector.confidence, 0.8);
    assert.equal(selector.availability, 'in_stock');
    const regex = byListing.get(third)!;
    assert.equal(regex.current_price, 10.95);
    assert.equal(regex.confidence, 0.65);
    assert.equal(regex.collection_status, 'partial', 'availability unknown');
  });

  it('obeys robots.txt: disallowed pages are never requested', async () => {
    const s = webSource();
    setListingUrl(s.compListingId, `${fx.origin}/blocked/p1`);
    const job = await run(s.retailerId);
    assert.equal(job.status, 'partial');
    assert.deepEqual(fx.pages(), ['/p/jsonld-1']);
    const log = logsOf(job.id).find((l) => l.code === 'robots_disallowed')!;
    assert.equal(log.listing_id, s.compListingId);
    assert.equal(log.level, 'error');
    assert.equal(observations(s.retailerId).length, 1);
  });

  it('respects robots.txt rules addressed to its own user agent', async () => {
    fx.state.robots = `User-agent: *\nAllow: /\n\nUser-agent: ${t.ctx.config.userAgent.split('/')[0]}\nDisallow: /p/\n`;
    const s = webSource();
    const job = await run(s.retailerId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'robots_disallowed');
    assert.deepEqual(fx.pages(), []);
  });

  it('treats an unreadable robots.txt as "not permitted"', async () => {
    fx.state.robotsStatus = 500;
    const s = webSource();
    const job = await run(s.retailerId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'robots_unavailable');
    assert.deepEqual(fx.pages(), []);
    assert.equal(observations(s.retailerId).length, 0);
  });

  it('allows collection when the site has no robots.txt', async () => {
    fx.state.robotsStatus = 404;
    const s = webSource();
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
  });

  it('honours a Crawl-delay longer than the configured pause', async () => {
    fx.state.robots = 'User-agent: *\nCrawl-delay: 1\n';
    const s = webSource();
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    const pageHits = fx.hits.filter((h) => h.path !== '/robots.txt');
    assert.ok(pageHits[1]!.at - pageHits[0]!.at >= 950, `gap was ${pageHits[1]!.at - pageHits[0]!.at} ms`);
    assert.ok(logsOf(job.id).some((l) => l.code === 'crawl_delay'));
  });

  it('reports refusals, verification pages and pages without a price as failures — never a guessed price', async () => {
    const s = webSource();
    setListingUrl(s.ownListingId, `${fx.origin}/p/captcha`);
    setListingUrl(s.compListingId, `${fx.origin}/p/noprice`);
    const now = new Date().toISOString();
    for (const [id, path] of [['forbidden', '/p/forbidden'], ['gone', '/p/gone'], ['usd', '/p/usd-1']] as const) {
      db().run(
        `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'matched', ?, ?)`,
        [s.retailerId, s.ownProductId, id, `${fx.origin}${path}`, id, now, now],
      );
    }
    const job = await run(s.retailerId);
    assert.equal(job.status, 'failed');
    assert.equal(job.listings_failed, 5);
    assert.equal(job.observations_created, 0);
    const codes = logsOf(job.id).filter((l) => l.level === 'error' && l.listing_id).map((l) => l.code).sort();
    assert.deepEqual(codes, ['access_denied', 'bot_challenge', 'currency_mismatch', 'no_price_found', 'not_found']);
    assert.match(logsOf(job.id).find((l) => l.code === 'access_denied')!.message, /HTTP 403/);
    assert.match(logsOf(job.id).find((l) => l.code === 'currency_mismatch')!.message, /USD/);
    assert.equal(observations(s.retailerId).length, 0);
  });

  it('applies the robots.txt of the host a page redirects to', async () => {
    const strict = await startFixtureServer((url) => {
      if (url.pathname === '/robots.txt') return { type: 'text/plain', body: 'User-agent: *\nDisallow: /\n' };
      return { body: productPage(jsonLd({ '@type': 'Product', offers: { price: '1.00', priceCurrency: 'AED' } })) };
    });
    const hop = http.createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(302, { location: `${strict.origin}/p/moved` }).end();
    });
    await new Promise<void>((resolve) => hop.listen(0, '127.0.0.1', resolve));
    const hopOrigin = `http://127.0.0.1:${(hop.address() as AddressInfo).port}`;
    try {
      const s = webSource();
      setListingUrl(s.ownListingId, `${hopOrigin}/p/old`);
      db().run('UPDATE retailer_listings SET is_active = 0 WHERE id = ?', [s.compListingId]);
      const job = await run(s.retailerId);
      assert.equal(job.status, 'failed');
      assert.equal(job.error_code, 'robots_disallowed');
      assert.match(logsOf(job.id).find((l) => l.code === 'robots_disallowed')!.message, /redirected/);
      assert.equal(observations(s.retailerId).length, 0);
    } finally {
      hop.closeAllConnections();
      await new Promise<void>((resolve) => hop.close(() => resolve()));
      await strict.close();
    }
  });

  it('stops the run when the site signals rate limiting', async () => {
    const s = webSource();
    setListingUrl(s.ownListingId, `${fx.origin}/p/throttle`);
    const job = await run(s.retailerId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'rate_limited');
    assert.deepEqual(fx.pages(), ['/p/throttle'], 'the second listing is not requested');
  });

  it('extracts conservatively from HTML (pure)', () => {
    const { config } = readWebConfig({});
    const listing = { id: 1, code: 'LST-1', retailer_id: 1, product_id: 1, external_id: 'SKU-200', url: 'https://shop.example/p/oil', title: null, gtin: null, sku: null, match_status: 'matched', is_demo: 0 } satisfies SourceListing;
    const retailer = { currency_code: 'AED' };

    // two pack sizes described as variants, none identifiable → no guess
    const ambiguous = productPage(
      jsonLd({
        '@type': 'ProductGroup',
        name: 'Oil',
        hasVariant: [
          { '@type': 'Product', sku: 'SKU-100', offers: { price: '8.00', priceCurrency: 'AED' } },
          { '@type': 'Product', sku: 'SKU-300', offers: { price: '20.00', priceCurrency: 'AED' } },
        ],
      }),
      `<p>${'Long description without any price. '.repeat(50)}</p>`,
    );
    const a = extractFromHtml(ambiguous, listing, retailer, config);
    assert.ok('failure' in a && a.failure.code === 'no_price_found');

    // …but the variant carrying the listing's own identifier is used
    const identified = ambiguous.replace('SKU-300', 'SKU-200');
    const b = extractFromHtml(identified, listing, retailer, config);
    assert.ok('extraction' in b && b.extraction.current === 20 && b.extraction.strategy === 'json_ld');

    // sale price meta tags: sale is the selling price, the other the regular price
    const sale = productPage('<meta property="product:price:amount" content="20.00"><meta property="product:sale_price:amount" content="15.00"><meta property="product:price:currency" content="AED">');
    const c = extractFromHtml(sale, listing, retailer, config);
    assert.ok('extraction' in c && c.extraction.current === 15 && c.extraction.regular === 20 && c.extraction.strategy === 'meta');

    // related products in an ItemList are not this product
    const related = productPage(jsonLd({ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: { '@type': 'Product', offers: { price: '5.00' } } }] }), `<p>${'Text. '.repeat(400)}</p>`);
    const d = extractFromHtml(related, listing, retailer, config);
    assert.ok('failure' in d && d.failure.code === 'no_price_found');

    // out of stock without a price is a valid observation
    const oos = productPage(jsonLd({ '@type': 'Product', offers: { '@type': 'Offer', availability: 'https://schema.org/OutOfStock' } }));
    const e = extractFromHtml(oos, listing, retailer, config);
    assert.ok('extraction' in e && e.extraction.current === null && e.extraction.availability === 'out_of_stock');

    // a JavaScript-rendered shell is reported as such
    const shell = '<!doctype html><html><head><title>Shop</title><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script><script src="d.js"></script></head><body><div id="root"></div></body></html>';
    const f = extractFromHtml(shell, listing, retailer, config);
    assert.ok('failure' in f && /JavaScript/.test(f.failure.message));

    // a currency code written next to a selector price is checked against the retailer currency
    const selectorConfig = readWebConfig({ price_selector: '.price' }).config;
    const known = new Set(['AED', 'USD', 'SAR']);
    const foreign = extractFromHtml(productPage('', '<span class="price">USD 3.99</span>'), listing, retailer, selectorConfig, known);
    assert.ok('failure' in foreign && foreign.failure.code === 'currency_mismatch');
    const local = extractFromHtml(productPage('', '<span class="price">AED 14.75</span>'), listing, retailer, selectorConfig, known);
    assert.ok('extraction' in local && local.extraction.current === 14.75);

    // invalid regular expressions are a configuration problem, not a crash
    assert.ok(readWebConfig({ price_regex: '([0-9' }).problems.length > 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Simulated demo source
// ---------------------------------------------------------------------------------------------

describe('simulated demo source', () => {
  const profile = (seed: number) => ({ seed, base: 12, step: 0.25, promo: 0.25, depths: [0.1, 0.2], types: ['price_cut'], drift: 0.05, oos: 0.01 });

  function demoSource(options: { failureRate?: number; profiles?: 'both' | 'own-only' } = {}): Fixture {
    const s = source('simulated', {});
    db().run('UPDATE retailers SET is_demo = 1 WHERE id = ?', [s.retailerId]);
    db().run('UPDATE retailer_listings SET is_demo = 1 WHERE retailer_id = ?', [s.retailerId]);
    const profiles: Record<string, unknown> = { [s.ownListingId]: profile(s.ownListingId) };
    if (options.profiles !== 'own-only') profiles[s.compListingId] = profile(s.compListingId);
    db().run('UPDATE retailers SET connector_config = ? WHERE id = ?', [
      JSON.stringify({ simulated: { failure_rate: options.failureRate ?? 0, profiles } }),
      s.retailerId,
    ]);
    return s;
  }

  before(() => {
    setSetting(t.ctx, 'demo_epoch', new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10));
  });

  it('produces DEMO observations and jobs that are labelled simulated, without any network request', async () => {
    const s = demoSource();
    const job = await run(s.retailerId);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.data_class, 'simulated');
    assert.equal(job.is_demo, 1);
    assert.equal(job.method, 'simulated');
    assert.equal(fx.hits.length, 0);
    const rows = observations(s.retailerId);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.source_method, 'simulated');
      assert.equal(row.data_class, 'simulated');
      assert.equal(row.is_demo, 1);
      assert.ok(row.current_price > 0);
      const evidence = db().get<Record<string, any>>('SELECT * FROM source_evidence WHERE id = ?', [row.evidence_id])!;
      assert.equal(evidence.kind, 'simulated');
      assert.equal(evidence.is_demo, 1);
      assert.match(evidence.note, /not an observation of a real retailer/i);
    }
    assert.match(logsOf(job.id).find((l) => l.code === 'run_summary')!.message, /^Simulated demo run/);
  });

  it('refuses to run for a real (non-demo) retailer', async () => {
    const s = source('simulated', { simulated: { failure_rate: 0, profiles: {} } });
    const job = await run(s.retailerId);
    assert.equal(job.status, 'not_configured');
    assert.match(job.error_message!, /only available for DEMO retailers/);
    assert.equal(observations(s.retailerId).length, 0);
  });

  it('labels its deliberate failures as simulated', async () => {
    const s = demoSource({ failureRate: 1 });
    const job = await run(s.retailerId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, SIMULATED_FAILURE_CODE);
    assert.match(job.error_message!, /^Simulated failure \(demo\)/);
    assert.equal(job.data_class, 'simulated');
    assert.equal(observations(s.retailerId).length, 0);
  });

  it('reports listings without a demo profile as missing', async () => {
    const s = demoSource({ profiles: 'own-only' });
    const job = await run(s.retailerId);
    assert.equal(job.status, 'partial');
    assert.equal(job.listings_missing, 1);
    assert.equal(job.observations_created, 1);
    assert.ok(logsOf(job.id).some((l) => l.code === 'no_simulation_profile' && l.listing_id === s.compListingId));
  });
});

// ---------------------------------------------------------------------------------------------
// Runner, scheduler, retries
// ---------------------------------------------------------------------------------------------

describe('runner and scheduler', () => {
  before(() => {
    // Sources created by earlier suites must not be picked up by the scheduler passes below.
    db().run('UPDATE retailers SET is_enabled = 0');
  });

  it('runs only sources that are due, enabled, automated and configured', async () => {
    const due = source('product_feed', feedConfig());
    const notYet = source('product_feed', feedConfig());
    db().run('UPDATE retailers SET next_run_at = ? WHERE id = ?', [new Date(Date.now() + 3_600_000).toISOString(), notYet.retailerId]);
    const paused = source('product_feed', feedConfig());
    db().run('UPDATE retailers SET is_enabled = 0 WHERE id = ?', [paused.retailerId]);
    const manualFrequency = source('product_feed', feedConfig());
    db().run(`UPDATE retailers SET collection_frequency = 'manual' WHERE id = ?`, [manualFrequency.retailerId]);
    const people = source('manual', {});
    const unconfigured = source('official_api', { mode: 'bulk' });

    const ticks: Date[] = [];
    t.ctx.hooks.schedulerTick.push((now) => ticks.push(now));
    const finished: number[] = [];
    t.ctx.hooks.collectionJobFinished.push((jobId) => finished.push(jobId));

    const now = new Date();
    const result = await runSchedulerTick(t.ctx, now, { wait: true });
    assert.deepEqual(ticks, [now]);
    assert.deepEqual(result.started.map((j) => j.retailer_id), [due.retailerId]);
    assert.equal(result.finished[0]!.status, 'succeeded');
    assert.equal(result.finished[0]!.trigger_type, 'schedule');
    assert.deepEqual(finished, [result.started[0]!.id]);
    // the unconfigured source is skipped with the reason — no job is fabricated for it
    assert.deepEqual(result.skipped.map((s) => s.retailer_id), [unconfigured.retailerId]);
    assert.match(result.skipped[0]!.reason, /Not configured/);
    for (const s of [notYet, paused, manualFrequency, people, unconfigured]) {
      assert.equal(count('SELECT COUNT(*) FROM collection_jobs WHERE retailer_id = ?', [s.retailerId]), 0);
    }
    // next run is planned one interval (daily) ahead
    const next = db().get<{ next_run_at: string }>('SELECT next_run_at FROM retailers WHERE id = ?', [due.retailerId])!.next_run_at;
    const hoursAhead = (Date.parse(next) - Date.now()) / 3_600_000;
    assert.ok(hoursAhead > 23.9 && hoursAhead < 24.1, `next run in ${hoursAhead} h`);
    // nothing is due on the following pass
    const again = await runSchedulerTick(t.ctx, new Date(), { wait: true });
    assert.equal(again.started.length, 0);
    t.ctx.hooks.schedulerTick.length = 0;
    t.ctx.hooks.collectionJobFinished.length = 0;
    db().run('UPDATE retailers SET is_enabled = 0');
  });

  it('retries a failed run automatically after a back-off, up to the configured maximum', async () => {
    const s = source('product_feed', feedConfig());
    fx.state.feedStatus = 503;
    const first = await runSchedulerTick(t.ctx, new Date(), { wait: true });
    assert.equal(first.finished.length, 1);
    assert.equal(first.finished[0]!.status, 'failed');
    assert.equal(first.finished[0]!.attempt, 1);
    const jobs = () => db().all<Record<string, any>>('SELECT * FROM collection_jobs WHERE retailer_id = ? ORDER BY id', [s.retailerId]);

    // too early: the back-off (2 minutes) has not elapsed
    const early = await runSchedulerTick(t.ctx, new Date(Date.now() + 60_000), { wait: true });
    assert.equal(early.started.length, 0);

    // after the back-off the retry runs — and fails again
    const retry1 = await runSchedulerTick(t.ctx, new Date(Date.now() + 3 * 60_000), { wait: true });
    assert.equal(retry1.finished.length, 1);
    assert.equal(retry1.finished[0]!.trigger_type, 'retry');
    assert.equal(retry1.finished[0]!.attempt, 2);
    assert.equal(retry1.finished[0]!.parent_job_id, first.finished[0]!.id);
    assert.equal(retry1.finished[0]!.status, 'failed');
    assert.equal(db().get<{ n: number }>('SELECT consecutive_failures AS n FROM retailers WHERE id = ?', [s.retailerId])!.n, 2);

    // second retry (10 minute back-off) succeeds once the source is back
    fx.state.feedStatus = undefined;
    assert.equal((await runSchedulerTick(t.ctx, new Date(Date.now() + 5 * 60_000), { wait: true })).started.length, 0);
    const retry2 = await runSchedulerTick(t.ctx, new Date(Date.now() + 11 * 60_000), { wait: true });
    assert.equal(retry2.finished[0]!.attempt, 3);
    assert.equal(retry2.finished[0]!.status, 'succeeded');
    assert.equal(db().get<{ n: number }>('SELECT consecutive_failures AS n FROM retailers WHERE id = ?', [s.retailerId])!.n, 0);
    assert.deepEqual(jobs().map((j) => [j.attempt, j.trigger_type, j.status]), [
      [1, 'schedule', 'failed'],
      [2, 'retry', 'failed'],
      [3, 'retry', 'succeeded'],
    ]);

    // the retry chain is visible on every job of the chain
    const detail = await t.api('GET', `/collection/jobs/${retry1.finished[0]!.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.chain.map((j: any) => j.attempt), [1, 2, 3]);
    db().run('UPDATE retailers SET is_enabled = 0');
  });

  it('gives up after the maximum number of automatic retries and never retries configuration problems', async () => {
    const s = source('product_feed', feedConfig());
    fx.state.feedStatus = 500;
    await runSchedulerTick(t.ctx, new Date(), { wait: true });
    await runSchedulerTick(t.ctx, new Date(Date.now() + 3 * 60_000), { wait: true });
    await runSchedulerTick(t.ctx, new Date(Date.now() + 14 * 60_000), { wait: true });
    const beyond = await runSchedulerTick(t.ctx, new Date(Date.now() + 60 * 60_000), { wait: true });
    assert.equal(beyond.started.length, 0);
    assert.equal(count('SELECT COUNT(*) FROM collection_jobs WHERE retailer_id = ?', [s.retailerId]), 3);
    db().run('UPDATE retailers SET is_enabled = 0');

    const auth = source('official_api', {
      mode: 'per_listing',
      format: 'json',
      url_template: `${fx.origin}/api/products/{external_id}`,
      auth: { type: 'bearer' },
      items_path: 'data',
      fields: { current_price: 'price.current' },
    });
    setSecret(t.ctx, retailerSecretName(auth.retailerId), 'wrong-token');
    const failed = await runSchedulerTick(t.ctx, new Date(), { wait: true });
    assert.equal(failed.finished[0]!.error_code, 'auth_failed');
    const later = await runSchedulerTick(t.ctx, new Date(Date.now() + 30 * 60_000), { wait: true });
    assert.equal(later.started.length, 0, 'a rejected credential is not retried automatically');
    db().run('UPDATE retailers SET is_enabled = 0');
  });

  it('supports a manual retry once the cause has been fixed', async () => {
    const s = source('product_feed', feedConfig());
    fx.state.feedStatus = 500;
    const failed = await run(s.retailerId);
    assert.equal(failed.status, 'failed');
    fx.state.feedStatus = undefined;

    assert.equal((await t.api('POST', `/collection/jobs/${failed.id}/retry`, { as: 'viewer' })).status, 403);
    const res = await t.api('POST', `/collection/jobs/${failed.id}/retry`, { as: 'analyst' });
    assert.equal(res.status, 202);
    assert.equal(res.body.job.parent_job_id, failed.id);
    assert.equal(res.body.job.attempt, 2);
    assert.equal(res.body.job.trigger_type, 'retry');
    // wait for the asynchronous run to finish
    let job: any;
    for (let i = 0; i < 100; i++) {
      job = (await t.api('GET', `/collection/jobs/${res.body.job.id}`)).body.job;
      if (!['queued', 'running'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.status, 'succeeded');
    assert.equal(job.requested_by_name, 'Test analyst');
    // a job that succeeded cannot be retried
    const again = await t.api('POST', `/collection/jobs/${job.id}/retry`);
    assert.equal(again.status, 409);
  });

  it('queues a manual run through the API and records who asked for it', async () => {
    const s = source('product_feed', feedConfig());
    assert.equal((await t.api('POST', `/collection/retailers/${s.retailerId}/run`, { as: 'viewer' })).status, 403);
    const res = await t.api('POST', `/collection/retailers/${s.retailerId}/run`, { as: 'analyst' });
    assert.equal(res.status, 202);
    assert.ok(['queued', 'running'].includes(res.body.job.status));
    // a second request while one is in flight is refused
    const dup = await t.api('POST', `/collection/retailers/${s.retailerId}/run`, { as: 'analyst' });
    assert.equal(dup.status, 409);
    let job: any;
    for (let i = 0; i < 100; i++) {
      job = (await t.api('GET', `/collection/jobs/${res.body.job.id}`)).body.job;
      if (!['queued', 'running'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.status, 'succeeded');
    assert.equal(job.trigger_type, 'manual');
    assert.ok(job.duration_ms >= 0);
    assert.equal(count(`SELECT COUNT(*) FROM audit_log WHERE action = 'collection.run' AND entity_id = ?`, [String(s.retailerId)]), 1);
  });

  it('refuses to "collect" sources that are updated by people', async () => {
    for (const method of ['manual', 'csv_import']) {
      const s = source(method, {});
      const res = await t.api('POST', `/collection/retailers/${s.retailerId}/run`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'not_applicable');
      assert.equal(count('SELECT COUNT(*) FROM collection_jobs WHERE retailer_id = ?', [s.retailerId]), 0);
    }
  });

  it('marks jobs interrupted by a shutdown as failed instead of leaving them running forever', () => {
    const s = source('product_feed', feedConfig());
    const now = new Date().toISOString();
    const stuck = db().run(
      `INSERT INTO collection_jobs (retailer_id, method, trigger_type, data_class, status, started_at, created_at) VALUES (?, 'product_feed', 'schedule', 'real', 'running', ?, ?)`,
      [s.retailerId, now, now],
    ).lastInsertRowid;
    assert.equal(recoverInterruptedJobs(t.ctx), 1);
    const job = db().get<Record<string, any>>('SELECT * FROM collection_jobs WHERE id = ?', [stuck])!;
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'interrupted');
    assert.ok(job.finished_at);
    assert.ok(logsOf(stuck).some((l) => l.code === 'interrupted'));
    assert.equal(recoverInterruptedJobs(t.ctx), 0);
  });

  it('does not let a job abandoned long ago block its source', () => {
    const s = source('product_feed', feedConfig());
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const recent = new Date().toISOString();
    const insert = (startedAt: string) =>
      db().run(
        `INSERT INTO collection_jobs (retailer_id, method, trigger_type, data_class, status, started_at, created_at) VALUES (?, 'product_feed', 'manual', 'real', 'running', ?, ?)`,
        [s.retailerId, startedAt, startedAt],
      ).lastInsertRowid;
    // a job that could still be running elsewhere blocks a second one…
    const live = insert(recent);
    assert.throws(() => enqueueJob(t.ctx, s.retailerId, { trigger: 'manual' }), /already queued or running/);
    db().run(`UPDATE collection_jobs SET status = 'failed', finished_at = ? WHERE id = ?`, [recent, live]);
    // …one that outlived the maximum job duration is recorded as interrupted and no longer blocks
    const dead = insert(old);
    const job = enqueueJob(t.ctx, s.retailerId, { trigger: 'manual' });
    assert.equal(job.status, 'queued');
    assert.equal(db().get<{ status: string; error_code: string }>('SELECT status, error_code FROM collection_jobs WHERE id = ?', [dead])!.error_code, 'interrupted');
    cancelJob(t.ctx, job.id);
  });

  it('can cancel a queued job', () => {
    const s = source('product_feed', feedConfig());
    const job = enqueueJob(t.ctx, s.retailerId, { trigger: 'manual' });
    assert.throws(() => enqueueJob(t.ctx, s.retailerId, { trigger: 'manual' }), /already queued or running/);
    const cancelled = cancelJob(t.ctx, job.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(observations(s.retailerId).length, 0);
  });

  it('never runs more than two jobs at the same time', async () => {
    const servers = await Promise.all([0, 1, 2].map(() => startFixtureServer(mainRoutes)));
    const shared = { inFlight: 0, max: 0 };
    try {
      const jobs = servers.map((server) => {
        const s = source('product_feed', {
          mode: 'bulk',
          format: 'json',
          url: `${server.origin}/slow-feed.json`,
          match: { listing_key: 'external_id', field: 'id' },
          fields: { current_price: 'price' },
        });
        return enqueueJob(t.ctx, s.retailerId, { trigger: 'manual' });
      });
      const watcher = setInterval(() => {
        const running = count(`SELECT COUNT(*) FROM collection_jobs WHERE status = 'running'`);
        shared.max = Math.max(shared.max, running);
      }, 10);
      const finished = await Promise.all(jobs.map((j) => startJob(t.ctx, j.id)));
      clearInterval(watcher);
      assert.deepEqual(finished.map((j) => j.status), ['succeeded', 'succeeded', 'succeeded']);
      assert.ok(shared.max <= 2, `saw ${shared.max} jobs running at once`);
      assert.ok(shared.max >= 1);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Health views (separate database so the numbers are exact)
// ---------------------------------------------------------------------------------------------

describe('collection health', () => {
  let h: TestApp;
  let simulated: Fixture;
  let unconfigured: Fixture;
  let manual: Fixture;

  const mk = (name: string, method: string, config: Record<string, unknown>) => {
    const f = createFixture(h.ctx, { retailerName: name, method });
    h.ctx.db.run('UPDATE retailers SET connector_config = ?, rate_limit_ms = 250, next_run_at = NULL WHERE id = ?', [JSON.stringify(config), f.retailerId]);
    return f;
  };

  before(async () => {
    h = await createTestApp();
    setSetting(h.ctx, 'demo_epoch', new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10));
    simulated = mk('Demo Mart', 'simulated', {});
    h.ctx.db.run('UPDATE retailers SET is_demo = 1 WHERE id = ?', [simulated.retailerId]);
    h.ctx.db.run('UPDATE retailer_listings SET is_demo = 1 WHERE retailer_id = ?', [simulated.retailerId]);
    const p = (seed: number) => ({ seed, base: 10, step: 0.25, promo: 0.2, depths: [0.1], types: ['price_cut'], drift: 0.05, oos: 0 });
    h.ctx.db.run('UPDATE retailers SET connector_config = ? WHERE id = ?', [
      JSON.stringify({ simulated: { failure_rate: 0, profiles: { [simulated.ownListingId]: p(1), [simulated.compListingId]: p(2) } } }),
      simulated.retailerId,
    ]);
    unconfigured = mk('API Mart', 'official_api', { mode: 'bulk', format: 'json', url: 'https://api.retailer.example/v1/products', auth: { type: 'bearer' }, match: { field: 'sku' }, fields: { current_price: 'price' } });
    manual = mk('Manual Mart', 'manual', {});
    await runRetailerNow(h.ctx, simulated.retailerId, { trigger: 'manual' });
    await runRetailerNow(h.ctx, unconfigured.retailerId, { trigger: 'manual' });
  });
  after(async () => {
    await h.close();
  });

  it('never presents simulated or unconfigured runs as real successes', async () => {
    const res = await h.api('GET', '/collection/health?days=7', { as: 'viewer' });
    assert.equal(res.status, 200);
    const health = res.body;
    assert.equal(health.window_days, 7);
    // real: one job, which made no attempt
    assert.equal(health.window.real.attempts, 0);
    assert.equal(health.window.real.not_configured, 1);
    assert.equal(health.window.real.succeeded, 0);
    assert.equal(health.window.real.success_rate, null, 'no real attempt → rate is n/a, not 100 %');
    assert.equal(health.window.real.observations_created, 0);
    // simulated: reported in its own bucket
    assert.equal(health.window.simulated.attempts, 1);
    assert.equal(health.window.simulated.succeeded, 1);
    assert.equal(health.window.simulated.success_rate, 1);
    assert.equal(health.window.simulated.observations_created, 2);
    assert.equal(health.last_real_success_at, null);
    assert.ok(health.last_simulated_run_at);
    assert.equal(health.latest_runs.real.sources, 0);
    assert.equal(health.latest_runs.real.listings_captured, 0);
    assert.equal(health.latest_runs.simulated.listings_captured, 2);
    assert.equal(health.latest_runs.simulated.products_captured, 2);
    // sources
    assert.deepEqual(health.sources, { total: 3, active: 0, healthy: 0, failing: 0, not_configured: 1, paused: 0, manual: 1, simulated: 1, pending: 0 });
    // provenance of the ledger: nothing was collected from a real source
    const byClass = Object.fromEntries(health.provenance.map((p: any) => [p.data_class, p]));
    assert.deepEqual(Object.keys(byClass).sort(), ['collected', 'imported', 'manual', 'simulated']);
    assert.equal(byClass.collected.observations, 0);
    assert.equal(byClass.collected.last_observed_at, null);
    assert.equal(byClass.simulated.observations, 2);
    assert.equal(byClass.simulated.demo_observations, 2);
    assert.equal(health.daily.length, 7);
    const today = health.daily[health.daily.length - 1];
    assert.equal(today.simulated_succeeded, 1);
    assert.equal(today.real_succeeded, 0);
    assert.equal(today.real_not_configured, 1);
    assert.equal(today.real_observations, 0);
    assert.equal(health.scheduler.enabled, false);
  });

  it('explains the state of every source', async () => {
    const res = await h.api('GET', '/collection/sources');
    assert.equal(res.status, 200);
    const byId = new Map<number, any>(res.body.rows.map((r: any) => [r.retailer_id, r]));
    const sim = byId.get(simulated.retailerId);
    assert.equal(sim.status, 'simulated');
    assert.match(sim.status_reason, /not a real integration/);
    assert.equal(sim.is_demo, 1);
    assert.equal(sim.listings_captured_last_run, 2);
    assert.equal(sim.latest_job.data_class, 'simulated');
    const api = byId.get(unconfigured.retailerId);
    assert.equal(api.status, 'not_configured');
    assert.equal(api.config_ok, false);
    assert.equal(api.credential_configured, false);
    assert.ok(api.missing.some((m: string) => /credential/i.test(m)));
    assert.match(api.status_reason, /nothing is being collected/);
    assert.equal(api.latest_job.status, 'not_configured');
    assert.equal(api.listings_captured_last_run, null);
    assert.equal(api.listings_never_observed, 2);
    assert.equal(api.listings_stale, 2);
    const man = byId.get(manual.retailerId);
    assert.equal(man.status, 'manual');
    assert.equal(man.runnable, false);
    assert.equal(man.next_run_at, null);

    const filtered = await h.api('GET', '/collection/sources?status=not_configured');
    assert.deepEqual(filtered.body.rows.map((r: any) => r.retailer_id), [unconfigured.retailerId]);

    const status = await h.api('GET', `/collection/retailers/${unconfigured.retailerId}/status`);
    assert.equal(status.body.configured, false);
    assert.match(status.body.explanation, /cannot be collected yet/);
    assert.ok(status.body.requirements.length > 0);
  });

  it('moves a source from pending to healthy only after a real collection succeeded', async () => {
    const feedServer = await startFixtureServer(mainRoutes);
    try {
      const real = mk('Feed Mart', 'product_feed', {
        mode: 'bulk',
        format: 'json',
        url: `${feedServer.origin}/feed.json`,
        items_path: 'data.items',
        match: { listing_key: 'external_id', field: 'sku' },
        fields: { current_price: 'pricing.now', availability: 'stock.status' },
      });
      const pending = (await h.api('GET', `/collection/sources?retailer_id=${real.retailerId}`)).body.rows[0];
      assert.equal(pending.status, 'pending');
      assert.match(pending.status_reason, /no collection has run yet/);
      let health = (await h.api('GET', '/collection/health')).body;
      assert.equal(health.sources.pending, 1);
      assert.equal(health.sources.healthy, 0);
      assert.equal(health.last_real_success_at, null);

      const job = await runRetailerNow(h.ctx, real.retailerId, { trigger: 'manual' });
      assert.equal(job.status, 'succeeded');
      const healthy = (await h.api('GET', `/collection/sources?retailer_id=${real.retailerId}`)).body.rows[0];
      assert.equal(healthy.status, 'healthy');
      assert.equal(healthy.listings_stale, 0);
      health = (await h.api('GET', '/collection/health')).body;
      assert.equal(health.sources.healthy, 1);
      assert.equal(health.sources.active, 1);
      assert.ok(health.last_real_success_at);
      assert.equal(health.window.real.attempts, 1);
      assert.equal(health.window.real.success_rate, 1);
      assert.equal(health.window.real.not_configured, 1);
      assert.equal(health.provenance.find((p: any) => p.data_class === 'collected').observations, 2);
      assert.equal(health.latest_runs.real.listings_captured, 2);

      // a failing run flips it to failing, with the reason
      feedServer.state.feedStatus = 502;
      await runRetailerNow(h.ctx, real.retailerId, { trigger: 'manual' });
      const failing = (await h.api('GET', `/collection/sources?retailer_id=${real.retailerId}`)).body.rows[0];
      assert.equal(failing.status, 'failing');
      assert.match(failing.status_reason, /HTTP 502/);
      health = (await h.api('GET', '/collection/health')).body;
      assert.equal(health.window.real.success_rate, 0.5);
      assert.equal(health.sources.failing, 1);
    } finally {
      await feedServer.close();
    }
  });

  it('lists jobs and error logs with filters', async () => {
    const jobs = await h.api('GET', '/collection/jobs?data_class=real&status=failed,not_configured');
    assert.equal(jobs.status, 200);
    assert.equal(jobs.body.total, 2);
    assert.ok(jobs.body.rows.every((j: any) => j.data_class === 'real'));
    const simulatedJobs = await h.api('GET', '/collection/jobs?data_class=simulated');
    assert.equal(simulatedJobs.body.total, 1);
    assert.equal(simulatedJobs.body.rows[0].retailer_name, 'Demo Mart');

    const errors = await h.api('GET', '/collection/logs?level=error');
    assert.ok(errors.body.total >= 1);
    assert.ok(errors.body.rows.every((l: any) => l.level === 'error'));
    assert.ok(errors.body.rows.some((l: any) => l.code === 'source_error' && l.retailer_name === 'Feed Mart'));
    const warnings = await h.api('GET', `/collection/logs?retailer_id=${unconfigured.retailerId}`);
    assert.equal(warnings.body.rows[0].code, 'not_configured');
    assert.deepEqual(warnings.body.rows[0].detail.missing.length > 0, true);
    assert.equal((await h.api('GET', '/collection/jobs?from=not-a-date')).status, 400);
    assert.equal((await h.api('GET', '/collection/jobs/999999')).status, 404);
  });

  it('requires a session for every endpoint', async () => {
    for (const path of ['/collection/health', '/collection/sources', '/collection/jobs', '/collection/logs', '/collection/connectors']) {
      assert.equal((await h.api('GET', path, { as: null })).status, 401, path);
    }
  });
});

describe('connector catalogue', () => {
  it('describes every collection method honestly', async () => {
    const res = await t.api('GET', '/collection/connectors', { as: 'viewer' });
    assert.equal(res.status, 200);
    const byMethod = new Map<string, any>(res.body.rows.map((c: any) => [c.method, c]));
    assert.deepEqual([...byMethod.keys()], ['official_api', 'product_feed', 'web_extraction', 'third_party', 'csv_import', 'manual', 'simulated']);
    assert.equal(byMethod.get('manual').runnable, false);
    assert.equal(byMethod.get('csv_import').kind, 'people');
    assert.equal(byMethod.get('simulated').kind, 'simulated');
    assert.match(byMethod.get('simulated').summary, /Not a real integration/);
    assert.equal(byMethod.get('web_extraction').needs_permission_attestation, true);
    assert.ok(byMethod.get('web_extraction').limitations.some((l: string) => /JavaScript/.test(l)));
    assert.equal(byMethod.get('third_party').credential.needed, 'always');
    assert.ok(byMethod.get('third_party').examples.some((e: any) => /Apify/.test(e.title)));
    assert.ok(byMethod.get('product_feed').config_fields.some((f: any) => f.key === 'fields.current_price' && f.required));
    assert.equal(describeConnectors().length, 7);
  });

  it('keeps the third-party example unconfigured until the user supplies their own details', async () => {
    const apify = describeConnectors().find((c) => c.method === 'third_party')!.examples.find((e) => /Apify/.test(e.title))!;
    const s = source('third_party', apify.config);
    const job = await run(s.retailerId);
    assert.equal(job.status, 'not_configured');
    assert.match(job.error_message!, /credential/i);
    // even with a token stored, the placeholder in the URL must be replaced first
    setSecret(t.ctx, retailerSecretName(s.retailerId), 'some-token');
    const again = await run(s.retailerId);
    assert.equal(again.status, 'not_configured');
    assert.match(again.error_message!, /placeholder/i);
    assert.equal(fx.hits.length, 0);
  });
});
