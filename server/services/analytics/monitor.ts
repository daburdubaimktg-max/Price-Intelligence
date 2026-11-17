/** Live price monitor (latest known price per listing) and the stream of detected price events. */
import type { AppContext } from '../../context.ts';
import type { SqlValue } from '../../db/sqlite.ts';
import { placeholders } from '../../db/sqlite.ts';
import type { Page } from '../../lib/http.ts';
import { orderBy } from '../../lib/http.ts';
import { listingConditions, type ObsFilter } from '../obs-filter.ts';
import { ageHoursSql, STALE_HOURS_SQL } from './common.ts';
import type { MonitorRow, MonitorFacets, PriceEventRow } from '../../../shared/api/analytics.ts';
export type { MonitorRow, MonitorFacets, PriceEventRow };

export interface MonitorOptions {
  promo?: boolean;
  availability?: string[];
  dataClasses?: string[];
  stale?: boolean;
  neverObserved?: boolean;
  changedWithinHours?: number;
  direction?: 'up' | 'down';
  priceMin?: number;
  priceMax?: number;
  sort?: string;
}

const MONITOR_SELECT = `
  li.listing_id, li.listing_code, li.listing_title, li.listing_url, li.external_id, li.match_status,
  li.product_id, li.product_code, li.product_name, li.sku, li.brand_id, li.brand_name, li.ownership,
  li.category_name, li.subcategory_name, li.variant_name, li.pack_size, li.pack_unit, li.units_per_pack, li.content_dimension,
  li.retailer_id, li.retailer_name, li.market_id, li.market_code, li.market_name, li.timezone, li.currency_code,
  li.collection_method, li.collection_frequency, li.retailer_enabled, li.listing_is_demo AS is_demo,
  o.id AS observation_id, o.regular_price, o.current_price, o.promo_price, o.discount_pct, o.is_promo, o.promo_type,
  o.promo_description, o.promo_ends_on, o.availability,
  (o.current_price * li.unit_factor / NULLIF(li.content_amount, 0)) AS unit_price,
  o.observed_at, o.collected_at, o.source_method, o.data_class, o.confidence,
  COALESCE(s.obs_count, 0) AS obs_count, s.first_observed_at,
  po.current_price AS prev_price, po.observed_at AS prev_observed_at,
  pe.old_price AS change_old_price, pe.new_price AS change_new_price, pe.change_abs, pe.change_pct,
  pe.direction AS change_direction, pe.occurred_at AS changed_at,
  ${ageHoursSql('s.last_observed_at')} AS age_hours,
  ${STALE_HOURS_SQL} AS stale_after_hours,
  (CASE WHEN s.last_observed_at IS NULL OR ${ageHoursSql('s.last_observed_at')} > ${STALE_HOURS_SQL} THEN 1 ELSE 0 END) AS is_stale`;

const MONITOR_FROM = `
  FROM v_listing_info li
  LEFT JOIN listing_state s ON s.listing_id = li.listing_id
  LEFT JOIN price_observations o ON o.id = s.latest_obs_id
  LEFT JOIN price_observations po ON po.id = s.prev_obs_id
  LEFT JOIN price_events pe ON pe.id = (
    SELECT e.id FROM price_events e WHERE e.listing_id = li.listing_id AND e.kind = 'price_change'
    ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1)`;

const MONITOR_SORTS: Record<string, string> = {
  product: 'li.product_name COLLATE NOCASE',
  brand: 'li.brand_name COLLATE NOCASE',
  retailer: 'li.retailer_name COLLATE NOCASE',
  market: 'li.market_name COLLATE NOCASE',
  price: 'o.current_price',
  unit_price: 'unit_price',
  discount: 'o.discount_pct',
  change: 'pe.change_pct',
  changed_at: 'pe.occurred_at',
  observed_at: 's.last_observed_at',
};

