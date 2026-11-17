/** Draws a report section's chart. One y-axis, at most eight series; every value is in the table view. */
import { useMemo } from 'react';
import { currencyDecimals, fmtNumber, fmtPct } from '@/lib/format.ts';
import { ChartEmpty, ChartFrame, COMPETITOR_COLOR, DIVERGING, Legend, MAX_SERIES, OWN_COLOR, type TableView } from '@/components/charts/kit.tsx';
import { BarList, DivergingColumns, seriesTable, TimeSeriesChart, useSeriesChart, type Series } from '@/components/charts/charts.tsx';
import type { DateRange } from '@shared/api/analytics.ts';
import type { ReportChart } from '@shared/api/reports.ts';

type LineChart = Extract<ReportChart, { kind: 'line' }>;
type DivergingChart = Extract<ReportChart, { kind: 'diverging' }>;
type BarsChart = Extract<ReportChart, { kind: 'bars' }>;

/** Formats a value in the chart's unit: 'index', '%' or a currency code. */
export function unitFormatter(unit: string): (value: number) => string {
  if (unit === 'index') return (v) => v.toFixed(1);
  if (unit === '%') return (v) => fmtPct(v, 1);
  if (!unit) return (v) => fmtNumber(v, 2);
  const decimals = currencyDecimals(unit);
  const plain = new Intl.NumberFormat('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  // unit prices below 1 need one more decimal than the currency normally shows
  const fine = new Intl.NumberFormat('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals === 0 ? 1 : decimals + 1 });
  return (v) => (Math.abs(v) < 1 ? fine : plain).format(v);
}

function unitCaption(chart: ReportChart): string {
  if (chart.kind === 'diverging') return 'Count per day';
  if (chart.unit === 'index') return chart.kind === 'line' && chart.reference ? `Index · ${chart.reference.label} = ${fmtNumber(chart.reference.value, 1)}` : 'Index';
  if (chart.unit === '%') return 'Percent';
  return chart.unit || 'Value';
}

function LineSection({ chart, scope, period, height }: { chart: LineChart; scope: string; period: DateRange; height: number }) {
  const format = useMemo(() => unitFormatter(chart.unit), [chart.unit]);
  // Own / competitor colours identify a series only when each role occurs once; several products of one
  // brand would otherwise all wear the same colour.
  const roles = chart.series.map((s) => s.role).filter(Boolean);
  const identity = roles.length === chart.series.length && new Set(roles).size === roles.length;
  const all = useMemo<Series[]>(
    () =>
      chart.series.map((s) => ({
        key: s.key,
        label: s.label,
        sublabel: s.sublabel,
        color: identity ? (s.role === 'own' ? OWN_COLOR : s.role === 'competitor' ? COMPETITOR_COLOR : undefined) : undefined,
        points: s.points,
      })),
    [chart.series, identity],
  );
  const drawn = useMemo(() => all.filter((s) => s.points.length > 0).slice(0, MAX_SERIES), [all]);
  const view = useSeriesChart(drawn, scope);
  const hiddenCount = all.filter((s) => s.points.length > 0).length - drawn.length;
  const empty = drawn.length === 0;
  return (
    <ChartFrame
      title={<span className="eyebrow">{unitCaption(chart)}</span>}
      legend={view.legend}
      table={empty ? null : seriesTable(all, format)}
      empty={empty ? <ChartEmpty description="No observations in this period for the chosen filters." /> : undefined}
      footer={hiddenCount > 0 ? `Showing ${drawn.length} of ${drawn.length + hiddenCount} series. The others are in the table view and in the Excel export.` : undefined}
    >
      <TimeSeriesChart
        series={drawn}
        colorScope={scope}
        height={height}
        formatValue={format}
        reference={chart.reference ? { value: chart.reference.value, label: `${chart.reference.label} (${fmtNumber(chart.reference.value, 1)})` } : undefined}
        hiddenKeys={view.hidden}
        domain={period}
        valueLabel={unitCaption(chart)}
      />
    </ChartFrame>
  );
}

function DivergingSection({ chart, height }: { chart: DivergingChart; height: number }) {
  const total = chart.data.reduce((acc, d) => acc + d.positive + d.negative, 0);
  const table: TableView = {
    columns: ['Date', chart.positive_label, chart.negative_label],
    numeric: [1, 2],
    rows: [...chart.data].reverse().map((d) => [d.date, d.positive, d.negative]),
  };
  return (
    <ChartFrame
      title={<span className="eyebrow">{unitCaption(chart)}</span>}
      legend={
        <Legend
          items={[
            { key: 'positive', label: chart.positive_label, color: DIVERGING.positive, shape: 'rect' },
            { key: 'negative', label: chart.negative_label, color: DIVERGING.negative, shape: 'rect' },
          ]}
        />
      }
      table={total > 0 ? table : null}
      empty={total === 0 ? <ChartEmpty title="Nothing to chart" description="No changes were recorded in this period for the chosen filters." /> : undefined}
    >
      <DivergingColumns data={chart.data} height={height} positiveLabel={chart.positive_label} negativeLabel={chart.negative_label} />
    </ChartFrame>
  );
}

function BarsSection({ chart }: { chart: BarsChart }) {
  const format = unitFormatter(chart.unit);
  const table: TableView = { columns: ['Item', unitCaption(chart)], numeric: [1], rows: chart.data.map((d) => [d.sublabel ? `${d.label} · ${d.sublabel}` : d.label, format(d.value)]) };
  return (
    <ChartFrame
      title={<span className="eyebrow">{unitCaption(chart)}</span>}
      table={chart.data.length ? table : null}
      empty={chart.data.length === 0 ? <ChartEmpty title="Nothing to chart" /> : undefined}
    >
      <BarList data={chart.data.map((d) => ({ key: d.key, label: d.label, sublabel: d.sublabel, value: d.value, display: format(d.value) }))} />
    </ChartFrame>
  );
}

export function ReportChartView({ chart, scope, period, height = 260 }: { chart: ReportChart; scope: string; period: DateRange; height?: number }) {
  if (chart.kind === 'line') return <LineSection chart={chart} scope={scope} period={period} height={height} />;
  if (chart.kind === 'diverging') return <DivergingSection chart={chart} height={Math.min(height, 220)} />;
  return <BarsSection chart={chart} />;
}
