import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { ago, createFixture, createTestApp, type Fixture, type TestApp } from './helpers.ts';
import { ingestObservations } from '../server/services/ingestion.ts';
import { setSecret } from '../server/services/core.ts';
import { localDate, nowIso } from '../server/lib/time.ts';
import { parseCsv, parseXlsx, toCsv } from '../server/lib/tabular.ts';
import { buildXlsx, sanitiseSheetName, writeXlsx } from '../server/services/export.ts';
import { databaseSheetNames, maybeAutoRefreshMirror, mirrorPath } from '../server/services/database-export.ts';
import type { RoleKey } from '../shared/constants.ts';

let t: TestApp;
let fx: Fixture;
let demoListingId: number;
let unmatchedListingId: number;

const TZ = 'Asia/Dubai';
/** Calendar date in Dubai `days` days ago. */
const day = (days: number) => localDate(new Date(Date.now() - days * 86_400_000), TZ);

async function multipart(
  url: string,
  fields: Record<string, string>,
  file?: { name: string; content: Buffer | string; type?: string },
  as: RoleKey = 'admin',
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append('file', new Blob([file.content], { type: file.type ?? 'application/octet-stream' }), file.name);
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  return t.api('POST', url, { body, headers: { 'content-type': encoded.headers.get('content-type')! }, as });
}

