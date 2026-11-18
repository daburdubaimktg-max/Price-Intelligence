import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { ago, createFixture, createTestApp, type Fixture, type TestApp } from './helpers.ts';
import { fireHook } from '../server/context.ts';
import { ingestObservations, type ObservationInput } from '../server/services/ingestion.ts';
import { comparisonBasis, evaluateIngested, freshnessWindowHours, runStateChecks } from '../server/services/alerts.ts';
import { flushNotifications } from '../server/services/notifications.ts';
import { setSetting } from '../server/services/core.ts';
import { ALERT_TYPES, MANUAL_STALE_HOURS } from '../shared/constants.ts';

let t: TestApp;

before(async () => {
  t = await createTestApp();
});
after(async () => {
  await flushNotifications(t.ctx);
  await t.close();
});

/** Records one observation `hoursAgo` hours in the past (recent enough to be alert-relevant). */
const obs = (listingId: number, hoursAgo: number, fields: Partial<ObservationInput> = {}) =>
  ingestObservations(t.ctx, [{ listing_id: listingId, observed_at: ago(0, hoursAgo), availability: 'in_stock', ...fields }], { sourceMethod: 'manual' });

interface AlertRecord {
  id: number;
  rule_id: number | null;
  type: string;
  severity: string;
  title: string;
  message: string;
  status: string;
  listing_id: number | null;
  product_id: number | null;
  retailer_id: number | null;
  market_id: number | null;
  observation_id: number | null;
  job_id: number | null;
  payload: any;
  triggered_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  is_demo: number;
}

function alertsOf(type: string, where: { listing?: number; retailer?: number; rule?: number } = {}): AlertRecord[] {
  const conditions = ['type = ?'];
  const params: Array<string | number> = [type];
  if (where.listing !== undefined) {
    conditions.push('listing_id = ?');
    params.push(where.listing);
  }
  if (where.retailer !== undefined) {
    conditions.push('retailer_id = ?');
    params.push(where.retailer);
  }
  if (where.rule !== undefined) {
    conditions.push('rule_id = ?');
    params.push(where.rule);
  }
  return t.ctx.db
    .all<AlertRecord>(`SELECT * FROM alerts WHERE ${conditions.join(' AND ')} ORDER BY id`, params)
    .map((a) => ({ ...a, payload: JSON.parse(a.payload as unknown as string) }));
}

const ruleId = (type: string) => t.ctx.db.get<{ id: number }>('SELECT id FROM alert_rules WHERE type = ? ORDER BY id LIMIT 1', [type])!.id;
const marketId = (code: string) => t.ctx.db.get<{ id: number }>('SELECT id FROM markets WHERE code = ?', [code])!.id;

async function createRule(body: Record<string, unknown>): Promise<number> {
  const res = await t.api('POST', '/alert-rules', { body });
  assert.equal(res.status, 201, res.raw);
  return res.body.id;
}

describe('default alert rules', () => {
  it('creates one rule per alert type from the brief on an empty installation', () => {
    const rules = t.ctx.db.all<{ type: string; is_enabled: number; is_demo: number; threshold_pct: number | null; threshold_count: number | null; severity: string }>(
      'SELECT type, is_enabled, is_demo, threshold_pct, threshold_count, severity FROM alert_rules ORDER BY id',
    );
    assert.equal(rules.length, 9);
    assert.deepEqual([...new Set(rules.map((r) => r.type))].sort(), [...ALERT_TYPES].sort());
    assert.ok(rules.every((r) => r.is_demo === 0));
    const byType = Object.fromEntries(rules.map((r) => [r.type, r]));
    assert.equal(byType.competitor_price_drop!.threshold_pct, 10);
    assert.equal(byType.competitor_promotion!.threshold_pct, 15);
    assert.equal(byType.price_increase!.threshold_pct, 5);
    assert.equal(byType.collection_failed!.threshold_count, 3);
    assert.equal(byType.collection_failed!.severity, 'critical');
    // the catch-all "any selling price change" rule is opt-in
    assert.equal(byType.price_change!.is_enabled, 0);
    assert.equal(byType.price_change!.severity, 'info');
    // newly found products: informational, from the first new listing of a run
    assert.equal(byType.new_listing!.threshold_count, 1);
    assert.equal(byType.new_listing!.severity, 'info');
    assert.equal(byType.new_listing!.is_enabled, 1);
  });
});

