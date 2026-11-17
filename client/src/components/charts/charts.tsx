/**
 * Chart components (plain SVG/HTML — no charting library):
 *   TimeSeriesChart     price / index history, multi-series, crosshair + tooltip, honest gaps
 *   DivergingColumns    counts above / below a baseline per day (price increases vs decreases)
 *   BarList             ranked horizontal bars, one hue
 *   Sparkline           tiny trend for stat tiles and table rows
 *   PromoGantt          promotion episodes per row over time
 *   IndexScale          a position on a scale centred on parity (100)
 *   SegmentedBar        thin part-to-whole bar beside its figures
 */
import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '../ui/primitives.tsx';
import {
  AXIS, AXIS_TEXT, ChartTooltip, dateTicks, dayNumber, dayToIso, DEEMPHASIS, DIVERGING, GRID, Legend, MAX_SERIES, niceTicks, shortDate,
  useSeriesColors, useSize, type LegendItem, type TableView,
} from './kit.tsx';

// ---------------------------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------------------------
export interface SeriesPoint {
  date: string;
  value: number | null;
  /** Optional marker: the point was a promotional price. */
  promo?: boolean | number;
}

export interface Series {
  key: string;
  label: string;
  sublabel?: string | null;
  points: SeriesPoint[];
  /** Fixed colour (otherwise assigned by stable slot). */
  color?: string;
}

export interface TimeSeriesChartProps {
  series: Series[];
  /** Keeps colours stable across filter changes on the same screen. */
  colorScope: string;
  height?: number;
  formatValue: (value: number) => string;
  /** Short axis formatter (defaults to formatValue). */
  formatAxis?: (value: number) => string;
  /** 'step' holds a price until the next observation (truthful for single listings). */
  curve?: 'linear' | 'step';
  includeZero?: boolean;
  /** Draw a horizontal reference line (e.g. index = 100). */
  reference?: { value: number; label: string };
  /** Explicit x-domain (ISO dates); defaults to the data extent. */
  domain?: { from?: string; to?: string };
  /** Break lines where consecutive observations are further apart than this many days. */
  maxGapDays?: number;
  hiddenKeys?: Set<string>;
  valueLabel?: string;
}

interface Prepared {
  key: string;
  label: string;
  sublabel?: string | null;
  color: string;
  pts: Array<{ day: number; value: number; promo: boolean }>;
}