async function download(url: string, as: RoleKey = 'admin') {
  const res = await t.app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${t.tokens[as]}` } });
  return { status: res.statusCode, headers: res.headers, buffer: res.rawPayload, text: res.body };
}

async function loadWorkbook(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  return wb;
}

function sheetRows(wb: ExcelJS.Workbook, name: string): { headers: string[]; rows: Record<string, unknown>[] } {
  const ws = wb.getWorksheet(name);
  assert.ok(ws, `sheet ${name} exists`);
  let headers: string[] = [];
  const rows: Record<string, unknown>[] = [];
  ws.eachRow((row, rowNumber) => {
    const values = (row.values as unknown[]).slice(1);
    if (rowNumber === 1) headers = values.map((v) => String(v ?? ''));
    else rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] ?? null])));
  });
  return { headers, rows };
}

const allCellText = (wb: ExcelJS.Workbook) => {
  const parts: string[] = [];
  for (const ws of wb.worksheets) {
    ws.eachRow((row) => row.eachCell((cell) => parts.push(typeof cell.value === 'object' && cell.value !== null && !(cell.value instanceof Date) ? JSON.stringify(cell.value) : String(cell.value))));
  }
  return parts.join('\n');
};

before(async () => {
  t = await createTestApp();
  fx = createFixture(t.ctx);
  const { db } = t.ctx;
  const now = nowIso();
  // a DEMO listing and an unmatched listing at the same retailer
  demoListingId = db.run(
    `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, is_demo, created_at, updated_at)
     VALUES (?, ?, 'demo-item', 'https://demo.invalid/p/demo-item', 'Demo item', 'matched', 1, ?, ?)`,
    [fx.retailerId, fx.compProductId, now, now],
  ).lastInsertRowid;
  unmatchedListingId = db.run(
    `INSERT INTO retailer_listings (retailer_id, external_id, url, title, match_status, created_at, updated_at)
     VALUES (?, 'mystery-1', 'https://testmart.example/p/mystery-1', 'Mystery Oil 250ml', 'unmatched', ?, ?)`,
    [fx.retailerId, now, now],
  ).lastInsertRowid;

  // own listing: 10 daily prices, a promotion on days 6..4
  for (let d = 10; d >= 1; d--) {
    const promo = d <= 6 && d >= 4;
    ingestObservations(
      t.ctx,
      [{ listing_id: fx.ownListingId, observed_at: ago(d), regular_price: 20, current_price: promo ? 16 : 20, availability: 'in_stock', confidence: 0.9 }],
      { sourceMethod: 'manual', userId: 1, suppressAlerts: true },
    );
  }
  // competitor listing: imported history
  for (let d = 8; d >= 1; d--) {
    ingestObservations(t.ctx, [{ listing_id: fx.compListingId, observed_at: ago(d), current_price: 30 + d, availability: d === 2 ? 'out_of_stock' : 'in_stock' }], {
      sourceMethod: 'csv_import',
      suppressAlerts: true,
    });
  }
  ingestObservations(t.ctx, [{ listing_id: demoListingId, observed_at: ago(1), current_price: 9.5 }], { sourceMethod: 'simulated', suppressAlerts: true });
  ingestObservations(t.ctx, [{ listing_id: unmatchedListingId, observed_at: ago(1), current_price: 11 }], { sourceMethod: 'manual', suppressAlerts: true });
});

after(async () => {
  await t.close();
});

describe('GET /observations', () => {
  it('lists observations newest first with everything needed to display them', async () => {
    const res = await t.api('GET', '/observations');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 19); // 10 + 8 + 1 demo; the unmatched listing is excluded by default
    const first = res.body.rows[0];
    assert.ok(first.observed_at >= res.body.rows[1].observed_at);
    for (const key of ['listing_code', 'product_name', 'brand_name', 'retailer_name', 'market_code', 'timezone', 'currency_code', 'source_method', 'data_class', 'observed_local_date', 'unit_price']) {
      assert.ok(key in first, `row has ${key}`);
    }
    assert.equal(first.voided, 0);
  });

  it('includes observations of unmatched listings only on request', async () => {
    const res = await t.api('GET', '/observations?include_unmatched=true');
    assert.equal(res.body.total, 20);
  });

  it('paginates', async () => {
    const p1 = await t.api('GET', '/observations?page_size=7&page=1');
    const p3 = await t.api('GET', '/observations?page_size=7&page=3');
    assert.equal(p1.body.rows.length, 7);
    assert.equal(p1.body.pages, 3);
    assert.equal(p3.body.rows.length, 5);
    assert.notEqual(p1.body.rows[0].id, p3.body.rows[0].id);
  });

  it('filters by brand, ownership, retailer, date range, price range, promotion and data class', async () => {
    assert.equal((await t.api('GET', `/observations?brand_id=${fx.ownBrandId}`)).body.total, 10);
    assert.equal((await t.api('GET', '/observations?ownership=competitor')).body.total, 9);
    assert.equal((await t.api('GET', `/observations?retailer_id=${fx.retailerId}&product_id=${fx.ownProductId}`)).body.total, 10);
    assert.equal((await t.api('GET', '/observations?promo=true')).body.total, 3);
    assert.equal((await t.api('GET', '/observations?price_min=31&price_max=34')).body.total, 4);
    assert.equal((await t.api('GET', '/observations?data_class=imported')).body.total, 8);
    assert.equal((await t.api('GET', '/observations?data_class=simulated')).body.total, 1);
    assert.equal((await t.api('GET', '/observations?availability=out_of_stock')).body.total, 1);
    const ranged = await t.api('GET', `/observations?brand_id=${fx.ownBrandId}&from=${day(3)}&to=${day(1)}`);
    assert.ok(ranged.body.total >= 2 && ranged.body.total <= 4);
    for (const row of ranged.body.rows) assert.ok(row.observed_local_date >= day(3) && row.observed_local_date <= day(1));
    assert.equal((await t.api('GET', '/observations?sku=own-oil')).body.total, 10);
    assert.equal((await t.api('GET', '/observations?from=2026-13-01')).status, 400);
  });

  it('sorts by a whitelisted column', async () => {
    const asc = await t.api('GET', '/observations?sort=current_price&page_size=3');
    const desc = await t.api('GET', '/observations?sort=-current_price&page_size=3');
    assert.equal(asc.body.rows[0].current_price, 9.5);
    assert.equal(desc.body.rows[0].current_price, 38);
    // unknown sort keys fall back to the default instead of reaching SQL
    assert.equal((await t.api('GET', '/observations?sort=1;drop table x')).status, 200);
  });

  it('requires a session', async () => {
    assert.equal((await t.api('GET', '/observations', { as: null })).status, 401);
  });
});

describe('manual price entry', () => {
  it('records a price with a market-local date and time', async () => {
    const res = await t.api('POST', '/observations', {
      as: 'analyst',
      body: { listing_id: fx.ownListingId, observed_date: day(12), observed_time: '01:30', regular_price: 21, current_price: '21', availability: 'in_stock', note: 'Shelf check' },
    });
    assert.equal(res.status, 201, res.raw);
    const obs = res.body.observation;
    assert.equal(obs.source_method, 'manual');
    assert.equal(obs.data_class, 'manual');
    assert.equal(obs.observed_basis, 'exact');
    assert.equal(obs.observed_local_date, day(12));
    // 01:30 in Dubai (UTC+4) is 21:30 UTC on the previous day
    assert.match(obs.observed_at, /T21:30:00\.000Z$/);
    assert.equal(obs.confidence, 0.95);
    assert.equal(obs.note, 'Shelf check');
    assert.equal(obs.is_demo, 0);
    assert.ok(obs.entered_by);
  });

  it('flags date-only entries and uses local noon', async () => {
    const res = await t.api('POST', '/observations', { body: { listing_id: fx.ownListingId, observed_date: day(13), current_price: 21.5 } });
    assert.equal(res.status, 201, res.raw);
    assert.equal(res.body.observation.observed_basis, 'date_only');
    assert.match(res.body.observation.observed_at, /T08:00:00\.000Z$/);
  });

  it('accepts an exact ISO instant and inline evidence', async () => {
    const at = ago(14);
    const res = await t.api('POST', '/observations', {
      body: {
        listing_id: fx.ownListingId,
        observed_at: at,
        regular_price: 22,
        current_price: 17.6,
        promo_description: 'Weekend deal',
        evidence: { kind: 'url', reference: 'https://testmart.example/p/own-oil-200' },
      },
    });
    assert.equal(res.status, 201, res.raw);
    const obs = res.body.observation;
    assert.equal(obs.observed_at, at);
    assert.equal(obs.is_promo, 1);
    assert.equal(obs.discount_pct, 20);
    assert.ok(obs.evidence_id);
    const detail = await t.api('GET', `/observations/${obs.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.evidence.kind, 'url');
    assert.equal(detail.body.evidence.reference, 'https://testmart.example/p/own-oil-200');
    assert.equal(detail.body.entered_by.email, 'admin@test.local');
    assert.equal(detail.body.previous, null); // oldest observation of the listing
    assert.ok(detail.body.next.id);
    assert.equal(detail.body.void, null);
  });

  it('refuses an identical entry and leaves no trace of rejected ones', async () => {
    const at = ago(15);
    const body = { listing_id: fx.ownListingId, observed_at: at, current_price: 19 };
    assert.equal((await t.api('POST', '/observations', { body })).status, 201);
    const count = () => t.ctx.db.scalar<number>('SELECT COUNT(*) FROM price_observations')!;
    const evidence = () => t.ctx.db.scalar<number>('SELECT COUNT(*) FROM source_evidence')!;
    const before = [count(), evidence()];
    const dup = await t.api('POST', '/observations', { body: { ...body, evidence: { kind: 'note', reference: 'again' } } });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /identical observation/i);
    const invalid = await t.api('POST', '/observations', { body: { listing_id: fx.ownListingId, observed_at: ago(16), evidence: { kind: 'note', reference: 'x' } } });
    assert.equal(invalid.status, 422);
    assert.match(invalid.body.error.message, /selling price is required/);
    const future = await t.api('POST', '/observations', { body: { listing_id: fx.ownListingId, observed_date: day(-3), current_price: 5 } });
    assert.equal(future.status, 422);
    assert.match(future.body.error.message, /future/);
    const badDate = await t.api('POST', '/observations', { body: { listing_id: fx.ownListingId, observed_date: 'yesterday', current_price: 5 } });
    assert.equal(badDate.status, 422);
    assert.equal((await t.api('POST', '/observations', { body: { listing_id: 999999, current_price: 5 } })).status, 404);
    assert.deepEqual([count(), evidence()], before);
  });

  it('is not available to viewers', async () => {
    const res = await t.api('POST', '/observations', { as: 'viewer', body: { listing_id: fx.ownListingId, current_price: 5 } });
    assert.equal(res.status, 403);
  });
});

