/** URL-synchronised state of the New Products screen and the options of its filter controls. */
import { useCallback, useMemo } from 'react';
import { NEW_LISTING_KINDS, NEW_LISTING_PERIODS, NEW_LISTING_SORTS, type NewListingKind, type NewListingPeriod } from '@shared/api/new-listings.ts';
import type { Option } from '@/components/ui/filters.tsx';
import type { Query } from '@/lib/api.ts';
import { toList, useReference, useUrlState } from '@/lib/hooks.ts';

export type NewProductsState = {
  days: string | undefined;
  market_id: string | undefined;
  retailer_id: string | undefined;
  brand_id: string | undefined;
  ownership: string | undefined;
  kind: string | undefined;
  q: string | undefined;
  include_ignored: string | undefined;
  sort: string | undefined;
  page: string | undefined;
};

export const DEFAULTS: NewProductsState = {
  days: '30',
  market_id: undefined,
  retailer_id: undefined,
  brand_id: undefined,
  ownership: 'all',
  kind: 'all',
  q: undefined,
  include_ignored: undefined,
  sort: '-first_seen',
  page: '1',
};

export const PAGE_SIZE = 50;

export const PERIOD_OPTIONS = NEW_LISTING_PERIODS.map((days) => ({ value: String(days), label: `${days} days` }));

export const OWNERSHIP_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'own', label: 'Own' },
  { value: 'competitor', label: 'Competitors' },
];

export const SORT_OPTIONS = [
  { value: '-first_seen', label: 'Newest first' },
  { value: 'first_seen', label: 'Oldest first' },
  { value: 'brand', label: 'Brand, A to Z' },
  { value: 'retailer', label: 'Retailer, A to Z' },
].filter((o) => NEW_LISTING_SORTS.includes(o.value.replace(/^-/, '') as (typeof NEW_LISTING_SORTS)[number]));

export const KIND_LABELS: Record<NewListingKind, string> = { new_product: 'New products', new_at_retailer: 'New at a retailer' };

/** Filter state of the screen, the query it stands for and the option lists of its controls. */
export function useNewProductFilters() {
  const { state, set, reset, activeCount } = useUrlState<NewProductsState>(DEFAULTS);
  const { ref } = useReference();

  // Any filter change returns to the first page.
  const filter = useCallback((patch: Partial<Record<keyof NewProductsState, string | undefined | null>>) => set({ ...patch, page: undefined }), [set]);

  const days = (NEW_LISTING_PERIODS.includes(Number(state.days) as NewListingPeriod) ? Number(state.days) : 30) as NewListingPeriod;
  const kind = NEW_LISTING_KINDS.includes(state.kind as NewListingKind) ? (state.kind as NewListingKind) : undefined;
  const sort = SORT_OPTIONS.some((o) => o.value === state.sort) ? state.sort! : DEFAULTS.sort!;
  const query = useMemo<Query>(
    () => ({
      days,
      market_id: state.market_id,
      retailer_id: state.retailer_id,
      brand_id: state.brand_id,
      ownership: state.ownership === 'own' || state.ownership === 'competitor' ? state.ownership : undefined,
      kind,
      q: state.q,
      include_ignored: state.include_ignored === 'true' ? 'true' : undefined,
      sort,
      page: state.page,
      page_size: PAGE_SIZE,
    }),
    [state, days, kind, sort],
  );

  const marketKey = toList(state.market_id).join(',');
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
    return { market, retailer, brand };
  }, [ref, marketKey]);

  /** Filters other than the period, sorting and paging. */
  const filtered =
    activeCount - (state.sort !== DEFAULTS.sort ? 1 : 0) - (state.page !== DEFAULTS.page ? 1 : 0) - (state.days !== DEFAULTS.days ? 1 : 0) > 0;

  return { state, set, filter, reset, query, options, filtered, days, kind, sort };
}

export type NewProductFilters = ReturnType<typeof useNewProductFilters>;