describe('event rules', () => {
  it('alerts when a competitor lowers its price by at least the threshold', () => {
    const f = createFixture(t.ctx, { retailerName: 'Drop Mart' });
    obs(f.compListingId, 40, { current_price: 30, regular_price: 30 });
    obs(f.compListingId, 30, { current_price: 26, regular_price: 26 });
    const alerts = alertsOf('competitor_price_drop', { listing: f.compListingId });
    assert.equal(alerts.length, 1);
    const a = alerts[0]!;
    assert.equal(a.severity, 'warning');
    assert.equal(a.status, 'open');
    assert.equal(a.product_id, f.compProductId);
    assert.equal(a.retailer_id, f.retailerId);
    assert.equal(a.market_id, f.marketId);
    assert.ok(a.observation_id);
    assert.equal(a.is_demo, 0);
    assert.equal(a.payload.old_price, 30);
    assert.equal(a.payload.new_price, 26);
    assert.equal(a.payload.change_pct, -13.33);
    assert.equal(a.payload.currency_code, 'AED');
    assert.match(a.title, /Competitor price drop: Rival Oil 300ml .* -13\.3% at Drop Mart/);
    assert.match(a.message, /\(300ml\) at Drop Mart, UAE: AED 30\.00 → AED 26\.00 \(-13\.3%\) on \d{1,2} \w{3} \d{4}\./);

    // below the threshold: no alert
    obs(f.compListingId, 20, { current_price: 24.5, regular_price: 24.5 });
    assert.equal(alertsOf('competitor_price_drop', { listing: f.compListingId }).length, 1);

    // an own product dropping its price is not a competitor price drop
    obs(f.ownListingId, 40, { current_price: 20 });
    obs(f.ownListingId, 30, { current_price: 16 });
    assert.equal(alertsOf('competitor_price_drop', { listing: f.ownListingId }).length, 0);
  });

  it('is idempotent: evaluating the same events again creates nothing', () => {
    const f = createFixture(t.ctx, { retailerName: 'Idem Mart' });
    obs(f.compListingId, 40, { current_price: 50 });
    const res = obs(f.compListingId, 30, { current_price: 40 });
    assert.equal(alertsOf('competitor_price_drop', { listing: f.compListingId }).length, 1);
    const before = t.ctx.db.scalar<number>('SELECT COUNT(*) FROM alerts')!;
    const created = evaluateIngested(t.ctx, { sourceMethod: 'manual', isDemo: false, listingIds: [f.compListingId], events: res.events, alertMaxAgeHours: 48 });
    assert.equal(created, 0);
    assert.equal(t.ctx.db.scalar<number>('SELECT COUNT(*) FROM alerts'), before);
  });

  it('never alerts on back-filled history (events older than the alert window)', () => {
    const f = createFixture(t.ctx, { retailerName: 'History Mart' });
    ingestObservations(
      t.ctx,
      [
        { listing_id: f.compListingId, observed_at: ago(10), current_price: 30 },
        { listing_id: f.compListingId, observed_at: ago(9), current_price: 20 },
      ],
      { sourceMethod: 'csv_import' },
    );
    assert.equal(t.ctx.db.scalar<number>('SELECT COUNT(*) FROM alerts WHERE retailer_id = ?', [f.retailerId]), 0);
    // the same events are alert-worthy when the caller widens the window explicitly (demo replay)
    const events = t.ctx.db.all<any>('SELECT * FROM price_events WHERE listing_id = ?', [f.compListingId]);
    assert.equal(evaluateIngested(t.ctx, { sourceMethod: 'csv_import', isDemo: false, listingIds: [], events, alertMaxAgeHours: 24 * 30 }), 1);
    const a = alertsOf('competitor_price_drop', { listing: f.compListingId })[0]!;
    assert.equal(a.triggered_at, events[0].occurred_at);
  });

  it('alerts on unexpected price increases but not when a promotion simply ends', () => {
    const f = createFixture(t.ctx, { retailerName: 'Increase Mart' });
    obs(f.ownListingId, 40, { current_price: 20 });
    obs(f.ownListingId, 30, { current_price: 21.5 });
    let alerts = alertsOf('price_increase', { listing: f.ownListingId });
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.title, /Price increase: Own Oil 200ml .* \+7\.5% at Increase Mart/);
    obs(f.ownListingId, 20, { current_price: 22 }); // +2.3 % — below 5 %
    assert.equal(alertsOf('price_increase', { listing: f.ownListingId }).length, 1);

    // promotion ends and the price returns to its regular level: expected, no alert
    obs(f.compListingId, 40, { current_price: 30, regular_price: 30 });
    obs(f.compListingId, 30, { current_price: 24, regular_price: 30 });
    obs(f.compListingId, 20, { current_price: 30, regular_price: 30 });
    assert.equal(alertsOf('price_increase', { listing: f.compListingId }).length, 0);

    // promotion ends at a price 10 % above the previous regular price: that part is unexpected
    obs(f.compListingId, 10, { current_price: 24, regular_price: 30 });
    obs(f.compListingId, 5, { current_price: 33, regular_price: 33 });
    alerts = alertsOf('price_increase', { listing: f.compListingId });
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.title, /\+10\.0%/);
    assert.match(alerts[0]!.message, /previous regular price of AED 30\.00/);
    assert.equal(alerts[0]!.payload.change_pct, 37.5, 'the raw move from the promotional price is kept');
    assert.equal(alerts[0]!.payload.change_vs_regular_pct, 10);
    assert.equal(alerts[0]!.payload.regular_price, 30);
  });

  it('supports an opt-in rule for any selling price change', async () => {
    const id = ruleId('price_change');
    const f = createFixture(t.ctx, { retailerName: 'Change Mart' });
    obs(f.ownListingId, 46, { current_price: 20 });
    obs(f.ownListingId, 44, { current_price: 21 });
    assert.equal(alertsOf('price_change', { listing: f.ownListingId }).length, 0, 'rule ships disabled');

    const on = await t.api('POST', `/alert-rules/${id}/toggle`, { body: {} });
    assert.equal(on.body.is_enabled, true);
    obs(f.ownListingId, 40, { current_price: 21.1 }); // +0.48 % — below the 1 % threshold
    assert.equal(alertsOf('price_change', { listing: f.ownListingId }).length, 0);
    obs(f.ownListingId, 30, { current_price: 20.5 }); // −2.8 %
    const alerts = alertsOf('price_change', { listing: f.ownListingId });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.severity, 'info');
    const off = await t.api('POST', `/alert-rules/${id}/toggle`, { body: { enabled: false } });
    assert.equal(off.body.is_enabled, false);
  });

  it('alerts when a competitor launches a significant promotion', async () => {
    const f = createFixture(t.ctx, { retailerName: 'Promo Mart' });
    obs(f.compListingId, 46, { current_price: 30, regular_price: 30 });
    obs(f.compListingId, 44, { current_price: 24, regular_price: 30, promo_description: 'Weekend deal' });
    let alerts = alertsOf('competitor_promotion', { listing: f.compListingId });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.payload.discount_pct, 20);
    assert.equal(alerts[0]!.payload.promo_price, 24);
    assert.equal(alerts[0]!.payload.regular_price, 30);
    assert.equal(alerts[0]!.payload.promo_type, 'price_cut');
    assert.match(alerts[0]!.title, /Competitor promotion: Rival Oil 300ml .* 20% off at Promo Mart/);
    assert.match(alerts[0]!.message, /"Weekend deal": AED 24\.00 \(regular AED 30\.00\), 20% off\./);

    // a 10 % promotion is below the 15 % threshold
    obs(f.compListingId, 40, { current_price: 30, regular_price: 30 });
    obs(f.compListingId, 36, { current_price: 27, regular_price: 30 });
    assert.equal(alertsOf('competitor_promotion', { listing: f.compListingId }).length, 1);

    // a promotion of unknown depth does not satisfy a 15 % threshold…
    obs(f.compListingId, 30, { current_price: 30, regular_price: 30 });
    obs(f.compListingId, 26, { current_price: 30, regular_price: 30, promo_type: 'bundle', promo_description: 'Free comb with purchase' });
    assert.equal(alertsOf('competitor_promotion', { listing: f.compListingId }).length, 1);

    // …but it does satisfy a rule that accepts any promotion
    const anyPromo = await createRule({ name: 'Any competitor promotion', type: 'competitor_promotion', threshold_pct: 0, retailer_id: f.retailerId });
    obs(f.compListingId, 20, { current_price: 30, regular_price: 30 });
    obs(f.compListingId, 16, { current_price: 30, regular_price: 30, promo_type: 'bundle', promo_description: 'Free comb with purchase' });
    alerts = alertsOf('competitor_promotion', { rule: anyPromo });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.payload.discount_pct, null);
    assert.match(alerts[0]!.message, /discount depth not stated/);

    // own-brand promotions are not competitor promotions
    obs(f.ownListingId, 40, { current_price: 20, regular_price: 20 });
    obs(f.ownListingId, 30, { current_price: 15, regular_price: 20 });
    assert.equal(alertsOf('competitor_promotion', { listing: f.ownListingId }).length, 0);
  });

  it('alerts when a product becomes unavailable', () => {
    const f = createFixture(t.ctx, { retailerName: 'Stock Mart' });
    obs(f.compListingId, 40, { current_price: 30 });
    obs(f.compListingId, 30, { current_price: 30, availability: 'out_of_stock' });
    const alerts = alertsOf('product_unavailable', { listing: f.compListingId });
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.title, /Out of stock: Rival Oil 300ml .* at Stock Mart/);
    assert.match(alerts[0]!.message, /became unavailable on .* \(previously in stock\)\. Last selling price: AED 30\.00\./);
    obs(f.compListingId, 20, { current_price: 30, availability: 'in_stock' });
    assert.equal(alertsOf('product_unavailable', { listing: f.compListingId }).length, 1, 'coming back in stock is not an alert');
  });

  it('applies rule scopes (market, retailer, brand, category incl. subcategory, product)', async () => {
    const f = createFixture(t.ctx, { retailerName: 'Scope Mart' });
    const now = new Date().toISOString();
    const sub = t.ctx.db.run('INSERT INTO categories (name, parent_id, created_at) VALUES (?, ?, ?)', ['Coconut Oil', f.categoryId, now]).lastInsertRowid;
    t.ctx.db.run('UPDATE products SET subcategory_id = ? WHERE id = ?', [sub, f.compProductId]);
    const base = { type: 'competitor_price_drop', threshold_pct: 1, retailer_id: f.retailerId };
    const otherMarket = await createRule({ name: 'Other market', type: 'competitor_price_drop', threshold_pct: 1, market_id: marketId('SA') });
    const sameMarket = await createRule({ ...base, name: 'Same market', market_id: f.marketId });
    const brand = await createRule({ ...base, name: 'Brand', brand_id: f.compBrandId });
    const otherBrand = await createRule({ ...base, name: 'Other brand', brand_id: f.ownBrandId });
    const category = await createRule({ ...base, name: 'Category', category_id: f.categoryId });
    const subcategory = await createRule({ ...base, name: 'Subcategory', category_id: sub });
    const otherProduct = await createRule({ ...base, name: 'Other product', product_id: f.ownProductId });
    const product = await createRule({ ...base, name: 'Product', product_id: f.compProductId });

    obs(f.compListingId, 40, { current_price: 30 });
    obs(f.compListingId, 30, { current_price: 29 }); // −3.3 %: only the low-threshold scoped rules can fire
    const fired = new Set(alertsOf('competitor_price_drop', { listing: f.compListingId }).map((a) => a.rule_id));
    assert.deepEqual([...fired].sort(), [sameMarket, brand, category, subcategory, product].sort());
    for (const id of [otherMarket, otherBrand, otherProduct]) assert.ok(!fired.has(id));
    // keep later tests quiet
    for (const id of [otherMarket, sameMarket, brand, otherBrand, category, subcategory, otherProduct, product]) {
      assert.equal((await t.api('DELETE', `/alert-rules/${id}`)).status, 200);
    }
  });

  it('honours the cool-down per rule and listing', async () => {
    const f = createFixture(t.ctx, { retailerName: 'Cooldown Mart' });
    const rule = await createRule({ name: 'Increase with cool-down', type: 'price_increase', threshold_pct: 1, cooldown_hours: 24, retailer_id: f.retailerId });
    obs(f.ownListingId, 40, { current_price: 20 });
    obs(f.ownListingId, 30, { current_price: 21 });
    obs(f.ownListingId, 20, { current_price: 22 }); // 10 h after the first alert → suppressed
    assert.equal(alertsOf('price_increase', { rule }).length, 1);
    obs(f.ownListingId, 2, { current_price: 23.5 }); // 28 h after the first alert → allowed again
    assert.equal(alertsOf('price_increase', { rule }).length, 2);
    // a different listing is not affected by the cool-down of the first
    obs(f.compListingId, 30, { current_price: 20 });
    obs(f.compListingId, 25, { current_price: 21 });
    assert.equal(alertsOf('price_increase', { rule }).length, 3);
  });
});

