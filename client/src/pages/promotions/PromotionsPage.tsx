/**
 * Promotion Intelligence — observed promotional activity across brands, retailers and markets.
 * Everything on this screen is observation-based: a promotion exists where promotional pricing was actually
 * observed, and it is "running" only while its listing is still being observed.
 */
import { useState } from 'react';
import { Page } from '@/app/AppShell.tsx';
import { DemoNotice } from '@/components/domain/domain.tsx';
import { ListingDrawer } from '@/components/domain/observations.tsx';
import { DateRangePicker, FilterBar, MultiSelect, ProductPicker } from '@/components/ui/filters.tsx';
import { ErrorState, LoadingBlock, PageHeader, Segmented } from '@/components/ui/primitives.tsx';
import { fmtDate } from '@/lib/format.ts';
import { fromList, toList, useApiQuery } from '@/lib/hooks.ts';
import type { PromotionSummary } from '@shared/api/analytics.ts';
import { isRefetching, RANGE_PRESETS, usePromoFilters } from './filters.ts';
import { BreakdownTable, ByTypeCard, OwnVsCompetitorsCard, TopDiscountsCard } from './PromoBreakdowns.tsx';
import { IntensityChart, TimelineChart } from './PromoCharts.tsx';
import { EpisodesTable } from './PromoEpisodes.tsx';
import { PromoKpis } from './PromoKpis.tsx';

const OWNERSHIP = [
  { value: 'all', label: 'All brands' },
  { value: 'own', label: 'Own' },
  { value: 'competitor', label: 'Competitors' },
] as const;

export default function PromotionsPage() {
  const filters = usePromoFilters();
  const { state, setScope, period, today, options } = filters;
  const [listingId, setListingId] = useState<number | null>(null);

  const summary = useApiQuery<PromotionSummary>(['promotions', 'summary'], '/promotions/summary', filters.query ?? undefined, { enabled: !!filters.query });
  const ownership = state.ownership === 'own' || state.ownership === 'competitor' ? state.ownership : 'all';
  const refetching = isRefetching(summary);

  return (
    <Page>
      <PageHeader
        title="Promotion Intelligence"
        description={
          period
            ? `Promotional pricing observed ${fmtDate(period.from)} – ${fmtDate(period.to)}: how often, how deep and for how long each brand and retailer discounts.`
            : 'How often, how deep and for how long each brand and retailer discounts.'
        }
      />

      <FilterBar onReset={filters.resetScope} activeCount={filters.activeScope}>
        {today && period ? (
          <DateRangePicker value={period} onChange={filters.setRange} today={today} presets={RANGE_PRESETS} min={filters.dates.data?.first_observation_date} />
        ) : null}
        <MultiSelect label="Market" options={options.markets} value={toList(state.market_id)} onChange={(next) => setScope({ market_id: fromList(next) ?? null, retailer_id: null })} />
        <MultiSelect label="Retailer" options={options.retailers} value={toList(state.retailer_id)} onChange={(next) => setScope({ retailer_id: fromList(next) ?? null })} searchable />
        <MultiSelect label="Brand" options={options.brands} value={toList(state.brand_id)} onChange={(next) => setScope({ brand_id: fromList(next) ?? null })} />
        <MultiSelect label="Category" options={options.categories} value={toList(state.category_id)} onChange={(next) => setScope({ category_id: fromList(next) ?? null })} searchable={false} />
        <Segmented label="Brand ownership" value={ownership} onChange={(next) => setScope({ ownership: next === 'all' ? null : next })} options={OWNERSHIP.map((o) => ({ ...o }))} />
        <ProductPicker value={toList(state.product_id)} onChange={(next) => setScope({ product_id: fromList(next) ?? null })} />
      </FilterBar>

      {filters.dates.isError ? (
        <ErrorState error={filters.dates.error} onRetry={() => void filters.dates.refetch()} />
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : !summary.data || !period ? (
        <LoadingBlock className="min-h-64" label="Loading promotions…" />
      ) : (
        <div className="flex flex-col gap-4">
          <DemoNotice demo={summary.data.demo} />

          <div className={refetching ? 'opacity-60 transition-opacity' : undefined}>
            <PromoKpis summary={summary.data} period={summary.data.period} />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <IntensityChart filters={filters} />
            <OwnVsCompetitorsCard rows={summary.data.by_ownership} refetching={refetching} />
          </div>

          <TimelineChart filters={filters} />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <ByTypeCard rows={summary.data.by_type} refetching={refetching} />
            <TopDiscountsCard rows={summary.data.top_discounts} onOpen={setListingId} refetching={refetching} />
          </div>

          <div className="grid gap-4 3xl:grid-cols-2">
            <BreakdownTable
              title="By brand"
              subtitle="Own brands and competitors, side by side"
              firstColumn="Brand"
              rows={summary.data.by_brand}
              showOwnership
              refetching={refetching}
              maxHeight={420}
            />
            <BreakdownTable
              title="By retailer"
              subtitle="Retailer-specific promotional activity"
              firstColumn="Retailer"
              rows={summary.data.by_retailer}
              refetching={refetching}
              maxHeight={420}
            />
          </div>

          <EpisodesTable filters={filters} onOpen={setListingId} />
        </div>
      )}

      <ListingDrawer listingId={listingId} onClose={() => setListingId(null)} />
    </Page>
  );
}
