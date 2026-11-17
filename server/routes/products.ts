/**
 * Product catalogue: the master list of canonical products (own and competitor), their pack variants
 * and the markets they are sold in.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SqlParam } from '../db/sqlite.ts';
import { placeholders } from '../db/sqlite.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { idList, idParam, likePattern, optBool, orderBy, paged, pagination, parse, requiredId } from '../lib/http.ts';
import { nowIso } from '../lib/time.ts';
import { audit } from '../services/core.ts';
import {
  fetchListings,
  fetchMappings,
  normaliseGtin,
  promoteBrandToReal,
  promoteCategoryToReal,
} from '../services/matching.ts';
import { PACK_UNITS } from '../../shared/constants.ts';
import { formatPack } from '../../shared/units.ts';
import type { BrandRef, ProductDetail, ProductOption, ProductRow, ProductSummary, ProductSummaryGroup, VariantRow } from '../../shared/api/catalogue.ts';
import { applyUpdate, changedFields, httpUrl, optFlag, optId, optNum, optText } from './reference.ts';

const packUnit = () =>
  z
    .union([z.enum(PACK_UNITS), z.literal(''), z.null()])
    .transform((v) => (v === '' ? null : v))
    .optional();

const productFields = {
  brand_id: requiredId(),
  name: z.string().trim().min(1).max(200),
  category_id: requiredId(),
  subcategory_id: optId(),
  product_line: optText(200),
  sku: optText(100),
  gtin: optText(40),
  pack_size: optNum(),
  pack_unit: packUnit(),
  units_per_pack: optNum(),
  image_url: optText(1000),
  description: optText(2000),
  status: z.enum(['active', 'inactive']).optional(),
  market_ids: z.array(requiredId()).max(500).optional(),
};

const variantFields = {
  name: z.string().trim().min(1).max(120),
  pack_size: z.union([z.number(), z.string().trim().min(1)]).transform((v, c) => {
    const n = typeof v === 'number' ? v : Number(v.replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) {
      c.addIssue({ code: 'custom', message: 'must be a number greater than zero' });
      return z.NEVER;
    }
    return n;
  }),
  pack_unit: z.enum(PACK_UNITS),
  units_per_pack: optNum(),
  gtin: optText(40),
  notes: optText(500),
  is_active: optFlag(),
};

const PRODUCT_FROM = `
  FROM products p
  JOIN brands b ON b.id = p.brand_id
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN categories sc ON sc.id = p.subcategory_id
  LEFT JOIN (
    SELECT l.product_id, COUNT(*) AS listing_count, SUM(l.is_active) AS active_listing_count,
      COUNT(DISTINCT l.retailer_id) AS retailer_count, COUNT(DISTINCT r.market_id) AS listed_market_count,
      MAX(s.last_observed_at) AS last_observed_at
    FROM retailer_listings l JOIN retailers r ON r.id = l.retailer_id LEFT JOIN listing_state s ON s.listing_id = l.id
    WHERE l.product_id IS NOT NULL GROUP BY l.product_id
  ) la ON la.product_id = p.id
  LEFT JOIN (SELECT product_id, COUNT(*) AS market_count FROM product_markets GROUP BY product_id) pm ON pm.product_id = p.id
  LEFT JOIN (SELECT product_id, COUNT(*) AS variant_count FROM product_variants GROUP BY product_id) pv ON pv.product_id = p.id`;

const PRODUCT_COLUMNS = `
  p.id, p.code, p.name, p.product_line, p.brand_id, b.name AS brand_name, b.ownership, p.category_id, c.name AS category_name,
  p.subcategory_id, sc.name AS subcategory_name, p.sku, p.gtin, p.pack_size, p.pack_unit, p.units_per_pack, p.image_url,
  p.description, p.status, p.is_demo, p.created_at, p.updated_at,
  COALESCE(la.listing_count, 0) AS listing_count, COALESCE(la.active_listing_count, 0) AS active_listing_count,
  COALESCE(la.retailer_count, 0) AS retailer_count, COALESCE(pm.market_count, 0) AS market_count,
  COALESCE(la.listed_market_count, 0) AS listed_market_count, COALESCE(pv.variant_count, 0) AS variant_count,
  la.last_observed_at`;

const SORTS: Record<string, string> = {
  name: 'p.name COLLATE NOCASE',
  code: 'p.code',
  brand: 'b.name',
  ownership: 'b.ownership',
  category: 'c.name',
  pack_size: 'p.pack_size',
  status: 'p.status',
  listing_count: 'listing_count',
  retailer_count: 'retailer_count',
  market_count: 'market_count',
  last_observed_at: 'la.last_observed_at',
  created_at: 'p.created_at',
  updated_at: 'p.updated_at',
};

function productFilters(query: Record<string, unknown>): { where: string[]; params: SqlParam[] } {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (typeof query.q === 'string' && query.q.trim()) {
    const p = likePattern(query.q.trim());
    where.push(
      `(p.name LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.gtin LIKE ? ESCAPE '\\' OR b.name LIKE ? ESCAPE '\\' OR p.product_line LIKE ? ESCAPE '\\')`,
    );
    params.push(p, p, p, p, p, p);
  }
  const brandIds = idList(query.brand_id);
  if (brandIds) {
    where.push(`p.brand_id IN (${placeholders(brandIds.length)})`);
    params.push(...brandIds);
  }
  const categoryIds = idList(query.category_id);
  if (categoryIds) {
    const ph = placeholders(categoryIds.length);
    where.push(`(p.category_id IN (${ph}) OR p.subcategory_id IN (${ph}))`);
    params.push(...categoryIds, ...categoryIds);
  }
  if (query.ownership === 'own' || query.ownership === 'competitor') {
    where.push('b.ownership = ?');
    params.push(query.ownership);
  }
  const marketIds = idList(query.market_id);
  if (marketIds) {
    where.push(`EXISTS (SELECT 1 FROM product_markets x WHERE x.product_id = p.id AND x.market_id IN (${placeholders(marketIds.length)}))`);
    params.push(...marketIds);
  }
  const status = typeof query.status === 'string' ? query.status : '';
  if (status === 'active' || status === 'inactive' || status === 'archived') {
    where.push('p.status = ?');
    params.push(status);
  } else if (status !== 'all') {
    where.push(`p.status <> 'archived'`);
  }
  const hasListings = optBool(query.has_listings);
  if (hasListings !== undefined) where.push(hasListings ? 'COALESCE(la.listing_count, 0) > 0' : 'COALESCE(la.listing_count, 0) = 0');
  const demo = optBool(query.demo);
  if (demo !== undefined) {
    where.push('p.is_demo = ?');
    params.push(demo);
  }
  return { where, params };
}

type RawProduct = Omit<ProductRow, 'pack_label'>;
const withPack = (row: RawProduct): ProductRow => ({ ...row, pack_label: formatPack(row.pack_size, row.pack_unit, row.units_per_pack) });

export default async function productRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  const productRow = (id: number): ProductRow => {
    const row = db.get<RawProduct>(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.id = ?`, [id]);
    if (!row) throw notFound('Product');
    return withPack(row);
  };

  function variantRows(productId: number): VariantRow[] {
    return db
      .all<Omit<VariantRow, 'pack_label'>>(
        `SELECT v.id, v.product_id, v.name, v.pack_size, v.pack_unit, v.units_per_pack, v.gtin, v.notes, v.is_active, v.created_at,
           (SELECT COUNT(*) FROM retailer_listings l WHERE l.variant_id = v.id) AS listing_count
         FROM product_variants v WHERE v.product_id = ? ORDER BY v.name`,
        [productId],
      )
      .map((v) => ({ ...v, pack_label: formatPack(v.pack_size, v.pack_unit, v.units_per_pack) }));
  }

  function productDetail(id: number): ProductDetail {
    const product = productRow(id);
    const markets = db.all<{ id: number; code: string; name: string }>(
      `SELECT m.id, m.code, m.name FROM product_markets pm JOIN markets m ON m.id = pm.market_id WHERE pm.product_id = ? ORDER BY m.sort_order, m.name`,
      [id],
    );
    const associated = db.all<BrandRef>(
      product.ownership === 'own'
        ? `SELECT b.id, b.name, b.ownership, b.is_active, b.is_demo FROM brand_competitors bc JOIN brands b ON b.id = bc.competitor_brand_id
           WHERE bc.own_brand_id = ? ORDER BY b.name`
        : `SELECT b.id, b.name, b.ownership, b.is_active, b.is_demo FROM brand_competitors bc JOIN brands b ON b.id = bc.own_brand_id
           WHERE bc.competitor_brand_id = ? ORDER BY b.name`,
      [product.brand_id],
    );
    return {
      product,
      variants: variantRows(id),
      market_ids: markets.map((m) => m.id),
      markets,
      listings: fetchListings(ctx, { where: ['li.product_id = ?'], params: [id], order: 'li.market_name, li.retailer_name, li.listing_id' }),
      mappings: {
        as_own: fetchMappings(ctx, { where: ['m.own_product_id = ?'], params: [id] }),
        as_competitor: fetchMappings(ctx, { where: ['m.competitor_product_id = ?'], params: [id] }),
      },
      associated_brands: associated,
    };
  }

  /** Cross-field rules. `data` is the complete product as it would be stored. */
  function validateProduct(
    data: {
      brand_id: number; category_id: number; subcategory_id: number | null; sku: string | null; gtin: string | null;
      pack_size: number | null; pack_unit: string | null; units_per_pack: number; image_url: string | null;
    },
    selfId?: number,
  ): { brand: { id: number; ownership: string; is_demo: number } } {
    const brand = db.get<{ id: number; ownership: string; is_demo: number }>('SELECT id, ownership, is_demo FROM brands WHERE id = ?', [data.brand_id]);
    if (!brand) throw unprocessable('The selected brand does not exist');
    const category = db.get<{ id: number; parent_id: number | null }>('SELECT id, parent_id FROM categories WHERE id = ?', [data.category_id]);
    if (!category) throw unprocessable('The selected category does not exist');
    if (category.parent_id !== null) throw unprocessable('Choose a top-level category (and optionally one of its subcategories)');
    if (data.subcategory_id) {
      const sub = db.get<{ parent_id: number | null }>('SELECT parent_id FROM categories WHERE id = ?', [data.subcategory_id]);
      if (!sub || sub.parent_id !== data.category_id) throw unprocessable('The subcategory does not belong to the selected category');
    }
    if ((data.pack_size === null) !== (data.pack_unit === null)) throw unprocessable('Pack size and pack unit must be provided together');
    if (data.pack_size !== null && !(data.pack_size > 0)) throw unprocessable('Pack size must be greater than zero');
    if (!Number.isInteger(data.units_per_pack) || data.units_per_pack < 1 || data.units_per_pack > 10_000) {
      throw unprocessable('Units per pack must be a whole number of at least 1');
    }
    if (data.gtin !== null && !/^\d{8,14}$/.test(data.gtin)) throw unprocessable('Barcode / GTIN must contain 8 to 14 digits');
    if (data.sku !== null) {
      const clash = db.get<{ code: string }>('SELECT code FROM products WHERE sku = ? AND id <> ?', [data.sku, selfId ?? 0]);
      if (clash) throw conflict(`SKU "${data.sku}" is already used by product ${clash.code}`);
    }
    if (data.gtin !== null) {
      const clash = db.get<{ code: string }>('SELECT code FROM products WHERE gtin = ? AND id <> ?', [data.gtin, selfId ?? 0]);
      if (clash) throw conflict(`Barcode ${data.gtin} is already used by product ${clash.code}`);
    }
    httpUrl(data.image_url, 'Product image URL', 1000);
    return { brand };
  }

  function assertMarkets(ids: number[]): void {
    if (ids.length === 0) return;
    const found = db.scalar<number>(`SELECT COUNT(*) FROM markets WHERE id IN (${placeholders(ids.length)})`, ids) ?? 0;
    if (found !== ids.length) throw unprocessable('One or more selected markets do not exist');
  }

  function setMarkets(productId: number, ids: number[]): void {
    db.run('DELETE FROM product_markets WHERE product_id = ?', [productId]);
    for (const marketId of ids) db.run('INSERT INTO product_markets (product_id, market_id) VALUES (?, ?)', [productId, marketId]);
  }

  // ---- lists -----------------------------------------------------------------------------------
  app.get('/products', async (req) => {
    const query = req.query as Record<string, unknown>;
    const { where, params } = productFilters(query);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = pagination(query, 50, 500);
    const total = db.scalar<number>(`SELECT COUNT(*) ${PRODUCT_FROM} ${whereSql}`, params) ?? 0;
    const order = orderBy(query.sort, SORTS, 'b.ownership DESC, b.name, p.name COLLATE NOCASE');
    const rows = db.all<RawProduct>(
      `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} ${whereSql} ORDER BY ${order}, p.id LIMIT ? OFFSET ?`,
      [...params, page.pageSize, page.offset],
    );
    return paged(rows.map(withPack), total, page);
  });

  /** Counts per brand, category or market for the same filters as the list (used for "group by"). */
  app.get('/products/summary', async (req): Promise<ProductSummary> => {
    const query = req.query as Record<string, unknown>;
    const groupBy = query.group_by === 'category' || query.group_by === 'market' ? query.group_by : 'brand';
    const { where, params } = productFilters(query);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.scalar<number>(`SELECT COUNT(*) ${PRODUCT_FROM} ${whereSql}`, params) ?? 0;
    let groups: ProductSummaryGroup[];
    if (groupBy === 'brand') {
      groups = db.all<ProductSummaryGroup>(
        `SELECT b.id AS id, b.name AS label, b.ownership AS ownership, COUNT(*) AS count ${PRODUCT_FROM} ${whereSql}
         GROUP BY b.id ORDER BY b.ownership DESC, count DESC, b.name`,
        params,
      );
    } else if (groupBy === 'category') {
      groups = db.all<ProductSummaryGroup>(
        `SELECT c.id AS id, c.name AS label, COUNT(*) AS count ${PRODUCT_FROM} ${whereSql} GROUP BY c.id ORDER BY count DESC, c.name`,
        params,
      );
    } else {
      groups = db.all<ProductSummaryGroup>(
        `SELECT mk.id AS id, mk.name AS label, COUNT(*) AS count ${PRODUCT_FROM}
         JOIN product_markets gm ON gm.product_id = p.id JOIN markets mk ON mk.id = gm.market_id
         ${whereSql} GROUP BY mk.id ORDER BY mk.sort_order, mk.name`,
        params,
      );
      const unassigned =
        db.scalar<number>(
          `SELECT COUNT(*) ${PRODUCT_FROM} ${whereSql ? `${whereSql} AND` : 'WHERE'} COALESCE(pm.market_count, 0) = 0`,
          params,
        ) ?? 0;
      if (unassigned > 0) groups.push({ id: null, label: 'No market assigned', count: unassigned });
    }
    return { group_by: groupBy, total, groups };
  });

  /** Lightweight product search for selectors. `ids=` resolves labels of already-selected products. */
  app.get('/products/options', async (req) => {
    const query = req.query as Record<string, unknown>;
    const where: string[] = [];
    const params: SqlParam[] = [];
    const ids = idList(query.ids);
    if (ids) {
      where.push(`p.id IN (${placeholders(ids.length)})`);
      params.push(...ids);
    } else {
      if (optBool(query.include_archived) !== true) where.push(`p.status <> 'archived'`);
      if (typeof query.q === 'string' && query.q.trim()) {
        const p = likePattern(query.q.trim());
        where.push(`(p.name LIKE ? ESCAPE '\\' OR p.code LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.gtin LIKE ? ESCAPE '\\' OR b.name LIKE ? ESCAPE '\\')`);
        params.push(p, p, p, p, p);
      }
      const brandIds = idList(query.brand_id);
      if (brandIds) {
        where.push(`p.brand_id IN (${placeholders(brandIds.length)})`);
        params.push(...brandIds);
      }
      const categoryIds = idList(query.category_id);
      if (categoryIds) {
        const ph = placeholders(categoryIds.length);
        where.push(`(p.category_id IN (${ph}) OR p.subcategory_id IN (${ph}))`);
        params.push(...categoryIds, ...categoryIds);
      }
      if (query.ownership === 'own' || query.ownership === 'competitor') {
        where.push('b.ownership = ?');
        params.push(query.ownership);
      }
    }
    const limit = Math.min(200, Math.max(1, Math.floor(Number(query.limit ?? 25)) || 25));
    const rows = db.all<Omit<ProductOption, 'pack_label'>>(
      `SELECT p.id, p.code, p.name, p.brand_id, b.name AS brand_name, b.ownership, c.name AS category_name,
         p.pack_size, p.pack_unit, p.units_per_pack, p.status, p.is_demo
       FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY b.ownership DESC, b.name, p.name COLLATE NOCASE, p.id LIMIT ?`,
      [...params, ids ? Math.max(limit, ids.length) : limit],
    );
    const options: ProductOption[] = rows.map((r) => ({ ...r, pack_label: formatPack(r.pack_size, r.pack_unit, r.units_per_pack) }));
    return { rows: options };
  });

  // ---- single product --------------------------------------------------------------------------
  app.get('/products/:id', async (req) => productDetail(idParam((req.params as { id: string }).id)));

  app.post('/products', { config: { permission: 'catalogue.write' } }, async (req, reply) => {
    const body = parse(z.object(productFields), req.body);
    const data = {
      brand_id: body.brand_id,
      name: body.name,
      category_id: body.category_id,
      subcategory_id: body.subcategory_id ?? null,
      product_line: body.product_line ?? null,
      sku: body.sku ?? null,
      gtin: normaliseGtin(body.gtin),
      pack_size: body.pack_size ?? null,
      pack_unit: body.pack_unit ?? null,
      units_per_pack: body.units_per_pack ?? 1,
      image_url: body.image_url ?? null,
      description: body.description ?? null,
      status: body.status ?? 'active',
    };
    if (body.gtin && !data.gtin) throw unprocessable('Barcode / GTIN must contain 8 to 14 digits');
    validateProduct(data);
    const marketIds = [...new Set(body.market_ids ?? [])];
    assertMarkets(marketIds);
    const now = nowIso();
    const id = db.tx(() => {
      // A real product keeps the (formerly demo) brand and categories it relies on.
      promoteBrandToReal(ctx, data.brand_id);
      promoteCategoryToReal(ctx, data.category_id);
      promoteCategoryToReal(ctx, data.subcategory_id);
      const newId = db.run(
        `INSERT INTO products (brand_id, name, product_line, category_id, subcategory_id, sku, gtin, pack_size, pack_unit, units_per_pack,
           image_url, description, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.brand_id, data.name, data.product_line, data.category_id, data.subcategory_id, data.sku, data.gtin, data.pack_size,
          data.pack_unit, data.units_per_pack, data.image_url, data.description, data.status, req.user!.id, now, now,
        ],
      ).lastInsertRowid;
      setMarkets(newId, marketIds);
      audit(ctx, req.user, 'product.created', 'product', newId, { name: data.name, brand_id: data.brand_id, sku: data.sku, gtin: data.gtin }, req.ip);
      return newId;
    });
    return reply.code(201).send(productDetail(id));
  });

  app.patch('/products/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = db.get<Record<string, unknown> & {
      brand_id: number; category_id: number; subcategory_id: number | null; sku: string | null; gtin: string | null;
      pack_size: number | null; pack_unit: string | null; units_per_pack: number; image_url: string | null; status: string; is_demo: number;
    }>('SELECT * FROM products WHERE id = ?', [id]);
    if (!before) throw notFound('Product');
    const body = parse(z.object(productFields).partial(), req.body);
    if (body.status !== undefined && before.status === 'archived') {
      throw conflict('This product is archived. Restore it before changing its status.');
    }
    const changes: Record<string, SqlParam> = {
      brand_id: body.brand_id,
      name: body.name,
      category_id: body.category_id,
      subcategory_id: body.subcategory_id,
      product_line: body.product_line,
      sku: body.sku,
      gtin: body.gtin === undefined ? undefined : normaliseGtin(body.gtin),
      pack_size: body.pack_size,
      pack_unit: body.pack_unit,
      units_per_pack: body.units_per_pack === undefined ? undefined : (body.units_per_pack ?? 1),
      image_url: body.image_url,
      description: body.description,
      status: body.status,
    };
    if (body.gtin && !changes.gtin) throw unprocessable('Barcode / GTIN must contain 8 to 14 digits');
    // Moving to another category drops a subcategory that no longer fits, unless a new one was sent.
    if (body.category_id !== undefined && body.category_id !== before.category_id && body.subcategory_id === undefined) {
      changes.subcategory_id = null;
    }
    const merged = { ...before };
    for (const [key, value] of Object.entries(changes)) if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    const { brand } = validateProduct(merged, id);
    if (merged.brand_id !== before.brand_id) {
      const previous = db.get<{ ownership: string }>('SELECT ownership FROM brands WHERE id = ?', [before.brand_id])!;
      const mapped = db.scalar<number>('SELECT COUNT(*) FROM competitor_mappings WHERE own_product_id = ? OR competitor_product_id = ?', [id, id]) ?? 0;
      if (previous.ownership !== brand.ownership && mapped > 0) {
        throw conflict('This product has competitor mappings. Remove them before moving it between an own brand and a competitor brand.');
      }
    }
    const marketIds = body.market_ids === undefined ? undefined : [...new Set(body.market_ids)];
    if (marketIds) assertMarkets(marketIds);
    const diff = changedFields(before, changes);
    db.tx(() => {
      if (!before.is_demo) {
        promoteBrandToReal(ctx, merged.brand_id);
        promoteCategoryToReal(ctx, merged.category_id);
        promoteCategoryToReal(ctx, merged.subcategory_id);
      }
      if (Object.keys(diff).length) applyUpdate(ctx, 'products', id, changes);
      if (marketIds) setMarkets(id, marketIds);
      if (Object.keys(diff).length || marketIds) {
        audit(ctx, req.user, 'product.updated', 'product', id, { ...diff, ...(marketIds ? { market_ids: marketIds } : {}) }, req.ip);
      }
    });
    return productDetail(id);
  });

  for (const [action, status] of [['archive', 'archived'], ['restore', 'active']] as const) {
    app.post(`/products/:id/${action}`, { config: { permission: 'catalogue.write' } }, async (req) => {
      const id = idParam((req.params as { id: string }).id);
      const product = db.get<{ status: string }>('SELECT status FROM products WHERE id = ?', [id]);
      if (!product) throw notFound('Product');
      if (action === 'restore' && product.status !== 'archived') throw conflict('This product is not archived');
      if (product.status !== status) {
        db.run('UPDATE products SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
        audit(ctx, req.user, action === 'archive' ? 'product.archived' : 'product.restored', 'product', id, { from: product.status }, req.ip);
      }
      return productDetail(id);
    });
  }

  app.delete('/products/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const product = db.get<{ code: string; name: string }>('SELECT code, name FROM products WHERE id = ?', [id]);
    if (!product) throw notFound('Product');
    const listings = db.scalar<number>('SELECT COUNT(*) FROM retailer_listings WHERE product_id = ?', [id]) ?? 0;
    if (listings > 0) {
      throw conflict(
        `${product.code} has ${listings} retailer listing${listings === 1 ? '' : 's'}. Archive the product instead so its price history is preserved.`,
        { listings },
      );
    }
    db.run('DELETE FROM products WHERE id = ?', [id]);
    audit(ctx, req.user, 'product.deleted', 'product', id, product, req.ip);
    return { ok: true };
  });

  app.put('/products/:id/markets', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    if (!db.get('SELECT id FROM products WHERE id = ?', [id])) throw notFound('Product');
    const body = parse(z.object({ market_ids: z.array(requiredId()).max(500) }), req.body);
    const ids = [...new Set(body.market_ids)];
    assertMarkets(ids);
    db.tx(() => {
      setMarkets(id, ids);
      audit(ctx, req.user, 'product.markets_set', 'product', id, { market_ids: ids }, req.ip);
    });
    return productDetail(id);
  });

  // ---- pack variants ---------------------------------------------------------------------------
  function validateVariant(productId: number, data: { name: string; units_per_pack: number; gtin: string | null }, selfId?: number): void {
    if (!Number.isInteger(data.units_per_pack) || data.units_per_pack < 1 || data.units_per_pack > 10_000) {
      throw unprocessable('Units per pack must be a whole number of at least 1');
    }
    if (data.gtin !== null && !/^\d{8,14}$/.test(data.gtin)) throw unprocessable('Barcode / GTIN must contain 8 to 14 digits');
    if (db.get('SELECT id FROM product_variants WHERE product_id = ? AND name = ? COLLATE NOCASE AND id <> ?', [productId, data.name, selfId ?? 0])) {
      throw conflict(`This product already has a pack variant named "${data.name}"`);
    }
  }

  app.post('/products/:id/variants', { config: { permission: 'catalogue.write' } }, async (req, reply) => {
    const productId = idParam((req.params as { id: string }).id);
    if (!db.get('SELECT id FROM products WHERE id = ?', [productId])) throw notFound('Product');
    const body = parse(z.object(variantFields), req.body);
    const data = { name: body.name, units_per_pack: body.units_per_pack ?? 1, gtin: normaliseGtin(body.gtin) };
    if (body.gtin && !data.gtin) throw unprocessable('Barcode / GTIN must contain 8 to 14 digits');
    validateVariant(productId, data);
    const id = db.run(
      `INSERT INTO product_variants (product_id, name, pack_size, pack_unit, units_per_pack, gtin, notes, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [productId, data.name, body.pack_size, body.pack_unit, data.units_per_pack, data.gtin, body.notes ?? null, body.is_active ?? true, nowIso()],
    ).lastInsertRowid;
    audit(ctx, req.user, 'variant.created', 'product', productId, { variant_id: id, name: data.name, pack: formatPack(body.pack_size, body.pack_unit, data.units_per_pack) }, req.ip);
    return reply.code(201).send(variantRows(productId).find((v) => v.id === id));
  });

  app.patch('/variants/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = db.get<Record<string, unknown> & { product_id: number; name: string; units_per_pack: number; gtin: string | null }>(
      'SELECT * FROM product_variants WHERE id = ?',
      [id],
    );
    if (!before) throw notFound('Pack variant');
    const body = parse(z.object(variantFields).partial(), req.body);
    const changes: Record<string, SqlParam> = {
      name: body.name,
      pack_size: body.pack_size,
      pack_unit: body.pack_unit,
      units_per_pack: body.units_per_pack === undefined ? undefined : (body.units_per_pack ?? 1),
      gtin: body.gtin === undefined ? undefined : normaliseGtin(body.gtin),
      notes: body.notes,
      is_active: body.is_active,
    };
    if (body.gtin && !changes.gtin) throw unprocessable('Barcode / GTIN must contain 8 to 14 digits');
    validateVariant(
      before.product_id,
      {
        name: body.name ?? before.name,
        units_per_pack: (changes.units_per_pack as number | undefined) ?? before.units_per_pack,
        gtin: changes.gtin === undefined ? before.gtin : (changes.gtin as string | null),
      },
      id,
    );
    const diff = changedFields(before, changes);
    if (Object.keys(diff).length) {
      applyUpdate(ctx, 'product_variants', id, changes, false);
      audit(ctx, req.user, 'variant.updated', 'product', before.product_id, { variant_id: id, ...diff }, req.ip);
    }
    return variantRows(before.product_id).find((v) => v.id === id);
  });

  app.delete('/variants/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const variant = db.get<{ product_id: number; name: string }>('SELECT product_id, name FROM product_variants WHERE id = ?', [id]);
    if (!variant) throw notFound('Pack variant');
    const used = db.scalar<number>('SELECT COUNT(*) FROM retailer_listings WHERE variant_id = ?', [id]) ?? 0;
    if (used > 0) {
      throw conflict(`"${variant.name}" is used by ${used} retailer listing${used === 1 ? '' : 's'}. Point those listings at another pack first, or deactivate the variant.`);
    }
    db.run('DELETE FROM product_variants WHERE id = ?', [id]);
    audit(ctx, req.user, 'variant.deleted', 'product', variant.product_id, { variant_id: id, name: variant.name }, req.ip);
    return { ok: true };
  });
}
