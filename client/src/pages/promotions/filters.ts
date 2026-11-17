/** URL-synchronised filter state of the promotion screen and its translation into API query parameters. */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { matchPreset, presetRange, type DatePreset, type Option } from '@/components/ui/filters.tsx';
import type { Query } from '@/lib/api.ts';
import { useDates, useReference, useUrlState, toList, type DateRange } from '@/lib/hooks.ts';

export const RANGE_PRESETS: DatePreset[] = ['7d', '30d', '90d'];

export type PromoParams = {
  /** A preset key (7d / 30d / 90d) or "custom" (then from / to apply). */
  range: string | undefined;
  from: string | undefined;
  to: string | undefined;
  market_id: string | undefined;
  retailer_id: string | undefined;
  brand_id: string | undefined;
  category_id: string | undefined;
  ownership: string | undefined;
  product_id: string | undefined;
  /** timeline grouping */
  group: string | undefined;
  /** episodes table */
  status: string | undefined;
  type: string | undefined;
  min_discount: string | undefined;
  sort: string | undefined;
  page: string | undefined;
};

const DEFAULTS: PromoParams = {
  range: '30d',
  from: undefined,
  to: undefined,
  market_id: undefined,
  retailer_id: undefined,
  brand_id: undefined,
  category_id: undefined,
  ownership: undefined,
  product_id: undefined,
  group: 'brand',
  status: undefined,
  type: undefined,
  min_discount: undefined,
  sort: '-started',
  page: undefined,
};

/** Keys of the page-wide filter row (the rest are per-card view settings). */
const SCOPE_KEYS = ['range', 'from', 'to', 'market_id', 'retailer_id', 'brand_id', 'category_id', 'ownership', 'product_id'] as const;

export function usePromoFilters() {
  const url = useUrlState<PromoParams>(DEFAULTS);
  const dates = useDates();
  const reference = useReference();
  const { state, set } = url;
  const today = dates.data?.today ?? null;

  const period = useMemo<DateRange | null>(() => {
    if (!today) return null;
    if (state.range === 'custom' && (state.from || state.to)) {
      const to = state.to ?? today;
      return { from: state.from ?? presetRange('30d', to).from!, to };
    }
    const preset = (RANGE_PRESETS as string[]).includes(state.range ?? '') ? (state.range as DatePreset) : '30d';
    const r = presetRange(preset, today);
    return { from: r.from!, to: r.to! };
  }, [today, state.range, state.from, state.to]);

  /** Dimension filters shared by every request on the screen. */
  const scope = useMemo<Query>(
    () => ({
      market_id: state.market_id,
      retailer_id: state.retailer_id,
      brand_id: state.brand_id,
      category_id: state.category_id,
      ownership: state.ownership,
      product_id: state.product_id,
    }),
    [state.market_id, state.retailer_id, state.brand_id, state.category_id, state.ownership, state.product_id],
  );
  const query = useMemo<Query | null>(() => (period ? { ...scope, from: period.from, to: period.to } : null), [scope, period]);

  /** Changing the scope always returns the episodes table to its first page. */
  const setScope = (patch: Partial<Record<keyof PromoParams, string | null | undefined>>) => set({ ...patch, page: null });

  const setRange = (next: Partial<DateRange>) => {
    if (!today) return;
    const preset = matchPreset(next, today, RANGE_PRESETS);
    if (preset) setScope({ range: preset, from: null, to: null });
    else setScope({ range: 'custom', from: next.from ?? null, to: next.to ?? null });
  };

  // The kit's `set` changes identity whenever the URL changes; memoised charts need a callback that does not.
  const setRef = useRef(set);
  useEffect(() => {
    setRef.current = set;
  });
  const setGroup = useCallback((group: string) => setRef.current({ group }), []);

  const resetScope = () => {
    const patch: Partial<Record<keyof PromoParams, null>> = { page: null };
    for (const key of SCOPE_KEYS) patch[key] = null;
    set(patch);
  };
  const activeScope = SCOPE_KEYS.filter((key) => state[key] !== undefined && state[key] !== DEFAULTS[key]).length;

  const ref = reference.ref;
  const options = useMemo(() => {
    const selectedMarkets = new Set(toList(state.market_id));
    const marketName = new Map((ref?.markets ?? []).map((m) => [m.id, m]));
    const markets: Option[] = (ref?.markets ?? []).filter((m) => m.is_active).map((m) => ({ value: String(m.id), label: m.name, sublabel: m.currency_code }));
    const retailers: Option[] = (ref?.retailers ?? [])
      .filter((r) => r.is_active && (selectedMarkets.size === 0 || selectedMarkets.has(String(r.market_id))))
      .map((r) => ({ value: String(r.id), label: r.name, group: marketName.get(r.market_id)?.name ?? 'Other' }));
    const brands: Option[] = (ref?.brands ?? [])
      .filter((b) => b.is_active)
      .map((b) => ({ value: String(b.id), label: b.name, group: b.ownership === 'own' ? 'Own brands' : 'Competitors' }))
      .sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : a.group === 'Own brands' ? -1 : 1));
    const parents = (ref?.categories ?? []).filter((c) => c.parent_id === null);
    const categories: Option[] = [];
    for (const parent of parents) {
      categories.push({ value: String(parent.id), label: `All ${parent.name}`, group: parent.name });
      for (const child of (ref?.categories ?? []).filter((c) => c.parent_id === parent.id)) {
        categories.push({ value: String(child.id), label: child.name, group: parent.name });
      }
    }
    return { markets, retailers, brands, categories };
  }, [ref, state.market_id]);

  return { ...url, today, period, scope, query, setScope, setRange, setGroup, resetScope, activeScope, options, dates, reference };
}

export type PromoFilters = ReturnType<typeof usePromoFilters>;

export const isRefetching = (q: { isFetching: boolean; isPending: boolean }) => q.isFetching && !q.isPending;
