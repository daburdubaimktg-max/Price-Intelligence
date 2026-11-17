/**
 * Filter state of the Historical Price Explorer. Everything lives in the URL so a view can be shared,
 * and the same object feeds every request on the screen (summary, timeline, comparison, records, volatility).
 */
import { useMemo } from 'react';
import type { Query } from '@/lib/api.ts';
import { toList, useDates, useReference, useUrlState, type DateRange } from '@/lib/hooks.ts';
import { presetRange, type DatePreset } from '@/components/ui/filters.tsx';
import type { ReferenceData } from '@shared/api/catalogue.ts';

export const HISTORY_PRESETS: DatePreset[] = ['today', '7d', '30d', '90d', 'all'];
export const DEFAULT_PRESET: DatePreset = '30d';

export const HISTORY_DEFAULTS = {
  // scope (one FilterBar row)
  from: undefined as string | undefined,
  to: undefined as string | undefined,
  /** Rolling window: 'today' | '7d' | '30d' | '90d' | 'all'. Absent = the default (last 30 days). Ignored when from/to are set. */
  period: undefined as string | undefined,
  market_id: undefined as string | undefined,
  retailer_id: undefined as string | undefined,
  brand_id: undefined as string | undefined,
  product_id: undefined as string | undefined,
  category_id: undefined as string | undefined,
  ownership: undefined as string | undefined,
  sku: undefined as string | undefined,
  price_min: undefined as string | undefined,
  price_max: undefined as string | undefined,
  promo: undefined as string | undefined,
  data_class: undefined as string | undefined,
  q: undefined as string | undefined,
  /** Comparison currency for the timeline and the period comparison: 'native', 'reporting' or an ISO code. */
  currency: undefined as string | undefined,
  // timeline
  tl_group: undefined as string | undefined,
  tl_metric: 'price' as string | undefined,
  tl_bucket: 'day' as string | undefined,
  // period comparison
  cmp: 'last_30_days' as string | undefined,
  cmp_group: 'product' as string | undefined,
  cmp_metric: 'price' as string | undefined,
  a_from: undefined as string | undefined,
  a_to: undefined as string | undefined,
  b_from: undefined as string | undefined,
  b_to: undefined as string | undefined,
  // stored records
  sort: '-observed_at' as string | undefined,
  page: '1' as string | undefined,
  page_size: '25' as string | undefined,
  // volatility
  vol_group: 'listing' as string | undefined,
  // price changes by group
  chg_group: 'retailer' as string | undefined,
};

export type HistoryState = typeof HISTORY_DEFAULTS;

/** Keys that define the scope (used for the Reset button and to restart paging). */
export const SCOPE_KEYS = [
  'from', 'to', 'period', 'market_id', 'retailer_id', 'brand_id', 'product_id', 'category_id', 'ownership', 'sku', 'price_min', 'price_max',
  'promo', 'data_class', 'q',
] as const;

export interface HistoryFilters {
  state: HistoryState;
  set: (patch: Partial<Record<keyof HistoryState, string | undefined | null>>) => void;
  /** Changes scope filters and returns the records table to its first page. */
  setScope: (patch: Partial<Record<keyof HistoryState, string | undefined | null>>) => void;
  resetScope: () => void;
  scopeCount: number;
  /** Effective date range (empty object = all time). Undefined until "today" is known. */
  range: Partial<DateRange> | undefined;
  today: string | undefined;
  firstDate: string | null | undefined;
  reportingCurrency: string;
  /** Dimension filters without dates (the period comparison brings its own periods). */
  dimensionQuery: Query;
  /** Dimension filters + the date range. */
  scopeQuery: Query;
  /** Resolved currency mode for requests: 'native' or an ISO code. */
  currency: string;
  /** True when the user has not chosen a currency and the mode was derived from the scope. */
  currencyIsAuto: boolean;
  ready: boolean;
}

/**
 * Currency mode when the user has not chosen one: native while the market / retailer selection is clearly a
 * single currency, otherwise the reporting currency so values can be read on one axis (with the rate stated).
 */
export function deriveCurrencyMode(ref: ReferenceData | undefined, marketParam: string | undefined, retailerParam: string | undefined): 'native' | 'reporting' {
  if (!ref) return 'native';
  const marketIds = new Set(toList(marketParam).map(Number));
  const retailerIds = new Set(toList(retailerParam).map(Number));
  const currencies = new Set<string>();
  if (retailerIds.size) {
    for (const r of ref.retailers) if (retailerIds.has(r.id) && (!marketIds.size || marketIds.has(r.market_id))) currencies.add(r.currency_code);
  } else {
    for (const m of ref.markets) if (m.is_active && (!marketIds.size || marketIds.has(m.id))) currencies.add(m.currency_code);
  }
  return currencies.size <= 1 ? 'native' : 'reporting';
}

export function useHistoryFilters(): HistoryFilters {
  const { state, set } = useUrlState(HISTORY_DEFAULTS);
  const dates = useDates();
  const { ref } = useReference();
  const today = dates.data?.today;
  const reportingCurrency = dates.data?.reporting_currency ?? 'USD';

  const range = useMemo<Partial<DateRange> | undefined>(() => {
    if (state.from || state.to) return { from: state.from, to: state.to };
    const preset = HISTORY_PRESETS.includes(state.period as DatePreset) ? (state.period as DatePreset) : DEFAULT_PRESET;
    return today ? presetRange(preset, today) : undefined;
  }, [state.from, state.to, state.period, today]);

  const dimensionQuery = useMemo<Query>(
    () => ({
      market_id: state.market_id,
      retailer_id: state.retailer_id,
      brand_id: state.brand_id,
      product_id: state.product_id,
      category_id: state.category_id,
      ownership: state.ownership,
      sku: state.sku,
      price_min: state.price_min,
      price_max: state.price_max,
      promo: state.promo,
      data_class: state.data_class,
      q: state.q,
    }),
    [state.market_id, state.retailer_id, state.brand_id, state.product_id, state.category_id, state.ownership, state.sku, state.price_min, state.price_max, state.promo, state.data_class, state.q],
  );
  const scopeQuery = useMemo<Query>(() => ({ ...dimensionQuery, from: range?.from, to: range?.to }), [dimensionQuery, range?.from, range?.to]);

  const derivedCurrency = useMemo(() => deriveCurrencyMode(ref, state.market_id, state.retailer_id), [ref, state.market_id, state.retailer_id]);
  const currency = state.currency ?? derivedCurrency;

  const scopeCount = SCOPE_KEYS.filter((k) => state[k] !== undefined && state[k] !== HISTORY_DEFAULTS[k]).length;

  return {
    state,
    set,
    setScope: (patch) => set({ ...patch, page: undefined }),
    resetScope: () => set({ ...Object.fromEntries(SCOPE_KEYS.map((k) => [k, undefined])), page: undefined }),
    scopeCount,
    range,
    today,
    firstDate: dates.data?.first_observation_date,
    reportingCurrency,
    dimensionQuery,
    scopeQuery,
    currency,
    currencyIsAuto: state.currency === undefined,
    ready: range !== undefined && !!ref,
  };
}
