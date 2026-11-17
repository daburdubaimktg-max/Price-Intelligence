/** Shared test harness: an isolated app + database per test file, plus fixture builders. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import { createUser } from '../server/auth/auth.ts';
import { ensureReferenceData } from '../server/seed/reference.ts';
import { nowIso } from '../server/lib/time.ts';
import type { RoleKey } from '../shared/constants.ts';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  dataDir: string;
  /** Session tokens per role. */
  tokens: Record<RoleKey, string>;
  api: (method: string, url: string, options?: { body?: unknown; as?: RoleKey | null; headers?: Record<string, string> }) => Promise<{ status: number; body: any; raw: string; headers: Record<string, unknown> }>;
  close: () => Promise<void>;
}

export const TEST_PASSWORD = 'Test-Password-2026';

export async function createTestApp(): Promise<TestApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pios-test-'));
  process.env.LOG_LEVEL = 'silent';
  // rate limits are exercised on their own in security.test.ts; elsewhere they would only throttle the suite
  const { app, ctx } = await buildApp({ dataDir, schedulerEnabled: false, seedDemo: false, allowPrivateNetwork: true, logLevel: 'silent', rateLimits: false });
  ensureReferenceData(ctx);
  const tokens = {} as Record<RoleKey, string>;
  for (const role of ['admin', 'analyst', 'viewer'] as RoleKey[]) {
    await createUser(ctx, { email: `${role}@test.local`, name: `Test ${role}`, password: TEST_PASSWORD, role });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${role}@test.local`, password: TEST_PASSWORD } });
    tokens[role] = res.json().token;
  }
  const api: TestApp['api'] = async (method, url, options = {}) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const as = options.as === undefined ? 'admin' : options.as;
    if (as) headers.authorization = `Bearer ${tokens[as]}`;
    const res = await app.inject({
      method: method as 'GET',
      url: url.startsWith('/api') ? url : `/api${url}`,
      headers,
      payload: options.body as never,
    });
    let body: any = null;
    try {
      body = res.json();
    } catch {
      body = null;
    }
    return { status: res.statusCode, body, raw: res.body, headers: res.headers };
  };
  return {
    app,
    ctx,
    dataDir,
    tokens,
    api,
    close: async () => {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Fixture {
  marketId: number;
  retailerId: number;
  ownBrandId: number;
  compBrandId: number;
  categoryId: number;
  ownProductId: number;
  compProductId: number;
  ownListingId: number;
  compListingId: number;
}

/** A minimal real (non-demo) catalogue: one market, one retailer, an own and a competitor product, each listed. */
export function createFixture(ctx: AppContext, options: { retailerName?: string; marketCode?: string; method?: string } = {}): Fixture {
  const { db } = ctx;
  const now = nowIso();
  const market = db.get<{ id: number; currency_code: string }>('SELECT id, currency_code FROM markets WHERE code = ?', [options.marketCode ?? 'AE'])!;
  const brand = (name: string, ownership: string) =>
    db.get<{ id: number }>('SELECT id FROM brands WHERE name = ?', [name])?.id ??
    db.run('INSERT INTO brands (name, ownership, created_at, updated_at) VALUES (?, ?, ?, ?)', [name, ownership, now, now]).lastInsertRowid;
  const ownBrandId = brand('Test Own', 'own');
  const compBrandId = brand('Test Rival', 'competitor');
  const categoryId =
    db.get<{ id: number }>('SELECT id FROM categories WHERE name = ? AND parent_id IS NULL', ['Hair Oil'])?.id ??
    db.run('INSERT INTO categories (name, created_at) VALUES (?, ?)', ['Hair Oil', now]).lastInsertRowid;
  const product = (brandId: number, name: string, size: number) =>
    db.run(
      `INSERT INTO products (brand_id, name, category_id, pack_size, pack_unit, created_at, updated_at) VALUES (?, ?, ?, ?, 'ml', ?, ?)`,
      [brandId, name, categoryId, size, now, now],
    ).lastInsertRowid;
  const suffix = `${options.marketCode ?? 'AE'}-${options.retailerName ?? 'Test Mart'}`;
  const ownProductId = product(ownBrandId, `Own Oil 200ml ${suffix}`, 200);
  const compProductId = product(compBrandId, `Rival Oil 300ml ${suffix}`, 300);
  const retailerId = db.run(
    `INSERT INTO retailers (name, website, country_code, market_id, currency_code, collection_method, collection_frequency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'daily', ?, ?)`,
    [options.retailerName ?? 'Test Mart', 'https://testmart.example', options.marketCode ?? 'AE', market.id, market.currency_code, options.method ?? 'manual', now, now],
  ).lastInsertRowid;
  const listing = (productId: number, slug: string) =>
    db.run(
      `INSERT INTO retailer_listings (retailer_id, product_id, external_id, url, title, match_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'matched', ?, ?)`,
      [retailerId, productId, slug, `https://testmart.example/p/${slug}-${retailerId}`, slug, now, now],
    ).lastInsertRowid;
  const ownListingId = listing(ownProductId, 'own-oil-200');
  const compListingId = listing(compProductId, 'rival-oil-300');
  db.run(
    `INSERT INTO competitor_mappings (own_product_id, competitor_product_id, equivalence, status, created_at, updated_at)
     VALUES (?, ?, 'comparable', 'approved', ?, ?)`,
    [ownProductId, compProductId, now, now],
  );
  return { marketId: market.id, retailerId, ownBrandId, compBrandId, categoryId, ownProductId, compProductId, ownListingId, compListingId };
}

