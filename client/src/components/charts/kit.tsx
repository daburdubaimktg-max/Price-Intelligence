/**
 * Chart foundations: the validated categorical palette, stable colour assignment, sizing, scales,
 * and the chart frame (title, legend, table-view twin).
 *
 * Rules encoded here (see the data-viz method):
 *   * categorical hues are used in fixed order, never cycled; more than 8 series are not drawn
 *   * colour follows the entity: a series keeps its hue when filters change
 *   * one y-axis per chart; solid hairline grid; text never wears the series colour
 *   * every chart has a table view and a legend for two or more series
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Table2, ChartLine } from 'lucide-react';
import { cn, EmptyState, IconButton } from '../ui/primitives.tsx';

export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'] as const;
export const MAX_SERIES = SERIES_COLORS.length;
export const OWN_COLOR = SERIES_COLORS[0];
export const COMPETITOR_COLOR = SERIES_COLORS[1];
/** Diverging poles (cool ↔ warm) with a neutral midpoint. */
export const DIVERGING = { negative: '#2a78d6', positive: '#e34948', neutral: '#d9d7cf' } as const;
export const DEEMPHASIS = '#b7bac3';
export const GRID = '#e9e7e0';
export const AXIS = '#cfccc2';
export const AXIS_TEXT = '#6b7489';

const colorMemory = new Map<string, Map<string, number>>();

/**
 * Assigns each series key a palette slot and remembers it for the lifetime of the page (per `scope`),
 * so a series keeps its colour when other series are filtered out.
 */