function monitorWhere(filter: ObsFilter, options: MonitorOptions): { sql: string; params: SqlValue[] } {
  const { conditions, params } = listingConditions(filter);
  conditions.push('li.listing_active = 1', 'li.retailer_active = 1');
  if (options.promo !== undefined) {
    conditions.push('COALESCE(o.is_promo, 0) = ?');
    params.push(options.promo ? 1 : 0);
  }
  if (options.availability?.length) {
    conditions.push(`o.availability IN (${placeholders(options.availability.length)})`);
    params.push(...options.availability);
  }
  if (options.dataClasses?.length) {
    conditions.push(`o.data_class IN (${placeholders(options.dataClasses.length)})`);
    params.push(...options.dataClasses);
  }
  if (options.stale !== undefined) {
    conditions.push(
      options.stale
        ? `(s.last_observed_at IS NULL OR ${ageHoursSql('s.last_observed_at')} > ${STALE_HOURS_SQL})`
        : `(s.last_observed_at IS NOT NULL AND ${ageHoursSql('s.last_observed_at')} <= ${STALE_HOURS_SQL})`,
    );
  }
  if (options.neverObserved) conditions.push('s.last_observed_at IS NULL');
  if (options.changedWithinHours !== undefined) {
    conditions.push(`pe.occurred_at >= ?`);
    params.push(new Date(Date.now() - options.changedWithinHours * 3_600_000).toISOString());
  }
  if (options.direction) {
    conditions.push('pe.direction = ?');
    params.push(options.direction);
  }
  if (options.priceMin !== undefined) {
    conditions.push('o.current_price >= ?');
    params.push(options.priceMin);
  }
  if (options.priceMax !== undefined) {
    conditions.push('o.current_price <= ?');
    params.push(options.priceMax);
  }
  return { sql: `WHERE ${conditions.join(' AND ')}`, params };
}

export function monitor(ctx: AppContext, filter: ObsFilter, options: MonitorOptions, page: Page): { rows: MonitorRow[]; total: number; facets: MonitorFacets } {
  const where = monitorWhere(filter, options);
  const total = ctx.db.scalar<number>(`SELECT COUNT(*) ${MONITOR_FROM} ${where.sql}`, where.params) ?? 0;
  const order = orderBy(options.sort, MONITOR_SORTS, 's.last_observed_at DESC');
  const rows = ctx.db.all<MonitorRow>(
    `SELECT ${MONITOR_SELECT} ${MONITOR_FROM} ${where.sql}
     ORDER BY ${order} NULLS LAST, li.listing_id LIMIT ? OFFSET ?`,
    [...where.params, page.pageSize, page.offset],
  );
  // Facets describe the whole scope (dimension filters only), so the chips stay stable while toggling them.
  const base = monitorWhere(filter, {});
  const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const facets = ctx.db.get<MonitorFacets>(
    `SELECT COUNT(*) AS listings,
       SUM(s.last_observed_at IS NOT NULL) AS observed,
       SUM(s.last_observed_at IS NULL) AS never_observed,
       SUM(CASE WHEN s.last_observed_at IS NULL OR ${ageHoursSql('s.last_observed_at')} > ${STALE_HOURS_SQL} THEN 1 ELSE 0 END) AS stale,
       SUM(COALESCE(o.is_promo, 0)) AS on_promo,
       SUM(CASE WHEN o.availability = 'out_of_stock' THEN 1 ELSE 0 END) AS out_of_stock,
       SUM(CASE WHEN pe.occurred_at >= ? THEN 1 ELSE 0 END) AS changed_24h,
       SUM(CASE WHEN pe.occurred_at >= ? AND pe.direction = 'up' THEN 1 ELSE 0 END) AS increases_24h,
       SUM(CASE WHEN pe.occurred_at >= ? AND pe.direction = 'down' THEN 1 ELSE 0 END) AS decreases_24h,
       MAX(s.last_observed_at) AS latest_observation_at,
       SUM(li.listing_is_demo) AS demo_listings
     ${MONITOR_FROM} ${base.sql}`,
    [dayAgo, dayAgo, dayAgo, ...base.params],
  )!;
  for (const key of Object.keys(facets) as Array<keyof MonitorFacets>) {
    if (facets[key] === null && key !== 'latest_observation_at') (facets as unknown as Record<string, unknown>)[key] = 0;
  }
  return { rows, total, facets };
}

/** Latest snapshot rows for an explicit set of listings (used by product pages and comparisons). */
export function monitorRowsFor(ctx: AppContext, filter: ObsFilter): MonitorRow[] {
  const where = monitorWhere(filter, {});
  return ctx.db.all<MonitorRow>(
    `SELECT ${MONITOR_SELECT} ${MONITOR_FROM} ${where.sql} ORDER BY li.market_name, li.retailer_name, li.product_name`,
    where.params,
  );
}

