/** Local building blocks shared by the Brand Explorer list and the brand page. */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowDown, ArrowUp, type LucideIcon } from 'lucide-react';
import { toQueryString, type Query } from '@/lib/api.ts';
import { DASH, fmtNumber, fmtPct, fmtPrice, fmtRelative } from '@/lib/format.ts';
import { toList, useReference } from '@/lib/hooks.ts';
import type { Option } from '@/components/ui/filters.tsx';
import { Badge, cn, Tip } from '@/components/ui/primitives.tsx';
import { COMPETITOR_COLOR, OWN_COLOR } from '@/components/charts/kit.tsx';
import { IndexScale, Sparkline } from '@/components/charts/charts.tsx';
import { ChangeCell, DemoBadge } from '@/components/domain/domain.tsx';
import { DealTagChip, dealTagLabel } from '@/components/domain/signals.tsx';
import type { BrandFreshness, BrandMoves, BrandPriceIndex, BrandPriceRange, BrandPromo, BrandTrendPoint } from '@shared/api/brands.ts';

/** Root of every Brand Explorer query key. */
export const BRANDS = 'brands';

/** Width of an element, tracked while it resizes — tables choose their columns from the room they really have. */
export function useElementWidth(): [(element: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
  }, []);
  return [ref, width];
}

