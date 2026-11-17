/**
 * Price timeline. One chart per currency (and per unit basis): raw prices in different currencies are
 * never drawn on a common axis. Choosing a comparison currency converts everything and states the rate.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeftRight } from 'lucide-react';
import { useApiQuery } from '@/lib/hooks.ts';
import { fmtNumber, fmtPct } from '@/lib/format.ts';
import { Button, Card, CardHeader, ErrorState, LoadingBlock, Notice, Segmented } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { ChartEmpty, ChartFrame, COMPETITOR_COLOR, MAX_SERIES, OWN_COLOR } from '@/components/charts/kit.tsx';
import { seriesTable, TimeSeriesChart, useSeriesChart, type Series } from '@/components/charts/charts.tsx';
import { ChangeCell, DemoBadge, FxNote, OwnershipDot } from '@/components/domain/domain.tsx';
import { ListingDrawer } from '@/components/domain/observations.tsx';
import type { GroupBy, Metric, TimelineResult, TimelineSeries } from '@shared/api/analytics.ts';
import type { HistoryFilters } from './filters.ts';
import { GROUP_LABELS, InlineSelect, isRefetching, METRIC_LABELS, metricFormatter, SectionHeader } from './parts.tsx';

const MAX_GROUPS = 4;

interface ChartGroup {
  key: string;
  currency: string | null;
  basis: string | null;
  series: TimelineSeries[];
}

function groupTitle(group: ChartGroup, metric: Metric): string {
  if (metric === 'discount') return 'Average discount of listings on promotion';
  return [METRIC_LABELS[metric], group.currency, group.basis].filter(Boolean).join(' · ');
}

function GroupChart({
  group, metric, step, height, scope, range, identityColors, hideSublabels,
}: {
  group: ChartGroup;
  metric: Metric;
  step: boolean;
  height: number;
  scope: string;
  range: { from?: string; to?: string };
  /** Own vs competitor series wear the product-wide identity colours. */
  identityColors: boolean;
  /** Drop series sublabels that would mislead (a market's local currency next to converted values). */
  hideSublabels: boolean;
}) {
  const format = useMemo(() => metricFormatter(metric, group.currency), [metric, group.currency]);
  // When every series is the same product (one product at several retailers), the retailer is what tells
  // the lines apart: it becomes the series name and the product moves to the chart title.
  const sharedLabel = group.series.length > 1 && group.series.every((s) => s.label === group.series[0]!.label && s.sublabel) ? group.series[0]!.label : null;
  const drawn = useMemo<Series[]>(
    () =>
      group.series.slice(0, MAX_SERIES).map((s) => ({
        key: s.key,
        label: sharedLabel ? s.sublabel! : s.label,
        sublabel: sharedLabel || hideSublabels ? null : s.sublabel,
        color: identityColors ? (s.ownership === 'own' ? OWN_COLOR : s.ownership === 'competitor' ? COMPETITOR_COLOR : undefined) : undefined,
        points: s.points.map((p) => ({ date: p.date, value: p.value, promo: s.listing_count === 1 && p.promo >= 0.5 })),
      })),
    [group.series, identityColors, sharedLabel, hideSublabels],
  );
  const chart = useSeriesChart(drawn, scope);
  const hiddenCount = group.series.length - drawn.length;
  return (
    <ChartFrame
      title={groupTitle(group, metric)}
      subtitle={`${sharedLabel ? `${sharedLabel} · ` : ''}${fmtNumber(group.series.length)} series${hiddenCount > 0 ? ` · chart shows the ${MAX_SERIES} with most observations` : ''}`}
      legend={chart.legend}
      table={seriesTable(drawn, format)}
      footer={hiddenCount > 0 ? `Showing the ${MAX_SERIES} series with most observations of ${fmtNumber(group.series.length)} in this chart — refine the filters to see the others. All of them are in the statistics table below.` : undefined}
    >
      <TimeSeriesChart
        series={drawn}
        colorScope={scope}
        height={height}
        formatValue={format}
        curve={step ? 'step' : 'linear'}
        hiddenKeys={chart.hidden}
        domain={range}
        valueLabel={groupTitle(group, metric)}
      />
    </ChartFrame>
  );
}