export interface EventOptions {
  kinds?: Array<PriceEventRow['kind']>;
  direction?: 'up' | 'down';
  /** Minimum absolute % change (price_change events). */
  minAbsPct?: number;
  /** ISO instant lower bound (in addition to the filter's date range). */
  since?: string;
  limit?: number;
  offset?: number;
  sort?: 'recent' | 'largest';
}

const EVENT_SELECT = `
  e.id, e.kind, e.direction, e.old_price, e.new_price, e.change_abs, e.change_pct, e.old_availability, e.new_availability,
  e.occurred_at, e.occurred_local_date, e.observation_id, e.prev_observation_id, e.listing_id,
  li.product_id, li.product_name, li.brand_name, li.ownership, li.pack_size, li.pack_unit, li.units_per_pack,
  li.retailer_id, li.retailer_name, li.market_id, li.market_code, li.market_name, li.timezone, li.currency_code,
  o.data_class, o.source_method, o.is_promo, o.promo_type, o.promo_description, o.discount_pct, e.is_demo`;

export function priceEvents(ctx: AppContext, filter: ObsFilter, options: EventOptions = {}): { rows: PriceEventRow[]; total: number } {
  const { conditions, params } = listingConditions(filter);
  const kinds = options.kinds?.length ? options.kinds : (['price_change'] as const);
  conditions.push(`e.kind IN (${placeholders(kinds.length)})`);
  params.push(...kinds);
  if (filter.date_from) {
    conditions.push('e.occurred_local_date >= ?');
    params.push(filter.date_from);
  }
  if (filter.date_to) {
    conditions.push('e.occurred_local_date <= ?');
    params.push(filter.date_to);
  }
  if (options.since) {
    conditions.push('e.occurred_at >= ?');
    params.push(options.since);
  }
  if (options.direction) {
    conditions.push('e.direction = ?');
    params.push(options.direction);
  }
  if (options.minAbsPct !== undefined) {
    conditions.push('ABS(e.change_pct) >= ?');
    params.push(options.minAbsPct);
  }
  const from = `FROM price_events e JOIN v_listing_info li ON li.listing_id = e.listing_id JOIN price_observations o ON o.id = e.observation_id`;
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = ctx.db.scalar<number>(`SELECT COUNT(*) ${from} ${where}`, params) ?? 0;
  const order = options.sort === 'largest' ? 'ABS(e.change_pct) DESC, e.occurred_at DESC' : 'e.occurred_at DESC, e.id DESC';
  const rows = ctx.db.all<PriceEventRow>(`SELECT ${EVENT_SELECT} ${from} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [
    ...params,
    Math.min(options.limit ?? 50, 1000),
    options.offset ?? 0,
  ]);
  return { rows, total };
}

/** Daily counts of price increases / decreases (for the movement chart). */
export function eventCountsByDay(
  ctx: AppContext,
  filter: ObsFilter,
): Array<{ date: string; increases: number; decreases: number; avg_increase_pct: number | null; avg_decrease_pct: number | null }> {
  const { conditions, params } = listingConditions(filter);
  conditions.push(`e.kind = 'price_change'`);
  if (filter.date_from) {
    conditions.push('e.occurred_local_date >= ?');
    params.push(filter.date_from);
  }
  if (filter.date_to) {
    conditions.push('e.occurred_local_date <= ?');
    params.push(filter.date_to);
  }
  return ctx.db.all(
    `SELECT e.occurred_local_date AS date,
       SUM(e.direction = 'up') AS increases, SUM(e.direction = 'down') AS decreases,
       ROUND(AVG(CASE WHEN e.direction = 'up' THEN e.change_pct END), 2) AS avg_increase_pct,
       ROUND(AVG(CASE WHEN e.direction = 'down' THEN e.change_pct END), 2) AS avg_decrease_pct
     FROM price_events e JOIN v_listing_info li ON li.listing_id = e.listing_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY e.occurred_local_date ORDER BY e.occurred_local_date`,
    params,
  );
}
