import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ago, createFixture, createTestApp, type Fixture, type TestApp } from './helpers.ts';
import { ingestObservations } from '../server/services/ingestion.ts';
import { comparability, refreshListingSuggestions, tokenise } from '../server/services/matching.ts';

let t: TestApp;
let fx: Fixture;

before(async () => {
  t = await createTestApp();
  fx = createFixture(t.ctx);
});
after(async () => {
  await t.close();
});

const scalar = (sql: string, params: unknown[] = []) => t.ctx.db.scalar<number>(sql, params as never) ?? 0;
const auditCount = (action: string, entityId?: number) =>
  entityId === undefined
    ? scalar('SELECT COUNT(*) FROM audit_log WHERE action = ?', [action])
    : scalar('SELECT COUNT(*) FROM audit_log WHERE action = ? AND entity_id = ?', [action, String(entityId)]);
const marketId = (code: string) => t.ctx.db.get<{ id: number }>('SELECT id FROM markets WHERE code = ?', [code])!.id;

/** Creates a brand / category / product through the API and returns the id. */
async function brand(name: string, ownership: 'own' | 'competitor'): Promise<number> {
  const res = await t.api('POST', '/brands', { body: { name, ownership } });
  assert.equal(res.status, 201, res.raw);
  return res.body.id;
}
async function category(name: string, parentId?: number): Promise<number> {
  const res = await t.api('POST', '/categories', { body: { name, parent_id: parentId } });
  assert.equal(res.status, 201, res.raw);
  return res.body.id;
}
async function product(body: Record<string, unknown>): Promise<number> {
  const res = await t.api('POST', '/products', { body });
  assert.equal(res.status, 201, res.raw);
  return res.body.product.id;
}
async function retailer(body: Record<string, unknown>): Promise<number> {
  const res = await t.api('POST', '/retailers', { body });
  assert.equal(res.status, 201, res.raw);
  return res.body.id;
}

describe('reference data', () => {
  it('returns the lists used by filter controls', async () => {
    const res = await t.api('GET', '/reference', { as: 'viewer' });
    assert.equal(res.status, 200);
    assert.equal(res.body.markets.length, 10);
    assert.deepEqual(Object.keys(res.body.markets[0]).sort(), [
      'code', 'country_code', 'country_name', 'currency_code', 'default_frequency', 'id', 'is_active', 'name', 'region', 'sort_order', 'timezone',
    ]);
    assert.ok(res.body.currencies.some((c: any) => c.code === 'KWD' && c.decimals === 3));
    assert.ok(res.body.brands.some((b: any) => b.name === 'Test Own' && b.ownership === 'own'));
    assert.ok(res.body.retailers.some((r: any) => r.id === fx.retailerId && r.collection_method === 'manual'));
    assert.ok(res.body.categories.some((c: any) => c.name === 'Hair Oil' && c.parent_id === null));
  });

  it('requires a session', async () => {
    assert.equal((await t.api('GET', '/reference', { as: null })).status, 401);
    assert.equal((await t.api('GET', '/products', { as: null })).status, 401);
  });
});

describe('brands', () => {
  it('lets analysts create, rename and associate brands; viewers cannot write', async () => {
    const denied = await t.api('POST', '/brands', { as: 'viewer', body: { name: 'Nope', ownership: 'own' } });
    assert.equal(denied.status, 403);

    const own = await t.api('POST', '/brands', { as: 'analyst', body: { name: 'Vatika', ownership: 'own', manufacturer: 'Dabur' } });
    assert.equal(own.status, 201);
    assert.equal(own.body.product_count, 0);
    assert.equal(own.body.manufacturer, 'Dabur');
    const rivalA = await brand('Parachute', 'competitor');
    const rivalB = await brand('Pantene', 'competitor');

    const dup = await t.api('POST', '/brands', { body: { name: 'vatika', ownership: 'competitor' } });
    assert.equal(dup.status, 409);

    const linked = await t.api('PUT', `/brands/${own.body.id}/competitors`, { as: 'analyst', body: { competitor_brand_ids: [rivalA, rivalB, rivalA] } });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.body.competitor_brand_ids.sort(), [rivalA, rivalB].sort());

    const list = await t.api('GET', '/brands?ownership=competitor');
    const parachute = list.body.rows.find((b: any) => b.id === rivalA);
    assert.deepEqual(parachute.benchmarked_by_brand_ids, [own.body.id]);
    assert.ok(list.body.rows.every((b: any) => b.ownership === 'competitor'));

    const renamed = await t.api('PATCH', `/brands/${rivalB}`, { body: { name: 'Pantene Pro-V' } });
    assert.equal(renamed.body.name, 'Pantene Pro-V');
    assert.equal(renamed.body.ownership, 'competitor');
    assert.ok(auditCount('brand.updated', rivalB) >= 1);
  });

  it('validates associations and protects brands in use', async () => {
    const own = await brand('Own Assoc', 'own');
    const rival = await brand('Rival Assoc', 'competitor');
    assert.equal((await t.api('PUT', `/brands/${rival}/competitors`, { body: { competitor_brand_ids: [own] } })).status, 422);
    assert.equal((await t.api('PUT', `/brands/${own}/competitors`, { body: { competitor_brand_ids: [own] } })).status, 422);
    assert.equal((await t.api('PUT', `/brands/${own}/competitors`, { body: { competitor_brand_ids: [999_999] } })).status, 422);
    await t.api('PUT', `/brands/${own}/competitors`, { body: { competitor_brand_ids: [rival] } });
    // ownership cannot flip while associations exist
    assert.equal((await t.api('PATCH', `/brands/${rival}`, { body: { ownership: 'own' } })).status, 409);
    // a brand with products cannot be deleted
    const inUse = await t.api('DELETE', `/brands/${fx.ownBrandId}`);
    assert.equal(inUse.status, 409);
    assert.match(inUse.body.error.message, /cannot be deleted/);
    // an unused brand can
    const unused = await brand('Disposable', 'competitor');
    assert.equal((await t.api('DELETE', `/brands/${unused}`)).status, 200);
    assert.equal(scalar('SELECT COUNT(*) FROM brands WHERE id = ?', [unused]), 0);
    assert.equal((await t.api('POST', '/brands', { body: { name: '', ownership: 'own' } })).status, 422);
    assert.equal((await t.api('POST', '/brands', { body: { name: 'X', ownership: 'partner' } })).status, 422);
  });
});

describe('categories', () => {
  it('supports two levels and refuses a third', async () => {
    const top = await category('Oral Care');
    const sub = await category('Toothpaste', top);
    const third = await t.api('POST', '/categories', { body: { name: 'Herbal', parent_id: sub } });
    assert.equal(third.status, 422);
    assert.match(third.body.error.message, /two levels/);
    assert.equal((await t.api('POST', '/categories', { body: { name: 'toothpaste', parent_id: top } })).status, 409);
    // the same name under another parent is fine
    const other = await category('Hair Care');
    assert.equal((await t.api('POST', '/categories', { body: { name: 'Toothpaste', parent_id: other } })).status, 201);
    const rows = (await t.api('GET', '/categories')).body.rows;
    const topRow = rows.find((c: any) => c.id === top);
    assert.equal(topRow.child_count, 1);
    assert.equal(rows.find((c: any) => c.id === sub).parent_name, 'Oral Care');
  });

  it('protects categories that are in use', async () => {
    const top = await category('Skin Care');
    const sub = await category('Body Lotion', top);
    assert.equal((await t.api('DELETE', `/categories/${top}`)).status, 409); // has children
    await product({ brand_id: fx.ownBrandId, name: 'Lotion 100ml', category_id: top, subcategory_id: sub, pack_size: 100, pack_unit: 'ml' });
    assert.equal((await t.api('DELETE', `/categories/${sub}`)).status, 409); // used by a product
    assert.equal((await t.api('PATCH', `/categories/${sub}`, { body: { parent_id: null } })).status, 409); // cannot move while used
    const renamed = await t.api('PATCH', `/categories/${sub}`, { body: { name: 'Body Lotions' } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Body Lotions');
    assert.equal(renamed.body.product_count, 1);
    const free = await category('Temporary');
    assert.equal((await t.api('DELETE', `/categories/${free}`)).status, 200);
    assert.equal((await t.api('POST', '/categories', { as: 'viewer', body: { name: 'Nope' } })).status, 403);
  });
});

describe('markets and currencies', () => {
  it('only administrators manage markets; inputs are validated', async () => {
    const body = { code: 'tz', name: 'Tanzania', country_name: 'Tanzania', currency_code: 'TZS', timezone: 'Africa/Dar_es_Salaam', default_frequency: '12h' };
    assert.equal((await t.api('POST', '/markets', { as: 'analyst', body })).status, 403);
    const created = await t.api('POST', '/markets', { body });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.code, 'TZ');
    assert.equal(created.body.country_code, 'TZ');
    assert.equal(created.body.default_frequency, '12h');
    assert.equal(created.body.retailer_count, 0);
    assert.equal((await t.api('POST', '/markets', { body })).status, 409);
    assert.equal((await t.api('POST', '/markets', { body: { ...body, code: 'T2', name: 'T2', timezone: 'Mars/Olympus' } })).status, 422);
    assert.equal((await t.api('POST', '/markets', { body: { ...body, code: 'T3', name: 'T3', currency_code: 'XXX' } })).status, 422);
    // code is immutable, other fields are editable
    assert.equal((await t.api('PATCH', `/markets/${created.body.id}`, { body: { code: 'TA' } })).status, 422);
    const patched = await t.api('PATCH', `/markets/${created.body.id}`, { body: { region: 'East Africa', is_active: false } });
    assert.equal(patched.body.region, 'East Africa');
    assert.equal(patched.body.is_active, 0);
    assert.equal(patched.body.name, 'Tanzania');
    // empty market can be deleted; a market with retailers cannot
    assert.equal((await t.api('DELETE', `/markets/${created.body.id}`)).status, 200);
    const busy = await t.api('DELETE', `/markets/${fx.marketId}`);
    assert.equal(busy.status, 409);
    assert.match(busy.body.error.message, /Deactivate/);
    assert.equal((await t.api('PATCH', `/markets/${fx.marketId}`, { body: { currency_code: 'USD' } })).status, 409);
  });

  it('a market schedule change reaches the retailers that inherit it', async () => {
    const m = await t.api('POST', '/markets', { body: { code: 'EG', name: 'Egypt', currency_code: 'EGP', timezone: 'Africa/Cairo', default_frequency: 'manual' } });
    const inheriting = await retailer({ name: 'Feed Shop', market_id: m.body.id, collection_method: 'product_feed' });
    const own = await retailer({ name: 'Own Schedule', market_id: m.body.id, collection_method: 'product_feed', collection_frequency: 'daily' });
    const get = async (id: number) => (await t.api('GET', `/retailers/${id}`)).body;
    assert.equal((await get(inheriting)).next_run_at, null); // market default is manual
    assert.equal((await get(inheriting)).effective_frequency, 'manual');
    assert.ok((await get(own)).next_run_at);
    await t.api('PATCH', `/markets/${m.body.id}`, { body: { default_frequency: '6h' } });
    assert.ok((await get(inheriting)).next_run_at);
    assert.equal((await get(inheriting)).effective_frequency, '6h');
    await t.api('PATCH', `/markets/${m.body.id}`, { body: { default_frequency: 'manual' } });
    assert.equal((await get(inheriting)).next_run_at, null);
    assert.ok((await get(own)).next_run_at); // explicit schedule untouched
  });

  it('adds currencies', async () => {
    assert.equal((await t.api('POST', '/currencies', { as: 'analyst', body: { code: 'RWF', name: 'Rwandan Franc' } })).status, 403);
    const created = await t.api('POST', '/currencies', { body: { code: 'rwf', name: 'Rwandan Franc', decimals: 0 } });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { code: 'RWF', name: 'Rwandan Franc', symbol: 'RWF', decimals: 0 });
    assert.equal((await t.api('POST', '/currencies', { body: { code: 'RWF', name: 'Again' } })).status, 409);
    assert.ok((await t.api('GET', '/currencies')).body.rows.some((c: any) => c.code === 'RWF'));
  });
});

