/** Reports: every figure comes from stored observations; CSV and Excel exports carry the same tables. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createFixture, createTestApp, ingestKnownPrices, type Fixture, type KnownPrices, type TestApp } from './helpers.ts';
import type { ReportResult, ReportSection } from '../shared/api/reports.ts';

let t: TestApp;
let fx: Fixture;
let known: KnownPrices;

before(async () => {
  t = await createTestApp();
  fx = createFixture(t.ctx);
  known = await ingestKnownPrices(t.ctx, fx);
});
after(async () => {
  await t.close();
});

async function generate(body: Record<string, unknown>, as: 'admin' | 'analyst' | 'viewer' = 'analyst'): Promise<ReportResult> {
  const res = await t.api('POST', '/reports/generate', { body, as });
  assert.equal(res.status, 200, res.raw.slice(0, 300));
  return res.body as ReportResult;
}
const section = (report: ReportResult, id: string): ReportSection => {
  const found = report.sections.find((s) => s.id === id);
  assert.ok(found, `section "${id}" is missing (have: ${report.sections.map((s) => s.id).join(', ')})`);
  return found;
};
async function download(query: string, as: 'admin' | 'analyst' | 'viewer' = 'analyst') {
  const res = await t.app.inject({ method: 'GET', url: `/api/reports/export?${query}`, headers: { authorization: `Bearer ${t.tokens[as]}` } });
  return { status: res.statusCode, headers: res.headers, buffer: res.rawPayload, text: res.body };
}

describe('report catalogue', () => {
  it('offers the six report types with the filters each one understands', async () => {
    const res = await t.api('GET', '/reports/types', { as: 'viewer' });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.rows.map((d: any) => d.type),
      ['weekly_competitor_pricing', 'monthly_market_pricing', 'brand_report', 'product_report', 'promotion_analysis', 'competitor_price_movement'],
    );
    const product = res.body.rows.find((d: any) => d.type === 'product_report');
    assert.deepEqual(product.required, ['product']);
    assert.ok(product.params.includes('period'));
    assert.equal(res.body.rows.find((d: any) => d.type === 'weekly_competitor_pricing').default_days, 7);
  });
});

describe('product report', () => {
  let report: ReportResult;
  before(async () => {
    report = await generate({ type: 'product_report', product_id: fx.ownProductId, days: 14 });
  });

  it('describes its scope, period and origin of the data', () => {
    assert.equal(report.type, 'product_report');
    assert.deepEqual(report.period, { from: known.date(13), to: known.today });
    assert.ok(report.scope.some((line) => line.includes('Own Oil 200ml')));
    assert.equal(report.generated_by, 'Test analyst');
    assert.equal(report.demo.any_demo, false);
    assert.ok(report.run_id);
  });

  it('lists the current price at every retailer with unit price and source', () => {
    const rows = section(report, 'current').table!.rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.retailer, 'Test Mart');
    assert.equal(rows[0]!.currency, 'AED');
    assert.equal(rows[0]!.price, 22);
    assert.equal(rows[0]!.unit_price, 11);
    assert.equal(rows[0]!.source, 'Manual entry');
    assert.equal(rows[0]!.observed, known.at(1));
  });

  it('computes the price statistics of the period', () => {
    const row = section(report, 'statistics').table!.rows[0]!;
    assert.equal(row.first, 20);
    assert.equal(row.last, 22);
    assert.equal(row.min, 17.6);
    assert.equal(row.max, 22);
    assert.equal(row.avg, 20.6);
    assert.equal(row.median, 21);
    assert.equal(row.change, 10);
    assert.equal(row.days, 6);
  });

  it('charts the stored daily prices', () => {
    const chart = section(report, 'history').chart!;
    assert.equal(chart.kind, 'line');
    assert.ok(chart.kind === 'line');
    assert.deepEqual(chart.series[0]!.points.map((p) => p.value), [20, 20, 22, 22, 17.6, 22]);
  });

  it('lists price changes, promotions and the competitor comparison', () => {
    const changes = section(report, 'changes').table!.rows;
    assert.deepEqual(changes.map((r) => r.change_pct).sort((a, b) => Number(a) - Number(b)), [-20, 10, 25]);
    const promos = section(report, 'promotions').table!.rows;
    assert.equal(promos.length, 1);
    assert.equal(promos[0]!.discount, 20);
    assert.equal(promos[0]!.pack, '200ml');
    assert.equal(promos[0]!.status, 'Ended');
    const comparison = section(report, 'competitors').table!.rows;
    const rival = comparison.find((r) => r.role === 'Competitor')!;
    assert.equal(rival.equivalence, 'Non-equivalent');
    assert.equal(rival.unit_price, 9);
    assert.equal(rival.gap_pct, 22.2);
    assert.match(String(rival.basis), /unit price/i);
  });

  it('is recorded in the list of generated reports', async () => {
    const runs = await t.api('GET', '/reports/runs', { as: 'viewer' });
    assert.equal(runs.status, 200);
    const run = runs.body.rows.find((r: any) => r.id === report.run_id);
    assert.equal(run.type, 'product_report');
    assert.equal(run.generated_by, 'Test analyst');
    assert.ok(run.row_count > 0);
  });
});

describe('other report types', () => {
  it('weekly competitor pricing: competitor moves, own moves and positioning', async () => {
    const report = await generate({ type: 'weekly_competitor_pricing' });
    assert.deepEqual(report.period, { from: known.date(6), to: known.today });
    const competitor = section(report, 'competitor_changes').table!.rows;
    assert.deepEqual(competitor.map((r) => [r.product, r.old_price, r.new_price, r.change_pct]), [[`Rival Oil 300ml AE-Test Mart`, 30, 27, -10]]);
    const own = section(report, 'own_changes').table!.rows;
    assert.deepEqual(own.map((r) => r.change_pct).sort((a, b) => Number(a) - Number(b)), [-20, 10, 25]);
    const overall = section(report, 'positioning').table!.rows.find((r) => r.group === 'Overall')!;
    assert.equal(overall.index, 122.2);
    assert.equal(overall.pairs, 1);
    const byBrand = section(report, 'competitor_by_brand').table!.rows;
    assert.deepEqual(byBrand.map((r) => [r.brand, r.increases, r.decreases]), [['Test Rival', 0, 1]]);
  });

  it('monthly market pricing: one row per market that has data, in its own currency', async () => {
    const report = await generate({ type: 'monthly_market_pricing' });
    const markets = section(report, 'markets').table!.rows;
    const uae = markets.find((r) => r.market === 'UAE')!;
    assert.equal(uae.currency, 'AED');
    assert.equal(uae.listings, 2);
    assert.equal(uae.price_increases, 2);
    assert.equal(uae.price_decreases, 2);
    assert.equal(uae.index, 122.2);
    assert.ok(report.notes.some((n) => /own currency/i.test(n)));
    const coverage = section(report, 'coverage').table!.rows.find((r) => r.market === 'UAE')!;
    assert.equal(coverage.real_runs, 0);
    assert.equal(coverage.sim_runs, 0);
  });

  it('brand report: needs a brand and reports its products', async () => {
    const missing = await t.api('POST', '/reports/generate', { body: { type: 'brand_report' }, as: 'analyst' });
    assert.equal(missing.status, 422);
    assert.match(missing.body.error.message, /brand/i);
    const report = await generate({ type: 'brand_report', brand_id: fx.ownBrandId });
    const current = section(report, 'current').table!.rows;
    assert.equal(current.length, 1);
    assert.equal(current[0]!.avg, 22);
    assert.equal(current[0]!.cheapest, 'Test Mart');
  });

  it('promotion analysis: discount depth by brand, retailer and type', async () => {
    const report = await generate({ type: 'promotion_analysis', days: 14 });
    const byBrand = section(report, 'by_brand').table!.rows;
    assert.equal(byBrand.length, 1);
    assert.equal(byBrand[0]!.episodes, 1);
    assert.equal(byBrand[0]!.avg, 20);
    assert.deepEqual(section(report, 'by_type').table!.rows.map((r) => r.name), ['Price cut']);
    assert.equal(section(report, 'episodes').table!.rows[0]!.discount, 20);
  });

  it('competitor price movement: competitor changes only, with the own products exposed to them', async () => {
    const report = await generate({ type: 'competitor_price_movement', days: 14 });
    const changes = section(report, 'changes').table!.rows;
    assert.deepEqual(changes.map((r) => r.brand), ['Test Rival']);
    const exposure = section(report, 'exposure').table!.rows;
    assert.equal(exposure.length, 1);
    assert.equal(exposure[0]!.own_price, 22);
    assert.equal(exposure[0]!.comp_price, 27);
    assert.equal(exposure[0]!.gap_pct, 22.2);
  });

  it('says so when the selection has no data instead of inventing rows', async () => {
    const kenya = t.ctx.db.get<{ id: number }>(`SELECT id FROM markets WHERE code = 'KE'`)!;
    const report = await generate({ type: 'weekly_competitor_pricing', market_id: kenya.id });
    assert.equal(section(report, 'competitor_changes').table!.rows.length, 0);
    assert.equal(section(report, 'own_changes').table!.rows.length, 0);
    assert.equal(report.demo.any_demo, false);
  });
});

describe('report parameters and permissions', () => {
  it('rejects unknown types, bad dates and inverted periods', async () => {
    assert.equal((await t.api('POST', '/reports/generate', { body: { type: 'nope' } })).status, 400);
    assert.equal((await t.api('POST', '/reports/generate', { body: { type: 'promotion_analysis', from: '17/11/2026' } })).status, 400);
    assert.equal((await t.api('POST', '/reports/generate', { body: { type: 'promotion_analysis', from: known.today, to: known.date(5) } })).status, 400);
    assert.equal((await t.api('POST', '/reports/generate', { body: { type: 'product_report' } })).status, 422);
    assert.equal((await t.api('POST', '/reports/generate', { body: { type: 'product_report', product_id: 987654 } })).status, 404);
    assert.equal((await t.api('POST', '/reports/generate', { body: { type: 'brand_report', brand_id: fx.ownBrandId, currency: 'ZZZ' } })).status, 400);
  });

  it('lets every signed-in role generate reports and nobody else', async () => {
    await generate({ type: 'promotion_analysis' }, 'viewer');
    assert.equal((await t.api('POST', '/reports/generate', { body: { type: 'promotion_analysis' }, as: null })).status, 401);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/reports/export?type=promotion_analysis' })).statusCode, 401);
  });
});

describe('report exports', () => {
  it('writes an Excel workbook with an About sheet, the summary, every table and the chart data', async () => {
    const res = await download(`type=product_report&product_id=${fx.ownProductId}&days=14&format=xlsx`);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /spreadsheetml/);
    assert.match(String(res.headers['content-disposition']), /attachment; filename="product-report-.*\.xlsx"/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer as never);
    const names = wb.worksheets.map((ws) => ws.name);
    assert.equal(names[0], 'About this report');
    for (const expected of ['Summary', 'Current prices', 'Price statistics by listing', 'Price changes', 'Promotions']) assert.ok(names.includes(expected), `sheet "${expected}" is missing (${names.join(', ')})`);
    assert.ok(names.some((n) => n.startsWith('Price history')), 'chart data sheet');

    const sheet = wb.getWorksheet('Price statistics by listing')!;
    let headerRow = 0;
    sheet.eachRow((row, n) => {
      if (!headerRow && row.getCell(1).value === 'Retailer · market') headerRow = n;
    });
    assert.ok(headerRow > 0);
    const headers = (sheet.getRow(headerRow).values as unknown[]).slice(1);
    const values = (sheet.getRow(headerRow + 1).values as unknown[]).slice(1);
    const cell = (label: string) => values[headers.indexOf(label)];
    assert.equal(cell('Average'), 20.6);
    assert.equal(cell('Lowest'), 17.6);
    assert.equal(cell('Highest'), 22);
    assert.ok(Math.abs(Number(cell('Change')) - 0.1) < 1e-9, 'percentages are stored as real fractions with a % format');

    const about = wb.getWorksheet('About this report')!;
    const text: string[] = [];
    about.eachRow((row) => row.eachCell((c) => text.push(String(c.value))));
    assert.ok(text.some((v) => v.includes('Own Oil 200ml')));
    assert.ok(text.some((v) => v.includes(known.today)) || text.some((v) => /\d{1,2} \w{3} \d{4}/.test(v)), 'the period is stated');
  });

  it('writes CSV with all tables, or one table when a section is named', async () => {
    const all = await download(`type=product_report&product_id=${fx.ownProductId}&days=14&format=csv`);
    assert.equal(all.status, 200);
    assert.match(String(all.headers['content-type']), /text\/csv/);
    assert.match(String(all.headers['content-disposition']), /\.csv"/);
    assert.ok(all.text.startsWith('﻿# Current prices\r\n'), 'UTF-8 BOM so Excel opens it correctly');
    assert.ok(all.text.includes('# Price statistics by listing\r\n'));
    assert.ok(all.text.includes('# Promotions\r\n'));
    assert.equal(all.text.split('﻿').length, 2, 'exactly one BOM');

    const one = await download(`type=product_report&product_id=${fx.ownProductId}&days=14&format=csv&section=statistics`);
    const lines = one.text.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.startsWith('Retailer · market,Currency,First,Latest,Lowest,Highest,Average,Median'));
    assert.ok(lines[1]!.startsWith('Test Mart · UAE,AED,20,22,17.6,22,20.6,21'));
  });

  it('rejects an unknown format and does not record exports as report runs', async () => {
    const before = (await t.api('GET', '/reports/runs')).body.rows.length;
    assert.equal((await download(`type=product_report&product_id=${fx.ownProductId}&format=pdf`)).status, 400);
    assert.equal((await download(`type=product_report&format=xlsx`)).status, 422);
    assert.equal((await download(`type=promotion_analysis&format=csv`, 'viewer')).status, 200);
    assert.equal((await t.api('GET', '/reports/runs')).body.rows.length, before);
  });
});
