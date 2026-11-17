/** Which prices moved the most in the period: ranked by volatility (standard deviation ÷ mean of the daily prices). */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { fmtNumber, fmtPct, fmtPrice } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Segmented } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { BarList } from '@/components/charts/charts.tsx';
import { DemoBadge, OwnershipDot } from '@/components/domain/domain.tsx';
import { ListingDrawer } from '@/components/domain/observations.tsx';
import type { VolatilityRow } from '@shared/api/analytics.ts';
import type { HistoryFilters } from './filters.ts';
import { isRefetching } from './parts.tsx';

interface VolatilityResponse {
  period: { from: string | null; to: string | null };
  rows: VolatilityRow[];
}

export function VolatilityCard({ filters }: { filters: HistoryFilters }) {
  const { state, set } = filters;
  const groupBy = state.vol_group === 'product' ? 'product' : 'listing';
  const [listingId, setListingId] = useState<number | null>(null);
  const query = useApiQuery<VolatilityResponse>(['history', 'volatility'], '/history/volatility', { ...filters.scopeQuery, group_by: groupBy, limit: 15 }, { enabled: filters.ready });
  const rows = query.data?.rows;
  const top = Math.max(0, ...(rows ?? []).map((r) => r.volatility_pct));

  const columns = useMemo<Array<Column<VolatilityRow>>>(
    () => [
      {
        key: 'item',
        header: groupBy === 'product' ? 'Product' : 'Listing',
        nowrap: false,
        cell: (r) => (
          <span className="flex min-w-0 items-center gap-2">
            <OwnershipDot ownership={r.ownership} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                {groupBy === 'product' && r.product_id ? (
                  <Link to={`/catalogue/products/${r.product_id}`} className="truncate font-medium text-ink hover:underline">
                    {r.label}
                  </Link>
                ) : (
                  <span className="truncate font-medium text-ink">{r.label}</span>
                )}
                {r.is_demo ? <DemoBadge /> : null}
              </span>
              {r.sublabel ? <span className="block truncate text-[11.5px] leading-4 text-ink-3">{r.sublabel}</span> : null}
            </span>
          </span>
        ),
      },
      { key: 'days', header: 'Days', align: 'right', cell: (r) => fmtNumber(r.days), hideBelow: 'sm', headerTitle: 'Days with a priced observation' },
      { key: 'changes', header: 'Changes', align: 'right', cell: (r) => fmtNumber(r.price_changes), headerTitle: 'Number of day-to-day price changes' },
      { key: 'min', header: 'Lowest', align: 'right', cell: (r) => `${fmtPrice(r.min, r.currency)} ${r.currency}`, hideBelow: 'md' },
      { key: 'max', header: 'Highest', align: 'right', cell: (r) => `${fmtPrice(r.max, r.currency)} ${r.currency}`, hideBelow: 'md' },
      { key: 'range', header: 'Range', align: 'right', cell: (r) => fmtPct(r.range_pct, 1), headerTitle: 'Highest above lowest, in %', hideBelow: 'sm' },
      {
        key: 'vol',
        header: 'Volatility',
        align: 'right',
        headerTitle: 'Standard deviation ÷ mean of the daily prices',
        cell: (r) => (
          <span className="inline-flex items-center justify-end gap-2">
            <span aria-hidden className="hidden h-1.5 w-20 rounded-full bg-wash sm:inline-block 2xl:hidden">
              <span className="block h-1.5 rounded-r-full bg-s1" style={{ width: `${top > 0 ? Math.max(2, (r.volatility_pct / top) * 100) : 0}%` }} />
            </span>
            <span className="w-12 font-medium text-ink">{fmtPct(r.volatility_pct, 1)}</span>
          </span>
        ),
      },
    ],
    [groupBy, top],
  );

  return (
    <Card className="mb-6">
      <CardHeader
        title="Highest price volatility"
        subtitle="Ranked by the spread of daily selling prices in the selected period (standard deviation ÷ mean). Volatility is unit-free, so listings in different currencies can be ranked together."
        actions={
          <Segmented
            label="Rank"
            size="sm"
            value={groupBy}
            onChange={(v) => set({ vol_group: v })}
            options={[
              { value: 'listing', label: 'Listings' },
              { value: 'product', label: 'Products' },
            ]}
          />
        }
      />
      {query.isError && !rows ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !rows ? (
        <LoadingBlock className="min-h-40" />
      ) : rows.length === 0 ? (
        <EmptyState title="Not enough history" description="Volatility needs at least five days of priced observations per listing in the selected period." />
      ) : (
        <div className={`grid 2xl:grid-cols-[minmax(0,4fr)_minmax(0,10fr)] ${isRefetching(query) ? 'opacity-60' : ''}`}>
          <div className="hidden border-line p-4 2xl:block 2xl:border-r">
            <BarList
              data={rows.slice(0, 8).map((r) => ({ key: r.key, label: r.label, sublabel: r.sublabel, value: r.volatility_pct, display: fmtPct(r.volatility_pct, 1) }))}
            />
          </div>
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.key} dense onRowClick={groupBy === 'listing' ? (r) => setListingId(r.listing_id) : undefined} />
        </div>
      )}
      <ListingDrawer listingId={listingId} onClose={() => setListingId(null)} />
    </Card>
  );
}
