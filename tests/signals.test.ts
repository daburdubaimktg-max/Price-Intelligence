/**
 * Observation signals — deal tags, rating, reviews, sales rank and seller stored with every observation —
 * and the Deals API built on them.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { ago, createFixture, createTestApp, ingestKnownPrices, type Fixture, type KnownPrices, type TestApp } from './helpers.ts';
import { Db, SqliteError } from '../server/db/sqlite.ts';
import { migrate } from '../server/db/migrate.ts';
import { localDate, nowIso } from '../server/lib/time.ts';
import { parseCsv } from '../server/lib/tabular.ts';
import { runRetailerNow } from '../server/services/collection/runner.ts';
import { rebuildAllDerived } from '../server/services/derived.ts';
import { parseCount, parseRating, parseSalesRank, parseTagCells, suggestMapping } from '../server/services/imports.ts';
import { ingestObservations, restoreObservation, voidObservation, type ObservationInput } from '../server/services/ingestion.ts';
import { demoObservation, simulateDays, stateOnDay, type DemoProfile } from '../server/seed/demo-model.ts';
import {
  DEAL_BADGE_TAGS, DEAL_OFFER_TAGS, DEAL_TAG_DESCRIPTIONS, DEAL_TAG_LABELS, DEAL_TAGS, dealTagFromLabel, isPriceCutWording, normaliseDealTags, parseDealTags,
  type DealTag, type RoleKey,
} from '../shared/constants.ts';
import type { DealRow, DealsResponse } from '../shared/api/deals.ts';

let t: TestApp;
let fx: Fixture;
let known: KnownPrices;

const TZ = 'Asia/Dubai';
/** Calendar date in Dubai `days` days ago. */
const day = (days: number) => localDate(new Date(Date.now() - days * 86_400_000), TZ);
const obsRow = (id: number) => t.ctx.db.get<Record<string, any>>('SELECT * FROM price_observations WHERE id = ?', [id])!;
const ledgerCount = () => t.ctx.db.scalar<number>('SELECT COUNT(*) FROM price_observations')!;
/** A count for every tag key: zero unless stated. */
const tagCounts = (counts: Partial<Record<DealTag, number>> = {}) => Object.fromEntries(DEAL_TAGS.map((tag) => [tag, counts[tag] ?? 0]));
const ingest = (inputs: ObservationInput[], sourceMethod: 'manual' | 'product_feed' | 'simulated' = 'manual') =>
  ingestObservations(t.ctx, inputs, { sourceMethod, suppressAlerts: true });

async function get(url: string, as: RoleKey | null = 'admin') {
  const res = await t.api('GET', url, { as });
  assert.equal(res.status, 200, `${url} → ${res.status} ${res.raw.slice(0, 300)}`);
  return res.body;
}

