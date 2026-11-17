/**
 * Stacked columns: how many runs finished each day, split by outcome. One y-axis, a surface gap between
 * segments, a rounded data-end on the top segment only, and a per-day tooltip. The exact values live in the
 * frame's table view.
 */
import { useState } from 'react';
import { AXIS, AXIS_TEXT, ChartTooltip, GRID, niceTicks, shortDate, useSize } from '@/components/charts/kit.tsx';

export interface StackSegment {
  key: string;
  label: string;
  color: string;
}

export interface StackDatum {
  date: string;
  values: Record<string, number>;
}

const GAP = 2;

export function StackedColumns({ data, segments, height = 190, unit }: { data: StackDatum[]; segments: StackSegment[]; height?: number; unit: string }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const margin = { top: 8, right: 8, bottom: 24, left: 34 };
  const width = size.width;
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = Math.max(0, height - margin.top - margin.bottom);
  const totals = data.map((d) => segments.reduce((acc, s) => acc + Math.max(0, d.values[s.key] ?? 0), 0));
  const maxTotal = Math.max(1, ...totals);
  const ticks = niceTicks(0, maxTotal, 4).filter((t) => Number.isInteger(t) && t >= 0);
  const hi = Math.max(ticks[ticks.length - 1] ?? maxTotal, maxTotal);
  const y = (v: number) => margin.top + plotH - (v / (hi || 1)) * plotH;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(24, band - 2));
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 64))));
  const active = hover !== null ? data[hover] : null;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={`${unit} per day by outcome. Use the table view for exact values.`} onPointerLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={margin.left} x2={margin.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? AXIS : GRID} strokeWidth={1} />
              <text x={margin.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS_TEXT} className="num">
                {t}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = margin.left + i * band + (band - barW) / 2;
            const present = segments.filter((s) => (d.values[s.key] ?? 0) > 0);
            let cumulative = 0;
            return (
              <g key={d.date} opacity={hover === null || hover === i ? 1 : 0.45}>
                {present.map((s, k) => {
                  const value = d.values[s.key] ?? 0;
                  const bottom = y(cumulative);
                  cumulative += value;
                  const top = y(cumulative);
                  const isTop = k === present.length - 1;
                  // a surface gap separates a segment from the one below it; the lowest segment sits on the baseline
                  const yBottom = k === 0 ? bottom : bottom - GAP;
                  const h = Math.max(1, yBottom - top);
                  if (!isTop) return <rect key={s.key} x={x} y={yBottom - h} width={barW} height={h} fill={s.color} />;
                  const r = Math.min(4, barW / 2, h);
                  const yTop = yBottom - h;
                  return (
                    <path
                      key={s.key}
                      d={`M${x},${yBottom}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + barW - r}Q${x + barW},${yTop} ${x + barW},${yTop + r}V${yBottom}Z`}
                      fill={s.color}
                    />
                  );
                })}
                <rect x={margin.left + i * band} y={margin.top} width={band} height={plotH} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />
                {i % labelEvery === 0 ? (
                  <text x={x + barW / 2} y={height - 7} textAnchor="middle" fontSize={11} fill={AXIS_TEXT} className="num">
                    {shortDate(d.date)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : null}
      {active && hover !== null ? (
        <ChartTooltip x={margin.left + hover * band + band / 2} y={margin.top} containerWidth={width}>
          <div className="mb-1 font-medium text-ink-3">{shortDate(active.date)}</div>
          {segments.map((s) => (
            <div key={s.key} className="flex items-baseline gap-2">
              <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
              <span className="num font-semibold text-ink">{active.values[s.key] ?? 0}</span>
              <span className="text-ink-3">{s.label.toLowerCase()}</span>
            </div>
          ))}
          <div className="mt-1 border-t border-line pt-1 text-ink-3">
            <span className="num font-semibold text-ink">{totals[hover]}</span> {unit.toLowerCase()} in total
          </div>
        </ChartTooltip>
      ) : null}
    </div>
  );
}
