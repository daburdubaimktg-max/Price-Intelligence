/**
 * Reference data: lists for filter controls plus management of brands, categories, markets and currencies.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { SqlParam } from '../db/sqlite.ts';
import { placeholders } from '../db/sqlite.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { flag, idParam, likePattern, optBool, optionalId, optionalNumber, optionalText, parse, requiredId } from '../lib/http.ts';
import { isValidTimeZone, nowIso } from '../lib/time.ts';
import { audit } from '../services/core.ts';
import { promoteCategoryToReal } from '../services/matching.ts';
import { AUTOMATED_METHODS, FREQUENCIES, OWNERSHIP } from '../../shared/constants.ts';
import type { BrandRef, BrandRow, CategoryRef, CategoryRow, CurrencyRef, MarketRef, MarketRow, ReferenceData, RetailerRef } from '../../shared/api/catalogue.ts';

// ---------------------------------------------------------------------------------------------
// Small helpers shared by the catalogue route modules (products, retailers, matching)
// ---------------------------------------------------------------------------------------------
/** Optional fields: absent stays absent (so PATCH can tell "not sent" from "cleared"), '' / null → null. */
export const optText = (max = 500) => optionalText(max).optional();
export const optNum = () => optionalNumber().optional();
export const optId = () => optionalId().optional();
export const optFlag = () => flag().optional();

/** UPDATE of exactly the provided columns. Column names come from code, never from the request. */
export function applyUpdate(ctx: AppContext, table: string, id: number, changes: Record<string, SqlParam>, touchUpdatedAt = true): number {
  const keys = Object.keys(changes).filter((k) => changes[k] !== undefined);
  if (keys.length === 0) return 0;
  const sets = keys.map((k) => `${k} = ?`);
  const params: SqlParam[] = keys.map((k) => changes[k]);
  if (touchUpdatedAt) {
    sets.push('updated_at = ?');
    params.push(nowIso());
  }
  return ctx.db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, [...params, id]).changes;
}

/** Before/after of the fields that actually changed, for the audit trail. */
export function changedFields(before: Record<string, unknown>, changes: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    const previous = before[key];
    const same = typeof value === 'boolean' ? (previous === 1) === value : previous === value;
    if (!same) out[key] = { from: previous ?? null, to: value };
  }
  return out;
}

/** Accepts only absolute http(s) URLs (no javascript:, data:, file: …). */
export function httpUrl(value: string | null | undefined, what: string, maxLength = 2000): string | null {
  if (value === null || value === undefined || value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unprocessable(`${what} must be a full URL starting with http:// or https://`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw unprocessable(`${what} must start with http:// or https://`);
  if (value.length > maxLength) throw unprocessable(`${what} is too long`);
  return value;
}

// ---------------------------------------------------------------------------------------------

const brandFields = {
  name: z.string().trim().min(1).max(120),
  ownership: z.enum(OWNERSHIP),
  manufacturer: optText(200),
  is_active: optFlag(),
};

const categoryFields = {
  name: z.string().trim().min(1).max(120),
  parent_id: optId(),
};

const marketFields = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,12}$/, 'use 2–12 letters, digits, "-" or "_"'),
  name: z.string().trim().min(1).max(120),
  country_code: optText(8),
  country_name: optText(120),
  region: optText(80),
  currency_code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'use a 3-letter currency code'),
  timezone: z.string().trim().min(1).max(64),
  default_frequency: z.enum(FREQUENCIES).optional(),
  is_active: optFlag(),
  sort_order: optNum(),
  notes: optText(1000),
};