export function TimeSeriesChart({
  series, colorScope, height = 260, formatValue, formatAxis, curve = 'linear', includeZero, reference, domain, maxGapDays, hiddenKeys, valueLabel,
}: TimeSeriesChartProps) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const colors = useSeriesColors(colorScope, series.map((s) => s.key));

  const prepared = useMemo<Prepared[]>(
    () =>
      series.slice(0, MAX_SERIES).map((s) => ({
        key: s.key,
        label: s.label,
        sublabel: s.sublabel,
        color: s.color ?? colors.get(s.key) ?? DEEMPHASIS,
        pts: s.points
          .filter((p): p is SeriesPoint & { value: number } => p.value !== null && Number.isFinite(p.value))
          .map((p) => ({ day: dayNumber(p.date), value: p.value, promo: !!p.promo }))
          .sort((a, b) => a.day - b.day),
      })),
    [series, colors],
  );
  const visible = prepared.filter((s) => !hiddenKeys?.has(s.key) && s.pts.length > 0);

  const margin = { top: 10, right: 16, bottom: 26, left: 52 };
  const width = Math.max(0, size.width);
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = Math.max(0, height - margin.top - margin.bottom);

  const scales = useMemo(() => {
    const all = visible.flatMap((s) => s.pts);
    if (!all.length) return null;
    let minDay = Math.min(...all.map((p) => p.day));
    let maxDay = Math.max(...all.map((p) => p.day));
    if (domain?.from) minDay = Math.min(minDay, dayNumber(domain.from));
    if (domain?.to) maxDay = Math.max(maxDay, dayNumber(domain.to));
    if (minDay === maxDay) {
      minDay -= 1;
      maxDay += 1;
    }
    let lo = Math.min(...all.map((p) => p.value));
    let hi = Math.max(...all.map((p) => p.value));
    if (reference) {
      lo = Math.min(lo, reference.value);
      hi = Math.max(hi, reference.value);
    }
    if (includeZero) lo = Math.min(0, lo);
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
    const ticks = niceTicks(includeZero && lo === 0 ? 0 : lo - pad, hi + pad, Math.max(2, Math.floor(plotH / 44)));
    const yMin = ticks[0]!;
    const yMax = ticks[ticks.length - 1]!;
    const x = (day: number) => margin.left + ((day - minDay) / (maxDay - minDay)) * plotW;
    const y = (value: number) => margin.top + plotH - ((value - yMin) / (yMax - yMin || 1)) * plotH;
    return { minDay, maxDay, ticks, x, y };
  }, [visible, domain?.from, domain?.to, includeZero, reference, plotW, plotH, margin.left, margin.top]);

  // A gap longer than the threshold is drawn as a gap: the chart never implies observations that do not exist.
  const paths = useMemo(() => {
    if (!scales) return [];
    return visible.map((s) => {
      const gaps = s.pts.slice(1).map((p, i) => p.day - s.pts[i]!.day).sort((a, b) => a - b);
      const median = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 1;
      const limit = maxGapDays ?? Math.max(4, median * 3.5);
      let d = '';
      s.pts.forEach((p, i) => {
        const px = scales.x(p.day);
        const py = scales.y(p.value);
        const prev = s.pts[i - 1];
        if (!prev || p.day - prev.day > limit) {
          d += `M${px.toFixed(1)},${py.toFixed(1)}`;
        } else if (curve === 'step') {
          d += `H${px.toFixed(1)}V${py.toFixed(1)}`;
        } else {
          d += `L${px.toFixed(1)},${py.toFixed(1)}`;
        }
      });
      return { key: s.key, color: s.color, d, last: s.pts[s.pts.length - 1]!, single: s.pts.length === 1 };
    });
  }, [visible, scales, curve, maxGapDays]);

  const allDays = useMemo(() => [...new Set(visible.flatMap((s) => s.pts.map((p) => p.day)))].sort((a, b) => a - b), [visible]);

  const onMove = (clientX: number) => {
    if (!scales || !ref.current || !allDays.length) return;
    const rect = ref.current.getBoundingClientRect();
    const px = clientX - rect.left;
    const day = scales.minDay + ((px - margin.left) / (plotW || 1)) * (scales.maxDay - scales.minDay);
    let best = allDays[0]!;
    for (const d of allDays) if (Math.abs(d - day) < Math.abs(best - day)) best = d;
    setHoverDay(best);
  };

  const hover = useMemo(() => {
    if (hoverDay === null || !scales) return null;
    const rows = visible
      .map((s) => {
        // value at the hovered day, or the latest earlier value for step series
        let point = s.pts.find((p) => p.day === hoverDay);
        if (!point && curve === 'step') {
          const earlier = s.pts.filter((p) => p.day < hoverDay);
          point = earlier[earlier.length - 1];
        }
        return point ? { key: s.key, label: s.label, sublabel: s.sublabel, color: s.color, value: point.value, promo: point.promo, exact: point.day === hoverDay } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.value - a.value);
    return { day: hoverDay, x: scales.x(hoverDay), rows };
  }, [hoverDay, scales, visible, curve]);

  const xTicks = scales ? dateTicks(scales.minDay, scales.maxDay, plotW) : [];
  const axisFormat = formatAxis ?? formatValue;
  // direct end labels only when few series and they do not collide
  const endLabels = useMemo(() => {
    if (!scales || paths.length === 0 || paths.length > 4) return [];
    const labels = paths.map((p) => ({ key: p.key, y: scales.y(p.last.value), text: formatValue(p.last.value), x: scales.x(p.last.day) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i]!.y - labels[i - 1]!.y < 13) return [];
    return labels;
  }, [paths, scales, formatValue]);

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {width > 0 && scales ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${valueLabel ?? 'Value'} over time for ${visible.length} series. Use the table view for exact values.`}
          onPointerMove={(e) => onMove(e.clientX)}
          onPointerLeave={() => setHoverDay(null)}
          onPointerDown={(e) => onMove(e.clientX)}
          style={{ touchAction: 'pan-y' }}
        >
          {scales.ticks.map((t) => (
            <g key={t}>
              <line x1={margin.left} x2={margin.left + plotW} y1={scales.y(t)} y2={scales.y(t)} stroke={GRID} strokeWidth={1} />
              <text x={margin.left - 8} y={scales.y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS_TEXT} className="num">
                {axisFormat(t)}
              </text>
            </g>
          ))}
          <line x1={margin.left} x2={margin.left + plotW} y1={margin.top + plotH} y2={margin.top + plotH} stroke={AXIS} strokeWidth={1} />
          {xTicks.map((d) => (
            <text key={d} x={scales.x(d)} y={height - 8} textAnchor="middle" fontSize={11} fill={AXIS_TEXT} className="num">
              {shortDate(dayToIso(d))}
            </text>
          ))}
          {reference ? (
            <g>
              <line x1={margin.left} x2={margin.left + plotW} y1={scales.y(reference.value)} y2={scales.y(reference.value)} stroke={AXIS_TEXT} strokeWidth={1} />
              <text x={margin.left + 4} y={scales.y(reference.value) - 5} fontSize={10.5} fill={AXIS_TEXT}>
                {reference.label}
              </text>
            </g>
          ) : null}
          {hover ? <line x1={hover.x} x2={hover.x} y1={margin.top} y2={margin.top + plotH} stroke={AXIS_TEXT} strokeWidth={1} /> : null}
          {paths.map((p) => (
            <path key={p.key} d={p.d} fill="none" stroke={p.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {paths.map((p) => (
            <circle key={`end-${p.key}`} cx={scales.x(p.last.day)} cy={scales.y(p.last.value)} r={4} fill={p.color} stroke="#fff" strokeWidth={2} />
          ))}
          {endLabels.map((l) => (
            <text key={`lbl-${l.key}`} x={Math.min(l.x + 8, width - 2)} y={l.y} dy="0.32em" fontSize={11} fontWeight={600} fill="#0e1b36" textAnchor={l.x + 60 > width ? 'end' : 'start'} dx={l.x + 60 > width ? -14 : 0} className="num">
              {l.text}
            </text>
          ))}
          {hover
            ? hover.rows.filter((r) => r.exact).map((r) => <circle key={`hov-${r.key}`} cx={hover.x} cy={scales.y(r.value)} r={4} fill={r.color} stroke="#fff" strokeWidth={2} />)
            : null}
        </svg>
      ) : null}
      {hover && hover.rows.length ? (
        <ChartTooltip x={hover.x} y={margin.top} containerWidth={width}>
          <div className="mb-1 font-medium text-ink-3">{shortDate(dayToIso(hover.day))}</div>
          <ul className="flex flex-col gap-1">
            {hover.rows.map((r) => (
              <li key={r.key} className="flex items-baseline gap-2">
                <span aria-hidden className="h-0.5 w-3 shrink-0 translate-y-[-3px] rounded-full" style={{ background: r.color }} />
                <span className="num font-semibold text-ink">{formatValue(r.value)}</span>
                <span className="min-w-0 truncate text-ink-3">
                  {r.label}
                  {r.sublabel ? ` · ${r.sublabel}` : ''}
                  {r.promo ? ' · on promotion' : ''}
                  {!r.exact ? ' · last known' : ''}
                </span>
              </li>
            ))}
          </ul>
        </ChartTooltip>
      ) : null}
    </div>
  );
}

/** Legend entries + table view for a set of series (shared by pages using TimeSeriesChart). */
export function seriesLegend(series: Series[], colorScope: string, colors: Map<string, string>, hidden?: Set<string>): LegendItem[] {
  void colorScope;
  return series.slice(0, MAX_SERIES).map((s) => ({ key: s.key, label: s.label, sublabel: s.sublabel, color: s.color ?? colors.get(s.key) ?? DEEMPHASIS, shape: 'line', hidden: hidden?.has(s.key) }));
}

export function seriesTable(series: Series[], formatValue: (v: number) => string): TableView {
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort().reverse();
  const lookup = series.map((s) => new Map(s.points.map((p) => [p.date, p.value])));
  return {
    columns: ['Date', ...series.map((s) => (s.sublabel ? `${s.label} · ${s.sublabel}` : s.label))],
    numeric: series.map((_, i) => i + 1),
    rows: dates.map((date) => [date, ...lookup.map((m) => {
      const v = m.get(date);
      return v === null || v === undefined ? null : formatValue(v);
    })]),
  };
}

/** Time series with its legend (toggle to isolate) — the usual way to place a line chart in a ChartFrame. */
export function useSeriesChart(series: Series[], colorScope: string) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const colors = useSeriesColors(colorScope, series.map((s) => s.key));
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const legend = <Legend items={seriesLegend(series, colorScope, colors, hidden)} onToggle={series.length > 1 ? toggle : undefined} />;
  return { hidden, legend, colors, overflow: Math.max(0, series.length - MAX_SERIES) };
}

// ---------------------------------------------------------------------------------------------
// Diverging columns (e.g. price increases above the baseline, decreases below)
// ---------------------------------------------------------------------------------------------
export interface DivergingDatum {
  date: string;
  positive: number;
  negative: number;
}

export function DivergingColumns({ data, height = 200, positiveLabel, negativeLabel }: { data: DivergingDatum[]; height?: number; positiveLabel: string; negativeLabel: string }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const margin = { top: 8, right: 8, bottom: 24, left: 34 };
  const width = size.width;
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = Math.max(0, height - margin.top - margin.bottom);
  const maxPos = Math.max(1, ...data.map((d) => d.positive));
  const maxNeg = Math.max(1, ...data.map((d) => d.negative));
  const ticks = niceTicks(-maxNeg, maxPos, 4).filter((t) => Number.isInteger(t));
  const lo = Math.min(ticks[0] ?? -maxNeg, -maxNeg);
  const hi = Math.max(ticks[ticks.length - 1] ?? maxPos, maxPos);
  const y = (v: number) => margin.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(24, band - 2));
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 64))));
  const cap = (x: number, yTop: number, h: number, up: boolean) => {
    // rounded data-end, square at the baseline
    const r = Math.min(4, barW / 2, h);
    if (h <= 0) return '';
    return up
      ? `M${x},${yTop + h}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + barW - r}Q${x + barW},${yTop} ${x + barW},${yTop + r}V${yTop + h}Z`
      : `M${x},${yTop}V${yTop + h - r}Q${x},${yTop + h} ${x + r},${yTop + h}H${x + barW - r}Q${x + barW},${yTop + h} ${x + barW},${yTop + h - r}V${yTop}Z`;
  };
  const active = hover !== null ? data[hover] : null;
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label={`${positiveLabel} and ${negativeLabel} per day. Use the table view for exact values.`} onPointerLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={margin.left} x2={margin.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? AXIS : GRID} strokeWidth={1} />
              <text x={margin.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS_TEXT} className="num">
                {Math.abs(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = margin.left + i * band + (band - barW) / 2;
            const posH = y(0) - y(d.positive);
            const negH = y(-d.negative) - y(0);
            return (
              <g key={d.date} opacity={hover === null || hover === i ? 1 : 0.45}>
                {d.positive > 0 ? <path d={cap(x, y(d.positive), posH, true)} fill={DIVERGING.positive} /> : null}
                {d.negative > 0 ? <path d={cap(x, y(0) + 1, Math.max(0, negH - 1), false)} fill={DIVERGING.negative} /> : null}
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
          <div className="flex items-baseline gap-2">
            <span aria-hidden className="size-2 rounded-[2px]" style={{ background: DIVERGING.positive }} />
            <span className="num font-semibold text-ink">{active.positive}</span>
            <span className="text-ink-3">{positiveLabel}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span aria-hidden className="size-2 rounded-[2px]" style={{ background: DIVERGING.negative }} />
            <span className="num font-semibold text-ink">{active.negative}</span>
            <span className="text-ink-3">{negativeLabel}</span>
          </div>
        </ChartTooltip>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Ranked horizontal bars
// ---------------------------------------------------------------------------------------------
export interface BarDatum {
  key: string;
  label: ReactNode;
  sublabel?: ReactNode;
  value: number | null;
  display?: ReactNode;
  color?: string;
  onClick?: () => void;
}

export function BarList({ data, color = '#2a78d6', max, emptyText = 'No data', className }: { data: BarDatum[]; color?: string; max?: number; emptyText?: string; className?: string }) {
  const top = max ?? Math.max(0, ...data.map((d) => d.value ?? 0));
  if (!data.length) return <p className="py-6 text-center text-[12.5px] text-ink-3">{emptyText}</p>;
  return (
    <ul className={cn('flex flex-col gap-2.5', className)}>
      {data.map((d) => {
        const pct = top > 0 && d.value !== null ? Math.max(0, Math.min(100, (d.value / top) * 100)) : 0;
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-[12.5px] leading-4">
              <span className="min-w-0 truncate text-ink">
                {d.label}
                {d.sublabel ? <span className="text-ink-3"> · {d.sublabel}</span> : null}
              </span>
              <span className="num shrink-0 font-semibold text-ink">{d.display ?? d.value ?? '—'}</span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-wash">
              <div className="h-1.5 rounded-r-full" style={{ width: `${pct}%`, background: d.color ?? color, minWidth: pct > 0 ? 2 : 0 }} />
            </div>
          </>
        );
        return (
          <li key={d.key}>
            {d.onClick ? (
              <button type="button" className="block w-full text-left hover:opacity-80" onClick={d.onClick}>
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------------------------
export function Sparkline({ values, width = 84, height = 24, color = '#2a78d6', className, label }: { values: Array<number | null>; width?: number; height?: number; color?: string; className?: string; label?: string }) {
  const pts = values.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => p.v !== null && Number.isFinite(p.v));
  if (pts.length < 2) return <span className={cn('inline-block text-ink-4', className)} style={{ width, height }} aria-hidden />;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const x = (i: number) => 2 + (i / (values.length - 1)) * (width - 6);
  const y = (v: number) => (hi === lo ? height / 2 : 3 + (1 - (v - lo) / (hi - lo)) * (height - 6));
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const last = pts[pts.length - 1]!;
  return (
    <svg width={width} height={height} className={className} role="img" aria-label={label ?? 'Trend'}>
      <path d={d} fill="none" stroke={DEEMPHASIS} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.i)} cy={y(last.v)} r={2.5} fill={color} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Promotion Gantt
// ---------------------------------------------------------------------------------------------
export interface GanttBar {
  id: string | number;
  start: string;
  end: string;
  color: string;
  title: string;
  detail?: string;
  current?: boolean;
}
export interface GanttRow {
  key: string;
  label: string;
  sublabel?: string | null;
  bars: GanttBar[];
}

export function PromoGantt({ rows, from, to, rowHeight = 30, labelWidth = 168 }: { rows: GanttRow[]; from: string; to: string; rowHeight?: number; labelWidth?: number }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ bar: GanttBar; x: number; y: number } | null>(null);
  const minDay = dayNumber(from);
  const maxDay = dayNumber(to) + 1;
  const narrow = size.width < 560;
  const lw = narrow ? 104 : labelWidth;
  const plotW = Math.max(0, size.width - lw - 8);
  const x = (day: number) => lw + ((day - minDay) / (maxDay - minDay || 1)) * plotW;
  const ticks = dateTicks(minDay, maxDay - 1, plotW);
  const height = rows.length * rowHeight + 26;
  // bars of the same row that overlap are packed into lanes so none is hidden
  const laid = useMemo(
    () =>
      rows.map((row) => {
        const lanes: number[] = [];
        const bars = [...row.bars]
          .sort((a, b) => (a.start < b.start ? -1 : 1))
          .map((bar) => {
            const s = dayNumber(bar.start);
            const e = dayNumber(bar.end) + 1;
            let lane = lanes.findIndex((end) => end <= s);
            if (lane === -1) {
              lane = lanes.length;
              lanes.push(e);
            } else lanes[lane] = e;
            return { bar, s, e, lane };
          });
        return { row, bars, lanes: Math.max(1, lanes.length) };
      }),
    [rows],
  );
  return (
    <div ref={ref} className="relative w-full overflow-hidden" style={{ height }}>
      {size.width > 0 ? (
        <svg width={size.width} height={height} role="img" aria-label="Promotion timeline. Use the table view for exact dates." onPointerLeave={() => setHover(null)}>
          {ticks.map((d) => (
            <g key={d}>
              <line x1={x(d)} x2={x(d)} y1={0} y2={height - 22} stroke={GRID} strokeWidth={1} />
              <text x={x(d)} y={height - 6} textAnchor="middle" fontSize={11} fill={AXIS_TEXT} className="num">
                {shortDate(dayToIso(d))}
              </text>
            </g>
          ))}
          {laid.map(({ row, bars, lanes }, r) => {
            const top = r * rowHeight;
            const laneH = Math.min(8, (rowHeight - 10) / lanes);
            return (
              <g key={row.key}>
                <line x1={0} x2={size.width} y1={top + rowHeight} y2={top + rowHeight} stroke={GRID} strokeWidth={1} />
                <text x={0} y={top + rowHeight / 2} dy="0.32em" fontSize={12} fill="#0e1b36">
                  {row.label.length > (narrow ? 15 : 24) ? `${row.label.slice(0, narrow ? 14 : 23)}…` : row.label}
                </text>
                {bars.map(({ bar, s, e, lane }) => {
                  const x1 = Math.max(lw, x(Math.max(s, minDay)));
                  const x2 = Math.min(lw + plotW, x(Math.min(e, maxDay)));
                  const w = Math.max(3, x2 - x1 - 2);
                  const yy = top + (rowHeight - lanes * laneH - (lanes - 1) * 2) / 2 + lane * (laneH + 2);
                  return (
                    <rect
                      key={bar.id}
                      x={x1}
                      y={yy}
                      width={w}
                      height={laneH}
                      rx={Math.min(4, laneH / 2)}
                      fill={bar.color}
                      opacity={hover && hover.bar.id !== bar.id ? 0.45 : 1}
                      onPointerEnter={() => setHover({ bar, x: x1 + w / 2, y: yy })}
                      onPointerDown={() => setHover({ bar, x: x1 + w / 2, y: yy })}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      ) : null}
      {hover ? (
        <ChartTooltip x={hover.x} y={Math.max(0, hover.y - 8)} containerWidth={size.width}>
          <div className="font-semibold text-ink">{hover.bar.title}</div>
          {hover.bar.detail ? <div className="text-ink-3">{hover.bar.detail}</div> : null}
          <div className="num mt-0.5 text-ink-3">
            {shortDate(hover.bar.start)} – {shortDate(hover.bar.end)}
            {hover.bar.current ? ' · running' : ''}
          </div>
        </ChartTooltip>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Index scale (parity = 100)
// ---------------------------------------------------------------------------------------------
/**
 * Shows a price index on a scale centred on parity. Left of centre = cheaper than competitors,
 * right = more expensive. Position carries the meaning; the number is printed beside it.
 */
export function IndexScale({ value, range = 30, width = 120, className }: { value: number | null | undefined; range?: number; width?: number; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cn('text-ink-4', className)}>—</span>;
  const clamped = Math.max(100 - range, Math.min(100 + range, value));
  const pos = ((clamped - (100 - range)) / (2 * range)) * 100;
  const color = Math.abs(value - 100) < 0.5 ? '#8a8f9c' : value > 100 ? DIVERGING.positive : DIVERGING.negative;
  const from = Math.min(50, pos);
  const to = Math.max(50, pos);
  return (
    <span className={cn('relative inline-block h-3 align-middle', className)} style={{ width }} role="img" aria-label={`Index ${value.toFixed(1)}; 100 is parity`}>
      <span className="absolute top-1/2 right-0 left-0 h-1 -translate-y-1/2 rounded-full bg-wash" />
      <span className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full" style={{ left: `${from}%`, width: `${to - from}%`, background: color, opacity: 0.55 }} />
      <span className="absolute top-0 bottom-0 left-1/2 w-px bg-ink-4" />
      <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white" style={{ left: `${pos}%`, background: color }} />
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Thin segmented bar (part-to-whole beside its figures)
// ---------------------------------------------------------------------------------------------
export function SegmentedBar({ parts, className, height = 8 }: { parts: Array<{ key: string; label: string; value: number; color: string }>; className?: string; height?: number }) {
  const total = parts.reduce((acc, p) => acc + Math.max(0, p.value), 0);
  if (total <= 0) return <div className={cn('rounded-full bg-wash', className)} style={{ height }} />;
  return (
    <div
      className={cn('flex w-full gap-0.5 overflow-hidden rounded-full', className)}
      style={{ height }}
      role="img"
      aria-label={parts.map((p) => `${p.label}: ${p.value} (${((p.value / total) * 100).toFixed(0)}%)`).join(', ')}
    >
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <div key={p.key} title={`${p.label}: ${p.value} (${((p.value / total) * 100).toFixed(0)}%)`} style={{ width: `${(p.value / total) * 100}%`, background: p.color, minWidth: 2 }} />
        ))}
    </div>
  );
}
