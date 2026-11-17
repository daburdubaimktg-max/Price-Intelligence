/** Shared building blocks for analytics: statistics, date ranges, staleness and listing metadata. */
import type { AppContext } from '../../context.ts';
import { placeholders } from '../../db/sqlite.ts';
import { addDays, localDate } from '../../lib/time.ts';
import { FREQUENCY_HOURS, MANUAL_STALE_HOURS, STALE_MULTIPLIER } from '../../../shared/constants.ts';
import { unitBasisLabel } from '../../../shared/units.ts';
import type { ContentDimension } from '../../../shared/constants.ts';
import type { Stats, DateRange, DemoNote } from '../../../shared/api/analytics.ts';
export type { Stats, DateRange, DemoNote };

export const round = (value: number | null | undefined, dp = 2): number | null => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
};

/** Descriptive statistics of a chronologically ordered series. Null when empty. */
export function computeStats(values: number[]): Stats | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const n = xs.length;
  const sum = xs.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const variance = n > 1 ? xs.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  const first = xs[0]!;
  const last = xs[n - 1]!;
  return {
    n,
    avg: round(avg, 4)!,
    median: round(median, 4)!,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    stddev: round(stddev, 4)!,
    volatility_pct: avg > 0 ? round((stddev / avg) * 100, 2)! : 0,
    first,
    last,
    change_pct: first > 0 ? round(((last - first) / first) * 100, 2) : null,
  };
}

export const mean = (values: number[]): number | null => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined || !(from > 0)) return null;
  return round(((to - from) / from) * 100, 2);
}

/**
 * "Today" for date-range presets: the latest calendar date that has started in any active market, so the most
 * recent observations of every market fall inside "today" / "last N days".
 */
export function marketToday(ctx: AppContext, now: Date = new Date()): string {
  const zones = ctx.db.all<{ timezone: string }>('SELECT DISTINCT timezone FROM markets WHERE is_active = 1');
  let best = now.toISOString().slice(0, 10);
  for (const z of zones) {
    const d = localDate(now, z.timezone);
    if (d > best) best = d;
  }
  return best;
}

/** Inclusive range covering the last `days` days ending today. */
export function lastDays(today: string, days: number): DateRange {
  return { from: addDays(today, -(days - 1)), to: today };
}

export function previousRange(range: DateRange): DateRange {
  const length = Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1;
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

/**
 * SQL expression: hours after which a listing counts as stale, from its source's schedule.
 * Automated sources: twice their interval. Manual / CSV sources: one week. (Aliases: `li` = v_listing_info.)
 */
export const STALE_HOURS_SQL = `(CASE
  WHEN li.collection_method IN ('manual', 'csv_import') THEN ${MANUAL_STALE_HOURS}
  ${Object.entries(FREQUENCY_HOURS)
    .filter(([, hours]) => hours !== null)
    .map(([freq, hours]) => `WHEN li.collection_frequency = '${freq}' THEN ${hours! * STALE_MULTIPLIER}`)
    .join('\n  ')}
  ELSE ${MANUAL_STALE_HOURS} END)`;

/** SQL expression: age of a timestamp column in hours. */
export const ageHoursSql = (column: string) => `((julianday('now') - julianday(${column})) * 24.0)`;

export interface ListingInfo {
  listing_id: number;
  listing_code: string;
  retailer_id: number;
  product_id: number | null;
  variant_id: number | null;
  external_id: string | null;
  listing_url: string | null;
  listing_title: string | null;
  match_status: string;
  listing_active: number;
  listing_is_demo: number;
  retailer_name: string;
  market_id: number;
  country_code: string;
  currency_code: string;
  collection_method: string;
  collection_frequency: string;
  retailer_enabled: number;
  retailer_active: number;
  market_code: string;
  market_name: string;
  timezone: string;
  product_code: string | null;
  product_name: string | null;
  product_line: string | null;
  sku: string | null;
  gtin: string | null;
  product_status: string | null;
  image_url: string | null;
  brand_id: number | null;
  brand_name: string | null;
  ownership: 'own' | 'competitor' | null;
  category_id: number | null;
  category_name: string | null;
  subcategory_id: number | null;
  subcategory_name: string | null;
  variant_name: string | null;
  pack_size: number | null;
  pack_unit: string | null;
  units_per_pack: number;
  content_amount: number | null;
  content_dimension: ContentDimension | null;
  unit_factor: number | null;
}

export function loadListings(ctx: AppContext, listingIds: number[]): Map<number, ListingInfo> {
  const out = new Map<number, ListingInfo>();
  const unique = [...new Set(listingIds)];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    for (const row of ctx.db.all<ListingInfo>(`SELECT * FROM v_listing_info WHERE listing_id IN (${placeholders(chunk.length)})`, chunk)) {
      out.set(row.listing_id, row);
    }
  }
  return out;
}

export function unitPriceOf(price: number | null | undefined, info: { content_amount: number | null; unit_factor: number | null }): number | null {
  if (price === null || price === undefined || !info.content_amount || !info.unit_factor) return null;
  return (price * info.unit_factor) / info.content_amount;
}

export const basisLabel = (dimension: ContentDimension | null | undefined) => unitBasisLabel(dimension);

export function packLabel(info: { pack_size: number | null; pack_unit: string | null; units_per_pack: number | null }): string {
  if (!info.pack_size || !info.pack_unit) return '';
  const size = Number.isInteger(info.pack_size) ? String(info.pack_size) : String(Number(info.pack_size.toFixed(3)));
  const unit = info.pack_unit === 'unit' ? (info.pack_size === 1 ? ' unit' : ' units') : info.pack_unit;
  return info.units_per_pack && info.units_per_pack > 1 ? `${info.units_per_pack} × ${size}${unit}` : `${size}${unit}`;
}

export function demoNote(rows: Array<{ is_demo?: number | null }>): DemoNote {
  let demo = 0;
  for (const r of rows) if (r.is_demo) demo++;
  return { demo_rows: demo, total_rows: rows.length, all_demo: rows.length > 0 && demo === rows.length, any_demo: demo > 0 };
}