describe('own brand more expensive than a mapped competitor', () => {
  it('compares non-identical packs on unit price and alerts only when the gap is crossed', async () => {
    const f = createFixture(t.ctx, { retailerName: 'Gap Mart' }); // own 200 ml, competitor 300 ml, mapping "comparable"
    const strict = await createRule({ name: 'Premium of 20%+', type: 'own_more_expensive', threshold_pct: 20, retailer_id: f.retailerId });
    const standard = ruleId('own_more_expensive'); // default rule: any premium
    obs(f.compListingId, 46, { current_price: 21 }); // 7.00 per 100 ml
    obs(f.ownListingId, 45, { current_price: 12 }); //  6.00 per 100 ml → own is cheaper
    assert.equal(alertsOf('own_more_expensive', { listing: f.ownListingId }).length, 0);

    obs(f.ownListingId, 40, { current_price: 15 }); // 7.50 per 100 ml → +7.1 % although the shelf price (15) is below the competitor's (21)
    let alerts = alertsOf('own_more_expensive', { listing: f.ownListingId });
    assert.equal(alerts.length, 1);
    const first = alerts[0]!;
    assert.equal(first.rule_id, standard);
    assert.equal(first.product_id, f.ownProductId);
    assert.equal(first.payload.basis, 'unit');
    assert.equal(first.payload.unit_basis, 'per 100ml');
    assert.equal(first.payload.equivalence, 'comparable');
    assert.equal(first.payload.trigger, 'own_price_change');
    assert.equal(first.payload.gap_pct, 7.14);
    assert.equal(first.payload.previous_gap_pct, -14.29);
    assert.equal(first.payload.own.price, 15);
    assert.equal(first.payload.own.unit_price, 7.5);
    assert.equal(first.payload.competitor.price, 21);
    assert.equal(first.payload.competitor.unit_price, 7);
    assert.equal(first.payload.competitor.listing_id, f.compListingId);
    assert.match(first.title, /Own product priced above competitor: Own Oil 200ml .* vs Rival Oil 300ml .* at Gap Mart \(\+7\.1%\)/);
    assert.match(first.message, /price per 100ml, non-equivalent products/);

    // the competitor gets cheaper (6.00) while own is already above: not a new crossing for the standard rule…
    obs(f.compListingId, 35, { current_price: 18 });
    assert.equal(alertsOf('own_more_expensive', { rule: standard, listing: f.ownListingId }).length, 1);
    // …but the premium is now +25 %, which crosses the stricter 20 % rule for the first time
    const strictAlerts = alertsOf('own_more_expensive', { rule: strict });
    assert.equal(strictAlerts.length, 1);
    assert.equal(strictAlerts[0]!.payload.gap_pct, 25);
    assert.equal(strictAlerts[0]!.payload.previous_gap_pct, 7.14);
    assert.equal(strictAlerts[0]!.payload.threshold, 20);
    assert.equal(strictAlerts[0]!.payload.trigger, 'competitor_price_change');

    // own drops below, then a competitor price cut pushes own above again → second alert, triggered by the competitor
    obs(f.ownListingId, 30, { current_price: 11 }); // 5.50 vs 6.00
    const res = obs(f.compListingId, 25, { current_price: 15 }); // 5.00 → own is +10 %
    alerts = alertsOf('own_more_expensive', { rule: standard, listing: f.ownListingId });
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1]!.payload.trigger, 'competitor_price_change');
    assert.equal(alerts[1]!.payload.gap_pct, 10);
    assert.equal(alerts[1]!.observation_id, res.observationIds[0]);
    assert.equal(alerts[1]!.listing_id, f.ownListingId, 'the alert is filed against the own listing');

    // +10 % does not reach the stricter rule again
    assert.equal(alertsOf('own_more_expensive', { rule: strict }).length, 1);
  });

  it('skips pairs whose pack dimensions differ (ml vs g)', () => {
    const f = createFixture(t.ctx, { retailerName: 'Dimension Mart' });
    t.ctx.db.run(`UPDATE products SET pack_unit = 'g' WHERE id = ?`, [f.compProductId]);
    obs(f.compListingId, 46, { current_price: 10 });
    obs(f.ownListingId, 45, { current_price: 5 });
    obs(f.ownListingId, 40, { current_price: 50 });
    assert.equal(alertsOf('own_more_expensive', { listing: f.ownListingId }).length, 0);
  });

  it('uses the shelf price for equivalent like-for-like packs', () => {
    const f = createFixture(t.ctx, { retailerName: 'Shelf Mart' });
    t.ctx.db.run('UPDATE products SET pack_size = 200 WHERE id = ?', [f.compProductId]);
    t.ctx.db.run(`UPDATE competitor_mappings SET equivalence = 'equivalent' WHERE own_product_id = ?`, [f.ownProductId]);
    obs(f.compListingId, 46, { current_price: 11 });
    obs(f.ownListingId, 45, { current_price: 10 });
    obs(f.ownListingId, 40, { current_price: 12 });
    const alerts = alertsOf('own_more_expensive', { listing: f.ownListingId });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.payload.basis, 'shelf');
    assert.equal(alerts[0]!.payload.gap_pct, 9.09);
    assert.match(alerts[0]!.message, /pack price, like-for-like packs/);
  });

  it('only uses approved mappings that apply in the market', () => {
    const scoped = createFixture(t.ctx, { retailerName: 'Mapping Market Mart' });
    t.ctx.db.run('UPDATE competitor_mappings SET market_id = ? WHERE own_product_id = ?', [marketId('SA'), scoped.ownProductId]);
    obs(scoped.compListingId, 46, { current_price: 21 });
    obs(scoped.ownListingId, 45, { current_price: 12 });
    obs(scoped.ownListingId, 40, { current_price: 20 });
    assert.equal(alertsOf('own_more_expensive', { listing: scoped.ownListingId }).length, 0);

    const pending = createFixture(t.ctx, { retailerName: 'Mapping Pending Mart' });
    t.ctx.db.run(`UPDATE competitor_mappings SET status = 'suggested' WHERE own_product_id = ?`, [pending.ownProductId]);
    obs(pending.compListingId, 46, { current_price: 21 });
    obs(pending.ownListingId, 45, { current_price: 12 });
    obs(pending.ownListingId, 40, { current_price: 20 });
    assert.equal(alertsOf('own_more_expensive', { listing: pending.ownListingId }).length, 0);
  });

  it('compares against the competitor price that was valid at the time of the change', () => {
    const f = createFixture(t.ctx, { retailerName: 'As-Of Mart' });
    // competitor history arrives first, including a later increase to 30
    const comp = ingestObservations(
      t.ctx,
      [
        { listing_id: f.compListingId, observed_at: ago(0, 46), current_price: 21 },
        { listing_id: f.compListingId, observed_at: ago(0, 20), current_price: 30 },
      ],
      { sourceMethod: 'csv_import' },
    );
    assert.equal(comp.inserted, 2);
    // own history arrives afterwards: at the time of its change (40 h ago) the competitor still cost 21
    ingestObservations(
      t.ctx,
      [
        { listing_id: f.ownListingId, observed_at: ago(0, 45), current_price: 12 },
        { listing_id: f.ownListingId, observed_at: ago(0, 40), current_price: 15 },
      ],
      { sourceMethod: 'csv_import' },
    );
    const alerts = alertsOf('own_more_expensive', { listing: f.ownListingId });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.payload.competitor.price, 21, 'not the later price of 30');
    assert.equal(alerts[0]!.payload.gap_pct, 7.14);
    const compFirst = t.ctx.db.get<{ observed_at: string }>('SELECT observed_at FROM price_observations WHERE id = ?', [comp.observationIds[0]])!;
    assert.equal(alerts[0]!.payload.competitor.observed_at, compFirst.observed_at);
  });

  it('applies the cool-down per own listing and competitor listing', async () => {
    const f = createFixture(t.ctx, { retailerName: 'Gap Cooldown Mart' });
    const rule = await createRule({ name: 'Premium with cool-down', type: 'own_more_expensive', threshold_pct: 0, cooldown_hours: 24, retailer_id: f.retailerId });
    obs(f.compListingId, 46, { current_price: 21 }); // 7.00 per 100 ml
    obs(f.ownListingId, 45, { current_price: 12 }); //  6.00
    obs(f.ownListingId, 40, { current_price: 15 }); //  7.50 → crossing #1
    obs(f.ownListingId, 35, { current_price: 12 }); //  back below
    obs(f.ownListingId, 30, { current_price: 16 }); //  8.00 → crossing #2, 10 h after the first
    assert.equal(alertsOf('own_more_expensive', { rule }).length, 1, 'suppressed by the cool-down');
    assert.equal(alertsOf('own_more_expensive', { rule: ruleId('own_more_expensive'), listing: f.ownListingId }).length, 2, 'the rule without cool-down reports both');
    obs(f.ownListingId, 20, { current_price: 12 });
    obs(f.ownListingId, 10, { current_price: 16 }); //  crossing #3, 30 h after the first → allowed
    assert.equal(alertsOf('own_more_expensive', { rule }).length, 2);
    assert.equal((await t.api('DELETE', `/alert-rules/${rule}`)).status, 200);
  });

  it('chooses the comparison basis as documented', () => {
    const ml = (amount: number) => ({ content_amount: amount, content_dimension: 'volume' as const, unit_factor: 100 });
    const g = (amount: number) => ({ content_amount: amount, content_dimension: 'mass' as const, unit_factor: 100 });
    const unknown = { content_amount: null, content_dimension: null, unit_factor: null };
    assert.equal(comparisonBasis(ml(200), ml(200), 'equivalent')!.basis, 'shelf');
    assert.equal(comparisonBasis(ml(200), ml(180), 'equivalent')!.basis, 'unit');
    assert.equal(comparisonBasis(ml(200), ml(200), 'comparable')!.basis, 'unit');
    assert.equal(comparisonBasis(ml(200), g(200), 'equivalent'), null);
    assert.equal(comparisonBasis(ml(200), unknown, 'equivalent')!.basis, 'shelf');
    assert.equal(comparisonBasis(ml(200), unknown, 'comparable'), null);
    const unit = comparisonBasis(ml(200), ml(300), 'comparable')!;
    assert.equal(unit.own(12), 6);
    assert.equal(unit.competitor(21), 7);
  });
});