/** A navigation link that looks like a small button. */
export function LinkButton({ to, icon: Icon, children, variant = 'secondary', title }: { to: string; icon?: LucideIcon; children: ReactNode; variant?: 'primary' | 'secondary'; title?: string }) {
  return (
    <Link
      to={to}
      title={title}
      className={cn(
        'inline-flex h-[34px] shrink-0 items-center justify-center gap-2 rounded-lg border px-3 text-[13px] font-medium whitespace-nowrap transition-colors select-none',
        variant === 'primary' ? 'border-navy bg-navy text-white hover:bg-navy-hover' : 'border-line-strong bg-surface text-ink hover:border-ink-4 hover:bg-sunken',
      )}
    >
      {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
      {children}
    </Link>
  );
}

/** Options of the scope filters: active markets, their retailers (narrowed by the chosen markets) and the category tree. */
export function useScopeOptions(marketParam: string | undefined) {
  const { ref } = useReference();
  return useMemo(() => {
    const chosen = toList(marketParam);
    const markets = (ref?.markets ?? []).filter((m) => m.is_active);
    const marketName = new Map(markets.map((m) => [m.id, m.name]));
    const market: Option[] = markets.map((m) => ({ value: String(m.id), label: m.name, sublabel: `${m.code} · ${m.currency_code}` }));
    const retailer: Option[] = (ref?.retailers ?? [])
      .filter((r) => r.is_active && (chosen.length === 0 || chosen.includes(String(r.market_id))))
      .map((r) => ({ value: String(r.id), label: r.name, group: marketName.get(r.market_id) ?? 'Other', tag: r.is_demo ? <DemoBadge /> : undefined }));
    const categories = ref?.categories ?? [];
    const category: Option[] = categories
      .filter((c) => c.parent_id === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((parent) => {
        const children = categories.filter((c) => c.parent_id === parent.id).sort((a, b) => a.name.localeCompare(b.name));
        return [{ value: String(parent.id), label: children.length ? `All ${parent.name}` : parent.name, group: children.length ? parent.name : 'Categories' }, ...children.map((c) => ({ value: String(c.id), label: c.name, group: parent.name }))];
      });
    return { market, retailer, category };
  }, [ref, marketParam]);
}

/** Address of a brand page that keeps the scope of the screen the user comes from. */
export function brandHref(id: number, scope: Query): string {
  return `/brands/${id}${toQueryString(scope)}`;
}

/** Trend values on a continuous day axis: days without a value are gaps, never interpolated. */
export function sparkValues(points: BrandTrendPoint[]): Array<number | null> {
  if (points.length === 0) return [];
  const day = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
  const first = day(points[0]!.date);
  const values: Array<number | null> = new Array(day(points[points.length - 1]!.date) - first + 1).fill(null);
  for (const p of points) values[day(p.date) - first] = p.index;
  return values;
}

/** 30-day indexed price trend: sparkline plus the change over the period. */
export function TrendSpark({ points, change, ownership, width = 72, className }: { points: BrandTrendPoint[]; change: number | null; ownership?: 'own' | 'competitor' | null; width?: number; className?: string }) {
  if (points.length < 2 || change === null) {
    return (
      <Tip content="A trend needs prices on at least two days of the last 30.">
        <span className={cn('text-[12px] whitespace-nowrap text-ink-4', className)}>No trend yet</span>
      </Tip>
    );
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    <span className={cn('inline-flex items-center gap-2 whitespace-nowrap', className)}>
      <Sparkline
        values={sparkValues(points)}
        width={width}
        height={22}
        color={ownership === 'competitor' ? COMPETITOR_COLOR : OWN_COLOR}
        label={`Price index from ${first.index.toFixed(1)} on ${first.date} to ${last.index.toFixed(1)} on ${last.date}`}
      />
      <ChangeCell pct={change} />
    </span>
  );
}

/** Price increases and decreases of a period. The arrows carry the direction; colour only reinforces it. */
export function MovesCell({ moves, className }: { moves: BrandMoves; className?: string }) {
  if (moves.increases + moves.decreases === 0) return <span className={cn('text-[12.5px] text-ink-4', className)}>No changes</span>;
  return (
    <span className={cn('num inline-flex items-center gap-2.5 font-medium whitespace-nowrap', className)}>
      <span className={cn('inline-flex items-center gap-0.5', moves.increases ? 'text-crit-ink' : 'text-ink-4')}>
        <ArrowUp className="size-3" aria-hidden />
        {fmtNumber(moves.increases)}
        <span className="sr-only"> price increases</span>
      </span>
      <span className={cn('inline-flex items-center gap-0.5', moves.decreases ? 'text-good-ink' : 'text-ink-4')}>
        <ArrowDown className="size-3" aria-hidden />
        {fmtNumber(moves.decreases)}
        <span className="sr-only"> price decreases</span>
      </span>
    </span>
  );
}

/** "AED 6.25 – 19.25" (a single figure when lowest and highest are the same). */
export function RangeText({ min, max, currency }: { min: number; max: number; currency: string }) {
  return (
    <span className="num whitespace-nowrap">
      <span className="text-[11px] text-ink-3">{currency}</span> <span className="font-medium text-ink">{min === max ? fmtPrice(min, currency) : `${fmtPrice(min, currency)} – ${fmtPrice(max, currency)}`}</span>
    </span>
  );
}

/**
 * Current price ranges, one line per currency — currencies are never merged into one figure. Only the first
 * `limit` lines are shown; the rest are named behind "+N more".
 */
export function PriceRanges({ ranges, limit = 3, align = 'left', showMedian = true }: { ranges: BrandPriceRange[]; limit?: number; align?: 'left' | 'right'; showMedian?: boolean }) {
  if (ranges.length === 0) return <span className="text-[12.5px] text-ink-4">No current price</span>;
  const line = (r: BrandPriceRange) => (
    <span key={r.currency} className={cn('flex items-baseline gap-1.5 text-[12.5px] leading-[18px]', align === 'right' && 'justify-end')}>
      <RangeText min={r.min} max={r.max} currency={r.currency} />
      {showMedian && r.listings > 1 ? <span className="num whitespace-nowrap text-[11.5px] text-ink-3">median {fmtPrice(r.median, r.currency)}</span> : null}
    </span>
  );
  const rest = ranges.slice(limit);
  return (
    <span className={cn('flex min-w-0 flex-col', align === 'right' && 'items-end')}>
      {ranges.slice(0, limit).map(line)}
      {rest.length ? (
        <Tip
          content={
            <span className="flex flex-col gap-0.5">
              {rest.map((r) => (
                <span key={r.currency} className="num">
                  {r.currency} {r.min === r.max ? fmtPrice(r.min, r.currency) : `${fmtPrice(r.min, r.currency)} – ${fmtPrice(r.max, r.currency)}`}
                </span>
              ))}
            </span>
          }
        >
          <span className="w-fit text-[11.5px] leading-[18px] text-ink-3 underline decoration-dotted underline-offset-2">
            +{rest.length} more {rest.length === 1 ? 'currency' : 'currencies'}
          </span>
        </Tip>
      ) : null}
    </span>
  );
}

/** Share of fresh listings on promotion with the average discount. */
export function PromoShare({ promo, className }: { promo: BrandPromo; className?: string }) {
  if (promo.share_pct === null) return <span className={cn('text-ink-4', className)}>{DASH}</span>;
  return (
    <span className={cn('inline-flex flex-col', className)}>
      <span className="num font-medium whitespace-nowrap text-ink">{fmtPct(promo.share_pct, promo.share_pct > 0 && promo.share_pct < 10 ? 1 : 0)}</span>
      <span className="num text-[11.5px] leading-4 whitespace-nowrap text-ink-3">
        {promo.listings === 0 ? 'none now' : promo.avg_discount_pct === null ? `${fmtNumber(promo.listings)} listing${promo.listings === 1 ? '' : 's'}` : `avg ${fmtPct(promo.avg_discount_pct, 0)} off`}
      </span>
    </span>
  );
}

/** Fresh / stale / never-observed listings. Stale and never-observed always carry a labelled badge. */
export function FreshnessBadges({ freshness, className }: { freshness: Pick<BrandFreshness, 'fresh' | 'stale' | 'never_observed'>; className?: string }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      <span className="num whitespace-nowrap">{fmtNumber(freshness.fresh)} fresh</span>
      {freshness.stale > 0 ? (
        <Badge tone="warn" title="Observed, but longer ago than the source's schedule allows. Left out of current prices.">
          {fmtNumber(freshness.stale)} stale
        </Badge>
      ) : null}
      {freshness.never_observed > 0 ? (
        <Badge tone="outline" title="Listed, but no price has been recorded yet.">
          {fmtNumber(freshness.never_observed)} never observed
        </Badge>
      ) : null}
    </span>
  );
}

export function LastObserved({ iso, className }: { iso: string | null; className?: string }) {
  return (
    <span className={cn('num whitespace-nowrap', className)} title={iso ? `${iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}` : undefined}>
      {iso ? fmtRelative(iso) : 'Never observed'}
    </span>
  );
}

/** What a price index says, with the own side as the subject (the index is always own ÷ competitor × 100). */
export function indexSentence(index: number | null, ownName: string, competitorName: string): string {
  if (index === null) return 'No comparable prices yet.';
  const gap = index - 100;
  if (Math.abs(gap) < 0.5) return `${ownName} is priced in line with ${competitorName}.`;
  return `${ownName} is priced ${fmtPct(Math.abs(gap), 1)} ${gap > 0 ? 'above' : 'below'} ${competitorName}.`;
}

/** Index figure with its position on the parity scale. */
export function IndexFigure({ index, scale = true, className }: { index: number | null; scale?: boolean; className?: string }) {
  if (index === null) return <span className={cn('text-ink-4', className)}>{DASH}</span>;
  return (
    <span className={cn('inline-flex items-center gap-2 whitespace-nowrap', className)}>
      {scale ? <IndexScale value={index} width={64} /> : null}
      <span className="num font-semibold text-ink">{index.toFixed(1)}</span>
    </span>
  );
}

/** The price index of a brand row, labelled with who is compared with whom. */
export function BrandIndexCell({ value, compact }: { value: BrandPriceIndex | null; compact?: boolean }) {
  if (!value) return <span className="text-[12.5px] text-ink-4">Not mapped</span>;
  const caption = value.perspective === 'own_vs_competitors' ? 'vs mapped competitors' : 'own products vs this brand';
  if (value.index === null) {
    return (
      <Tip content="The mapped products are measured in different units (g vs ml), so no index is stated.">
        <span className="text-[12.5px] text-ink-3">Not comparable</span>
      </Tip>
    );
  }
  return (
    <Tip content={`Own ÷ competitor price × 100 over ${fmtNumber(value.pairs)} mapped same-retailer pair${value.pairs === 1 ? '' : 's'}. 100 = parity.`}>
      <span className="inline-flex flex-col">
        <IndexFigure index={value.index} scale={!compact} />
        {compact ? null : <span className="text-[11.5px] leading-4 text-ink-3">{caption}</span>}
      </span>
    </Tip>
  );
}

/** Small labelled figure inside a card. */
export function Metric({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-0.5 truncate text-[11.5px] leading-4 text-ink-3">{label}</div>
      <div className="min-w-0 text-[13px] leading-5">{children}</div>
    </div>
  );
}

/** Case-insensitive match of a product against the words typed in the product search. */
export function matchesProduct(query: string, fields: Array<string | null | undefined>): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * Deal tags and badges carried by fresh listings, each with the number of listings showing it (most frequent
 * first). Renders nothing when no fresh listing is tagged.
 */
export function TagCounts({ tags, counts, max = 3, className }: { tags: string[] | undefined; counts: Record<string, number> | undefined; max?: number; className?: string }) {
  if (!tags?.length) return null;
  const rest = tags.slice(max);
  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1', className)}>
      {tags.slice(0, max).map((tag) => (
        <span key={tag} className="inline-flex min-w-0 items-center gap-1">
          <DealTagChip tag={tag} />
          <span className="num text-[11.5px] text-ink-3" title={`${fmtNumber(counts?.[tag] ?? 0)} fresh listing${counts?.[tag] === 1 ? '' : 's'} with this tag`}>
            {fmtNumber(counts?.[tag] ?? 0)}
          </span>
        </span>
      ))}
      {rest.length ? (
        <Tip
          content={
            <span className="flex flex-col gap-0.5">
              {rest.map((tag) => (
                <span key={tag}>
                  {dealTagLabel(tag)} · {fmtNumber(counts?.[tag] ?? 0)}
                </span>
              ))}
            </span>
          }
        >
          <span className="text-[11.5px] whitespace-nowrap text-ink-3 underline decoration-dotted underline-offset-2">+{rest.length} more</span>
        </Tip>
      ) : null}
    </span>
  );
}