describe('products', () => {
  let hairCare: number;
  let shampoo: number;
  let conditioner: number;
  let ownBrand: number;
  let rivalBrand: number;

  before(async () => {
    hairCare = await category('Hair Wash');
    shampoo = await category('Shampoo', hairCare);
    conditioner = await category('Conditioner', hairCare);
    ownBrand = await brand('Dabur Vatika Test', 'own');
    rivalBrand = await brand('Sunsilk Test', 'competitor');
  });

  it('creates a product with all catalogue attributes and returns its detail', async () => {
    const res = await t.api('POST', '/products', {
      as: 'analyst',
      body: {
        brand_id: ownBrand, name: 'Vatika Black Seed Shampoo', category_id: hairCare, subcategory_id: shampoo, product_line: 'Vatika Naturals',
        sku: 'VAT-BS-400', gtin: '6291-0690 12345', pack_size: '400', pack_unit: 'ml', image_url: 'https://cdn.example.com/vatika.png',
        description: 'Black seed shampoo', market_ids: [marketId('AE'), marketId('KE'), marketId('AE')],
      },
    });
    assert.equal(res.status, 201, res.raw);
    const p = res.body.product;
    assert.match(p.code, /^PRD-\d{5}$/);
    assert.equal(p.brand_name, 'Dabur Vatika Test');
    assert.equal(p.ownership, 'own');
    assert.equal(p.category_name, 'Hair Wash');
    assert.equal(p.subcategory_name, 'Shampoo');
    assert.equal(p.gtin, '6291069012345');
    assert.equal(p.pack_size, 400);
    assert.equal(p.pack_label, '400ml');
    assert.equal(p.units_per_pack, 1);
    assert.equal(p.status, 'active');
    assert.equal(p.is_demo, 0);
    assert.equal(p.listing_count, 0);
    assert.equal(p.market_count, 2);
    assert.deepEqual(res.body.market_ids.sort(), [marketId('AE'), marketId('KE')].sort());
    assert.deepEqual(res.body.listings, []);
    assert.deepEqual(res.body.variants, []);
    assert.equal(auditCount('product.created', p.id), 1);
    const viewer = await t.api('GET', `/products/${p.id}`, { as: 'viewer' });
    assert.equal(viewer.status, 200);
    assert.equal(viewer.body.product.name, 'Vatika Black Seed Shampoo');
  });

  it('rejects invalid products with clear messages', async () => {
    const base = { brand_id: ownBrand, name: 'Bad Product', category_id: hairCare };
    const post = (extra: Record<string, unknown>, as: 'admin' | 'viewer' = 'admin') => t.api('POST', '/products', { as, body: { ...base, ...extra } });
    assert.equal((await post({}, 'viewer')).status, 403);
    assert.equal((await post({ name: '   ' })).status, 422);
    assert.equal((await post({ brand_id: 999_999 })).status, 422);
    assert.equal((await post({ category_id: shampoo })).status, 422); // a subcategory is not a top-level category
    const otherTop = await category('Unrelated Top');
    const foreignSub = await category('Foreign Sub', otherTop);
    const wrongSub = await post({ subcategory_id: foreignSub });
    assert.equal(wrongSub.status, 422);
    assert.match(wrongSub.body.error.message, /does not belong/);
    assert.match((await post({ pack_size: 200 })).body.error.message, /together/);
    assert.equal((await post({ pack_size: -5, pack_unit: 'ml' })).status, 422);
    assert.equal((await post({ pack_size: 5, pack_unit: 'oz' })).status, 422);
    assert.equal((await post({ units_per_pack: 1.5 })).status, 422);
    assert.match((await post({ gtin: '12AB' })).body.error.message, /8 to 14 digits/);
    assert.equal((await post({ image_url: 'javascript:alert(1)' })).status, 422);
    assert.equal((await post({ market_ids: [999_999] })).status, 422);
    const dupSku = await post({ sku: 'VAT-BS-400' });
    assert.equal(dupSku.status, 409);
    assert.match(dupSku.body.error.message, /already used by product PRD-/);
    assert.equal((await post({ gtin: '6291069012345' })).status, 409);
    assert.equal(scalar(`SELECT COUNT(*) FROM products WHERE name = 'Bad Product'`), 0);
  });

  it('filters, sorts, groups and paginates the catalogue', async () => {
    await product({ brand_id: ownBrand, name: 'Vatika Conditioner 200ml', category_id: hairCare, subcategory_id: conditioner, pack_size: 200, pack_unit: 'ml', market_ids: [marketId('AE')] });
    const rivalId = await product({ brand_id: rivalBrand, name: 'Sunsilk Shampoo 400ml', category_id: hairCare, subcategory_id: shampoo, pack_size: 400, pack_unit: 'ml', sku: 'SUN-400' });
    const inactiveId = await product({ brand_id: rivalBrand, name: 'Sunsilk Old Shampoo', category_id: hairCare, status: 'inactive' });

    const all = await t.api('GET', `/products?category_id=${hairCare}&sort=name`);
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 4);
    assert.deepEqual(Object.keys(all.body).sort(), ['page', 'page_size', 'pages', 'rows', 'total']);
    const names = all.body.rows.map((r: any) => r.name);
    assert.deepEqual(names, [...names].sort((a: string, b: string) => a.localeCompare(b)));

    assert.equal((await t.api('GET', `/products?category_id=${shampoo}`)).body.total, 2); // subcategory match
    assert.equal((await t.api('GET', `/products?category_id=${hairCare}&ownership=competitor`)).body.total, 2);
    assert.equal((await t.api('GET', `/products?brand_id=${ownBrand},${rivalBrand}&q=conditioner`)).body.total, 1);
    assert.equal((await t.api('GET', '/products?q=SUN-400')).body.rows[0].id, rivalId);
    assert.equal((await t.api('GET', `/products?category_id=${hairCare}&market_id=${marketId('KE')}`)).body.total, 1);
    assert.equal((await t.api('GET', `/products?category_id=${hairCare}&status=inactive`)).body.rows[0].id, inactiveId);
    assert.equal((await t.api('GET', `/products?category_id=${hairCare}&has_listings=true`)).body.total, 0);
    const paged = await t.api('GET', `/products?category_id=${hairCare}&page=2&page_size=3&sort=-name`);
    assert.equal(paged.body.rows.length, 1);
    assert.equal(paged.body.pages, 2);

    const byBrand = await t.api('GET', `/products/summary?group_by=brand&category_id=${hairCare}`);
    assert.equal(byBrand.body.total, 4);
    assert.deepEqual(byBrand.body.groups.map((g: any) => [g.label, g.ownership, g.count]), [
      ['Dabur Vatika Test', 'own', 2],
      ['Sunsilk Test', 'competitor', 2],
    ]);
    const byMarket = await t.api('GET', `/products/summary?group_by=market&category_id=${hairCare}`);
    const groups = Object.fromEntries(byMarket.body.groups.map((g: any) => [g.label, g.count]));
    assert.equal(groups.UAE, 2);
    assert.equal(groups.Kenya, 1);
    assert.equal(groups['No market assigned'], 2);
    const byCategory = await t.api('GET', `/products/summary?group_by=category&brand_id=${ownBrand}`);
    assert.deepEqual(byCategory.body.groups.map((g: any) => [g.label, g.count]), [['Hair Wash', 2]]);

    const options = await t.api('GET', `/products/options?q=sunsilk&ownership=competitor`);
    assert.equal(options.body.rows.length, 2);
    assert.equal(options.body.rows.find((o: any) => o.id === rivalId).pack_label, '400ml');
    const byIds = await t.api('GET', `/products/options?ids=${rivalId}`);
    assert.deepEqual(byIds.body.rows.map((o: any) => o.id), [rivalId]);
  });

  it('updates only the fields that were sent', async () => {
    const id = await product({
      brand_id: ownBrand, name: 'Patch Me 100ml', category_id: hairCare, subcategory_id: shampoo, sku: 'PATCH-1', pack_size: 100, pack_unit: 'ml',
      description: 'original', market_ids: [marketId('AE')],
    });
    const renamed = await t.api('PATCH', `/products/${id}`, { as: 'analyst', body: { name: 'Patched 100ml' } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.product.name, 'Patched 100ml');
    assert.equal(renamed.body.product.sku, 'PATCH-1');
    assert.equal(renamed.body.product.description, 'original');
    assert.deepEqual(renamed.body.market_ids, [marketId('AE')]);
    const cleared = await t.api('PATCH', `/products/${id}`, { body: { description: null, sku: '', units_per_pack: 2 } });
    assert.equal(cleared.body.product.description, null);
    assert.equal(cleared.body.product.sku, null);
    assert.equal(cleared.body.product.pack_label, '2 × 100ml');
    // moving to another category drops the subcategory that no longer fits
    const otherTop = await category('Hair Styling');
    const moved = await t.api('PATCH', `/products/${id}`, { body: { category_id: otherTop } });
    assert.equal(moved.body.product.category_name, 'Hair Styling');
    assert.equal(moved.body.product.subcategory_id, null);
    assert.equal((await t.api('PATCH', `/products/${id}`, { body: { subcategory_id: shampoo } })).status, 422);
    assert.equal((await t.api('PATCH', `/products/${id}`, { body: { pack_unit: null } })).status, 422); // size without unit
    assert.equal((await t.api('PATCH', `/products/${id}`, { as: 'viewer', body: { name: 'x' } })).status, 403);
    assert.equal((await t.api('PATCH', '/products/999999', { body: { name: 'x' } })).status, 404);
    const marketsSet = await t.api('PUT', `/products/${id}/markets`, { body: { market_ids: [marketId('SA'), marketId('QA')] } });
    assert.deepEqual(marketsSet.body.markets.map((m: any) => m.code).sort(), ['QA', 'SA']);
    const log = t.ctx.db.get<{ detail: string }>(`SELECT detail FROM audit_log WHERE action = 'product.updated' AND entity_id = ? ORDER BY id LIMIT 1`, [String(id)])!;
    assert.deepEqual(JSON.parse(log.detail), { name: { from: 'Patch Me 100ml', to: 'Patched 100ml' } });
  });

  it('archives instead of deleting products that have listings', async () => {
    const withListing = await t.api('DELETE', `/products/${fx.ownProductId}`);
    assert.equal(withListing.status, 409);
    assert.match(withListing.body.error.message, /Archive the product instead/);
    assert.equal(scalar('SELECT COUNT(*) FROM products WHERE id = ?', [fx.ownProductId]), 1);

    const id = await product({ brand_id: ownBrand, name: 'Short Lived', category_id: hairCare, market_ids: [marketId('AE')] });
    const archived = await t.api('POST', `/products/${id}/archive`);
    assert.equal(archived.body.product.status, 'archived');
    assert.ok(!(await t.api('GET', '/products?q=Short Lived')).body.rows.length); // hidden by default
    assert.equal((await t.api('GET', '/products?q=Short Lived&status=archived')).body.total, 1);
    assert.equal((await t.api('GET', '/products?q=Short Lived&status=all')).body.total, 1);
    assert.equal((await t.api('PATCH', `/products/${id}`, { body: { status: 'active' } })).status, 409);
    const restored = await t.api('POST', `/products/${id}/restore`);
    assert.equal(restored.body.product.status, 'active');
    assert.equal((await t.api('POST', `/products/${id}/restore`)).status, 409);
    assert.equal((await t.api('DELETE', `/products/${id}`, { as: 'viewer' })).status, 403);
    assert.equal((await t.api('DELETE', `/products/${id}`)).status, 200);
    assert.equal(scalar('SELECT COUNT(*) FROM product_markets WHERE product_id = ?', [id]), 0);
    assert.equal((await t.api('GET', `/products/${id}`)).status, 404);
    assert.equal(auditCount('product.archived', id), 1);
    assert.equal(auditCount('product.deleted', id), 1);
  });

  it('manages pack variants and uses them for the effective pack of a listing', async () => {
    const id = await product({ brand_id: ownBrand, name: 'Variant Host 200ml', category_id: hairCare, pack_size: 200, pack_unit: 'ml' });
    const twin = await t.api('POST', `/products/${id}/variants`, { as: 'analyst', body: { name: 'Twin pack', pack_size: 200, pack_unit: 'ml', units_per_pack: 2 } });
    assert.equal(twin.status, 201, twin.raw);
    assert.equal(twin.body.pack_label, '2 × 200ml');
    assert.equal((await t.api('POST', `/products/${id}/variants`, { body: { name: 'twin pack', pack_size: 100, pack_unit: 'ml' } })).status, 409);
    assert.equal((await t.api('POST', `/products/${id}/variants`, { body: { name: 'Broken', pack_size: 0, pack_unit: 'ml' } })).status, 422);
    const bonus = await t.api('POST', `/products/${id}/variants`, { body: { name: 'Bonus pack', pack_size: 250, pack_unit: 'ml' } });
    const patched = await t.api('PATCH', `/variants/${bonus.body.id}`, { body: { notes: '25% extra free' } });
    assert.equal(patched.body.notes, '25% extra free');
    assert.equal(patched.body.pack_size, 250);

    const listing = await t.api('POST', '/listings', {
      body: { retailer_id: fx.retailerId, url: 'https://testmart.example/p/variant-host-twin', product_id: id, variant_id: twin.body.id },
    });
    assert.equal(listing.status, 201, listing.raw);
    assert.equal(listing.body.variant_name, 'Twin pack');
    assert.equal(listing.body.pack_label, '2 × 200ml');
    assert.equal(listing.body.content_amount, 400);
    const inUse = await t.api('DELETE', `/variants/${twin.body.id}`);
    assert.equal(inUse.status, 409);
    assert.equal((await t.api('DELETE', `/variants/${bonus.body.id}`)).status, 200);
    const detail = await t.api('GET', `/products/${id}`);
    assert.deepEqual(detail.body.variants.map((v: any) => [v.name, v.listing_count]), [['Twin pack', 1]]);
    assert.equal(detail.body.product.variant_count, 1);
  });

  it('shows listings with latest and previous prices, mappings and associated brands in the product detail', async () => {
    ingestObservations(
      t.ctx,
      [
        { listing_id: fx.ownListingId, observed_at: ago(3), current_price: 12, regular_price: 12, availability: 'in_stock' },
        { listing_id: fx.ownListingId, observed_at: ago(1), current_price: 9, regular_price: 12, availability: 'in_stock' },
      ],
      { sourceMethod: 'manual', suppressAlerts: true },
    );
    await t.api('PUT', `/brands/${fx.ownBrandId}/competitors`, { body: { competitor_brand_ids: [fx.compBrandId] } });
    const own = await t.api('GET', `/products/${fx.ownProductId}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.product.listing_count, 1);
    assert.equal(own.body.product.retailer_count, 1);
    assert.ok(own.body.product.last_observed_at);
    const listing = own.body.listings[0];
    assert.equal(listing.id, fx.ownListingId);
    assert.match(listing.code, /^LST-\d{6}$/);
    assert.equal(listing.retailer_name, 'Test Mart');
    assert.equal(listing.currency_code, 'AED');
    assert.equal(listing.obs_count, 2);
    assert.equal(listing.latest.current_price, 9);
    assert.equal(listing.latest.is_promo, 1);
    assert.equal(listing.latest.discount_pct, 25);
    assert.equal(listing.latest.data_class, 'manual');
    assert.equal(listing.latest.unit_price, 4.5); // 9 AED for 200 ml → 4.50 per 100 ml
    assert.equal(listing.previous_price, 12);
    assert.equal(own.body.mappings.as_own.length, 1);
    assert.equal(own.body.mappings.as_own[0].competitor.product_id, fx.compProductId);
    assert.equal(own.body.mappings.as_own[0].equivalence, 'comparable');
    assert.deepEqual(own.body.mappings.as_competitor, []);
    assert.deepEqual(own.body.associated_brands.map((b: any) => b.id), [fx.compBrandId]);
    const rival = await t.api('GET', `/products/${fx.compProductId}`);
    assert.equal(rival.body.mappings.as_competitor[0].own.product_id, fx.ownProductId);
    assert.deepEqual(rival.body.associated_brands.map((b: any) => b.id), [fx.ownBrandId]);
    assert.equal(rival.body.listings[0].latest, null);
  });
});

describe('retailers', () => {
  const SECRET = 'sk-live-THIS-MUST-NEVER-LEAK-9f3a';

  it('only administrators manage sources; defaults come from the market', async () => {
    const body = { name: 'Carrefour Test', website: 'https://www.carrefour.example', market_id: marketId('SA'), collection_method: 'official_api' };
    assert.equal((await t.api('POST', '/retailers', { as: 'analyst', body })).status, 403);
    assert.equal((await t.api('POST', '/retailers', { as: 'viewer', body })).status, 403);
    const created = await t.api('POST', '/retailers', { body });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.currency_code, 'SAR');
    assert.equal(created.body.country_code, 'SA');
    assert.equal(created.body.market_name, 'Saudi Arabia');
    assert.equal(created.body.collection_frequency, null);
    assert.equal(created.body.effective_frequency, 'daily');
    assert.equal(created.body.is_enabled, 1);
    assert.equal(created.body.is_demo, 0);
    assert.equal(created.body.permission_attested, 0);
    assert.ok(created.body.next_run_at, 'automated sources are scheduled');
    assert.deepEqual(created.body.connector_config, {});
    assert.deepEqual(created.body.credential, { configured: false, hint: null, updated_at: null });
    assert.equal(created.body.listing_count, 0);

    const manual = await t.api('POST', '/retailers', { body: { name: 'Manual Shop', market_id: marketId('SA'), collection_method: 'manual', collection_frequency: 'weekly' } });
    assert.equal(manual.body.next_run_at, null);
    assert.equal(manual.body.effective_frequency, 'weekly');
    const onDemand = await t.api('POST', '/retailers', { body: { name: 'On Demand Feed', market_id: marketId('SA'), collection_method: 'product_feed', collection_frequency: 'manual' } });
    assert.equal(onDemand.body.next_run_at, null);

    assert.equal((await t.api('POST', '/retailers', { body })).status, 409); // same name, same market
    assert.equal((await t.api('POST', '/retailers', { body: { ...body, market_id: marketId('KW') } })).status, 201); // other market is fine
    assert.equal((await t.api('POST', '/retailers', { body: { ...body, name: 'Sim', collection_method: 'simulated' } })).status, 422);
    assert.equal((await t.api('POST', '/retailers', { body: { ...body, name: 'Bad Url', website: 'ftp://files.example' } })).status, 422);
    assert.equal((await t.api('POST', '/retailers', { body: { ...body, name: 'No Market', market_id: 999_999 } })).status, 422);
    assert.equal((await t.api('POST', '/retailers', { body: { ...body, name: 'Fast', rate_limit_ms: 10 } })).status, 422);
    assert.equal((await t.api('POST', '/retailers', { body: { ...body, name: 'Bad Method', collection_method: 'screen_scrape' } })).status, 422);
    assert.equal(auditCount('retailer.created', created.body.id), 1);
  });

  it('never accepts credentials in connector settings', async () => {
    const base = { name: 'Config Shop', market_id: marketId('QA'), collection_method: 'official_api' };
    const flat = await t.api('POST', '/retailers', { body: { ...base, connector_config: { url: 'https://api.example/v1', api_key: SECRET } } });
    assert.equal(flat.status, 422);
    assert.match(flat.body.error.message, /must not contain credentials \("api_key"\)/);
    const nested = await t.api('POST', '/retailers', { body: { ...base, connector_config: { auth: { type: 'bearer' }, headers: [{ Authorization: `Bearer ${SECRET}` }] } } });
    assert.equal(nested.status, 422);
    assert.match(nested.body.error.message, /headers\[0\]\.Authorization/);
    assert.equal((await t.api('POST', '/retailers', { body: { ...base, connector_config: ['not', 'an', 'object'] } })).status, 422);
    const ok = await t.api('POST', '/retailers', {
      body: { ...base, connector_config: { mode: 'bulk', url: 'https://api.example/v1/items', auth: { type: 'header', header_name: 'X-API-Key' }, fields: { current_price: 'price.now' } } },
    });
    assert.equal(ok.status, 201, ok.raw);
    assert.equal(ok.body.connector_config.auth.header_name, 'X-API-Key');
    const patched = await t.api('PATCH', `/retailers/${ok.body.id}`, { body: { connector_config: { mode: 'bulk', password: 'x' } } });
    assert.equal(patched.status, 422);
    assert.equal(scalar('SELECT COUNT(*) FROM retailers WHERE connector_config LIKE ?', [`%${SECRET}%`]), 0);
  });

  it('stores the credential encrypted and never returns it', async () => {
    const id = await retailer({ name: 'Secret Shop', market_id: marketId('BH'), collection_method: 'third_party' });
    assert.equal((await t.api('PUT', `/retailers/${id}/credential`, { as: 'analyst', body: { value: SECRET } })).status, 403);
    assert.equal((await t.api('PUT', `/retailers/${id}/credential`, { body: { value: '   ' } })).status, 422);
    const set = await t.api('PUT', `/retailers/${id}/credential`, { body: { value: SECRET } });
    assert.equal(set.status, 200);
    assert.equal(set.body.credential.configured, true);
    assert.equal(set.body.credential.hint, '…9f3a');

    const responses = [
      set,
      await t.api('GET', `/retailers/${id}`),
      await t.api('GET', '/retailers'),
      await t.api('GET', `/retailers/${id}`, { as: 'analyst' }),
      await t.api('GET', '/reference'),
      await t.api('PATCH', `/retailers/${id}`, { body: { notes: 'updated' } }),
    ];
    for (const res of responses) assert.ok(!res.raw.includes(SECRET), 'credential leaked in an API response');
    // at rest: encrypted, and absent from the audit trail
    const stored = t.ctx.db.get<{ ciphertext: string }>('SELECT ciphertext FROM secrets WHERE name = ?', [`retailer:${id}:credential`])!;
    assert.ok(!stored.ciphertext.includes(SECRET));
    assert.equal(scalar('SELECT COUNT(*) FROM audit_log WHERE detail LIKE ?', [`%${SECRET}%`]), 0);
    assert.equal(auditCount('retailer.credential_set', id), 1);

    // non-managers learn only whether a credential exists; connector settings are hidden from them
    const analystView = (await t.api('GET', `/retailers/${id}`, { as: 'analyst' })).body;
    assert.deepEqual(analystView.credential, { configured: true, hint: null, updated_at: null });
    assert.equal(analystView.connector_config, null);

    const removed = await t.api('DELETE', `/retailers/${id}/credential`);
    assert.equal(removed.body.credential.configured, false);
    assert.equal(scalar('SELECT COUNT(*) FROM secrets WHERE name = ?', [`retailer:${id}:credential`]), 0);
  });

  it('records who attested permitted access, and when', async () => {
    const id = await retailer({ name: 'Extraction Shop', market_id: marketId('OM'), collection_method: 'web_extraction' });
    assert.equal((await t.api('POST', `/retailers/${id}/attest-permission`, { as: 'analyst', body: { attested: true, note: 'Partner agreement 2026' } })).status, 403);
    const noBasis = await t.api('POST', `/retailers/${id}/attest-permission`, { body: { attested: true } });
    assert.equal(noBasis.status, 422);
    const ok = await t.api('POST', `/retailers/${id}/attest-permission`, { body: { attested: true, note: 'Written permission from retailer partnership team, ref PA-2026-14' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.permission_attested, 1);
    assert.equal(ok.body.permission_attested_by_name, 'Test admin');
    assert.ok(ok.body.permission_attested_at);
    assert.match(ok.body.permission_note, /PA-2026-14/);
    const withdrawn = await t.api('POST', `/retailers/${id}/attest-permission`, { body: { attested: false } });
    assert.equal(withdrawn.body.permission_attested, 0);
    assert.equal(withdrawn.body.permission_attested_by, null);
    assert.equal(withdrawn.body.permission_attested_at, null);
    assert.equal(auditCount('retailer.permission_attested', id), 1);
    assert.equal(auditCount('retailer.permission_withdrawn', id), 1);
  });

  it('re-plans the schedule when method, frequency or state changes', async () => {
    const id = await retailer({ name: 'Schedule Shop', market_id: marketId('IQ'), collection_method: 'product_feed', collection_frequency: '6h' });
    const patch = async (body: Record<string, unknown>) => (await t.api('PATCH', `/retailers/${id}`, { body })).body;
    assert.equal((await patch({ is_enabled: false })).next_run_at, null); // paused
    assert.ok((await patch({ is_enabled: true })).next_run_at); // resumed
    assert.equal((await patch({ collection_frequency: 'manual' })).next_run_at, null);
    assert.ok((await patch({ collection_frequency: null })).next_run_at); // back to the market default (daily)
    assert.equal((await patch({ collection_method: 'csv_import' })).next_run_at, null); // people-driven method
    const before = await patch({ collection_method: 'official_api' });
    assert.ok(before.next_run_at);
    // an unrelated edit leaves the schedule alone
    t.ctx.db.run('UPDATE retailers SET next_run_at = ? WHERE id = ?', ['2030-01-01T00:00:00.000Z', id]);
    assert.equal((await patch({ notes: 'just a note' })).next_run_at, '2030-01-01T00:00:00.000Z');
    assert.equal((await patch({ is_active: false })).next_run_at, null);
    assert.equal((await t.api('PATCH', `/retailers/${id}`, { as: 'analyst', body: { notes: 'x' } })).status, 403);
  });

  it('protects recorded history when a retailer is edited or deleted', async () => {
    // fx.retailerId has observations (ingested in the products suite) and listings
    const moved = await t.api('PATCH', `/retailers/${fx.retailerId}`, { body: { market_id: marketId('SA') } });
    assert.equal(moved.status, 409);
    assert.match(moved.body.error.message, /cannot change once it has price observations/);
    assert.equal((await t.api('PATCH', `/retailers/${fx.retailerId}`, { body: { currency_code: 'USD' } })).status, 409);
    const del = await t.api('DELETE', `/retailers/${fx.retailerId}`);
    assert.equal(del.status, 409);
    assert.match(del.body.error.message, /Deactivate the retailer instead/);
    const deactivated = await t.api('PATCH', `/retailers/${fx.retailerId}`, { body: { is_active: false } });
    assert.equal(deactivated.body.is_active, 0);
    await t.api('PATCH', `/retailers/${fx.retailerId}`, { body: { is_active: true } });

    const empty = await retailer({ name: 'Empty Shop', market_id: marketId('GH'), collection_method: 'manual' });
    await t.api('PUT', `/retailers/${empty}/credential`, { body: { value: 'temporary-credential' } });
    assert.equal((await t.api('DELETE', `/retailers/${empty}`)).status, 200);
    assert.equal(scalar('SELECT COUNT(*) FROM secrets WHERE name = ?', [`retailer:${empty}:credential`]), 0);
    assert.equal((await t.api('GET', `/retailers/${empty}`)).status, 404);

    // demo sources cannot be turned into real ones
    const demo = await retailer({ name: 'Demo Source', market_id: marketId('UG'), collection_method: 'manual' });
    t.ctx.db.run(`UPDATE retailers SET is_demo = 1, collection_method = 'simulated' WHERE id = ?`, [demo]);
    const converted = await t.api('PATCH', `/retailers/${demo}`, { body: { collection_method: 'official_api' } });
    assert.equal(converted.status, 409);
    assert.equal((await t.api('PATCH', `/retailers/${demo}`, { body: { is_enabled: false } })).status, 200);
  });

  it('lists retailers with filters and listing counts', async () => {
    const res = await t.api('GET', `/retailers?market_id=${marketId('AE')}`, { as: 'viewer' });
    assert.equal(res.status, 200);
    const row = res.body.rows.find((r: any) => r.id === fx.retailerId);
    assert.equal(row.matched_listing_count, row.listing_count);
    assert.equal(row.unmatched_listing_count, 0);
    assert.equal(row.observation_count, 2);
    assert.ok(row.last_observed_at);
    assert.ok(res.body.rows.every((r: any) => r.market_code === 'AE'));
    assert.equal((await t.api('GET', '/retailers?method=web_extraction')).body.rows.length, 1);
    assert.equal((await t.api('GET', '/retailers?q=carrefour')).body.total, 2);
  });
});

describe('listings', () => {
  let retailerId: number;
  let otherRetailer: number;
  let productId: number;

  before(async () => {
    retailerId = await retailer({ name: 'Listing Mart', market_id: marketId('KE'), collection_method: 'manual' });
    otherRetailer = await retailer({ name: 'Listing Mart 2', market_id: marketId('KE'), collection_method: 'manual' });
    productId = await product({ brand_id: fx.ownBrandId, name: 'Listed Oil 100ml', category_id: fx.categoryId, pack_size: 100, pack_unit: 'ml' });
  });

  it('creates listings with their own identifier and URL, mapped to a canonical product', async () => {
    const res = await t.api('POST', '/listings', {
      as: 'analyst',
      body: { retailer_id: retailerId, url: 'https://listing-mart.example/p/oil-100', external_id: 'SKU-100', title: 'Listed Oil 100 ml', product_id: productId },
    });
    assert.equal(res.status, 201, res.raw);
    assert.match(res.body.code, /^LST-\d{6}$/);
    assert.equal(res.body.match_status, 'matched');
    assert.equal(res.body.product_name, 'Listed Oil 100ml');
    assert.equal(res.body.currency_code, 'KES');
    assert.equal(res.body.market_code, 'KE');
    assert.equal(res.body.is_demo, 0);
    assert.ok(res.body.matched_at);
    assert.equal(res.body.latest, null);
    assert.equal(res.body.obs_count, 0);
    // listing a product at a Kenyan retailer makes it available in Kenya
    assert.equal(scalar('SELECT COUNT(*) FROM product_markets WHERE product_id = ? AND market_id = ?', [productId, marketId('KE')]), 1);
    assert.equal(auditCount('listing.created', res.body.id), 1);
    assert.equal(auditCount('listing.matched', res.body.id), 1);

    // several listings (at different retailers) can map to the same canonical product
    const second = await t.api('POST', '/listings', { body: { retailer_id: otherRetailer, url: 'https://listing-mart.example/p/oil-100', external_id: 'SKU-100', product_id: productId } });
    assert.equal(second.status, 201);
    assert.equal((await t.api('GET', `/products/${productId}`)).body.listings.length, 2);

    const unmatched = await t.api('POST', '/listings', { body: { retailer_id: retailerId, url: 'https://listing-mart.example/p/unknown-item' } });
    assert.equal(unmatched.body.match_status, 'unmatched');
    assert.equal(unmatched.body.product_id, null);
    assert.equal(unmatched.body.pack_label, '—');
  });

  it('enforces URL, uniqueness and variant rules', async () => {
    const post = (body: Record<string, unknown>, as: 'admin' | 'viewer' = 'admin') => t.api('POST', '/listings', { as, body: { retailer_id: retailerId, ...body } });
    assert.equal((await post({ url: 'https://x.example/a' }, 'viewer')).status, 403);
    assert.equal((await post({})).status, 422); // URL is required
    assert.equal((await post({ url: 'ftp://x.example/a' })).status, 422);
    assert.equal((await post({ url: 'not a url' })).status, 422);
    assert.equal((await post({ url: 'https://x.example/b', retailer_id: 999_999 })).status, 422);
    const dupUrl = await post({ url: 'https://listing-mart.example/p/oil-100' });
    assert.equal(dupUrl.status, 409);
    assert.match(dupUrl.body.error.message, /same URL/);
    const dupId = await post({ url: 'https://listing-mart.example/p/oil-100-b', external_id: 'SKU-100' });
    assert.equal(dupId.status, 409);
    assert.equal((await post({ url: 'https://x.example/c', gtin: 'abc' })).status, 422);
    assert.equal((await post({ url: 'https://x.example/d', product_id: 999_999 })).status, 422);
    // a variant must belong to the chosen product
    const foreign = await product({ brand_id: fx.ownBrandId, name: 'Variant Owner 50ml', category_id: fx.categoryId, pack_size: 50, pack_unit: 'ml' });
    const variant = await t.api('POST', `/products/${foreign}/variants`, { body: { name: 'Trio', pack_size: 50, pack_unit: 'ml', units_per_pack: 3 } });
    const mismatch = await post({ url: 'https://x.example/e', product_id: productId, variant_id: variant.body.id });
    assert.equal(mismatch.status, 422);
    assert.match(mismatch.body.error.message, /does not belong/);
    assert.equal((await post({ url: 'https://x.example/f', variant_id: variant.body.id })).status, 422); // variant without product
    assert.equal(scalar(`SELECT COUNT(*) FROM retailer_listings WHERE url LIKE 'https://x.example/%'`), 0); // nothing half-created
    // archived products cannot be mapped
    await t.api('POST', `/products/${foreign}/archive`);
    assert.equal((await post({ url: 'https://x.example/g', product_id: foreign })).status, 422);
  });

  it('edits listings without ever moving them between retailers', async () => {
    const created = await t.api('POST', '/listings', { body: { retailer_id: retailerId, url: 'https://listing-mart.example/p/editable', title: 'Editable' } });
    const id = created.body.id;
    const moved = await t.api('PATCH', `/listings/${id}`, { body: { retailer_id: otherRetailer } });
    assert.equal(moved.status, 422);
    assert.match(moved.body.error.message, /cannot be moved/);
    const mapped = await t.api('PATCH', `/listings/${id}`, { as: 'analyst', body: { product_id: productId, title: 'Editable Oil' } });
    assert.equal(mapped.status, 200, mapped.raw);
    assert.equal(mapped.body.match_status, 'matched');
    assert.equal(mapped.body.title, 'Editable Oil');
    const remapped = await t.api('PATCH', `/listings/${id}`, { body: { product_id: fx.ownProductId } });
    assert.equal(remapped.body.product_id, fx.ownProductId);
    const log = t.ctx.db.get<{ detail: string }>(`SELECT detail FROM audit_log WHERE action = 'listing.matched' AND entity_id = ? ORDER BY id DESC LIMIT 1`, [String(id)])!;
    assert.equal(JSON.parse(log.detail).previous_product_id, productId);
    const cleared = await t.api('PATCH', `/listings/${id}`, { body: { product_id: null } });
    assert.equal(cleared.body.match_status, 'unmatched');
    assert.equal(cleared.body.product_id, null);
    assert.equal((await t.api('PATCH', `/listings/${id}`, { body: { url: 'https://listing-mart.example/p/oil-100' } })).status, 409);
    assert.equal((await t.api('PATCH', `/listings/${id}`, { body: { is_active: false } })).body.is_active, 0);
    assert.equal((await t.api('PATCH', `/listings/${id}`, { as: 'viewer', body: { title: 'x' } })).status, 403);
    // direct SQL cannot move it either (database trigger)
    assert.throws(() => t.ctx.db.run('UPDATE retailer_listings SET retailer_id = ? WHERE id = ?', [otherRetailer, id]), /cannot be moved/);
  });

  it('keeps listings that have price history; deletes only empty ones', async () => {
    const withHistory = await t.api('DELETE', `/listings/${fx.ownListingId}`);
    assert.equal(withHistory.status, 409);
    assert.match(withHistory.body.error.message, /2 price observations/);
    assert.equal(scalar('SELECT COUNT(*) FROM retailer_listings WHERE id = ?', [fx.ownListingId]), 1);
    const empty = await t.api('POST', '/listings', { body: { retailer_id: retailerId, url: 'https://listing-mart.example/p/disposable' } });
    assert.equal((await t.api('DELETE', `/listings/${empty.body.id}`, { as: 'viewer' })).status, 403);
    assert.equal((await t.api('DELETE', `/listings/${empty.body.id}`)).status, 200);
    assert.equal((await t.api('GET', `/listings/${empty.body.id}`)).status, 404);
  });

  it('lists listings with filters and the latest price', async () => {
    const byRetailer = await t.api('GET', `/listings?retailer_id=${fx.retailerId}&sort=product`, { as: 'viewer' });
    assert.equal(byRetailer.status, 200);
    assert.ok(byRetailer.body.total >= 2);
    const own = byRetailer.body.rows.find((l: any) => l.id === fx.ownListingId);
    assert.equal(own.latest.current_price, 9);
    assert.equal(own.previous_price, 12);
    assert.equal(own.ownership, 'own');
    assert.equal((await t.api('GET', `/listings?retailer_id=${retailerId}&match_status=unmatched`)).body.rows.every((l: any) => l.match_status === 'unmatched'), true);
    assert.equal((await t.api('GET', `/listings?product_id=${productId}`)).body.total, 2);
    assert.equal((await t.api('GET', `/listings?market_id=${marketId('KE')}&q=SKU-100`)).body.total, 2);
    assert.equal((await t.api('GET', `/listings?retailer_id=${fx.retailerId}&has_observations=true`)).body.total, 1);
    assert.equal((await t.api('GET', `/listings?retailer_id=${retailerId}&active=false`)).body.total, 1);
  });
});

describe('listing ↔ product matching', () => {
  let retailerId: number;
  let amla200: number;
  let amla300: number;
  let brandId: number;
  const listing = async (body: Record<string, unknown>): Promise<number> => {
    const res = await t.api('POST', '/listings', { body: { retailer_id: retailerId, ...body } });
    assert.equal(res.status, 201, res.raw);
    return res.body.id;
  };
  const queue = async (query = '') => (await t.api('GET', `/matching/listings?retailer_id=${retailerId}${query}`)).body;
  const find = (body: any, id: number) => body.rows.find((r: any) => r.id === id);

  before(async () => {
    retailerId = await retailer({ name: 'Match Mart', market_id: marketId('AE'), collection_method: 'product_feed', collection_frequency: 'manual' });
    brandId = await brand('Dabur Amla', 'own');
    amla200 = await product({ brand_id: brandId, name: 'Dabur Amla Hair Oil 200ml', category_id: fx.categoryId, pack_size: 200, pack_unit: 'ml', gtin: '6291069700015' });
    amla300 = await product({ brand_id: brandId, name: 'Dabur Amla Hair Oil 300ml', category_id: fx.categoryId, pack_size: 300, pack_unit: 'ml' });
  });

  it('tokenises titles without sizes, stop words or plurals', () => {
    assert.deepEqual(tokenise('Dabur Amlà Hair Oils for Strong Hair, 2 x 200 ml (Pack of 2)'), ['dabur', 'amla', 'hair', 'oil', 'strong', 'hair']);
    assert.deepEqual(tokenise('7 Oils in One 1.5L'), ['oil', 'one']);
    assert.deepEqual(tokenise("Dabur Herb'l Clove Toothpaste 150g"), ['dabur', 'herbl', 'clove', 'toothpaste']);
  });

  it('does not treat identical names as identical SKUs: a different pack size is capped', async () => {
    const id = await listing({ url: 'https://match.example/p/1', title: 'Dabur Amla Hair Oil 300 ml' });
    const row = find(await queue(), id);
    assert.equal(row.match_status, 'unmatched', 'suggestions are never applied automatically');
    assert.equal(row.suggestions.length, 2);
    const [best, second] = row.suggestions;
    assert.equal(best.product_id, amla300);
    assert.ok(best.score > 0.85, `expected a strong match, got ${best.score}`);
    assert.ok(best.reasons.some((r: string) => /Pack size matches \(300ml\)/.test(r)));
    assert.ok(best.reasons.some((r: string) => /Brand "Dabur Amla" appears/.test(r)));
    assert.equal(second.product_id, amla200);
    assert.ok(second.score <= 0.5, `same name / different size must be capped at 0.5, got ${second.score}`);
    assert.ok(second.reasons.some((r: string) => /Pack size differs \(listing 300ml vs product 200ml\)/.test(r)));
    assert.equal(best.status, 'pending');
    assert.equal(best.pack_label, '300ml');
  });

  it('gives an exact barcode match the top score regardless of the title', async () => {
    const id = await listing({ url: 'https://match.example/p/2', title: 'Hair oil green bottle', gtin: '06291069700015' });
    const row = find(await queue(), id);
    assert.equal(row.suggestions[0].product_id, amla200);
    assert.equal(row.suggestions[0].score, 1);
    assert.match(row.suggestions[0].reasons[0], /Barcode \(GTIN 6291069700015\) matches exactly/);
  });

  it('flags titles without a pack size and ignores unrelated listings', async () => {
    const noSize = await listing({ url: 'https://match.example/p/3', title: 'Dabur Amla Hair Oil' });
    const unrelated = await listing({ url: 'https://match.example/p/4', title: 'Organic Quinoa 1kg' });
    const fromUrl = await listing({ url: 'https://match.example/dabur-amla-hair-oil-200ml/p/998' });
    const body = await queue();
    const row = find(body, noSize);
    assert.equal(row.suggestions.length, 2);
    for (const s of row.suggestions) {
      assert.ok(s.score <= 0.8);
      assert.ok(s.reasons.some((r: string) => /No pack size found/.test(r)));
    }
    assert.deepEqual(find(body, unrelated).suggestions, []);
    assert.equal(find(body, fromUrl).suggestions[0].product_id, amla200); // falls back to the URL slug
    assert.ok(body.counts.unmatched >= 5);
    assert.ok(body.counts.pending_suggestions >= 5);
  });

  it('approving a suggestion maps the listing and closes the other suggestions', async () => {
    const id = await listing({ url: 'https://match.example/p/5', title: 'Dabur Amla Hair Oil 200ml Bottle' });
    const row = find(await queue(), id);
    const [best, other] = row.suggestions;
    assert.equal(best.product_id, amla200);
    assert.equal((await t.api('POST', `/matching/suggestions/${best.id}/approve`, { as: 'viewer' })).status, 403);
    const approved = await t.api('POST', `/matching/suggestions/${best.id}/approve`, { as: 'analyst' });
    assert.equal(approved.status, 200, approved.raw);
    assert.equal(approved.body.listing.match_status, 'matched');
    assert.equal(approved.body.listing.product_id, amla200);
    const statuses = t.ctx.db.all<{ id: number; status: string; decided_by: number | null }>('SELECT id, status, decided_by FROM listing_match_suggestions WHERE listing_id = ?', [id]);
    assert.equal(statuses.find((s) => s.id === best.id)!.status, 'approved');
    assert.equal(statuses.find((s) => s.id === other.id)!.status, 'rejected');
    assert.ok(statuses.every((s) => s.decided_by !== null));
    assert.equal((await t.api('POST', `/matching/suggestions/${best.id}/approve`)).status, 409);
    assert.equal((await t.api('POST', `/matching/suggestions/${other.id}/approve`)).status, 409);
    assert.equal(find(await queue(), id), undefined); // left the review queue
    const log = t.ctx.db.get<{ detail: string }>(`SELECT detail FROM audit_log WHERE action = 'listing.matched' AND entity_id = ?`, [String(id)])!;
    assert.equal(JSON.parse(log.detail).via, 'suggestion');
  });

  it('a rejected suggestion never comes back', async () => {
    const id = await listing({ url: 'https://match.example/p/6', title: 'Dabur Amla Hair Oil 200 ml' });
    const row = find(await queue(), id);
    const target = row.suggestions.find((s: any) => s.product_id === amla200);
    const rejected = await t.api('POST', `/matching/suggestions/${target.id}/reject`, { as: 'analyst' });
    assert.equal(rejected.status, 200);
    assert.ok(!rejected.body.listing.suggestions.some((s: any) => s.product_id === amla200));
    const refreshed = await t.api('POST', '/matching/refresh', { body: { listing_ids: [id] } });
    assert.equal(refreshed.status, 200);
    const again = find(await queue(), id);
    assert.ok(!again.suggestions.some((s: any) => s.product_id === amla200));
    assert.equal(again.match_status, 'unmatched');
    assert.equal(scalar(`SELECT COUNT(*) FROM listing_match_suggestions WHERE listing_id = ? AND product_id = ? AND status = 'rejected'`, [id, amla200]), 1);
    assert.equal((await t.api('POST', '/matching/refresh', { as: 'viewer' })).status, 403);
  });

  it('supports manual matching, un-matching and ignoring', async () => {
    const id = await listing({ url: 'https://match.example/p/7', title: 'Amla oil big' });
    const matched = await t.api('POST', `/matching/listings/${id}/match`, { as: 'analyst', body: { product_id: amla300 } });
    assert.equal(matched.status, 200, matched.raw);
    assert.equal(matched.body.listing.product_id, amla300);
    assert.equal((await t.api('POST', `/matching/listings/${id}/ignore`)).status, 409); // matched listings are not ignorable
    const unmatched = await t.api('POST', `/matching/listings/${id}/unmatch`);
    assert.equal(unmatched.body.listing.match_status, 'unmatched');
    assert.equal(unmatched.body.listing.product_id, null);
    assert.ok(!unmatched.body.listing.suggestions.some((s: any) => s.product_id === amla300), 'the product just un-matched is not suggested again');
    const ignored = await t.api('POST', `/matching/listings/${id}/ignore`);
    assert.equal(ignored.body.listing.match_status, 'ignored');
    assert.equal(find(await queue(), id), undefined);
    assert.ok(find(await queue('&status=ignored'), id));
    const back = await t.api('POST', `/matching/listings/${id}/unmatch`); // back into the review queue
    assert.equal(back.body.listing.match_status, 'unmatched');
    assert.equal((await t.api('POST', `/matching/listings/${id}/match`, { body: { product_id: 999_999 } })).status, 422);
    assert.equal((await t.api('POST', '/matching/listings/999999/match', { body: { product_id: amla300 } })).status, 404);
    assert.ok(auditCount('listing.unmatched', id) >= 1);
    assert.equal(auditCount('listing.ignored', id), 1);
  });

  it('refreshListingSuggestions only touches unmatched listings and reports pending suggestions', () => {
    const before = scalar(`SELECT COUNT(*) FROM listing_match_suggestions WHERE status <> 'pending'`);
    const pending = refreshListingSuggestions(t.ctx);
    assert.ok(pending > 0);
    assert.equal(scalar(`SELECT COUNT(*) FROM listing_match_suggestions WHERE status <> 'pending'`), before, 'decisions are preserved');
    assert.equal(
      scalar(`SELECT COUNT(*) FROM listing_match_suggestions s JOIN retailer_listings l ON l.id = s.listing_id WHERE s.status = 'pending' AND l.match_status <> 'unmatched'`),
      0,
    );
    assert.equal(refreshListingSuggestions(t.ctx, []), 0);
  });

  it('recognises multi-packs and maps them through a pack variant', async () => {
    const id = await listing({ url: 'https://match.example/p/8', title: 'Dabur Amla Hair Oil 2 x 300ml Twin Pack' });
    let row = find(await queue(), id);
    assert.equal(row.suggestions[0].product_id, amla300);
    assert.ok(row.suggestions[0].score <= 0.7, `a multi-pack is not the base pack, got ${row.suggestions[0].score}`);
    assert.ok(row.suggestions[0].reasons.some((r: string) => /multi-pack \(2 × 300ml\) of this product's 300ml pack/.test(r)));
    // once the product has a matching pack variant, the suggestion says so and approving selects that variant
    const variant = await t.api('POST', `/products/${amla300}/variants`, { body: { name: 'Twin pack', pack_size: 300, pack_unit: 'ml', units_per_pack: 2 } });
    assert.equal(variant.status, 201, variant.raw);
    await t.api('POST', '/matching/refresh', { body: { listing_ids: [id] } });
    row = find(await queue(), id);
    const best = row.suggestions[0];
    assert.equal(best.product_id, amla300);
    assert.ok(best.score > 0.9, `expected a strong match through the variant, got ${best.score}`);
    assert.ok(best.reasons.some((r: string) => /pack variant "Twin pack" \(2 × 300ml\)/.test(r)));
    const approved = await t.api('POST', `/matching/suggestions/${best.id}/approve`);
    assert.equal(approved.status, 200, approved.raw);
    assert.equal(approved.body.listing.variant_id, variant.body.id);
    assert.equal(approved.body.listing.content_amount, 600);
    assert.equal(approved.body.listing.pack_label, '2 × 300ml');
  });

  it('copes with retailer spelling: compounds, brand placement and other brands', async () => {
    const colgate = await brand('Colgate Probe', 'competitor');
    const paste = await product({ brand_id: colgate, name: 'Colgate Probe Herbal Toothpaste 125ml', category_id: fx.categoryId, pack_size: 125, pack_unit: 'ml' });
    const spaced = await listing({ url: 'https://match.example/p/9', title: 'Colgate Probe Herbal Tooth Paste 125 ml' });
    const otherBrand = await listing({ url: 'https://match.example/p/10', title: 'Sensodyne Herbal Toothpaste 125ml' });
    const body = await queue();
    const best = find(body, spaced).suggestions[0];
    assert.equal(best.product_id, paste);
    assert.ok(best.score > 0.9, `"tooth paste" should match "toothpaste", got ${best.score}`);
    // a product of another brand is never a confident match, whatever the name and size overlap
    for (const s of find(body, otherBrand).suggestions) {
      assert.ok(s.score <= 0.45, `cross-brand suggestion scored ${s.score}`);
      assert.ok(s.reasons.some((r: string) => /not found in the listing/.test(r)));
    }
  });
});

describe('competitor equivalence mappings', () => {
  let cat: number;
  let sub: number;
  let otherCat: number;
  let ownBrand: number;
  let rivalBrand: number;
  let own200: number;
  let rival200: number;
  let rival210: number;
  let rival300: number;
  let rivalGrams: number;
  let rivalOtherCategory: number;

  before(async () => {
    cat = await category('Mapping Hair Oil');
    sub = await category('Coconut Oil', cat);
    otherCat = await category('Mapping Toothpaste');
    ownBrand = await brand('Map Own', 'own');
    rivalBrand = await brand('Map Rival', 'competitor');
    const base = { category_id: cat, subcategory_id: sub };
    own200 = await product({ ...base, brand_id: ownBrand, name: 'Own Coconut 200ml', pack_size: 200, pack_unit: 'ml' });
    rival200 = await product({ ...base, brand_id: rivalBrand, name: 'Rival Coconut 200ml', pack_size: 200, pack_unit: 'ml' });
    rival210 = await product({ ...base, brand_id: rivalBrand, name: 'Rival Coconut 210ml', pack_size: 210, pack_unit: 'ml' });
    rival300 = await product({ ...base, brand_id: rivalBrand, name: 'Rival Coconut 300ml', pack_size: 300, pack_unit: 'ml' });
    rivalGrams = await product({ ...base, brand_id: rivalBrand, name: 'Rival Coconut Balm 150g', pack_size: 150, pack_unit: 'g' });
    rivalOtherCategory = await product({ brand_id: rivalBrand, name: 'Rival Toothpaste 100ml', category_id: otherCat, pack_size: 100, pack_unit: 'ml' });
  });

  it('describes how two packs can be compared', () => {
    const ml = (size: number, units = 1) => ({ pack_size: size, pack_unit: 'ml', units_per_pack: units });
    const same = comparability(ml(200), ml(100, 2));
    assert.equal(same.same_size, true);
    assert.equal(same.unit_basis, 'per 100ml');
    const near = comparability(ml(200), ml(230));
    assert.equal(near.within_tolerance, true);
    assert.equal(near.same_size, false);
    const far = comparability(ml(200), ml(300));
    assert.equal(far.within_tolerance, false);
    assert.equal(far.size_ratio, 1.5);
    assert.match(far.note, /Size differs 200ml vs 300ml/);
    const mixed = comparability(ml(200), { pack_size: 150, pack_unit: 'g', units_per_pack: 1 });
    assert.equal(mixed.same_dimension, false);
    assert.equal(mixed.unit_basis, null);
    assert.match(mixed.note, /Units differ: ml vs g .* unit prices cannot be compared/);
    assert.equal(comparability(ml(200), { pack_size: null, pack_unit: null, units_per_pack: 1 }).same_dimension, null);
  });

  it('suggests equivalents only for like-for-like packs and labels the rest as non-equivalent', async () => {
    assert.equal((await t.api('POST', '/mappings/suggest', { as: 'viewer', body: { own_product_id: own200 } })).status, 403);
    const res = await t.api('POST', '/mappings/suggest', { as: 'analyst', body: { own_product_id: own200 } });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.created, 4);
    assert.equal(res.body.own_products_considered, 1);
    const by = (id: number) => res.body.suggestions.find((s: any) => s.competitor.product_id === id);
    assert.equal(by(rivalOtherCategory), undefined, 'other categories are never suggested');
    for (const s of res.body.suggestions) {
      assert.equal(s.status, 'suggested');
      assert.equal(s.market_id, null);
      assert.equal(s.decided_by, null);
    }
    assert.equal(by(rival200).equivalence, 'equivalent');
    assert.match(by(rival200).rationale, /Same subcategory \(Mapping Hair Oil › Coconut Oil\); same pack size \(200ml\)/);
    assert.equal(by(rival210).equivalence, 'equivalent');
    assert.match(by(rival210).rationale, /within 15% \(200ml vs 210ml\)/);
    assert.equal(by(rival300).equivalence, 'comparable');
    assert.match(by(rival300).rationale, /size differs 200ml vs 300ml/);
    assert.equal(by(rival300).comparability.size_ratio, 1.5);
    assert.equal(by(rivalGrams).equivalence, 'comparable');
    assert.match(by(rivalGrams).rationale, /units differ: ml vs g — unit prices cannot be compared/);
    assert.equal(by(rivalGrams).comparability.unit_basis, null);
    assert.ok(by(rival200).score > by(rival300).score);
    assert.ok(by(rival300).score > by(rivalGrams).score);
    // running it again proposes nothing new
    const again = await t.api('POST', '/mappings/suggest', { body: { own_product_id: own200 } });
    assert.equal(again.body.created, 0);
    assert.equal((await t.api('POST', '/mappings/suggest', { body: { own_product_id: rival200 } })).status, 422);
  });

  it('approves, rejects and re-scopes suggestions', async () => {
    const list = await t.api('GET', `/mappings?own_product_id=${own200}&status=suggested`);
    assert.equal(list.body.total, 4);
    assert.deepEqual(list.body.counts, { suggested: 4, approved: 0, rejected: 0 });
    const id = (competitor: number) => list.body.rows.find((m: any) => m.competitor.product_id === competitor).id;

    const approved = await t.api('POST', `/mappings/${id(rival200)}/approve`, { as: 'analyst' });
    assert.equal(approved.status, 200, approved.raw);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.decided_by_name, 'Test analyst');
    assert.ok(approved.body.decided_at);

    // a reviewer may downgrade an "equivalent" suggestion while approving it
    const downgraded = await t.api('POST', `/mappings/${id(rival210)}/approve`, { body: { equivalence: 'comparable' } });
    assert.equal(downgraded.body.equivalence, 'comparable');

    // …but can never upgrade packs in different units to "equivalent"
    const impossible = await t.api('POST', `/mappings/${id(rivalGrams)}/approve`, { body: { equivalence: 'equivalent' } });
    assert.equal(impossible.status, 422);
    assert.match(impossible.body.error.message, /cannot be marked equivalent/);
    assert.equal((await t.api('PATCH', `/mappings/${id(rivalGrams)}`, { body: { equivalence: 'equivalent' } })).status, 422);

    const rejected = await t.api('POST', `/mappings/${id(rival300)}/reject`);
    assert.equal(rejected.body.status, 'rejected');
    assert.equal((await t.api('POST', `/mappings/${id(rival300)}/reject`, { as: 'viewer' })).status, 403);

    const scoped = await t.api('PATCH', `/mappings/${id(rival200)}`, { body: { market_id: marketId('AE'), rationale: 'UAE range only' } });
    assert.equal(scoped.body.market_name, 'UAE');
    assert.equal(scoped.body.rationale, 'UAE range only');
    assert.equal(scoped.body.status, 'approved');

    const counts = (await t.api('GET', `/mappings?own_product_id=${own200}`)).body.counts;
    assert.deepEqual(counts, { suggested: 1, approved: 2, rejected: 1 });
    // market filter includes mappings that apply everywhere
    assert.equal((await t.api('GET', `/mappings?own_product_id=${own200}&market_id=${marketId('KE')}&status=approved`)).body.total, 1);
    assert.equal((await t.api('GET', `/mappings?own_product_id=${own200}&market_id=${marketId('AE')}&status=approved`)).body.total, 2);
    assert.equal((await t.api('GET', `/mappings?own_product_id=${own200}&market_id=${marketId('AE')}&exact_market=true`)).body.total, 1);
    assert.equal((await t.api('GET', `/mappings?product_id=${rival300}`)).body.total, 1);
    assert.equal(auditCount('mapping.approved', id(rival200)), 1);
    assert.equal(auditCount('mapping.rejected', id(rival300)), 1);
  });

  it('validates manual mappings', async () => {
    const post = (body: Record<string, unknown>, as: 'admin' | 'viewer' = 'admin') => t.api('POST', '/mappings', { as, body });
    assert.equal((await post({ own_product_id: own200, competitor_product_id: rivalOtherCategory }, 'viewer')).status, 403);
    const swapped = await post({ own_product_id: rival200, competitor_product_id: own200 });
    assert.equal(swapped.status, 422);
    assert.match(swapped.body.error.message, /must be one of your own/);
    assert.equal((await post({ own_product_id: own200, competitor_product_id: own200 })).status, 422);
    const ownOther = await product({ brand_id: ownBrand, name: 'Own Coconut 400ml', category_id: cat, pack_size: 400, pack_unit: 'ml' });
    assert.equal((await post({ own_product_id: own200, competitor_product_id: ownOther })).status, 422); // both own
    assert.equal((await post({ own_product_id: own200, competitor_product_id: 999_999 })).status, 422);
    assert.equal((await post({ own_product_id: own200, competitor_product_id: rivalOtherCategory, market_id: 999_999 })).status, 422);

    // equivalence defaults from the packs: 400ml vs 300ml → comparable; explicit "equivalent" across units is refused
    const created = await post({ own_product_id: ownOther, competitor_product_id: rival300 });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.status, 'approved');
    assert.equal(created.body.equivalence, 'comparable');
    assert.equal(created.body.decided_by_name, 'Test admin');
    assert.equal(created.body.is_demo, 0);
    assert.equal((await post({ own_product_id: ownOther, competitor_product_id: rivalGrams, equivalence: 'equivalent' })).status, 422);
    const like = await post({ own_product_id: ownOther, competitor_product_id: rivalGrams, equivalence: 'comparable' });
    assert.equal(like.status, 201);
    assert.match(like.body.comparability.note, /Units differ/);

    // duplicates: same pair + same scope is refused, another market scope is allowed
    assert.equal((await post({ own_product_id: ownOther, competitor_product_id: rival300 })).status, 409);
    const scoped = await post({ own_product_id: ownOther, competitor_product_id: rival300, market_id: marketId('KE'), equivalence: 'comparable' });
    assert.equal(scoped.status, 201);
    assert.equal((await t.api('PATCH', `/mappings/${scoped.body.id}`, { body: { market_id: null } })).status, 409); // would collide with the global mapping

    // a pending suggestion for the pair is turned into the approved mapping instead of duplicating it
    const pending = (await t.api('GET', `/mappings?own_product_id=${own200}&status=suggested`)).body.rows[0];
    const promoted = await post({ own_product_id: own200, competitor_product_id: pending.competitor.product_id, equivalence: 'comparable' });
    assert.equal(promoted.status, 201);
    assert.equal(promoted.body.id, pending.id);
    assert.equal(promoted.body.status, 'approved');

    assert.equal((await t.api('DELETE', `/mappings/${scoped.body.id}`)).status, 200);
    assert.equal((await t.api('GET', `/mappings/${scoped.body.id}`)).status, 404);
    assert.equal(auditCount('mapping.created', created.body.id), 1);
    assert.equal(auditCount('mapping.deleted', scoped.body.id), 1);
  });

  it('keeps ownership consistent with existing mappings', async () => {
    const moved = await t.api('PATCH', `/products/${own200}`, { body: { brand_id: rivalBrand } });
    assert.equal(moved.status, 409);
    assert.match(moved.body.error.message, /competitor mappings/);
    assert.equal((await t.api('PATCH', `/brands/${ownBrand}`, { body: { ownership: 'competitor' } })).status, 409);
  });
});

describe('demo catalogue rows that real data starts to depend on', () => {
  it('stop being demo rows (so removing the demo dataset never breaks or removes real data)', async () => {
    const demoBrand = await brand('Demo Brand', 'own');
    const demoTop = await category('Demo Category');
    const demoSub = await category('Demo Subcategory', demoTop);
    const demoProduct = await product({ brand_id: demoBrand, name: 'Demo Product 100ml', category_id: demoTop, subcategory_id: demoSub, pack_size: 100, pack_unit: 'ml' });
    const otherDemoBrand = await brand('Demo Brand Two', 'own');
    t.ctx.db.run('UPDATE brands SET is_demo = 1 WHERE id IN (?, ?)', [demoBrand, otherDemoBrand]);
    t.ctx.db.run('UPDATE categories SET is_demo = 1 WHERE id IN (?, ?)', [demoTop, demoSub]);
    t.ctx.db.run('UPDATE products SET is_demo = 1 WHERE id = ?', [demoProduct]);
    const flags = () => ({
      product: scalar('SELECT is_demo FROM products WHERE id = ?', [demoProduct]),
      brand: scalar('SELECT is_demo FROM brands WHERE id = ?', [demoBrand]),
      top: scalar('SELECT is_demo FROM categories WHERE id = ?', [demoTop]),
      sub: scalar('SELECT is_demo FROM categories WHERE id = ?', [demoSub]),
    });
    assert.deepEqual(flags(), { product: 1, brand: 1, top: 1, sub: 1 });

    // a demo listing (demo retailer) on a demo product changes nothing
    const demoRetailer = await retailer({ name: 'Demo Retailer', market_id: marketId('AE'), collection_method: 'manual' });
    t.ctx.db.run('UPDATE retailers SET is_demo = 1 WHERE id = ?', [demoRetailer]);
    const demoListing = await t.api('POST', '/listings', { body: { retailer_id: demoRetailer, url: 'https://demo.invalid/p/1', product_id: demoProduct } });
    assert.equal(demoListing.body.is_demo, 1);
    assert.deepEqual(flags(), { product: 1, brand: 1, top: 1, sub: 1 });

    // a real listing mapped to the demo product promotes the product and what it depends on
    const realListing = await t.api('POST', '/listings', { body: { retailer_id: fx.retailerId, url: 'https://testmart.example/p/real-on-demo', product_id: demoProduct } });
    assert.equal(realListing.status, 201, realListing.raw);
    assert.equal(realListing.body.is_demo, 0);
    assert.deepEqual(flags(), { product: 0, brand: 0, top: 0, sub: 0 });
    assert.equal(scalar('SELECT is_demo FROM retailer_listings WHERE id = ?', [demoListing.body.id]), 1, 'simulated listings stay demo');

    // a real product created under a demo brand promotes the brand
    await product({ brand_id: otherDemoBrand, name: 'Real Under Demo Brand', category_id: fx.categoryId });
    assert.equal(scalar('SELECT is_demo FROM brands WHERE id = ?', [otherDemoBrand]), 0);
  });
});