describe('state rules', () => {
  it('derives the freshness window from the source', () => {
    const rule = { threshold_hours: null };
    assert.equal(freshnessWindowHours(rule, { is_enabled: 1, collection_method: 'product_feed', frequency: 'daily' }), 48);
    assert.equal(freshnessWindowHours(rule, { is_enabled: 1, collection_method: 'official_api', frequency: '6h' }), 12);
    assert.equal(freshnessWindowHours(rule, { is_enabled: 1, collection_method: 'manual', frequency: 'daily' }), MANUAL_STALE_HOURS);
    assert.equal(freshnessWindowHours(rule, { is_enabled: 1, collection_method: 'product_feed', frequency: 'manual' }), MANUAL_STALE_HOURS);
    assert.equal(freshnessWindowHours(rule, { is_enabled: 0, collection_method: 'product_feed', frequency: 'daily' }), MANUAL_STALE_HOURS);
    assert.equal(freshnessWindowHours({ threshold_hours: 5 }, { is_enabled: 0, collection_method: 'manual', frequency: null }), 5);
  });

  it('opens one stale alert per retailer, updates it in place and resolves it when prices are fresh again', () => {
    const f = createFixture(t.ctx, { retailerName: 'Stale Feed', method: 'product_feed' }); // daily → 48 h window
    ingestObservations(t.ctx, [{ listing_id: f.ownListingId, observed_at: ago(5), current_price: 12 }], { sourceMethod: 'product_feed' });
    obs(f.compListingId, 1, { current_price: 20 });

    const first = runStateChecks(t.ctx);
    assert.ok(first.stale_observation.opened >= 1);
    let alerts = alertsOf('stale_observation', { retailer: f.retailerId });
    assert.equal(alerts.length, 1);
    const alert = alerts[0]!;
    assert.equal(alert.status, 'open');
    assert.equal(alert.listing_id, null);
    assert.equal(alert.payload.stale_count, 1);
    assert.equal(alert.payload.total_listings, 2);
    assert.equal(alert.payload.window_hours, 48);
    assert.equal(alert.payload.never_observed, 0);
    assert.equal(alert.payload.sample[0].listing_id, f.ownListingId);
    assert.match(alert.title, /No fresh prices: 1 of 2 listings at Stale Feed \(UAE\)/);

    // condition persists and worsens → same alert, updated
    const later = runStateChecks(t.ctx, new Date(Date.now() + 3 * 86_400_000));
    assert.ok(later.stale_observation.updated >= 1);
    alerts = alertsOf('stale_observation', { retailer: f.retailerId });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.id, alert.id);
    assert.equal(alerts[0]!.payload.stale_count, 2);
    assert.match(alerts[0]!.title, /2 of 2 listings/);

    // fresh observations arrive → resolved automatically, straight from ingestion
    obs(f.ownListingId, 0.5, { current_price: 12 });
    obs(f.compListingId, 0.4, { current_price: 20 });
    alerts = alertsOf('stale_observation', { retailer: f.retailerId });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.status, 'resolved');
    assert.match(alerts[0]!.resolution_note!, /Resolved automatically/);
    assert.ok(alerts[0]!.resolved_at);

    // nothing new while everything is fresh
    runStateChecks(t.ctx);
    assert.equal(alertsOf('stale_observation', { retailer: f.retailerId }).length, 1);
  });

  it('counts never-observed listings once they are older than the window and judges paused sources by the manual window', () => {
    const never = createFixture(t.ctx, { retailerName: 'Never Feed', method: 'product_feed' });
    runStateChecks(t.ctx);
    assert.equal(alertsOf('stale_observation', { retailer: never.retailerId }).length, 0, 'brand-new listings are not stale yet');
    runStateChecks(t.ctx, new Date(Date.now() + 3 * 86_400_000));
    const alerts = alertsOf('stale_observation', { retailer: never.retailerId });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.payload.never_observed, 2);
    assert.match(alerts[0]!.message, /2 listings have never been observed/);

    const paused = createFixture(t.ctx, { retailerName: 'Paused Feed', method: 'product_feed' });
    t.ctx.db.run('UPDATE retailers SET is_enabled = 0 WHERE id = ?', [paused.retailerId]);
    ingestObservations(
      t.ctx,
      [
        { listing_id: paused.ownListingId, observed_at: ago(3), current_price: 12 },
        { listing_id: paused.compListingId, observed_at: ago(3), current_price: 20 },
      ],
      { sourceMethod: 'product_feed' },
    );
    runStateChecks(t.ctx);
    assert.equal(alertsOf('stale_observation', { retailer: paused.retailerId }).length, 0, '3 days is inside the 7-day manual window');
    t.ctx.db.run('UPDATE retailers SET is_enabled = 1 WHERE id = ?', [paused.retailerId]);
    runStateChecks(t.ctx);
    assert.equal(alertsOf('stale_observation', { retailer: paused.retailerId }).length, 1, 'an enabled daily source is stale after 48 h');
  });

  it('supports an explicit maximum age and a retailer scope', async () => {
    const f = createFixture(t.ctx, { retailerName: 'Hourly Mart' });
    const rule = await createRule({ name: 'Hourly Mart must be fresh within 1 h', type: 'stale_observation', threshold_hours: 1, retailer_id: f.retailerId, severity: 'critical' });
    obs(f.ownListingId, 2, { current_price: 12 });
    obs(f.compListingId, 0.2, { current_price: 20 });
    runStateChecks(t.ctx);
    const alerts = alertsOf('stale_observation', { rule });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.retailer_id, f.retailerId);
    assert.equal(alerts[0]!.severity, 'critical');
    assert.equal(alerts[0]!.payload.window_hours, 1);
    assert.equal(alerts[0]!.payload.stale_count, 1);
    assert.equal((await t.api('DELETE', `/alert-rules/${rule}`)).status, 200);
  });

  it('closes the open state alerts of a rule that is switched off or deleted', async () => {
    const f = createFixture(t.ctx, { retailerName: 'Switch Mart' });
    const rule = await createRule({ name: 'Switch Mart freshness', type: 'stale_observation', threshold_hours: 1, retailer_id: f.retailerId });
    obs(f.ownListingId, 3, { current_price: 12 });
    obs(f.compListingId, 3, { current_price: 20 });
    runStateChecks(t.ctx);
    assert.equal(alertsOf('stale_observation', { rule })[0]!.status, 'open');

    await t.api('POST', `/alert-rules/${rule}/toggle`, { body: { enabled: false } });
    let alerts = alertsOf('stale_observation', { rule });
    assert.equal(alerts[0]!.status, 'resolved');
    assert.match(alerts[0]!.resolution_note!, /rule was switched off/);
    runStateChecks(t.ctx);
    assert.equal(alertsOf('stale_observation', { rule }).length, 1, 'a disabled rule raises nothing');

    await t.api('PATCH', `/alert-rules/${rule}`, { body: { is_enabled: true } });
    runStateChecks(t.ctx);
    alerts = alertsOf('stale_observation', { rule });
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1]!.status, 'open');
    const openId = alerts[1]!.id;

    assert.equal((await t.api('DELETE', `/alert-rules/${rule}`)).status, 200);
    const closed = t.ctx.db.get<{ status: string; rule_id: number | null; resolution_note: string }>('SELECT status, rule_id, resolution_note FROM alerts WHERE id = ?', [openId])!;
    assert.equal(closed.status, 'resolved');
    assert.equal(closed.rule_id, null);
    assert.match(closed.resolution_note, /rule was deleted/);
  });

  it('opens, updates and auto-resolves "collection failing repeatedly" alerts', () => {
    const f = createFixture(t.ctx, { retailerName: 'Failing Feed', method: 'product_feed' });
    const now = new Date().toISOString();
    const job = (status: string, message: string | null) =>
      t.ctx.db.run(
        `INSERT INTO collection_jobs (retailer_id, method, trigger_type, data_class, status, error_code, error_message, created_at)
         VALUES (?, 'product_feed', 'schedule', 'real', ?, ?, ?, ?)`,
        [f.retailerId, status, message ? 'http_error' : null, message, now],
      ).lastInsertRowid;

    t.ctx.db.run('UPDATE retailers SET consecutive_failures = 2, last_attempt_at = ? WHERE id = ?', [now, f.retailerId]);
    job('failed', 'HTTP 503 from feed');
    runStateChecks(t.ctx);
    assert.equal(alertsOf('collection_failed', { retailer: f.retailerId }).length, 0, 'two failures are below the threshold of three');

    t.ctx.db.run('UPDATE retailers SET consecutive_failures = 3 WHERE id = ?', [f.retailerId]);
    const failedJob = job('failed', 'HTTP 503 from feed (attempt 3)');
    fireHook(t.ctx, t.ctx.hooks.collectionJobFinished, failedJob);
    let alerts = alertsOf('collection_failed', { retailer: f.retailerId });
    assert.equal(alerts.length, 1);
    const alert = alerts[0]!;
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.status, 'open');
    assert.equal(alert.job_id, failedJob);
    assert.equal(alert.payload.consecutive_failures, 3);
    assert.equal(alert.payload.threshold, 3);
    assert.equal(alert.payload.last_error_message, 'HTTP 503 from feed (attempt 3)');
    assert.match(alert.title, /Collection failing: Failing Feed \(UAE\) — 3 consecutive failed runs/);
    assert.match(alert.message, /never completed a successful collection/);

    t.ctx.db.run('UPDATE retailers SET consecutive_failures = 5 WHERE id = ?', [f.retailerId]);
    const again = runStateChecks(t.ctx);
    assert.ok(again.collection_failed.updated >= 1);
    alerts = alertsOf('collection_failed', { retailer: f.retailerId });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.id, alert.id);
    assert.equal(alerts[0]!.payload.consecutive_failures, 5);

    // next run succeeds → resolved from the job-finished hook
    t.ctx.db.run('UPDATE retailers SET consecutive_failures = 0, last_success_at = ? WHERE id = ?', [now, f.retailerId]);
    fireHook(t.ctx, t.ctx.hooks.collectionJobFinished, job('succeeded', null));
    alerts = alertsOf('collection_failed', { retailer: f.retailerId });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.status, 'resolved');
    assert.match(alerts[0]!.resolution_note!, /Resolved automatically/);
  });

  it('runs the state checks from the scheduler tick at most every ten minutes', () => {
    const a = createFixture(t.ctx, { retailerName: 'Tick Feed A', method: 'product_feed' });
    const b = createFixture(t.ctx, { retailerName: 'Tick Feed B', method: 'product_feed' });
    const failing = (retailerId: number) => t.ctx.db.run('UPDATE retailers SET consecutive_failures = 4 WHERE id = ?', [retailerId]);
    const base = Date.now() + 60 * 60_000;
    failing(a.retailerId);
    fireHook(t.ctx, t.ctx.hooks.schedulerTick, new Date(base));
    assert.equal(alertsOf('collection_failed', { retailer: a.retailerId }).length, 1);
    failing(b.retailerId);
    fireHook(t.ctx, t.ctx.hooks.schedulerTick, new Date(base + 60_000));
    assert.equal(alertsOf('collection_failed', { retailer: b.retailerId }).length, 0, 'throttled');
    fireHook(t.ctx, t.ctx.hooks.schedulerTick, new Date(base + 11 * 60_000));
    assert.equal(alertsOf('collection_failed', { retailer: b.retailerId }).length, 1);
    t.ctx.db.run('UPDATE retailers SET consecutive_failures = 0 WHERE id IN (?, ?)', [a.retailerId, b.retailerId]);
    runStateChecks(t.ctx);
  });

  it('flags alerts raised from demo sources as DEMO', () => {
    const f = createFixture(t.ctx, { retailerName: 'Demo Source', method: 'simulated' });
    t.ctx.db.run('UPDATE retailers SET is_demo = 1, consecutive_failures = 3 WHERE id = ?', [f.retailerId]);
    t.ctx.db.run('UPDATE retailer_listings SET is_demo = 1 WHERE retailer_id = ?', [f.retailerId]);
    runStateChecks(t.ctx);
    assert.equal(alertsOf('collection_failed', { retailer: f.retailerId })[0]!.is_demo, 1);
    ingestObservations(t.ctx, [{ listing_id: f.compListingId, observed_at: ago(0, 30), current_price: 30 }], { sourceMethod: 'simulated' });
    ingestObservations(t.ctx, [{ listing_id: f.compListingId, observed_at: ago(0, 20), current_price: 20 }], { sourceMethod: 'simulated' });
    const drop = alertsOf('competitor_price_drop', { listing: f.compListingId });
    assert.equal(drop.length, 1);
    assert.equal(drop[0]!.is_demo, 1);
    t.ctx.db.run('UPDATE retailers SET consecutive_failures = 0 WHERE id = ?', [f.retailerId]);
    runStateChecks(t.ctx);
  });
});

