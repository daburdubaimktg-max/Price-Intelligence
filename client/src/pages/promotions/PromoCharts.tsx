/** Promotional intensity over time and the promotion timeline (Gantt). */
import { memo, useEffect, useMemo, useState } from 'react';
import { TimeSeriesChart, useSeriesChart, type Series } from '@/components/charts/charts.tsx';
import { ChartEmpty, ChartFrame, COMPETITOR_COLOR, Legend, OWN_COLOR, type TableView } from '@/components/charts/kit.tsx';
import { Button, ErrorState, LoadingBlock, Segmented } from '@/components/ui/primitives.tsx';
import { fmtDate, fmtPct } from '@/lib/format.ts';
import type { Query } from '@/lib/api.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import type { DateRange, DemoNote, PromoCalendarDay, PromoTimelineRow } from '@shared/api/analytics.ts';
import { isRefetching } from './filters.ts';
import { layoutTimeline, promoTypeColor, promoTypeLabel } from './promo-meta.ts';
import { PromoTimeline } from './PromoTimeline.tsx';

// ---------------------------------------------------------------------------------------------
// Promotional intensity: share of observed listings on promotion, own vs competitors
// ---------------------------------------------------------------------------------------------
interface CalendarResponse {
  period: DateRange;
  days: PromoCalendarDay[];
}

/** `query` is the page's memoised scope + period, so the chart re-renders only when that changes. */
export const IntensityChart = memo(function IntensityChart({ query }: { query: Query | null }) {
  const q = useApiQuery<CalendarResponse>(['promotions', 'calendar'], '/promotions/calendar', query ?? undefined, { enabled: !!query });
  const days = q.data?.days ?? [];

  const series = useMemo<Series[]>(() => {
    const own: Series = { key: 'own', label: 'Own brands', color: OWN_COLOR, points: days.map((d) => ({ date: d.date, value: d.own_share_pct })) };
    const competitor: Series = { key: 'competitor', label: 'Competitors', color: COMPETITOR_COLOR, points: days.map((d) => ({ date: d.date, value: d.competitor_share_pct })) };
    return [own, competitor].filter((s) => s.points.some((p) => p.value !== null));
  }, [days]);
  const chart = useSeriesChart(series, 'promotions-intensity');

  const table = useMemo<TableView>(
    () => ({
      columns: ['Date', 'Own on promotion', 'Own observed', 'Own share', 'Competitors on promotion', 'Competitors observed', 'Competitor share', 'Average discount'],
      numeric: [1, 2, 3, 4, 5, 6, 7],
      rows: [...days].reverse().map((d) => [
        d.date, d.own_on_promo, d.own_observed, d.own_share_pct === null ? null : fmtPct(d.own_share_pct, 1), d.competitor_on_promo, d.competitor_observed,
        d.competitor_share_pct === null ? null : fmtPct(d.competitor_share_pct, 1), d.avg_discount_pct === null ? null : fmtPct(d.avg_discount_pct, 1),
      ]),
    }),
    [days],
  );

  return (
    <ChartFrame
      title="Promotional intensity"
      subtitle="Share of observed listings on promotion each day — own brands vs competitors"
      legend={chart.legend}
      table={days.length ? table : null}
      refetching={isRefetching(q)}
      empty={
        q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.isPending ? (
          <LoadingBlock className="min-h-64" />
        ) : series.length === 0 ? (
          <ChartEmpty title="No observations in this selection" />
        ) : undefined
      }
      footer="Based on the last priced observation of each listing per market-local day. Days without observations show no value."
    >
      <TimeSeriesChart
        series={series}
        colorScope="promotions-intensity"
        hiddenKeys={chart.hidden}
        height={260}
        includeZero
        formatValue={(v) => fmtPct(v, 1)}
        formatAxis={(v) => `${Math.round(v)}%`}
        domain={q.data?.period}
        valueLabel="Share of observed listings on promotion"
      />
    </ChartFrame>
  );
});

// ---------------------------------------------------------------------------------------------
// Promotion timeline
// ---------------------------------------------------------------------------------------------
interface TimelineResponse {
  period: DateRange;
  group_by: string;
  rows: PromoTimelineRow[];
  truncated: boolean;
  total_rows: number;
  demo: DemoNote;
}

