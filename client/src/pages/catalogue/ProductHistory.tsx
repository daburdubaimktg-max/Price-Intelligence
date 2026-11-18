/**
 * Product detail → price history (one chart per currency — currencies are never mixed on one axis)
 * and the most recent observations from the ledger.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, History } from 'lucide-react';
import { fmtNumber, fmtPrice, fmtUnitPrice } from '@/lib/format.ts';
import { useApiQuery, useDates } from '@/lib/hooks.ts';
import type { Paged } from '@/lib/api.ts';
import { ChartEmpty, ChartFrame, MAX_SERIES } from '@/components/charts/kit.tsx';
import { seriesTable, TimeSeriesChart, useSeriesChart, type Series } from '@/components/charts/charts.tsx';
import { DataTable } from '@/components/ui/data-table.tsx';
import { Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice, Segmented } from '@/components/ui/primitives.tsx';
import { AvailabilityBadge, ConfidenceBadge, DataClassBadge, DemoBadge, DemoNotice, MarketTime, PriceCell, PromoBadge } from '@/components/domain/domain.tsx';
import { ObservationDrawer } from '@/components/domain/observations.tsx';
import { DealTagChips } from '@/components/domain/signals.tsx';
import type { TimelineResult, TimelineSeries } from '@shared/api/analytics.ts';
import type { ObservationRecord } from '@shared/api/observations.ts';
import { CATALOGUE, fitColumns, useElementWidth, type FitColumn } from './shared.tsx';

type Period = '30' | '90' | 'all';
type Metric = 'price' | 'unit_price';
const MAX_CHARTS = 4;

interface CurrencyGroup {
  key: string;
  currency: string;
  basis: string | null;
  series: TimelineSeries[];
}

function CurrencyChart({ group, metric, productId, refetching, range }: { group: CurrencyGroup; metric: Metric; productId: number; refetching: boolean; range: { from?: string; to?: string } }) {
  const series = useMemo<Series[]>(
    () =>
      group.series.map((s) => ({
        key: s.key,
        // every series is this product, so the listing (retailer · market · pack) is the useful name
        label: s.sublabel ?? s.label,
        points: s.points.map((p) => ({ date: p.date, value: p.value, promo: p.promo > 0 })),
      })),
    [group.series],
  );
  const format = (v: number) => (metric === 'unit_price' ? fmtUnitPrice(v, group.currency) : fmtPrice(v, group.currency));
  const chart = useSeriesChart(series, `product-${productId}-${group.key}`);
  const demo = group.series.some((s) => s.is_demo);
  return (
    <ChartFrame
      title={
        <span className="flex flex-wrap items-center gap-2">
          {metric === 'unit_price' ? `Unit price in ${group.currency}` : `Selling price in ${group.currency}`}
          {demo ? <DemoBadge /> : null}
        </span>
      }
      subtitle={[`${fmtNumber(group.series.length)} listing${group.series.length === 1 ? '' : 's'}`, group.basis, 'daily closing price; a price is held until the next observation'].filter(Boolean).join(' · ')}
      legend={chart.legend}
      table={seriesTable(series.slice(0, MAX_SERIES), format)}
      refetching={refetching}
      className="border-0 shadow-none"
      footer={
        chart.overflow > 0 ? (
          <>
            Showing {MAX_SERIES} of {fmtNumber(series.length)} listings in {group.currency}.{' '}
            <Link className="link" to={`/history?product_id=${productId}`}>
              Open the Historical Price Explorer
            </Link>{' '}
            to choose retailers.
          </>
        ) : undefined
      }
    >
      <TimeSeriesChart
        series={series}
        colorScope={`product-${productId}-${group.key}`}
        formatValue={format}
        curve="step"
        hiddenKeys={chart.hidden}
        domain={range}
        valueLabel={metric === 'unit_price' ? 'Unit price' : 'Selling price'}
        height={240}
      />
    </ChartFrame>
  );
}

export function ProductPriceHistory({ productId }: { productId: number }) {
  const [period, setPeriod] = useState<Period>('90');
  const [metric, setMetric] = useState<Metric>('price');
  const dates = useDates();
  const today = dates.data?.today;
  const query =
    period === 'all'
      ? { from: dates.data?.first_observation_date ?? undefined, to: today, days: dates.data?.first_observation_date ? undefined : 365 }
      : { days: Number(period) };
  const timeline = useApiQuery<TimelineResult>(
    [CATALOGUE, 'product-history', productId],
    '/history/timeline',
    { product_id: productId, group_by: 'listing', metric, max_series: 100, ...query },
    { enabled: period !== 'all' || dates.isSuccess },
  );
  const data = timeline.data;

  // One chart per currency (and unit basis): prices in different currencies are never drawn on one axis.
  const groups = useMemo<CurrencyGroup[]>(() => {
    const map = new Map<string, CurrencyGroup>();
    for (const s of data?.series ?? []) {
      const key = `${s.currency ?? ''}|${s.basis ?? ''}`;
      const g = map.get(key);
      if (g) g.series.push(s);
      else map.set(key, { key, currency: s.currency ?? '', basis: s.basis, series: [s] });
    }
    return [...map.values()].sort((a, b) => b.series.length - a.series.length || a.currency.localeCompare(b.currency));
  }, [data]);
  const shown = groups.slice(0, MAX_CHARTS);
  const range = { from: data?.from ?? undefined, to: data?.to ?? undefined };

  return (
    <Card>
      <CardHeader
        title="Price history"
        subtitle="From the observation ledger. Every observation is kept; nothing is overwritten."
        actions={
          <>
            <Segmented<Metric>
              size="sm"
              label="Metric"
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'price', label: 'Selling price' },
                { value: 'unit_price', label: 'Unit price' },
              ]}
            />
            <Segmented<Period>
              size="sm"
              label="Period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: '30', label: '30 days' },
                { value: '90', label: '90 days' },
                { value: 'all', label: 'All' },
              ]}
            />
          </>
        }
      />
      {timeline.isError && !data ? (
        <ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} />
      ) : !data ? (
        <LoadingBlock className="min-h-64" />
      ) : groups.length === 0 ? (
        <ChartEmpty title="No price observations in this period" description="Widen the period, or add an observation to one of the listings." />
      ) : (
        <div className="flex flex-col">
          <DemoNotice demo={data.demo} className="mx-4 mt-3" />
          {data.truncated ? (
            <Notice tone="info" className="mx-4 mt-3">
              This product has {fmtNumber(data.total_series)} listings with prices; the {fmtNumber(data.series.length)} with the most observations are shown.
            </Notice>
          ) : null}
          <div className="divide-y divide-line">
            {shown.map((g) => (
              <CurrencyChart key={g.key} group={g} metric={metric} productId={productId} refetching={timeline.isPlaceholderData} range={range} />
            ))}
          </div>
          {groups.length > MAX_CHARTS ? (
            <p className="border-t border-line px-4 py-2.5 text-[12px] leading-5 text-ink-3">
              Prices exist in {fmtNumber(groups.length)} currencies; the {MAX_CHARTS} with the most listings are charted ({shown.map((g) => g.currency).join(', ')}). Not charted:{' '}
              {groups.slice(MAX_CHARTS).map((g) => g.currency).join(', ')}. Use{' '}
              <Link className="link" to={`/history?product_id=${productId}`}>
                the Historical Price Explorer
              </Link>{' '}
              to see them or to convert everything to one currency.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

export function ProductObservations({ productId }: { productId: number }) {
  const [open, setOpen] = useState<number | null>(null);
  const observations = useApiQuery<Paged<ObservationRecord>>([CATALOGUE, 'product-observations', productId], '/observations', { product_id: productId, page_size: 15 });
  const data = observations.data;
  // columns follow the width of the card: when it is narrow the time moves under the retailer so the price stays on screen
  const [cardRef, cardWidth] = useElementWidth();
  const compact = cardWidth < 530;
  const columns: Array<FitColumn<ObservationRecord>> = [
    {
      key: 'observed',
      header: 'Observed',
      minWidth: 530,
      nowrap: true,
      cell: (o) => (
        <span className="inline-flex flex-col items-start gap-1">
          <MarketTime iso={o.observed_at} timeZone={o.timezone} short />
          <DataClassBadge value={o.data_class} short />
        </span>
      ),
    },
    {
      key: 'retailer',
      header: 'Retailer',
      cell: (o) => (
        <span className="block" style={{ maxWidth: compact ? '12rem' : '16rem' }}>
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium text-ink">{o.retailer_name}</span>
            {o.is_demo ? <DemoBadge /> : null}
          </span>
          <span className="block truncate text-[11.5px] leading-4 text-ink-3">{[o.market_name, o.variant_name, o.seller_name ? `sold by ${o.seller_name}` : null].filter(Boolean).join(' · ')}</span>
          {compact ? (
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <MarketTime iso={o.observed_at} timeZone={o.timezone} short />
              <DataClassBadge value={o.data_class} short />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'price',
      header: 'Selling price',
      align: 'right',
      cell: (o) => (
        <span className="inline-flex flex-col items-end gap-0.5">
          <PriceCell price={o.current_price} regular={o.regular_price} currency={o.currency_code} isPromo={o.is_promo} />
          {o.is_promo ? <PromoBadge type={o.promo_type ?? 'other'} discount={o.discount_pct} description={o.promo_description} /> : null}
          {/* without a column of its own, the tags sit under the price */}
          {cardWidth < 900 && o.tags.length ? <DealTagChips tags={o.tags} tagText={o.tag_text} max={2} align="end" /> : null}
        </span>
      ),
    },
    {
      key: 'tags',
      header: 'Tags',
      minWidth: 900,
      headerTitle: 'Deal tags and badges the retailer showed with the price',
      cell: (o) => (
        <span className="block max-w-52">
          <DealTagChips tags={o.tags} tagText={o.tag_text} variant="full" max={2} empty={<span className="text-ink-4">—</span>} />
        </span>
      ),
    },
    { key: 'availability', header: 'Availability', minWidth: 640, nowrap: true, cell: (o) => <AvailabilityBadge value={o.availability} /> },
    { key: 'confidence', header: 'Confidence', minWidth: 740, nowrap: true, cell: (o) => <ConfidenceBadge value={o.confidence} /> },
  ];
  return (
    <div ref={cardRef} className="min-w-0">
    <Card>
      <CardHeader
        title="Recent observations"
        subtitle={data ? `Latest ${fmtNumber(Math.min(data.rows.length, data.total))} of ${fmtNumber(data.total)} observations recorded for this product.` : 'Latest observations recorded for this product.'}
        actions={
          <Link to={`/history?product_id=${productId}`} className="link inline-flex items-center gap-1 text-[12.5px]">
            Open in Historical Price Explorer <ArrowRight className="size-3" aria-hidden />
          </Link>
        }
      />
      {observations.isError && !data ? (
        <ErrorState error={observations.error} onRetry={() => void observations.refetch()} />
      ) : (
        <DataTable
          columns={fitColumns(columns, cardWidth)}
          rows={data?.rows}
          rowKey={(o) => o.id}
          onRowClick={(o) => setOpen(o.id)}
          loading={observations.isPending}
          refetching={observations.isPlaceholderData}
          dense
          empty={<EmptyState icon={History} title="No observations yet" description="Prices appear here as soon as they are collected, imported or entered for one of this product's listings." />}
        />
      )}
      <ObservationDrawer observationId={open} onClose={() => setOpen(null)} onChanged={() => void observations.refetch()} />
    </Card>
    </div>
  );
}