export function TimelineCard({ filters }: { filters: HistoryFilters }) {
  const { state, set } = filters;
  const hasProduct = !!state.product_id;
  const groupBy = (state.tl_group ?? (hasProduct ? 'listing' : 'ownership')) as GroupBy;
  const metric = (state.tl_metric ?? 'price') as Metric;
  const bucket = state.tl_bucket === 'week' ? 'week' : 'day';
  const [listingId, setListingId] = useState<number | null>(null);

  const query = useApiQuery<TimelineResult>(
    ['history', 'timeline'],
    '/history/timeline',
    { ...filters.scopeQuery, group_by: groupBy, metric, currency: filters.currency, bucket, max_series: 40 },
    { enabled: filters.ready },
  );
  const data = query.data;

  const groups = useMemo<ChartGroup[]>(() => {
    const map = new Map<string, ChartGroup>();
    for (const s of data?.series ?? []) {
      const key = `${s.currency ?? ''}|${s.basis ?? ''}`;
      const g = map.get(key);
      if (g) g.series.push(s);
      else map.set(key, { key, currency: s.currency, basis: s.basis, series: [s] });
    }
    // own brands first when the series are "own vs competitors"
    if (data?.group_by === 'ownership') {
      const rank = (o: TimelineSeries['ownership']) => (o === 'own' ? 0 : o === 'competitor' ? 1 : 2);
      for (const g of map.values()) g.series.sort((a, b) => rank(a.ownership) - rank(b.ownership));
    }
    return [...map.values()].sort((a, b) => b.series.reduce((n, s) => n + s.points.length, 0) - a.series.reduce((n, s) => n + s.points.length, 0));
  }, [data]);

  const tooManyGroups = groups.length > MAX_GROUPS;
  // a market's sublabel is its local currency — misleading next to converted values
  const convertedMarkets = groupBy === 'market' && data?.currency_mode === 'converted';
  const step = groupBy === 'listing' && bucket === 'day' && (metric === 'price' || metric === 'regular_price');
  const scope = `history-timeline-${groupBy}`;
  const range = { from: data?.from ?? undefined, to: data?.to ?? undefined };

  const statColumns = useMemo<Array<Column<TimelineSeries>>>(() => {
    const value = (s: TimelineSeries, v: number | undefined | null) => (v === undefined || v === null ? '—' : metricFormatter(metric, s.currency)(v));
    return [
      {
        key: 'series',
        header: 'Series',
        nowrap: false,
        cell: (s) => (
          <span className="flex max-w-[11.5rem] min-w-0 items-center gap-2 sm:max-w-[22rem]">
            {s.ownership === 'own' || s.ownership === 'competitor' ? <OwnershipDot ownership={s.ownership} /> : null}
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                {groupBy === 'product' && s.ref.product_id ? (
                  <Link to={`/catalogue/products/${s.ref.product_id}`} className="truncate font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                    {s.label}
                  </Link>
                ) : (
                  <span className="truncate font-medium text-ink">{s.label}</span>
                )}
                {s.is_demo ? <DemoBadge /> : null}
              </span>
              {s.sublabel && !convertedMarkets ? <span className="block truncate text-[11.5px] leading-4 text-ink-3">{s.sublabel}</span> : null}
              {metric !== 'discount' ? <span className="block text-[11.5px] leading-4 text-ink-3 sm:hidden">{[s.currency, s.basis].filter(Boolean).join(' · ')}</span> : null}
            </span>
          </span>
        ),
      },
      { key: 'unit', header: metric === 'discount' ? 'Unit' : 'Currency', cell: (s) => <span className="text-ink-2">{metric === 'discount' ? '%' : [s.currency, s.basis].filter(Boolean).join(' · ')}</span>, hideBelow: 'sm' },
      { key: 'n', header: bucket === 'week' ? 'Weeks' : 'Days', align: 'right', cell: (s) => fmtNumber(s.stats?.n ?? 0), headerTitle: 'Number of periods with at least one observation', hideBelow: 'sm' },
      { key: 'listings', header: 'Listings', align: 'right', cell: (s) => fmtNumber(s.listing_count), hideBelow: 'md' },
      { key: 'avg', header: 'Average', align: 'right', cell: (s) => <span className="font-medium text-ink">{value(s, s.stats?.avg)}</span> },
      { key: 'median', header: 'Median', align: 'right', cell: (s) => value(s, s.stats?.median), hideBelow: 'md' },
      { key: 'min', header: 'Lowest', align: 'right', cell: (s) => value(s, s.stats?.min), hideBelow: 'sm' },
      { key: 'max', header: 'Highest', align: 'right', cell: (s) => value(s, s.stats?.max), hideBelow: 'sm' },
      { key: 'vol', header: 'Volatility', align: 'right', cell: (s) => fmtPct(s.stats?.volatility_pct, 1), headerTitle: 'Standard deviation ÷ mean of the series', hideBelow: 'lg' },
      { key: 'change', header: 'Change', align: 'right', cell: (s) => <ChangeCell pct={s.stats?.change_pct} />, headerTitle: 'First to last value in the period' },
    ];
  }, [metric, groupBy, bucket, convertedMarkets]);

  const controls = (
    <>
      <InlineSelect
        label="Group by"
        value={groupBy}
        onChange={(v) => set({ tl_group: v })}
        width="w-56"
        options={(Object.keys(GROUP_LABELS) as GroupBy[]).map((g) => ({ value: g, label: GROUP_LABELS[g] }))}
      />
      <InlineSelect
        label="Metric"
        value={metric}
        onChange={(v) => set({ tl_metric: v })}
        width="w-44"
        options={(Object.keys(METRIC_LABELS) as Metric[]).map((m) => ({ value: m, label: METRIC_LABELS[m] }))}
      />
      <Segmented
        label="Bucket"
        value={bucket}
        onChange={(v) => set({ tl_bucket: v })}
        options={[
          { value: 'day', label: 'Daily' },
          { value: 'week', label: 'Weekly', title: 'Average of the daily values of each week (Monday to Sunday)' },
        ]}
      />
    </>
  );

  return (
    <section className="mb-6" aria-label="Price timeline">
      <SectionHeader
        title="Price timeline"
        subtitle="The daily price of a listing is its last priced observation of that market-local day; group values are averages of their listings. Lines break where observations are missing."
        controls={controls}
      />

      {query.isError && !data ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : !data ? (
        <Card>
          <LoadingBlock className="min-h-72" />
        </Card>
      ) : data.series.length === 0 ? (
        <Card>
          <ChartEmpty description="No priced observations match the filters in this date range." />
        </Card>
      ) : (
        <div className={isRefetching(query) ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          {data.truncated ? (
            <Notice tone="info" className="mb-3">
              Showing the {fmtNumber(data.series.length)} series with most observations of {fmtNumber(data.total_series)} — refine the filters or group at a higher level to see every series.
            </Notice>
          ) : null}

          {tooManyGroups ? (
            <Notice
              tone="warn"
              icon={ArrowLeftRight}
              className="mb-3"
              title={`This selection spans ${groups.length} ${metric === 'unit_price' && new Set(groups.map((g) => g.currency)).size < groups.length ? 'currency and unit-basis combinations' : 'currencies'}`}
              action={
                metric !== 'discount' ? (
                  <Button size="sm" variant="primary" onClick={() => set({ currency: 'reporting' })}>
                    Convert to {filters.reportingCurrency}
                  </Button>
                ) : undefined
              }
            >
              Prices in different currencies are never drawn on one axis ({groups.map((g) => [g.currency, g.basis].filter(Boolean).join(' ')).join(', ')}). Choose a comparison currency or narrow the scope to
              one market to see the chart. The statistics below are complete.
            </Notice>
          ) : (
            <div className={groups.length > 1 ? 'grid gap-4 xl:grid-cols-2' : ''}>
              {groups.map((g) => (
                <GroupChart key={g.key} group={g} metric={metric} step={step} height={groups.length > 1 ? 240 : 300} scope={`${scope}-${g.key}`} range={range} identityColors={groupBy === 'ownership'} hideSublabels={convertedMarkets} />
              ))}
            </div>
          )}

          <FxNote conversions={data.conversions} missing={data.missing_rates} target={data.target_currency} className="mt-3" />

          <Card className="mt-4">
            <CardHeader
              title="Series statistics"
              subtitle={`${metric === 'discount' ? 'Average discount of listings on promotion' : METRIC_LABELS[metric]} per ${GROUP_LABELS[groupBy].toLowerCase()}${
                metric === 'discount' ? '' : data.currency_mode === 'converted' ? ` — converted to ${data.target_currency}` : ' — in each series’ own currency'
              }${groupBy === 'listing' ? '. Select a row to open the listing.' : ''}`}
            />
            <DataTable
              columns={statColumns}
              rows={data.series}
              rowKey={(s) => s.key}
              dense
              maxHeight={380}
              onRowClick={groupBy === 'listing' ? (s) => setListingId(s.ref.listing_id ?? null) : undefined}
            />
          </Card>
        </div>
      )}
      <ListingDrawer listingId={listingId} onClose={() => setListingId(null)} />
    </section>
  );
}