export function useSeriesColors(scope: string, keys: string[]): Map<string, string> {
  return useMemo(() => {
    let memory = colorMemory.get(scope);
    if (!memory) {
      memory = new Map();
      colorMemory.set(scope, memory);
    }
    // forget keys no longer shown only when slots run out
    const present = new Set(keys);
    const used = new Set<number>();
    for (const [key, slot] of memory) if (present.has(key)) used.add(slot);
    const out = new Map<string, string>();
    for (const key of keys) {
      let slot = memory.get(key);
      if (slot === undefined || (used.has(slot) && [...out.keys()].some((k) => memory!.get(k) === slot && k !== key))) {
        slot = undefined;
        for (let i = 0; i < MAX_SERIES; i++) {
          if (!used.has(i)) {
            slot = i;
            break;
          }
        }
        if (slot === undefined) slot = MAX_SERIES - 1;
        memory.set(key, slot);
      }
      used.add(slot);
      out.set(key, SERIES_COLORS[slot]!);
    }
    return out;
  }, [scope, keys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize((prev) => (Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5 ? prev : { width: rect.width, height: rect.height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/** "Nice" tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const rawStep = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual >= 7.5 ? 10 : residual >= 3.5 ? 5 : residual >= 1.5 ? 2 : 1) * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

export const dayNumber = (isoDate: string): number => Math.round(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / 86_400_000);
export const dayToIso = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/** Evenly spaced date ticks that fit the available width. */
export function dateTicks(minDay: number, maxDay: number, width: number): number[] {
  const span = Math.max(1, maxDay - minDay);
  const maxTicks = Math.max(2, Math.floor(width / 78));
  const candidates = [1, 2, 7, 14, 30, 61, 91, 182, 365];
  const step = candidates.find((c) => span / c <= maxTicks) ?? 365;
  const ticks: number[] = [];
  for (let d = maxDay; d >= minDay; d -= step) ticks.unshift(d);
  return ticks;
}

export interface LegendItem {
  key: string;
  label: string;
  sublabel?: string | null;
  color: string;
  shape?: 'line' | 'rect';
  hidden?: boolean;
}

export function Legend({ items, onToggle, className }: { items: LegendItem[]; onToggle?: (key: string) => void; className?: string }) {
  if (items.length < 2 && !onToggle) return null;
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] leading-4 text-ink-2', className)}>
      {items.map((item) => {
        const body = (
          <>
            <span
              aria-hidden
              className={cn('shrink-0 rounded-[2px]', item.shape === 'rect' ? 'size-2.5' : 'h-0.5 w-3.5 rounded-full')}
              style={{ background: item.hidden ? DEEMPHASIS : item.color }}
            />
            <span className={cn('truncate', item.hidden && 'text-ink-4 line-through')}>
              {item.label}
              {item.sublabel ? <span className="text-ink-3"> · {item.sublabel}</span> : null}
            </span>
          </>
        );
        return (
          <li key={item.key} className="min-w-0">
            {onToggle ? (
              <button type="button" className="flex max-w-64 items-center gap-1.5 hover:text-ink" aria-pressed={!item.hidden} title="Show / hide this series" onClick={() => onToggle(item.key)}>
                {body}
              </button>
            ) : (
              <span className="flex max-w-64 items-center gap-1.5">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface TableView {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  /** Columns (by index) that hold numbers and should be right-aligned. */
  numeric?: number[];
}

/**
 * Card around a chart: title, optional note, legend slot and the table-view toggle
 * (the accessible twin of the chart — every value is reachable without hovering).
 */
export function ChartFrame({
  title,
  subtitle,
  actions,
  legend,
  table,
  children,
  footer,
  empty,
  refetching,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  legend?: ReactNode;
  table?: TableView | null;
  children: ReactNode;
  footer?: ReactNode;
  /** When set, shown instead of the chart. */
  empty?: ReactNode;
  refetching?: boolean;
  className?: string;
}) {
  const [showTable, setShowTable] = useState(false);
  useEffect(() => {
    if (!table) setShowTable(false);
  }, [table]);
  return (
    <figure className={cn('sheet m-0 flex min-w-0 flex-col', className)}>
      <figcaption className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3">
        <div className="min-w-0">
          <div className="text-[13.5px] leading-5 font-semibold text-ink">{title}</div>
          {subtitle ? <div className="mt-0.5 text-[12px] leading-4 text-ink-3">{subtitle}</div> : null}
        </div>
        <div className="no-print flex shrink-0 flex-wrap items-center gap-2">
          {actions}
          {table && !empty ? (
            <IconButton
              icon={showTable ? ChartLine : Table2}
              label={showTable ? 'Show chart' : 'Show data as a table'}
              size="sm"
              variant="secondary"
              aria-pressed={showTable}
              onClick={() => setShowTable((v) => !v)}
            />
          ) : null}
        </div>
      </figcaption>
      {legend && !empty && !showTable ? <div className="px-4 pt-2.5">{legend}</div> : null}
      <div className={cn('min-w-0 flex-1 px-4 pt-3 pb-3 transition-opacity', refetching && 'opacity-50')}>
        {empty ? (
          empty
        ) : showTable && table ? (
          <div className="table-wrap max-h-80 overflow-y-auto rounded-md border border-line">
            <table className="grid-table is-dense">
              <thead>
                <tr>
                  {table.columns.map((c, i) => (
                    <th key={i} scope="col" style={{ textAlign: table.numeric?.includes(i) ? 'right' : 'left' }}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, i) => (
                      <td key={i} className={cn(table.numeric?.includes(i) && 'num')} style={{ textAlign: table.numeric?.includes(i) ? 'right' : 'left' }}>
                        {cell === null || cell === undefined ? '—' : cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
      {footer ? <div className="border-t border-line px-4 py-2.5 text-[12px] leading-4 text-ink-3">{footer}</div> : null}
    </figure>
  );
}

export function ChartEmpty({ title = 'No data for this selection', description }: { title?: string; description?: ReactNode }) {
  return <EmptyState icon={ChartLine} title={title} description={description ?? 'Widen the date range or relax the filters.'} className="py-8" />;
}

/** Tooltip box positioned inside a relatively positioned chart container. */
export function ChartTooltip({ x, y, containerWidth, children }: { x: number; y: number; containerWidth: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(180);
  useLayoutEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth);
  });
  const left = x + 14 + w > containerWidth ? Math.max(0, x - 14 - w) : x + 14;
  return (
    <div
      ref={ref}
      role="status"
      className="pointer-events-none absolute z-10 max-w-72 min-w-36 rounded-md border border-line bg-surface px-2.5 py-2 text-[12px] leading-4 shadow-pop"
      style={{ left, top: Math.max(0, y) }}
    >
      {children}
    </div>
  );
}