/** ISO timestamp `days` days (and `hours` hours) before now. */
export function ago(days: number, hours = 0): string {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString();
}

export interface KnownPrices {
  /** "Today" as analytics sees it (latest market-local date). */
  today: string;
  /** 08:00 UTC (midday in the Gulf) on the market-local date `k` days before today. Always in the past for k ≥ 1. */
  at: (k: number) => string;
  /** Local date `k` days before today. */
  date: (k: number) => string;
  /** Observation id of the promotional observation (own listing, T-2). */
  promoObservationId: number;
}

/**
 * A hand-computable price history for the fixture (currency AED), entered manually:
 *   own   200 ml:  T-10 20.00 · T-8 20.00 · T-6 22.00 · T-4 22.00 · T-2 17.60 on promotion (regular 22.00) · T-1 22.00
 *   rival 300 ml:  T-10 30.00 · T-6 27.00
 * Unit prices today: own 11.00 / 100 ml, rival 9.00 / 100 ml → own is 22.2 % above (index 122.2).
 */
export async function ingestKnownPrices(ctx: AppContext, fx: Fixture): Promise<KnownPrices> {
  const { ingestObservations } = await import('../server/services/ingestion.ts');
  const { marketToday } = await import('../server/services/analytics/common.ts');
  const { addDays } = await import('../server/lib/time.ts');
  const today = marketToday(ctx);
  const date = (k: number) => addDays(today, -k);
  const at = (k: number) => `${date(k)}T08:00:00.000Z`;
  const price = (listing_id: number, k: number, current: number, extra: Record<string, unknown> = {}) => ({
    listing_id,
    observed_at: at(k),
    current_price: current,
    regular_price: current,
    availability: 'in_stock' as const,
    ...extra,
  });
  const res = ingestObservations(
    ctx,
    [
      price(fx.ownListingId, 10, 20),
      price(fx.ownListingId, 8, 20),
      price(fx.ownListingId, 6, 22),
      price(fx.ownListingId, 4, 22),
      price(fx.ownListingId, 2, 17.6, { regular_price: 22, promo_price: 17.6, is_promo: true, promo_type: 'price_cut', promo_description: 'Save 20%' }),
      price(fx.ownListingId, 1, 22),
      price(fx.compListingId, 10, 30),
      price(fx.compListingId, 6, 27),
    ],
    { sourceMethod: 'manual', userId: 1 },
  );
  if (res.inserted !== 8) throw new Error(`fixture prices were not stored: ${JSON.stringify(res.rejected)}`);
  return { today, at, date, promoObservationId: res.idByIndex.get(4)! };
}
