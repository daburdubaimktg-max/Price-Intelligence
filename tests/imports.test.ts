import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { ago, createFixture, createTestApp, type Fixture, type TestApp } from './helpers.ts';
import { localDate, nowIso } from '../server/lib/time.ts';
import { parseCsv } from '../server/lib/tabular.ts';
import {
  parseAvailability,
  parseConfidence,
  parseImportTimestamp,
  parsePercent,
  parsePrice,
  parsePromoType,
  suggestMapping,
} from '../server/services/imports.ts';
import { ingestObservations } from '../server/services/ingestion.ts';
import type { RoleKey } from '../shared/constants.ts';

let t: TestApp;
let fx: Fixture;
let sa: Fixture;
let ownCode: string;
let ownProductCode: string;
let ownUrl: string;
let unlistedProductId: number;

const TZ = 'Asia/Dubai';
const day = (days: number) => localDate(new Date(Date.now() - days * 86_400_000), TZ);
const ledgerCount = () => t.ctx.db.scalar<number>('SELECT COUNT(*) FROM price_observations')!;

async function upload(kind: string | null, file: { name: string; content: Buffer | string } | null, as: RoleKey = 'admin', extra: Record<string, string> = {}) {
  const form = new FormData();
  if (kind) form.append('kind', kind);
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  if (file) form.append('file', new Blob([file.content]), file.name);
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  return t.api('POST', '/imports', { body, headers: { 'content-type': encoded.headers.get('content-type')! }, as });
}