export default async function referenceRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  // ---- reference lists -------------------------------------------------------------------------
  app.get('/reference', async (): Promise<ReferenceData> => {
    return {
      markets: db.all<MarketRef>(
        `SELECT id, code, name, country_code, country_name, region, currency_code, timezone, default_frequency, is_active, sort_order
         FROM markets ORDER BY sort_order, name`,
      ),
      retailers: db.all<RetailerRef>(
        `SELECT id, name, market_id, currency_code, collection_method, is_active, is_demo FROM retailers ORDER BY name COLLATE NOCASE`,
      ),
      brands: db.all<BrandRef>(`SELECT id, name, ownership, is_active, is_demo FROM brands ORDER BY ownership DESC, name`),
      categories: db.all<CategoryRef>(`SELECT id, name, parent_id FROM categories ORDER BY name`),
      currencies: db.all<CurrencyRef>(`SELECT code, name, symbol, decimals FROM currencies ORDER BY code`),
    };
  });

  // ---- brands ----------------------------------------------------------------------------------
  function brandRows(where: string[] = [], params: SqlParam[] = []): BrandRow[] {
    const rows = db.all<Omit<BrandRow, 'competitor_brand_ids' | 'benchmarked_by_brand_ids'>>(
      `SELECT b.id, b.name, b.ownership, b.manufacturer, b.is_active, b.is_demo, b.created_at, b.updated_at,
         (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS product_count
       FROM brands b ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY b.ownership DESC, b.name`,
      params,
    );
    const links = db.all<{ own_brand_id: number; competitor_brand_id: number }>('SELECT own_brand_id, competitor_brand_id FROM brand_competitors');
    return rows.map((row) => ({
      ...row,
      competitor_brand_ids: links.filter((l) => l.own_brand_id === row.id).map((l) => l.competitor_brand_id),
      benchmarked_by_brand_ids: links.filter((l) => l.competitor_brand_id === row.id).map((l) => l.own_brand_id),
    }));
  }
  const brandRow = (id: number): BrandRow => {
    const row = brandRows(['b.id = ?'], [id])[0];
    if (!row) throw notFound('Brand');
    return row;
  };

  app.get('/brands', async (req) => {
    const query = req.query as Record<string, unknown>;
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (query.ownership === 'own' || query.ownership === 'competitor') {
      where.push('b.ownership = ?');
      params.push(query.ownership);
    }
    if (typeof query.q === 'string' && query.q.trim()) {
      where.push(`(b.name LIKE ? ESCAPE '\\' OR b.manufacturer LIKE ? ESCAPE '\\')`);
      params.push(likePattern(query.q.trim()), likePattern(query.q.trim()));
    }
    const active = optBool(query.active);
    if (active !== undefined) {
      where.push('b.is_active = ?');
      params.push(active);
    }
    return { rows: brandRows(where, params) };
  });

  app.post('/brands', { config: { permission: 'catalogue.write' } }, async (req, reply) => {
    const body = parse(z.object(brandFields), req.body);
    if (db.get('SELECT id FROM brands WHERE name = ?', [body.name])) throw conflict(`A brand named "${body.name}" already exists`);
    const now = nowIso();
    const id = db.run(
      'INSERT INTO brands (name, ownership, manufacturer, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [body.name, body.ownership, body.manufacturer ?? null, body.is_active ?? true, now, now],
    ).lastInsertRowid;
    audit(ctx, req.user, 'brand.created', 'brand', id, { name: body.name, ownership: body.ownership }, req.ip);
    return reply.code(201).send(brandRow(id));
  });

  app.patch('/brands/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = db.get<Record<string, unknown>>('SELECT * FROM brands WHERE id = ?', [id]);
    if (!before) throw notFound('Brand');
    const body = parse(z.object(brandFields).partial(), req.body);
    if (body.name !== undefined && db.get('SELECT id FROM brands WHERE name = ? AND id <> ?', [body.name, id])) {
      throw conflict(`A brand named "${body.name}" already exists`);
    }
    if (body.ownership !== undefined && body.ownership !== before.ownership) {
      const linked =
        (db.scalar<number>(
          `SELECT COUNT(*) FROM competitor_mappings m JOIN products p ON p.id IN (m.own_product_id, m.competitor_product_id) WHERE p.brand_id = ?`,
          [id],
        ) ?? 0) + (db.scalar<number>('SELECT COUNT(*) FROM brand_competitors WHERE own_brand_id = ? OR competitor_brand_id = ?', [id, id]) ?? 0);
      if (linked > 0) {
        throw conflict('This brand is used in competitor mappings or brand associations. Remove those before changing whether it is an own or a competitor brand.');
      }
    }
    const changes = { name: body.name, ownership: body.ownership, manufacturer: body.manufacturer, is_active: body.is_active };
    const diff = changedFields(before, changes);
    if (Object.keys(diff).length) {
      applyUpdate(ctx, 'brands', id, changes);
      audit(ctx, req.user, 'brand.updated', 'brand', id, diff, req.ip);
    }
    return brandRow(id);
  });

  app.delete('/brands/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const brand = db.get<{ name: string }>('SELECT name FROM brands WHERE id = ?', [id]);
    if (!brand) throw notFound('Brand');
    const products = db.scalar<number>('SELECT COUNT(*) FROM products WHERE brand_id = ?', [id]) ?? 0;
    if (products > 0) {
      throw conflict(`"${brand.name}" has ${products} product${products === 1 ? '' : 's'} and cannot be deleted. Deactivate it instead.`);
    }
    db.run('DELETE FROM brands WHERE id = ?', [id]);
    audit(ctx, req.user, 'brand.deleted', 'brand', id, { name: brand.name }, req.ip);
    return { ok: true };
  });

  app.put('/brands/:id/competitors', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const brand = db.get<{ ownership: string }>('SELECT ownership FROM brands WHERE id = ?', [id]);
    if (!brand) throw notFound('Brand');
    if (brand.ownership !== 'own') throw unprocessable('Competitor brands can only be associated with an own brand');
    const body = parse(z.object({ competitor_brand_ids: z.array(requiredId()).max(200) }), req.body);
    const ids = [...new Set(body.competitor_brand_ids)];
    if (ids.length) {
      const valid = db.all<{ id: number }>(`SELECT id FROM brands WHERE ownership = 'competitor' AND id IN (${placeholders(ids.length)})`, ids);
      if (valid.length !== ids.length) throw unprocessable('Every associated brand must be an existing competitor brand');
    }
    db.tx(() => {
      db.run('DELETE FROM brand_competitors WHERE own_brand_id = ?', [id]);
      for (const competitorId of ids) {
        db.run('INSERT INTO brand_competitors (own_brand_id, competitor_brand_id) VALUES (?, ?)', [id, competitorId]);
      }
      audit(ctx, req.user, 'brand.competitors_set', 'brand', id, { competitor_brand_ids: ids }, req.ip);
    });
    return brandRow(id);
  });

  // ---- categories (two levels: category → subcategory) ------------------------------------------
  function categoryRows(where: string[] = [], params: SqlParam[] = []): CategoryRow[] {
    return db.all<CategoryRow>(
      `SELECT c.id, c.name, c.parent_id, pc.name AS parent_name, c.is_demo, c.created_at,
         (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id OR p.subcategory_id = c.id) AS product_count,
         (SELECT COUNT(*) FROM categories ch WHERE ch.parent_id = c.id) AS child_count
       FROM categories c LEFT JOIN categories pc ON pc.id = c.parent_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY COALESCE(pc.name, c.name), c.parent_id IS NOT NULL, c.name`,
      params,
    );
  }
  const categoryRow = (id: number): CategoryRow => {
    const row = categoryRows(['c.id = ?'], [id])[0];
    if (!row) throw notFound('Category');
    return row;
  };
  function assertParent(parentId: number | null | undefined, selfId?: number): void {
    if (!parentId) return;
    if (parentId === selfId) throw unprocessable('A category cannot be its own parent');
    const parent = db.get<{ parent_id: number | null }>('SELECT parent_id FROM categories WHERE id = ?', [parentId]);
    if (!parent) throw unprocessable('The parent category does not exist');
    if (parent.parent_id !== null) throw unprocessable('Subcategories cannot have their own subcategories (two levels only)');
  }
  function assertUniqueCategory(name: string, parentId: number | null, selfId?: number): void {
    const clash = db.get<{ id: number }>('SELECT id FROM categories WHERE COALESCE(parent_id, 0) = ? AND name = ? AND id <> ?', [parentId ?? 0, name, selfId ?? 0]);
    if (clash) throw conflict(parentId ? `This category already has a subcategory named "${name}"` : `A category named "${name}" already exists`);
  }

  app.get('/categories', async () => ({ rows: categoryRows() }));

  app.post('/categories', { config: { permission: 'catalogue.write' } }, async (req, reply) => {
    const body = parse(z.object(categoryFields), req.body);
    const parentId = body.parent_id ?? null;
    assertParent(parentId);
    assertUniqueCategory(body.name, parentId);
    const id = db.tx(() => {
      // A real subcategory keeps its (formerly demo) parent category alive.
      promoteCategoryToReal(ctx, parentId);
      return db.run('INSERT INTO categories (name, parent_id, created_at) VALUES (?, ?, ?)', [body.name, parentId, nowIso()]).lastInsertRowid;
    });
    audit(ctx, req.user, 'category.created', 'category', id, { name: body.name, parent_id: parentId }, req.ip);
    return reply.code(201).send(categoryRow(id));
  });

  app.patch('/categories/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = categoryRow(id);
    const body = parse(z.object(categoryFields).partial(), req.body);
    const name = body.name ?? before.name;
    const parentId = body.parent_id === undefined ? before.parent_id : body.parent_id;
    if (parentId !== before.parent_id) {
      if (before.product_count > 0 || before.child_count > 0) {
        throw conflict('A category that is used by products or has subcategories cannot be moved. It can still be renamed.');
      }
      assertParent(parentId, id);
    }
    if (name !== before.name || parentId !== before.parent_id) {
      assertUniqueCategory(name, parentId, id);
      db.tx(() => {
        if (!before.is_demo) promoteCategoryToReal(ctx, parentId);
        db.run('UPDATE categories SET name = ?, parent_id = ? WHERE id = ?', [name, parentId, id]);
      });
      audit(ctx, req.user, 'category.updated', 'category', id, changedFields({ ...before }, { name, parent_id: parentId }), req.ip);
    }
    return categoryRow(id);
  });

  app.delete('/categories/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const row = categoryRow(id);
    if (row.product_count > 0) {
      throw conflict(`"${row.name}" is used by ${row.product_count} product${row.product_count === 1 ? '' : 's'} and cannot be deleted`);
    }
    if (row.child_count > 0) throw conflict(`"${row.name}" has subcategories. Delete or move them first.`);
    db.run('DELETE FROM categories WHERE id = ?', [id]);
    audit(ctx, req.user, 'category.deleted', 'category', id, { name: row.name }, req.ip);
    return { ok: true };
  });

  // ---- markets ---------------------------------------------------------------------------------
  function marketRows(where: string[] = [], params: SqlParam[] = []): MarketRow[] {
    return db.all<MarketRow>(
      `SELECT m.id, m.code, m.name, m.country_code, m.country_name, m.region, m.currency_code, m.timezone, m.default_frequency,
         m.is_active, m.sort_order, m.notes, m.created_at, m.updated_at,
         (SELECT COUNT(*) FROM retailers r WHERE r.market_id = m.id) AS retailer_count,
         (SELECT COUNT(*) FROM retailers r WHERE r.market_id = m.id AND r.is_active = 1) AS active_retailer_count,
         (SELECT COUNT(*) FROM retailer_listings l JOIN retailers r ON r.id = l.retailer_id WHERE r.market_id = m.id) AS listing_count,
         (SELECT COUNT(*) FROM product_markets pm WHERE pm.market_id = m.id) AS product_count,
         (SELECT COUNT(DISTINCT l.product_id) FROM retailer_listings l JOIN retailers r ON r.id = l.retailer_id
            WHERE r.market_id = m.id AND l.product_id IS NOT NULL) AS listed_product_count
       FROM markets m ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY m.sort_order, m.name`,
      params,
    );
  }
  const marketRow = (id: number): MarketRow => {
    const row = marketRows(['m.id = ?'], [id])[0];
    if (!row) throw notFound('Market');
    return row;
  };
  const assertCurrency = (code: string) => {
    if (!db.get('SELECT code FROM currencies WHERE code = ?', [code])) {
      throw unprocessable(`Currency ${code} is not set up. Add it under currencies first.`);
    }
  };
  const assertTimeZone = (tz: string) => {
    if (!isValidTimeZone(tz)) throw unprocessable(`"${tz}" is not a valid IANA time zone (for example Asia/Dubai or Africa/Nairobi)`);
  };

  app.get('/markets', async (req) => {
    const active = optBool((req.query as Record<string, unknown>).active);
    return { rows: active === undefined ? marketRows() : marketRows(['m.is_active = ?'], [active]) };
  });

  app.get('/markets/:id', async (req) => marketRow(idParam((req.params as { id: string }).id)));

  app.post('/markets', { config: { permission: 'admin.settings' } }, async (req, reply) => {
    const body = parse(z.object(marketFields), req.body);
    assertCurrency(body.currency_code);
    assertTimeZone(body.timezone);
    if (db.get('SELECT id FROM markets WHERE code = ?', [body.code])) throw conflict(`A market with code ${body.code} already exists`);
    if (db.get('SELECT id FROM markets WHERE name = ? COLLATE NOCASE', [body.name])) throw conflict(`A market named "${body.name}" already exists`);
    const now = nowIso();
    const sortOrder = body.sort_order ?? (db.scalar<number>('SELECT COALESCE(MAX(sort_order), 0) + 10 FROM markets') ?? 10);
    const id = db.run(
      `INSERT INTO markets (code, name, country_code, country_name, region, currency_code, timezone, default_frequency, is_active, sort_order, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.code, body.name, (body.country_code ?? body.code).toUpperCase(), body.country_name ?? body.name, body.region ?? null,
        body.currency_code, body.timezone, body.default_frequency ?? 'daily', body.is_active ?? true, Math.round(sortOrder), body.notes ?? null, now, now,
      ],
    ).lastInsertRowid;
    audit(ctx, req.user, 'market.created', 'market', id, { code: body.code, name: body.name, currency_code: body.currency_code, timezone: body.timezone }, req.ip);
    return reply.code(201).send(marketRow(id));
  });

  app.patch('/markets/:id', { config: { permission: 'admin.settings' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = db.get<Record<string, unknown>>('SELECT * FROM markets WHERE id = ?', [id]);
    if (!before) throw notFound('Market');
    const body = parse(z.object(marketFields).partial(), req.body);
    if (body.code !== undefined && body.code !== before.code) throw unprocessable('The market code cannot be changed once the market exists');
    if (body.name !== undefined && db.get('SELECT id FROM markets WHERE name = ? COLLATE NOCASE AND id <> ?', [body.name, id])) {
      throw conflict(`A market named "${body.name}" already exists`);
    }
    if (body.timezone !== undefined) assertTimeZone(body.timezone);
    if (body.currency_code !== undefined && body.currency_code !== before.currency_code) {
      assertCurrency(body.currency_code);
      if ((db.scalar<number>('SELECT COUNT(*) FROM retailers WHERE market_id = ?', [id]) ?? 0) > 0) {
        throw conflict('The currency of a market cannot change once it has retailers. Create a new market for the new currency instead.');
      }
    }
    const changes = {
      name: body.name,
      country_code: body.country_code === undefined ? undefined : (body.country_code ?? String(before.code)).toUpperCase(),
      country_name: body.country_name === undefined ? undefined : (body.country_name ?? body.name ?? String(before.name)),
      region: body.region,
      currency_code: body.currency_code,
      timezone: body.timezone,
      default_frequency: body.default_frequency,
      is_active: body.is_active,
      sort_order: body.sort_order === undefined || body.sort_order === null ? undefined : Math.round(body.sort_order),
      notes: body.notes,
    };
    const diff = changedFields(before, changes);
    if (Object.keys(diff).length) {
      db.tx(() => {
        applyUpdate(ctx, 'markets', id, changes);
        if (diff.default_frequency) {
          // Retailers that inherit the market schedule follow the new default.
          const automated = AUTOMATED_METHODS.map((m) => `'${m}'`).join(', ');
          if (changes.default_frequency === 'manual') {
            db.run(
              `UPDATE retailers SET next_run_at = NULL WHERE market_id = ? AND collection_frequency IS NULL AND collection_method IN (${automated})`,
              [id],
            );
          } else {
            db.run(
              `UPDATE retailers SET next_run_at = ? WHERE market_id = ? AND collection_frequency IS NULL AND next_run_at IS NULL
                 AND is_enabled = 1 AND is_active = 1 AND collection_method IN (${automated})`,
              [nowIso(), id],
            );
          }
        }
        audit(ctx, req.user, 'market.updated', 'market', id, diff, req.ip);
      });
    }
    return marketRow(id);
  });

  app.delete('/markets/:id', { config: { permission: 'admin.settings' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const row = marketRow(id);
    if (row.retailer_count > 0) {
      throw conflict(`${row.name} has ${row.retailer_count} retailer${row.retailer_count === 1 ? '' : 's'} and cannot be deleted. Deactivate the market instead.`);
    }
    db.run('DELETE FROM markets WHERE id = ?', [id]);
    audit(ctx, req.user, 'market.deleted', 'market', id, { code: row.code, name: row.name }, req.ip);
    return { ok: true };
  });

  // ---- currencies ------------------------------------------------------------------------------
  app.get('/currencies', async () => ({
    rows: db.all<CurrencyRef>('SELECT code, name, symbol, decimals FROM currencies ORDER BY code'),
  }));

  app.post('/currencies', { config: { permission: 'admin.settings' } }, async (req, reply) => {
    const body = parse(
      z.object({
        code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'use the 3-letter ISO 4217 code'),
        name: z.string().trim().min(1).max(80),
        symbol: optText(8),
        decimals: z.number().int().min(0).max(4).optional(),
      }),
      req.body,
    );
    if (db.get('SELECT code FROM currencies WHERE code = ?', [body.code])) throw conflict(`Currency ${body.code} already exists`);
    db.run('INSERT INTO currencies (code, name, symbol, decimals) VALUES (?, ?, ?, ?)', [body.code, body.name, body.symbol ?? body.code, body.decimals ?? 2]);
    audit(ctx, req.user, 'currency.created', 'currency', body.code, { name: body.name }, req.ip);
    return reply.code(201).send(db.get<CurrencyRef>('SELECT code, name, symbol, decimals FROM currencies WHERE code = ?', [body.code]));
  });
}
