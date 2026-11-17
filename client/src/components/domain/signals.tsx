/**
 * Signals a retailer shows next to a price: deal tags and badges, customer rating, sales rank and seller.
 *
 * Two kinds of tag are kept visually apart, because they mean different things:
 *   * offer tags (limited-time deal, sale-event deal, coupon, multi-buy …) say the listing is on offer — filled chips;
 *   * badges (best seller, retailer's choice, selling fast …) describe the listing — outlined chips.
 * Every chip carries its text; colour and outline only reinforce the difference. Tag keys, labels and
 * descriptions come from shared/constants.ts, so a key added there shows up here without further work.
 */
import { type ReactNode } from 'react';
import {
  BadgeCheck, Flame, Layers, PartyPopper, Star, Store, Tag, TicketPercent, Timer, TrendingDown, Trophy, type LucideIcon,
} from 'lucide-react';
import { DEAL_BADGE_TAGS, DEAL_OFFER_TAGS, DEAL_TAG_DESCRIPTIONS, DEAL_TAG_LABELS, DEAL_TAGS, normaliseDealTags, type DealTag } from '@shared/constants.ts';
import { DASH, fmtCompact, fmtNumber, titleCase } from '@/lib/format.ts';
import { Badge, cn, Tip } from '../ui/primitives.tsx';

// ---------------------------------------------------------------------------------------------
// Tag metadata
// ---------------------------------------------------------------------------------------------
export type DealTagKind = 'offer' | 'badge' | 'unknown';

/** Icons are decoration only: a key without one gets the neutral tag icon. */
const TAG_ICONS: Record<string, LucideIcon> = {
  limited_time_deal: Timer,
  event_deal: PartyPopper,
  lowest_price: TrendingDown,
  deal: Tag,
  coupon: TicketPercent,
  multi_buy: Layers,
  best_seller: Trophy,
  retailer_choice: BadgeCheck,
  selling_fast: Flame,
};

const isKnownTag = (tag: string): tag is DealTag => (DEAL_TAGS as readonly string[]).includes(tag);

export function dealTagKind(tag: string): DealTagKind {
  if ((DEAL_OFFER_TAGS as readonly string[]).includes(tag)) return 'offer';
  if ((DEAL_BADGE_TAGS as readonly string[]).includes(tag)) return 'badge';
  return 'unknown';
}

/** Label of a tag key. `short` drops the explanatory tail ("Coupon / extra discount" → "Coupon"). */
export function dealTagLabel(tag: string, short = false): string {
  const label = isKnownTag(tag) ? DEAL_TAG_LABELS[tag] : titleCase(tag);
  if (!short) return label;
  return label.split(' / ')[0]!.replace(/\s+in N days$/i, '');
}

export function dealTagDescription(tag: string): string | null {
  return isKnownTag(tag) ? DEAL_TAG_DESCRIPTIONS[tag] : null;
}

export function dealTagIcon(tag: string): LucideIcon {
  return TAG_ICONS[tag] ?? Tag;
}

/** Tag keys in the canonical order of DEAL_TAGS; keys this build does not know come last, in the order given. */
export function orderDealTags(tags: readonly string[] | null | undefined): string[] {
  const list = tags ?? [];
  const known = (DEAL_TAGS as readonly string[]).filter((tag) => list.includes(tag));
  const unknown = list.filter((tag) => !isKnownTag(tag));
  return [...known, ...new Set(unknown)];
}

/**
 * The stored wording can hold several of the retailer's phrases ("Early Yellow Friday Deal · Lowest price in
 * 30 days"). Returns the phrase each tag was read from, so a chip can show the retailer's own words.
 */
export function dealTagWordings(tags: readonly string[] | null | undefined, tagText: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!tagText || !tags?.length) return out;
  const pieces = tagText.split(/\s+·\s+|\s*[|;\n]+\s*/).map((piece) => piece.trim()).filter(Boolean);
  for (const piece of pieces) {
    for (const tag of normaliseDealTags([piece])) {
      if (tags.includes(tag) && !out.has(tag)) out.set(tag, piece);
    }
  }
  // one tag and one phrase belong together even when the phrase is not recognised on its own
  if (out.size === 0 && tags.length === 1 && pieces.length === 1) out.set(tags[0]!, pieces[0]!);
  return out;
}

