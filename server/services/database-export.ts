/**
 * The whole database as one Excel workbook, and the always-current "Excel mirror" of it on disk.
 *
 * The relational database stays the system of record (it is what enforces the append-only ledger);
 * the workbook is a faithful, read-only copy for people who want the data in Excel: one sheet per
 * entity, human-readable columns, real Excel numbers and dates, DEMO rows flagged everywhere.
 *
 * Never exported: password hashes, session tokens, encrypted credentials or connector settings.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import type { AppContext } from '../context.ts';
import type { SqlValue } from '../db/sqlite.ts';
import { nowIso } from '../lib/time.ts';
import {
  ALERT_TYPE_INFO,
  AVAILABILITY_LABELS,
  COLLECTION_METHOD_LABELS,
  DATA_CLASS_LABELS,
  FREQUENCY_LABELS,
  PROMO_TYPE_LABELS,
  type AlertType,
  type Availability,
  type CollectionMethod,
  type DataClass,
  type Frequency,
  type PromoType,
} from '../../shared/constants.ts';
import { formatPack, unitBasisLabel } from '../../shared/units.ts';
import type { DatabaseMirrorStatus } from '../../shared/api/observations.ts';
import { writeXlsx, type ColumnSpec, type SheetSpec, type WorkbookSummary } from './export.ts';

type Row = Record<string, unknown>;

interface DbColumn extends ColumnSpec {
  description: string;
}

interface DbSheet {
  name: string;
  description: string;
  /** Only included for administrators (people data, audit trail). */
  adminOnly?: boolean;
  columns: DbColumn[];
  count: (ctx: AppContext) => number;
  rows: (ctx: AppContext) => Iterable<Row>;
}

const count = (sql: string) => (ctx: AppContext) => ctx.db.scalar<number>(sql) ?? 0;

/** Small tables: one query. */
const all =
  (sql: string, map?: (row: Row) => Row) =>
  (ctx: AppContext): Iterable<Row> => {
    const rows = ctx.db.all<Row>(sql);
    return map ? rows.map(map) : rows;
  };

/**
 * Large tables: keyset pagination, so memory stays flat. `sql` must end with a condition on an ascending
 * integer key written as `<key> > ?` and select that key as `cursor_key`.
 */
const paged =
  (sql: string, orderBy: string, map?: (row: Row) => Row, chunk = 2000) =>
  (ctx: AppContext): Iterable<Row> => ({
    *[Symbol.iterator]() {
      let last: SqlValue = 0;
      for (;;) {
        const rows: Row[] = ctx.db.all<Row>(`${sql} ORDER BY ${orderBy} LIMIT ${chunk}`, [last]);
        for (const row of rows) yield map ? map(row) : row;
        if (rows.length < chunk) return;
        last = rows[rows.length - 1]!.cursor_key as number;
      }
    },
  });

const demo = (row: Row) => (row.is_demo ? 'DEMO' : null);
const label = <K extends string>(labels: Record<K, string>, value: unknown) => (typeof value === 'string' ? (labels[value as K] ?? value) : null);
const OWNERSHIP_SQL = (alias: string) => `CASE ${alias}.ownership WHEN 'own' THEN 'Own brand' WHEN 'competitor' THEN 'Competitor' END`;
const DEMO_COLUMN: DbColumn = { key: 'demo', header: 'Demo data', type: 'text', width: 11, description: '"DEMO" marks illustrative records with fictional values. Blank = real data.' };

const EVENT_KIND_LABELS: Record<string, string> = {
  price_change: 'Price change',
  availability_change: 'Availability change',
  promo_start: 'Promotion started',
  promo_end: 'Promotion ended',
};
const BASIS_LABELS: Record<string, string> = { exact: 'Exact time', date_only: 'Date only', import_time: 'Import time (original date unknown)' };

