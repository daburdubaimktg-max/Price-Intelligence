/**
 * Deals (route "/deals"): the listings that are on offer right now, from GET /api/deals — with the tags the
 * retailer shows, the discount against the regular price and, once history has built up, the price against the
 * listing's own 30-day average and 90-day low — and, above the list, the comparison of those offers by brand,
 * product range, retailer and market (GET /api/deals/compare). Refreshes itself every minute.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ListFilter, PackageCheck, RefreshCw, Tags, TrendingDown, X } from 'lucide-react';
import type { DealsResponse } from '@shared/api/deals.ts';
import { Page } from '@/app/AppShell.tsx';
import { DemoNotice } from '@/components/domain/domain.tsx';
import { ListingDrawer } from '@/components/domain/observations.tsx';
import { FilterBar, MultiSelect, ProductPicker, SearchInput } from '@/components/ui/filters.tsx';
import { Button, Card, cn, ErrorState, IconButton, LoadingBlock, PageHeader, Segmented, Select } from '@/components/ui/primitives.tsx';
import { fmtNumber } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useIsNarrow } from '@/lib/hooks.ts';
import { DealsList } from './DealsList.tsx';
import { DealsCompare } from './DealsCompare.tsx';
import { DealsSummaryStrip } from './DealsSummary.tsx';
import { MIN_DISCOUNT_OPTIONS, OWNERSHIP_OPTIONS, SORT_OPTIONS, sortLabel, useDealFilters } from './filters.ts';
import { TagFilterChips, ToggleChip } from './TagFilter.tsx';

const REFRESH_MS = 60_000;
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const toggleIn = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

export default function DealsPage() {
  const client = useQueryClient();
  const filters = useDealFilters();
  const { state, filter, set, reset, options, sort, filtered } = filters;
  const [listingId, setListingId] = useState<number | null>(null);
  // On phones the dimension filters sit behind one button so the deals are not pushed below the fold.
  const phone = useIsNarrow(639);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const query = useApiQuery<DealsResponse>(['deals'], '/deals', filters.query, { refetchInterval: REFRESH_MS });
  const data = query.data;
  const summary = data?.summary;
  const refetching = query.isFetching && !query.isPending && query.isPlaceholderData;
  const tags = toList(state.tag);

  const refreshAll = () => {
    void query.refetch();
    void client.invalidateQueries({ queryKey: ['monitor'] });
  };

  return (
    <Page>
      <PageHeader
        title="Deals"
        description="Listings on offer right now: the latest fresh observation carries an offer tag from the retailer, is on promotion, or sells below its regular price. Badges such as “Best seller” are shown with a deal but do not make one."
      />

      <FilterBar>
        {phone ? (
          <Button icon={ListFilter} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
            Filters{filters.dimensionFilters > 0 ? ` (${filters.dimensionFilters})` : ''}
          </Button>
        ) : null}
        {!phone || filtersOpen ? (
          <>
            <MultiSelect label="Market" options={options.market} value={filters.selectedMarkets} onChange={(next) => filter({ market_id: fromList(next), retailer_id: undefined })} />
            <MultiSelect label="Retailer" options={options.retailer} value={toList(state.retailer_id)} onChange={(next) => filter({ retailer_id: fromList(next) })} />
            <MultiSelect label="Brand" options={options.brand} value={toList(state.brand_id)} onChange={(next) => filter({ brand_id: fromList(next) })} />
            <MultiSelect label="Category" options={options.category} value={toList(state.category_id)} onChange={(next) => filter({ category_id: fromList(next) })} />
            <Segmented label="Ownership" value={state.ownership ?? 'all'} onChange={(v) => filter({ ownership: v })} options={OWNERSHIP_OPTIONS} />
            <ProductPicker value={toList(state.product_id)} onChange={(next) => filter({ product_id: fromList(next) })} />
          </>
        ) : null}
        <SearchInput value={state.q ?? ''} onChange={(q) => filter({ q: q || undefined })} placeholder="Search product, brand, retailer…" className={phone ? 'w-auto min-w-0 flex-1' : undefined} />
        {filtered ? (
          <Button variant="ghost" icon={X} onClick={reset}>
            Reset
          </Button>
        ) : null}

        <div className="-mx-3 flex min-w-0 basis-[calc(100%+1.5rem)] flex-col gap-2 sm:mx-0 sm:basis-full">
          <TagFilterChips counts={summary?.by_tag} selected={tags} onToggle={(tag) => filter({ tag: fromList(toggleIn(tags, tag)) })} loading={refetching} />
          <div className="flex items-center gap-1.5 overflow-x-auto px-3 pb-1 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0" role="group" aria-label="Deal filters">
            <label className="flex shrink-0 items-center gap-2 text-[12.5px] text-ink-3">
              <span className="eyebrow">Discount</span>
              <Select
                className="w-40"
                value={state.min_discount ?? ''}
                onChange={(e) => filter({ min_discount: e.target.value || undefined })}
                aria-label="Minimum discount against the regular price"
              >
                {MIN_DISCOUNT_OPTIONS.some((o) => o.value === (state.min_discount ?? '')) ? null : <option value={state.min_discount}>{state.min_discount}% or more</option>}
                {MIN_DISCOUNT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </label>
            <ToggleChip
              on={state.in_stock === 'true'}
              onToggle={() => filter({ in_stock: state.in_stock === 'true' ? undefined : 'true' })}
              label="In stock only"
              icon={PackageCheck}
              title="Leave out deals last observed as out of stock"
            />
            <ToggleChip
              on={state.lowest_only === 'true'}
              onToggle={() => filter({ lowest_only: state.lowest_only === 'true' ? undefined : 'true' })}
              label="90-day low only"
              icon={TrendingDown}
              count={state.lowest_only === 'true' ? null : (summary?.lowest_90d ?? null)}
              title="Only deals whose current price is the lowest daily price of the last 90 days (needs 7 observed days per listing)"
            />
            <ToggleChip
              on={state.include_badges === 'true'}
              onToggle={() => filter({ include_badges: state.include_badges === 'true' ? undefined : 'true' })}
              label="Include badge-only listings"
              icon={Tags}
              title="Also list fresh listings that only carry a badge (best seller, retailer's choice, selling fast, other) without being on offer"
            />
          </div>
        </div>
      </FilterBar>

      {query.isError && !data ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !data || !summary ? (
        <LoadingBlock className="min-h-64" label="Loading the current deals…" />
      ) : (
        <div className="flex flex-col gap-4">
          <DemoNotice demo={summary.demo} />

          <div className={cn('transition-opacity', refetching && 'opacity-60')}>
            <DealsSummaryStrip summary={summary} onOpenListing={setListingId} />
          </div>

          {/* The comparison: who has how much of the range on offer, how deep, where, and how that moved. */}
          <DealsCompare filters={filters} />

          <Card>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 text-[12.5px] leading-5 text-ink-3">
              <span className="order-1 min-w-0 flex-1">
                <span className="num font-semibold text-ink">{fmtNumber(data.total)}</span> {data.total === 1 ? 'deal' : 'deals'}
                {filtered ? ' match the filters' : ''}
                <span className="hidden lg:inline"> · sorted by {sortLabel(sort).toLowerCase()}</span>
              </span>
              <span className="order-2 flex items-center gap-2 sm:order-3" aria-live="polite">
                <span className="hidden md:inline">{query.dataUpdatedAt ? `Updated ${clock.format(new Date(query.dataUpdatedAt))}, refreshes every minute` : null}</span>
                <IconButton icon={RefreshCw} label="Refresh now" size="sm" variant="secondary" className={cn(query.isFetching && '[&>svg]:animate-spin-slow')} onClick={refreshAll} />
              </span>
              {/* its own full-width line on phones, between the count and the refresh button otherwise */}
              <label className="order-3 flex basis-full items-center gap-2 whitespace-nowrap sm:order-2 sm:basis-auto">
                Sort by
                <Select className="min-w-0 flex-1 sm:w-64 sm:flex-none" value={sort} onChange={(e) => set({ sort: e.target.value, page: undefined })} aria-label="Sort the deals by">
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <DealsList
              data={data}
              loading={query.isPending}
              refetching={refetching}
              sort={sort}
              onSort={(next) => set({ sort: next, page: undefined })}
              onPage={(page) => set({ page: String(page) })}
              onOpen={setListingId}
              selectedId={listingId}
              filtered={filtered}
              onReset={reset}
            />
          </Card>
        </div>
      )}

      <ListingDrawer listingId={listingId} onClose={() => setListingId(null)} />
    </Page>
  );
}