describe('void and restore', () => {
  let targetId: number;

  before(async () => {
    const res = await t.api('POST', '/observations', { body: { listing_id: fx.ownListingId, observed_at: ago(20), current_price: 99 } });
    targetId = res.body.observation.id;
  });

  it('only administrators can void, and a reason is required', async () => {
    assert.equal((await t.api('POST', `/observations/${targetId}/void`, { as: 'analyst', body: { reason: 'typo' } })).status, 403);
    assert.equal((await t.api('POST', `/observations/${targetId}/void`, { body: { reason: '' } })).status, 422);
    assert.equal((await t.api('POST', '/observations/999999/void', { body: { reason: 'nope' } })).status, 404);
  });

  it('voiding removes the observation from analytics but keeps it in the ledger', async () => {
    const before = (await t.api('GET', `/observations?listing_id=${fx.ownListingId}`)).body.total;
    const res = await t.api('POST', `/observations/${targetId}/void`, { body: { reason: 'Wrong price typed' } });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.observation.voided, 1);
    assert.equal(res.body.void.reason, 'Wrong price typed');
    assert.equal(res.body.void.voided_by_name, 'Test admin');
    assert.equal((await t.api('GET', `/observations?listing_id=${fx.ownListingId}`)).body.total, before - 1);
    const withVoided = await t.api('GET', `/observations?listing_id=${fx.ownListingId}&include_voided=true`);
    assert.equal(withVoided.body.total, before);
    const row = withVoided.body.rows.find((r: any) => r.id === targetId);
    assert.equal(row.voided, 1);
    assert.equal(row.void_reason, 'Wrong price typed');
    const only = await t.api('GET', '/observations?include_voided=only');
    assert.deepEqual(only.body.rows.map((r: any) => r.id), [targetId]);
    assert.equal(t.ctx.db.scalar('SELECT COUNT(*) FROM price_observations WHERE id = ?', [targetId]), 1);
    assert.equal((await t.api('POST', `/observations/${targetId}/void`, { body: { reason: 'again' } })).status, 409);
    const audit = t.ctx.db.get<{ action: string }>(`SELECT action FROM audit_log WHERE entity_type = 'observation' AND entity_id = ? ORDER BY id DESC`, [String(targetId)]);
    assert.equal(audit!.action, 'observation.void');
  });

  it('restores a voided observation', async () => {
    const res = await t.api('POST', `/observations/${targetId}/restore`);
    assert.equal(res.status, 200);
    assert.equal(res.body.observation.voided, 0);
    assert.equal((await t.api('POST', `/observations/${targetId}/restore`)).status, 409);
  });

  it('will not restore an observation that a newer record replaced', async () => {
    const at = ago(21);
    const first = await t.api('POST', '/observations', { body: { listing_id: fx.ownListingId, observed_at: at, current_price: 18 } });
    const second = await t.api('POST', '/observations', { body: { listing_id: fx.ownListingId, observed_at: at, current_price: 18.5 } });
    assert.equal(second.status, 201);
    assert.equal(second.body.superseded, 1);
    const detail = await t.api('GET', `/observations/${first.body.observation.id}`);
    assert.equal(detail.body.observation.voided, 1);
    assert.match(detail.body.void.reason, /Superseded/);
    const restore = await t.api('POST', `/observations/${first.body.observation.id}/restore`);
    assert.equal(restore.status, 409);
    assert.match(restore.body.error.message, new RegExp(`#${second.body.observation.id}`));
  });
});