/**
 * Every tag key in display order — offer tags first, then badges — with the keys of `extra` that this build
 * does not know appended (e.g. a key from the URL), so nothing selected can disappear from a control.
 */
export function dealTagKeys(extra: readonly string[] = []): string[] {
  const known = DEAL_TAGS as readonly string[];
  return [...known.filter((tag) => dealTagKind(tag) === 'offer'), ...known.filter((tag) => dealTagKind(tag) !== 'offer'), ...extra.filter((tag) => !known.includes(tag))];
}

/** Options of a tag multi-select: every tag that occurs (or is selected), grouped into offer tags and badges. */
export function dealTagOptions(counts: Partial<Record<string, number>> | null | undefined, selected: readonly string[] = [], noun = 'listing'): Array<{ value: string; label: string; sublabel?: string; group?: string }> {
  return dealTagKeys(selected)
    .filter((tag) => (counts?.[tag] ?? 0) > 0 || selected.includes(tag))
    .map((tag) => {
      const count = counts?.[tag] ?? 0;
      return {
        value: tag,
        label: dealTagLabel(tag),
        sublabel: `${fmtNumber(count)} ${count === 1 ? noun : `${noun}s`}`,
        group: dealTagKind(tag) === 'offer' ? 'Offer tags' : dealTagKind(tag) === 'badge' ? 'Badges' : 'Other',
      };
    });
}

// ---------------------------------------------------------------------------------------------
// Deal tag chips
// ---------------------------------------------------------------------------------------------
const WORDING_MAX = 34;

/**
 * One tag. With `wording` (the retailer's own phrase) and `showWording`, the chip shows that phrase when it
 * says more than the label ("Buy 3 For 27.38 AED", "Lowest price in 30 days"); the label then moves to the tooltip.
 */