const GROUPS = [
  { value: 'brand', label: 'Brand' },
  { value: 'product', label: 'Product' },
  { value: 'retailer', label: 'Retailer' },
] as const;
type Group = (typeof GROUPS)[number]['value'];

/** Rows drawn before the reader asks for all of them (keeps the chart on one screen). */
const ROW_LIMIT = 15;

export const TimelineChart = memo(function TimelineChart({ query, group: groupParam, onGroup }: { query: Query | null; group: string | undefined; onGroup: (group: string) => void }) {
  const group: Group = GROUPS.some((g) => g.value === groupParam) ? (groupParam as Group) : 'brand';
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [group]);
  const q = useApiQuery<TimelineResponse>(
    ['promotions', 'timeline'],
    '/promotions/timeline',
    query ? { ...query, group_by: group } : undefined,
    { enabled: !!query },
  );
  const data = q.data;
  const layout = useMemo(() => layoutTimeline(data?.rows ?? []), [data]);
  const groupLabel = GROUPS.find((g) => g.value === (data?.group_by ?? group))?.label ?? 'Group';
  const drawn = showAll ? layout.rows : layout.rows.slice(0, ROW_LIMIT);
  const hiddenRows = layout.rows.length - drawn.length;

  const table = useMemo<TableView | null>(() => {
    if (!data || data.rows.length === 0) return null;
    const rows: TableView['rows'] = [];
    for (const row of data.rows) {
      for (const e of row.episodes) {
        rows.push([
          row.label, e.product_name ?? 'Unmatched listing', `${e.retailer_name} (${e.market_code})`, promoTypeLabel(e.promo_type),
          e.max_discount_pct === null ? null : fmtPct(e.max_discount_pct, 1), e.start, e.end,
          e.is_current ? 'Running' : e.status === 'active' ? 'Unconfirmed' : 'Ended', e.is_demo ? 'DEMO' : '',
        ]);
      }
    }
    return { columns: [groupLabel, 'Product', 'Retailer', 'Type', 'Highest discount', 'First day in period', 'Last day in period', 'Status', 'Data'], numeric: [4], rows };
  }, [data, groupLabel]);

  const notes: string[] = [];
  if (data?.truncated) notes.push(`The ${data.rows.length} most active of ${data.total_rows} ${groupLabel.toLowerCase()}s are included — refine the filters to see the others.`);
  if (layout.types.length === 1) notes.push(`Every promotion in this selection is of the type "${promoTypeLabel(layout.types[0])}".`);
  if (layout.merged) {
    notes.push(
      'Dense selection: promotions of the same type that overlap are merged into one bar per row and type (hover for the count). Filter to a market, retailer or product to see every promotion as its own bar; the table view always lists them all.',
    );
  }

  return (
    <ChartFrame
      title="Promotional timeline"
      subtitle={data ? `Observed promotions ${fmtDate(data.period.from)} – ${fmtDate(data.period.to)}, by ${groupLabel.toLowerCase()}` : 'Observed promotions over time'}
      actions={<Segmented label="Group timeline by" size="sm" value={group} onChange={onGroup} options={GROUPS.map((g) => ({ value: g.value, label: g.label }))} />}
      legend={layout.types.length ? <Legend items={layout.types.map((t) => ({ key: t, label: promoTypeLabel(t), color: promoTypeColor(t), shape: 'rect' as const }))} /> : undefined}
      table={table}
      refetching={isRefetching(q)}
      empty={
        q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.isPending ? (
          <LoadingBlock className="min-h-64" />
        ) : !data || data.rows.length === 0 ? (
          <ChartEmpty title="No promotions in this selection" />
        ) : undefined
      }
      footer={notes.length ? notes.map((n) => <p key={n}>{n}</p>) : undefined}
    >
      {data ? (
        <>
          <PromoTimeline rows={drawn} from={data.period.from} to={data.period.to} />
          {hiddenRows > 0 || showAll ? (
            <div className="no-print mt-2 flex items-center justify-between gap-3 text-[12.5px] text-ink-3">
              <span>
                {showAll ? `All ${layout.rows.length} rows shown.` : `Showing the ${drawn.length} most active of ${layout.rows.length} rows.`}
              </span>
              {layout.rows.length > ROW_LIMIT ? (
                <Button size="sm" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? `Show top ${ROW_LIMIT}` : `Show all ${layout.rows.length}`}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </ChartFrame>
  );
});