describe('evidence files', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image body')]);
  let evidenceId: number;

  it('stores an uploaded screenshot by content hash', async () => {
    const res = await multipart('/evidence', { note: 'Shelf photo', captured_at: ago(2) }, { name: 'shelf photo.png', content: png, type: 'image/png' }, 'analyst');
    assert.equal(res.status, 201, res.raw);
    evidenceId = res.body.id;
    assert.equal(res.body.kind, 'screenshot');
    assert.equal(res.body.mime_type, 'image/png');
    assert.equal(res.body.size_bytes, png.length);
    assert.equal(res.body.has_file, true);
    assert.equal(res.body.note, 'Shelf photo');
    assert.ok(!('file_path' in res.body));
    assert.ok(fs.readdirSync(t.ctx.config.evidenceDir).some((f) => f === `${res.body.sha256}.png`));
  });

  it('serves the file to signed-in users only, with safe headers', async () => {
    const file = await download(`/evidence/${evidenceId}/file`, 'viewer');
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    assert.match(String(file.headers['content-disposition']), /^inline/);
    assert.ok(file.buffer.equals(png));
    assert.equal((await t.api('GET', `/evidence/${evidenceId}/file`, { as: null })).status, 401);
    assert.equal((await t.api('GET', '/evidence/999999/file')).status, 404);
  });

  it('rejects unsupported content regardless of the file name', async () => {
    const exe = await multipart('/evidence', {}, { name: 'photo.png', content: Buffer.from('MZ\u0000\u0000not an image'), type: 'image/png' });
    assert.equal(exe.status, 422);
    const html = await multipart('/evidence', {}, { name: 'page.html', content: '<script>alert(1)</script>', type: 'text/html' });
    assert.equal(html.status, 422);
    assert.equal((await multipart('/evidence', {}, { name: 'a.png', content: png }, 'viewer')).status, 403);
  });

  it('can be attached to a manual observation', async () => {
    const res = await t.api('POST', '/observations', { body: { listing_id: fx.compListingId, observed_at: ago(30), current_price: 41, evidence_id: evidenceId } });
    assert.equal(res.status, 201, res.raw);
    const meta = await t.api('GET', `/evidence/${evidenceId}`);
    assert.equal(meta.body.observation_count, 1);
    const bad = await t.api('POST', '/observations', { body: { listing_id: fx.compListingId, observed_at: ago(31), current_price: 41, evidence_id: 424242 } });
    assert.equal(bad.status, 422);
  });
});