async function download(url: string, as: RoleKey = 'admin') {
  const res = await t.app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${t.tokens[as]}` } });
  return { status: res.statusCode, headers: res.headers, buffer: res.rawPayload };
}

/** stage → validate → commit in one go. */
async function importFile(kind: string, name: string, content: Buffer | string, options: Record<string, unknown> = {}, mapping?: Record<string, string>) {
  const staged = await upload(kind, { name, content });
  assert.equal(staged.status, 201, staged.raw);
  const id = staged.body.batch.id as number;
  const validated = await t.api('POST', `/imports/${id}/validate`, { body: { options, mapping } });
  assert.equal(validated.status, 200, validated.raw);
  const committed = await t.api('POST', `/imports/${id}/commit`);
  return { id, staged: staged.body, validated: validated.body, committed };
}

before(async () => {
  t = await createTestApp();
  fx = createFixture(t.ctx);
  sa = createFixture(t.ctx, { marketCode: 'SA' }); // a retailer with the same name in another market
  const { db } = t.ctx;
  db.run(`UPDATE products SET sku = 'OWN-200', gtin = '6291000000011' WHERE id = ?`, [fx.ownProductId]);
  ownCode = db.get<{ code: string }>('SELECT code FROM retailer_listings WHERE id = ?', [fx.ownListingId])!.code;
  ownUrl = db.get<{ url: string }>('SELECT url FROM retailer_listings WHERE id = ?', [fx.ownListingId])!.url;
  ownProductCode = db.get<{ code: string }>('SELECT code FROM products WHERE id = ?', [fx.ownProductId])!.code;
  const now = nowIso();
  unlistedProductId = db.run(
    `INSERT INTO products (brand_id, name, category_id, sku, pack_size, pack_unit, created_at, updated_at) VALUES (?, 'Own Shampoo 400ml', ?, 'OWN-SH-400', 400, 'ml', ?, ?)`,
    [fx.ownBrandId, fx.categoryId, now, now],
  ).lastInsertRowid;
});

after(async () => {
  await t.close();
});

describe('value parsing', () => {
  it('reads prices in the formats people actually type', () => {
    const price = (text: string, comma = false) => {
      const r = parsePrice(text, comma);
      return r.ok ? r.value : `error`;
    };
    assert.equal(price('12.50'), 12.5);
    assert.equal(price('AED 1,250.50'), 1250.5);
    assert.equal(price('1.250,50'), 1250.5);
    assert.equal(price('12,50'), 12.5); // can only be a decimal comma
    assert.equal(price('12,5 €'), 12.5);
    assert.equal(price('1,250'), 1250);
    assert.equal(price('1,250', true), 1.25);
    assert.equal(price('1.250'), 1.25);
    assert.equal(price('1.250', true), 1250);
    assert.equal(price('1,250,000'), 1250000);
    assert.equal(price('KSh 1 250'), 1250);
    assert.equal(price('Rs. 1,250.00'), 1250);
    assert.equal(price('12.50 AED.'), 12.5);
    assert.equal(price(''), null);
    assert.equal(price('n/a'), null);
    assert.equal(price('abc'), 'error');
    assert.equal(price('-5'), -5);
  });

  it('reads percentages, confidence, availability and promotion types', () => {
    const value = <T>(r: { ok: true; value: T } | { ok: false; error: string }) => (r.ok ? r.value : 'error');
    assert.equal(value(parsePercent('20%')), 20);
    assert.equal(value(parsePercent('20')), 20);
    assert.equal(value(parsePercent('0.2')), 20); // Excel fraction
    assert.equal(value(parsePercent('12,5 %')), 12.5);
    assert.equal(value(parsePercent('')), null);
    assert.equal(value(parsePercent('lots')), 'error');
    assert.equal(value(parseConfidence('high')), 0.9);
    assert.equal(value(parseConfidence('Medium')), 0.7);
    assert.equal(value(parseConfidence('0.8')), 0.8);
    assert.equal(value(parseConfidence('85')), 0.85);
    assert.equal(value(parseConfidence('85%')), 0.85);
    assert.equal(value(parseConfidence('150')), 'error');
    assert.equal(value(parseAvailability('In Stock', 'unknown')), 'in_stock');
    assert.equal(value(parseAvailability('OOS', 'unknown')), 'out_of_stock');
    assert.equal(value(parseAvailability('sold out', 'unknown')), 'out_of_stock');
    assert.equal(value(parseAvailability('low stock', 'unknown')), 'limited');
    assert.equal(value(parseAvailability('', 'in_stock')), 'in_stock');
    assert.equal(value(parseAvailability('maybe', 'unknown')), 'error');
    assert.equal(parsePromoType('Price cut'), 'price_cut');
    assert.equal(parsePromoType('Buy 2 get 1'), 'multi_buy');
    assert.equal(parsePromoType('Bundle'), 'bundle');
    assert.equal(parsePromoType('Coupon'), 'coupon');
    assert.equal(parsePromoType('Ramadan special'), 'other');
    assert.equal(parsePromoType(''), null);
  });

  it('interprets timestamps in the market time zone or UTC and keeps milliseconds', () => {
    assert.deepEqual(parseImportTimestamp('2025-06-01 10:00', TZ, 'auto', 'market'), { utc: '2025-06-01T06:00:00.000Z', basis: 'exact' });
    assert.deepEqual(parseImportTimestamp('2025-06-01 10:00', TZ, 'auto', 'utc'), { utc: '2025-06-01T10:00:00.000Z', basis: 'exact' });
    assert.deepEqual(parseImportTimestamp('2025-06-01 10:00:05.123', TZ, 'auto', 'utc'), { utc: '2025-06-01T10:00:05.123Z', basis: 'exact' });
    assert.deepEqual(parseImportTimestamp('2025-06-01T10:00:05.123+04:00', TZ, 'auto', 'utc'), { utc: '2025-06-01T06:00:05.123Z', basis: 'exact' });
    assert.deepEqual(parseImportTimestamp('01/06/2025', TZ, 'dmy', 'market'), { utc: '2025-06-01T08:00:00.000Z', basis: 'date_only' });
    assert.equal(parseImportTimestamp('03/04/2025', TZ, 'auto', 'market'), null);
    assert.equal(parseImportTimestamp('14 Mar 2025', TZ, 'auto', 'market')!.utc, '2025-03-14T08:00:00.000Z');
  });

  it('recognises common column names', () => {
    const { mapping } = suggestMapping('observations', ['Store', 'Country', 'Barcode', 'Date', 'Time', 'RRP', 'Price', 'Offer price', 'Discount', 'Stock', 'URL', 'Comments']);
    assert.deepEqual(mapping, {
      retailer: 'Store', market: 'Country', gtin: 'Barcode', observed_date: 'Date', observed_time: 'Time', regular_price: 'RRP',
      current_price: 'Price', promo_price: 'Offer price', discount_pct: 'Discount', availability: 'Stock', product_url: 'URL', note: 'Comments',
    });
    assert.equal(suggestMapping('observations', ['Retailer', 'Link', 'Price']).mapping.listing_url, 'Link');
    assert.equal(suggestMapping('observations', ['Listing code', 'Observed at (UTC)', 'Current price']).options.timezone_mode, 'utc');
    const products = suggestMapping('products', ['Product', 'Brand', 'Category', 'Size', 'UOM', 'EAN', 'Countries']).mapping;
    assert.deepEqual(products, { name: 'Product', brand: 'Brand', category: 'Category', gtin: 'EAN', pack_size: 'Size', pack_unit: 'UOM', markets: 'Countries' });
  });
});

describe('price history import (CSV)', () => {
  let batchId: number;
  const csv = () =>
    [
      'Retailer,Market,SKU,Date,Regular price,Price,Promo,Stock,Confidence,Notes',
      `Test Mart,AE,OWN-200,${day(5)},20.00,20.00,,In stock,high,first`,
      `Test Mart,AE,OWN-200,${day(4)},20.00,16.00,Save 20%,In stock,,promo day`,
      `Test Mart,AE,OWN-200,${day(3)},"AED 1,020.50",,,yes,,`,
      `Unknown Shop,AE,OWN-200,${day(3)},20,20,,,,`,
      `Test Mart,AE,NOPE-1,${day(3)},20,20,,,,`,
      'Test Mart,AE,OWN-200,not a date,20,20,,,,',
      `Test Mart,AE,OWN-200,${day(2)},abc,,,,,`,
      `Test Mart,AE,OWN-200,${day(1)},,,,out of stock,,`,
      '',
    ].join('\r\n');

  it('stages the file as evidence and proposes a column mapping — nothing reaches the ledger', async () => {
    const before = ledgerCount();
    const res = await upload('observations', { name: 'history (march).csv', content: csv() }, 'analyst');
    assert.equal(res.status, 201, res.raw);
    batchId = res.body.batch.id;
    assert.equal(res.body.batch.status, 'staged');
    assert.equal(res.body.batch.kind, 'observations');
    assert.equal(res.body.row_count, 8);
    assert.deepEqual(res.body.headers, ['Retailer', 'Market', 'SKU', 'Date', 'Regular price', 'Price', 'Promo', 'Stock', 'Confidence', 'Notes']);
    assert.equal(res.body.sample_rows.length, 8);
    assert.deepEqual(res.body.suggested_mapping, {
      retailer: 'Retailer', market: 'Market', sku: 'SKU', observed_date: 'Date', regular_price: 'Regular price', current_price: 'Price',
      promo_description: 'Promo', availability: 'Stock', confidence: 'Confidence', note: 'Notes',
    });
    assert.ok(res.body.fields.some((f: any) => f.field === 'listing_code'));
    const evidence = t.ctx.db.get<Record<string, unknown>>('SELECT * FROM source_evidence WHERE id = ?', [res.body.batch.evidence_id])!;
    assert.equal(evidence.kind, 'csv_file');
    assert.equal(evidence.sha256, res.body.batch.sha256);
    assert.match(String(evidence.sha256), /^[0-9a-f]{64}$/);
    const original = await download(`/evidence/${evidence.id}/file`);
    assert.equal(original.status, 200);
    assert.equal(original.buffer.toString('utf8'), csv());
    assert.equal(ledgerCount(), before);
  });

  it('validates as a dry run and explains every rejected row', async () => {
    const before = ledgerCount();
    const res = await t.api('POST', `/imports/${batchId}/validate`, { as: 'analyst', body: {} });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.batch.status, 'validated');
    assert.deepEqual(
      { rows: res.body.summary.rows, valid: res.body.summary.valid, invalid: res.body.summary.invalid, will_insert: res.body.summary.will_insert, dup: res.body.summary.already_in_ledger },
      { rows: 8, valid: 4, invalid: 4, will_insert: 4, dup: 0 },
    );
    assert.equal(res.body.summary.date_from, day(5));
    assert.equal(res.body.summary.date_to, day(1));
    assert.equal(res.body.error_total, 4);
    const byRow = Object.fromEntries(res.body.errors.map((e: any) => [e.row, e]));
    assert.match(byRow[5].message, /Retailer "Unknown Shop" is not configured/);
    assert.equal(byRow[5].field, 'retailer');
    assert.match(byRow[6].message, /No product with SKU "NOPE-1"/);
    assert.match(byRow[7].message, /not a recognisable date/);
    assert.match(byRow[8].message, /"abc" is not a price/);
    assert.equal(res.body.preview.length, 4);
    const first = res.body.preview[0];
    assert.equal(first.row, 2);
    assert.equal(first.listing_code, ownCode);
    assert.equal(first.observed_basis, 'date_only');
    assert.equal(first.observed_local_date, day(5));
    assert.equal(first.current_price, 20);
    assert.equal(first.confidence, 0.9);
    assert.equal(res.body.preview[1].is_promo, true);
    assert.equal(res.body.preview[1].discount_pct, 20);
    assert.equal(res.body.preview[2].current_price, 1020.5);
    assert.equal(res.body.preview[3].availability, 'out_of_stock');
    assert.equal(ledgerCount(), before, 'validation writes nothing to the ledger');
  });

  it('commits the valid rows as imported history with provenance', async () => {
    let alerts = 0;
    t.ctx.hooks.observationsIngested.push(() => alerts++);
    const before = ledgerCount();
    const res = await t.api('POST', `/imports/${batchId}/commit`, { as: 'analyst' });
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(
      { inserted: res.body.inserted, duplicates: res.body.duplicates, skipped: res.body.skipped_invalid, status: res.body.batch.status },
      { inserted: 4, duplicates: 0, skipped: 4, status: 'committed' },
    );
    assert.equal(res.body.batch.inserted_count, 4);
    assert.equal(res.body.batch.error_count, 4);
    assert.ok(res.body.batch.committed_at);
    assert.equal(ledgerCount(), before + 4);
    assert.equal(alerts, 0, 'history imports never raise alerts');
    const rows = t.ctx.db.all<Record<string, unknown>>('SELECT * FROM price_observations WHERE import_batch_id = ? ORDER BY observed_at', [batchId]);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.source_method, 'csv_import');
      assert.equal(row.data_class, 'imported');
      assert.equal(row.observed_basis, 'date_only');
      assert.equal(row.evidence_id, res.body.batch.evidence_id);
      assert.equal(row.is_demo, 0);
      assert.match(String(row.observed_at), /T08:00:00\.000Z$/); // local noon in Dubai
      assert.ok(row.entered_by);
    }
    assert.deepEqual(rows.map((r) => r.observed_local_date), [day(5), day(4), day(3), day(1)]);
    assert.deepEqual(rows.map((r) => r.confidence), [0.9, 0.7, 0.7, 0.7]);
    assert.equal(rows[0]!.note, 'first');
    assert.equal(rows[1]!.is_promo, 1);
    assert.equal(rows[1]!.promo_description, 'Save 20%');
    assert.equal(rows[3]!.availability, 'out_of_stock');
    assert.equal(rows[3]!.current_price, null);
    // collected_at is the import time, not the original date
    assert.ok(String(rows[0]!.collected_at) > String(rows[0]!.observed_at));
    const detail = await t.api('GET', `/imports/${batchId}`);
    assert.equal(detail.body.error_total, 4);
    assert.equal(detail.body.result.inserted, 4);
    assert.equal(detail.body.batch.created_by_name, 'Test analyst');
  });

  it('refuses to commit twice', async () => {
    const res = await t.api('POST', `/imports/${batchId}/commit`);
    assert.equal(res.status, 409);
    assert.equal((await t.api('POST', `/imports/${batchId}/validate`, { body: {} })).status, 409);
  });

  it('never duplicates observations when the same file is imported again', async () => {
    const before = ledgerCount();
    const again = await importFile('observations', 'history-again.csv', csv());
    assert.equal(again.validated.summary.already_in_ledger, 4);
    assert.equal(again.validated.summary.will_insert, 0);
    assert.equal(again.committed.status, 200);
    assert.equal(again.committed.body.inserted, 0);
    assert.equal(again.committed.body.duplicates, 4);
    assert.equal(ledgerCount(), before);
  });

  it('requires a commit to be validated first and checks permissions', async () => {
    const staged = await upload('observations', { name: 'x.csv', content: csv() });
    assert.equal((await t.api('POST', `/imports/${staged.body.batch.id}/commit`)).status, 409);
    assert.equal((await upload('observations', { name: 'x.csv', content: csv() }, 'viewer')).status, 403);
    assert.equal((await t.api('POST', `/imports/${staged.body.batch.id}/validate`, { as: 'viewer', body: {} })).status, 403);
    assert.equal((await t.api('POST', `/imports/${staged.body.batch.id}/commit`, { as: 'viewer' })).status, 403);
  });

  it('rejects unusable uploads with a clear message', async () => {
    assert.equal((await upload(null, { name: 'x.csv', content: 'a,b\n1,2\n' })).status, 400);
    assert.equal((await upload('observations', null)).status, 422);
    assert.equal((await upload('observations', { name: 'x.csv', content: '' })).status, 422);
    const fakeXlsx = await upload('observations', { name: 'prices.xlsx', content: 'not really excel' });
    assert.equal(fakeXlsx.status, 422);
    const xls = await upload('observations', { name: 'old.xls', content: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]) });
    assert.equal(xls.status, 422);
    assert.match(xls.body.error.message, /\.xls/);
    assert.equal((await upload('observations', { name: 'photo.png', content: 'x' })).status, 422);
    const staged = await upload('observations', { name: 'x.csv', content: 'Retailer,Price,Date\nTest Mart,5,2025-01-01\n' });
    const noId = await t.api('POST', `/imports/${staged.body.batch.id}/validate`, { body: {} });
    assert.equal(noId.status, 422);
    assert.match(noId.body.error.message, /identifies the listing/);
    const badColumn = await t.api('POST', `/imports/${staged.body.batch.id}/validate`, { body: { mapping: { retailer: 'Retailer', sku: 'Nope', current_price: 'Price' } } });
    assert.equal(badColumn.status, 422);
    assert.match(badColumn.body.error.message, /Column "Nope"/);
    const badField = await t.api('POST', `/imports/${staged.body.batch.id}/validate`, { body: { mapping: { hacker: 'Retailer' } } });
    assert.equal(badField.status, 422);
  });
});

describe('dates, separators and options', () => {
  it('refuses ambiguous dates until the date order is chosen', async () => {
    const content = ['Retailer;Listing code;Date;Price;Discount', `Test Mart;${ownCode};03/04/2025;12,50;10%`, `Test Mart;${ownCode};25/04/2025;1.250,00;`].join('\n');
    const staged = await upload('observations', { name: 'semi.csv', content });
    const id = staged.body.batch.id;
    assert.deepEqual(staged.body.headers, ['Retailer', 'Listing code', 'Date', 'Price', 'Discount']);
    const auto = await t.api('POST', `/imports/${id}/validate`, { body: {} });
    assert.equal(auto.body.summary.valid, 1);
    assert.equal(auto.body.errors[0].row, 2);
    assert.match(auto.body.errors[0].message, /ambiguous/);
    const dmy = await t.api('POST', `/imports/${id}/validate`, { body: { options: { date_order: 'dmy' } } });
    assert.equal(dmy.body.summary.valid, 2);
    assert.equal(dmy.body.preview[0].observed_local_date, '2025-04-03');
    assert.equal(dmy.body.preview[0].current_price, 12.5);
    assert.equal(dmy.body.preview[0].discount_pct, 10);
    assert.equal(dmy.body.preview[1].current_price, 1250);
    const mdy = await t.api('POST', `/imports/${id}/validate`, { body: { options: { date_order: 'mdy' } } });
    assert.equal(mdy.body.preview[0].observed_local_date, '2025-03-04');
    assert.equal(mdy.body.summary.valid, 1); // 25/04 is not a month/day date
    assert.equal(mdy.body.batch.options.date_order, 'mdy');
  });

  it('honours the decimal comma option, the time zone option and missing dates', async () => {
    const content = ['Listing code,Observed at,Price', `${ownCode},2025-05-01 10:00,"1,250"`, `${ownCode},,7`].join('\n');
    const staged = await upload('observations', { name: 'opts.csv', content });
    const id = staged.body.batch.id;
    const plain = await t.api('POST', `/imports/${id}/validate`, { body: {} });
    assert.equal(plain.body.summary.valid, 1);
    assert.match(plain.body.errors[0].message, /observation date is missing/i);
    assert.equal(plain.body.preview[0].current_price, 1250);
    assert.equal(plain.body.preview[0].observed_at, '2025-05-01T06:00:00.000Z');
    const res = await t.api('POST', `/imports/${id}/validate`, { body: { options: { decimal_comma: true, timezone_mode: 'utc', allow_missing_dates: true, default_confidence: 0.5 } } });
    assert.equal(res.body.summary.valid, 2);
    assert.equal(res.body.preview[0].current_price, 1.25);
    assert.equal(res.body.preview[0].observed_at, '2025-05-01T10:00:00.000Z');
    assert.equal(res.body.preview[0].confidence, 0.5);
    assert.equal(res.body.preview[1].observed_basis, 'import_time');
    const bad = await t.api('POST', `/imports/${id}/validate`, { body: { options: { default_confidence: 7 } } });
    assert.equal(bad.status, 422);
  });
});

describe('finding the listing', () => {
  it('resolves listings by code, retailer item ID, URL, SKU, barcode or product code', async () => {
    const content = [
      'Listing code,Retailer,Market,Retailer item ID,Listing URL,SKU,GTIN,Product code,Observed at,Current price',
      `${ownCode},,,,,,,,2025-06-01 10:00,20`,
      ',Test Mart,AE,rival-oil-300,,,,,2025-06-01 10:00,30',
      `,Test Mart,AE,,${ownUrl},,,,2025-06-02 10:00,20`,
      ',Test Mart,UAE,,,OWN-200,,,2025-06-03 10:00,20',
      ',test mart,ae,,,,6291000000011,,2025-06-04 10:00,20',
      `,Test Mart,AE,,,,,${ownProductCode},2025-06-05 10:00,20`,
      ',Test Mart,,,,OWN-200,,,2025-06-06 10:00,20',
      ',Test Mart,SA,,,OWN-200,,,2025-06-07 10:00,20',
      `${ownCode},Test Mart,SA,,,,,,2025-06-08 10:00,20`,
      ',Test Mart,AE,,,OWN-200,,PRD-99999,2025-06-09 10:00,20',
      ',,,,,OWN-200,,,2025-06-10 10:00,20',
    ].join('\n');
    const res = await importFile('observations', 'resolve.csv', content);
    const v = res.validated;
    assert.equal(v.summary.valid, 6);
    assert.equal(v.summary.invalid, 5);
    assert.equal(v.summary.listings, 2);
    const byRow = Object.fromEntries(v.errors.map((e: any) => [e.row, e.message]));
    assert.match(byRow[8], /exists in several markets \(AE, SA\)/);
    assert.match(byRow[9], /is not listed at Test Mart/);
    assert.match(byRow[10], /belongs to Test Mart \(AE\), not to Test Mart \(SA\)/);
    assert.match(byRow[11], /No product with product code "PRD-99999"/);
    assert.match(byRow[12], /no retailer and no listing code/);
    assert.equal(res.committed.body.inserted, 6);
    const rows = t.ctx.db.all<{ listing_id: number; observed_at: string }>('SELECT listing_id, observed_at FROM price_observations WHERE import_batch_id = ? ORDER BY observed_at, id', [res.id]);
    assert.deepEqual(rows.map((r) => r.listing_id), [fx.ownListingId, fx.compListingId, fx.ownListingId, fx.ownListingId, fx.ownListingId, fx.ownListingId]);
    assert.equal(rows[0]!.observed_at, '2025-06-01T06:00:00.000Z'); // 10:00 in Dubai
  });

  it('creates missing listings only when asked to', async () => {
    const content = ['Retailer,Market,SKU,Date,Price', 'Test Mart,AE,OWN-SH-400,2025-07-01,35', 'Test Mart,AE,OWN-SH-400,2025-07-02,36'].join('\n');
    const staged = await upload('observations', { name: 'new-listing.csv', content });
    const id = staged.body.batch.id;
    const strict = await t.api('POST', `/imports/${id}/validate`, { body: {} });
    assert.equal(strict.body.summary.valid, 0);
    assert.match(strict.body.errors[0].message, /enable "create missing listings"/);
    const relaxed = await t.api('POST', `/imports/${id}/validate`, { body: { options: { create_missing_listings: true } } });
    assert.equal(relaxed.body.summary.valid, 2);
    assert.equal(relaxed.body.summary.listings_to_create, 1);
    assert.equal(relaxed.body.preview[0].new_listing, true);
    assert.equal(relaxed.body.preview[0].listing_code, null);
    assert.equal(t.ctx.db.scalar('SELECT COUNT(*) FROM retailer_listings WHERE product_id = ?', [unlistedProductId]), 0, 'validation creates nothing');
    const committed = await t.api('POST', `/imports/${id}/commit`);
    assert.equal(committed.body.listings_created, 1);
    assert.equal(committed.body.inserted, 2);
    const listing = t.ctx.db.get<Record<string, unknown>>('SELECT * FROM retailer_listings WHERE product_id = ?', [unlistedProductId])!;
    assert.equal(listing.retailer_id, fx.retailerId);
    assert.equal(listing.match_status, 'matched');
    assert.match(String(listing.code), /^LST-\d{6}$/);
    assert.equal(t.ctx.db.scalar('SELECT COUNT(*) FROM v_observations WHERE listing_id = ?', [listing.id as number]), 2);
    assert.equal(t.ctx.db.get<{ obs_count: number }>('SELECT obs_count FROM listing_state WHERE listing_id = ?', [listing.id as number])!.obs_count, 2);
  });
});

describe('Excel (.xlsx) import', () => {
  async function workbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Notes').addRow(['Prices collected by the field team']);
    const ws = wb.addWorksheet('Prices');
    ws.addRow(['Retailer', 'Market', 'SKU', 'Observed at', 'Regular price', 'Current price', 'Discount %', 'Availability']);
    ws.addRow(['Test Mart', 'AE', 'OWN-200', new Date(Date.UTC(2025, 6, 10, 9, 30, 0)), 20, 15, 0.25, 'In stock']);
    ws.getCell('D2').numFmt = 'yyyy-mm-dd hh:mm';
    ws.getCell('G2').numFmt = '0%';
    ws.addRow(['Test Mart', 'AE', 'OWN-200', new Date(Date.UTC(2025, 6, 11)), 20, { formula: 'E3', result: 20 }, null, 'In stock']);
    ws.getCell('D3').numFmt = 'yyyy-mm-dd';
    ws.addRow([]);
    ws.addRow(['Test Mart', 'AE', 'OWN-200', '12/07/2025', 20, 'n/a', null, 'OOS']);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('reads typed cells (dates, numbers, percentages, formulas) from the chosen worksheet', async () => {
    const staged = await upload('observations', { name: 'field prices.xlsx', content: await workbook() }, 'analyst');
    assert.equal(staged.status, 201, staged.raw);
    const id = staged.body.batch.id;
    assert.deepEqual(staged.body.sheets, ['Notes', 'Prices']);
    assert.equal(staged.body.sheet, 'Notes');
    const switched = await t.api('POST', `/imports/${id}/sheet`, { as: 'analyst', body: { sheet: 'Prices' } });
    assert.equal(switched.status, 200, switched.raw);
    assert.equal(switched.body.sheet, 'Prices');
    assert.equal(switched.body.row_count, 3);
    assert.deepEqual(switched.body.sample_rows[0], {
      Retailer: 'Test Mart', Market: 'AE', SKU: 'OWN-200', 'Observed at': '2025-07-10 09:30:00', 'Regular price': '20', 'Current price': '15', 'Discount %': '25%', Availability: 'In stock',
    });
    assert.equal(switched.body.suggested_mapping.observed_at, 'Observed at');
    assert.equal((await t.api('POST', `/imports/${id}/sheet`, { body: { sheet: 'Nope' } })).status, 422);

    const validated = await t.api('POST', `/imports/${id}/validate`, { as: 'analyst', body: { options: { date_order: 'dmy' } } });
    assert.equal(validated.status, 200, validated.raw);
    assert.equal(validated.body.summary.valid, 3);
    assert.equal(validated.body.batch.options.sheet, 'Prices');
    const [a, b, c] = validated.body.preview;
    assert.equal(a.observed_at, '2025-07-10T05:30:00.000Z'); // 09:30 Dubai wall-clock time
    assert.equal(a.observed_basis, 'exact');
    assert.equal(a.discount_pct, 25);
    assert.equal(a.is_promo, true);
    assert.equal(b.observed_basis, 'date_only');
    assert.equal(b.current_price, 20); // formula result
    assert.equal(c.row, 5); // the blank row is skipped but numbering follows the sheet
    assert.equal(c.availability, 'out_of_stock');
    assert.equal(c.observed_local_date, '2025-07-12');
    const committed = await t.api('POST', `/imports/${id}/commit`, { as: 'analyst' });
    assert.equal(committed.body.inserted, 3);
    const evidence = t.ctx.db.get<{ kind: string; mime_type: string }>('SELECT kind, mime_type FROM source_evidence WHERE id = ?', [committed.body.batch.evidence_id])!;
    assert.match(evidence.mime_type, /spreadsheetml/);
  });

  it('records what the figures were taken from (e.g. screenshots)', async () => {
    const content = ['Listing code,Date,Price', `${ownCode},2025-08-01,19`].join('\n');
    const res = await importFile('observations', 'from-screenshots.csv', content, { evidence_kind: 'screenshot', evidence_note: 'Transcribed from retailer screenshots (August)', default_confidence: 0.6 });
    assert.equal(res.committed.body.inserted, 1);
    const row = t.ctx.db.get<Record<string, unknown>>(
      `SELECT o.confidence, o.data_class, e.kind, e.note FROM price_observations o JOIN source_evidence e ON e.id = o.evidence_id WHERE o.import_batch_id = ?`,
      [res.id],
    )!;
    assert.deepEqual({ ...row }, { confidence: 0.6, data_class: 'imported', kind: 'screenshot', note: 'Transcribed from retailer screenshots (August)' });
  });

  it('round-trips: an Excel export imports back as "already recorded", to the millisecond', async () => {
    // live-style observations with millisecond timestamps
    ingestObservations(
      t.ctx,
      [
        { listing_id: fx.compListingId, observed_at: ago(2, 3), regular_price: 30, current_price: 24, availability: 'in_stock' },
        { listing_id: fx.compListingId, observed_at: ago(1, 5), regular_price: 30, current_price: 30, availability: 'limited' },
        { listing_id: fx.compListingId, observed_at: ago(0, 7), availability: 'out_of_stock' },
      ],
      { sourceMethod: 'manual', suppressAlerts: true },
    );
    const exported = await download(`/observations/export?format=xlsx&retailer_id=${fx.retailerId}`);
    assert.equal(exported.status, 200);
    const staged = await upload('observations', { name: 'export.xlsx', content: exported.buffer });
    assert.equal(staged.status, 201, staged.raw);
    assert.equal(staged.body.sheet, 'Price observations');
    assert.equal(staged.body.suggested_mapping.listing_code, 'Listing code');
    assert.equal(staged.body.suggested_mapping.observed_at, 'Observed at (UTC)');
    assert.equal(staged.body.suggested_options.timezone_mode, 'utc');
    const validated = await t.api('POST', `/imports/${staged.body.batch.id}/validate`, { body: {} });
    assert.equal(validated.status, 200, validated.raw);
    const s = validated.body.summary;
    assert.equal(s.invalid, 0, JSON.stringify(validated.body.errors));
    assert.ok(s.valid >= 15);
    assert.equal(s.already_in_ledger, s.valid);
    assert.equal(s.will_insert, 0);
    assert.equal(s.will_supersede, 0);
    const before = ledgerCount();
    const committed = await t.api('POST', `/imports/${staged.body.batch.id}/commit`);
    assert.equal(committed.body.inserted, 0);
    assert.equal(ledgerCount(), before);
  });

  it('round-trips a CSV export as well', async () => {
    const exported = await download(`/observations/export?format=csv&retailer_id=${fx.retailerId}`);
    const staged = await upload('observations', { name: 'export.csv', content: exported.buffer });
    const validated = await t.api('POST', `/imports/${staged.body.batch.id}/validate`, { body: {} });
    assert.equal(validated.body.summary.invalid, 0, JSON.stringify(validated.body.errors));
    assert.equal(validated.body.summary.will_insert, 0);
    assert.equal(validated.body.summary.already_in_ledger, validated.body.summary.valid);
  });
});

describe('voiding a committed import', () => {
  it('withdraws its observations (kept in the ledger) and brings back what it had replaced', async () => {
    const first = await importFile('observations', 'v1.csv', ['Listing code,Observed at,Price', `${ownCode},2025-09-01 10:00,50`, `${ownCode},2025-09-02 10:00,51`].join('\n'));
    assert.equal(first.committed.body.inserted, 2);
    const second = await importFile('observations', 'v2.csv', ['Listing code,Observed at,Price', `${ownCode},2025-09-01 10:00,55`, `${ownCode},2025-09-03 10:00,56`].join('\n'));
    assert.equal(second.validated.summary.will_supersede, 1);
    assert.equal(second.committed.body.inserted, 2);
    assert.equal(second.committed.body.superseded, 1);
    const priceAt = (date: string) =>
      t.ctx.db.get<{ current_price: number }>(`SELECT current_price FROM v_observations WHERE listing_id = ? AND observed_local_date = ?`, [fx.ownListingId, date])?.current_price;
    assert.equal(priceAt('2025-09-01'), 55);
    const total = ledgerCount();
    const stateBefore = t.ctx.db.get<{ obs_count: number }>('SELECT obs_count FROM listing_state WHERE listing_id = ?', [fx.ownListingId])!.obs_count;

    assert.equal((await t.api('POST', `/imports/${second.id}/void`, { as: 'analyst', body: { reason: 'wrong file' } })).status, 403);
    assert.equal((await t.api('POST', `/imports/${second.id}/void`, { body: { reason: '' } })).status, 422);
    const res = await t.api('POST', `/imports/${second.id}/void`, { body: { reason: 'Wrong currency in the source sheet' } });
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(
      { voided: res.body.observations_voided, restored: res.body.observations_restored, status: res.body.batch.status, reason: res.body.batch.void_reason },
      { voided: 2, restored: 1, status: 'voided', reason: 'Wrong currency in the source sheet' },
    );
    assert.equal(ledgerCount(), total, 'nothing is deleted from the ledger');
    assert.equal(priceAt('2025-09-01'), 50, 'the superseded observation applies again');
    assert.equal(priceAt('2025-09-03'), undefined);
    assert.equal(t.ctx.db.get<{ obs_count: number }>('SELECT obs_count FROM listing_state WHERE listing_id = ?', [fx.ownListingId])!.obs_count, stateBefore - 1);
    const voided = await t.api('GET', `/observations?import_batch_id=${second.id}&include_voided=true`);
    assert.equal(voided.body.total, 2);
    assert.ok(voided.body.rows.every((r: any) => r.voided === 1 && /Import #\d+ voided: Wrong currency/.test(r.void_reason)));
    assert.equal((await t.api('POST', `/imports/${second.id}/void`, { body: { reason: 'again' } })).status, 409);
    assert.equal((await t.api('POST', `/imports/${second.id}/commit`)).status, 409);
  });

  it('lists imports newest first and filters by kind', async () => {
    const res = await t.api('GET', '/imports?kind=observations&page_size=5');
    assert.equal(res.status, 200);
    assert.equal(res.body.rows.length, 5);
    assert.ok(res.body.total >= 8);
    assert.ok(res.body.rows[0].id > res.body.rows[1].id);
    assert.ok(res.body.rows.every((r: any) => r.kind === 'observations'));
    assert.equal((await t.api('GET', '/imports?status=voided')).body.total, 1);
    assert.equal((await t.api('GET', '/imports/999999')).status, 404);
    assert.equal((await t.api('GET', '/imports?kind=nonsense')).status, 400);
  });
});

describe('product import', () => {
  const csv = [
    'Product name,Brand,Brand ownership,Category,Subcategory,SKU,GTIN,Pack size,Pack unit,Units per pack,Markets,Status',
    'New Own Shampoo 400ml,Test Own,,Hair Oil,,NEW-SH-400,6291000000028,400,ML,1,AE|SA,active',
    'Rival Cream,New Rival Brand,competitor,Hair Care New,Hair Cream,RC-140,,140ml,,,UAE,',
    'Twin Pack,Test Own,,Hair Oil,,TP-2,,2x150g,,,,',
    ',Test Own,,Hair Oil,,X1,,,,,,',
    'Bad Unit,Test Own,,Hair Oil,,X2,,100,gallons,,,',
    'Bad Gtin,Test Own,,Hair Oil,,X3,12AB,,,,,',
    'Unknown Brand Product,Ghost Brand,,Hair Oil,,X4,,,,,,',
    'Existing,Test Own,,Hair Oil,,OWN-200,,200,ml,,,',
    'Twin Pack again,Test Own,,Hair Oil,,TP-2,,,,,,',
  ].join('\n');

  it('validates products and explains what is wrong', async () => {
    const staged = await upload('products', { name: 'products.csv', content: csv }, 'analyst');
    assert.equal(staged.status, 201, staged.raw);
    assert.equal(staged.body.suggested_mapping.name, 'Product name');
    assert.equal(staged.body.suggested_mapping.ownership, 'Brand ownership');
    const strict = await t.api('POST', `/imports/${staged.body.batch.id}/validate`, { as: 'analyst', body: {} });
    assert.equal(strict.status, 200, strict.raw);
    assert.deepEqual(
      { valid: strict.body.summary.valid, create: strict.body.summary.to_create, existing: strict.body.summary.already_in_ledger, dup: strict.body.summary.duplicates_in_file },
      { valid: 2, create: 2, existing: 1, dup: 1 },
    );
    const byRow = Object.fromEntries(strict.body.errors.map((e: any) => [e.row, e.message]));
    assert.match(byRow[3], /Brand "New Rival Brand" does not exist/);
    assert.match(byRow[5], /Product name is missing/);
    assert.match(byRow[6], /"gallons" is not a pack unit/);
    assert.match(byRow[7], /not a barcode/);
    assert.match(byRow[8], /Brand "Ghost Brand" does not exist/);
    assert.ok(strict.body.warnings.some((w: any) => w.row === 9 && /Already in the catalogue/.test(w.message)));
    assert.ok(strict.body.warnings.some((w: any) => w.row === 10 && /Same product/.test(w.message)));
    assert.equal(t.ctx.db.scalar(`SELECT COUNT(*) FROM products WHERE sku = 'NEW-SH-400'`), 0);
  });

  it('creates products, brands and categories on commit', async () => {
    const res = await importFile('products', 'products.csv', csv, { create_missing_brands: true, create_missing_categories: true });
    const v = res.validated;
    assert.deepEqual({ valid: v.summary.valid, brands: v.summary.brands_to_create, categories: v.summary.categories_to_create }, { valid: 3, brands: 1, categories: 2 });
    assert.match(v.errors.find((e: any) => e.row === 8).message, /is new: say whether it is an own brand or a competitor/);
    assert.equal(v.preview[1].new_brand, true);
    assert.equal(v.preview[1].pack, '140ml');
    assert.equal(v.preview[2].pack, '2 × 150g');
    assert.equal(res.committed.status, 200, res.committed.raw);
    assert.deepEqual({ inserted: res.committed.body.inserted, updated: res.committed.body.updated, status: res.committed.body.batch.status }, { inserted: 3, updated: 0, status: 'committed' });
    const product = (sku: string) =>
      t.ctx.db.get<Record<string, unknown>>(
        `SELECT p.*, b.name AS brand, b.ownership, c.name AS category, sc.name AS subcategory FROM products p JOIN brands b ON b.id = p.brand_id
         JOIN categories c ON c.id = p.category_id LEFT JOIN categories sc ON sc.id = p.subcategory_id WHERE p.sku = ?`,
        [sku],
      )!;
    const shampoo = product('NEW-SH-400');
    assert.match(String(shampoo.code), /^PRD-\d{5}$/);
    assert.deepEqual([shampoo.pack_size, shampoo.pack_unit, shampoo.units_per_pack, shampoo.gtin, shampoo.status], [400, 'ml', 1, '6291000000028', 'active']);
    const markets = t.ctx.db.all<{ code: string }>('SELECT m.code FROM product_markets pm JOIN markets m ON m.id = pm.market_id WHERE pm.product_id = ? ORDER BY m.code', [shampoo.id as number]);
    assert.deepEqual(markets.map((m) => m.code), ['AE', 'SA']);
    const cream = product('RC-140');
    assert.deepEqual([cream.brand, cream.ownership, cream.category, cream.subcategory, cream.pack_size, cream.pack_unit], ['New Rival Brand', 'competitor', 'Hair Care New', 'Hair Cream', 140, 'ml']);
    const twin = product('TP-2');
    assert.deepEqual([twin.pack_size, twin.pack_unit, twin.units_per_pack], [150, 'g', 2]);
    assert.equal(t.ctx.db.scalar(`SELECT COUNT(*) FROM audit_log WHERE action = 'brand.create'`), 1);
  });

  it('updates existing products only when asked, leaving blank cells untouched', async () => {
    const content = ['Product name,Brand,Category,SKU,GTIN,Pack size,Pack unit,Description', 'Own Oil 250ml Renamed,Test Own,Hair Oil,OWN-200,,250,ml,Updated via import'].join('\n');
    const skipped = await importFile('products', 'update.csv', content);
    assert.equal(skipped.validated.summary.valid, 0);
    assert.equal(skipped.committed.body.inserted + skipped.committed.body.updated, 0);
    const updated = await importFile('products', 'update.csv', content, { update_existing: true });
    assert.equal(updated.validated.summary.to_update, 1);
    assert.equal(updated.validated.preview[0].action, 'update');
    assert.equal(updated.committed.body.updated, 1);
    const row = t.ctx.db.get<Record<string, unknown>>('SELECT name, pack_size, gtin, description FROM products WHERE id = ?', [fx.ownProductId])!;
    assert.deepEqual({ ...row }, { name: 'Own Oil 250ml Renamed', pack_size: 250, gtin: '6291000000011', description: 'Updated via import' });
  });

  it('is closed to viewers', async () => {
    assert.equal((await upload('products', { name: 'p.csv', content: csv }, 'viewer')).status, 403);
  });
});

describe('templates', () => {
  it('offers CSV and Excel templates whose example rows are ignored by the importer', async () => {
    for (const kind of ['observations', 'products'] as const) {
      const csv = await download(`/imports/templates/${kind}.csv`, 'viewer');
      assert.equal(csv.status, 200);
      assert.match(String(csv.headers['content-disposition']), new RegExp(`${kind === 'observations' ? 'price' : 'product'}-import-template\\.csv`));
      const parsed = parseCsv(csv.buffer);
      assert.equal(parsed.rows.length, 2);
      assert.ok(Object.values(parsed.rows[0]!).some((v) => v.startsWith('EXAMPLE ROW')));

      const xlsx = await download(`/imports/templates/${kind}.xlsx`);
      assert.equal(xlsx.status, 200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.buffer as never);
      assert.deepEqual(wb.worksheets.map((w) => w.name), ['Import', 'Instructions']);

      for (const [name, content] of [[`${kind}.csv`, csv.buffer], [`${kind}.xlsx`, xlsx.buffer]] as const) {
        const staged = await upload(kind, { name, content });
        assert.equal(staged.status, 201, staged.raw);
        const validated = await t.api('POST', `/imports/${staged.body.batch.id}/validate`, { body: {} });
        assert.equal(validated.status, 200, validated.raw);
        assert.deepEqual(
          { valid: validated.body.summary.valid, invalid: validated.body.summary.invalid, examples: validated.body.summary.example_rows_skipped },
          { valid: 0, invalid: 0, examples: 2 },
          `${name} template`,
        );
      }
    }
    assert.equal((await download('/imports/templates/secrets.csv')).status, 400);
  });
});
