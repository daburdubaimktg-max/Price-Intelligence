/**
 * New listings per day or week, stacked by brand. Own brands sit at the baseline, then competitors; every
 * other brand is one neutral segment and listings without a recognised brand another (outlined, so the two
 * neutrals are told apart by more than their shade).
 */
import { useMemo, useState } from 'react';
import type { NewListingsSeries } from '@shared/api/new-listings.ts';
import { AXIS, AXIS_TEXT, ChartEmpty, ChartFrame, ChartTooltip, DEEMPHASIS, GRID, Legend, niceTicks, shortDate, useSeriesColors, useSize, type LegendItem, type TableView } from '@/components/charts/kit.tsx';
import { fmtNumber } from '@/lib/format.ts';

const UNRECOGNISED_FILL = '#eceef3';
const GAP = 2;

interface Segment {
  key: string;
  label: string;
  color: string;
  outlined?: boolean;
  counts: number[];
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function bucketLabel(series: NewListingsSeries, start: string): string {
  return series.bucket === 'day' ? shortDate(start) : `Week of ${shortDate(start)}`;
}

function StackedColumns({ series, segments, height = 220 }: { series: NewListingsSeries; segments: Segment[]; height?: number }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const margin = { top: 8, right: 8, bottom: 24, left: 34 };
  const width = size.width;
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = Math.max(0, height - margin.top - margin.bottom);
  const totals = series.starts.map((_, i) => sum(segments.map((s) => s.counts[i] ?? 0)));
  const max = Math.max(1, ...totals);
  const ticks = niceTicks(0, max, 4).filter((t) => Number.isInteger(t) && t >= 0);
  const top = Math.max(max, ticks[ticks.length - 1] ?? max);
  const y = (v: number) => margin.top + plotH - (v / top) * plotH;
  const band = series.starts.length ? plotW / series.starts.length : 0;
  const barW = Math.max(3, Math.min(44, band - 8));
  const labelEvery = Math.max(1, Math.ceil(series.starts.length / Math.max(2, Math.floor(plotW / 72))));
  const active = hover !== null ? hover : null;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`New listings per ${series.bucket} by brand. Use the table view for exact values.`}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={margin.left} x2={margin.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? AXIS : GRID} strokeWidth={1} />
              <text x={margin.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS_TEXT} className="num">
                {t}
              </text>
            </g>
          ))}
          {series.starts.map((start, i) => {
            const x = margin.left + i * band + (band - barW) / 2;
            const present = segments.filter((s) => (s.counts[i] ?? 0) > 0);
            let below = 0;
            return (
              <g key={start} opacity={hover === null || hover === i ? 1 : 0.45}>
                {present.map((segment, index) => {
                  const value = segment.counts[i] ?? 0;
                  const y0 = y(below);
                  const y1 = y(below + value);
                  below += value;
                  const isTop = index === present.length - 1;
                  // a 2 px gap in the surface colour separates a segment from the one below it
                  const bottom = index === 0 ? y0 : y0 - GAP;
                  const h = Math.max(1, bottom - y1);
                  const r = isTop ? Math.min(4, barW / 2, h) : 0;
                  const d = `M${x},${y1 + h}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + barW - r}Q${x + barW},${y1} ${x + barW},${y1 + r}V${y1 + h}Z`;
                  return <path key={segment.key} d={d} fill={segment.color} stroke={segment.outlined ? AXIS : undefined} strokeWidth={segment.outlined ? 1 : undefined} strokeDasharray={segment.outlined ? '3 2' : undefined} />;
                })}
                <rect x={margin.left + i * band} y={margin.top} width={band} height={plotH} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
                {i % labelEvery === 0 ? (
                  <text x={x + barW / 2} y={height - 7} textAnchor="middle" fontSize={11} fill={AXIS_TEXT} className="num">
                    {shortDate(start)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : null}
      {active !== null ? (
        <ChartTooltip x={margin.left + active * band + band / 2} y={margin.top} containerWidth={width}>
          <div className="mb-1 font-medium text-ink-3">{bucketLabel(series, series.starts[active]!)}</div>
          {segments
            .filter((s) => (s.counts[active] ?? 0) > 0)
            .map((s) => (
              <div key={s.key} className="flex items-baseline gap-2">
                <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: s.color, outline: s.outlined ? `1px dashed ${AXIS}` : undefined }} />
                <span className="num font-semibold text-ink">{fmtNumber(s.counts[active])}</span>
                <span className="truncate text-ink-3">{s.label}</span>
              </div>
            ))}
          {totals[active] === 0 ? <div className="text-ink-3">No new listings</div> : null}
          {segments.filter((s) => (s.counts[active] ?? 0) > 0).length > 1 ? (
            <div className="mt-1 border-t border-line pt-1 text-ink-3">
              <span className="num font-semibold text-ink">{fmtNumber(totals[active])}</span> in total
            </div>
          ) : null}
        </ChartTooltip>
      ) : null}
    </div>
  );
}

export function NewListingsChart({ series, refetching, periodLabel }: { series: NewListingsSeries; refetching?: boolean; periodLabel: string }) {
  const keys = useMemo(() => series.brands.map((b) => b.key), [series.brands]);
  const colors = useSeriesColors('new-products', keys);
  const segments = useMemo<Segment[]>(() => {
    const list: Segment[] = series.brands.map((b) => ({ key: b.key, label: `${b.brand_name}${b.ownership === 'own' ? ' (own)' : ''}`, color: colors.get(b.key) ?? DEEMPHASIS, counts: b.counts }));
    if (sum(series.other) > 0) list.push({ key: 'other', label: 'Other brands', color: DEEMPHASIS, counts: series.other });
    if (sum(series.unrecognised) > 0) list.push({ key: 'unrecognised', label: 'Brand not recognised', color: UNRECOGNISED_FILL, outlined: true, counts: series.unrecognised });
    return list;
  }, [series, colors]);
  const total = sum(segments.map((s) => sum(s.counts)));
  const legend: LegendItem[] = segments.map((s) => ({ key: s.key, label: s.label, sublabel: fmtNumber(sum(s.counts)), color: s.color, shape: 'rect' }));
  const table: TableView = {
    columns: [series.bucket === 'day' ? 'Day' : 'Week starting', ...segments.map((s) => s.label), 'Total'],
    rows: series.starts.map((start, i) => [start, ...segments.map((s) => s.counts[i] ?? 0), sum(segments.map((s) => s.counts[i] ?? 0))]),
    numeric: segments.map((_, i) => i + 1).concat(segments.length + 1),
  };
  return (
    <ChartFrame
      title={`New listings per ${series.bucket} by brand`}
      subtitle={`${periodLabel} · counted on the day a listing was first seen, in the market's own time · own brands at the baseline`}
      legend={<Legend items={legend} />}
      table={total > 0 ? table : null}
      refetching={refetching}
      empty={total === 0 ? <ChartEmpty title="No new listings in this period" description="Nothing was first seen after its retailer's baseline within these filters." /> : undefined}
    >
      <StackedColumns series={series} segments={segments} />
    </ChartFrame>
  );
}