describe('exports', () => {
  before(async () => {
    // a note that a spreadsheet would treat as a formula
    await t.api('POST', '/observations', { body: { listing_id: fx.compListingId, observed_at: ago(40), current_price: 44, note: '=HYPERLINK("http://evil.example","click")' } });
  });

  it('exports CSV with provenance columns, a DEMO marker and formula-injection protection', async () => {
    const res = await download('/observations/export?format=csv');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/csv/);
    assert.match(String(res.headers['content-disposition']), /attachment; filename="price-observations-\d+\.csv"/);
    assert.equal(res.buffer.subarray(0, 3).toString('hex'), 'efbbbf');
    const csv = parseCsv(res.buffer);
    for (const header of ['Listing code', 'Retailer', 'Current price', 'Observed at (UTC)', 'Market-local date', 'Time zone', 'Source method', 'Data class', 'Demo data', 'Confidence', 'Evidence', 'Unit price', 'Unit price basis']) {
      assert.ok(csv.headers.includes(header), `CSV has column ${header}`);
    }
    const total = (await t.api('GET', '/observations')).body.total;
    assert.equal(csv.rows.length, total);
    const demo = csv.rows.filter((r) => r['Demo data'] === 'DEMO');
    assert.equal(demo.length, 1);
    assert.equal(demo[0]!['Data class'], 'Simulated demo');
    const formula = csv.rows.find((r) => r.Note.includes('HYPERLINK'))!;
    assert.ok(formula.Note.startsWith("'="), 'formula is neutralised');
    const promo = csv.rows.find((r) => r['On promotion'] === 'Yes')!;
    assert.equal(promo['Discount %'], '20');
    assert.equal(promo['Unit price basis'], 'per 100ml');
    assert.match(promo['Observed at (UTC)']!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('applies the same filters as the list', async () => {
    const query = `brand_id=${fx.ownBrandId}&promo=true`;
    const res = await download(`/observations/export?format=csv&${query}`);
    const rows = parseCsv(res.buffer).rows;
    const listed = (await t.api('GET', `/observations?${query}`)).body;
    assert.equal(rows.length, listed.total);
    assert.ok(rows.length >= 3);
    assert.ok(rows.every((r) => r['On promotion'] === 'Yes' && r.Brand === 'Test Own'));
    assert.deepEqual(rows.map((r) => Number(r['Observation ID'])), listed.rows.map((r: any) => r.id));
    assert.equal((await download('/observations/export?format=pdf')).status, 400);
    assert.equal((await t.api('GET', '/observations/export', { as: null })).status, 401);
  });

  it('exports Excel with real dates and numbers and a provenance sheet', async () => {
    const res = await download(`/observations/export?format=xlsx&retailer_id=${fx.retailerId}`);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /spreadsheetml/);
    const wb = await loadWorkbook(res.buffer);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Price observations', 'Provenance']);
    const { headers, rows } = sheetRows(wb, 'Price observations');
    assert.ok(headers.includes('Observed at (UTC)'));
    assert.equal(rows.length, (await t.api('GET', `/observations?retailer_id=${fx.retailerId}`)).body.total);
    const first = rows[0]!;
    assert.ok(first['Observed at (UTC)'] instanceof Date);
    assert.equal(typeof first['Current price'], 'number');
    assert.equal(rows.filter((r) => r['Demo data'] === 'DEMO').length, 1);
    const promo = rows.find((r) => r['On promotion'] === 'Yes')!;
    assert.equal(promo['Discount %'], 0.2); // 20 % as a real percentage cell
    const note = rows.find((r) => String(r.Note ?? '').includes('HYPERLINK'))!;
    assert.equal(typeof note.Note, 'string'); // stored as text, not as a formula
    const provenance = allCellText(wb);
    assert.match(provenance, /Retailers: Test Mart/);
    assert.match(provenance, /WARNING: 1 of \d+ rows are DEMO DATA/);
    assert.match(provenance, /Test admin <admin@test.local>/);
    const ws = wb.getWorksheet('Price observations')!;
    assert.equal(ws.views[0]!.state, 'frozen');
    assert.ok(ws.autoFilter);
  });
});

describe('workbook writer and CSV helpers', () => {
  it('splits sheets beyond the row limit and sanitises sheet names', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ n: i + 1, label: `row ${i + 1}` }));
    const buffer = await buildXlsx(
      [{ name: 'Data: [2026]/*?', columns: [{ key: 'n', header: 'N', type: 'integer' }, { key: 'label', header: 'Label', type: 'text' }], rows }],
      { maxRowsPerSheet: 10 },
    );
    const wb = await loadWorkbook(buffer);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Data 2026', 'Data 2026 (2)', 'Data 2026 (3)']);
    assert.deepEqual(wb.worksheets.map((w) => w.rowCount), [11, 11, 6]);
    assert.equal(wb.worksheets[2]!.getRow(2).getCell(1).value, 21);
    assert.equal(sanitiseSheetName('x'.repeat(50)).length, 31);
    assert.equal(sanitiseSheetName('History'), 'History data');
  });

  it('writes to a file atomically and reads back through parseXlsx', async () => {
    const file = `${t.dataDir}/tmp-test/out.xlsx`;
    const summary = await writeXlsx(
      [
        {
          name: 'Prices',
          columns: [
            { key: 'at', header: 'Observed at', type: 'datetime' },
            { key: 'day', header: 'Day', type: 'date' },
            { key: 'price', header: 'Price', type: 'money' },
            { key: 'pct', header: 'Discount %', type: 'percent' },
            { key: 'text', header: 'Text', type: 'text' },
          ],
          rows: [{ at: '2026-03-14T09:26:53.589Z', day: '2026-03-14', price: 12.5, pct: 15, text: '  é ع 😀 <&> ' }],
        },
      ],
      file,
    );
    assert.deepEqual(summary.sheets, [{ name: 'Prices', rows: 1 }]);
    assert.equal(fs.statSync(file).size, summary.bytes);
    assert.deepEqual(fs.readdirSync(`${t.dataDir}/tmp-test`), ['out.xlsx']); // no temp file left behind
    const parsed = await parseXlsx(fs.readFileSync(file));
    assert.deepEqual(parsed.rows[0], { 'Observed at': '2026-03-14 09:26:53.589', Day: '2026-03-14', Price: '12.5', 'Discount %': '15%', Text: 'é ع 😀 <&>' });
  });

  it('parses delimited text robustly', () => {
    const semi = parseCsv('﻿a;b;c\r\n1;"x;y";3\r\n\r\n;;\r\n4;5\r\n');
    assert.equal(semi.delimiter, ';');
    assert.deepEqual(semi.rows, [{ a: '1', b: 'x;y', c: '3' }, { a: '4', b: '5', c: '' }]);
    assert.deepEqual(semi.rowNumbers, [2, 5]);
    assert.equal(parseCsv('a\tb\n1\t2\n').delimiter, '\t');
    const latin1 = parseCsv(Buffer.from('name,price\nCaf\xe9,5\n', 'latin1'));
    assert.equal(latin1.rows[0]!.name, 'Café');
    const dup = parseCsv('x,x,\n1,2,3\n');
    assert.deepEqual(dup.headers, ['x', 'x (2)']);
    const csv = toCsv([{ key: 'a', header: 'A' }], [{ a: '=1+1' }, { a: '-5.2' }, { a: -5.2 }, { a: '@x' }, { a: 'say "hi", ok' }]);
    assert.equal(csv, '﻿A\r\n\'=1+1\r\n-5.2\r\n-5.2\r\n\'@x\r\n"say ""hi"", ok"\r\n');
  });
});