const SHEETS: DbSheet[] = [
  {
    name: 'Markets',
    description: 'Markets monitored, with their currency, time zone and default collection schedule.',
    columns: [
      { key: 'id', header: 'Market ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'code', header: 'Market code', type: 'text', width: 12, description: 'Short code, e.g. AE.' },
      { key: 'name', header: 'Market', type: 'text', description: 'Market name.' },
      { key: 'country_code', header: 'Country code', type: 'text', width: 13, description: 'ISO country code.' },
      { key: 'country_name', header: 'Country', type: 'text', description: 'Country name.' },
      { key: 'region', header: 'Region', type: 'text', description: 'Region grouping.' },
      { key: 'currency_code', header: 'Currency', type: 'text', width: 10, description: 'Currency of prices in this market.' },
      { key: 'timezone', header: 'Time zone', type: 'text', description: 'IANA time zone used for local dates.' },
      { key: 'default_frequency', header: 'Default collection frequency', type: 'text', width: 26, description: 'Schedule used by retailers that do not set their own.' },
      { key: 'is_active', header: 'Active', type: 'boolean', description: 'Whether the market is in use.' },
      { key: 'retailers', header: 'Retailers', type: 'integer', description: 'Number of retailers configured in the market.' },
      { key: 'notes', header: 'Notes', type: 'text', width: 40, description: 'Free-text notes.' },
    ],
    count: count('SELECT COUNT(*) FROM markets'),
    rows: all(
      `SELECT m.id, m.code, m.name, m.country_code, m.country_name, m.region, m.currency_code, m.timezone, m.default_frequency, m.is_active,
         (SELECT COUNT(*) FROM retailers r WHERE r.market_id = m.id) AS retailers, m.notes
       FROM markets m ORDER BY m.sort_order, m.name`,
      (row) => ({ ...row, default_frequency: label(FREQUENCY_LABELS, row.default_frequency) }),
    ),
  },
  {
    name: 'Currencies',
    description: 'Currencies known to the system.',
    columns: [
      { key: 'code', header: 'Currency code', type: 'text', width: 14, description: 'ISO 4217 code.' },
      { key: 'name', header: 'Currency', type: 'text', description: 'Currency name.' },
      { key: 'symbol', header: 'Symbol', type: 'text', width: 9, description: 'Display symbol.' },
      { key: 'decimals', header: 'Decimals', type: 'integer', description: 'Decimal places normally shown.' },
    ],
    count: count('SELECT COUNT(*) FROM currencies'),
    rows: all('SELECT code, name, symbol, decimals FROM currencies ORDER BY code'),
  },
  {
    name: 'Exchange rates',
    description: 'History of exchange rates (append-only). Each rate keeps its source and timestamp.',
    columns: [
      { key: 'id', header: 'Rate ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'base_currency', header: 'Base currency', type: 'text', width: 14, description: 'Always USD.' },
      { key: 'quote_currency', header: 'Quote currency', type: 'text', width: 15, description: 'Currency being quoted.' },
      { key: 'rate', header: 'Rate', type: 'number', numFmt: '0.000000', width: 14, description: 'Units of the quote currency per 1 unit of the base currency.' },
      { key: 'as_of', header: 'As of (UTC)', type: 'datetime', description: 'Timestamp the rate refers to.' },
      { key: 'source', header: 'Source', type: 'text', width: 28, description: 'Where the rate came from.' },
      { key: 'source_ref', header: 'Source reference', type: 'text', width: 36, description: 'URL or note for the source.' },
      { key: 'fetched_at', header: 'Recorded at (UTC)', type: 'datetime', description: 'When the rate was stored.' },
      DEMO_COLUMN,
    ],
    count: count('SELECT COUNT(*) FROM exchange_rates'),
    rows: paged(
      `SELECT id, id AS cursor_key, base_currency, quote_currency, rate, as_of, source, source_ref, fetched_at, is_demo FROM exchange_rates WHERE id > ?`,
      'id',
      (row) => ({ ...row, demo: demo(row) }),
    ),
  },
  {
    name: 'Brands',
    description: 'Own and competitor brands.',
    columns: [
      { key: 'id', header: 'Brand ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'name', header: 'Brand', type: 'text', description: 'Brand name.' },
      { key: 'ownership', header: 'Brand ownership', type: 'text', width: 16, description: 'Own brand or Competitor.' },
      { key: 'manufacturer', header: 'Manufacturer', type: 'text', description: 'Company behind the brand.' },
      { key: 'benchmarked_against', header: 'Benchmarked against', type: 'text', width: 40, description: 'Competitor brands associated with an own brand.' },
      { key: 'products', header: 'Products', type: 'integer', description: 'Number of products of the brand.' },
      { key: 'is_active', header: 'Active', type: 'boolean', description: 'Whether the brand is in use.' },
      DEMO_COLUMN,
    ],
    count: count('SELECT COUNT(*) FROM brands'),
    rows: all(
      `SELECT b.id, b.name, ${OWNERSHIP_SQL('b')} AS ownership, b.manufacturer, b.is_active, b.is_demo,
         (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS products,
         (SELECT group_concat(cb.name, ', ') FROM brand_competitors bc JOIN brands cb ON cb.id = bc.competitor_brand_id WHERE bc.own_brand_id = b.id) AS benchmarked_against
       FROM brands b ORDER BY b.ownership DESC, b.name`,
      (row) => ({ ...row, demo: demo(row) }),
    ),
  },
  {
    name: 'Categories',
    description: 'Category tree (categories and their subcategories).',
    columns: [
      { key: 'id', header: 'Category ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'name', header: 'Name', type: 'text', description: 'Category or subcategory name.' },
      { key: 'level', header: 'Level', type: 'text', width: 13, description: 'Category or Subcategory.' },
      { key: 'parent', header: 'Parent category', type: 'text', description: 'Parent of a subcategory.' },
      DEMO_COLUMN,
    ],
    count: count('SELECT COUNT(*) FROM categories'),
    rows: all(
      `SELECT c.id, c.name, p.name AS parent, CASE WHEN c.parent_id IS NULL THEN 'Category' ELSE 'Subcategory' END AS level, c.is_demo
       FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
       ORDER BY COALESCE(p.name, c.name), c.parent_id IS NOT NULL, c.name`,
      (row) => ({ ...row, demo: demo(row) }),
    ),
  },
  {
    name: 'Products',
    description: 'Master product catalogue (canonical products).',
    columns: [
      { key: 'code', header: 'Product code', type: 'text', width: 13, description: 'Product ID shown in the application.' },
      { key: 'name', header: 'Product name', type: 'text', width: 40, description: 'Product name.' },
      { key: 'brand', header: 'Brand', type: 'text', description: 'Brand.' },
      { key: 'ownership', header: 'Brand ownership', type: 'text', width: 16, description: 'Own brand or Competitor.' },
      { key: 'category', header: 'Category', type: 'text', description: 'Category.' },
      { key: 'subcategory', header: 'Subcategory', type: 'text', description: 'Subcategory.' },
      { key: 'product_line', header: 'Product line', type: 'text', description: 'Range / line grouping pack sizes.' },
      { key: 'sku', header: 'SKU', type: 'text', width: 16, description: 'Internal SKU.' },
      { key: 'gtin', header: 'GTIN', type: 'text', width: 16, description: 'Barcode.' },
      { key: 'pack_size', header: 'Pack size', type: 'number', description: 'Size of one unit.' },
      { key: 'pack_unit', header: 'Pack unit', type: 'text', width: 10, description: 'ml, l, g, kg or unit.' },
      { key: 'units_per_pack', header: 'Units per pack', type: 'integer', width: 14, description: 'Units in a multi-pack.' },
      { key: 'pack', header: 'Pack', type: 'text', width: 12, description: 'Pack as displayed, e.g. 2 × 200ml.' },
      { key: 'status', header: 'Status', type: 'text', width: 10, description: 'active, inactive or archived.' },
      { key: 'markets', header: 'Markets', type: 'text', width: 22, description: 'Market codes where the product is sold, separated by |.' },
      { key: 'listings', header: 'Listings', type: 'integer', description: 'Number of retailer listings mapped to the product.' },
      { key: 'image_url', header: 'Image URL', type: 'text', width: 30, description: 'Product image link.' },
      { key: 'description', header: 'Description', type: 'text', width: 40, description: 'Free-text description.' },
      DEMO_COLUMN,
      { key: 'created_at', header: 'Created at (UTC)', type: 'datetime', description: 'When the product was created.' },
      { key: 'updated_at', header: 'Updated at (UTC)', type: 'datetime', description: 'When the product was last changed.' },
      { key: 'id', header: 'Product ID', type: 'integer', description: 'Internal identifier.' },
    ],
    count: count('SELECT COUNT(*) FROM products'),
    rows: paged(
      `SELECT p.id, p.id AS cursor_key, p.code, p.name, b.name AS brand, ${OWNERSHIP_SQL('b')} AS ownership, c.name AS category, sc.name AS subcategory,
         p.product_line, p.sku, p.gtin, p.pack_size, p.pack_unit, p.units_per_pack, p.status,
         (SELECT group_concat(m.code, '|') FROM product_markets pm JOIN markets m ON m.id = pm.market_id WHERE pm.product_id = p.id) AS markets,
         (SELECT COUNT(*) FROM retailer_listings l WHERE l.product_id = p.id) AS listings,
         p.image_url, p.description, p.is_demo, p.created_at, p.updated_at
       FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id LEFT JOIN categories sc ON sc.id = p.subcategory_id
       WHERE p.id > ?`,
      'p.id',
      (row) => ({
        ...row,
        demo: demo(row),
        pack: row.pack_size ? formatPack(row.pack_size as number, row.pack_unit as string, row.units_per_pack as number) : null,
      }),
    ),
  },
  {
    name: 'Product variants',
    description: 'Alternative pack configurations of a product (twin packs, bonus packs).',
    columns: [
      { key: 'id', header: 'Variant ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'product_code', header: 'Product code', type: 'text', width: 13, description: 'Product the variant belongs to.' },
      { key: 'product', header: 'Product', type: 'text', width: 40, description: 'Product name.' },
      { key: 'name', header: 'Variant', type: 'text', description: 'Variant name.' },
      { key: 'pack_size', header: 'Pack size', type: 'number', description: 'Size of one unit.' },
      { key: 'pack_unit', header: 'Pack unit', type: 'text', width: 10, description: 'ml, l, g, kg or unit.' },
      { key: 'units_per_pack', header: 'Units per pack', type: 'integer', width: 14, description: 'Units in the pack.' },
      { key: 'gtin', header: 'GTIN', type: 'text', width: 16, description: 'Barcode of the variant.' },
      { key: 'notes', header: 'Notes', type: 'text', width: 30, description: 'Free-text notes.' },
      { key: 'is_active', header: 'Active', type: 'boolean', description: 'Whether the variant is in use.' },
    ],
    count: count('SELECT COUNT(*) FROM product_variants'),
    rows: all(
      `SELECT v.id, p.code AS product_code, p.name AS product, v.name, v.pack_size, v.pack_unit, v.units_per_pack, v.gtin, v.notes, v.is_active
       FROM product_variants v JOIN products p ON p.id = v.product_id ORDER BY p.name, v.name`,
    ),
  },
  {
    name: 'Product markets',
    description: 'Market availability: which product is sold in which market.',
    columns: [
      { key: 'product_code', header: 'Product code', type: 'text', width: 13, description: 'Product.' },
      { key: 'product', header: 'Product', type: 'text', width: 40, description: 'Product name.' },
      { key: 'market_code', header: 'Market code', type: 'text', width: 12, description: 'Market.' },
      { key: 'market', header: 'Market', type: 'text', description: 'Market name.' },
    ],
    count: count('SELECT COUNT(*) FROM product_markets'),
    rows: all(
      `SELECT p.code AS product_code, p.name AS product, m.code AS market_code, m.name AS market
       FROM product_markets pm JOIN products p ON p.id = pm.product_id JOIN markets m ON m.id = pm.market_id ORDER BY p.name, m.sort_order`,
    ),
  },
  {
    name: 'Competitor mappings',
    description: 'Equivalent-product mapping between own products and competitor products.',
    columns: [
      { key: 'id', header: 'Mapping ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'own_product_code', header: 'Own product code', type: 'text', width: 17, description: 'Own product.' },
      { key: 'own_product', header: 'Own product', type: 'text', width: 36, description: 'Own product name.' },
      { key: 'own_brand', header: 'Own brand', type: 'text', description: 'Brand of the own product.' },
      { key: 'competitor_product_code', header: 'Competitor product code', type: 'text', width: 23, description: 'Competitor product.' },
      { key: 'competitor_product', header: 'Competitor product', type: 'text', width: 36, description: 'Competitor product name.' },
      { key: 'competitor_brand', header: 'Competitor brand', type: 'text', description: 'Brand of the competitor product.' },
      { key: 'market', header: 'Market', type: 'text', width: 13, description: 'Market the mapping applies to, or "All markets".' },
      { key: 'equivalence', header: 'Equivalence', type: 'text', width: 26, description: 'Equivalent (like for like) or Comparable (not equivalent — unit prices only).' },
      { key: 'status', header: 'Status', type: 'text', width: 11, description: 'suggested, approved or rejected.' },
      { key: 'score', header: 'Match score', type: 'number', numFmt: '0.00', description: 'Suggestion score (0–1).' },
      { key: 'rationale', header: 'Rationale', type: 'text', width: 40, description: 'Why the products were matched.' },
      { key: 'decided_by', header: 'Decided by', type: 'text', width: 26, description: 'User who approved or rejected.' },
      { key: 'decided_at', header: 'Decided at (UTC)', type: 'datetime', description: 'When it was decided.' },
      DEMO_COLUMN,
    ],
    count: count('SELECT COUNT(*) FROM competitor_mappings'),
    rows: all(
      `SELECT cm.id, op.code AS own_product_code, op.name AS own_product, ob.name AS own_brand,
         cp.code AS competitor_product_code, cp.name AS competitor_product, cb.name AS competitor_brand,
         COALESCE(m.code, 'All markets') AS market,
         CASE cm.equivalence WHEN 'equivalent' THEN 'Equivalent' ELSE 'Comparable (not equivalent)' END AS equivalence,
         cm.status, cm.score, cm.rationale, u.email AS decided_by, cm.decided_at, cm.is_demo
       FROM competitor_mappings cm
       JOIN products op ON op.id = cm.own_product_id JOIN brands ob ON ob.id = op.brand_id
       JOIN products cp ON cp.id = cm.competitor_product_id JOIN brands cb ON cb.id = cp.brand_id
       LEFT JOIN markets m ON m.id = cm.market_id LEFT JOIN users u ON u.id = cm.decided_by
       ORDER BY ob.name, op.name, cb.name, cp.name`,
      (row) => ({ ...row, demo: demo(row) }),
    ),
  },
  {
    name: 'Retailers',
    description: 'Retailers / marketplaces configured as collection sources. Connector settings and credentials are never exported.',
    columns: [
      { key: 'id', header: 'Retailer ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'name', header: 'Retailer', type: 'text', description: 'Retailer name.' },
      { key: 'market_code', header: 'Market code', type: 'text', width: 12, description: 'Market.' },
      { key: 'market', header: 'Market', type: 'text', description: 'Market name.' },
      { key: 'country_code', header: 'Country', type: 'text', width: 9, description: 'Country code.' },
      { key: 'currency_code', header: 'Currency', type: 'text', width: 10, description: 'Currency of the retailer.' },
      { key: 'website', header: 'Website', type: 'text', width: 30, description: 'Website.' },
      { key: 'collection_method', header: 'Collection method', type: 'text', width: 28, description: 'How prices are collected for this retailer.' },
      { key: 'collection_frequency', header: 'Collection frequency', type: 'text', width: 20, description: 'Effective schedule (own setting or the market default).' },
      { key: 'is_enabled', header: 'Collection enabled', type: 'boolean', width: 18, description: 'No = paused.' },
      { key: 'permission_attested', header: 'Access permission attested', type: 'boolean', width: 25, description: 'Whether permission to access the site was attested (website extraction).' },
      { key: 'last_attempt_at', header: 'Last attempt (UTC)', type: 'datetime', description: 'Last collection attempt.' },
      { key: 'last_success_at', header: 'Last success (UTC)', type: 'datetime', description: 'Last successful collection.' },
      { key: 'next_run_at', header: 'Next run (UTC)', type: 'datetime', description: 'Next scheduled collection.' },
      { key: 'consecutive_failures', header: 'Consecutive failures', type: 'integer', width: 20, description: 'Failed runs in a row.' },
      { key: 'listings', header: 'Listings', type: 'integer', description: 'Number of listings configured.' },
      { key: 'is_active', header: 'Active', type: 'boolean', description: 'Whether the retailer is in use.' },
      DEMO_COLUMN,
      { key: 'notes', header: 'Notes', type: 'text', width: 40, description: 'Free-text notes.' },
    ],
    count: count('SELECT COUNT(*) FROM retailers'),
    rows: all(
      `SELECT r.id, r.name, r.website, r.country_code, m.name AS market, m.code AS market_code, r.currency_code, r.collection_method,
         COALESCE(r.collection_frequency, m.default_frequency) AS collection_frequency, r.is_enabled, r.permission_attested,
         r.last_attempt_at, r.last_success_at, r.next_run_at, r.consecutive_failures,
         (SELECT COUNT(*) FROM retailer_listings l WHERE l.retailer_id = r.id) AS listings, r.is_active, r.is_demo, r.notes
       FROM retailers r JOIN markets m ON m.id = r.market_id ORDER BY m.sort_order, r.name`,
      (row) => ({
        ...row,
        demo: demo(row),
        collection_method: label(COLLECTION_METHOD_LABELS, row.collection_method),
        collection_frequency: label(FREQUENCY_LABELS, row.collection_frequency),
      }),
    ),
  },
  {
    name: 'Retailer listings',
    description: 'Retailer listings mapped to canonical products, with the latest observed price of each.',
    columns: [
      { key: 'code', header: 'Listing code', type: 'text', width: 14, description: 'Unique listing identifier.' },
      { key: 'retailer', header: 'Retailer', type: 'text', description: 'Retailer.' },
      { key: 'market', header: 'Market', type: 'text', width: 9, description: 'Market code.' },
      { key: 'product_code', header: 'Product code', type: 'text', width: 13, description: 'Canonical product (blank = not matched yet).' },
      { key: 'product', header: 'Product', type: 'text', width: 40, description: 'Canonical product name.' },
      { key: 'brand', header: 'Brand', type: 'text', description: 'Brand.' },
      { key: 'variant', header: 'Pack variant', type: 'text', description: 'Pack variant sold by this listing, if not the standard pack.' },
      { key: 'external_id', header: 'Retailer item ID', type: 'text', width: 18, description: "The retailer's own item id." },
      { key: 'url', header: 'Listing URL', type: 'text', width: 44, description: 'URL of the listing.' },
      { key: 'title', header: 'Retailer title', type: 'text', width: 40, description: 'Title as shown by the retailer.' },
      { key: 'gtin', header: 'Retailer GTIN', type: 'text', width: 16, description: 'Barcode reported by the retailer.' },
      { key: 'match_status', header: 'Match status', type: 'text', width: 13, description: 'matched, unmatched or ignored.' },
      { key: 'is_active', header: 'Active', type: 'boolean', description: 'Whether the listing is monitored.' },
      { key: 'currency', header: 'Currency', type: 'text', width: 10, description: 'Currency of the listing prices.' },
      { key: 'latest_current_price', header: 'Latest current price', type: 'money', width: 19, description: 'Selling price of the latest observation.' },
      { key: 'latest_regular_price', header: 'Latest regular price', type: 'money', width: 19, description: 'Regular price of the latest observation.' },
      { key: 'latest_on_promotion', header: 'Latest on promotion', type: 'boolean', width: 19, description: 'Whether the latest observation was promotional.' },
      { key: 'latest_availability', header: 'Latest availability', type: 'text', width: 18, description: 'Availability of the latest observation.' },
      { key: 'last_observed_at', header: 'Last observed (UTC)', type: 'datetime', description: 'Time of the latest observation.' },
      { key: 'observations', header: 'Observations', type: 'integer', width: 13, description: 'Number of (non-voided) observations.' },
      DEMO_COLUMN,
      { key: 'id', header: 'Listing ID', type: 'integer', description: 'Internal identifier.' },
    ],
    count: count('SELECT COUNT(*) FROM retailer_listings'),
    rows: paged(
      `SELECT l.id, l.id AS cursor_key, l.code, r.name AS retailer, m.code AS market, p.code AS product_code, p.name AS product, b.name AS brand,
         v.name AS variant, l.external_id, l.url, l.title, l.gtin, l.match_status, l.is_active, l.is_demo, r.currency_code AS currency,
         lo.current_price AS latest_current_price, lo.regular_price AS latest_regular_price,
         CASE WHEN lo.id IS NULL THEN NULL ELSE lo.is_promo END AS latest_on_promotion, lo.availability AS latest_availability,
         s.last_observed_at, COALESCE(s.obs_count, 0) AS observations
       FROM retailer_listings l JOIN retailers r ON r.id = l.retailer_id JOIN markets m ON m.id = r.market_id
       LEFT JOIN products p ON p.id = l.product_id LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN product_variants v ON v.id = l.variant_id
       LEFT JOIN listing_state s ON s.listing_id = l.id LEFT JOIN price_observations lo ON lo.id = s.latest_obs_id
       WHERE l.id > ?`,
      'l.id',
      (row) => ({ ...row, demo: demo(row), latest_availability: label(AVAILABILITY_LABELS, row.latest_availability) }),
    ),
  },
  {
    name: 'Price observations',
    description: 'The complete price ledger: every observation ever recorded (append-only). Voided observations are kept and flagged.',
    columns: [
      { key: 'id', header: 'Observation ID', type: 'integer', description: 'Identifier of the observation in the ledger.' },
      { key: 'observed_at', header: 'Observed at (UTC)', type: 'datetime', description: 'When the price was true, in UTC.' },
      { key: 'observed_local_date', header: 'Market-local date', type: 'date', width: 16, description: 'Calendar date in the time zone of the market.' },
      { key: 'market_name', header: 'Market name', type: 'text', width: 16, description: 'Market.' },
      { key: 'market_code', header: 'Market', type: 'text', width: 9, description: 'Market code.' },
      { key: 'retailer_name', header: 'Retailer', type: 'text', description: 'Retailer.' },
      { key: 'brand_name', header: 'Brand', type: 'text', width: 18, description: 'Brand of the product.' },
      { key: 'ownership', header: 'Ownership', type: 'text', width: 13, description: 'Own brand or Competitor.' },
      { key: 'product_name', header: 'Product', type: 'text', width: 40, description: 'Canonical product (blank while the listing is unmatched).' },
      { key: 'product_code', header: 'Product code', type: 'text', width: 13, description: 'Product ID.' },
      { key: 'sku', header: 'SKU', type: 'text', width: 16, description: 'Internal SKU.' },
      { key: 'gtin', header: 'GTIN', type: 'text', width: 16, description: 'Barcode.' },
      { key: 'category_name', header: 'Category', type: 'text', width: 16, description: 'Category.' },
      { key: 'subcategory_name', header: 'Subcategory', type: 'text', width: 18, description: 'Subcategory.' },
      { key: 'pack', header: 'Pack', type: 'text', width: 12, description: 'Pack sold by the listing.' },
      { key: 'listing_code', header: 'Listing code', type: 'text', width: 14, description: 'Retailer listing the price belongs to.' },
      { key: 'currency_code', header: 'Currency', type: 'text', width: 10, description: 'Currency of the prices in this row.' },
      { key: 'regular_price', header: 'Regular price', type: 'money', description: 'Regular listed price.' },
      { key: 'current_price', header: 'Current price', type: 'money', description: 'Price a shopper pays.' },
      { key: 'promo_price', header: 'Promo price', type: 'money', description: 'Promotional price when on offer.' },
      { key: 'discount_pct', header: 'Discount %', type: 'percent', description: 'Discount against the regular price.' },
      { key: 'is_promo', header: 'On promotion', type: 'boolean', width: 13, description: 'Whether the observation shows promotional pricing.' },
      { key: 'promo_type', header: 'Promo type', type: 'text', width: 12, description: 'Price cut, multi-buy, bundle, coupon or other.' },
      { key: 'promo_description', header: 'Promo description', type: 'text', width: 28, description: 'Offer text.' },
      { key: 'promo_starts_on', header: 'Promo starts on', type: 'date', width: 15, description: 'Stated start of the promotion.' },
      { key: 'promo_ends_on', header: 'Promo ends on', type: 'date', width: 15, description: 'Stated end of the promotion.' },
      { key: 'availability', header: 'Availability', type: 'text', width: 13, description: 'Stock status.' },
      { key: 'unit_price', header: 'Unit price', type: 'money', description: 'Price per 100 ml, per 100 g or per unit.' },
      { key: 'unit_basis', header: 'Unit price basis', type: 'text', width: 15, description: 'Basis of the unit price.' },
      { key: 'source_method', header: 'Source method', type: 'text', width: 28, description: 'How the observation entered the system.' },
      { key: 'data_class', header: 'Data class', type: 'text', width: 17, description: 'Collected (real), imported history, manual entry or simulated demo.' },
      DEMO_COLUMN,
      { key: 'confidence', header: 'Confidence', type: 'number', numFmt: '0.00', description: 'Evidence / extraction confidence (0–1).' },
      { key: 'collection_status', header: 'Collection status', type: 'text', width: 16, description: 'complete or partial.' },
      { key: 'observed_basis', header: 'Timestamp basis', type: 'text', width: 16, description: 'Exact time, date only, or import time when the original date is unknown.' },
      { key: 'time_zone', header: 'Time zone', type: 'text', width: 16, description: 'Time zone of the market.' },
      { key: 'collected_at', header: 'Collected at (UTC)', type: 'datetime', description: 'When the system captured the observation.' },
      { key: 'source_timestamp', header: 'Source timestamp (UTC)', type: 'datetime', width: 22, description: 'Timestamp reported by the source itself, if any.' },
      { key: 'evidence_reference', header: 'Evidence', type: 'text', width: 30, description: 'Evidence reference (URL, file, note).' },
      { key: 'job_id', header: 'Collection job ID', type: 'integer', width: 16, description: 'Collection job that produced the observation.' },
      { key: 'import_batch_id', header: 'Import batch ID', type: 'integer', width: 15, description: 'Import that produced the observation.' },
      { key: 'entered_by', header: 'Entered by', type: 'text', width: 26, description: 'User who entered or imported it.' },
      { key: 'url', header: 'Product URL', type: 'text', width: 40, description: 'URL where the price was seen.' },
      { key: 'note', header: 'Note', type: 'text', width: 30, description: 'Free-text note.' },
      { key: 'voided', header: 'Voided', type: 'boolean', description: 'Yes = withdrawn from analytics (kept for audit).' },
      { key: 'void_reason', header: 'Void reason', type: 'text', width: 40, description: 'Why the observation was voided.' },
      { key: 'voided_at', header: 'Voided at (UTC)', type: 'datetime', description: 'When it was voided.' },
      { key: 'listing_id', header: 'Listing ID', type: 'integer', description: 'Internal listing identifier.' },
      { key: 'product_id', header: 'Product ID', type: 'integer', description: 'Internal product identifier.' },
      { key: 'retailer_id', header: 'Retailer ID', type: 'integer', description: 'Internal retailer identifier.' },
      { key: 'market_id', header: 'Market ID', type: 'integer', description: 'Internal market identifier.' },
    ],
    count: count('SELECT COUNT(*) FROM price_observations'),
    rows: paged(
      `SELECT o.id, o.id AS cursor_key, o.observed_at, o.observed_local_date, li.timezone AS time_zone, li.market_name, li.market_code, li.retailer_name,
         li.brand_name, ${OWNERSHIP_SQL('li')} AS ownership, li.product_name, li.product_code, li.sku, li.gtin, li.category_name, li.subcategory_name,
         li.pack_size, li.pack_unit, li.units_per_pack, li.listing_code, o.currency_code, o.regular_price, o.current_price, o.promo_price,
         o.discount_pct, o.is_promo, o.promo_type, o.promo_description, o.promo_starts_on, o.promo_ends_on, o.availability,
         (o.current_price * li.unit_factor / NULLIF(li.content_amount, 0)) AS unit_price, li.content_dimension,
         o.source_method, o.data_class, o.is_demo, o.confidence, o.collection_status, o.observed_basis, o.collected_at, o.source_timestamp,
         ev.reference AS evidence_reference, o.job_id, o.import_batch_id, u.email AS entered_by, COALESCE(o.product_url, li.listing_url) AS url, o.note,
         (ov.observation_id IS NOT NULL) AS voided, ov.reason AS void_reason, ov.voided_at,
         o.listing_id, li.product_id, o.retailer_id, o.market_id
       FROM price_observations o JOIN v_listing_info li ON li.listing_id = o.listing_id
       LEFT JOIN observation_voids ov ON ov.observation_id = o.id
       LEFT JOIN source_evidence ev ON ev.id = o.evidence_id
       LEFT JOIN users u ON u.id = o.entered_by
       WHERE o.id > ?`,
      'o.id',
      (row) => ({
        ...row,
        demo: demo(row),
        pack: row.pack_size ? formatPack(row.pack_size as number, row.pack_unit as string, row.units_per_pack as number) : null,
        promo_type: label(PROMO_TYPE_LABELS as Record<PromoType, string>, row.promo_type),
        availability: label(AVAILABILITY_LABELS as Record<Availability, string>, row.availability),
        unit_basis: row.unit_price === null ? null : unitBasisLabel(row.content_dimension as 'volume' | 'mass' | 'count' | null),
        source_method: label(COLLECTION_METHOD_LABELS as Record<CollectionMethod, string>, row.source_method),
        data_class: label(DATA_CLASS_LABELS as Record<DataClass, string>, row.data_class),
        observed_basis: label(BASIS_LABELS, row.observed_basis),
      }),
    ),
  },
  {
    name: 'Promotions',
    description: 'Promotion episodes derived from consecutive promotional observations of a listing.',
    columns: [
      { key: 'id', header: 'Promotion ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'retailer_name', header: 'Retailer', type: 'text', description: 'Retailer.' },
      { key: 'market_code', header: 'Market', type: 'text', width: 9, description: 'Market code.' },
      { key: 'brand_name', header: 'Brand', type: 'text', width: 18, description: 'Brand.' },
      { key: 'product_name', header: 'Product', type: 'text', width: 40, description: 'Product.' },
      { key: 'listing_code', header: 'Listing code', type: 'text', width: 14, description: 'Listing.' },
      { key: 'promo_type', header: 'Promo type', type: 'text', width: 12, description: 'Promotion mechanic.' },
      { key: 'description', header: 'Promo description', type: 'text', width: 28, description: 'Offer text.' },
      { key: 'status', header: 'Status', type: 'text', width: 9, description: 'active or ended.' },
      { key: 'end_reason', header: 'End reason', type: 'text', width: 18, description: 'Price restored, or a gap in observations.' },
      { key: 'start_local_date', header: 'First seen (local date)', type: 'date', width: 21, description: 'First day the promotion was observed.' },
      { key: 'end_local_date', header: 'Last seen (local date)', type: 'date', width: 21, description: 'Last day the promotion was observed.' },
      { key: 'duration_days', header: 'Duration (days)', type: 'integer', width: 15, description: 'Days from first to last sighting, inclusive.' },
      { key: 'promo_days_observed', header: 'Promo days observed', type: 'integer', width: 19, description: 'Distinct days with a promotional observation.' },
      { key: 'observation_count', header: 'Observations', type: 'integer', width: 13, description: 'Promotional observations in the episode.' },
      { key: 'currency_code', header: 'Currency', type: 'text', width: 10, description: 'Currency.' },
      { key: 'regular_price', header: 'Regular price', type: 'money', description: 'Regular price during the promotion.' },
      { key: 'min_promo_price', header: 'Lowest promo price', type: 'money', width: 18, description: 'Lowest promotional price observed.' },
      { key: 'max_discount_pct', header: 'Highest discount %', type: 'percent', width: 18, description: 'Deepest discount observed.' },
      { key: 'avg_discount_pct', header: 'Average discount %', type: 'percent', width: 18, description: 'Average discount over the episode.' },
      { key: 'stated_start', header: 'Stated start', type: 'date', width: 13, description: 'Start date stated by the retailer.' },
      { key: 'stated_end', header: 'Stated end', type: 'date', width: 13, description: 'End date stated by the retailer.' },
      { key: 'started_at', header: 'First seen at (UTC)', type: 'datetime', description: 'Time of the first promotional observation.' },
      { key: 'ended_at', header: 'Ended at (UTC)', type: 'datetime', description: 'Time the promotion was seen to have ended.' },
      DEMO_COLUMN,
    ],
    count: count('SELECT COUNT(*) FROM promotions'),
    rows: paged(
      `SELECT pr.id, pr.id AS cursor_key, li.listing_code, li.retailer_name, li.market_code, li.brand_name, li.product_name, pr.promo_type, pr.description,
         pr.status, pr.end_reason, pr.started_at, pr.ended_at, pr.start_local_date, pr.end_local_date, pr.duration_days, pr.promo_days_observed,
         pr.observation_count, pr.currency_code, pr.regular_price, pr.min_promo_price, pr.max_discount_pct, pr.avg_discount_pct,
         pr.stated_start, pr.stated_end, pr.is_demo
       FROM promotions pr JOIN v_listing_info li ON li.listing_id = pr.listing_id WHERE pr.id > ?`,
      'pr.id',
      (row) => ({
        ...row,
        demo: demo(row),
        promo_type: label(PROMO_TYPE_LABELS as Record<string, string>, row.promo_type),
        end_reason: row.end_reason === 'price_restored' ? 'Price restored' : row.end_reason === 'observation_gap' ? 'Gap in observations' : null,
      }),
    ),
  },
  {
    name: 'Price changes',
    description: 'Changes detected between consecutive observations of a listing: price, availability, promotion start / end.',
    columns: [
      { key: 'id', header: 'Change ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'occurred_at', header: 'Occurred at (UTC)', type: 'datetime', description: 'Time of the observation that showed the change.' },
      { key: 'occurred_local_date', header: 'Market-local date', type: 'date', width: 16, description: 'Local date of the change.' },
      { key: 'kind', header: 'Change', type: 'text', width: 20, description: 'What changed.' },
      { key: 'direction', header: 'Direction', type: 'text', width: 10, description: 'up or down for price changes.' },
      { key: 'retailer_name', header: 'Retailer', type: 'text', description: 'Retailer.' },
      { key: 'market_code', header: 'Market', type: 'text', width: 9, description: 'Market code.' },
      { key: 'brand_name', header: 'Brand', type: 'text', width: 18, description: 'Brand.' },
      { key: 'product_name', header: 'Product', type: 'text', width: 40, description: 'Product.' },
      { key: 'listing_code', header: 'Listing code', type: 'text', width: 14, description: 'Listing.' },
      { key: 'currency_code', header: 'Currency', type: 'text', width: 10, description: 'Currency.' },
      { key: 'old_price', header: 'Previous price', type: 'money', width: 14, description: 'Selling price before.' },
      { key: 'new_price', header: 'New price', type: 'money', description: 'Selling price after.' },
      { key: 'change_abs', header: 'Change', type: 'money', description: 'Absolute change.' },
      { key: 'change_pct', header: 'Change %', type: 'percent', description: 'Percentage change (discount % for promotion starts).' },
      { key: 'old_availability', header: 'Previous availability', type: 'text', width: 20, description: 'Availability before.' },
      { key: 'new_availability', header: 'New availability', type: 'text', width: 16, description: 'Availability after.' },
      { key: 'observation_id', header: 'Observation ID', type: 'integer', width: 15, description: 'Observation that showed the change.' },
      { key: 'prev_observation_id', header: 'Previous observation ID', type: 'integer', width: 22, description: 'Observation before the change.' },
      DEMO_COLUMN,
    ],
    count: count('SELECT COUNT(*) FROM price_events'),
    rows: paged(
      `SELECT e.id, e.id AS cursor_key, e.occurred_at, e.occurred_local_date, e.kind, e.direction, li.listing_code, li.retailer_name, li.market_code,
         li.brand_name, li.product_name, li.currency_code, e.old_price, e.new_price, e.change_abs, e.change_pct, e.old_availability,
         e.new_availability, e.observation_id, e.prev_observation_id, e.is_demo
       FROM price_events e JOIN v_listing_info li ON li.listing_id = e.listing_id WHERE e.id > ?`,
      'e.id',
      (row) => ({
        ...row,
        demo: demo(row),
        kind: label(EVENT_KIND_LABELS, row.kind),
        old_availability: label(AVAILABILITY_LABELS as Record<string, string>, row.old_availability),
        new_availability: label(AVAILABILITY_LABELS as Record<string, string>, row.new_availability),
      }),
    ),
  },
  {
    name: 'Collection jobs',
    description: 'History of collection runs. Real attempts and simulated demo runs are labelled and never mixed up.',
    columns: [
      { key: 'id', header: 'Job ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'retailer', header: 'Retailer', type: 'text', description: 'Source.' },
      { key: 'market', header: 'Market', type: 'text', width: 9, description: 'Market code.' },
      { key: 'method', header: 'Method', type: 'text', width: 28, description: 'Collection method used.' },
      { key: 'data_class', header: 'Run type', type: 'text', width: 18, description: 'Real collection or Simulated (demo).' },
      { key: 'trigger_type', header: 'Trigger', type: 'text', width: 10, description: 'schedule, manual or retry.' },
      { key: 'status', header: 'Status', type: 'text', width: 15, description: 'queued, running, succeeded, partial, failed, not_configured or cancelled.' },
      { key: 'attempt', header: 'Attempt', type: 'integer', description: 'Attempt number.' },
      { key: 'scheduled_for', header: 'Scheduled for (UTC)', type: 'datetime', description: 'When the run was due.' },
      { key: 'started_at', header: 'Started at (UTC)', type: 'datetime', description: 'Start of the run.' },
      { key: 'finished_at', header: 'Finished at (UTC)', type: 'datetime', description: 'End of the run.' },
      { key: 'listings_total', header: 'Listings', type: 'integer', description: 'Listings in scope.' },
      { key: 'listings_succeeded', header: 'Captured', type: 'integer', description: 'Listings captured.' },
      { key: 'listings_failed', header: 'Failed', type: 'integer', description: 'Listings that failed.' },
      { key: 'listings_missing', header: 'Missing', type: 'integer', description: 'Listings not found at the source.' },
      { key: 'observations_created', header: 'Observations created', type: 'integer', width: 20, description: 'New observations written.' },
      { key: 'duplicates_skipped', header: 'Duplicates skipped', type: 'integer', width: 18, description: 'Identical observations not stored again.' },
      { key: 'error_code', header: 'Error code', type: 'text', width: 18, description: 'Failure code.' },
      { key: 'error_message', header: 'Error message', type: 'text', width: 50, description: 'Failure description.' },
      { key: 'requested_by', header: 'Requested by', type: 'text', width: 26, description: 'User who started a manual run.' },
      DEMO_COLUMN,
    ],
    count: count('SELECT COUNT(*) FROM collection_jobs'),
    rows: paged(
      `SELECT j.id, j.id AS cursor_key, r.name AS retailer, m.code AS market, j.method, j.trigger_type, j.data_class, j.status, j.attempt, j.scheduled_for,
         j.started_at, j.finished_at, j.listings_total, j.listings_succeeded, j.listings_failed, j.listings_missing, j.observations_created,
         j.duplicates_skipped, j.error_code, j.error_message, u.email AS requested_by, j.is_demo
       FROM collection_jobs j JOIN retailers r ON r.id = j.retailer_id JOIN markets m ON m.id = r.market_id
       LEFT JOIN users u ON u.id = j.requested_by WHERE j.id > ?`,
      'j.id',
      (row) => ({
        ...row,
        demo: demo(row),
        method: label(COLLECTION_METHOD_LABELS as Record<string, string>, row.method),
        data_class: row.data_class === 'simulated' ? 'Simulated (demo)' : 'Real collection',
      }),
    ),
  },
  {
    name: 'Alerts',
    description: 'Alert history.',
    columns: [
      { key: 'id', header: 'Alert ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'triggered_at', header: 'Triggered at (UTC)', type: 'datetime', description: 'When the alert was raised.' },
      { key: 'type', header: 'Alert type', type: 'text', width: 34, description: 'Kind of alert.' },
      { key: 'severity', header: 'Severity', type: 'text', width: 10, description: 'info, warning or critical.' },
      { key: 'status', header: 'Status', type: 'text', width: 13, description: 'open, acknowledged or resolved.' },
      { key: 'title', header: 'Title', type: 'text', width: 44, description: 'Headline.' },
      { key: 'message', header: 'Message', type: 'text', width: 70, description: 'Details.' },
      { key: 'retailer', header: 'Retailer', type: 'text', description: 'Retailer concerned.' },
      { key: 'market', header: 'Market', type: 'text', width: 9, description: 'Market code.' },
      { key: 'product', header: 'Product', type: 'text', width: 40, description: 'Product concerned.' },
      { key: 'listing_code', header: 'Listing code', type: 'text', width: 14, description: 'Listing concerned.' },
      { key: 'observation_id', header: 'Observation ID', type: 'integer', width: 15, description: 'Observation that triggered the alert.' },
      { key: 'rule', header: 'Rule', type: 'text', width: 34, description: 'Alert rule.' },
      { key: 'acknowledged_by', header: 'Acknowledged by', type: 'text', width: 26, description: 'User who acknowledged.' },
      { key: 'acknowledged_at', header: 'Acknowledged at (UTC)', type: 'datetime', width: 22, description: 'When it was acknowledged.' },
      { key: 'resolved_by', header: 'Resolved by', type: 'text', width: 26, description: 'User who resolved.' },
      { key: 'resolved_at', header: 'Resolved at (UTC)', type: 'datetime', description: 'When it was resolved.' },
      { key: 'resolution_note', header: 'Resolution note', type: 'text', width: 40, description: 'Note left when resolving.' },
      DEMO_COLUMN,
    ],
    count: count('SELECT COUNT(*) FROM alerts'),
    rows: paged(
      `SELECT a.id, a.id AS cursor_key, a.triggered_at, a.type, a.severity, a.status, a.title, a.message, r.name AS retailer, m.code AS market,
         p.name AS product, l.code AS listing_code, a.observation_id, ar.name AS rule, au.email AS acknowledged_by, a.acknowledged_at,
         ru.email AS resolved_by, a.resolved_at, a.resolution_note, a.is_demo
       FROM alerts a LEFT JOIN retailers r ON r.id = a.retailer_id LEFT JOIN markets m ON m.id = a.market_id
       LEFT JOIN products p ON p.id = a.product_id LEFT JOIN retailer_listings l ON l.id = a.listing_id
       LEFT JOIN alert_rules ar ON ar.id = a.rule_id LEFT JOIN users au ON au.id = a.acknowledged_by LEFT JOIN users ru ON ru.id = a.resolved_by
       WHERE a.id > ?`,
      'a.id',
      (row) => ({ ...row, demo: demo(row), type: ALERT_TYPE_INFO[row.type as AlertType]?.label ?? row.type }),
    ),
  },
  {
    name: 'Alert rules',
    description: 'Configured alert rules and their thresholds.',
    columns: [
      { key: 'id', header: 'Rule ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'name', header: 'Rule', type: 'text', width: 36, description: 'Rule name.' },
      { key: 'type', header: 'Alert type', type: 'text', width: 34, description: 'Kind of alert the rule raises.' },
      { key: 'is_enabled', header: 'Enabled', type: 'boolean', description: 'Whether the rule is active.' },
      { key: 'severity', header: 'Severity', type: 'text', width: 10, description: 'Severity of alerts raised.' },
      { key: 'threshold_pct', header: 'Threshold %', type: 'number', description: 'Percentage threshold.' },
      { key: 'threshold_count', header: 'Threshold count', type: 'integer', width: 15, description: 'Count threshold (consecutive failures).' },
      { key: 'threshold_hours', header: 'Threshold hours', type: 'number', width: 15, description: 'Maximum age in hours.' },
      { key: 'market', header: 'Market scope', type: 'text', width: 14, description: 'Market the rule is limited to.' },
      { key: 'retailer', header: 'Retailer scope', type: 'text', description: 'Retailer the rule is limited to.' },
      { key: 'brand', header: 'Brand scope', type: 'text', description: 'Brand the rule is limited to.' },
      { key: 'category', header: 'Category scope', type: 'text', description: 'Category the rule is limited to.' },
      { key: 'product', header: 'Product scope', type: 'text', width: 36, description: 'Product the rule is limited to.' },
      { key: 'channels', header: 'Channels', type: 'text', width: 24, description: 'Notification channels.' },
      { key: 'cooldown_hours', header: 'Cool-down (hours)', type: 'number', width: 17, description: 'Minimum time between repeated alerts.' },
    ],
    count: count('SELECT COUNT(*) FROM alert_rules'),
    rows: all(
      `SELECT ar.id, ar.name, ar.type, ar.is_enabled, ar.severity, ar.threshold_pct, ar.threshold_count, ar.threshold_hours,
         m.name AS market, r.name AS retailer, b.name AS brand, c.name AS category, p.name AS product, ar.channels, ar.cooldown_hours
       FROM alert_rules ar LEFT JOIN markets m ON m.id = ar.market_id LEFT JOIN retailers r ON r.id = ar.retailer_id
       LEFT JOIN brands b ON b.id = ar.brand_id LEFT JOIN categories c ON c.id = ar.category_id LEFT JOIN products p ON p.id = ar.product_id
       ORDER BY ar.id`,
      (row) => {
        let channels = row.channels;
        try {
          const parsed = JSON.parse(String(row.channels));
          if (Array.isArray(parsed)) channels = parsed.join(', ');
        } catch {
          /* keep raw */
        }
        return { ...row, channels, type: ALERT_TYPE_INFO[row.type as AlertType]?.label ?? row.type };
      },
    ),
  },
  {
    name: 'Import batches',
    description: 'CSV / Excel imports and their outcome.',
    columns: [
      { key: 'id', header: 'Import batch ID', type: 'integer', width: 15, description: 'Internal identifier.' },
      { key: 'kind', header: 'Kind', type: 'text', width: 14, description: 'observations (price history) or products.' },
      { key: 'file_name', header: 'File', type: 'text', width: 36, description: 'Uploaded file.' },
      { key: 'status', header: 'Status', type: 'text', width: 11, description: 'staged, validated, committed, failed or voided.' },
      { key: 'row_count', header: 'Rows', type: 'integer', description: 'Data rows in the file.' },
      { key: 'valid_count', header: 'Valid rows', type: 'integer', description: 'Rows that passed validation.' },
      { key: 'inserted_count', header: 'Inserted', type: 'integer', description: 'Rows written.' },
      { key: 'duplicate_count', header: 'Duplicates', type: 'integer', description: 'Rows skipped because they already existed.' },
      { key: 'error_count', header: 'Errors', type: 'integer', description: 'Rows rejected.' },
      { key: 'created_by', header: 'Uploaded by', type: 'text', width: 26, description: 'User who uploaded the file.' },
      { key: 'created_at', header: 'Uploaded at (UTC)', type: 'datetime', description: 'Upload time.' },
      { key: 'committed_at', header: 'Committed at (UTC)', type: 'datetime', description: 'When the rows were written.' },
      { key: 'voided_by', header: 'Voided by', type: 'text', width: 26, description: 'User who voided the import.' },
      { key: 'voided_at', header: 'Voided at (UTC)', type: 'datetime', description: 'When it was voided.' },
      { key: 'void_reason', header: 'Void reason', type: 'text', width: 40, description: 'Why it was voided.' },
      { key: 'sha256', header: 'File SHA-256', type: 'text', width: 30, description: 'Checksum of the original file.' },
      DEMO_COLUMN,
    ],
    count: count('SELECT COUNT(*) FROM import_batches'),
    rows: all(
      `SELECT b.id, b.kind, b.file_name, b.status, b.row_count, b.valid_count, b.inserted_count, b.duplicate_count, b.error_count,
         cu.email AS created_by, b.created_at, b.committed_at, vu.email AS voided_by, b.voided_at, b.void_reason, b.sha256, b.is_demo
       FROM import_batches b LEFT JOIN users cu ON cu.id = b.created_by LEFT JOIN users vu ON vu.id = b.voided_by ORDER BY b.id`,
      (row) => ({ ...row, demo: demo(row) }),
    ),
  },
  {
    name: 'Source evidence',
    description: 'Evidence records referenced by observations (files, URLs, page extracts, notes).',
    columns: [
      { key: 'id', header: 'Evidence ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'kind', header: 'Kind', type: 'text', width: 15, description: 'Type of evidence.' },
      { key: 'reference', header: 'Reference', type: 'text', width: 50, description: 'URL, file name or description.' },
      { key: 'file_name', header: 'File', type: 'text', width: 30, description: 'Retained file, if any.' },
      { key: 'mime_type', header: 'File type', type: 'text', width: 22, description: 'MIME type.' },
      { key: 'size_bytes', header: 'Size (bytes)', type: 'integer', width: 13, description: 'File size.' },
      { key: 'sha256', header: 'SHA-256', type: 'text', width: 30, description: 'Checksum of the content.' },
      { key: 'excerpt', header: 'Excerpt', type: 'text', width: 50, description: 'Short extract supporting the observation.' },
      { key: 'captured_at', header: 'Captured at (UTC)', type: 'datetime', description: 'When the evidence was captured.' },
      { key: 'uploaded_by', header: 'Uploaded by', type: 'text', width: 26, description: 'User who provided it.' },
      { key: 'note', header: 'Note', type: 'text', width: 40, description: 'Free-text note.' },
      DEMO_COLUMN,
      { key: 'created_at', header: 'Recorded at (UTC)', type: 'datetime', description: 'When the record was created.' },
    ],
    count: count('SELECT COUNT(*) FROM source_evidence'),
    rows: paged(
      `SELECT e.id, e.id AS cursor_key, e.kind, e.reference, e.file_name, e.mime_type, e.size_bytes, e.sha256, e.excerpt, e.captured_at,
         u.email AS uploaded_by, e.note, e.is_demo, e.created_at
       FROM source_evidence e LEFT JOIN users u ON u.id = e.uploaded_by WHERE e.id > ?`,
      'e.id',
      (row) => ({ ...row, demo: demo(row) }),
    ),
  },
  {
    name: 'Users',
    description: 'User accounts and roles (passwords are never exported).',
    adminOnly: true,
    columns: [
      { key: 'id', header: 'User ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'email', header: 'E-mail', type: 'text', width: 30, description: 'Sign-in e-mail.' },
      { key: 'name', header: 'Name', type: 'text', description: 'Display name.' },
      { key: 'role', header: 'Role', type: 'text', width: 15, description: 'Administrator, Analyst or Viewer.' },
      { key: 'is_active', header: 'Active', type: 'boolean', description: 'Whether the account can sign in.' },
      { key: 'last_login_at', header: 'Last sign-in (UTC)', type: 'datetime', description: 'Last successful sign-in.' },
      { key: 'created_at', header: 'Created at (UTC)', type: 'datetime', description: 'When the account was created.' },
    ],
    count: count('SELECT COUNT(*) FROM users'),
    rows: all(
      `SELECT u.id, u.email, u.name, r.name AS role, u.is_active, u.last_login_at, u.created_at
       FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id`,
    ),
  },
  {
    name: 'Audit log',
    description: 'Append-only trail of changes and sign-ins.',
    adminOnly: true,
    columns: [
      { key: 'id', header: 'Entry ID', type: 'integer', description: 'Internal identifier.' },
      { key: 'at', header: 'At (UTC)', type: 'datetime', description: 'When it happened.' },
      { key: 'user_email', header: 'User', type: 'text', width: 30, description: 'Who did it.' },
      { key: 'action', header: 'Action', type: 'text', width: 26, description: 'What was done.' },
      { key: 'entity_type', header: 'Record type', type: 'text', width: 16, description: 'Kind of record affected.' },
      { key: 'entity_id', header: 'Record ID', type: 'text', width: 12, description: 'Identifier of the record.' },
      { key: 'detail', header: 'Detail', type: 'text', width: 70, description: 'Details (JSON).' },
      { key: 'ip', header: 'IP address', type: 'text', width: 16, description: 'Address the request came from.' },
    ],
    count: count('SELECT COUNT(*) FROM audit_log'),
    rows: paged(`SELECT id, id AS cursor_key, at, user_email, action, entity_type, entity_id, detail, ip FROM audit_log WHERE id > ?`, 'id'),
  },
];

export interface DatabaseWorkbookOptions {
  /** Include the Users and Audit log sheets (administrators only). */
  includeAdminSheets: boolean;
  /** "Name <e-mail>" of the person exporting, for the README. */
  generatedBy?: string | null;
}

export interface DatabaseWorkbookResult extends WorkbookSummary {
  observationRows: number;
  generatedAt: string;
}

/** Names of the data sheets a workbook will contain (for tests and documentation). */
export function databaseSheetNames(includeAdminSheets: boolean): string[] {
  return ['README', ...SHEETS.filter((s) => includeAdminSheets || !s.adminOnly).map((s) => s.name), 'Data dictionary'];
}

/** Writes the whole database as one workbook to a file path (atomically) or a writable stream. */
export async function writeDatabaseWorkbook(ctx: AppContext, target: string | Writable, options: DatabaseWorkbookOptions): Promise<DatabaseWorkbookResult> {
  const generatedAt = nowIso();
  const sheets = SHEETS.filter((sheet) => options.includeAdminSheets || !sheet.adminOnly);
  const counts = sheets.map((sheet) => ({ sheet, rows: sheet.count(ctx) }));
  const observationRows = counts.find((c) => c.sheet.name === 'Price observations')?.rows ?? 0;
  const demoObservations = ctx.db.scalar<number>('SELECT COUNT(*) FROM price_observations WHERE is_demo = 1') ?? 0;
  const demoProducts = ctx.db.scalar<number>('SELECT COUNT(*) FROM products WHERE is_demo = 1') ?? 0;
  const demoRetailers = ctx.db.scalar<number>('SELECT COUNT(*) FROM retailers WHERE is_demo = 1') ?? 0;
  const voided = ctx.db.scalar<number>('SELECT COUNT(*) FROM observation_voids') ?? 0;
  const fmt = (n: number) => n.toLocaleString('en-US');

  const notes = [
    'Price Intelligence OS — database workbook',
    `Generated ${generatedAt.replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC${options.generatedBy ? ` by ${options.generatedBy}` : ''}.`,
    'This workbook is a complete, read-only copy of the database. The relational database remains the system of record: editing this file does not change the database. To load data, use Import (CSV or Excel) in the application.',
  ];
  if (demoObservations > 0 || demoProducts > 0 || demoRetailers > 0) {
    notes.push(
      `DEMO DATA NOTICE: ${fmt(demoObservations)} of ${fmt(observationRows)} price observations, ${fmt(demoProducts)} products and ${fmt(demoRetailers)} retailers are illustrative DEMO records with fictional prices. They are marked "DEMO" in the "Demo data" column of every sheet and are NOT real market observations.`,
    );
  }
  notes.push(
    'All timestamps are in UTC. "Market-local date" is the calendar date in the time zone of the market.',
    `Price observations are never changed or deleted. ${fmt(voided)} observation(s) were voided (corrections): they stay in the "Price observations" sheet, flagged in the "Voided" column, and are excluded from analytics.`,
    'Not included by design: passwords, sessions, integration credentials and connector settings.',
  );

  const specs: SheetSpec[] = [
    {
      name: 'README',
      notes,
      columns: [
        { key: 'sheet', header: 'Sheet', type: 'text', width: 24 },
        { key: 'rows', header: 'Rows', type: 'integer', width: 12 },
        { key: 'description', header: 'What it contains', type: 'text', width: 110 },
      ],
      rows: [
        ...counts.map((c) => ({ sheet: c.sheet.name, rows: c.rows, description: c.sheet.description })),
        { sheet: 'Data dictionary', rows: null, description: 'Meaning of every column in every sheet.' },
      ],
    },
    ...sheets.map((sheet): SheetSpec => ({ name: sheet.name, columns: sheet.columns, rows: sheet.rows(ctx) })),
    {
      name: 'Data dictionary',
      columns: [
        { key: 'sheet', header: 'Sheet', type: 'text', width: 24 },
        { key: 'column', header: 'Column', type: 'text', width: 30 },
        { key: 'description', header: 'Description', type: 'text', width: 110 },
      ],
      rows: sheets.flatMap((sheet) => sheet.columns.map((column) => ({ sheet: sheet.name, column: column.header, description: column.description }))),
    },
  ];
  const summary = await writeXlsx(specs, target, { title: 'Price Intelligence OS — database' });
  return { ...summary, observationRows, generatedAt };
}

// ---------------------------------------------------------------------------------------------
// Excel mirror: an always-current copy of the workbook on disk
// ---------------------------------------------------------------------------------------------
const MIRROR_KEY = 'excel_mirror';
export const MIRROR_FILE_NAME = 'price-intelligence-database.xlsx';

interface MirrorState {
  generated_at: string | null;
  size_bytes: number | null;
  observation_rows: number | null;
  sheets: Array<{ name: string; rows: number }>;
  duration_ms: number | null;
  fingerprint: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

const EMPTY_STATE: MirrorState = {
  generated_at: null,
  size_bytes: null,
  observation_rows: null,
  sheets: [],
  duration_ms: null,
  fingerprint: null,
  last_error: null,
  last_error_at: null,
};

const inFlight = new WeakMap<AppContext, Promise<DatabaseMirrorStatus>>();

export function exportsDir(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'exports');
}

export function mirrorPath(ctx: AppContext): string {
  return path.join(exportsDir(ctx), MIRROR_FILE_NAME);
}

export function mirrorEnabled(): boolean {
  return !['off', 'false', '0', 'no'].includes((process.env.PIOS_EXCEL_MIRROR ?? 'on').toLowerCase());
}

export function mirrorIntervalMinutes(): number {
  const minutes = Number(process.env.PIOS_EXCEL_MIRROR_MINUTES);
  return Number.isFinite(minutes) && minutes >= 1 ? Math.floor(minutes) : 60;
}

function readState(ctx: AppContext): MirrorState {
  const row = ctx.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [MIRROR_KEY]);
  if (!row) return { ...EMPTY_STATE };
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(row.value) as Partial<MirrorState>) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function writeState(ctx: AppContext, state: MirrorState): void {
  ctx.db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [MIRROR_KEY, JSON.stringify(state), nowIso()],
  );
}

/** Changes whenever data shown in the workbook changes. */
function fingerprint(ctx: AppContext): string {
  const row = ctx.db.get<Row>(
    `SELECT
       (SELECT COALESCE(MAX(id), 0) FROM price_observations) AS a,
       (SELECT COUNT(*) FROM price_observations) AS b,
       (SELECT COUNT(*) FROM observation_voids) AS c,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM products) AS d,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM retailer_listings) AS e,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM retailers) AS f,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM competitor_mappings) AS g,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM brands) AS h,
       (SELECT COALESCE(MAX(id), 0) FROM exchange_rates) AS i,
       (SELECT COALESCE(MAX(id), 0) || ':' || COUNT(*) FROM alerts) AS j,
       (SELECT COALESCE(MAX(id), 0) FROM collection_jobs) AS k,
       (SELECT COALESCE(MAX(id), 0) FROM import_batches) AS l`,
  );
  return Object.values(row ?? {}).join('|');
}

export function getMirrorStatus(ctx: AppContext): DatabaseMirrorStatus {
  const state = readState(ctx);
  const file = mirrorPath(ctx);
  const exists = fs.existsSync(file);
  return {
    enabled: mirrorEnabled(),
    path: file,
    exists,
    generated_at: exists ? state.generated_at : null,
    size_bytes: exists ? fs.statSync(file).size : null,
    observation_rows: exists ? state.observation_rows : null,
    sheets: exists ? state.sheets : [],
    duration_ms: exists ? state.duration_ms : null,
    stale: !exists || state.fingerprint !== fingerprint(ctx),
    generating: inFlight.has(ctx),
    interval_minutes: mirrorIntervalMinutes(),
    last_error: state.last_error,
    last_error_at: state.last_error_at,
  };
}

/**
 * Regenerates the mirror workbook now. Concurrent calls share one generation; the file is replaced
 * atomically, so anyone opening it always sees a complete workbook.
 */
export function refreshMirror(ctx: AppContext): Promise<DatabaseMirrorStatus> {
  const running = inFlight.get(ctx);
  if (running) return running;
  const promise = (async () => {
    const started = Date.now();
    // Taken before writing: anything that changes while the workbook is produced leaves the mirror "stale".
    const print = fingerprint(ctx);
    try {
      const result = await writeDatabaseWorkbook(ctx, mirrorPath(ctx), { includeAdminSheets: false });
      writeState(ctx, {
        generated_at: result.generatedAt,
        size_bytes: result.bytes,
        observation_rows: result.observationRows,
        sheets: result.sheets,
        duration_ms: Date.now() - started,
        fingerprint: print,
        last_error: null,
        last_error_at: null,
      });
    } catch (err) {
      ctx.log.error({ err }, 'Excel mirror generation failed');
      writeState(ctx, { ...readState(ctx), last_error: (err as Error).message, last_error_at: nowIso() });
      throw err;
    } finally {
      inFlight.delete(ctx);
    }
    return getMirrorStatus(ctx);
  })();
  inFlight.set(ctx, promise);
  return promise;
}

/**
 * Called on every scheduler tick: creates the mirror when it does not exist yet and refreshes it when the
 * database changed and the last copy is older than the configured interval.
 */
export function maybeAutoRefreshMirror(ctx: AppContext, now: Date = new Date()): Promise<DatabaseMirrorStatus> | null {
  if (!mirrorEnabled() || inFlight.has(ctx)) return null;
  const state = readState(ctx);
  const exists = fs.existsSync(mirrorPath(ctx));
  if (exists) {
    const age = state.generated_at ? now.getTime() - Date.parse(state.generated_at) : Number.POSITIVE_INFINITY;
    if (age < mirrorIntervalMinutes() * 60_000) return null;
    if (state.fingerprint === fingerprint(ctx)) return null;
  } else if (state.last_error_at && now.getTime() - Date.parse(state.last_error_at) < 10 * 60_000) {
    // A failed first attempt is retried after a pause, not on every tick.
    return null;
  }
  const promise = refreshMirror(ctx);
  promise.catch(() => undefined);
  return promise;
}

/** Removes temporary export files left behind by an interrupted download or generation. */
export function cleanExportTemp(ctx: AppContext, olderThanMs = 60 * 60_000): void {
  for (const dir of [path.join(exportsDir(ctx), 'tmp'), exportsDir(ctx)]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.tmp') && !name.startsWith('export-')) continue;
      const file = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > olderThanMs) fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
