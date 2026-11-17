/**
 * Market Intelligence — every configured market with its retailers, currency, schedule, coverage and health,
 * plus cross-market price comparison normalised for currency and pack size.
 */
import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import { Page } from '@/app/AppShell.tsx';
import { FilterBar } from '@/components/ui/filters.tsx';
import { Card, EmptyState, ErrorState, LoadingBlock, PageHeader, Segmented } from '@/components/ui/primitives.tsx';
import { useCan } from '@/lib/auth.tsx';
import { useApiQuery, useUrlState } from '@/lib/hooks.ts';
import type { MarketOverviewRow } from '@shared/api/analytics.ts';
import { CrossMarket } from './CrossMarket.tsx';
import { DemoMarketsNotice, MarketCard, MarketSummary, useNow } from './MarketCards.tsx';

export type MarketParams = {
  view: string | undefined;
  /** activity window of the market cards, and the averaging period of the product comparison */
  days: string | undefined;
  mode: string | undefined;
  product_id: string | undefined;
  category_id: string | undefined;
  brand_id: string | undefined;
  currency: string | undefined;
  base_market_id: string | undefined;
};

const DEFAULTS: MarketParams = {
  view: 'markets',
  days: '30',
  mode: 'product',
  product_id: undefined,
  category_id: undefined,
  brand_id: undefined,
  currency: undefined,
  base_market_id: undefined,
};

export type MarketUrl = ReturnType<typeof useUrlState<MarketParams>>;

const VIEWS = [
  { value: 'markets', label: 'Markets' },
  { value: 'cross', label: 'Cross-market comparison' },
] as const;

const PERIODS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

function MarketsView({ url }: { url: MarketUrl }) {
  const canManage = useCan('admin.settings');
  const now = useNow();
  const days = ['7', '30', '90'].includes(url.state.days ?? '') ? Number(url.state.days) : 30;
  const q = useApiQuery<{ markets: MarketOverviewRow[] }>(['market-intel', 'overview'], '/market-intel/overview', { days });
  const refetching = q.isFetching && !q.isPending;

  return (
    <>
      <FilterBar
        trailing={
          canManage ? (
            <Link
              to="/admin?tab=markets"
              className="inline-flex h-[34px] items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 text-[13px] font-medium text-ink transition-colors hover:border-ink-4 hover:bg-sunken"
            >
              <Plus className="size-3.5" aria-hidden />
              Add or edit markets
            </Link>
          ) : null
        }
      >
        <span className="text-[13px] text-ink-3">Activity and collection over the last</span>
        <Segmented label="Activity period" value={String(days)} onChange={(next) => url.set({ days: next === '30' ? null : next })} options={PERIODS} />
      </FilterBar>

      {q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        </Card>
      ) : !q.data ? (
        <LoadingBlock className="min-h-64" label="Loading markets…" />
      ) : q.data.markets.length === 0 ? (
        <Card>
          <EmptyState
            title="No markets configured"
            description="Markets hold their own retailers, currency, listings, competitor mapping and collection schedule."
            action={
              canManage ? (
                <Link className="link text-[13px]" to="/admin?tab=markets">
                  Add a market
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className={refetching ? 'flex flex-col gap-4 opacity-60 transition-opacity' : 'flex flex-col gap-4'}>
          <DemoMarketsNotice markets={q.data.markets} />
          <MarketSummary markets={q.data.markets} />
          <div className="grid gap-4 md:grid-cols-2 3xl:grid-cols-3">
            {q.data.markets.map((market) => (
              <MarketCard key={market.id} market={market} days={days} now={now} canManage={canManage} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default function MarketsPage() {
  const url = useUrlState<MarketParams>(DEFAULTS);
  const view = url.state.view === 'cross' ? 'cross' : 'markets';
  return (
    <Page>
      <PageHeader
        title="Market Intelligence"
        description={
          view === 'markets'
            ? 'Each market has its own retailers, currency, listings, competitor mapping and collection schedule. Times are shown in market-local time.'
            : 'Compare prices across markets — always converted to one currency with a stated exchange rate, and normalised to unit price.'
        }
        actions={<Segmented label="View" value={view} onChange={(next) => url.set({ view: next === 'markets' ? null : next }, { replace: false })} options={VIEWS.map((v) => ({ ...v }))} />}
      />
      {view === 'markets' ? <MarketsView url={url} /> : <CrossMarket url={url} />}
    </Page>
  );
}
