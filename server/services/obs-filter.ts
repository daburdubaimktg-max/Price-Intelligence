/**
 * One filter model for every query over price observations — the history explorer, the live monitor,
 * exports, reports and the assistant all go through it, so "brand = X, retailer = Y, last 30 days"
 * means exactly the same thing everywhere.
 */
import type { SqlValue } from '../db/sqlite.ts';
import { placeholders } from '../db/sqlite.ts';
import { badRequest } from '../lib/errors.ts';
import { idList, likePattern, optBool, optNumber, strList } from '../lib/http.ts';
import { isIsoDate } from '../lib/time.ts';
import { AVAILABILITY, COLLECTION_METHODS, DATA_CLASSES, DEAL_TAG_LABELS, DEAL_TAGS, isDealTag, type DealTag } from '../../shared/constants.ts';

export interface ObsFilter {
  market_ids?: number[];
  country_codes?: string[];
  retailer_ids?: number[];
  brand_ids?: number[];
  product_ids?: number[];
  listing_ids?: number[];
  /** Matches products whose category or subcategory is one of these. */
  category_ids?: number[];
  ownership?: 'own' | 'competitor';
  /** SKU / barcode / product code / retailer item id (partial match). */
  sku?: string;
  /** Free text over product, brand, retailer and listing title. */
  search?: string;
  /** Inclusive range on the market-local calendar date. */
  date_from?: string;
  date_to?: string;
  price_min?: number;
  price_max?: number;
  promo?: boolean;
  availability?: string[];
  data_classes?: string[];
  source_methods?: string[];
  /** Observations carrying at least one of these deal tags. */
  tags?: DealTag[];
  /** Include listings not yet matched to a canonical product (excluded by default). */
  include_unmatched?: boolean;
}

/**
 * FROM clause used with the filter. `o` = observation (voided rows excluded), `li` = listing info.
 * Use OBS_FROM_ALL to include voided observations (ledger audits).
 */
export const OBS_FROM = `FROM v_observations o JOIN v_listing_info li ON li.listing_id = o.listing_id`;
export const OBS_FROM_ALL = `FROM price_observations o JOIN v_listing_info li ON li.listing_id = o.listing_id`;

/** Unit price expression: price per 100 ml / 100 g / unit (NULL when pack content is unknown). */
export const UNIT_PRICE_SQL = `(o.current_price * li.unit_factor / NULLIF(li.content_amount, 0))`;

/** Canonical column list for an observation as returned by the API. */
export const OBS_RECORD_COLUMNS = `
  o.id, o.listing_id, li.listing_code, li.listing_title, li.listing_url, li.external_id,
  li.product_id, li.product_code, li.product_name, li.sku, li.gtin, li.image_url,
  li.brand_id, li.brand_name, li.ownership, li.category_id, li.category_name, li.subcategory_id, li.subcategory_name,
  o.retailer_id, li.retailer_name, o.market_id, li.market_code, li.market_name, li.timezone, li.country_code,
  o.currency_code, li.pack_size, li.pack_unit, li.units_per_pack, li.variant_name, li.content_amount, li.content_dimension,
  o.regular_price, o.current_price, o.promo_price, o.discount_pct, o.is_promo, o.promo_type, o.promo_description,
  o.promo_starts_on, o.promo_ends_on, o.availability, o.product_url,
  o.observed_at, o.observed_basis, o.observed_local_date, o.collected_at, o.source_timestamp,
  o.source_method, o.data_class, o.collection_status, o.confidence, o.evidence_id, o.job_id, o.import_batch_id,
  o.entered_by, o.note, o.is_demo,
  o.tags, o.tag_text, o.rating, o.review_count, o.sales_rank, o.sales_rank_label, o.seller_name,
  ${UNIT_PRICE_SQL} AS unit_price`;

/** Signal columns of an observation, for queries that build their own column list (alias defaults to `o`). */
export const obsSignalColumns = (alias = 'o') =>
  `${alias}.tags, ${alias}.tag_text, ${alias}.rating, ${alias}.review_count, ${alias}.sales_rank, ${alias}.sales_rank_label, ${alias}.seller_name`;

/**
 * SQL condition: the observation `alias` carries at least one of `tags`. The leading `tags <> '[]'` lets
 * SQLite use the partial index of tagged observations and skips the JSON work for untagged rows.
 */
