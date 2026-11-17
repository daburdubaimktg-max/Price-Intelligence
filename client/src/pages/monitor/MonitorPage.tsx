/**
 * Live Price Monitor (route "/monitor"): the latest known price of every monitored listing,
 * from GET /api/monitor. Refreshes itself every minute.
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ListFilter, Plus, RefreshCw, X } from 'lucide-react';
import type { MonitorFacets, MonitorRow } from '@shared/api/analytics.ts';
import { DATA_CLASSES, DATA_CLASS_LABELS } from '@shared/constants.ts';
import { Page } from '@/app/AppShell.tsx';
import { DemoBadge } from '@/components/domain/domain.tsx';
import { ListingDrawer, ManualObservationDialog } from '@/components/domain/observations.tsx';
import { DataTable, Pagination } from '@/components/ui/data-table.tsx';
import { FilterBar, MultiSelect, SearchInput, type Option } from '@/components/ui/filters.tsx';
import { Button, Card, cn, EmptyState, ErrorState, IconButton, PageHeader, Segmented } from '@/components/ui/primitives.tsx';
import type { Paged } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtNumber, fmtRelative, plural } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useIsNarrow, useReference, useUrlState } from '@/lib/hooks.ts';
import { useMonitorColumns } from './columns.tsx';
import { FacetChips, type FacetKey } from './FacetChips.tsx';

type MonitorResponse = Paged<MonitorRow> & { facets: MonitorFacets };

type MonitorState = {
  market_id: string | undefined;
  retailer_id: string | undefined;
  brand_id: string | undefined;
  category_id: string | undefined;
  product_id: string | undefined;
  data_class: string | undefined;
  ownership: string | undefined;
  q: string | undefined;
  promo: string | undefined;
  availability: string | undefined;
  stale: string | undefined;
  never_observed: string | undefined;
  changed_within_hours: string | undefined;
  direction: string | undefined;
  price_min: string | undefined;
  price_max: string | undefined;
  include_unmatched: string | undefined;
  sort: string | undefined;
  page: string | undefined;
};

const DEFAULTS: MonitorState = {
  market_id: undefined,
  retailer_id: undefined,
  brand_id: undefined,
  category_id: undefined,
  product_id: undefined,
  data_class: undefined,
  ownership: 'all',
  q: undefined,
  promo: undefined,
  availability: undefined,
  stale: undefined,
  never_observed: undefined,
  changed_within_hours: undefined,
  direction: undefined,
  price_min: undefined,
  price_max: undefined,
  include_unmatched: undefined,
  sort: '-observed_at',
  page: '1',
};

const PAGE_SIZE = 50;
const REFRESH_MS = 60_000;
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const OWNERSHIP_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'own', label: 'Own' },
  { value: 'competitor', label: 'Competitors' },
];

export default function MonitorPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const canWrite = useCan('observations.write');
  const { state, set, reset, activeCount } = useUrlState<MonitorState>(DEFAULTS);
  const { ref } = useReference();

  // Prices can only be ordered within one currency: true when the market / retailer filter leaves a single one.
  const singleCurrency = useMemo(() => {
    const marketIds = toList(state.market_id);
    const retailerIds = toList(state.retailer_id);
    const currencies = new Set<string>();
    if (retailerIds.length) {
      for (const r of ref?.retailers ?? []) if (retailerIds.includes(String(r.id))) currencies.add(r.currency_code);
    } else if (marketIds.length) {
      for (const m of ref?.markets ?? []) if (marketIds.includes(String(m.id))) currencies.add(m.currency_code);
    } else {
      for (const m of ref?.markets ?? []) if (m.is_active) currencies.add(m.currency_code);
    }
    return currencies.size === 1;
  }, [ref, state.market_id, state.retailer_id]);
  const columns = useMonitorColumns(singleCurrency);
  const priceSort = /^-?(price|unit_price)$/.test(state.sort ?? '');
  const sort = priceSort && !singleCurrency ? DEFAULTS.sort : state.sort;
  const [listingId, setListingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  // On phones the dimension filters sit behind one button so the table is not pushed below the fold.
  const phone = useIsNarrow(639);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Any filter change returns to the first page.
  const filter = useCallback((patch: Partial<Record<keyof MonitorState, string | undefined | null>>) => set({ ...patch, page: undefined }), [set]);

  const params = useMemo(
    () => ({
      market_id: state.market_id,
      retailer_id: state.retailer_id,
      brand_id: state.brand_id,
      category_id: state.category_id,
      product_id: state.product_id,
      data_class: state.data_class,
      ownership: state.ownership === 'own' || state.ownership === 'competitor' ? state.ownership : undefined,
      q: state.q,
      promo: state.promo,
      availability: state.availability,
      stale: state.stale,
      never_observed: state.never_observed,
      changed_within_hours: state.changed_within_hours,
      direction: state.direction,
      price_min: state.price_min,
      price_max: state.price_max,
      include_unmatched: state.include_unmatched,
      sort,
      page: state.page,
      page_size: PAGE_SIZE,
    }),
    [state, sort],
  );
  const query = useApiQuery<MonitorResponse>(['monitor'], '/monitor', params, { refetchInterval: REFRESH_MS });
  const data = query.data;
  const refetching = query.isFetching && !query.isPending;

  // ---- filter options ---------------------------------------------------------------------------
  const selectedMarkets = toList(state.market_id);
  const options = useMemo(() => {
    const markets = (ref?.markets ?? []).filter((m) => m.is_active);
    const marketName = new Map(markets.map((m) => [m.id, m.name]));
    const demoTag = (isDemo: number) => (isDemo ? <DemoBadge /> : undefined);
    const market: Option[] = markets.map((m) => ({ value: String(m.id), label: m.name, sublabel: `${m.code} · ${m.currency_code}` }));
    const retailer: Option[] = (ref?.retailers ?? [])
      .filter((r) => r.is_active && (selectedMarkets.length === 0 || selectedMarkets.includes(String(r.market_id))))
      .map((r) => ({ value: String(r.id), label: r.name, sublabel: marketName.get(r.market_id), group: marketName.get(r.market_id), tag: demoTag(r.is_demo) }));
    const brand: Option[] = (ref?.brands ?? [])
      .filter((b) => b.is_active)
      .sort((a, b) => (a.ownership === b.ownership ? a.name.localeCompare(b.name) : a.ownership === 'own' ? -1 : 1))
      .map((b) => ({ value: String(b.id), label: b.name, group: b.ownership === 'own' ? 'Own brands' : 'Competitors', tag: demoTag(b.is_demo) }));
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
    const source: Option[] = DATA_CLASSES.map((c) => ({ value: c, label: DATA_CLASS_LABELS[c] }));
    return { market, retailer, brand, category, source };
  }, [ref, selectedMarkets.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- quick toggles ----------------------------------------------------------------------------
  const activeChips = useMemo(() => {
    const on = new Set<FacetKey>();
    if (state.promo === 'true') on.add('promo');
    if (state.availability === 'out_of_stock') on.add('out_of_stock');
    if (state.stale === 'true') on.add('stale');
    if (state.never_observed === 'true') on.add('never');
    if (state.changed_within_hours === '24' && state.direction === 'up') on.add('up');
    if (state.changed_within_hours === '24' && state.direction === 'down') on.add('down');
    if (state.include_unmatched === 'true') on.add('unmatched');
    return on;
  }, [state]);

  const toggleChip = (key: FacetKey) => {
    const on = activeChips.has(key);
    switch (key) {
      case 'promo':
        return filter({ promo: on ? undefined : 'true' });
      case 'out_of_stock':
        return filter({ availability: on ? undefined : 'out_of_stock' });
      case 'stale':
        return filter({ stale: on ? undefined : 'true' });
      case 'never':
        return filter({ never_observed: on ? undefined : 'true' });
      case 'up':
      case 'down':
        return filter(on ? { changed_within_hours: undefined, direction: undefined } : { changed_within_hours: '24', direction: key });
      case 'unmatched':
        return filter({ include_unmatched: on ? undefined : 'true' });
    }
  };

  const dimensionFilters =
    (['market_id', 'retailer_id', 'brand_id', 'category_id', 'data_class'] as const).filter((k) => !!state[k]).length + (state.ownership && state.ownership !== 'all' ? 1 : 0);
  const facets = data?.facets;
  const filtered = activeCount - (state.sort !== DEFAULTS.sort ? 1 : 0) - (state.page !== DEFAULTS.page ? 1 : 0) > 0;

  const refreshAll = () => {
    void query.refetch();
    void client.invalidateQueries({ queryKey: ['overview'] });
  };

  return (
    <Page>
      <PageHeader
        title="Live Price Monitor"
        description="The latest known price of every monitored retailer listing. Earlier prices stay in the history."
        actions={
          canWrite ? (
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
              Add observation
            </Button>
          ) : undefined
        }
      />

      <FilterBar>
        {phone ? (
          <Button icon={ListFilter} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
            Filters{dimensionFilters > 0 ? ` (${dimensionFilters})` : ''}
          </Button>
        ) : null}
        {!phone || filtersOpen ? (
          <>
            <MultiSelect label="Market" options={options.market} value={selectedMarkets} onChange={(next) => filter({ market_id: fromList(next), retailer_id: undefined })} />
            <MultiSelect label="Retailer" options={options.retailer} value={toList(state.retailer_id)} onChange={(next) => filter({ retailer_id: fromList(next) })} />
            <MultiSelect label="Brand" options={options.brand} value={toList(state.brand_id)} onChange={(next) => filter({ brand_id: fromList(next) })} />
            <MultiSelect label="Category" options={options.category} value={toList(state.category_id)} onChange={(next) => filter({ category_id: fromList(next) })} />
            <MultiSelect label="Source" options={options.source} value={toList(state.data_class)} onChange={(next) => filter({ data_class: fromList(next) })} />
            <Segmented label="Ownership" value={state.ownership ?? 'all'} onChange={(v) => filter({ ownership: v })} options={OWNERSHIP_OPTIONS} />
          </>
        ) : null}
        <SearchInput value={state.q ?? ''} onChange={(q) => filter({ q: q || undefined })} placeholder="Search product, brand, retailer…" className={phone ? 'w-auto min-w-0 flex-1' : undefined} />
        {filtered ? (
          <Button variant="ghost" icon={X} onClick={reset}>
            Reset
          </Button>
        ) : null}
        <FacetChips facets={facets} active={activeChips} onToggle={toggleChip} />
      </FilterBar>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 text-[12.5px] leading-5 text-ink-3">
          {facets ? (
            <>
              <span>
                <span className="num font-semibold text-ink">{fmtNumber(data?.total ?? 0)}</span>
                {filtered ? (
                  <>
                    {' '}
                    of <span className="num">{fmtNumber(facets.listings)}</span>
                  </>
                ) : null}{' '}
                {(data?.total ?? 0) === 1 && !filtered ? 'listing' : 'listings'}
                {facets.demo_listings > 0 ? (
                  <>
                    {' · '}
                    {facets.demo_listings >= facets.listings
                      ? facets.listings === 1
                        ? 'a demo listing'
                        : 'all are demo listings'
                      : `${fmtNumber(facets.demo_listings)} ${facets.demo_listings === 1 ? 'is a demo listing' : 'are demo listings'}`}
                  </>
                ) : null}
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {facets.latest_observation_at ? `Latest observation ${fmtRelative(facets.latest_observation_at)}` : 'No observation yet'}
                  {' · '}
                  {plural(facets.changed_24h, 'price change')} in the last 24 h
                </span>
                <span className="flex items-center gap-2" aria-live="polite">
                  <span className="hidden text-ink-4 sm:inline" aria-hidden>
                    |
                  </span>
                  {query.dataUpdatedAt ? `Updated ${clock.format(new Date(query.dataUpdatedAt))}, refreshes every minute` : null}
                  <IconButton icon={RefreshCw} label="Refresh now" size="sm" variant="secondary" className={cn(query.isFetching && '[&>svg]:animate-spin-slow')} onClick={refreshAll} />
                </span>
              </span>
            </>
          ) : (
            <span>Loading the latest prices…</span>
          )}
        </div>

        {query.isError && !data ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={data?.rows}
            rowKey={(r) => r.listing_id}
            sort={sort}
            onSort={(next) => set({ sort: next, page: undefined })}
            onRowClick={(r) => setListingId(r.listing_id)}
            selectedKey={listingId}
            loading={query.isPending}
            refetching={refetching && query.isPlaceholderData}
            empty={
              filtered ? (
                <EmptyState
                  title="No listings match these filters"
                  description="Relax or reset the filters to see more of the monitored listings."
                  action={
                    <Button size="sm" onClick={reset}>
                      Reset filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="No listings are being monitored yet"
                  description="Add products and link them to retailer listings in the catalogue. A listing appears here as soon as it exists, and shows a price after its first observation."
                  action={
                    <Button size="sm" variant="primary" onClick={() => navigate('/catalogue')}>
                      Open the product catalogue
                    </Button>
                  }
                />
              )
            }
            footer={
              data ? <Pagination page={data.page} pages={data.pages} total={data.total} pageSize={data.page_size} onPage={(page) => set({ page: String(page) })} noun="listings" /> : null
            }
          />
        )}
      </Card>

      <ListingDrawer listingId={listingId} onClose={() => setListingId(null)} />
      {canWrite ? (
        <ManualObservationDialog
          open={adding}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            refreshAll();
          }}
        />
      ) : null}
    </Page>
  );
}
