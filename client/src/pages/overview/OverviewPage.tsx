/** Executive overview (route "/"). All content comes from GET /api/overview. */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { RefreshCw } from 'lucide-react';
import type { OverviewResult } from '@shared/api/analytics.ts';
import { Page } from '@/app/AppShell.tsx';
import { ListingDrawer } from '@/components/domain/observations.tsx';
import { FilterBar, MultiSelect } from '@/components/ui/filters.tsx';
import { Button, Card, cn, EmptyState, ErrorState, IconButton, PageHeader, Segmented, Skeleton } from '@/components/ui/primitives.tsx';
import { useAuth } from '@/lib/auth.tsx';
import { fmtDate, fmtDateTime } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useReference, useUrlState } from '@/lib/hooks.ts';
import {
  CurrentPromotionsCard, KpiTiles, MarketsCard, PositioningCard, PriceChangesChart, PriceIndexChart, PromoShareChart, ProvenanceStrip, RecentChangesCard,
} from './sections.tsx';

const PERIODS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy aria-label="Loading overview">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-[108px] rounded-[10px]" />
        ))}
      </div>
      <Skeleton className="h-24 rounded-[10px]" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80 rounded-[10px]" />
        <Skeleton className="h-80 rounded-[10px]" />
      </div>
    </div>
  );
}

/** Shown when nothing is monitored yet (an empty workspace without demo data). */
function GettingStarted() {
  const navigate = useNavigate();
  const { can } = useAuth();
  return (
    <Card>
      <EmptyState
        title="Nothing is being monitored yet"
        description="Add your products and retailers, link retailer listings to products, then enter or import prices. Every observation is kept in the ledger from the first one."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => navigate('/catalogue')}>
              Open the product catalogue
            </Button>
            <Button onClick={() => navigate('/collection')}>Set up data collection</Button>
            {can('admin.demo') ? <Button onClick={() => navigate('/admin?tab=database')}>Load the demo dataset</Button> : null}
          </div>
        }
      />
    </Card>
  );
}

export default function OverviewPage() {
  const { state, set, reset, activeCount } = useUrlState<{ days: string | undefined; market_id: string | undefined }>({ days: '30', market_id: undefined });
  const days = PERIODS.some((p) => p.value === state.days) ? state.days! : '30';
  const { ref } = useReference();
  const [listingId, setListingId] = useState<number | null>(null);

  const query = useApiQuery<OverviewResult>(['overview'], '/overview', { days, market_id: state.market_id }, { refetchInterval: 120_000 });
  const data = query.data;
  const refetching = query.isFetching && !query.isPending;

  const marketOptions = useMemo(
    () => (ref?.markets ?? []).filter((m) => m.is_active).map((m) => ({ value: String(m.id), label: m.name, sublabel: `${m.code} · ${m.currency_code}` })),
    [ref],
  );

  const nothingMonitored = !!data && data.kpis.listings_active === 0 && data.kpis.observations_total === 0 && !data.market_ids;

  return (
    <Page>
      <PageHeader
        title="Overview"
        description="Price position, price movements, promotions and collection health across your monitored products, retailers and markets."
      />
      <FilterBar
        onReset={reset}
        activeCount={activeCount}
        trailing={
          data ? (
            <>
              <span className="text-[12px] leading-4 text-ink-3">
                {fmtDate(data.period.from)} – {fmtDate(data.period.to)} · as of {fmtDateTime(data.generated_at)}
              </span>
              <IconButton icon={RefreshCw} label="Refresh" size="sm" variant="secondary" className={cn(query.isFetching && '[&>svg]:animate-spin-slow')} onClick={() => void query.refetch()} />
            </>
          ) : null
        }
      >
        <Segmented label="Period" value={days} onChange={(v) => set({ days: v })} options={PERIODS} />
        <MultiSelect label="Market" options={marketOptions} value={toList(state.market_id)} onChange={(next) => set({ market_id: fromList(next) })} />
      </FilterBar>

      {query.isPending ? (
        <OverviewSkeleton />
      ) : query.isError || !data ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className={cn('flex flex-col gap-4 transition-opacity', refetching && 'opacity-60')}>
            <KpiTiles data={data} />
            {nothingMonitored ? <GettingStarted /> : <ProvenanceStrip data={data} />}
          </div>
          {nothingMonitored ? null : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <PriceIndexChart data={data} refetching={refetching} />
                <PriceChangesChart data={data} refetching={refetching} />
              </div>
              <div className="grid gap-4 min-[87.5rem]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <PositioningCard data={data} />
                <RecentChangesCard data={data} refetching={refetching} onOpenListing={setListingId} />
              </div>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
                <PromoShareChart data={data} refetching={refetching} />
                <CurrentPromotionsCard data={data} />
              </div>
              <MarketsCard data={data} refetching={refetching} />
            </>
          )}
        </div>
      )}

      <ListingDrawer listingId={listingId} onClose={() => setListingId(null)} />
    </Page>
  );
}