describe('alerts API', () => {
  it('lists alerts with names, parsed payloads, filters and pagination', async () => {
    const all = await t.api('GET', '/alerts?page_size=5', { as: 'viewer' });
    assert.equal(all.status, 200);
    assert.ok(all.body.total > 10);
    assert.equal(all.body.rows.length, 5);
    assert.equal(all.body.page_size, 5);
    const row = all.body.rows[0];
    assert.equal(typeof row.payload, 'object');
    assert.equal(typeof row.is_demo, 'boolean');
    assert.ok('rule_name' in row && 'retailer_name' in row && 'market_name' in row && 'timezone' in row);
    // newest first
    assert.ok(all.body.rows.every((r: any, i: number, rows: any[]) => i === 0 || rows[i - 1].triggered_at >= r.triggered_at));

    const drops = await t.api('GET', '/alerts?type=competitor_price_drop&page_size=200');
    assert.ok(drops.body.rows.length >= 3);
    assert.ok(drops.body.rows.every((r: any) => r.type === 'competitor_price_drop' && r.ownership === 'competitor' && r.product_name && r.brand_name === 'Test Rival'));

    const critical = await t.api('GET', '/alerts?severity=critical&page_size=200');
    assert.ok(critical.body.rows.length >= 1);
    assert.ok(critical.body.rows.every((r: any) => r.severity === 'critical'));

    const demo = await t.api('GET', '/alerts?is_demo=true&page_size=200');
    assert.ok(demo.body.rows.length >= 2);
    assert.ok(demo.body.rows.every((r: any) => r.is_demo === true));

    const search = await t.api('GET', `/alerts?q=${encodeURIComponent('Gap Mart')}&type=own_more_expensive`);
    assert.equal(search.body.total, 3); // two from the standard rule, one from the stricter 20 % rule
    const byProduct = await t.api('GET', `/alerts?product_id=${search.body.rows[0].product_id}&type=own_more_expensive`);
    assert.equal(byProduct.body.total, 3);
    const byRule = await t.api('GET', `/alerts?rule_id=${ruleId('own_more_expensive')}&q=${encodeURIComponent('Gap Mart')}`);
    assert.equal(byRule.body.total, 2);
    const resolved = await t.api('GET', '/alerts?status=resolved&page_size=200');
    assert.ok(resolved.body.rows.length >= 2);
    assert.ok(resolved.body.rows.every((r: any) => r.status === 'resolved'));
    const future = await t.api('GET', '/alerts?from=2099-01-01');
    assert.equal(future.body.total, 0);
    assert.equal((await t.api('GET', '/alerts?from=nonsense')).status, 400);
    assert.equal((await t.api('GET', '/alerts', { as: null })).status, 401);
  });

  it('acknowledges, resolves and reopens alerts with an audit trail', async () => {
    const open = (await t.api('GET', '/alerts?status=open&type=product_unavailable')).body.rows[0];
    assert.equal((await t.api('POST', `/alerts/${open.id}/acknowledge`, { as: 'viewer', body: {} })).status, 403);

    const ack = await t.api('POST', `/alerts/${open.id}/acknowledge`, { as: 'analyst', body: {} });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.status, 'acknowledged');
    assert.equal(ack.body.acknowledged_by_name, 'Test analyst');
    assert.ok(ack.body.acknowledged_at);

    const resolve = await t.api('POST', `/alerts/${open.id}/resolve`, { body: { note: 'Checked with the retailer' } });
    assert.equal(resolve.body.status, 'resolved');
    assert.equal(resolve.body.resolution_note, 'Checked with the retailer');
    assert.equal(resolve.body.resolved_by_name, 'Test admin');

    const ackResolved = await t.api('POST', `/alerts/${open.id}/acknowledge`, { body: {} });
    assert.equal(ackResolved.status, 409);

    const reopen = await t.api('POST', `/alerts/${open.id}/reopen`, { body: {} });
    assert.equal(reopen.body.status, 'open');
    assert.equal(reopen.body.resolved_at, null);
    assert.equal(reopen.body.acknowledged_at, null);

    const detail = await t.api('GET', `/alerts/${open.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(
      detail.body.notifications.map((n: any) => [n.channel, n.status]),
      [['in_app', 'delivered']],
    );
    assert.equal((await t.api('GET', '/alerts/9999999')).status, 404);
    const actions = t.ctx.db
      .all<{ action: string }>(`SELECT action FROM audit_log WHERE entity_type = 'alert' AND entity_id = ? ORDER BY id`, [String(open.id)])
      .map((r) => r.action);
    assert.deepEqual(actions, ['alert.acknowledge', 'alert.resolve', 'alert.reopen']);
  });

  it('applies bulk actions and reports what changed', async () => {
    const rows = (await t.api('GET', '/alerts?status=open&type=competitor_price_drop&page_size=3')).body.rows;
    const ids = rows.map((r: any) => r.id);
    assert.equal((await t.api('POST', '/alerts/bulk', { as: 'viewer', body: { ids, action: 'acknowledge' } })).status, 403);
    const ack = await t.api('POST', '/alerts/bulk', { as: 'analyst', body: { ids: [...ids, 9_999_999], action: 'acknowledge' } });
    assert.deepEqual(ack.body, { updated: ids.length, skipped: 1 });
    const again = await t.api('POST', '/alerts/bulk', { body: { ids, action: 'acknowledge' } });
    assert.deepEqual(again.body, { updated: 0, skipped: ids.length });
    const resolve = await t.api('POST', '/alerts/bulk', { body: { ids, action: 'resolve', note: 'Reviewed in weekly pricing meeting' } });
    assert.equal(resolve.body.updated, ids.length);
    const check = await t.api('GET', `/alerts/${ids[0]}`);
    assert.equal(check.body.status, 'resolved');
    assert.equal(check.body.resolution_note, 'Reviewed in weekly pricing meeting');
    assert.equal((await t.api('POST', '/alerts/bulk', { body: { ids: [], action: 'resolve' } })).status, 422);
    assert.equal((await t.api('POST', '/alerts/bulk', { body: { ids, action: 'delete' } })).status, 422);
  });

  it('summarises alerts and counts unread ones according to personal preferences', async () => {
    const summary = await t.api('GET', '/alerts/summary?days=7', { as: 'viewer' });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.days, 7);
    assert.equal(summary.body.trend.length, 7);
    assert.equal(summary.body.by_type.length, ALERT_TYPES.length);
    const total = t.ctx.db.scalar<number>('SELECT COUNT(*) FROM alerts')!;
    assert.equal(summary.body.open + summary.body.acknowledged + summary.body.resolved, total);
    assert.equal(
      summary.body.trend.reduce((s: number, d: any) => s + d.total, 0),
      summary.body.triggered_in_period,
    );
    assert.ok(summary.body.by_type.find((x: any) => x.type === 'competitor_price_drop').total >= 3);
    assert.equal(summary.body.demo_active, t.ctx.db.scalar<number>(`SELECT COUNT(*) FROM alerts WHERE status IN ('open', 'acknowledged') AND is_demo = 1`));
    const active = summary.body.active_by_severity;
    assert.equal(active.info + active.warning + active.critical, summary.body.open + summary.body.acknowledged);

    const prefs = await t.api('GET', '/me/notification-prefs', { as: 'viewer' });
    assert.deepEqual(prefs.body, { in_app: true, email: false, min_severity: 'info' });
    const openTotal = t.ctx.db.scalar<number>(`SELECT COUNT(*) FROM alerts WHERE status = 'open'`)!;
    const openCritical = t.ctx.db.scalar<number>(`SELECT COUNT(*) FROM alerts WHERE status = 'open' AND severity = 'critical'`)!;
    let unread = await t.api('GET', '/alerts/unread-count', { as: 'viewer' });
    assert.deepEqual(unread.body, { open: openTotal, critical: openCritical, total_open: openTotal });

    const put = await t.api('PUT', '/me/notification-prefs', { as: 'viewer', body: { min_severity: 'critical' } });
    assert.deepEqual(put.body, { in_app: true, email: false, min_severity: 'critical' });
    unread = await t.api('GET', '/alerts/unread-count', { as: 'viewer' });
    assert.deepEqual(unread.body, { open: openCritical, critical: openCritical, total_open: openTotal });

    await t.api('PUT', '/me/notification-prefs', { as: 'viewer', body: { in_app: false } });
    unread = await t.api('GET', '/alerts/unread-count', { as: 'viewer' });
    assert.deepEqual(unread.body, { open: 0, critical: 0, total_open: openTotal });

    assert.equal((await t.api('PUT', '/me/notification-prefs', { as: 'viewer', body: { min_severity: 'loud' } })).status, 422);
    assert.equal((await t.api('PUT', '/me/notification-prefs', { as: 'viewer', body: { sms: true } })).status, 422);
    await t.api('PUT', '/me/notification-prefs', { as: 'viewer', body: { in_app: true, min_severity: 'info' } });
  });

  it('runs the state checks on demand', async () => {
    assert.equal((await t.api('POST', '/alerts/evaluate', { as: 'viewer', body: {} })).status, 403);
    const res = await t.api('POST', '/alerts/evaluate', { as: 'analyst', body: {} });
    assert.equal(res.status, 200);
    assert.ok(res.body.checked_at);
    assert.equal(typeof res.body.stale_observation.opened, 'number');
    assert.equal(typeof res.body.collection_failed.resolved, 'number');
    assert.ok(Array.isArray(res.body.opened_alert_ids));
  });
});

describe('alert rule management', () => {
  it('lists rules with scope names and alert counts', async () => {
    const res = await t.api('GET', '/alert-rules', { as: 'viewer' });
    assert.equal(res.status, 200);
    assert.ok(res.body.rows.length >= 8);
    const drop = res.body.rows.find((r: any) => r.type === 'competitor_price_drop');
    assert.equal(drop.is_enabled, true);
    assert.deepEqual(drop.channels, ['in_app']);
    assert.ok(drop.alert_count >= 3);
    assert.ok(drop.last_triggered_at);
    assert.ok(res.body.types.competitor_price_drop.label);
  });

  it('validates thresholds, scopes and channels per rule type', async () => {
    const f = createFixture(t.ctx, { retailerName: 'Rule Mart' });
    assert.equal((await t.api('POST', '/alert-rules', { as: 'viewer', body: { name: 'x', type: 'price_change' } })).status, 403);

    const ok = await t.api('POST', '/alert-rules', {
      as: 'analyst',
      body: { name: '  Big drops at Rule Mart ', type: 'competitor_price_drop', threshold_pct: '12.5', retailer_id: f.retailerId, channels: ['webhook'], severity: 'critical' },
    });
    assert.equal(ok.status, 201, ok.raw);
    assert.equal(ok.body.name, 'Big drops at Rule Mart');
    assert.equal(ok.body.threshold_pct, 12.5);
    assert.equal(ok.body.threshold_count, null);
    assert.equal(ok.body.retailer_name, 'Rule Mart');
    assert.deepEqual(ok.body.channels, ['in_app', 'webhook'], 'in-app is always included');
    assert.equal(ok.body.severity, 'critical');
    assert.equal(ok.body.is_demo, false);

    const defaults = await t.api('POST', '/alert-rules', { body: { name: 'Defaults', type: 'collection_failed' } });
    assert.equal(defaults.body.threshold_count, 3);
    assert.equal(defaults.body.threshold_pct, null);
    assert.equal(defaults.body.severity, 'warning');

    const bad = async (body: Record<string, unknown>, pattern: RegExp) => {
      const res = await t.api('POST', '/alert-rules', { body });
      assert.equal(res.status, 422, res.raw);
      assert.match(res.body.error.message, pattern);
    };
    await bad({ name: '', type: 'price_change' }, /name/);
    await bad({ name: 'x', type: 'made_up' }, /type/);
    await bad({ name: 'x', type: 'competitor_price_drop', threshold_count: 3 }, /threshold_count does not apply/);
    await bad({ name: 'x', type: 'product_unavailable', threshold_pct: 5 }, /threshold_pct does not apply/);
    await bad({ name: 'x', type: 'competitor_promotion', threshold_pct: 150 }, /between 0 and 100/);
    await bad({ name: 'x', type: 'price_increase', threshold_pct: -1 }, /between 0 and 1000/);
    await bad({ name: 'x', type: 'collection_failed', threshold_count: 2.5 }, /whole number/);
    await bad({ name: 'x', type: 'stale_observation', threshold_hours: 0 }, /greater than 0/);
    await bad({ name: 'x', type: 'price_change', market_id: 987654 }, /market that does not exist/);
    await bad({ name: 'x', type: 'price_change', retailer_id: f.retailerId, market_id: marketId('SA') }, /does not belong to the selected market/);
    await bad({ name: 'x', type: 'collection_failed', brand_id: f.ownBrandId }, /only be scoped by market or retailer/);
    await bad({ name: 'x', type: 'price_change', channels: ['sms'] }, /channels/);
    await bad({ name: 'x', type: 'price_change', cooldown_hours: 10_000 }, /cooldown_hours/);
    await bad({ name: 'x', type: 'price_change', colour: 'red' }, /Invalid alert rule/);

    const stale = await t.api('POST', '/alert-rules', { body: { name: 'Stale (derived window)', type: 'stale_observation', is_enabled: false } });
    assert.equal(stale.body.threshold_hours, null);
    assert.equal(stale.body.is_enabled, false);
    for (const id of [defaults.body.id, stale.body.id]) await t.api('DELETE', `/alert-rules/${id}`);
  });

  it('updates, toggles and deletes rules while keeping the alerts they raised', async () => {
    const f = createFixture(t.ctx, { retailerName: 'Lifecycle Mart' });
    const id = await createRule({ name: 'Lifecycle', type: 'product_unavailable', retailer_id: f.retailerId });
    obs(f.ownListingId, 30, { current_price: 10 });
    obs(f.ownListingId, 20, { current_price: 10, availability: 'out_of_stock' });
    const raised = alertsOf('product_unavailable', { rule: id });
    assert.equal(raised.length, 1);

    const patched = await t.api('PATCH', `/alert-rules/${id}`, { body: { name: 'Lifecycle (renamed)', severity: 'critical', cooldown_hours: 6, retailer_id: null, brand_id: f.ownBrandId } });
    assert.equal(patched.status, 200, patched.raw);
    assert.equal(patched.body.name, 'Lifecycle (renamed)');
    assert.equal(patched.body.severity, 'critical');
    assert.equal(patched.body.cooldown_hours, 6);
    assert.equal(patched.body.retailer_id, null);
    assert.equal(patched.body.brand_name, 'Test Own');
    assert.equal(patched.body.alert_count, 1);
    assert.equal((await t.api('PATCH', `/alert-rules/${id}`, { body: { type: 'price_change' } })).status, 422);
    assert.equal((await t.api('PATCH', `/alert-rules/${id}`, { body: { threshold_pct: 5 } })).status, 422);
    assert.equal((await t.api('PATCH', `/alert-rules/${id}`, { as: 'viewer', body: { name: 'nope' } })).status, 403);
    assert.equal((await t.api('PATCH', '/alert-rules/9999999', { body: { name: 'nope' } })).status, 404);

    const off = await t.api('POST', `/alert-rules/${id}/toggle`, { body: {} });
    assert.equal(off.body.is_enabled, false);
    obs(f.ownListingId, 15, { current_price: 10, availability: 'in_stock' });
    obs(f.ownListingId, 10, { current_price: 10, availability: 'out_of_stock' });
    assert.equal(alertsOf('product_unavailable', { rule: id }).length, 1, 'a disabled rule does not fire');

    const del = await t.api('DELETE', `/alert-rules/${id}`, { as: 'analyst' });
    assert.equal(del.status, 200);
    const orphan = t.ctx.db.get<{ rule_id: number | null; status: string }>('SELECT rule_id, status FROM alerts WHERE id = ?', [raised[0]!.id])!;
    assert.equal(orphan.rule_id, null, 'history is kept, the rule reference is cleared');
    assert.equal(orphan.status, 'open');
    const listed = await t.api('GET', `/alerts/${raised[0]!.id}`);
    assert.equal(listed.body.rule_name, null);
    assert.equal((await t.api('DELETE', `/alert-rules/${id}`)).status, 404);
  });
});

// ---------------------------------------------------------------------------------------------
// Notification delivery against real local endpoints
// ---------------------------------------------------------------------------------------------
interface Hook {
  url: string;
  requests: Array<{ headers: http.IncomingHttpHeaders; body: any }>;
  status: number;
  close: () => Promise<void>;
}

async function startWebhookServer(): Promise<Hook> {
  const hook: Hook = { url: '', requests: [], status: 200, close: async () => undefined };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hook.requests.push({ headers: req.headers, body: JSON.parse(raw || 'null') });
      res.writeHead(hook.status, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  hook.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/secret-token-123`;
  hook.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return hook;
}

interface Sink {
  port: number;
  messages: Array<{ from: string; to: string[]; data: string }>;
  close: () => Promise<void>;
}

/** Minimal SMTP server that accepts every message (no TLS, no auth). */
async function startSmtpSink(): Promise<Sink> {
  const messages: Sink['messages'] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let current = { from: '', to: [] as string[], data: '' };
    socket.write('220 localhost ESMTP test sink\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { from: '', to: [], data: '' };
          socket.write('250 OK queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-localhost\r\n250 SIZE 10485760\r\n');
        else if (cmd.startsWith('MAIL FROM')) {
          current.from = line;
          socket.write('250 OK\r\n');
        } else if (cmd.startsWith('RCPT TO')) {
          current.to.push(line);
          socket.write('250 OK\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('notification delivery', () => {
  let hook: Hook;
  let sink: Sink;
  let f: Fixture;
  let rule: number;
  const notificationsOf = (alertId: number) =>
    t.ctx.db.all<{ channel: string; status: string; recipient: string | null; error: string | null }>(
      'SELECT channel, status, recipient, error FROM alert_notifications WHERE alert_id = ? ORDER BY id',
      [alertId],
    );
  /**
   * Makes the given listings unavailable in ONE ingestion batch → one new alert per listing from `rule`.
   * Every call uses its own, later time slot.
   */
  let step = 0;
  const triggerAll = (listingIds: number[]): AlertRecord[] => {
    const base = 44 - step * 2;
    step++;
    const before = alertsOf('product_unavailable', { rule }).length;
    ingestObservations(
      t.ctx,
      listingIds.map((id) => ({ listing_id: id, observed_at: ago(0, base), current_price: 10, availability: 'in_stock' as const })),
      { sourceMethod: 'manual' },
    );
    ingestObservations(
      t.ctx,
      listingIds.map((id) => ({ listing_id: id, observed_at: ago(0, base - 1), current_price: 10, availability: 'out_of_stock' as const })),
      { sourceMethod: 'manual' },
    );
    const alerts = alertsOf('product_unavailable', { rule });
    assert.equal(alerts.length, before + listingIds.length, 'each listing raises exactly one new alert');
    return alerts.slice(-listingIds.length);
  };
  const trigger = (listingId: number): AlertRecord => triggerAll([listingId])[0]!;

  before(async () => {
    hook = await startWebhookServer();
    sink = await startSmtpSink();
    f = createFixture(t.ctx, { retailerName: 'Notify Mart' });
    rule = await createRule({ name: 'Notify', type: 'product_unavailable', retailer_id: f.retailerId, channels: ['in_app', 'webhook', 'email'] });
    // keep the default (unscoped) rule out of the way for these listings
    t.ctx.db.run('UPDATE alert_rules SET is_enabled = 0 WHERE id = ?', [ruleId('product_unavailable')]);
  });
  after(async () => {
    await flushNotifications(t.ctx);
    await hook.close();
    await sink.close();
  });

  it('records unconfigured channels as not configured — never as delivered', async () => {
    const alert = trigger(f.ownListingId);
    await flushNotifications(t.ctx);
    const rows = notificationsOf(alert.id);
    assert.deepEqual(
      rows.map((r) => [r.channel, r.status]),
      [
        ['in_app', 'delivered'],
        ['webhook', 'not_configured'],
        ['email', 'not_configured'],
      ],
    );
    assert.match(rows[1]!.error!, /No webhook URL/);
    assert.match(rows[2]!.error!, /E-mail is not configured: missing SMTP host and sender address/);
    assert.equal(hook.requests.length, 0);
    assert.equal(sink.messages.length, 0);
  });

  it('posts one webhook call per batch and records delivery', async () => {
    const put = await t.api('PUT', '/integrations/webhook', { body: { url: hook.url } });
    assert.equal(put.status, 200, put.raw);
    assert.equal(put.body.configured, true);
    assert.ok(!JSON.stringify(put.body).includes('secret-token-123'));

    // two alerts raised by a single ingestion batch → a single request
    const latest = triggerAll([f.ownListingId, f.compListingId]);
    await flushNotifications(t.ctx);
    assert.equal(hook.requests.length, 1);
    const { body, headers } = hook.requests[0]!;
    assert.match(String(headers['content-type']), /application\/json/);
    assert.match(String(headers['user-agent']), /PriceIntelligenceOS/);
    assert.equal(body.source, 'Price Intelligence OS');
    assert.equal(body.type, 'alerts');
    assert.equal(body.count, 2);
    assert.equal(body.contains_demo_data, false);
    assert.equal(body.alerts.length, 2);
    assert.match(body.text, /2 new alerts \(2 warning\)/);
    assert.ok(body.alerts.every((a: any) => a.type === 'product_unavailable' && a.retailer === 'Notify Mart' && a.market === 'UAE' && a.details.new_availability === 'out_of_stock'));
    for (const a of latest) {
      const webhook = notificationsOf(a.id).find((n) => n.channel === 'webhook')!;
      assert.equal(webhook.status, 'delivered');
      assert.match(webhook.recipient!, /^http:\/\/127\.0\.0\.1:\d+\/…$/);
      assert.ok(!webhook.recipient!.includes('secret-token-123'));
    }
  });

  it('records a failed webhook delivery with the real reason', async () => {
    hook.status = 500;
    const alert = trigger(f.ownListingId);
    await flushNotifications(t.ctx);
    const webhook = notificationsOf(alert.id).find((n) => n.channel === 'webhook')!;
    assert.equal(webhook.status, 'failed');
    assert.match(webhook.error!, /HTTP 500/);
    hook.status = 200;

    // endpoint unreachable
    await hook.close();
    const dead = trigger(f.compListingId);
    await flushNotifications(t.ctx);
    const unreachable = notificationsOf(dead.id).find((n) => n.channel === 'webhook')!;
    assert.equal(unreachable.status, 'failed');
    assert.match(unreachable.error!, /Could not reach 127\.0\.0\.1/);
    hook = await startWebhookServer();
    await t.api('PUT', '/integrations/webhook', { body: { url: hook.url } });
  });

  it('delivers e-mail digests through SMTP to subscribed users and extra recipients', async () => {
    setSetting(t.ctx, 'smtp', { host: '127.0.0.1', port: sink.port, secure: false, user: '', from: 'Price Alerts <alerts@test.local>' });

    // SMTP configured but nobody subscribed → still not configured, and it says why
    let alert = trigger(f.ownListingId);
    await flushNotifications(t.ctx);
    let mail = notificationsOf(alert.id).filter((n) => n.channel === 'email');
    assert.equal(mail.length, 1);
    assert.equal(mail[0]!.status, 'not_configured');
    assert.match(mail[0]!.error!, /No e-mail recipients/);
    assert.equal(sink.messages.length, 0);

    // analyst wants every alert by e-mail, viewer only critical ones, plus one extra recipient
    await t.api('PUT', '/me/notification-prefs', { as: 'analyst', body: { email: true } });
    await t.api('PUT', '/me/notification-prefs', { as: 'viewer', body: { email: true, min_severity: 'critical' } });
    setSetting(t.ctx, 'alert_email_recipients', ['pricing-team@test.local']);
    alert = trigger(f.compListingId);
    await flushNotifications(t.ctx);
    mail = notificationsOf(alert.id).filter((n) => n.channel === 'email');
    assert.deepEqual(
      mail.map((n) => [n.recipient, n.status]).sort(),
      [
        ['analyst@test.local', 'delivered'],
        ['pricing-team@test.local', 'delivered'],
      ],
      'the viewer only wants critical alerts; this one is a warning',
    );
    assert.equal(sink.messages.length, 2);
    const message = sink.messages.find((m) => m.to.some((x) => x.includes('analyst@test.local')))!;
    assert.match(message.from, /alerts@test\.local/);
    assert.match(message.data, /Subject: \[Price Intelligence OS\] 1 new alert \(1 warning\)/);
    assert.match(message.data, /Out of stock: Rival Oil 300ml/);

    // SMTP server gone → recorded as failed with the real error
    await sink.close();
    alert = trigger(f.ownListingId);
    await flushNotifications(t.ctx);
    mail = notificationsOf(alert.id).filter((n) => n.channel === 'email');
    assert.equal(mail.length, 2);
    assert.ok(mail.every((n) => n.status === 'failed' && n.error));
    sink = await startSmtpSink();
    await t.api('PUT', '/me/notification-prefs', { as: 'analyst', body: { email: false } });
    await t.api('PUT', '/me/notification-prefs', { as: 'viewer', body: { email: false, min_severity: 'info' } });
  });

  it('only notifies the channels a rule asks for', async () => {
    const quiet = await createRule({ name: 'In-app only', type: 'price_increase', threshold_pct: 1, retailer_id: f.retailerId });
    const requestsBefore = hook.requests.length;
    obs(f.ownListingId, 3, { current_price: 10, availability: 'in_stock' });
    obs(f.ownListingId, 2, { current_price: 12, availability: 'in_stock' });
    await flushNotifications(t.ctx);
    const alert = alertsOf('price_increase', { rule: quiet })[0]!;
    assert.deepEqual(
      notificationsOf(alert.id).map((n) => [n.channel, n.status]),
      [['in_app', 'delivered']],
    );
    assert.equal(hook.requests.length, requestsBefore);
  });
});