describe('Excel database workbook', () => {
  before(() => {
    setSecret(t.ctx, `retailer:${fx.retailerId}:credential`, 'super-secret-token-123', 1);
    t.ctx.db.run(`UPDATE retailers SET connector_config = ? WHERE id = ?`, [JSON.stringify({ url: 'https://feeds.internal.example/prices?key=in-config' }), fx.retailerId]);
  });

  it('contains the whole database, one sheet per entity, for administrators', async () => {
    const res = await download('/database/export.xlsx');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /spreadsheetml/);
    assert.equal(Number(res.headers['content-length']), res.buffer.length);
    const wb = await loadWorkbook(res.buffer);
    const names = wb.worksheets.map((w) => w.name);
    assert.deepEqual(names, databaseSheetNames(true));
    for (const expected of ['README', 'Markets', 'Currencies', 'Exchange rates', 'Brands', 'Categories', 'Products', 'Product variants', 'Product markets', 'Competitor mappings', 'Retailers', 'Retailer listings', 'Price observations', 'Promotions', 'Price changes', 'Collection jobs', 'Alerts', 'Alert rules', 'Import batches', 'Source evidence', 'Users', 'Audit log', 'Data dictionary']) {
      assert.ok(names.includes(expected), `sheet ${expected}`);
    }
    const ledger = sheetRows(wb, 'Price observations');
    assert.equal(ledger.rows.length, t.ctx.db.scalar('SELECT COUNT(*) FROM price_observations'));
    assert.equal(ledger.rows.filter((r) => r.Voided === 'Yes').length, t.ctx.db.scalar('SELECT COUNT(*) FROM observation_voids'));
    assert.equal(ledger.rows.filter((r) => r['Demo data'] === 'DEMO').length, 1);
    const sample = ledger.rows.find((r) => r.Product && r['On promotion'] === 'Yes')!;
    assert.ok(sample['Observed at (UTC)'] instanceof Date);
    assert.equal(sample.Retailer, 'Test Mart');
    assert.equal(sample.Pack, '200ml');
    assert.equal(sample['Unit price basis'], 'per 100ml');
    assert.equal(typeof sample['Unit price'], 'number');
    assert.equal(sheetRows(wb, 'Markets').rows.length, 10);
    assert.equal(sheetRows(wb, 'Users').rows.length, 3);
    assert.ok(sheetRows(wb, 'Retailer listings').rows.some((r) => r['Listing code'] && typeof r['Latest current price'] === 'number'));
    assert.ok(sheetRows(wb, 'Promotions').rows.length >= 1);
    assert.ok(sheetRows(wb, 'Price changes').rows.length >= 2);
    const text = allCellText(wb);
    assert.match(text, /DEMO DATA NOTICE: 1 of/);
    assert.match(text, /relational database remains the system of record/);
    // readme lists every sheet with its row count
    const readme = wb.getWorksheet('README')!;
    let ledgerCount: unknown;
    readme.eachRow((row) => {
      if (row.getCell(1).value === 'Price observations') ledgerCount = row.getCell(2).value;
    });
    assert.equal(ledgerCount, ledger.rows.length);
    // data dictionary documents every column of every sheet
    const dictionary = wb.getWorksheet('Data dictionary')!;
    assert.ok(dictionary.rowCount > 200);
  });

  it('never contains password hashes, credentials or connector settings', async () => {
    const res = await download('/database/export.xlsx');
    const text = allCellText(await loadWorkbook(res.buffer));
    assert.ok(!text.includes('scrypt$'));
    assert.ok(!text.includes('super-secret-token-123'));
    assert.ok(!text.includes('in-config'));
    assert.ok(!/token_hash|ciphertext/.test(text));
  });

  it('leaves people data out for analysts and is closed to viewers', async () => {
    const res = await download('/database/export.xlsx', 'analyst');
    assert.equal(res.status, 200);
    const names = (await loadWorkbook(res.buffer)).worksheets.map((w) => w.name);
    assert.ok(!names.includes('Users') && !names.includes('Audit log'));
    assert.deepEqual(names, databaseSheetNames(false));
    assert.equal((await download('/database/export.xlsx', 'viewer')).status, 403);
    assert.equal((await t.api('GET', '/database/export.xlsx', { as: null })).status, 401);
    // nothing is left behind in the temporary export folder
    assert.deepEqual(fs.readdirSync(`${t.dataDir}/exports/tmp`), []);
  });
});

