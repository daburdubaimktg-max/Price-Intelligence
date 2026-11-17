/**
 * The overview lists the ten deepest current promotions, but the figures next to the list must describe
 * every current promotion — however many there are.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ingestObservations } from '../server/services/ingestion.ts';
import { nowIso } from '../server/lib/time.ts';
import { ago, createFixture, createTestApp, type TestApp } from './helpers.ts';

describe('overview: promotions running now', () => {
  let t: TestApp;
  const discounts: number[] = [];

  before(async () => {
    t = await createTestApp();
    const f = createFixture(t.ctx, { retailerName: 'Promo Mart' });
    const now = nowIso();
    const listing = (productId: number, slug: string) =>
      t.ctx.db.run(
        `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'matched', ?, ?)`,
        [f.retailerId, productId, slug, `https://promomart.example/p/${slug}`, slug, now, now],
      ).lastInsertRowid;
    // 7 own and 6 competitor listings on promotion (13 > the ten that are listed), plus one listing at full price
    const inputs = [];
    for (let i = 0; i < 13; i++) {
      const own = i % 2 === 0;
      const id = i === 0 ? f.ownListingId : i === 1 ? f.compListingId : listing(own ? f.ownProductId : f.compProductId, `${own ? 'own' : 'rival'}-extra-${i}`);
      const pct = 5 + i * 5; // 5 % … 65 %
      discounts.push(pct);
      inputs.push({ listing_id: id, observed_at: ago(0, 3), current_price: 100 - pct, regular_price: 100, availability: 'in_stock' as const });
    }
    inputs.push({ listing_id: listing(f.ownProductId, 'own-full-price'), observed_at: ago(0, 3), current_price: 100, regular_price: 100, availability: 'in_stock' as const });
    const result = ingestObservations(t.ctx, inputs, { sourceMethod: 'manual', suppressAlerts: true });
    assert.equal(result.inserted, 14);
  });
  after(async () => {
    await t.close();
  });

  it('counts and averages all current promotions, not just the listed ones', async () => {
    const res = await t.api('GET', '/overview?days=30');
    assert.equal(res.status, 200);
    const { kpis, promotions } = res.body;
    assert.equal(promotions.current.length, 10);
    // the list is the ten deepest, deepest first
    assert.deepEqual(promotions.current.map((p: { max_discount_pct: number }) => p.max_discount_pct), [65, 60, 55, 50, 45, 40, 35, 30, 25, 20]);
    assert.equal(kpis.active_promotions, 13);
    assert.equal(promotions.own_current, 7);
    assert.equal(promotions.competitor_current, 6);
    assert.equal(promotions.own_current + promotions.competitor_current, kpis.active_promotions);
    assert.equal(kpis.active_promotion_products, 2);
    assert.equal(promotions.avg_current_discount_pct, Math.round((discounts.reduce((a, b) => a + b, 0) / discounts.length) * 10) / 10);
  });
});
