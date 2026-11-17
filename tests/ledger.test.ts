import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ago, createFixture, createTestApp, type Fixture, type TestApp } from './helpers.ts';
import { ingestObservations, restoreObservation, voidObservation } from '../server/services/ingestion.ts';
import { rebuildListingDerived } from '../server/services/derived.ts';

let t: TestApp;
let fx: Fixture;

before(async () => {
  t = await createTestApp();
  fx = createFixture(t.ctx);
});
after(async () => {
  await t.close();
});

const count = (sql: string, params: unknown[] = []) => t.ctx.db.scalar<number>(sql, params as never) ?? 0;

describe('append-only price ledger', () => {
  it('stores an observation with timestamp, source and provenance', () => {
    const res = ingestObservations(
      t.ctx,
      [{ listing_id: fx.ownListingId, observed_at: ago(10), current_price: 12.5, regular_price: 12.5, availability: 'in_stock', confidence: 0.9 }],
      { sourceMethod: 'manual', userId: 1 },
    );
    assert.equal(res.inserted, 1);
    assert.equal(res.rejected.length, 0);
    const row = t.ctx.db.get<Record<string, unknown>>('SELECT * FROM price_observations WHERE id = ?', [res.observationIds[0]]);
    assert.equal(row!.current_price, 12.5);
    assert.equal(row!.source_method, 'manual');
    assert.equal(row!.data_class, 'manual');
    assert.equal(row!.currency_code, 'AED');
    assert.equal(row!.is_demo, 0);
    assert.match(String(row!.observed_at), /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.match(String(row!.observed_local_date), /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row!.collected_at);
  });

  it('rejects UPDATE of an observation at the database level', () => {
    assert.throws(() => t.ctx.db.run('UPDATE price_observations SET current_price = 1 WHERE listing_id = ?', [fx.ownListingId]), /append-only/);
  });

  it('rejects DELETE of a real observation at the database level', () => {
    assert.throws(() => t.ctx.db.run('DELETE FROM price_observations WHERE listing_id = ?', [fx.ownListingId]), /append-only/);
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE listing_id = ?', [fx.ownListingId]), 1);
  });

  it('rejects INSERT OR REPLACE that would overwrite an observation', () => {
    const existing = t.ctx.db.get<Record<string, unknown>>('SELECT * FROM price_observations WHERE listing_id = ? LIMIT 1', [fx.ownListingId])!;
    assert.throws(
      () =>
        t.ctx.db.run(
          `INSERT OR REPLACE INTO price_observations (id, listing_id, retailer_id, market_id, currency_code, current_price, availability,
             observed_at, observed_local_date, collected_at, source_method, dedupe_key, is_demo, created_at)
           VALUES (?, ?, ?, ?, 'AED', 99, 'in_stock', ?, ?, ?, 'manual', 'x', 0, ?)`,
          [existing.id, existing.listing_id, existing.retailer_id, existing.market_id, existing.observed_at, existing.observed_local_date, existing.collected_at, existing.created_at] as never,
        ),
      /append-only/,
    );
    assert.equal(t.ctx.db.get<{ current_price: number }>('SELECT current_price FROM price_observations WHERE id = ?', [existing.id as number])!.current_price, 12.5);
  });

  it('skips an identical re-ingestion (idempotent) regardless of the channel', () => {
    const at = ago(9);
    const input = { listing_id: fx.ownListingId, observed_at: at, current_price: 12.5, availability: 'in_stock' as const };
    assert.equal(ingestObservations(t.ctx, [input], { sourceMethod: 'csv_import' }).inserted, 1);
    const again = ingestObservations(t.ctx, [input, input], { sourceMethod: 'csv_import' });
    assert.equal(again.inserted, 0);
    assert.equal(again.duplicates, 2);
    const viaOtherChannel = ingestObservations(t.ctx, [input], { sourceMethod: 'manual' });
    assert.equal(viaOtherChannel.duplicates, 1);
  });

  it('keeps unchanged prices as separate observations when the timestamps differ', () => {
    const before = count('SELECT COUNT(*) FROM price_observations WHERE listing_id = ?', [fx.ownListingId]);
    const res = ingestObservations(
      t.ctx,
      [
        { listing_id: fx.ownListingId, observed_at: ago(8), current_price: 12.5, availability: 'in_stock' },
        { listing_id: fx.ownListingId, observed_at: ago(7), current_price: 12.5, availability: 'in_stock' },
      ],
      { sourceMethod: 'manual' },
    );
    assert.equal(res.inserted, 2);
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE listing_id = ?', [fx.ownListingId]), before + 2);
  });

  it('supersedes (voids, never overwrites) a different value recorded for the same instant', () => {
    const at = ago(6);
    const first = ingestObservations(t.ctx, [{ listing_id: fx.ownListingId, observed_at: at, current_price: 13, availability: 'in_stock' }], { sourceMethod: 'csv_import' });
    const second = ingestObservations(t.ctx, [{ listing_id: fx.ownListingId, observed_at: at, current_price: 14, availability: 'in_stock' }], { sourceMethod: 'csv_import' });
    assert.equal(second.inserted, 1);
    assert.equal(second.superseded, 1);
    // original is still in the ledger…
    assert.equal(t.ctx.db.get<{ current_price: number }>('SELECT current_price FROM price_observations WHERE id = ?', [first.observationIds[0]])!.current_price, 13);
    // …but excluded from analytics
    assert.equal(count('SELECT COUNT(*) FROM v_observations WHERE id = ?', [first.observationIds[0]]), 0);
    assert.equal(count('SELECT COUNT(*) FROM v_observations WHERE id = ?', [second.observationIds[0]]), 1);
  });

  it('allows purging DEMO observations only', () => {
    const now = new Date().toISOString();
    t.ctx.db.run(`UPDATE retailer_listings SET is_demo = 1 WHERE id = ?`, [fx.compListingId]);
    const res = ingestObservations(t.ctx, [{ listing_id: fx.compListingId, observed_at: ago(3), current_price: 20 }], { sourceMethod: 'simulated' });
    assert.equal(res.inserted, 1);
    assert.equal(t.ctx.db.get<{ is_demo: number }>('SELECT is_demo FROM price_observations WHERE id = ?', [res.observationIds[0]])!.is_demo, 1);
    t.ctx.db.run('DELETE FROM listing_state WHERE listing_id = ?', [fx.compListingId]);
    t.ctx.db.run('DELETE FROM price_observations WHERE id = ?', [res.observationIds[0]]);
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE id = ?', [res.observationIds[0]]), 0);
    t.ctx.db.run(`UPDATE retailer_listings SET is_demo = 0, updated_at = ? WHERE id = ?`, [now, fx.compListingId]);
  });

  it('refuses simulated observations on real listings', () => {
    const res = ingestObservations(t.ctx, [{ listing_id: fx.ownListingId, observed_at: ago(1), current_price: 10 }], { sourceMethod: 'simulated' });
    assert.equal(res.inserted, 0);
    assert.match(res.rejected[0]!.reason, /demo listings/);
  });
});

describe('observation normalisation', () => {
  it('detects a price-cut promotion and computes the discount', () => {
    const res = ingestObservations(
      t.ctx,
      [{ listing_id: fx.compListingId, observed_at: ago(20), regular_price: 20, current_price: 15, availability: 'in_stock' }],
      { sourceMethod: 'manual' },
    );
    const row = t.ctx.db.get<Record<string, unknown>>('SELECT * FROM price_observations WHERE id = ?', [res.observationIds[0]])!;
    assert.equal(row.is_promo, 1);
    assert.equal(row.promo_type, 'price_cut');
    assert.equal(row.promo_price, 15);
    assert.equal(row.discount_pct, 25);
  });

  it('treats a separately reported promo price as the selling price', () => {
    const res = ingestObservations(
      t.ctx,
      [{ listing_id: fx.compListingId, observed_at: ago(19), current_price: 20, promo_price: 16, availability: 'in_stock' }],
      { sourceMethod: 'manual' },
    );
    const row = t.ctx.db.get<Record<string, unknown>>('SELECT * FROM price_observations WHERE id = ?', [res.observationIds[0]])!;
    assert.equal(row.current_price, 16);
    assert.equal(row.regular_price, 20);
    assert.equal(row.discount_pct, 20);
  });

  it('keeps the shelf price for multi-buy offers', () => {
    const res = ingestObservations(
      t.ctx,
      [{ listing_id: fx.compListingId, observed_at: ago(18), current_price: 20, promo_price: 15, promo_type: 'multi_buy', promo_description: '2 for 30', regular_price: 20 }],
      { sourceMethod: 'manual' },
    );
    const row = t.ctx.db.get<Record<string, unknown>>('SELECT * FROM price_observations WHERE id = ?', [res.observationIds[0]])!;
    assert.equal(row.current_price, 20);
    assert.equal(row.promo_price, 15);
    assert.equal(row.promo_type, 'multi_buy');
    assert.equal(row.discount_pct, 25);
  });

  it('accepts an out-of-stock observation without a price', () => {
    const res = ingestObservations(t.ctx, [{ listing_id: fx.compListingId, observed_at: ago(17), availability: 'out_of_stock' }], { sourceMethod: 'manual' });
    assert.equal(res.inserted, 1);
  });

  it('rejects invalid observations with a clear reason and never stores them', () => {
    const before = count('SELECT COUNT(*) FROM price_observations');
    const res = ingestObservations(
      t.ctx,
      [
        { listing_id: fx.compListingId, observed_at: ago(16) },
        { listing_id: fx.compListingId, observed_at: new Date(Date.now() + 86_400_000).toISOString(), current_price: 5 },
        { listing_id: fx.compListingId, observed_at: ago(16), current_price: 5, currency_code: 'USD' },
        { listing_id: fx.compListingId, observed_at: 'not a date', current_price: 5 },
        { listing_id: fx.compListingId, observed_at: ago(16), current_price: -4 },
        { listing_id: 999_999, observed_at: ago(16), current_price: 5 },
      ],
      { sourceMethod: 'csv_import' },
    );
    assert.equal(res.inserted, 0);
    assert.equal(res.rejected.length, 6);
    assert.match(res.rejected[0]!.reason, /selling price is required/);
    assert.match(res.rejected[1]!.reason, /future/);
    assert.match(res.rejected[2]!.reason, /does not match the retailer currency/);
    assert.match(res.rejected[3]!.reason, /invalid/);
    assert.match(res.rejected[4]!.reason, /negative/);
    assert.match(res.rejected[5]!.reason, /does not exist/);
    assert.equal(count('SELECT COUNT(*) FROM price_observations'), before);
  });
});

describe('derived state', () => {
  let listingId: number;

  before(() => {
    const f2 = createFixture(t.ctx, { retailerName: 'Derived Mart' });
    listingId = f2.ownListingId;
  });

  const snapshot = () => ({
    events: t.ctx.db.all(
      `SELECT kind, direction, old_price, new_price, change_pct, occurred_at, observation_id, prev_observation_id FROM price_events WHERE listing_id = ? ORDER BY occurred_at, kind`,
      [listingId],
    ),
    promos: t.ctx.db.all(
      `SELECT first_observation_id, last_observation_id, status, end_reason, started_at, last_seen_at, ended_at, duration_days,
         promo_days_observed, observation_count, regular_price, min_promo_price, max_discount_pct, avg_discount_pct
       FROM promotions WHERE listing_id = ? ORDER BY started_at`,
      [listingId],
    ),
    state: t.ctx.db.get(`SELECT latest_obs_id, prev_obs_id, first_observed_at, last_observed_at, obs_count, last_price_change_at FROM listing_state WHERE listing_id = ?`, [listingId]),
  });

  it('tracks latest state, price changes and promotion episodes as observations arrive', () => {
    // day -30..-1, one observation per day, arriving one at a time (incremental path)
    const prices: Array<[number, number, number | null]> = []; // [daysAgo, current, regular]
    for (let d = 30; d >= 1; d--) {
      let current = 20;
      let regular: number | null = 20;
      if (d <= 24 && d >= 20) current = 16; // promo 1: 5 days at 20% off
      if (d <= 12) regular = 22; // list price increase
      if (d <= 12) current = 22;
      if (d <= 6 && d >= 4) current = 17.6; // promo 2: 3 days at 20% off
      prices.push([d, current, regular]);
    }
    for (const [d, current, regular] of prices) {
      const res = ingestObservations(
        t.ctx,
        [{ listing_id: listingId, observed_at: ago(d), current_price: current, regular_price: regular, availability: 'in_stock' }],
        { sourceMethod: 'manual', suppressAlerts: true },
      );
      assert.equal(res.inserted, 1);
    }
    const s = snapshot();
    const kinds = s.events.map((e: any) => e.kind);
    assert.equal(kinds.filter((k: string) => k === 'price_change').length, 5); // 20→16, 16→20, 20→22, 22→17.6, 17.6→22
    assert.equal(kinds.filter((k: string) => k === 'promo_start').length, 2);
    assert.equal(kinds.filter((k: string) => k === 'promo_end').length, 2);
    const firstDrop: any = s.events.find((e: any) => e.kind === 'price_change');
    assert.equal(firstDrop.direction, 'down');
    assert.equal(firstDrop.change_pct, -20);
    assert.equal(s.promos.length, 2);
    const [p1, p2] = s.promos as any[];
    assert.equal(p1.status, 'ended');
    assert.equal(p1.end_reason, 'price_restored');
    assert.equal(p1.duration_days, 5);
    assert.equal(p1.observation_count, 5);
    assert.equal(p1.max_discount_pct, 20);
    assert.equal(p1.min_promo_price, 16);
    assert.equal(p2.duration_days, 3);
    assert.equal((s.state as any).obs_count, 30);
  });

  it('gives identical results when rebuilt from the ledger', () => {
    const incremental = snapshot();
    t.ctx.db.tx(() => rebuildListingDerived(t.ctx, listingId));
    assert.deepEqual(snapshot(), incremental);
  });

  it('handles back-filled history (out-of-order arrival) correctly', () => {
    // an older observation arrives late: 45 days ago at a different price
    const res = ingestObservations(t.ctx, [{ listing_id: listingId, observed_at: ago(45), current_price: 19, regular_price: 19 }], {
      sourceMethod: 'csv_import',
      suppressAlerts: true,
    });
    assert.equal(res.inserted, 1);
    const s = snapshot();
    assert.equal((s.state as any).obs_count, 31);
    const first: any = s.events[0];
    assert.equal(first.kind, 'price_change');
    assert.equal(first.old_price, 19);
    assert.equal(first.new_price, 20);
    // latest pointer is unchanged by back-fill
    const latest = t.ctx.db.get<{ current_price: number }>(
      'SELECT o.current_price FROM listing_state s JOIN price_observations o ON o.id = s.latest_obs_id WHERE s.listing_id = ?',
      [listingId],
    )!;
    assert.equal(latest.current_price, 22);
  });

  it('recomputes when an observation is voided and when it is restored', () => {
    const before = snapshot();
    const promoObs = t.ctx.db.all<{ id: number }>(
      `SELECT id FROM price_observations WHERE listing_id = ? AND is_promo = 1 AND current_price = 17.6 ORDER BY observed_at`,
      [listingId],
    );
    for (const o of promoObs) voidObservation(t.ctx, o.id, 'test void', 1);
    const voided = snapshot();
    assert.equal(voided.promos.length, 1);
    assert.equal((voided.state as any).obs_count, 28);
    for (const o of promoObs) restoreObservation(t.ctx, o.id);
    assert.deepEqual(snapshot(), before);
    // the ledger itself never lost a row
    assert.equal(count('SELECT COUNT(*) FROM price_observations WHERE listing_id = ?', [listingId]), 31);
  });

  it('incremental and rebuilt state agree for randomised sequences', () => {
    const f3 = createFixture(t.ctx, { retailerName: 'Random Mart' });
    const id = f3.ownListingId;
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let regular = 30;
    for (let d = 120; d >= 1; d--) {
      if (rnd() < 0.05) regular = Math.round(regular * (0.95 + rnd() * 0.12) * 100) / 100;
      const promo = rnd() < 0.25;
      const oos = rnd() < 0.04;
      const perDay = rnd() < 0.2 ? 2 : 1;
      for (let k = 0; k < perDay; k++) {
        ingestObservations(
          t.ctx,
          [
            {
              listing_id: id,
              observed_at: ago(d, -k * 6),
              regular_price: regular,
              current_price: oos ? null : promo ? Math.round(regular * 0.8 * 100) / 100 : regular,
              availability: oos ? 'out_of_stock' : 'in_stock',
            },
          ],
          { sourceMethod: 'manual', suppressAlerts: true },
        );
      }
      if (rnd() < 0.08) d -= Math.floor(rnd() * 14); // gaps in collection
    }
    const snap = () => ({
      events: t.ctx.db.all(`SELECT kind, direction, old_price, new_price, change_pct, observation_id, prev_observation_id FROM price_events WHERE listing_id = ? ORDER BY observation_id, kind`, [id]),
      promos: t.ctx.db.all(
        `SELECT first_observation_id, last_observation_id, status, end_reason, ended_at, duration_days, promo_days_observed, observation_count,
           min_promo_price, max_discount_pct, avg_discount_pct, discount_obs_count FROM promotions WHERE listing_id = ? ORDER BY first_observation_id`,
        [id],
      ),
      state: t.ctx.db.get(`SELECT latest_obs_id, prev_obs_id, first_observed_at, last_observed_at, obs_count, last_price_change_at FROM listing_state WHERE listing_id = ?`, [id]),
    });
    const incremental = snap();
    assert.ok(incremental.events.length > 10);
    assert.ok(incremental.promos.length > 3);
    t.ctx.db.tx(() => rebuildListingDerived(t.ctx, id));
    assert.deepEqual(snap(), incremental);
  });
});

describe('authentication and access control', () => {
  it('rejects unauthenticated API calls and wrong passwords', async () => {
    assert.equal((await t.api('GET', '/auth/me', { as: null })).status, 401);
    const bad = await t.api('POST', '/auth/login', { as: null, body: { email: 'admin@test.local', password: 'wrong' } });
    assert.equal(bad.status, 401);
  });

  it('returns the signed-in user with role-based permissions', async () => {
    const admin = await t.api('GET', '/auth/me', { as: 'admin' });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.user.role, 'admin');
    assert.ok(admin.body.permissions.includes('admin.users'));
    const viewer = await t.api('GET', '/auth/me', { as: 'viewer' });
    assert.ok(!viewer.body.permissions.includes('catalogue.write'));
    assert.ok(viewer.body.permissions.includes('reports.generate'));
  });

  it('never returns password hashes', async () => {
    const me = await t.api('GET', '/auth/me');
    assert.ok(!JSON.stringify(me.body).includes('scrypt'));
  });

  it('blocks cross-site writes on cookie sessions', async () => {
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@test.local', password: 'Test-Password-2026' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    assert.match(String(login.headers['set-cookie']), /HttpOnly/i);
    const cross = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'sec-fetch-site': 'cross-site' } });
    assert.equal(cross.statusCode, 403);
    const same = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    assert.equal(same.statusCode, 200);
    const after = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    assert.equal(after.statusCode, 401);
  });
});