describe('Excel mirror', () => {
  it('reports that no mirror exists yet', async () => {
    const res = await t.api('GET', '/database/mirror');
    assert.equal(res.status, 200);
    assert.equal(res.body.exists, false);
    assert.equal(res.body.stale, true);
    assert.equal(res.body.generating, false);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.interval_minutes, 60);
    assert.equal(res.body.path, mirrorPath(t.ctx));
    assert.equal((await download('/database/mirror/download')).status, 404);
    assert.equal((await t.api('GET', '/database/mirror', { as: 'viewer' })).status, 403);
  });

  it('generates the mirror workbook on disk and serves it', async () => {
    const res = await t.api('POST', '/database/mirror/refresh', { as: 'analyst' });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.exists, true);
    assert.equal(res.body.stale, false);
    assert.ok(res.body.generated_at);
    assert.equal(res.body.observation_rows, t.ctx.db.scalar('SELECT COUNT(*) FROM price_observations'));
    assert.equal(res.body.last_error, null);
    assert.ok(fs.existsSync(mirrorPath(t.ctx)));
    assert.equal(fs.statSync(mirrorPath(t.ctx)).size, res.body.size_bytes);
    assert.deepEqual(fs.readdirSync(`${t.dataDir}/exports`).filter((f) => f.endsWith('.tmp')), []);
    const file = await download('/database/mirror/download', 'analyst');
    assert.equal(file.status, 200);
    const names = (await loadWorkbook(file.buffer)).worksheets.map((w) => w.name);
    assert.deepEqual(names, databaseSheetNames(false)); // the mirror never carries users or the audit log
  });

  it('becomes stale when the ledger changes and refreshes itself on the scheduler tick', async () => {
    const generatedAt = (await t.api('GET', '/database/mirror')).body.generated_at;
    await t.api('POST', '/observations', { body: { listing_id: fx.ownListingId, observed_at: ago(50), current_price: 23 } });
    assert.equal((await t.api('GET', '/database/mirror')).body.stale, true);
    // within the refresh interval nothing happens…
    assert.equal(maybeAutoRefreshMirror(t.ctx, new Date()), null);
    // …after the interval the stale mirror is regenerated
    const later = new Date(Date.now() + 61 * 60_000);
    const pending = maybeAutoRefreshMirror(t.ctx, later);
    assert.ok(pending);
    assert.equal((await t.api('GET', '/database/mirror')).body.generating, true);
    const status = await pending;
    assert.equal(status.stale, false);
    assert.notEqual(status.generated_at, generatedAt);
    // unchanged data is not re-exported
    assert.equal(maybeAutoRefreshMirror(t.ctx, new Date(Date.now() + 200 * 60_000)), null);
  });

  it('is wired to the scheduler tick and creates the first mirror automatically', async () => {
    const fresh = await createTestApp();
    try {
      assert.ok(fresh.ctx.hooks.schedulerTick.length >= 1);
      for (const handler of fresh.ctx.hooks.schedulerTick) handler(new Date());
      for (let i = 0; i < 100 && !fs.existsSync(mirrorPath(fresh.ctx)); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(fs.existsSync(mirrorPath(fresh.ctx)));
      const parsed = await parseXlsx(fs.readFileSync(mirrorPath(fresh.ctx)), 'Markets');
      assert.equal(parsed.rows.length, 10);
    } finally {
      await new Promise((r) => setTimeout(r, 50));
      await fresh.close();
    }
  });

  it('can be switched off', async () => {
    process.env.PIOS_EXCEL_MIRROR = 'off';
    try {
      assert.equal((await t.api('GET', '/database/mirror')).body.enabled, false);
      await t.api('POST', '/observations', { body: { listing_id: fx.ownListingId, observed_at: ago(51), current_price: 23 } });
      assert.equal(maybeAutoRefreshMirror(t.ctx, new Date(Date.now() + 500 * 60_000)), null);
    } finally {
      delete process.env.PIOS_EXCEL_MIRROR;
    }
  });
});