export function tagCondition(tags: readonly DealTag[], alias = 'o'): { sql: string; params: SqlValue[] } {
  return {
    sql: `(${alias}.tags <> '[]' AND EXISTS (SELECT 1 FROM json_each(${alias}.tags) WHERE value IN (${placeholders(tags.length)})))`,
    params: [...tags],
  };
}

/** Reads a `tag=<key,key>` query parameter. Unknown keys are refused, so a typo never widens the result. */
export function parseTagParam(value: unknown): DealTag[] | undefined {
  const keys = strList(value)?.map((k) => k.toLowerCase());
  if (!keys?.length) return undefined;
  for (const key of keys) {
    if (!isDealTag(key)) throw badRequest(`Unknown deal tag "${key}". Use one or more of: ${DEAL_TAGS.join(', ')}`);
  }
  return DEAL_TAGS.filter((tag) => keys.includes(tag));
}

export function parseObsFilter(query: Record<string, unknown>): ObsFilter {
  const filter: ObsFilter = {
    market_ids: idList(query.market_id),
    country_codes: strList(query.country)?.map((c) => c.toUpperCase()),
    retailer_ids: idList(query.retailer_id),
    brand_ids: idList(query.brand_id),
    product_ids: idList(query.product_id),
    listing_ids: idList(query.listing_id),
    category_ids: idList(query.category_id),
    price_min: optNumber(query.price_min, 'minimum price'),
    price_max: optNumber(query.price_max, 'maximum price'),
    promo: optBool(query.promo),
    include_unmatched: optBool(query.include_unmatched),
  };
  if (query.ownership === 'own' || query.ownership === 'competitor') filter.ownership = query.ownership;
  if (typeof query.sku === 'string' && query.sku.trim()) filter.sku = query.sku.trim();
  const q = query.q ?? query.search;
  if (typeof q === 'string' && q.trim()) filter.search = q.trim();
  for (const key of ['from', 'to'] as const) {
    const value = query[key];
    if (value === undefined || value === null || value === '') continue;
    if (!isIsoDate(value)) throw badRequest(`"${key}" must be a date in YYYY-MM-DD format`);
    if (key === 'from') filter.date_from = value;
    else filter.date_to = value;
  }
  if (filter.date_from && filter.date_to && filter.date_from > filter.date_to) {
    throw badRequest('The start date is after the end date');
  }
  const availability = strList(query.availability)?.filter((a) => (AVAILABILITY as readonly string[]).includes(a));
  if (availability?.length) filter.availability = availability;
  const classes = strList(query.data_class)?.filter((c) => (DATA_CLASSES as readonly string[]).includes(c));
  if (classes?.length) filter.data_classes = classes;
  const methods = strList(query.source_method)?.filter((m) => (COLLECTION_METHODS as readonly string[]).includes(m));
  if (methods?.length) filter.source_methods = methods;
  const tags = parseTagParam(query.tag);
  if (tags) filter.tags = tags;
  return filter;
}

export interface WhereClause {
  /** Starts with "WHERE …" (always non-empty). */
  sql: string;
  params: SqlValue[];
}

/** Conditions on the listing dimension only (no observation columns) — usable without joining observations. */
export function listingConditions(filter: ObsFilter): { conditions: string[]; params: SqlValue[] } {
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  const inList = (column: string, values: Array<number | string> | undefined) => {
    if (!values?.length) return;
    conditions.push(`${column} IN (${placeholders(values.length)})`);
    params.push(...values);
  };
  inList('li.market_id', filter.market_ids);
  inList('li.country_code', filter.country_codes);
  inList('li.retailer_id', filter.retailer_ids);
  inList('li.brand_id', filter.brand_ids);
  inList('li.product_id', filter.product_ids);
  inList('li.listing_id', filter.listing_ids);
  if (filter.category_ids?.length) {
    const ph = placeholders(filter.category_ids.length);
    conditions.push(`(li.category_id IN (${ph}) OR li.subcategory_id IN (${ph}))`);
    params.push(...filter.category_ids, ...filter.category_ids);
  }
  if (filter.ownership) {
    conditions.push('li.ownership = ?');
    params.push(filter.ownership);
  }
  if (filter.sku) {
    const p = likePattern(filter.sku);
    conditions.push(`(li.sku LIKE ? ESCAPE '\\' OR li.gtin LIKE ? ESCAPE '\\' OR li.product_code LIKE ? ESCAPE '\\' OR li.external_id LIKE ? ESCAPE '\\' OR li.listing_code LIKE ? ESCAPE '\\')`);
    params.push(p, p, p, p, p);
  }
  if (filter.search) {
    const p = likePattern(filter.search);
    conditions.push(`(li.product_name LIKE ? ESCAPE '\\' OR li.brand_name LIKE ? ESCAPE '\\' OR li.retailer_name LIKE ? ESCAPE '\\' OR li.listing_title LIKE ? ESCAPE '\\' OR li.sku LIKE ? ESCAPE '\\')`);
    params.push(p, p, p, p, p);
  }
  if (!filter.include_unmatched) conditions.push('li.product_id IS NOT NULL');
  return { conditions, params };
}

