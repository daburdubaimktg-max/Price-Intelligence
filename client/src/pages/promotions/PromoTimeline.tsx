/**
 * Promotion timeline (Gantt) for this screen.
 *
 * The shared PromoGantt packs every bar of a row into one fixed row height, which breaks down when many
 * listings promote at once. This local variant takes explicit lanes per row (so a promotion type can keep
 * its own lane), sizes each row to its lanes and repeats the date axis above and below the plot.
 * Visual language (hairline grid, 8px bars, 2px surface gaps, tooltip) matches the shared chart kit.
 */
import { useMemo, useState } from 'react';
import { AXIS, AXIS_TEXT, ChartTooltip, dateTicks, dayNumber, dayToIso, GRID, shortDate, useSize } from '@/components/charts/kit.tsx';

export interface TimelineBar {
  id: string | number;
  start: string;
  end: string;
  color: string;
  title: string;
  detail?: string;
  current?: boolean;
}

export interface TimelineRow {
  key: string;
  label: string;
  sublabel?: string | null;
  /** Each lane holds bars that do not overlap each other. */
  lanes: TimelineBar[][];
}

const LANE_H = 8;
const LANE_GAP = 2;
const ROW_PAD = 8;
const MIN_ROW = 30;
const AXIS_H = 22;

export function PromoTimeline({ rows, from, to }: { rows: TimelineRow[]; from: string; to: string }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ bar: TimelineBar; x: number; y: number } | null>(null);
  const narrow = size.width < 560;
  const labelW = narrow ? 104 : 176;
  const maxChars = narrow ? 15 : 26;
  const minDay = dayNumber(from);
  const maxDay = dayNumber(to) + 1;
  const plotW = Math.max(0, size.width - labelW - 8);
  const x = (day: number) => labelW + ((day - minDay) / (maxDay - minDay || 1)) * plotW;
  const ticks = dateTicks(minDay, maxDay - 1, plotW);

  const layout = useMemo(() => {
    let top = AXIS_H;
    const out = rows.map((row) => {
      const lanes = Math.max(1, row.lanes.length);
      const height = Math.max(MIN_ROW, ROW_PAD * 2 + lanes * LANE_H + (lanes - 1) * LANE_GAP);
      const offset = (height - (lanes * LANE_H + (lanes - 1) * LANE_GAP)) / 2;
      const item = { row, top, height, offset };
      top += height;
      return item;
    });
    return { rows: out, height: top + AXIS_H };
  }, [rows]);

  const clip = (text: string) => (text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text);

  return (
    <div ref={ref} className="relative w-full" style={{ height: layout.height }}>
      {size.width > 0 ? (
        <svg
          width={size.width}
          height={layout.height}
          role="img"
          aria-label={`Promotion timeline with ${rows.length} rows. Use the table view for exact dates.`}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((d) => {
            // a tick near the right edge is end-anchored so its label is not clipped
            const edge = x(d) > size.width - 24;
            const tx = edge ? size.width - 1 : x(d);
            const anchor = edge ? 'end' : 'middle';
            return (
              <g key={d}>
                <line x1={x(d)} x2={x(d)} y1={AXIS_H - 4} y2={layout.height - AXIS_H + 4} stroke={GRID} strokeWidth={1} />
                <text x={tx} y={12} textAnchor={anchor} fontSize={11} fill={AXIS_TEXT} className="num">
                  {shortDate(dayToIso(d))}
                </text>
                <text x={tx} y={layout.height - 6} textAnchor={anchor} fontSize={11} fill={AXIS_TEXT} className="num">
                  {shortDate(dayToIso(d))}
                </text>
              </g>
            );
          })}
          <line x1={0} x2={size.width} y1={AXIS_H} y2={AXIS_H} stroke={AXIS} strokeWidth={1} />
          {layout.rows.map(({ row, top, height, offset }) => {
            const twoLines = !!row.sublabel && height >= 38;
            return (
              <g key={row.key}>
                <line x1={0} x2={size.width} y1={top + height} y2={top + height} stroke={GRID} strokeWidth={1} />
                <text x={0} y={top + height / 2 - (twoLines ? 6 : 0)} dy="0.32em" fontSize={12} fontWeight={500} fill="#0e1b36">
                  <title>{row.sublabel ? `${row.label} — ${row.sublabel}` : row.label}</title>
                  {clip(row.label)}
                </text>
                {twoLines ? (
                  <text x={0} y={top + height / 2 + 9} dy="0.32em" fontSize={10.5} fill={AXIS_TEXT}>
                    {clip(row.sublabel!)}
                  </text>
                ) : null}
                {row.lanes.map((lane, laneIndex) =>
                  lane.map((bar) => {
                    const s = dayNumber(bar.start);
                    const e = dayNumber(bar.end) + 1;
                    const x1 = Math.max(labelW, x(Math.max(s, minDay)));
                    const x2 = Math.min(labelW + plotW, x(Math.min(e, maxDay)));
                    const w = Math.max(3, x2 - x1 - 2);
                    const y = top + offset + laneIndex * (LANE_H + LANE_GAP);
                    const enter = () => setHover({ bar, x: x1 + w / 2, y });
                    return (
                      <g key={bar.id}>
                        <rect x={x1} y={y} width={w} height={LANE_H} rx={4} fill={bar.color} opacity={hover && hover.bar.id !== bar.id ? 0.4 : 1} />
                        {/* hit area: the whole lane band, wider than the mark */}
                        <rect x={x1 - 1} y={y - LANE_GAP / 2} width={Math.max(8, w + 2)} height={LANE_H + LANE_GAP} fill="transparent" onPointerEnter={enter} onPointerDown={enter} />
                      </g>
                    );
                  }),
                )}
              </g>
            );
          })}
        </svg>
      ) : null}
      {hover ? (
        <ChartTooltip x={hover.x} y={Math.max(0, hover.y - 10)} containerWidth={size.width}>
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
