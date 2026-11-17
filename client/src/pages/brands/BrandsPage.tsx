/**
 * Brand Explorer — every brand with listed products: how large its range is, where it is listed, how its prices
 * move and how often it is on promotion. A brand opens its own page (range, price matrix, trend, competing brands).
 */
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ListFilter, Store, Tags, X } from 'lucide-react';
import { Page } from '@/app/AppShell.tsx';
import type { Query } from '@/lib/api.ts';
import { fmtNumber } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useDates, useIsNarrow, useUrlState } from '@/lib/hooks.ts';
import { FilterBar, MultiSelect, SearchInput } from '@/components/ui/filters.tsx';
import { Button, Card, cn, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, StatTile } from '@/components/ui/primitives.tsx';
import { DemoNotice, FxNote } from '@/components/domain/domain.tsx';
import type { BrandExplorerResult, BrandExplorerRow } from '@shared/api/brands.ts';
import { CurrencySelect, InlineSelect, isRefetching } from '../history/parts.tsx';
import { BrandCards } from './BrandCards.tsx';
import { BrandTable } from './BrandTable.tsx';
import { brandHref, BRANDS, useScopeOptions } from './parts.tsx';

type ListState = {
  market_id: string | undefined;
  retailer_id: string | undefined;
  category_id: string | undefined;
  /** all | own | competitor */
  ownership: string | undefined;
  q: string | undefined;
  /** native | reporting | ISO code — a comparison currency converts the price ranges. */
  currency: string | undefined;
  /** cards | table */
  view: string | undefined;
  sort: string | undefined;
};

const DEFAULTS: ListState = {
  market_id: undefined,
  retailer_id: undefined,
  category_id: undefined,
  ownership: 'all',
  q: undefined,
  currency: 'native',
  view: 'cards',
  sort: undefined,
};

const OWNERSHIP_OPTIONS: Array<{ value: 'all' | 'own' | 'competitor'; label: string }> = [
  { value: 'all', label: 'All brands' },
  { value: 'own', label: 'Own' },
  { value: 'competitor', label: 'Competitors' },
];

const SORT_OPTIONS = [
  { value: '', label: 'Own brands first' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: '-products', label: 'Most products' },
  { value: '-listings', label: 'Most listings' },
  { value: '-promo_share', label: 'Highest promotion share' },
  { value: '-moves', label: 'Most price moves (7 days)' },
  { value: '-trend', label: 'Largest 30-day increase' },
  { value: 'trend', label: 'Largest 30-day decrease' },
  { value: '-last_observation', label: 'Latest observation' },
];

function SummaryStrip({ data }: { data: BrandExplorerResult }) {
  const s = data.summary;
  const notFresh = [
    s.stale_listings ? `${fmtNumber(s.stale_listings)} stale` : null,
    s.never_observed_listings ? `${fmtNumber(s.never_observed_listings)} never observed` : null,
  ].filter(Boolean);
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Brands" value={fmtNumber(s.brands)} detail={`${fmtNumber(s.own_brands)} own · ${fmtNumber(s.competitor_brands)} competitor`} icon={Tags} />
      <StatTile label="Listed products" value={fmtNumber(s.products)} detail={`${fmtNumber(s.own_products)} own · ${fmtNumber(s.competitor_products)} competitor`} />
      <StatTile
        label="Retailer listings"
        value={fmtNumber(s.listings)}
        detail={`${fmtNumber(s.fresh_listings)} fresh${notFresh.length ? ` · ${notFresh.join(' · ')}` : ''}`}
        tone={s.stale_listings + s.never_observed_listings > 0 ? 'warn' : 'default'}
        title="Fresh listings were observed recently enough for their source's schedule. Only they count towards current prices."
      />
      <StatTile
        label="Listed at"
        value={`${fmtNumber(s.retailers)} retailer${s.retailers === 1 ? '' : 's'}`}
        detail={`${fmtNumber(s.markets)} market${s.markets === 1 ? '' : 's'} · ${s.currencies.length === 1 ? s.currencies[0] : `${s.currencies.length} currencies`}`}
        icon={Store}
      />
    </div>
  );
}

