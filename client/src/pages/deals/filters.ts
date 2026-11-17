/** URL-synchronised state of the Deals screen and the options of its filter controls. */
import { useCallback, useMemo } from 'react';
import { DEAL_SORTS, type DealSort } from '@shared/api/deals.ts';
import type { Option } from '@/components/ui/filters.tsx';
import type { Query } from '@/lib/api.ts';
import { toList, useReference, useUrlState } from '@/lib/hooks.ts';

export type DealsState = {
  market_id: string | undefined;
  retailer_id: string | undefined;
  brand_id: string | undefined;
  category_id: string | undefined;
  product_id: string | undefined;
  ownership: string | undefined;
  q: string | undefined;
  /** Deal tag keys, comma-separated: deals carrying at least one of them. */
  tag: string | undefined;
  min_discount: string | undefined;
  lowest_only: string | undefined;
  include_badges: string | undefined;
  /** "true" = only deals that can be bought now (in stock or limited stock). */
  in_stock: string | undefined;
  sort: string | undefined;
  page: string | undefined;
};

export const DEFAULTS: DealsState = {
  market_id: undefined,
  retailer_id: undefined,
  brand_id: undefined,
  category_id: undefined,
  product_id: undefined,
  ownership: 'all',
  q: undefined,
  tag: undefined,
  min_discount: undefined,
  lowest_only: undefined,
  include_badges: undefined,
  in_stock: undefined,
  sort: '-discount',
  page: '1',
};

export const PAGE_SIZE = 50;

export const OWNERSHIP_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'own', label: 'Own' },
  { value: 'competitor', label: 'Competitors' },
];

export const MIN_DISCOUNT_OPTIONS = [
  { value: '', label: 'Any discount' },
  { value: '10', label: '10% or more' },
  { value: '20', label: '20% or more' },
  { value: '30', label: '30% or more' },
  { value: '40', label: '40% or more' },
  { value: '50', label: '50% or more' },
];

/** What each sort key of the API means to a reader; the directions that make sense, the useful one first. */
const SORT_LABELS: Record<DealSort, Array<{ descending: boolean; label: string }>> = {
  discount: [
    { descending: true, label: 'Deepest discount' },
    { descending: false, label: 'Smallest discount' },
  ],
  drop: [{ descending: true, label: 'Biggest drop vs 30-day average' }],
  price: [
    { descending: false, label: 'Lowest price (within each currency)' },
    { descending: true, label: 'Highest price (within each currency)' },
  ],
  observed: [
    { descending: true, label: 'Most recently observed' },
    { descending: false, label: 'Observed longest ago' },
  ],
  rating: [{ descending: true, label: 'Best customer rating' }],
  rank: [{ descending: false, label: 'Best sales rank' }],
};

export const SORT_OPTIONS: Array<{ value: string; label: string }> = DEAL_SORTS.flatMap((key) =>
  (SORT_LABELS[key] ?? [{ descending: true, label: key }]).map((option) => ({ value: `${option.descending ? '-' : ''}${key}`, label: option.label })),
);

export function sortLabel(sort: string | undefined): string {
  return SORT_OPTIONS.find((o) => o.value === sort)?.label ?? SORT_OPTIONS[0]!.label;
}

/** Filter state of the screen, the query it stands for and the option lists of its controls. */
export function useDealFilters() {
  const { state, set, reset, activeCount } = useUrlState<DealsState>(DEFAULTS);
  const { ref } = useReference();

  // Any filter change returns to the first page.
  const filter = useCallback((patch: Partial<Record<keyof DealsState, string | undefined | null>>) => set({ ...patch, page: undefined }), [set]);

  const sort = SORT_OPTIONS.some((o) => o.value === state.sort) ? state.sort! : DEFAULTS.sort!;
  const query = useMemo<Query>(
    () => ({
      market_id: state.market_id,
      retailer_id: state.retailer_id,
      brand_id: state.brand_id,
      category_id: state.category_id,
      product_id: state.product_id,
      ownership: state.ownership === 'own' || state.ownership === 'competitor' ? state.ownership : undefined,
      q: state.q,
      tag: state.tag,
      min_discount: state.min_discount,
      lowest_only: state.lowest_only === 'true' ? 'true' : undefined,
      include_badges: state.include_badges === 'true' ? 'true' : undefined,
      availability: state.in_stock === 'true' ? 'in_stock,limited' : undefined,
      sort,
      page: state.page,
      page_size: PAGE_SIZE,
    }),
    [state, sort],
  );

  const selectedMarkets = toList(state.market_id);
  const marketKey = selectedMarkets.join(',');
  const options = useMemo(() => {
    const markets = (ref?.markets ?? []).filter((m) => m.is_active);
    const marketName = new Map(markets.map((m) => [m.id, m.name]));
    const chosen = marketKey ? marketKey.split(',') : [];
    const market: Option[] = markets.map((m) => ({ value: String(m.id), label: m.name, sublabel: `${m.code} · ${m.currency_code}` }));
    const retailer: Option[] = (ref?.retailers ?? [])
      .filter((r) => r.is_active && (chosen.length === 0 || chosen.includes(String(r.market_id))))
      .map((r) => ({ value: String(r.id), label: r.name, sublabel: marketName.get(r.market_id), group: marketName.get(r.market_id) }));
    const brand: Option[] = (ref?.brands ?? [])
      .filter((b) => b.is_active)
      .sort((a, b) => (a.ownership === b.ownership ? a.name.localeCompare(b.name) : a.ownership === 'own' ? -1 : 1))
      .map((b) => ({ value: String(b.id), label: b.name, group: b.ownership === 'own' ? 'Own brands' : 'Competitors' }));
    const categories = ref?.categories ?? [];
    const category: Option[] = categories
      .filter((c) => c.parent_id === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((parent) => [
        { value: String(parent.id), label: `All ${parent.name}`, group: parent.name },
        ...categories
          .filter((c) => c.parent_id === parent.id)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => ({ value: String(c.id), label: c.name, group: parent.name })),
      ]);
    return { market, retailer, brand, category };
  }, [ref, marketKey]);

  /** Filters other than sorting and paging. */
  const filtered = activeCount - (state.sort !== DEFAULTS.sort ? 1 : 0) - (state.page !== DEFAULTS.page ? 1 : 0) > 0;
  const dimensionFilters = (['market_id', 'retailer_id', 'brand_id', 'category_id'] as const).filter((k) => !!state[k]).length + (state.ownership && state.ownership !== 'all' ? 1 : 0);

  return { state, set, filter, reset, sort, query, options, filtered, dimensionFilters, selectedMarkets };
}

export type DealFilters = ReturnType<typeof useDealFilters>;
