/** Brand Explorer — dense, sortable table of the same brand rows as the cards. */
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { Tags } from 'lucide-react';
import { fmtNumber } from '@/lib/format.ts';
import { Card, EmptyState } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { ChangeCell, DemoBadge, OwnershipDot } from '@/components/domain/domain.tsx';
import type { BrandExplorerRow } from '@shared/api/brands.ts';
import { BrandIndexCell, FreshnessBadges, LastObserved, MovesCell, PriceRanges, PromoShare, TrendSpark, useElementWidth } from './parts.tsx';

type FitColumn = Column<BrandExplorerRow> & { minWidth?: number };

export function BrandTable({
  rows, hrefOf, sort, onSort, refetching, converted,
}: {
  rows: BrandExplorerRow[];
  hrefOf: (row: BrandExplorerRow) => string;
  sort: string;
  onSort: (sort: string) => void;
  refetching: boolean;
  converted: boolean;
}) {
  const navigate = useNavigate();
  const [ref, width] = useElementWidth();

  const columns = useMemo<FitColumn[]>(
    () => [
      {
        key: 'brand',
        header: 'Brand',
        sortKey: 'name',
        nowrap: false,
        cell: (r) => (
          <span className="flex max-w-[15rem] min-w-[7.5rem] items-start gap-2">
            <OwnershipDot ownership={r.ownership} className="mt-[7px]" />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <Link to={hrefOf(r)} className="font-medium break-words text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                  {r.name}
                </Link>
                {r.is_demo ? <DemoBadge /> : null}
              </span>
              <span className="block text-[11.5px] leading-4 text-ink-3">
                {r.ownership === 'own' ? 'Own brand' : 'Competitor'}
                {r.categories.length ? ` · ${r.categories.map((c) => c.name).join(', ')}${r.category_count > r.categories.length ? '…' : ''}` : ''}
              </span>
            </span>
          </span>
        ),
      },
      { key: 'products', header: 'Products', align: 'right', sortKey: 'products', cell: (r) => fmtNumber(r.products), minWidth: 480 },
      {
        key: 'listings',
        header: 'Listings',
        align: 'right',
        sortKey: 'listings',
        headerTitle: 'Active retailer listings of the brand in this scope',
        cell: (r) => <span className="font-medium text-ink">{fmtNumber(r.listings)}</span>,
      },
      {
        key: 'coverage',
        header: 'Listed at',
        sortKey: 'retailers',
        cell: (r) => (
          <span className="num whitespace-nowrap text-ink-2">
            {fmtNumber(r.retailers)} retailer{r.retailers === 1 ? '' : 's'} · {fmtNumber(r.markets)} market{r.markets === 1 ? '' : 's'}
          </span>
        ),
        minWidth: 1280,
      },
      {
        key: 'trend',
        header: width > 0 && width < 480 ? '30 days' : '30-day trend',
        sortKey: 'trend',
        headerTitle: 'Average change of the listings’ prices over the last 30 days (each listing against its own first price)',
        // phones: the figure alone, so the brand name keeps its room
        cell: (r) => (width > 0 && width < 480 ? <ChangeCell pct={r.trend_change_pct} /> : <TrendSpark points={r.trend} change={r.trend_change_pct} ownership={r.ownership} width={64} />),
      },
      {
        key: 'promo',
        header: 'On promotion',
        align: 'right',
        sortKey: 'promo_share',
        headerTitle: 'Share of fresh listings currently on promotion',
        cell: (r) => <PromoShare promo={r.promo} className="items-end" />,
        minWidth: 600,
      },
      {
        key: 'moves',
        header: 'Moves 7 d',
        sortKey: 'moves',
        headerTitle: 'Selling-price increases and decreases in the last 7 days',
        cell: (r) => <MovesCell moves={r.moves_7d} />,
        minWidth: 700,
      },
      {
        key: 'index',
        header: 'Price index',
        sortKey: 'index',
        headerTitle: 'Own ÷ competitor price × 100 over mapped same-retailer pairs (100 = parity)',
        cell: (r) => <BrandIndexCell value={r.price_index} compact />,
        minWidth: 940,
      },
      {
        key: 'prices',
        header: converted ? 'Current prices (converted)' : 'Current prices',
        headerTitle: 'Lowest to highest current selling price of the fresh listings — one line per currency',
        nowrap: false,
        cell: (r) => <PriceRanges ranges={r.price_ranges} limit={2} showMedian={false} />,
        minWidth: 1080,
      },
      {
        key: 'observed',
        header: 'Last observed',
        sortKey: 'last_observation',
        nowrap: false,
        cell: (r) => (
          <span className="flex flex-col gap-0.5 text-[12.5px] text-ink-2">
            <LastObserved iso={r.freshness.last_observed_at} />
            {r.freshness.stale + r.freshness.never_observed > 0 ? <FreshnessBadges freshness={r.freshness} className="text-[11.5px] text-ink-3" /> : null}
          </span>
        ),
        minWidth: 820,
      },
    ],
    [hrefOf, width, converted],
  );
  const visible = useMemo(() => columns.filter((c) => !c.minWidth || width >= c.minWidth), [columns, width]);

  return (
    <div ref={ref} className="min-w-0">
      <Card>
        <DataTable
          columns={visible}
          rows={rows}
          rowKey={(r) => r.id}
          sort={sort}
          onSort={onSort}
          onRowClick={(r) => navigate(hrefOf(r))}
          refetching={refetching}
          dense
          empty={<EmptyState icon={Tags} title="No brand matches" description="Relax the filters to see more brands." />}
        />
      </Card>
    </div>
  );
}