export default function BrandsPage() {
  const { state, set, reset, activeCount } = useUrlState<ListState>(DEFAULTS);
  const dates = useDates();
  const reportingCurrency = dates.data?.reporting_currency ?? 'USD';
  const options = useScopeOptions(state.market_id);
  const phone = useIsNarrow(639);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const ownership = state.ownership === 'own' || state.ownership === 'competitor' ? state.ownership : 'all';
  const view = state.view === 'table' ? 'table' : 'cards';
  const currency = state.currency ?? 'native';
  const sort = state.sort ?? '';

  const params = useMemo<Query>(
    () => ({
      market_id: state.market_id,
      retailer_id: state.retailer_id,
      category_id: state.category_id,
      ownership: ownership === 'all' ? undefined : ownership,
      q: state.q,
      sort: sort || undefined,
      currency: currency === 'native' ? undefined : currency,
    }),
    [state.market_id, state.retailer_id, state.category_id, ownership, state.q, sort, currency],
  );
  const query = useApiQuery<BrandExplorerResult>([BRANDS, 'list'], '/brand-explorer', params);
  const data = query.data;
  const refetching = isRefetching(query);

  // A brand page opens in the scope the user is looking at.
  const scope = useMemo<Query>(
    () => ({ market_id: state.market_id, retailer_id: state.retailer_id, category_id: state.category_id, currency: currency === 'native' ? undefined : currency }),
    [state.market_id, state.retailer_id, state.category_id, currency],
  );
  const hrefOf = useCallback((row: BrandExplorerRow) => brandHref(row.id, scope), [scope]);

  const dimensionFilters = [state.market_id, state.retailer_id, state.category_id].filter(Boolean).length + (ownership !== 'all' ? 1 : 0);
  const filtered = activeCount - (state.view && state.view !== DEFAULTS.view ? 1 : 0) - (state.sort ? 1 : 0) > 0;
  const sortOptions = SORT_OPTIONS.some((o) => o.value === sort) ? SORT_OPTIONS : [...SORT_OPTIONS, { value: sort, label: 'Table column order' }];
  const converted = data?.currency_mode === 'converted';

  return (
    <Page>
      <PageHeader
        title="Brand Explorer"
        description="Every brand with listed products: the size of its range, where it is listed, how its prices move and how often it is on promotion. Open a brand for its product range, price matrix, trend and competing brands."
      />

      <FilterBar
        trailing={
          <>
            <CurrencySelect label="Prices in" value={currency} reportingCurrency={reportingCurrency} onChange={(v) => set({ currency: v })} />
            {view === 'cards' ? <InlineSelect label="Sort" value={sort} onChange={(v) => set({ sort: v || undefined })} options={sortOptions} width="w-52" /> : null}
            <Segmented
              label="View"
              value={view}
              onChange={(v) => set({ view: v })}
              options={[
                { value: 'cards', label: 'Cards' },
                { value: 'table', label: 'Table' },
              ]}
            />
          </>
        }
      >
        {phone ? (
          <Button icon={ListFilter} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
            Filters{dimensionFilters > 0 ? ` (${dimensionFilters})` : ''}
          </Button>
        ) : null}
        {!phone || filtersOpen ? (
          <>
            <MultiSelect label="Market" options={options.market} value={toList(state.market_id)} onChange={(next) => set({ market_id: fromList(next), retailer_id: undefined })} />
            <MultiSelect label="Retailer" options={options.retailer} value={toList(state.retailer_id)} onChange={(next) => set({ retailer_id: fromList(next) })} searchable />
            <MultiSelect label="Category" options={options.category} value={toList(state.category_id)} onChange={(next) => set({ category_id: fromList(next) })} />
            <Segmented label="Ownership" value={ownership} onChange={(v) => set({ ownership: v })} options={OWNERSHIP_OPTIONS} />
          </>
        ) : null}
        <SearchInput value={state.q ?? ''} onChange={(q) => set({ q: q || undefined })} placeholder="Search brand or manufacturer…" className={phone ? 'w-auto min-w-0 flex-1' : undefined} />
        {filtered ? (
          <Button variant="ghost" icon={X} onClick={reset}>
            Reset
          </Button>
        ) : null}
      </FilterBar>

      {query.isError && !data ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : !data ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[88px]" />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading brands">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-72" />
            ))}
          </div>
        </>
      ) : (
        <div className={cn('transition-opacity', refetching && 'opacity-60')}>
          <DemoNotice demo={data.demo} className="mb-4" />
          <SummaryStrip data={data} />

          {data.rows.length === 0 ? (
            <Card>
              <EmptyState
                icon={Tags}
                title={filtered ? 'No brand has listed products in this scope' : 'No brand has listed products yet'}
                description={
                  filtered
                    ? 'Relax the filters, or check that the brand’s products are listed at a retailer of the selected markets.'
                    : 'Brands appear here once their products have retailer listings. Add products and listings in the Product Catalogue.'
                }
                action={
                  filtered ? (
                    <Button size="sm" onClick={reset}>
                      Reset filters
                    </Button>
                  ) : (
                    <Link to="/catalogue" className="link text-[13px]">
                      Open the Product Catalogue
                    </Link>
                  )
                }
              />
            </Card>
          ) : view === 'table' ? (
            <BrandTable rows={data.rows} hrefOf={hrefOf} sort={sort} onSort={(next) => set({ sort: next })} refetching={false} converted={converted} />
          ) : (
            <BrandCards rows={data.rows} hrefOf={hrefOf} converted={converted} />
          )}

          <FxNote conversions={data.conversions} missing={data.missing_rates} target={data.target_currency} className="mt-3" />

          <div className="mt-4 flex flex-col gap-1 text-[12px] leading-5 text-ink-3">
            {data.summary.brands_without_listings > 0 ? (
              <p>
                {fmtNumber(data.summary.brands_without_listings)} more {data.summary.brands_without_listings === 1 ? 'brand' : 'brands'} in the catalogue{' '}
                {data.summary.brands_without_listings === 1 ? 'has' : 'have'} no listed product in this scope.{' '}
                <Link to="/catalogue?tab=taxonomy" className="link">
                  Brands &amp; categories
                </Link>
              </p>
            ) : null}
            <p>
              Current prices and the promotion share use fresh listings only — stale and never-observed listings are counted but not priced. Prices are shown per currency and never merged
              {converted ? '; this view converts them at the rates stated above' : ''}. The 30-day trend indexes each listing to its own first price in the period (= 100), holds a price for up to 7 days between
              observations and averages the brand’s listings, so it compares across markets and pack sizes.
            </p>
          </div>
        </div>
      )}
    </Page>
  );
}