export function obsWhere(filter: ObsFilter, extra: { conditions?: string[]; params?: SqlValue[] } = {}): WhereClause {
  const { conditions, params } = listingConditions(filter);
  const inList = (column: string, values: Array<number | string> | undefined) => {
    if (!values?.length) return;
    conditions.push(`${column} IN (${placeholders(values.length)})`);
    params.push(...values);
  };
  if (filter.date_from) {
    conditions.push('o.observed_local_date >= ?');
    params.push(filter.date_from);
  }
  if (filter.date_to) {
    conditions.push('o.observed_local_date <= ?');
    params.push(filter.date_to);
  }
  if (filter.price_min !== undefined) {
    conditions.push('o.current_price >= ?');
    params.push(filter.price_min);
  }
  if (filter.price_max !== undefined) {
    conditions.push('o.current_price <= ?');
    params.push(filter.price_max);
  }
  if (filter.promo !== undefined) {
    conditions.push('o.is_promo = ?');
    params.push(filter.promo ? 1 : 0);
  }
  inList('o.availability', filter.availability);
  inList('o.data_class', filter.data_classes);
  inList('o.source_method', filter.source_methods);
  if (filter.tags?.length) {
    const tagged = tagCondition(filter.tags);
    conditions.push(tagged.sql);
    params.push(...tagged.params);
  }
  if (extra.conditions?.length) {
    conditions.push(...extra.conditions);
    params.push(...(extra.params ?? []));
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : 'WHERE 1 = 1', params };
}

/** Human-readable description of a filter, for report headers and export provenance sheets. */
export function describeFilter(filter: ObsFilter, names: { [K in 'markets' | 'retailers' | 'brands' | 'products' | 'categories']?: Map<number, string> } = {}): string[] {
  const lines: string[] = [];
  const list = (label: string, ids: number[] | undefined, map?: Map<number, string>) => {
    if (ids?.length) lines.push(`${label}: ${ids.map((id) => map?.get(id) ?? `#${id}`).join(', ')}`);
  };
  list('Markets', filter.market_ids, names.markets);
  if (filter.country_codes?.length) lines.push(`Countries: ${filter.country_codes.join(', ')}`);
  list('Retailers', filter.retailer_ids, names.retailers);
  list('Brands', filter.brand_ids, names.brands);
  list('Products', filter.product_ids, names.products);
  list('Categories', filter.category_ids, names.categories);
  if (filter.ownership) lines.push(`Ownership: ${filter.ownership === 'own' ? 'Own brands' : 'Competitors'}`);
  if (filter.sku) lines.push(`SKU contains: ${filter.sku}`);
  if (filter.search) lines.push(`Search: ${filter.search}`);
  if (filter.date_from || filter.date_to) lines.push(`Dates: ${filter.date_from ?? 'beginning'} to ${filter.date_to ?? 'latest'}`);
  if (filter.price_min !== undefined || filter.price_max !== undefined) {
    lines.push(`Price range: ${filter.price_min ?? '0'} – ${filter.price_max ?? 'any'}`);
  }
  if (filter.promo !== undefined) lines.push(`Promotion status: ${filter.promo ? 'on promotion' : 'not on promotion'}`);
  if (filter.availability?.length) lines.push(`Availability: ${filter.availability.join(', ')}`);
  if (filter.data_classes?.length) lines.push(`Data source class: ${filter.data_classes.join(', ')}`);
  if (filter.source_methods?.length) lines.push(`Source method: ${filter.source_methods.join(', ')}`);
  if (filter.tags?.length) lines.push(`Deal tags (any of): ${filter.tags.map((tag) => DEAL_TAG_LABELS[tag]).join(', ')}`);
  return lines;
}
