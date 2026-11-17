/**
 * Competitor pairing suggestions on a catalogue with retailer listings: products that are sold side by side
 * rank first, and a whole-catalogue run only proposes pairs that can actually be compared at a retailer.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { suggestCompetitorMappings } from '../server/services/matching.ts';
import { nowIso } from '../server/lib/time.ts';
import { createTestApp, type TestApp } from './helpers.ts';

describe('competitor pairing suggestions and retail presence', () => {
  let t: TestApp;
  const ids: Record<string, number> = {};

  before(async () => {
    t = await createTestApp();
    const { db } = t.ctx;
    const now = nowIso();
    const market = db.get<{ id: number; currency_code: string }>(`SELECT id, currency_code FROM markets WHERE code = 'AE'`)!;
    const brand = (name: string, ownership: string) => db.run('INSERT INTO brands (name, ownership, created_at, updated_at) VALUES (?, ?, ?, ?)', [name, ownership, now, now]).lastInsertRowid;
    const own = brand('Pair Own', 'own');
    const rival = brand('Pair Rival', 'competitor');
    const category = db.run('INSERT INTO categories (name, created_at) VALUES (?, ?)', ['Pair Hair Care', now]).lastInsertRowid;
    const sub = db.run('INSERT INTO categories (name, parent_id, created_at) VALUES (?, ?, ?)', ['Pair Shampoo', category, now]).lastInsertRowid;
    const product = (key: string, brandId: number, size: number) => {
      ids[key] = db.run(
        `INSERT INTO products (brand_id, name, category_id, subcategory_id, pack_size, pack_unit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ml', ?, ?)`,
        [brandId, `Pair ${key}`, category, sub, size, now, now],
      ).lastInsertRowid;
    };
    const retailer = (name: string) =>
      db.run(
        `INSERT INTO retailers (name, country_code, market_id, currency_code, collection_method, collection_frequency, created_at, updated_at) VALUES (?, 'AE', ?, ?, 'manual', 'manual', ?, ?)`,
        [name, market.id, market.currency_code, now, now],
      ).lastInsertRowid;
    const list = (key: string, retailerId: number) =>
      db.run(
        `INSERT INTO retailer_listings (retailer_id, product_id, external_id, title, match_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'matched', ?, ?)`,
        [retailerId, ids[key]!, `${key}-${retailerId}`, key, now, now],
      );
    const [a, b, c] = [retailer('Pair A'), retailer('Pair B'), retailer('Pair C')];

    product('own-wide', own, 400); // listed at A, B and C
    product('own-narrow', own, 400); // listed at C only
    product('own-unlisted', own, 400); // not listed anywhere
    product('rival-two-shared', rival, 400); // A and B
    product('rival-one-shared', rival, 400); // C
    product('rival-unlisted', rival, 400); // nowhere
    product('rival-other-size', rival, 700); // A, B and C, but a different pack
    product('rival-near-size', rival, 420); // A
    for (const r of [a, b, c]) list('own-wide', r);
    list('own-narrow', c);
    for (const r of [a, b]) list('rival-two-shared', r);
    list('rival-one-shared', c);
    for (const r of [a, b, c]) list('rival-other-size', r);
    list('rival-near-size', a);
  });
  after(async () => {
    await t.close();
  });

  const suggestionsOf = (ownKey: string) =>
    t.ctx.db.all<{ competitor_product_id: number; equivalence: string; score: number; rationale: string; status: string }>(
      `SELECT competitor_product_id, equivalence, score, rationale, status FROM competitor_mappings WHERE own_product_id = ? ORDER BY score DESC, id`,
      [ids[ownKey]!],
    );
  const keyOf = (id: number) => Object.entries(ids).find(([, v]) => v === id)![0];

  it('a whole-catalogue run limited to widely listed own products proposes only side-by-side pairs, best first', () => {
    const result = suggestCompetitorMappings(t.ctx, undefined, { minRetailers: 3 });
    assert.equal(result.considered, 1, 'only the own product listed at three retailers is considered');
    const rows = suggestionsOf('own-wide');
    assert.equal(rows.length, 3, 'at most three per own product in a whole-catalogue run');
    assert.deepEqual(rows.map((r) => keyOf(r.competitor_product_id)), ['rival-two-shared', 'rival-one-shared', 'rival-near-size']);
    assert.ok(rows.every((r) => r.status === 'suggested'));
    assert.deepEqual(rows.map((r) => r.equivalence), ['equivalent', 'equivalent', 'equivalent']);
    assert.match(rows[0]!.rationale, /same pack size \(400ml\).*listed side by side at 2 retailers/);
    assert.match(rows[1]!.rationale, /listed side by side at 1 retailer$/);
    assert.ok(rows[0]!.score > rows[1]!.score);
    assert.equal(suggestionsOf('own-narrow').length, 0);
    assert.equal(suggestionsOf('own-unlisted').length, 0);
  });

  it('a later run over everything adds the remaining pairs, never one that cannot be compared at a retailer', () => {
    const result = suggestCompetitorMappings(t.ctx);
    assert.equal(result.considered, 3);
    // the widely listed product gets its next-best pairs (the first three stay)
    const wide = suggestionsOf('own-wide').map((r) => keyOf(r.competitor_product_id));
    assert.deepEqual(wide.slice(0, 3), ['rival-two-shared', 'rival-one-shared', 'rival-near-size']);
    assert.ok(wide.includes('rival-other-size'));
    assert.ok(!wide.includes('rival-unlisted'), 'a competitor that is listed nowhere cannot be compared and is not proposed in bulk');
    const other = suggestionsOf('own-wide').find((r) => keyOf(r.competitor_product_id) === 'rival-other-size')!;
    assert.equal(other.equivalence, 'comparable');
    assert.match(other.rationale, /size differs 400ml vs 700ml.*listed side by side at 3 retailers/);
    // listed at C only: the competitors that are also at C
    assert.deepEqual(suggestionsOf('own-narrow').map((r) => keyOf(r.competitor_product_id)).sort(), ['rival-one-shared', 'rival-other-size']);
    // an own product without listings cannot be narrowed by retailer: the catalogue-only proposal applies, capped at three
    assert.equal(suggestionsOf('own-unlisted').length, 3);
  });

  it('asking for one product still offers every candidate, listed or not', async () => {
    const res = await t.api('POST', '/mappings/suggest', { body: { own_product_id: ids['own-narrow'] } });
    assert.equal(res.status, 200, res.raw);
    const all = suggestionsOf('own-narrow').map((r) => keyOf(r.competitor_product_id)).sort();
    assert.deepEqual(all, ['rival-near-size', 'rival-one-shared', 'rival-other-size', 'rival-two-shared', 'rival-unlisted']);
    // nothing is ever approved by a suggestion run
    assert.equal(t.ctx.db.scalar<number>(`SELECT COUNT(*) FROM competitor_mappings WHERE status <> 'suggested'`), 0);
    const bad = await t.api('POST', '/mappings/suggest', { body: { min_retailers: 0 } });
    assert.equal(bad.status, 422);
  });
});