export function DealTagChip({ tag, wording, showWording, className }: { tag: string; wording?: string | null; showWording?: boolean; className?: string }) {
  const kind = dealTagKind(tag);
  const label = dealTagLabel(tag, true);
  const fullLabel = dealTagLabel(tag);
  const description = dealTagDescription(tag);
  const phrase = wording?.trim() || null;
  const useWording = !!showWording && !!phrase && phrase.length <= WORDING_MAX && phrase.toLowerCase() !== label.toLowerCase();
  const text = useWording ? phrase : label;
  const tip = (
    <>
      <span className="font-medium">
        {kind === 'offer' ? 'Offer tag' : kind === 'badge' ? 'Badge' : 'Tag'}: {fullLabel}
      </span>
      {description ? <span className="block">{description}</span> : null}
      {phrase && phrase !== text ? <span className="block">Retailer's wording: “{phrase}”</span> : null}
    </>
  );
  return (
    <Tip content={tip}>
      <span className={cn('inline-flex max-w-full min-w-0', className)} data-tag={tag} data-tag-kind={kind}>
        <Badge tone={kind === 'offer' ? 'warn' : kind === 'badge' ? 'outline' : 'neutral'} icon={dealTagIcon(tag)} className="max-w-full min-w-0 !shrink">
          <span className="truncate">{text}</span>
        </Badge>
      </span>
    </Tip>
  );
}

export interface DealTagChipsProps {
  tags: readonly string[] | null | undefined;
  /** The retailer's own wording of the tags, as stored with the observation. */
  tagText?: string | null;
  /**
   * compact: at most `max` chips with canonical labels, the rest behind a "+N" chip (for table cells).
   * full: every chip, with the retailer's phrase where it says more (for detail views and deal lists).
   */
  variant?: 'compact' | 'full';
  max?: number;
  /** Rendered when there is no tag (default: nothing). */
  empty?: ReactNode;
  align?: 'start' | 'end';
  className?: string;
}

export function DealTagChips({ tags, tagText, variant = 'compact', max, empty = null, align = 'start', className }: DealTagChipsProps) {
  const ordered = orderDealTags(tags);
  if (ordered.length === 0) return <>{empty}</>;
  const wordings = dealTagWordings(ordered, tagText);
  const limit = variant === 'compact' ? (max ?? 2) : (max ?? ordered.length);
  const shown = ordered.slice(0, limit);
  const rest = ordered.slice(limit);
  return (
    <span className={cn('inline-flex max-w-full min-w-0 flex-wrap items-center gap-1', align === 'end' && 'justify-end', className)} role="list" aria-label="Deal tags">
      {shown.map((tag) => (
        <span key={tag} role="listitem" className="inline-flex max-w-full min-w-0">
          <DealTagChip tag={tag} wording={wordings.get(tag)} showWording={variant === 'full'} />
        </span>
      ))}
      {rest.length ? (
        <Tip
          content={
            <>
              {rest.map((tag) => (
                <span key={tag} className="block">
                  {dealTagLabel(tag)}
                  {wordings.get(tag) ? ` — “${wordings.get(tag)}”` : ''}
                </span>
              ))}
            </>
          }
        >
          <span role="listitem" className="inline-flex">
            <Badge tone="neutral">
              +{rest.length}
              <span className="sr-only"> more: {rest.map((tag) => dealTagLabel(tag)).join(', ')}</span>
            </Badge>
          </span>
        </Tip>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Rating, sales rank, seller
// ---------------------------------------------------------------------------------------------
const fmtRating = (rating: number) => (Math.round(rating * 10) / 10).toFixed(1);

/** ★ 4.6 (1,280) — the average customer rating and the number of ratings behind it, as the retailer showed them. */
export function RatingBadge({ rating, reviews, variant = 'compact', empty = null, className }: { rating: number | null | undefined; reviews?: number | null; variant?: 'compact' | 'full'; empty?: ReactNode; className?: string }) {
  const hasRating = rating !== null && rating !== undefined && Number.isFinite(rating);
  const hasReviews = reviews !== null && reviews !== undefined && Number.isFinite(reviews);
  if (!hasRating && !hasReviews) return <>{empty}</>;
  const count = hasReviews ? reviews! : null;
  const spoken = [hasRating ? `Rated ${fmtRating(rating!)} out of 5` : null, count !== null ? `${fmtNumber(count)} ${count === 1 ? 'rating' : 'ratings'}` : null].filter(Boolean).join(', ');
  return (
    <span className={cn('num inline-flex items-center gap-1 whitespace-nowrap', className)} title={`${spoken} (as shown by the retailer)`}>
      <span className="sr-only">{spoken}</span>
      <span aria-hidden className="inline-flex items-center gap-1">
        {hasRating ? (
          <>
            <Star className="size-3 shrink-0 text-s4" fill="currentColor" strokeWidth={1.5} />
            <span className="font-medium text-ink">{fmtRating(rating!)}</span>
          </>
        ) : null}
        {count !== null ? (
          variant === 'full' ? (
            <span className="text-ink-3">
              {hasRating ? '· ' : ''}
              {fmtNumber(count)} {count === 1 ? 'review' : 'reviews'}
            </span>
          ) : (
            <span className="text-[11.5px] text-ink-3">({count >= 10_000 ? fmtCompact(count) : fmtNumber(count)})</span>
          )
        ) : null}
      </span>
    </span>
  );
}

/** "#3 in Shampoos": the position in the retailer's sales ranking and the list it refers to. */
export function RankBadge({ rank, label, variant = 'compact', empty = null, className }: { rank: number | null | undefined; label?: string | null; variant?: 'compact' | 'full'; empty?: ReactNode; className?: string }) {
  const hasRank = rank !== null && rank !== undefined && rank > 0;
  const text = label?.trim() || null;
  if (!hasRank && !text) return <>{empty}</>;
  // the label usually repeats the position ("#3 in Shampoos"); keep one of them
  const list = text ? text.replace(/^#\s*\d[\d,]*\s*/, '').trim() : '';
  const position = hasRank ? `#${fmtNumber(rank!)}` : (text?.match(/^#\s*\d[\d,]*/)?.[0] ?? '');
  const full = [position, list].filter(Boolean).join(' ') || text || DASH;
  if (variant === 'full') {
    return (
      <span className={cn('num text-ink', className)}>
        {position ? <span className="font-medium">{position}</span> : null}
        {list ? <span className="text-ink-2"> {list}</span> : null}
      </span>
    );
  }
  return (
    <span className={cn('num inline-flex max-w-full min-w-0 items-baseline gap-1 whitespace-nowrap', className)} title={`Sales rank at the retailer: ${full}`}>
      <span className="sr-only">Sales rank </span>
      {position ? <span className="font-medium text-ink-2">{position}</span> : null}
      {list ? <span className="truncate text-[11.5px] text-ink-3">{list}</span> : null}
    </span>
  );
}

/** Who sells the item on the listing: the retailer itself or a marketplace seller. */
export function SellerLabel({ seller, prefix = 'Sold by', empty = null, className }: { seller: string | null | undefined; prefix?: string | null; empty?: ReactNode; className?: string }) {
  const name = seller?.trim();
  if (!name) return <>{empty}</>;
  return (
    <span className={cn('inline-flex max-w-full min-w-0 items-center gap-1 text-ink-3', className)} title={`Seller on this listing: ${name}`}>
      <Store className="size-3 shrink-0" aria-hidden />
      <span className="truncate">
        {prefix ? `${prefix} ` : <span className="sr-only">Sold by </span>}
        <span className="text-ink-2">{name}</span>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// The signals of one observation, together
// ---------------------------------------------------------------------------------------------
export interface ObservationSignals {
  tags?: readonly string[] | null;
  tag_text?: string | null;
  rating?: number | null;
  review_count?: number | null;
  sales_rank?: number | null;
  sales_rank_label?: string | null;
  seller_name?: string | null;
}

export function hasSignals(o: ObservationSignals | null | undefined): boolean {
  if (!o) return false;
  return !!o.tags?.length || !!o.tag_text || o.rating != null || o.review_count != null || (o.sales_rank != null && o.sales_rank > 0) || !!o.sales_rank_label || !!o.seller_name;
}

/** Rating · rank · seller on one line (each part only when the retailer showed it). */
export function SignalLine({ signals, className, seller = true }: { signals: ObservationSignals; className?: string; seller?: boolean }) {
  const parts: ReactNode[] = [];
  if (signals.rating != null || signals.review_count != null) parts.push(<RatingBadge key="rating" rating={signals.rating} reviews={signals.review_count} />);
  if ((signals.sales_rank != null && signals.sales_rank > 0) || signals.sales_rank_label) parts.push(<RankBadge key="rank" rank={signals.sales_rank} label={signals.sales_rank_label} />);
  if (seller && signals.seller_name) parts.push(<SellerLabel key="seller" seller={signals.seller_name} />);
  if (parts.length === 0) return null;
  return <span className={cn('flex max-w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-4', className)}>{parts}</span>;
}

/** Label / value rows of the signals for a detail panel (pass to DescriptionList; rows without a value are hidden). */
export function signalItems(o: ObservationSignals): Array<{ label: ReactNode; value: ReactNode; hidden?: boolean }> {
  const tags = orderDealTags(o.tags);
  return [
    { label: 'Deal tags', value: <DealTagChips tags={tags} tagText={o.tag_text} variant="full" align="end" />, hidden: tags.length === 0 },
    { label: "Retailer's wording", value: o.tag_text ? <span className="font-normal text-ink-2">“{o.tag_text}”</span> : DASH, hidden: !o.tag_text },
    { label: 'Customer rating', value: <RatingBadge rating={o.rating} reviews={o.review_count} variant="full" />, hidden: o.rating == null && o.review_count == null },
    { label: 'Sales rank', value: <RankBadge rank={o.sales_rank} label={o.sales_rank_label} variant="full" />, hidden: !(o.sales_rank != null && o.sales_rank > 0) && !o.sales_rank_label },
    { label: 'Seller', value: o.seller_name ?? DASH, hidden: !o.seller_name },
  ];
}
