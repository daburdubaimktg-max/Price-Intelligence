/** The stored observation records themselves, with server-side sorting, paging and CSV / Excel export. */
import { useMemo, useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';
import { download, type Paged } from '@/lib/api.ts';
import { fmtDate, fmtNumber, fmtPrice, plural } from '@/lib/format.ts';
import { useApiQuery, useIsNarrow } from '@/lib/hooks.ts';
import { Button, Card, CardHeader, EmptyState, ErrorState, Select, Tip } from '@/components/ui/primitives.tsx';
import { useToast } from '@/components/ui/overlays.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { AvailabilityBadge, ConfidenceBadge, DataClassBadge, MarketTime, packText, PriceCell, ProductCell, PromoBadge } from '@/components/domain/domain.tsx';
import { ObservationDrawer } from '@/components/domain/observations.tsx';
import type { ObservationRecord } from '@shared/api/observations.ts';
import type { HistoryFilters } from './filters.ts';
import { isRefetching } from './parts.tsx';

export function ObservationsCard({ filters }: { filters: HistoryFilters }) {
  const { state, set } = filters;
  const toast = useToast();
  const [openId, setOpenId] = useState<number | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const page = Math.max(1, Number(state.page) || 1);
  const pageSize = [25, 50, 100].includes(Number(state.page_size)) ? Number(state.page_size) : 25;

  const query = useApiQuery<Paged<ObservationRecord>>(
    ['observations', 'list'],
    '/observations',
    { ...filters.scopeQuery, sort: state.sort, page, page_size: pageSize },
    { enabled: filters.ready },
  );
  const data = query.data;

  const narrow = useIsNarrow(639);
  const roomy = !useIsNarrow(1535);
  // Phones: two columns — what / where / when, and the price — so the essentials are visible without scrolling.
  const narrowColumns = useMemo<Array<Column<ObservationRecord>>>(
    () => [
      {
        key: 'observation',
        header: 'Observation',
        sortKey: 'observed_at',
        nowrap: false,
        cell: (o) => (
          <div className="max-w-[13.5rem]">
            <span className="block text-[13px] leading-[18px] font-medium break-words text-ink">{o.product_name ?? o.listing_title ?? o.listing_code}</span>
            <span className="block text-[11.5px] leading-4 text-ink-3">
              {o.retailer_name} · {o.market_name}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] leading-4">
              {o.observed_basis === 'exact' ? <MarketTime iso={o.observed_at} timeZone={o.timezone} short /> : <span className="num text-ink-2">{fmtDate(o.observed_local_date)}</span>}
              <DataClassBadge value={o.data_class} short />
            </span>
          </div>
        ),
      },
      {
        key: 'price',
        header: 'Selling price',
        align: 'right',
        sortKey: 'current_price',
        cell: (o) => (
          <span className="inline-flex flex-col items-end gap-1">
            <PriceCell price={o.current_price} regular={o.regular_price} currency={o.currency_code} isPromo={o.is_promo} />
            {o.is_promo ? <PromoBadge type={o.promo_type ?? 'other'} discount={o.discount_pct} description={o.promo_description} /> : null}
            {o.availability !== 'in_stock' && o.availability !== 'unknown' ? <AvailabilityBadge value={o.availability} /> : null}
          </span>
        ),
      },
    ],
    [],
  );
  const columns = useMemo<Array<Column<ObservationRecord>>>(
    () => [
      {
        key: 'observed',
        header: 'Observed',
        sortKey: 'observed_at',
        nowrap: true,
        cell: (o) =>
          o.observed_basis === 'exact' ? (
            <MarketTime iso={o.observed_at} timeZone={o.timezone} />
          ) : (
            <Tip content={o.observed_basis === 'date_only' ? 'Only the day is known for this observation (imported or entered without a time).' : 'The original observation date is unknown; the import time is used.'}>
              <span className="num text-ink-2">
                {fmtDate(o.observed_local_date)}
                <span className="ml-1 text-[11px] text-ink-4">{o.observed_basis === 'date_only' ? 'date only' : 'import time'}</span>
              </span>
            </Tip>
          ),
      },
      {
        key: 'product',
        header: 'Product',
        sortKey: 'product_name',
        nowrap: false,
        cell: (o) => (
          <div className="max-w-[14rem] min-w-40">
            <ProductCell name={o.product_name ?? o.listing_title} brand={o.brand_name} pack={packText(o)} variant={o.variant_name} ownership={o.ownership} isDemo={o.is_demo} compact />
          </div>
        ),
      },
      {
        key: 'retailer',
        header: 'Retailer',
        sortKey: 'retailer_name',
        cell: (o) => (
          <span className="block max-w-40 min-w-0">
            <span className="block truncate text-ink">{o.retailer_name}</span>
            <span className="block truncate text-[11.5px] leading-4 text-ink-3">{o.market_name}</span>
          </span>
        ),
      },
      {
        key: 'regular',
        header: 'Regular',
        align: 'right',
        sortKey: 'regular_price',
        headerTitle: 'Regular listed price. Sorting uses the stored number — add a market filter to rank within one currency.',
        cell: (o) => <PriceCell price={o.regular_price} currency={o.currency_code} showCurrency={false} />,
        hideBelow: 'md',
      },
      {
        key: 'current',
        header: 'Selling price',
        align: 'right',
        sortKey: 'current_price',
        headerTitle: 'Price a shopper paid. Sorting uses the stored number — add a market filter to rank within one currency.',
        cell: (o) => <PriceCell price={o.current_price} currency={o.currency_code} />,
      },
      {
        key: 'discount',
        header: 'Promotion',
        sortKey: 'discount_pct',
        headerTitle: 'Promotion type or discount, with the promotional price',
        cell: (o) =>
          o.is_promo ? (
            <span className="inline-flex flex-col items-start gap-0.5 whitespace-nowrap">
              <PromoBadge type={o.promo_type ?? 'other'} discount={o.discount_pct} description={o.promo_description} />
              {o.promo_price !== null ? (
                <Tip content="Promotional price recorded with this observation">
                  <span className="num text-[11.5px] leading-4 text-ink-3">promo {fmtPrice(o.promo_price, o.currency_code)}</span>
                </Tip>
              ) : null}
            </span>
          ) : (
            <span className="text-ink-4">—</span>
          ),
        hideBelow: 'sm',
      },
      { key: 'availability', header: 'Availability', cell: (o) => <AvailabilityBadge value={o.availability} />, hideBelow: 'lg' },
      { key: 'source', header: 'Source', cell: (o) => <DataClassBadge value={o.data_class} short />, hideBelow: 'md' },
      // shown only where there is room for it (≥ 1536 px); it is always in the observation drawer
      ...(roomy ? [{ key: 'confidence', header: 'Confidence', cell: (o: ObservationRecord) => <ConfidenceBadge value={o.confidence} /> }] : []),
    ],
    [roomy],
  );

  async function runExport(format: 'csv' | 'xlsx') {
    setExporting(format);
    try {
      await download('/observations/export', { ...filters.scopeQuery, sort: state.sort, format }, `price-observations.${format}`);
      toast.success('Export ready', `${plural(data?.total ?? 0, 'observation')} exported as ${format === 'csv' ? 'CSV' : 'Excel'}.`);
    } catch (err) {
      toast.fromError(err, 'Export failed');
    } finally {
      setExporting(null);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader
        title="Stored observations"
        subtitle={
          data
            ? `${fmtNumber(data.total)} record${data.total === 1 ? '' : 's'} match the filters. Each row is one stored observation — select it to see its source, evidence and confidence.`
            : 'The records behind the charts.'
        }
        actions={
          <>
            <Button icon={Download} size="sm" loading={exporting === 'csv'} disabled={!data || data.total === 0 || exporting !== null} onClick={() => void runExport('csv')}>
              Export CSV
            </Button>
            <Button icon={FileSpreadsheet} size="sm" loading={exporting === 'xlsx'} disabled={!data || data.total === 0 || exporting !== null} onClick={() => void runExport('xlsx')}>
              Export Excel
            </Button>
          </>
        }
      />
      {query.isError && !data ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <DataTable
            columns={narrow ? narrowColumns : columns}
            rows={data?.rows}
            rowKey={(o) => o.id}
            sort={state.sort}
            onSort={(sort) => set({ sort, page: undefined })}
            onRowClick={(o) => setOpenId(o.id)}
            selectedKey={openId}
            loading={query.isPending}
            refetching={isRefetching(query)}
            dense
            className="[&_td]:px-2.5 [&_th]:px-2.5"
            empty={<EmptyState title="No observations match" description="Widen the date range or remove a filter. Nothing is ever deleted from the ledger, so earlier periods remain available." />}
          />
          {data && data.total > 0 ? (
            <Pagination
              page={data.page}
              pages={data.pages}
              total={data.total}
              pageSize={data.page_size}
              noun="observations"
              onPage={(p) => set({ page: String(p) })}
              className="gap-y-2"
            />
          ) : null}
          {data && data.total > 25 ? (
            <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-[12.5px] text-ink-3">
              <label htmlFor="obs-page-size">Rows per page</label>
              <span className="inline-block w-20">
                <Select id="obs-page-size" value={String(pageSize)} onChange={(e) => set({ page_size: e.target.value, page: undefined })}>
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </Select>
              </span>
            </div>
          ) : null}
        </>
      )}
      <ObservationDrawer observationId={openId} onClose={() => setOpenId(null)} onChanged={() => void query.refetch()} />
    </Card>
  );
}