async function download(url: string, as: RoleKey = 'admin') {
  const res = await t.app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${t.tokens[as]}` } });
  return { status: res.statusCode, headers: res.headers, buffer: res.rawPayload };
}

async function upload(kind: string, file: { name: string; content: Buffer | string }, as: RoleKey = 'admin') {
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', new Blob([file.content]), file.name);
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  return t.api('POST', '/imports', { body, headers: { 'content-type': encoded.headers.get('content-type')! }, as });
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

before(async () => {
  t = await createTestApp();
  fx = createFixture(t.ctx);
  known = await ingestKnownPrices(t.ctx, fx);
});

after(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------------------------
// Wording → tag keys
// ---------------------------------------------------------------------------------------------
describe('deal tag wording', () => {
  it('names ten tags in a fixed order, each with a label and a one-line description', () => {
    assert.deepEqual([...DEAL_TAGS], ['limited_time_deal', 'event_deal', 'lowest_price', 'deal', 'coupon', 'multi_buy', 'best_seller', 'retailer_choice', 'selling_fast', 'other']);
    assert.deepEqual(DEAL_TAG_LABELS, {
      limited_time_deal: 'Limited-time deal',
      event_deal: 'Sale-event deal',
      lowest_price: 'Lowest price in N days',
      deal: 'Deal',
      coupon: 'Coupon / extra discount',
      multi_buy: 'Multi-buy offer',
      best_seller: 'Best seller',
      retailer_choice: "Retailer's choice",
      selling_fast: 'Selling fast',
      other: 'Other tag',
    });
    for (const tag of DEAL_TAGS) {
      assert.ok(DEAL_TAG_DESCRIPTIONS[tag].length > 20 && !DEAL_TAG_DESCRIPTIONS[tag].includes('\n'), `description of ${tag}`);
      assert.equal(dealTagFromLabel(DEAL_TAG_LABELS[tag]), tag, 'a label reads back as its key');
      assert.equal(dealTagFromLabel(tag), tag);
    }
    // every tag is either an offer or a badge
    assert.deepEqual([...DEAL_OFFER_TAGS], ['limited_time_deal', 'event_deal', 'lowest_price', 'deal', 'coupon', 'multi_buy']);
    assert.deepEqual([...DEAL_BADGE_TAGS], ['best_seller', 'retailer_choice', 'selling_fast', 'other']);
    assert.deepEqual([...DEAL_OFFER_TAGS, ...DEAL_BADGE_TAGS].sort(), [...DEAL_TAGS].sort());
  });

  it('maps English and Arabic retailer wording to tag keys', () => {
    const cases: Array<[string, DealTag[]]> = [
      // limited time
      ['Limited time deal', ['limited_time_deal']],
      ['عرض لفترة محدودة', ['limited_time_deal']],
      ['عرض لمدة محدودة', ['limited_time_deal']],
      ['Lightning deal', ['limited_time_deal']],
      ['Flash Sale', ['limited_time_deal']],
      // sale events
      ['Early Yellow Friday Deal ⏳', ['event_deal']],
      ['White Friday', ['event_deal']],
      ['Black Friday Deal', ['event_deal']],
      ['Ramadan offers', ['event_deal']],
      ['Eid Deals', ['event_deal']],
      ['Prime Day', ['event_deal']],
      ['11.11', ['event_deal']],
      ['11.11 Sale', ['event_deal']],
      ['الجمعة الصفراء', ['event_deal']],
      ['الجمعة البيضاء', ['event_deal']],
      ['عروض رمضان', ['event_deal']],
      ['عروض العيد', ['event_deal']],
      // the retailer's own "lowest price of a period" statement
      ['Lowest price in 30 days', ['lowest_price']],
      ['Lowest price in 7 days', ['lowest_price']],
      ['Lowest price in a year', ['lowest_price']],
      ['lowest price this year', ['lowest_price']],
      ['Lowest price this month', ['lowest_price']],
      ['lowest in 30 days', ['lowest_price']],
      ['أقل سعر خلال 30 يوم', ['lowest_price']],
      ['أقل سعر في 30 يوم', ['lowest_price']],
      // general deal badge
      ['Deal', ['deal']],
      ['Deal of the day', ['deal']],
      ['Mega Deal', ['deal']],
      ['Lowest price guaranteed', ['deal']],
      ['صفقة اليوم', ['deal']],
      // coupons and extra discounts
      ['coupon', ['coupon']],
      ['Extra 10% off', ['coupon']],
      ['Extra 15% off', ['coupon']],
      ['Extra \uE001 2 Off!', ['coupon']],
      ['Save 10% with coupon', ['coupon']],
      ['قسيمة', ['coupon']],
      ['خصم إضافي 10%', ['coupon']],
      // multi-buy
      ['Buy 2 get 1 free', ['multi_buy']],
      ['Buy 3 For 27.38 AED', ['multi_buy']],
      ['Buy 3 For 29.99 SAR', ['multi_buy']],
      ['2 for', ['multi_buy']],
      ['3 for 2', ['multi_buy']],
      ['اشتر 2 واحصل على 1 مجاناً', ['multi_buy']],
      ['واحصل على واحدة مجاناً', ['multi_buy']],
      // best seller
      ['Best seller', ['best_seller']],
      ['#1 Best Seller', ['best_seller']],
      ['الأكثر مبيعاً', ['best_seller']],
      ['الأكثر مبيعًا', ['best_seller']],
      ['الأعلى مبيعاً', ['best_seller']],
      // retailer's choice
      ["Amazon's Choice", ['retailer_choice']],
      ['Amazon\u2019s Choice', ['retailer_choice']],
      ['amazons-choice', ['retailer_choice']],
      ['خيار أمازون', ['retailer_choice']],
      // demand and stock signals
      ['Selling out fast', ['selling_fast']],
      ['selling fast', ['selling_fast']],
      ['almost gone', ['selling_fast']],
      ['few left', ['selling_fast']],
      ['Only 3 left in stock', ['selling_fast']],
      ['low stock', ['selling_fast']],
      ['يباع بسرعة', ['selling_fast']],
      ['الكمية محدودة', ['selling_fast']],
      // wording the real datasets carry
      ['Early Yellow Friday Deal', ['event_deal']],
      ['Limited time deal (عرض لمدة محدودة)', ['limited_time_deal']],
    ];
    for (const [wording, expected] of cases) assert.deepEqual(normaliseDealTags([wording]), expected, wording);
  });

  it('treats a plain price cut as a lower price, not as a tag', () => {
    for (const wording of ['Save 30%', 'وفر 28%', '30% off', '-30%', 'خصم 30%', 'Save AED 5.00', 'Was 25.00 now 20.00', 'Was 11.11', '', '   ', '⏳']) {
      assert.deepEqual(normaliseDealTags([wording]), [], JSON.stringify(wording));
      assert.equal(isPriceCutWording(wording), true, JSON.stringify(wording));
    }
    assert.equal(isPriceCutWording('Limited time deal'), false);
    assert.deepEqual(normaliseDealTags([]), []);
    assert.deepEqual(normaliseDealTags([null, undefined, 'Save 39%']), []);
  });

  it('keeps unrecognised wording as "other" and combines several badges sensibly', () => {
    assert.deepEqual(normaliseDealTags(['Free delivery']), ['other']);
    assert.deepEqual(normaliseDealTags(['سعيد']), ['other'], 'an Arabic word that merely contains "Eid" is not a sale event');
    assert.deepEqual(normaliseDealTags(['Pack of 2 for sensitive teeth']), ['other'], 'a product title is not a multi-buy offer');
    // canonical order, no duplicates
    assert.deepEqual(normaliseDealTags(['Best seller', "Amazon's Choice", 'Limited time deal', 'Best Seller']), ['limited_time_deal', 'best_seller', 'retailer_choice']);
    // what one real listing showed: a sale-event tag, an extra discount and a plain price cut
    assert.deepEqual(normaliseDealTags(['Early Yellow Friday Deal ⏳', 'Extra 10% off', 'Save 39%']), ['event_deal', 'coupon']);
    assert.deepEqual(normaliseDealTags(['عرض لمدة محدودة', 'وفر 28%']), ['limited_time_deal']);
    // the general "deal" key gives way to a more specific offer tag; "other" only stands alone
    assert.deepEqual(normaliseDealTags(['Deal', 'Limited time deal']), ['limited_time_deal']);
    assert.deepEqual(normaliseDealTags(['Deal', 'Lowest price in 30 days']), ['lowest_price']);
    assert.deepEqual(normaliseDealTags(['Lowest price in 7 days', 'Limited time deal', 'Selling out fast']), ['limited_time_deal', 'lowest_price', 'selling_fast']);
    assert.deepEqual(normaliseDealTags(['Deal', 'Best seller']), ['deal', 'best_seller']);
    assert.deepEqual(normaliseDealTags(['Deal', 'Selling out fast']), ['deal', 'selling_fast'], 'a badge does not replace the deal badge');
    assert.deepEqual(normaliseDealTags(['Only 2 days left']), ['other'], 'a countdown is not a stock signal');
    assert.deepEqual(normaliseDealTags(['Limited time deal', 'Free delivery']), ['limited_time_deal']);
    // keys and labels are understood as they are
    assert.deepEqual(normaliseDealTags(['limited_time_deal', 'Coupon / extra discount', 'Other tag']), ['limited_time_deal', 'coupon']);
    assert.equal(dealTagFromLabel('Sale-event deal'), 'event_deal');
    assert.equal(dealTagFromLabel('multi_buy'), 'multi_buy');
    assert.equal(dealTagFromLabel('Yellow Friday'), null);
  });

  it('reads the stored form of the tags defensively', () => {
    assert.deepEqual(parseDealTags('["best_seller","limited_time_deal","best_seller","bogus"]'), ['limited_time_deal', 'best_seller']);
    assert.deepEqual(parseDealTags('[]'), []);
    assert.deepEqual(parseDealTags(null), []);
    assert.deepEqual(parseDealTags('not json'), []);
    assert.deepEqual(parseDealTags(['coupon', 'deal']), ['deal', 'coupon']);
  });
});

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------
describe('signals in the ledger', () => {
  let taggedId: number;

  it('stores tags, tag wording, rating, reviews, sales rank and seller with the observation', () => {
    const res = ingest([
      {
        listing_id: fx.compListingId,
        observed_at: known.at(3),
        current_price: 27,
        regular_price: 27,
        availability: 'in_stock',
        tags: ['best_seller', 'limited_time_deal', 'best_seller'],
        tag_text: '  Early Yellow   Friday Deal \uE001 ',
        rating: 4.456,
        review_count: 1280,
        sales_rank: 3,
        sales_rank_label: ' #3 in Hair Oils ',
        seller_name: 'S'.repeat(250),
      },
    ]);
    assert.equal(res.inserted, 1, JSON.stringify(res.rejected));
    taggedId = res.observationIds[0]!;
    const row = obsRow(taggedId);
    assert.equal(row.tags, '["limited_time_deal","best_seller"]', 'de-duplicated, canonical order, stored as a JSON list');
    assert.equal(row.tag_text, 'Early Yellow Friday Deal', 'trimmed, one line, icon-font glyph removed');
    assert.equal(row.rating, 4.46);
    assert.equal(row.review_count, 1280);
    assert.equal(row.sales_rank, 3);
    assert.equal(row.sales_rank_label, '#3 in Hair Oils');
    assert.equal(row.seller_name.length, 200, 'long text is cut at 200 characters');
    // the tag alone does not make the observation promotional
    assert.equal(row.is_promo, 0);
  });

  it('rejects a row with an unknown tag or an impossible figure, with a clear reason', () => {
    const before = ledgerCount();
    const base = { listing_id: fx.compListingId, observed_at: known.at(2), current_price: 27, regular_price: 27, availability: 'in_stock' as const };
    const res = ingest([
      { ...base, tags: ['flash' as DealTag] },
      { ...base, tags: 'deal' as unknown as DealTag[] },
      { ...base, rating: 5.1 },
      { ...base, rating: -1 },
      { ...base, review_count: -1 },
      { ...base, review_count: 12.5 },
      { ...base, sales_rank: -2 },
      { ...base, sales_rank: 1.5 },
    ]);
    assert.equal(res.inserted, 0);
    assert.equal(ledgerCount(), before);
    const reasons = res.rejected.map((r) => r.reason);
    assert.equal(reasons.length, 8);
    assert.equal(reasons[0], `Unknown deal tag "flash" (use: ${DEAL_TAGS.join(', ')})`);
    assert.match(reasons[1]!, /Tags must be a list of tag keys/);
    assert.match(reasons[2]!, /Rating must be between 0 and 5/);
    assert.match(reasons[3]!, /Rating must be between 0 and 5/);
    assert.match(reasons[4]!, /Review count must be a whole number of 0 or more/);
    assert.match(reasons[5]!, /Review count must be a whole number of 0 or more/);
    assert.match(reasons[6]!, /Sales rank must be a whole number of 0 or more/);
    assert.match(reasons[7]!, /Sales rank must be a whole number of 0 or more/);
  });

  it('accepts zero values and leaves observations without signals untagged', () => {
    const res = ingest([
      { listing_id: fx.compListingId, observed_at: known.at(2), current_price: 27, regular_price: 27, availability: 'in_stock', rating: 0, review_count: 0, sales_rank: 0, tags: [], tag_text: '   ' },
    ]);
    assert.equal(res.inserted, 1, JSON.stringify(res.rejected));
    const row = obsRow(res.observationIds[0]!);
    assert.equal(row.tags, '[]');
    assert.equal(row.tag_text, null);
    assert.equal(row.rating, 0);
    assert.equal(row.review_count, 0);
    assert.equal(row.sales_rank, null, 'ranks start at 1: 0 means "not ranked"');
    // observations recorded without any signal (the whole fixture history)
    const plain = obsRow(known.promoObservationId);
    assert.deepEqual(
      [plain.tags, plain.tag_text, plain.rating, plain.review_count, plain.sales_rank, plain.sales_rank_label, plain.seller_name],
      ['[]', null, null, null, null, null, null],
    );
  });

  it('keeps signals out of the identity of an observation: the same fact is stored once', () => {
    const before = ledgerCount();
    const res = ingest([
      { listing_id: fx.compListingId, observed_at: known.at(3), current_price: 27, regular_price: 27, availability: 'in_stock', tags: ['coupon'], rating: 1, seller_name: 'Somebody else' },
    ]);
    assert.deepEqual({ inserted: res.inserted, duplicates: res.duplicates, superseded: res.superseded }, { inserted: 0, duplicates: 1, superseded: 0 });
    assert.equal(ledgerCount(), before);
    const row = obsRow(taggedId);
    assert.equal(row.tags, '["limited_time_deal","best_seller"]');
    assert.equal(row.rating, 4.46);
  });

  it('stays append-only, and derived state can still be rebuilt from the ledger', () => {
    assert.throws(
      () => t.ctx.db.run(`UPDATE price_observations SET tags = '["deal"]' WHERE id = ?`, [taggedId]),
      (err: unknown) => err instanceof SqliteError && /append-only/.test(err.message),
    );
    assert.throws(
      () => t.ctx.db.run(`INSERT INTO price_observations (listing_id, retailer_id, market_id, currency_code, current_price, observed_at, observed_local_date, collected_at, source_method, dedupe_key, created_at, tags)
        SELECT listing_id, retailer_id, market_id, currency_code, current_price, observed_at, observed_local_date, collected_at, source_method, 'not-a-list', created_at, 'limited_time_deal' FROM price_observations WHERE id = ?`, [taggedId]),
      (err: unknown) => err instanceof SqliteError && err.code === 'CHECK',
      'the tags column only accepts a JSON list',
    );
    const state = () => t.ctx.db.all('SELECT listing_id, latest_obs_id, prev_obs_id, obs_count, last_price_change_at FROM listing_state ORDER BY listing_id');
    const events = () => t.ctx.db.scalar<number>('SELECT COUNT(*) FROM price_events');
    const beforeState = state();
    const beforeEvents = events();
    assert.ok(rebuildAllDerived(t.ctx) >= 2);
    assert.deepEqual(state(), beforeState);
    assert.equal(events(), beforeEvents);
  });
});

// ---------------------------------------------------------------------------------------------
// Observations API and manual entry
// ---------------------------------------------------------------------------------------------
describe('signals in the observations API', () => {
  it('returns the signals with each observation, tags as a list', async () => {
    const list = await get(`/observations?listing_id=${fx.compListingId}&sort=observed_at`);
    const tagged = list.rows.find((r: any) => r.observed_at === known.at(3));
    assert.deepEqual(tagged.tags, ['limited_time_deal', 'best_seller']);
    assert.equal(tagged.tag_text, 'Early Yellow Friday Deal');
    assert.equal(tagged.rating, 4.46);
    assert.equal(tagged.review_count, 1280);
    assert.equal(tagged.sales_rank, 3);
    assert.equal(tagged.sales_rank_label, '#3 in Hair Oils');
    const untagged = list.rows.find((r: any) => r.observed_at === known.at(10));
    assert.deepEqual(untagged.tags, []);
    assert.equal(untagged.rating, null);
    const detail = await get(`/observations/${tagged.id}`);
    assert.deepEqual(detail.observation.tags, ['limited_time_deal', 'best_seller']);
    assert.equal(detail.observation.seller_name.length, 200);
  });

  it('filters observations by tag (any of the keys) and refuses unknown keys', async () => {
    const limited = await get('/observations?tag=limited_time_deal');
    assert.equal(limited.total, 1);
    assert.equal(limited.rows[0].observed_at, known.at(3));
    assert.equal((await get('/observations?tag=coupon')).total, 0);
    const either = await get('/observations?tag=coupon,best_seller');
    assert.equal(either.total, 1);
    assert.equal((await get(`/observations?tag=best_seller&listing_id=${fx.ownListingId}`)).total, 0);
    const bad = await t.api('GET', '/observations?tag=limited_time_deal,flash');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /Unknown deal tag "flash"/);
    // the history summary uses the same filter
    assert.equal((await get('/history/summary?tag=limited_time_deal')).observations, 1);
  });

  it('accepts signals on a manually entered price', async () => {
    const res = await t.api('POST', '/observations', {
      as: 'analyst',
      body: {
        listing_id: fx.ownListingId, observed_at: known.at(3), current_price: 21, regular_price: 22,
        tags: ['coupon'], tag_text: 'Extra 10% off', rating: 4.2, review_count: 55, sales_rank: 12, sales_rank_label: '#12 in Hair Oils', seller_name: 'Test Mart',
      },
    });
    assert.equal(res.status, 201, res.raw);
    const o = res.body.observation;
    assert.deepEqual(o.tags, ['coupon']);
    assert.deepEqual([o.tag_text, o.rating, o.review_count, o.sales_rank, o.sales_rank_label, o.seller_name], ['Extra 10% off', 4.2, 55, 12, '#12 in Hair Oils', 'Test Mart']);
    assert.equal(o.data_class, 'manual');
    assert.equal(obsRow(o.id).tags, '["coupon"]');
  });

  it('reads the tag from the wording when no tag is ticked, and refuses unknown tags', async () => {
    const worded = await t.api('POST', '/observations', {
      as: 'analyst',
      body: { listing_id: fx.ownListingId, observed_at: known.at(5), current_price: 22, regular_price: 22, tag_text: 'عرض لمدة محدودة' },
    });
    assert.equal(worded.status, 201, worded.raw);
    assert.deepEqual(worded.body.observation.tags, ['limited_time_deal']);
    assert.equal(worded.body.observation.tag_text, 'عرض لمدة محدودة');

    const before = ledgerCount();
    const bad = await t.api('POST', '/observations', {
      as: 'analyst',
      body: { listing_id: fx.ownListingId, observed_at: known.at(7), current_price: 22, tags: ['flash'] },
    });
    assert.equal(bad.status, 422);
    assert.match(bad.body.error.message, /Unknown deal tag "flash"/);
    const badRating = await t.api('POST', '/observations', {
      as: 'analyst',
      body: { listing_id: fx.ownListingId, observed_at: known.at(7), current_price: 22, rating: 7 },
    });
    assert.equal(badRating.status, 422);
    assert.match(badRating.body.error.message, /Rating must be between 0 and 5/);
    assert.equal(ledgerCount(), before);
    const viewer = await t.api('POST', '/observations', { as: 'viewer', body: { listing_id: fx.ownListingId, observed_at: known.at(7), current_price: 22, tags: ['deal'] } });
    assert.equal(viewer.status, 403);
  });
});

// ---------------------------------------------------------------------------------------------
// Live monitor
// ---------------------------------------------------------------------------------------------
describe('signals in the live monitor', () => {
  let stale: Fixture;

  before(() => {
    const res = ingest([
      // the rival's latest observation: two offer tags
      { listing_id: fx.compListingId, observed_at: known.at(1), current_price: 27, regular_price: 27, availability: 'in_stock', tags: ['coupon', 'limited_time_deal'], tag_text: 'Limited time deal', rating: 4.4, review_count: 1300, sales_rank: 2, sales_rank_label: '#2 in Hair Oils', seller_name: 'Test Mart' },
      // the own listing's latest observation: a badge only
      { listing_id: fx.ownListingId, observed_at: ago(0, 2), current_price: 22, regular_price: 22, availability: 'in_stock', tags: ['best_seller'], rating: 4.7, review_count: 90 },
    ]);
    assert.equal(res.inserted, 2, JSON.stringify(res.rejected));
    // A source collected daily goes stale after two days: its tags say nothing about today.
    stale = createFixture(t.ctx, { retailerName: 'Stale Feed Mart', method: 'product_feed' });
    const old = ingest([{ listing_id: stale.ownListingId, observed_at: known.at(4), current_price: 10, regular_price: 20, availability: 'in_stock', tags: ['deal', 'best_seller'], tag_text: 'Deal' }], 'product_feed');
    assert.equal(old.inserted, 1, JSON.stringify(old.rejected));
  });

  it('shows the signals of the latest observation on each row', async () => {
    const res = await get(`/monitor?retailer_id=${fx.retailerId}`);
    const rival = res.rows.find((r: any) => r.listing_id === fx.compListingId);
    assert.deepEqual(rival.tags, ['limited_time_deal', 'coupon']);
    assert.deepEqual([rival.tag_text, rival.rating, rival.review_count, rival.sales_rank, rival.sales_rank_label, rival.seller_name], ['Limited time deal', 4.4, 1300, 2, '#2 in Hair Oils', 'Test Mart']);
    const own = res.rows.find((r: any) => r.listing_id === fx.ownListingId);
    assert.deepEqual(own.tags, ['best_seller']);
    assert.deepEqual([own.tag_text, own.rating, own.review_count, own.sales_rank, own.seller_name], [null, 4.7, 90, null, null]);
    // a listing that was never observed has no signals, and an empty list of tags
    const never = createFixture(t.ctx, { retailerName: 'Never Seen Mart' });
    const blank = (await get(`/monitor?retailer_id=${never.retailerId}`)).rows[0];
    assert.equal(blank.observation_id, null);
    assert.deepEqual(blank.tags, []);
    assert.equal(blank.rating, null);
  });

  it('counts the tags carried right now — by fresh listings only', async () => {
    const res = await get(`/monitor?retailer_id=${fx.retailerId}`);
    assert.deepEqual(res.facets.by_tag, tagCounts({ limited_time_deal: 1, coupon: 1, best_seller: 1 }));
    const old = await get(`/monitor?retailer_id=${stale.retailerId}`);
    const row = old.rows.find((r: any) => r.listing_id === stale.ownListingId);
    assert.equal(row.is_stale, 1);
    assert.deepEqual(row.tags, ['deal', 'best_seller'], 'the row still shows what was last seen');
    assert.deepEqual(old.facets.by_tag, tagCounts());
    const all = await get('/monitor');
    assert.equal(all.facets.by_tag.best_seller, 1);
    assert.equal(all.facets.by_tag.deal, 0);
  });

  it('filters the monitor by tag without changing the facets', async () => {
    const coupons = await get(`/monitor?retailer_id=${fx.retailerId}&tag=coupon`);
    assert.deepEqual(coupons.rows.map((r: any) => r.listing_id), [fx.compListingId]);
    assert.equal(coupons.total, 1);
    assert.equal(coupons.facets.listings, 2);
    assert.equal(coupons.facets.by_tag.best_seller, 1);
    const either = await get(`/monitor?retailer_id=${fx.retailerId}&tag=best_seller,coupon`);
    assert.equal(either.total, 2);
    assert.equal((await get(`/monitor?retailer_id=${fx.retailerId}&tag=multi_buy`)).total, 0);
    assert.equal((await get('/monitor?tag=deal')).total, 1, 'a stale listing can still be found by its last tag');
    assert.equal((await t.api('GET', '/monitor?tag=bogus')).status, 400);
    // sortable by rating
    const byRating = await get(`/monitor?retailer_id=${fx.retailerId}&sort=-rating`);
    assert.deepEqual(byRating.rows.map((r: any) => r.rating), [4.7, 4.4]);
  });
});

// ---------------------------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------------------------
describe('deals', () => {
  let dm: Fixture; // Deal Mart, UAE (AED)
  let sa: Fixture; // Deal Mart, Saudi Arabia (SAR)
  let feed: Fixture; // a daily feed whose last observation is stale
  let long: Fixture; // long-running offers
  let scope: string;
  let latestA: number;
  const byListing = (res: DealsResponse, listingId: number): DealRow => {
    const row = res.rows.find((r) => r.listing_id === listingId);
    assert.ok(row, `listing ${listingId} is listed as a deal`);
    return row;
  };
  const price = (listing_id: number, k: number, current: number, regular: number, extra: Partial<ObservationInput> = {}): ObservationInput => ({
    listing_id, observed_at: known.at(k), current_price: current, regular_price: regular, availability: 'in_stock', ...extra,
  });

  before(() => {
    dm = createFixture(t.ctx, { retailerName: 'Deal Mart' });
    sa = createFixture(t.ctx, { retailerName: 'Deal Mart', marketCode: 'SA' });
    feed = createFixture(t.ctx, { retailerName: 'Feed Mart', method: 'product_feed' });
    long = createFixture(t.ctx, { retailerName: 'Long Mart' });
    scope = `retailer_id=${dm.retailerId},${sa.retailerId},${feed.retailerId}`;
    const res = ingest([
      // A — own 200 ml at Deal Mart UAE, regular price 50:
      //     50 · 50 · 50 · 50 · 45 (price cut) · 50 · 40 · 40 (sale-event tag) · 35 (limited-time deal + best seller)
      price(dm.ownListingId, 9, 50, 50),
      price(dm.ownListingId, 8, 50, 50),
      price(dm.ownListingId, 7, 50, 50),
      price(dm.ownListingId, 6, 50, 50),
      price(dm.ownListingId, 5, 45, 50),
      price(dm.ownListingId, 4, 50, 50),
      price(dm.ownListingId, 3, 40, 50, { tags: ['event_deal'], tag_text: 'Yellow Friday Deal' }),
      price(dm.ownListingId, 2, 40, 50, { tags: ['event_deal'], tag_text: 'Yellow Friday Deal' }),
      price(dm.ownListingId, 1, 35, 50, { tags: ['limited_time_deal', 'best_seller'], tag_text: 'Limited time deal', rating: 4.6, review_count: 1200, sales_rank: 3, sales_rank_label: '#3 in Hair Oils', seller_name: 'Deal Mart' }),
      // B — rival 300 ml at Deal Mart UAE: never cheaper, but the latest observation carries a coupon
      price(dm.compListingId, 5, 30, 30),
      price(dm.compListingId, 3, 30, 30),
      price(dm.compListingId, 1, 30, 30, { tags: ['coupon'], tag_text: 'Extra 10% off' }),
      // C — own at Deal Mart KSA (SAR): below its regular price, no tag
      price(sa.ownListingId, 2, 100, 100),
      price(sa.ownListingId, 1, 80, 100),
      // D — rival at Deal Mart KSA: a best-seller badge at the regular price
      price(sa.compListingId, 1, 60, 60, { tags: ['best_seller'] }),
    ]);
    assert.equal(res.inserted, 15, JSON.stringify(res.rejected));
    latestA = res.idByIndex.get(8)!;
    // E — a deal last seen four days ago on a daily feed: stale, so not a deal today
    assert.equal(ingest([price(feed.ownListingId, 4, 10, 20, { tags: ['deal'] })], 'product_feed').inserted, 1);
  });

  it('lists fresh listings that are tagged as an offer, on promotion or below their regular price', async () => {
    const res: DealsResponse = await get(`/deals?${scope}`);
    assert.deepEqual(res.rows.map((r) => r.listing_id), [dm.ownListingId, sa.ownListingId, dm.compListingId], 'deepest discount first, rows without a discount last');
    assert.deepEqual({ total: res.total, page: res.page, page_size: res.page_size, pages: res.pages }, { total: 3, page: 1, page_size: 50, pages: 1 });

    const a = byListing(res, dm.ownListingId);
    assert.deepEqual(
      {
        product: a.product_name, brand: a.brand_name, ownership: a.ownership, category: a.category_name, retailer: a.retailer_name, market: a.market_code, currency: a.currency_code,
        current: a.current_price, regular: a.regular_price, discount: a.discount_pct, unit: a.unit_price, basis: a.unit_basis,
        tags: a.tags, tag_text: a.tag_text, promo: a.is_promo, promo_type: a.promo_type, availability: a.availability,
        rating: a.rating, reviews: a.review_count, rank: a.sales_rank, rank_label: a.sales_rank_label, seller: a.seller_name,
        observed_at: a.observed_at, data_class: a.data_class, is_demo: a.is_demo, observation_id: a.observation_id,
      },
      {
        product: 'Own Oil 200ml AE-Deal Mart', brand: 'Test Own', ownership: 'own', category: 'Hair Oil', retailer: 'Deal Mart', market: 'AE', currency: 'AED',
        current: 35, regular: 50, discount: 30, unit: 17.5, basis: 'per 100ml',
        tags: ['limited_time_deal', 'best_seller'], tag_text: 'Limited time deal', promo: 1, promo_type: 'price_cut', availability: 'in_stock',
        rating: 4.6, reviews: 1200, rank: 3, rank_label: '#3 in Hair Oils', seller: 'Deal Mart',
        observed_at: known.at(1), data_class: 'manual', is_demo: 0, observation_id: latestA,
      },
    );
    // history: nine observed days, 410 / 9 = 45.5556 on average; (45.5556 − 35) / 45.5556 = 23.17 % below it
    assert.deepEqual(
      { avg30: a.avg_30d, avg90: a.avg_90d, low: a.low_90d, high: a.high_90d, drop: a.drop_vs_avg_30d_pct, lowest: a.is_lowest_90d, days: a.history_days, since: a.deal_since, first: a.first_observed_at },
      { avg30: 45.5556, avg90: 45.5556, low: 35, high: 50, drop: 23.17, lowest: true, days: 9, since: known.at(3), first: known.at(9) },
    );

    // a tag alone makes the deal: no discount, three observed days, so no "lowest in 90 days" claim
    const b = byListing(res, dm.compListingId);
    assert.deepEqual(
      { current: b.current_price, regular: b.regular_price, discount: b.discount_pct, tags: b.tags, tag_text: b.tag_text, promo: b.is_promo, unit: b.unit_price, ownership: b.ownership },
      { current: 30, regular: 30, discount: null, tags: ['coupon'], tag_text: 'Extra 10% off', promo: 0, unit: 10, ownership: 'competitor' },
    );
    assert.deepEqual(
      { avg30: b.avg_30d, low: b.low_90d, high: b.high_90d, drop: b.drop_vs_avg_30d_pct, lowest: b.is_lowest_90d, days: b.history_days, since: b.deal_since },
      { avg30: 30, low: 30, high: 30, drop: 0, lowest: false, days: 3, since: known.at(1) },
    );

    // a lower price alone makes the deal too: (100 − 80) / 100 = 20 %, and 80 is 11.11 % below the two-day average of 90
    const c = byListing(res, sa.ownListingId);
    assert.deepEqual(
      { currency: c.currency_code, market: c.market_code, current: c.current_price, regular: c.regular_price, discount: c.discount_pct, tags: c.tags, promo: c.is_promo },
      { currency: 'SAR', market: 'SA', current: 80, regular: 100, discount: 20, tags: [], promo: 1 },
    );
    assert.deepEqual(
      { avg30: c.avg_30d, low: c.low_90d, high: c.high_90d, drop: c.drop_vs_avg_30d_pct, lowest: c.is_lowest_90d, days: c.history_days, since: c.deal_since },
      { avg30: 90, low: 80, high: 100, drop: 11.11, lowest: false, days: 2, since: known.at(1) },
    );

    // not deals: a badge at the regular price (D), a stale offer (E) — which is counted, not listed
    assert.ok(!res.rows.some((r) => r.listing_id === sa.compListingId || r.listing_id === feed.ownListingId));
    assert.equal(res.summary.stale_deals, 1);
    assert.ok(res.rows.every((r) => r.is_stale === false && r.stale_after_hours === 168 && r.age_hours > 0 && r.age_hours < 168));
  });

  it('summarises all matching deals without ever mixing currencies', async () => {
    const { summary }: DealsResponse = await get(`/deals?${scope}&page_size=1`);
    assert.deepEqual({ total: summary.total, own: summary.own, competitor: summary.competitor, lowest: summary.lowest_90d }, { total: 3, own: 2, competitor: 1, lowest: 1 });
    assert.deepEqual(summary.by_tag, tagCounts({ limited_time_deal: 1, coupon: 1, best_seller: 1 }));
    assert.deepEqual(summary.by_brand, [
      { brand_id: dm.ownBrandId, brand_name: 'Test Own', ownership: 'own', deals: 2, avg_discount_pct: 25, max_discount_pct: 30 },
      { brand_id: dm.compBrandId, brand_name: 'Test Rival', ownership: 'competitor', deals: 1, avg_discount_pct: null, max_discount_pct: null },
    ]);
    const marketName = (id: number) => t.ctx.db.scalar<string>('SELECT name FROM markets WHERE id = ?', [id])!;
    assert.deepEqual(summary.by_retailer, [
      { retailer_id: dm.retailerId, retailer_name: 'Deal Mart', market_code: 'AE', market_name: marketName(dm.marketId), currency_code: 'AED', deals: 2, avg_discount_pct: 30, max_discount_pct: 30 },
      { retailer_id: sa.retailerId, retailer_name: 'Deal Mart', market_code: 'SA', market_name: marketName(sa.marketId), currency_code: 'SAR', deals: 1, avg_discount_pct: 20, max_discount_pct: 20 },
    ]);
    assert.deepEqual(summary.deepest, {
      listing_id: dm.ownListingId, product_id: dm.ownProductId, product_name: 'Own Oil 200ml AE-Deal Mart', brand_name: 'Test Own', retailer_name: 'Deal Mart', market_code: 'AE',
      currency_code: 'AED', current_price: 35, regular_price: 50, discount_pct: 30,
    });
    assert.deepEqual(summary.currencies, ['AED', 'SAR']);
    assert.equal(summary.latest_observation_at, known.at(1));
    assert.deepEqual(summary.demo, { demo_rows: 0, total_rows: 3, all_demo: false, any_demo: false });
    // no figure in the summary adds up or averages prices
    assert.ok(!JSON.stringify(summary).includes('avg_price') && !('total_value' in summary));
  });

  it('filters by tag, discount, 90-day low, ownership, brand, market, product and search text', async () => {
    const ids = async (query: string) => ((await get(`/deals?${scope}&${query}`)) as DealsResponse).rows.map((r) => r.listing_id);
    assert.deepEqual(await ids('tag=coupon'), [dm.compListingId]);
    assert.deepEqual(await ids('tag=coupon,limited_time_deal'), [dm.ownListingId, dm.compListingId]);
    assert.deepEqual(await ids('tag=best_seller'), [dm.ownListingId], 'a badge filters deals; it does not make one');
    assert.deepEqual(await ids('tag=multi_buy'), []);
    assert.deepEqual(await ids('min_discount=25'), [dm.ownListingId]);
    assert.deepEqual(await ids('min_discount=20'), [dm.ownListingId, sa.ownListingId]);
    assert.deepEqual(await ids('min_discount=0'), [dm.ownListingId, sa.ownListingId, dm.compListingId], 'a minimum of 0 % is no filter');
    assert.deepEqual(await ids('lowest_only=true'), [dm.ownListingId]);
    assert.deepEqual(await ids('ownership=competitor'), [dm.compListingId]);
    assert.deepEqual(await ids('ownership=own'), [dm.ownListingId, sa.ownListingId]);
    assert.deepEqual(await ids(`brand_id=${dm.compBrandId}`), [dm.compListingId]);
    assert.deepEqual(await ids(`market_id=${sa.marketId}`), [sa.ownListingId]);
    assert.deepEqual(await ids(`product_id=${sa.ownProductId}`), [sa.ownListingId]);
    assert.deepEqual(await ids(`category_id=${dm.categoryId}`), [dm.ownListingId, sa.ownListingId, dm.compListingId]);
    assert.deepEqual(await ids('q=Rival'), [dm.compListingId]);
    assert.deepEqual(await ids('q=no-such-product'), []);

    // the tag counts ignore the tag filter (so the chips keep their numbers); everything else follows it
    const filtered: DealsResponse = await get(`/deals?${scope}&tag=coupon`);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.summary.total, 1);
    assert.deepEqual({ own: filtered.summary.own, competitor: filtered.summary.competitor }, { own: 0, competitor: 1 });
    assert.deepEqual(filtered.summary.by_tag, tagCounts({ limited_time_deal: 1, coupon: 1, best_seller: 1 }));
    assert.equal(filtered.summary.deepest, null);
    const deep: DealsResponse = await get(`/deals?${scope}&min_discount=25`);
    assert.deepEqual(deep.summary.by_tag, tagCounts({ limited_time_deal: 1, best_seller: 1 }));
  });

  it('lists badge-only listings when asked to', async () => {
    const res: DealsResponse = await get(`/deals?${scope}&include_badges=true`);
    assert.equal(res.total, 4);
    const d = byListing(res, sa.compListingId);
    assert.deepEqual({ tags: d.tags, discount: d.discount_pct, promo: d.is_promo, since: d.deal_since }, { tags: ['best_seller'], discount: null, promo: 0, since: known.at(1) });
    assert.equal(res.summary.by_tag.best_seller, 2);
    assert.ok(!res.rows.some((r) => r.listing_id === feed.ownListingId), 'stale listings stay out');
  });

  it('lists stale offers only on request — flagged, and after the fresh ones', async () => {
    const res: DealsResponse = await get(`/deals?${scope}&include_stale=true`);
    assert.deepEqual(res.rows.map((r) => r.listing_id), [dm.ownListingId, sa.ownListingId, dm.compListingId, feed.ownListingId], 'the 50 % offer last seen four days ago ranks below every current one');
    const e = byListing(res, feed.ownListingId);
    assert.deepEqual({ stale: e.is_stale, after: e.stale_after_hours, discount: e.discount_pct, tags: e.tags, observed: e.observed_at }, { stale: true, after: 48, discount: 50, tags: ['deal'], observed: known.at(4) });
    assert.ok(e.age_hours > 48);
    assert.equal(res.total, 4);
    assert.equal(res.summary.stale_deals, 1, 'the count does not depend on whether they are listed');
    assert.deepEqual(((await get(`/deals?${scope}&include_stale=true&min_discount=40`)) as DealsResponse).rows.map((r) => r.listing_id), [feed.ownListingId]);
    // the default view never lists it, whatever the filters
    assert.deepEqual(((await get(`/deals?${scope}&min_discount=40`)) as DealsResponse).rows, []);
    assert.equal(((await get(`/deals?${scope}&min_discount=40`)) as DealsResponse).summary.stale_deals, 1);
    assert.equal(((await get(`/deals?retailer_id=${dm.retailerId}`)) as DealsResponse).summary.stale_deals, 0);
  });

  it('treats the retailer\'s "lowest price" statement as an offer and "selling fast" as a badge', async () => {
    const tagMart = createFixture(t.ctx, { retailerName: 'Tag Mart' });
    const res = ingest([
      price(tagMart.ownListingId, 1, 30, 30, { tags: normaliseDealTags(['Lowest price in 30 days']), tag_text: 'Lowest price in 30 days' }),
      price(tagMart.compListingId, 1, 30, 30, { tags: normaliseDealTags(['Selling out fast']), tag_text: 'Selling out fast' }),
    ]);
    assert.equal(res.inserted, 2, JSON.stringify(res.rejected));
    const deals: DealsResponse = await get(`/deals?retailer_id=${tagMart.retailerId}`);
    assert.deepEqual(deals.rows.map((r) => [r.listing_id, r.tags, r.tag_text, r.discount_pct]), [[tagMart.ownListingId, ['lowest_price'], 'Lowest price in 30 days', null]]);
    // what the retailer claims and what the stored history shows are separate things: one observed day proves nothing
    assert.equal(deals.rows[0]!.is_lowest_90d, false);
    assert.deepEqual(deals.summary.by_tag, tagCounts({ lowest_price: 1 }));
    assert.equal((await get(`/deals?retailer_id=${tagMart.retailerId}&tag=lowest_price`)).total, 1);
    assert.equal((await get(`/deals?retailer_id=${tagMart.retailerId}&tag=selling_fast`)).total, 0);
    const withBadges: DealsResponse = await get(`/deals?retailer_id=${tagMart.retailerId}&include_badges=true&tag=selling_fast`);
    assert.deepEqual(withBadges.rows.map((r) => [r.listing_id, r.tags]), [[tagMart.compListingId, ['selling_fast']]]);
    assert.deepEqual(withBadges.summary.by_tag, tagCounts({ lowest_price: 1, selling_fast: 1 }));
    // the monitor counts both, and finds both by tag
    const monitor = await get(`/monitor?retailer_id=${tagMart.retailerId}&tag=selling_fast`);
    assert.deepEqual(monitor.rows.map((r: any) => r.listing_id), [tagMart.compListingId]);
    assert.deepEqual(monitor.facets.by_tag, tagCounts({ lowest_price: 1, selling_fast: 1 }));
    assert.equal((await get('/observations?tag=lowest_price')).total, 1);
  });

  it('sorts by discount, drop, price, observation time, rating and rank', async () => {
    const ids = async (sort: string) => ((await get(`/deals?${scope}&sort=${sort}`)) as DealsResponse).rows.map((r) => r.listing_id);
    const [a, b, c] = [dm.ownListingId, dm.compListingId, sa.ownListingId];
    assert.deepEqual(await ids('-discount'), [a, c, b]);
    assert.deepEqual(await ids('discount'), [c, a, b], 'rows without a discount stay last in both directions');
    assert.deepEqual(await ids('-drop'), [a, c, b]);
    assert.deepEqual(await ids('drop'), [b, c, a]);
    // prices in different currencies are never ranked against each other: AED first, then SAR
    assert.deepEqual(await ids('price'), [b, a, c]);
    assert.deepEqual(await ids('-price'), [a, b, c]);
    assert.deepEqual(await ids('-rating'), [a, b, c]);
    assert.deepEqual(await ids('rank'), [a, b, c]);
    assert.deepEqual(await ids('-observed'), [a, b, c]);
    assert.deepEqual(await ids('nonsense'), [a, c, b], 'an unknown sort key falls back to the default');
  });

  it('pages through the deals', async () => {
    const second: DealsResponse = await get(`/deals?${scope}&page_size=1&page=2`);
    assert.deepEqual(second.rows.map((r) => r.listing_id), [sa.ownListingId]);
    assert.deepEqual({ total: second.total, page: second.page, page_size: second.page_size, pages: second.pages }, { total: 3, page: 2, page_size: 1, pages: 3 });
    assert.equal(second.summary.total, 3);
    const beyond: DealsResponse = await get(`/deals?${scope}&page_size=2&page=9`);
    assert.deepEqual(beyond.rows, []);
    assert.equal(beyond.total, 3);
  });

  it('follows the ledger when an observation is voided', async () => {
    voidObservation(t.ctx, latestA, 'test: wrong price', null);
    try {
      const res: DealsResponse = await get(`/deals?${scope}`);
      const a = byListing(res, dm.ownListingId);
      // the day before becomes the latest observation: 40 against 50, eight observed days, 375 / 8 = 46.875 on average
      assert.deepEqual(
        { current: a.current_price, discount: a.discount_pct, tags: a.tags, tag_text: a.tag_text, avg30: a.avg_30d, low: a.low_90d, drop: a.drop_vs_avg_30d_pct, lowest: a.is_lowest_90d, days: a.history_days, since: a.deal_since },
        { current: 40, discount: 20, tags: ['event_deal'], tag_text: 'Yellow Friday Deal', avg30: 46.875, low: 40, drop: 14.67, lowest: true, days: 8, since: known.at(3) },
      );
      assert.equal(res.summary.by_tag.limited_time_deal, 0);
    } finally {
      restoreObservation(t.ctx, latestA);
    }
    assert.equal(byListing(await get(`/deals?${scope}`), dm.ownListingId).current_price, 35);
  });

  it('finds the start of an offer that has been running for longer than the history window', async () => {
    const res = ingest([
      // own: one plain observation, then the same offer for 110 days
      price(long.ownListingId, 120, 20, 20),
      price(long.ownListingId, 110, 15, 20),
      price(long.ownListingId, 100, 15, 20),
      price(long.ownListingId, 50, 15, 20),
      price(long.ownListingId, 1, 15, 20),
      // rival: on offer ever since it was first observed
      price(long.compListingId, 100, 9, 10),
      price(long.compListingId, 1, 9, 10),
    ]);
    assert.equal(res.inserted, 7, JSON.stringify(res.rejected));
    const deals: DealsResponse = await get(`/deals?retailer_id=${long.retailerId}`);
    const own = byListing(deals, long.ownListingId);
    assert.deepEqual(
      { since: own.deal_since, days: own.history_days, avg30: own.avg_30d, avg90: own.avg_90d, drop: own.drop_vs_avg_30d_pct, lowest: own.is_lowest_90d, first: own.first_observed_at },
      { since: known.at(110), days: 2, avg30: 15, avg90: 15, drop: null, lowest: false, first: known.at(120) },
      'one observed day in the last 30 is no basis for a drop against the average',
    );
    const rival = byListing(deals, long.compListingId);
    assert.deepEqual({ since: rival.deal_since, days: rival.history_days, drop: rival.drop_vs_avg_30d_pct }, { since: known.at(100), days: 1, drop: null });
  });

  it('flags DEMO deals and reports how much of the result is demo data', async () => {
    const now = nowIso();
    const demoListing = t.ctx.db.run(
      `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, is_demo, created_at, updated_at)
       VALUES (?, ?, 'demo-deal', 'https://demo.invalid/deal', 'DEMO deal', 'matched', 1, ?, ?)`,
      [dm.retailerId, dm.compProductId, now, now],
    ).lastInsertRowid;
    assert.equal(ingest([price(demoListing, 1, 9, 10, { tags: ['deal'] })], 'simulated').inserted, 1);
    const res: DealsResponse = await get(`/deals?${scope}`);
    const demo = byListing(res, demoListing);
    assert.deepEqual({ is_demo: demo.is_demo, data_class: demo.data_class, discount: demo.discount_pct }, { is_demo: 1, data_class: 'simulated', discount: 10 });
    assert.deepEqual(res.summary.demo, { demo_rows: 1, total_rows: 4, all_demo: false, any_demo: true });
    assert.ok(res.rows.filter((r) => r.listing_id !== demoListing).every((r) => r.is_demo === 0));
  });

  it('is readable by every signed-in user and validates its parameters', async () => {
    assert.equal((await get(`/deals?${scope}`, 'viewer')).total, 4);
    assert.equal((await get(`/deals?${scope}`, 'analyst')).total, 4);
    assert.equal((await t.api('GET', '/deals', { as: null })).status, 401);
    const badTag = await t.api('GET', '/deals?tag=flash');
    assert.equal(badTag.status, 400);
    assert.match(badTag.body.error.message, /Unknown deal tag "flash"/);
    assert.equal((await t.api('GET', '/deals?min_discount=abc')).status, 400);
    assert.equal((await t.api('GET', '/deals?min_discount=150')).status, 400);
    assert.equal((await t.api('GET', '/deals?brand_id=x')).status, 400);
    // without a scope, every deal of the installation is listed — including the tagged fixture listing of the earlier tests
    const all: DealsResponse = await get('/deals?page_size=200');
    assert.ok(all.rows.some((r) => r.listing_id === fx.compListingId));
    assert.ok(!all.rows.some((r) => r.listing_id === fx.ownListingId), 'a best-seller badge at the regular price is not a deal');
    assert.equal(all.total, all.rows.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------------------------
describe('importing signals', () => {
  let batchId: number;

  const csv = () =>
    [
      'Retailer,Market,SKU,Date,Price,Regular price,Tags,Tag text,Rating,Reviews,Sales rank,Seller',
      `Test Mart,AE,SIG-OWN-200,${day(30)},19,22,Limited time deal; Best seller,,4.5,"1,280",#3 in Hair Oils,Test Mart Direct`,
      `Test Mart,AE,SIG-OWN-200,${day(29)},19,22,عرض لمدة محدودة,,,,,`,
      `Test Mart,AE,SIG-OWN-200,${day(28)},22,22,Mega bonus,,,,,`,
      `Test Mart,AE,SIG-OWN-200,${day(27)},19,22,Save 30%,,,,,`,
      `Test Mart,AE,SIG-OWN-200,${day(26)},19,22,,Early Yellow Friday Deal,4.1/5,2.5K,12,`,
      `Test Mart,AE,SIG-OWN-200,${day(25)},19,22,,,9,,,`,
      `Test Mart,AE,SIG-OWN-200,${day(24)},19,22,,,,12.5,,`,
      `Test Mart,AE,SIG-OWN-200,${day(23)},19,22,,,,,top,`,
      '',
    ].join('\r\n');

  before(() => {
    t.ctx.db.run(`UPDATE products SET sku = 'SIG-OWN-200' WHERE id = ?`, [fx.ownProductId]);
  });

  it('reads tag, rating, review, rank and seller cells', () => {
    assert.deepEqual(parseTagCells('Limited time deal; Best seller', ''), { tags: ['limited_time_deal', 'best_seller'], tag_text: null });
    assert.deepEqual(parseTagCells('limited_time_deal, coupon', ''), { tags: ['limited_time_deal', 'coupon'], tag_text: null });
    assert.deepEqual(parseTagCells('["deal","best_seller"]', ''), { tags: ['deal', 'best_seller'], tag_text: null });
    assert.deepEqual(parseTagCells('Early Yellow Friday Deal ⏳', ''), { tags: ['event_deal'], tag_text: 'Early Yellow Friday Deal ⏳' });
    assert.deepEqual(parseTagCells('Buy 2, get 1 free', ''), { tags: ['multi_buy'], tag_text: 'Buy 2, get 1 free' }, 'a comma inside wording does not split it');
    assert.deepEqual(parseTagCells('Mega bonus', ''), { tags: ['other'], tag_text: 'Mega bonus' }, 'unrecognised wording is kept');
    assert.deepEqual(parseTagCells('Save 30%', ''), { tags: [], tag_text: null });
    assert.deepEqual(parseTagCells('', 'Limited time deal'), { tags: ['limited_time_deal'], tag_text: 'Limited time deal' });
    assert.deepEqual(parseTagCells('Limited-time deal', 'عرض لمدة محدودة'), { tags: ['limited_time_deal'], tag_text: 'عرض لمدة محدودة' });
    assert.deepEqual(parseTagCells('', ''), { tags: [], tag_text: null });

    assert.deepEqual(parseRating('4.5'), { ok: true, value: 4.5 });
    assert.deepEqual(parseRating('4,5'), { ok: true, value: 4.5 });
    assert.deepEqual(parseRating('4.5 out of 5'), { ok: true, value: 4.5 });
    assert.deepEqual(parseRating(''), { ok: true, value: null });
    assert.equal(parseRating('9').ok, false);
    assert.equal(parseRating('90%').ok, false);
    assert.deepEqual(parseCount('1,280 ratings', 'number of reviews'), { ok: true, value: 1280 });
    assert.deepEqual(parseCount('(1 280)', 'number of reviews'), { ok: true, value: 1280 });
    assert.deepEqual(parseCount('1.2K', 'number of reviews'), { ok: true, value: 1200 });
    assert.equal(parseCount('12.5', 'number of reviews').ok, false);
    assert.deepEqual(parseSalesRank('#3 in Shampoos'), { ok: true, value: { rank: 3, label: '#3 in Shampoos' } });
    assert.deepEqual(parseSalesRank('1,204'), { ok: true, value: { rank: 1204, label: null } });
    assert.equal(parseSalesRank('top').ok, false);

    const { mapping } = suggestMapping('observations', ['Store', 'ASIN', 'Timestamp', 'Price', 'Badges', 'Badge text', 'Stars', 'Number of reviews', 'Best sellers rank', 'Sold by']);
    assert.deepEqual(
      { tags: mapping.tags, tag_text: mapping.tag_text, rating: mapping.rating, review_count: mapping.review_count, sales_rank: mapping.sales_rank, seller_name: mapping.seller_name },
      { tags: 'Badges', tag_text: 'Badge text', rating: 'Stars', review_count: 'Number of reviews', sales_rank: 'Best sellers rank', seller_name: 'Sold by' },
    );
  });

  it('recognises the signal columns of an uploaded file', async () => {
    const res = await upload('observations', { name: 'tagged-history.csv', content: csv() }, 'analyst');
    assert.equal(res.status, 201, res.raw);
    batchId = res.body.batch.id;
    assert.deepEqual(res.body.suggested_mapping, {
      retailer: 'Retailer', market: 'Market', sku: 'SKU', observed_date: 'Date', regular_price: 'Regular price', current_price: 'Price',
      tags: 'Tags', tag_text: 'Tag text', rating: 'Rating', review_count: 'Reviews', sales_rank: 'Sales rank', seller_name: 'Seller',
    });
    for (const field of ['tags', 'tag_text', 'rating', 'review_count', 'sales_rank', 'sales_rank_label', 'seller_name']) {
      assert.ok(res.body.fields.some((f: any) => f.field === field && f.required === 'no'), `field ${field} is offered for mapping`);
    }
  });

  it('validates the signal cells and explains the rows it cannot read', async () => {
    const before = ledgerCount();
    const res = await t.api('POST', `/imports/${batchId}/validate`, { as: 'analyst', body: {} });
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual({ rows: res.body.summary.rows, valid: res.body.summary.valid, invalid: res.body.summary.invalid }, { rows: 8, valid: 5, invalid: 3 });
    assert.deepEqual(
      res.body.errors.map((e: any) => [e.row, e.field]),
      [[7, 'rating'], [8, 'review_count'], [9, 'sales_rank']],
    );
    assert.match(res.body.errors[0].message, /"9" is not a rating/);
    assert.match(res.body.errors[1].message, /"12.5" is not a number of reviews/);
    assert.match(res.body.errors[2].message, /"top" is not a sales rank/);
    const first = res.body.preview[0];
    assert.deepEqual(
      { tags: first.tags, tag_text: first.tag_text, rating: first.rating, reviews: first.review_count, rank: first.sales_rank, seller: first.seller_name },
      { tags: ['limited_time_deal', 'best_seller'], tag_text: null, rating: 4.5, reviews: 1280, rank: 3, seller: 'Test Mart Direct' },
    );
    assert.equal(ledgerCount(), before, 'validation writes nothing');
  });

  it('stores the imported signals with the observations', async () => {
    const res = await t.api('POST', `/imports/${batchId}/commit`, { as: 'analyst' });
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual({ inserted: res.body.inserted, skipped: res.body.skipped_invalid }, { inserted: 5, skipped: 3 });
    const stored = (k: number) =>
      t.ctx.db.get<Record<string, any>>(
        `SELECT tags, tag_text, rating, review_count, sales_rank, sales_rank_label, seller_name, source_method, import_batch_id
         FROM price_observations WHERE listing_id = ? AND observed_local_date = ?`,
        [fx.ownListingId, day(k)],
      )!;
    assert.deepEqual({ ...stored(30) }, {
      tags: '["limited_time_deal","best_seller"]', tag_text: null, rating: 4.5, review_count: 1280, sales_rank: 3, sales_rank_label: '#3 in Hair Oils',
      seller_name: 'Test Mart Direct', source_method: 'csv_import', import_batch_id: batchId,
    });
    assert.deepEqual([stored(29).tags, stored(29).tag_text], ['["limited_time_deal"]', 'عرض لمدة محدودة']);
    assert.deepEqual([stored(28).tags, stored(28).tag_text], ['["other"]', 'Mega bonus'], 'unrecognised wording is kept as "other" with the retailer\'s words');
    assert.deepEqual([stored(27).tags, stored(27).tag_text], ['[]', null], 'a plain price cut is not a tag');
    assert.deepEqual(
      [stored(26).tags, stored(26).tag_text, stored(26).rating, stored(26).review_count, stored(26).sales_rank, stored(26).sales_rank_label, stored(26).seller_name],
      ['["event_deal"]', 'Early Yellow Friday Deal', 4.1, 2500, 12, null, null],
    );
  });

  it('offers the signal columns in the import template', async () => {
    const template = await download('/imports/templates/observations.csv', 'viewer');
    assert.equal(template.status, 200);
    const parsed = parseCsv(template.buffer);
    for (const header of ['Tags', 'Tag text', 'Rating', 'Reviews', 'Sales rank', 'Seller']) assert.ok(parsed.headers.includes(header), `template column ${header}`);
    assert.equal(parsed.rows[0]!.Tags, 'Limited time deal; Best seller');
  });
});

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------
describe('exporting signals', () => {
  const SIGNAL_HEADERS = ['Tags', 'Tag text', 'Rating', 'Reviews', 'Sales rank', 'Sales rank label', 'Seller'];

  it('writes the signals to the CSV export', async () => {
    const res = await download(`/observations/export?format=csv&listing_id=${fx.ownListingId}`);
    assert.equal(res.status, 200);
    const { headers, rows } = parseCsv(res.buffer);
    for (const header of SIGNAL_HEADERS) assert.ok(headers.includes(header), `CSV column ${header}`);
    const imported = rows.find((r) => r['Market-local date'] === day(30))!;
    assert.deepEqual(
      SIGNAL_HEADERS.map((h) => imported[h]),
      ['Limited-time deal; Best seller', '', '4.5', '1280', '3', '#3 in Hair Oils', 'Test Mart Direct'],
    );
    const manual = rows.find((r) => r['Observed at (UTC)'] === known.at(3))!;
    assert.deepEqual(SIGNAL_HEADERS.map((h) => manual[h]), ['Coupon / extra discount', 'Extra 10% off', '4.2', '55', '12', '#12 in Hair Oils', 'Test Mart']);
    const plain = rows.find((r) => r['Observed at (UTC)'] === known.at(10))!;
    assert.deepEqual(SIGNAL_HEADERS.map((h) => plain[h]), ['', '', '', '', '', '', '']);
    // the tag filter applies to exports as it does to the list
    const tagged = parseCsv((await download('/observations/export?format=csv&tag=other')).buffer).rows;
    assert.deepEqual(tagged.map((r) => r['Tag text']), ['Mega bonus']);
  });

  it('writes real numbers to the Excel export, and the importer reads its own export back', async () => {
    const res = await download(`/observations/export?format=xlsx&retailer_id=${fx.retailerId}&tag=limited_time_deal`);
    assert.equal(res.status, 200);
    const wb = await loadWorkbook(res.buffer);
    const { headers, rows } = sheetRows(wb, 'Price observations');
    for (const header of SIGNAL_HEADERS) assert.ok(headers.includes(header), `Excel column ${header}`);
    const imported = rows.find((r) => r.Seller === 'Test Mart Direct')!;
    assert.equal(imported.Tags, 'Limited-time deal; Best seller');
    assert.equal(imported.Rating, 4.5);
    assert.equal(imported.Reviews, 1280);
    assert.equal(imported['Sales rank'], 3);
    let provenance = '';
    wb.getWorksheet('Provenance')!.eachRow((row) => row.eachCell((cell) => (provenance += `${String(cell.value)}\n`)));
    assert.match(provenance, /Deal tags \(any of\): Limited-time deal/);

    const staged = await upload('observations', { name: 'export.xlsx', content: res.buffer });
    assert.equal(staged.status, 201, staged.raw);
    const mapping = staged.body.suggested_mapping;
    assert.deepEqual(
      [mapping.tags, mapping.tag_text, mapping.rating, mapping.review_count, mapping.sales_rank, mapping.sales_rank_label, mapping.seller_name],
      SIGNAL_HEADERS,
    );
    const validated = await t.api('POST', `/imports/${staged.body.batch.id}/validate`, { body: {} });
    assert.equal(validated.status, 200, validated.raw);
    assert.equal(validated.body.summary.invalid, 0, JSON.stringify(validated.body.errors));
    assert.equal(validated.body.summary.will_insert, 0, 'every exported row is recognised as already recorded');
    assert.ok(validated.body.preview.some((p: any) => p.tags.includes('limited_time_deal')));
  });

  it('carries the signals in the full database workbook and documents them', async () => {
    const res = await download('/database/export.xlsx');
    assert.equal(res.status, 200);
    const wb = await loadWorkbook(res.buffer);
    const ledger = sheetRows(wb, 'Price observations');
    for (const header of SIGNAL_HEADERS) assert.ok(ledger.headers.includes(header), `workbook column ${header}`);
    assert.equal(ledger.rows.length, ledgerCount());
    const imported = ledger.rows.find((r) => r.Seller === 'Test Mart Direct')!;
    assert.deepEqual(
      [imported.Tags, imported['Tag text'], imported.Rating, imported.Reviews, imported['Sales rank'], imported['Sales rank label']],
      ['Limited-time deal; Best seller', null, 4.5, 1280, 3, '#3 in Hair Oils'],
    );
    assert.equal(ledger.rows.filter((r) => r.Tags).length, t.ctx.db.scalar(`SELECT COUNT(*) FROM price_observations WHERE tags <> '[]'`));
    const listings = sheetRows(wb, 'Retailer listings');
    const rival = listings.rows.find((r) => r['Listing ID'] === fx.compListingId)!;
    assert.deepEqual([rival['Latest tags'], rival['Latest rating'], rival['Latest reviews'], rival['Latest sales rank'], rival['Latest seller']], ['Limited-time deal; Coupon / extra discount', 4.4, 1300, 2, 'Test Mart']);
    const dictionary = sheetRows(wb, 'Data dictionary').rows;
    for (const header of SIGNAL_HEADERS) {
      const entry = dictionary.find((r) => r.Sheet === 'Price observations' && r.Column === header);
      assert.ok(entry && String(entry.Description).length > 20, `data dictionary entry for ${header}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// DEMO dataset
// ---------------------------------------------------------------------------------------------
describe('signals in the DEMO dataset', () => {
  let demo: TestApp;
  const count = (sql: string, params: unknown[] = []) => demo.ctx.db.scalar<number>(sql, params as never) ?? 0;
  const OFFER_TAG = `EXISTS (SELECT 1 FROM json_each(o.tags) WHERE value IN (${DEAL_OFFER_TAGS.map((tag) => `'${tag}'`).join(', ')}))`;

  before(async () => {
    demo = await createTestApp();
    const res = await demo.api('POST', '/admin/demo/seed', { body: {} });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
  });
  after(async () => {
    await demo.close();
  });

  it('gives every simulated observation a stable rating, a growing review count and a seller — all flagged DEMO', () => {
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE is_demo = 0'), 0);
    const simulated = count(`SELECT COUNT(*) FROM price_observations WHERE source_method = 'simulated'`);
    assert.ok(simulated > 40_000);
    assert.equal(count(`SELECT COUNT(*) FROM price_observations WHERE source_method = 'simulated' AND (rating IS NULL OR review_count IS NULL OR seller_name IS NULL)`), 0);
    assert.deepEqual({ ...demo.ctx.db.get('SELECT MIN(rating) AS low, MAX(rating) AS high FROM price_observations')! }, { low: 3.8, high: 4.8 });
    assert.equal(count('SELECT COUNT(*) FROM (SELECT listing_id FROM price_observations WHERE rating IS NOT NULL GROUP BY listing_id HAVING COUNT(DISTINCT rating) > 1)'), 0, 'the rating of a listing is stable');
    assert.equal(
      count(`SELECT COUNT(*) FROM (SELECT review_count, LAG(review_count) OVER (PARTITION BY listing_id ORDER BY observed_at, id) AS previous
             FROM price_observations WHERE review_count IS NOT NULL) WHERE review_count < previous`),
      0,
      'review counts never go down',
    );
    assert.ok(count('SELECT COUNT(*) FROM (SELECT listing_id FROM price_observations GROUP BY listing_id HAVING MAX(review_count) > MIN(review_count))') > 300, 'and they grow over the months');
    // shelf checks (manual entry, imported shelf prices) see no online rating, rank or seller
    assert.equal(count(`SELECT COUNT(*) FROM price_observations WHERE source_method IN ('manual', 'csv_import') AND (rating IS NOT NULL OR sales_rank IS NOT NULL OR seller_name IS NOT NULL)`), 0);
    // marketplaces show a sales rank, with the list it refers to
    assert.ok(count('SELECT COUNT(DISTINCT listing_id) FROM price_observations WHERE sales_rank IS NOT NULL') > 50);
    assert.equal(count(`SELECT COUNT(*) FROM price_observations WHERE sales_rank IS NOT NULL AND sales_rank_label <> '#' || sales_rank || ' in ' || substr(sales_rank_label, instr(sales_rank_label, ' in ') + 4)`), 0);
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE (sales_rank IS NULL) <> (sales_rank_label IS NULL)'), 0);
  });

  it('tags promotional days consistently with the offer, and a few listings as best sellers', () => {
    const tagged = (tag: string, extra = '') => count(`SELECT COUNT(*) FROM price_observations o WHERE EXISTS (SELECT 1 FROM json_each(o.tags) WHERE value = ?) ${extra}`, [tag]);
    for (const tag of ['limited_time_deal', 'event_deal', 'deal', 'coupon', 'multi_buy', 'best_seller']) assert.ok(tagged(tag) > 100, `${tag} occurs in the demo history`);
    assert.equal(tagged('other'), 0);
    // offer tags only ever sit on promotional observations, and match the mechanic
    assert.equal(count(`SELECT COUNT(*) FROM price_observations o WHERE o.is_promo = 0 AND ${OFFER_TAG}`), 0);
    assert.equal(tagged('multi_buy', `AND o.promo_type <> 'multi_buy'`), 0);
    assert.equal(tagged('coupon', `AND o.promo_type <> 'coupon'`), 0);
    for (const tag of ['limited_time_deal', 'event_deal', 'deal']) assert.equal(tagged(tag, `AND o.promo_type <> 'price_cut'`), 0, `${tag} only on price cuts`);
    // deeper cuts carry the stronger badges
    const averageDiscount = (where: string) => demo.ctx.db.scalar<number>(`SELECT AVG(o.discount_pct) FROM price_observations o WHERE o.promo_type = 'price_cut' AND ${where}`)!;
    const strong = averageDiscount(`EXISTS (SELECT 1 FROM json_each(o.tags) WHERE value IN ('limited_time_deal', 'event_deal'))`);
    const untagged = averageDiscount(`NOT ${OFFER_TAG}`);
    assert.ok(strong > untagged + 5, `limited-time and sale-event deals average ${strong.toFixed(1)} % off, untagged price cuts ${untagged.toFixed(1)} %`);
    assert.ok(count(`SELECT COUNT(*) FROM price_observations o WHERE o.promo_type = 'price_cut' AND NOT ${OFFER_TAG}`) > 500, 'many plain price cuts carry no offer tag');
    // the wording stored with a tag is wording the normaliser maps to that very tag
    const wordings = demo.ctx.db.all<{ tags: string; tag_text: string }>(`SELECT DISTINCT tags, tag_text FROM price_observations o WHERE tag_text IS NOT NULL AND ${OFFER_TAG}`);
    assert.ok(wordings.length >= 8);
    for (const { tags, tag_text } of wordings) {
      const offer = parseDealTags(tags).filter((tag) => tag !== 'best_seller' && tag !== 'retailer_choice');
      assert.deepEqual(normaliseDealTags([tag_text]), offer, tag_text);
    }
    assert.ok(wordings.some((w) => /Sale Deal$/.test(w.tag_text)), 'sale-event deals name their event');
    // a few listings are best sellers — and stay best sellers
    const listings = count('SELECT COUNT(*) FROM retailer_listings');
    const bestSellers = count(`SELECT COUNT(DISTINCT o.listing_id) FROM price_observations o WHERE EXISTS (SELECT 1 FROM json_each(o.tags) WHERE value = 'best_seller')`);
    assert.ok(bestSellers >= 5 && bestSellers < listings * 0.15, `${bestSellers} of ${listings} listings are best sellers`);
    assert.equal(
      count(`SELECT COUNT(*) FROM (SELECT o.listing_id FROM price_observations o WHERE o.rating IS NOT NULL GROUP BY o.listing_id
             HAVING COUNT(DISTINCT EXISTS (SELECT 1 FROM json_each(o.tags) WHERE value = 'best_seller')) > 1)`),
      0,
    );
  });

  it('is deterministic: the same profile always yields the same signals', () => {
    const profile: DemoProfile = { seed: 424242, base: 18, step: 0.25, promo: 0.4, depths: [0.1, 0.25, 0.3], types: ['price_cut', 'coupon', 'multi_buy'], drift: 0.05, oos: 0.01, seller: 'Demo Seller', rankIn: 'Shampoo' };
    const first = simulateDays(profile, 150);
    assert.deepEqual(simulateDays(profile, 150), first);
    assert.deepEqual(stateOnDay(profile, 97), first[97]);
    assert.ok(first.some((state) => state.tags.length > 0));
    assert.ok(first.every((state) => state.rating === first[0]!.rating && state.sellerName === 'Demo Seller' && state.salesRankLabel === `#${state.salesRank} in Shampoo`));
    assert.ok(first[150]!.reviewCount > first[0]!.reviewCount);
    // signals come from their own random numbers: the simulated prices are what they were without them
    const { seller: _seller, rankIn: _rankIn, ...bare } = profile;
    assert.deepEqual(simulateDays(bare, 150).map((s) => [s.regular, s.current, s.isPromo, s.promoType, s.availability]), first.map((s) => [s.regular, s.current, s.isPromo, s.promoType, s.availability]));
    const observation = demoObservation(7, first[97]!, '2026-01-01T00:00:00.000Z', '2025-09-01');
    assert.deepEqual(
      [observation.tags, observation.tag_text, observation.rating, observation.review_count, observation.sales_rank, observation.sales_rank_label, observation.seller_name],
      [first[97]!.tags, first[97]!.tagText, first[97]!.rating, first[97]!.reviewCount, first[97]!.salesRank, first[97]!.salesRankLabel, 'Demo Seller'],
    );
  });

  it('keeps emitting the signals when the simulated source runs again', async () => {
    const retailer = demo.ctx.db.get<{ id: number; connector_config: string }>(`SELECT id, connector_config FROM retailers WHERE name = 'Noon UAE'`)!;
    // no deliberate simulated failure for this run
    const config = JSON.parse(retailer.connector_config);
    config.simulated.failure_rate = 0;
    demo.ctx.db.run('UPDATE retailers SET connector_config = ? WHERE id = ?', [JSON.stringify(config), retailer.id]);
    const previous = new Map(
      demo.ctx.db
        .all<{ listing_id: number; rating: number; review_count: number; seller_name: string }>(
          `SELECT o.listing_id, o.rating, o.review_count, o.seller_name FROM listing_state s JOIN price_observations o ON o.id = s.latest_obs_id WHERE o.retailer_id = ?`,
          [retailer.id],
        )
        .map((row) => [row.listing_id, row]),
    );
    const job = await runRetailerNow(demo.ctx, retailer.id, { trigger: 'manual' });
    assert.equal(job.status, 'succeeded', job.error_message ?? '');
    const fresh = demo.ctx.db.all<Record<string, any>>('SELECT * FROM price_observations WHERE job_id = ?', [job.id]);
    assert.ok(fresh.length > 10);
    for (const row of fresh) {
      const before = previous.get(row.listing_id)!;
      assert.equal(row.is_demo, 1);
      assert.equal(row.source_method, 'simulated');
      assert.equal(row.rating, before.rating);
      assert.ok(row.review_count >= before.review_count);
      assert.equal(row.seller_name, before.seller_name);
      assert.ok(row.sales_rank >= 1 && /^#\d+ in /.test(row.sales_rank_label), 'marketplace listings keep their sales rank');
      assert.ok(Array.isArray(JSON.parse(row.tags)));
    }
  });

  it('shows DEMO deals as demo data', async () => {
    const res = await demo.api('GET', '/deals?page_size=200');
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    const body: DealsResponse = res.body;
    assert.ok(body.total > 20);
    assert.ok(body.rows.every((row) => row.is_demo === 1 && row.data_class !== 'collected'));
    assert.deepEqual(body.summary.demo, { demo_rows: body.total, total_rows: body.total, all_demo: true, any_demo: true });
    assert.ok(body.rows.some((row) => row.tags.includes('limited_time_deal')) || body.summary.by_tag.limited_time_deal === 0);
    // tag counts of the monitor and of the deals agree for offer tags: every fresh, offer-tagged listing is a deal
    const monitor = (await demo.api('GET', '/monitor?page_size=1')).body;
    for (const tag of DEAL_OFFER_TAGS) assert.equal(body.summary.by_tag[tag], monitor.facets.by_tag[tag], tag);
    assert.deepEqual(Object.keys(body.summary.by_tag), [...DEAL_TAGS]);
    assert.deepEqual(Object.keys(monitor.facets.by_tag), [...DEAL_TAGS]);
  });
});

// ---------------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------------
describe('migration 002 (signals)', () => {
  it('applies on top of a database created by migration 001 and keeps every row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pios-migrate-'));
    const db = new Db(path.join(dir, 'before-signals.db'));
    try {
      // A database exactly as version 1 left it …
      const migrations = path.join(import.meta.dirname, '..', 'server', 'db', 'migrations');
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
      db.tx(() => {
        db.exec(fs.readFileSync(path.join(migrations, '001_init.sql'), 'utf8'));
        db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)', ['001_init.sql', nowIso()]);
      });
      assert.ok(!db.all<{ name: string }>(`SELECT name FROM pragma_table_info('price_observations')`).some((c) => c.name === 'tags'));
      // … with data in it: a real and a DEMO observation, one of them voided.
      const now = nowIso();
      db.run(`INSERT INTO currencies (code, name, symbol) VALUES ('AED', 'UAE dirham', 'AED')`);
      db.run(`INSERT INTO markets (id, code, name, country_code, country_name, currency_code, timezone, created_at, updated_at) VALUES (1, 'AE', 'United Arab Emirates', 'AE', 'United Arab Emirates', 'AED', 'Asia/Dubai', ?, ?)`, [now, now]);
      db.run(`INSERT INTO retailers (id, name, country_code, market_id, currency_code, collection_method, created_at, updated_at) VALUES (1, 'Old Mart', 'AE', 1, 'AED', 'manual', ?, ?)`, [now, now]);
      db.run(`INSERT INTO retailer_listings (id, retailer_id, title, created_at, updated_at) VALUES (1, 1, 'Old listing', ?, ?)`, [now, now]);
      db.run(`INSERT INTO retailer_listings (id, retailer_id, title, is_demo, created_at, updated_at) VALUES (2, 1, 'Old demo listing', 1, ?, ?)`, [now, now]);
      const insert = `INSERT INTO price_observations (listing_id, retailer_id, market_id, currency_code, regular_price, current_price, is_promo, promo_type, availability,
          observed_at, observed_local_date, collected_at, source_method, dedupe_key, is_demo, created_at)
        VALUES (?, 1, 1, 'AED', ?, ?, ?, ?, 'in_stock', ?, ?, ?, ?, ?, ?, ?)`;
      db.run(insert, [1, 20, 20, 0, null, '2026-03-01T08:00:00.000Z', '2026-03-01', now, 'manual', 'key-1', 0, now]);
      db.run(insert, [1, 20, 16, 1, 'price_cut', '2026-03-02T08:00:00.000Z', '2026-03-02', now, 'manual', 'key-2', 0, now]);
      db.run(insert, [2, 9, 9, 0, null, '2026-03-02T08:00:00.000Z', '2026-03-02', now, 'simulated', 'key-3', 1, now]);
      db.run(`INSERT INTO observation_voids (observation_id, reason, voided_at) VALUES (1, 'entered twice', ?)`, [now]);
      const before = db.all('SELECT id, listing_id, regular_price, current_price, is_promo, promo_type, observed_at, source_method, data_class, dedupe_key, is_demo FROM price_observations ORDER BY id');
      assert.equal(before.length, 3);

      const result = migrate(db);
      assert.equal(result.applied[0], '002_signals.sql');
      assert.ok(result.current >= 2);

      // every row survived untouched, and reads as "no signals"
      assert.deepEqual(db.all('SELECT id, listing_id, regular_price, current_price, is_promo, promo_type, observed_at, source_method, data_class, dedupe_key, is_demo FROM price_observations ORDER BY id'), before);
      assert.deepEqual(
        db.all('SELECT tags, tag_text, rating, review_count, sales_rank, sales_rank_label, seller_name FROM price_observations').map((row) => ({ ...row })),
        Array.from({ length: 3 }, () => ({ tags: '[]', tag_text: null, rating: null, review_count: null, sales_rank: null, sales_rank_label: null, seller_name: null })),
      );
      // the view of non-voided observations exposes the new columns and still hides the voided row
      assert.deepEqual(db.all('SELECT id, tags, rating, seller_name FROM v_observations ORDER BY id').map((row) => ({ ...row })), [
        { id: 2, tags: '[]', rating: null, seller_name: null },
        { id: 3, tags: '[]', rating: null, seller_name: null },
      ]);
      // the ledger is as append-only as before
      assert.throws(() => db.run(`UPDATE price_observations SET tags = '["deal"]' WHERE id = 2`), /append-only/);
      assert.throws(() => db.run('DELETE FROM price_observations WHERE id = 2'), /append-only/);
      assert.equal(db.run('DELETE FROM price_observations WHERE id = 3').changes, 1, 'DEMO rows can still be purged');
      // new observations can carry signals; nonsense is refused by the database itself
      db.run(`${insert.replace('is_demo, created_at)', 'is_demo, created_at, tags, tag_text, rating, review_count, sales_rank, sales_rank_label, seller_name)').replace('?, ?, ?)', `?, ?, ?, '["limited_time_deal"]', 'Limited time deal', 4.5, 120, 3, '#3 in Hair Oils', 'Old Mart')`)}`, [
        1, 20, 15, 1, 'price_cut', '2026-03-03T08:00:00.000Z', '2026-03-03', now, 'manual', 'key-4', 0, now,
      ]);
      assert.equal(db.scalar(`SELECT COUNT(*) FROM price_observations o WHERE o.tags <> '[]' AND EXISTS (SELECT 1 FROM json_each(o.tags) WHERE value = 'limited_time_deal')`), 1);
      assert.throws(
        () => db.run(insert.replace('is_demo, created_at)', 'is_demo, created_at, rating)').replace('?, ?, ?)', '?, ?, ?, 7)'), [1, 20, 15, 1, 'price_cut', '2026-03-04T08:00:00.000Z', '2026-03-04', now, 'manual', 'key-5', 0, now]),
        (err: unknown) => err instanceof SqliteError && err.code === 'CHECK',
      );
      // tagged observations have their own index, and running the migrations again changes nothing
      assert.ok(db.get(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_observations_tagged'`));
      assert.ok(
        db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT id FROM price_observations WHERE listing_id = 1 AND tags <> '[]' ORDER BY observed_at DESC`).some((step) => step.detail.includes('idx_observations_tagged')),
      );
      assert.deepEqual(migrate(db).applied, []);
      assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
