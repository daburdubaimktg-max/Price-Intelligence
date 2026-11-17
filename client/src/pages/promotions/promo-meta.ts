/** Promotion-type identity (label, colour, order) and the timeline layout shared by the promotion screen. */
import { DEEMPHASIS, SERIES_COLORS, dayNumber } from '@/components/charts/kit.tsx';
import { fmtPct } from '@/lib/format.ts';
import { PROMO_TYPE_LABELS, PROMO_TYPES, type PromoType } from '@shared/constants.ts';
import type { PromoTimelineRow } from '@shared/api/analytics.ts';
import type { TimelineBar, TimelineRow } from './PromoTimeline.tsx';

/** The four promotion mechanics are categorical classes: fixed palette slots 1–4, "other" stays grey. */
const TYPE_COLORS: Record<string, string> = {
  price_cut: SERIES_COLORS[0],
  multi_buy: SERIES_COLORS[1],
  bundle: SERIES_COLORS[2],
  coupon: SERIES_COLORS[3],
  other: DEEMPHASIS,
};

export const PROMO_TYPE_ORDER: readonly string[] = PROMO_TYPES;

export function promoTypeLabel(type: string | null | undefined): string {
  return (type && PROMO_TYPE_LABELS[type as PromoType]) || 'Other offer';
}

export function promoTypeColor(type: string | null | undefined): string {
  return (type && TYPE_COLORS[type]) || DEEMPHASIS;
}

export function typeRank(type: string): number {
  const index = PROMO_TYPE_ORDER.indexOf(type);
  return index === -1 ? PROMO_TYPE_ORDER.length : index;
}

export type TimelineEpisode = PromoTimelineRow['episodes'][number];

/** Highest number of episodes running on the same day. */
function maxConcurrent(episodes: Array<{ start: string; end: string }>): number {
  const events: Array<[number, number]> = [];
  for (const e of episodes) {
    events.push([dayNumber(e.start), 1]);
    events.push([dayNumber(e.end) + 1, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let max = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > max) max = current;
  }
  return max;
}

export interface TimelineLayout {
  rows: TimelineRow[];
  /** True when overlapping promotions of one type were merged into a single bar per row and type. */
  merged: boolean;
  /** Promotion types present, in their fixed order. */
  types: string[];
}

/** A row stays readable up to this many parallel promotions; beyond it rows are summarised per promotion type. */
const MAX_LANES = 6;

function episodeBar(e: TimelineEpisode): TimelineBar {
  return {
    id: e.id,
    start: e.start,
    end: e.end,
    color: promoTypeColor(e.promo_type),
    title: e.product_name ?? 'Unmatched listing',
    detail: [
      `${e.retailer_name} (${e.market_code})`,
      promoTypeLabel(e.promo_type),
      e.max_discount_pct !== null ? `${fmtPct(e.max_discount_pct, 0)} off` : null,
      e.description,
    ]
      .filter(Boolean)
      .join(' · '),
    current: e.is_current === 1,
  };
}

const byStart = (a: { start: string }, b: { start: string }) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

/**
 * Turns timeline rows into Gantt rows.
 *   Sparse selections: every promotion is its own bar, packed into as few lanes as possible.
 *   Dense selections (many listings promoting at once): overlapping promotions of the same type are merged,
 *   and each promotion type keeps its own lane in every row, so the chart reads like a calendar.
 * The table view always lists every promotion individually.
 */
export function layoutTimeline(rows: PromoTimelineRow[]): TimelineLayout {
  const merged = rows.some((row) => maxConcurrent(row.episodes) > MAX_LANES);
  const types = [...new Set(rows.flatMap((r) => r.episodes.map((e) => e.promo_type)))].sort((a, b) => typeRank(a) - typeRank(b));

  const out: TimelineRow[] = rows.map((row) => {
    if (!merged) {
      const lanes: TimelineBar[][] = [];
      const laneEnd: number[] = [];
      for (const e of [...row.episodes].sort(byStart)) {
        const start = dayNumber(e.start);
        let lane = laneEnd.findIndex((end) => end <= start);
        if (lane === -1) {
          lane = lanes.length;
          lanes.push([]);
          laneEnd.push(0);
        }
        lanes[lane]!.push(episodeBar(e));
        laneEnd[lane] = dayNumber(e.end) + 1;
      }
      return { key: row.key, label: row.label, sublabel: row.sublabel, lanes };
    }
    const lanes = types.map((type) => {
      const bars: TimelineBar[] = [];
      let span: { start: string; end: string; count: number; best: number | null; current: boolean } | null = null;
      const flush = () => {
        if (!span) return;
        bars.push({
          id: `${row.key}|${type}|${span.start}`,
          start: span.start,
          end: span.end,
          color: promoTypeColor(type),
          title: `${promoTypeLabel(type)} · ${span.count} promotion${span.count === 1 ? '' : 's'}`,
          detail: [row.label, span.best !== null ? `up to ${fmtPct(span.best, 0)} off` : null].filter(Boolean).join(' · '),
          current: span.current,
        });
        span = null;
      };
      for (const e of row.episodes.filter((x) => x.promo_type === type).sort(byStart)) {
        if (span && dayNumber(e.start) <= dayNumber(span.end) + 1) {
          if (e.end > span.end) span.end = e.end;
          span.count += 1;
          if (e.max_discount_pct !== null && (span.best === null || e.max_discount_pct > span.best)) span.best = e.max_discount_pct;
          if (e.is_current === 1) span.current = true;
        } else {
          flush();
          span = { start: e.start, end: e.end, count: 1, best: e.max_discount_pct, current: e.is_current === 1 };
        }
      }
      flush();
      return bars;
    });
    return { key: row.key, label: row.label, sublabel: row.sublabel, lanes };
  });
  return { rows: out, merged, types };
}
