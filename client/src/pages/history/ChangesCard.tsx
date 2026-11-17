/** Where prices moved: price changes of the selected period counted per retailer, market, brand, category or product. */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { fmtNumber, fmtPct, fmtRelative } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Segmented } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { DIVERGING } from '@/components/charts/kit.tsx';
import { DemoBadge, OwnershipDot } from '@/components/domain/domain.tsx';
import type { EventGroupBy, PriceChangeBreakdown, PriceChangeBreakdownRow } from '@shared/api/analytics.ts';
import type { HistoryFilters } from './filters.ts';
import { isRefetching } from './parts.tsx';

const GROUPS: Array<{ value: EventGroupBy; label: string; column: string; filterKey: 'retailer_id' | 'market_id' | 'brand_id' | 'category_id' | 'product_id' }> = [
  { value: 'retailer', label: 'Retailer', column: 'Retailer', filterKey: 'retailer_id' },
  { value: 'market', label: 'Market', column: 'Market', filterKey: 'market_id' },
  { value: 'brand', label: 'Brand', column: 'Brand', filterKey: 'brand_id' },
  { value: 'category', label: 'Category', column: 'Category', filterKey: 'category_id' },
  { value: 'product', label: 'Product', column: 'Product', filterKey: 'product_id' },
];

const COLLAPSED_ROWS = 10;

export function ChangesCard({ filters }: { filters: HistoryFilters }) {
  const { state, set } = filters;
  const group = GROUPS.find((g) => g.value === state.chg_group) ?? GROUPS[0]!;
  const query = useApiQuery<PriceChangeBreakdown>(['history', 'changes-by'], '/events/summary', { ...filters.scopeQuery, group_by: group.value }, { enabled: filters.ready });
  const data = query.data;
  const rows = data?.rows;
  const [expanded, setExpanded] = useState(false);
  const shown = rows && !expanded ? rows.slice(0, COLLAPSED_ROWS) : rows;
  const top = Math.max(1, ...(rows ?? []).map((r) => Math.max(r.increases, r.decreases)));

  const columns = useMemo<Array<Column<PriceChangeBreakdownRow>>>(
    () => [
      {
        key: 'name',
        header: group.column,
        nowrap: false,
        cell: (r) => (
          <span className="flex min-w-0 items-center gap-2">
            {r.ownership ? <OwnershipDot ownership={r.ownership} /> : null}
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-medium text-ink">{r.label}</span>
                {r.is_demo ? <DemoBadge /> : null}
              </span>
              {r.sublabel ? <span className="block truncate text-[11.5px] leading-4 text-ink-3">{r.sublabel}</span> : null}
            </span>
          </span>
        ),
      },
      { key: 'listings', header: 'Listings', align: 'right', cell: (r) => fmtNumber(r.listings), headerTitle: 'Listings with at least one price change in the period', hideBelow: 'md' },
      {
        key: 'balance',
        header: 'Decreases · Increases',
        headerTitle: 'Number of price decreases (left) and increases (right) in the period',
        hideBelow: 'sm',
        cell: (r) => (
          <span className="flex w-40 items-center gap-px" aria-hidden>
            <span className="flex h-2 flex-1 justify-end rounded-l-full bg-wash">
              <span className="h-2 rounded-l-full" style={{ width: `${(r.decreases / top) * 100}%`, background: DIVERGING.negative }} />
            </span>
            <span className="flex h-2 flex-1 rounded-r-full bg-wash">
              <span className="h-2 rounded-r-full" style={{ width: `${(r.increases / top) * 100}%`, background: DIVERGING.positive }} />
            </span>
          </span>
        ),
      },
      {
        key: 'down',
        header: 'Decreases',
        align: 'right',
        cell: (r) => (
          <span className="inline-flex items-center gap-1">
            <ArrowDown className="size-3 text-ink-3" aria-hidden />
            <span className="font-medium text-ink">{fmtNumber(r.decreases)}</span>
          </span>
        ),
      },
      { key: 'avg_down', header: 'Avg decrease', align: 'right', cell: (r) => (r.avg_decrease_pct === null ? '—' : fmtPct(r.avg_decrease_pct, 1, true)), hideBelow: 'lg' },
      {
        key: 'up',
        header: 'Increases',
        align: 'right',
        cell: (r) => (
          <span className="inline-flex items-center gap-1">
            <ArrowUp className="size-3 text-ink-3" aria-hidden />
            <span className="font-medium text-ink">{fmtNumber(r.increases)}</span>
          </span>
        ),
      },
      { key: 'avg_up', header: 'Avg increase', align: 'right', cell: (r) => (r.avg_increase_pct === null ? '—' : fmtPct(r.avg_increase_pct, 1, true)), hideBelow: 'lg' },
      { key: 'last', header: 'Latest change', align: 'right', cell: (r) => (r.last_change_at ? fmtRelative(r.last_change_at) : '—'), hideBelow: 'xl' },
    ],
    [group.column, top],
  );

  return (
    <Card className="mb-6">
      <CardHeader
        title={`Price changes by ${group.label.toLowerCase()}`}
        subtitle={
          data && data.totals.increases + data.totals.decreases > 0
            ? `${fmtNumber(data.totals.increases)} increases and ${fmtNumber(data.totals.decreases)} decreases in the selected period. A change is a difference in selling price between two consecutive observations of one listing; promotional cuts and their endings count. Select a row to narrow the whole page to it.`
            : 'Changes in selling price between consecutive observations of a listing, counted for the selected period.'
        }
      />
      <div className="border-b border-line px-4 py-2.5">
        <Segmented label="Count price changes by" size="sm" value={group.value} onChange={(v) => set({ chg_group: v })} options={GROUPS.map((g) => ({ value: g.value, label: g.label }))} />
      </div>
      {query.isError && !rows ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !rows ? (
        <LoadingBlock className="min-h-40" />
      ) : rows.length === 0 ? (
        <EmptyState title="No price changes in this selection" description="No listing in scope changed its selling price between two observations in the selected period." />
      ) : (
        <div className={isRefetching(query) ? 'opacity-60' : ''}>
          <DataTable
            columns={columns}
            rows={shown ?? rows}
            rowKey={(r) => r.key}
            dense
            onRowClick={(r) => {
              if (r.id !== null) set({ [group.filterKey]: String(r.id), page: '1' });
            }}
          />
          {rows.length > COLLAPSED_ROWS || (data && data.totals.groups > rows.length) ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-[12px] text-ink-3">
              <span>
                Showing the {fmtNumber((shown ?? rows).length)} most active of {fmtNumber(data?.totals.groups ?? rows.length)}.
              </span>
              {rows.length > COLLAPSED_ROWS ? (
                <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? 'Show fewer' : `Show all ${fmtNumber(rows.length)}`}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
