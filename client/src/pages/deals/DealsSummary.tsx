/**
 * Headline figures and breakdowns of the current deals. Everything here describes all deals that match the
 * filters (never just the page shown), and only counts and percentages: prices in different currencies are
 * never added up or averaged.
 */
import { memo, useState } from 'react';
import { Check } from 'lucide-react';
import type { DealBrandCount, DealRetailerCount, DealsSummary } from '@shared/api/deals.ts';
import { ChartFrame, COMPETITOR_COLOR, DEEMPHASIS, OWN_COLOR } from '@/components/charts/kit.tsx';
import { SegmentedBar } from '@/components/charts/charts.tsx';
import { OwnershipDot } from '@/components/domain/domain.tsx';
import { cn, EmptyState, StatTile } from '@/components/ui/primitives.tsx';
import { DASH, fmtDateTime, fmtMoney, fmtNumber, fmtPct, fmtRelative, tzLabel } from '@/lib/format.ts';

const viewerZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
})();

// ---------------------------------------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------------------------------------
export const DealsSummaryStrip = memo(function DealsSummaryStrip({ summary, onOpenListing }: { summary: DealsSummary; onOpenListing: (listingId: number) => void }) {
  const deepest = summary.deepest;
  const unmatched = Math.max(0, summary.total - summary.own - summary.competitor);
  const ownShare = summary.own + summary.competitor > 0 ? (summary.own / (summary.own + summary.competitor)) * 100 : null;
  return (
    <div className="stagger grid grid-cols-2 gap-3 xl:grid-cols-4">
      <StatTile
        label="Deals right now"
        value={fmtNumber(summary.total)}
        detail={
          summary.total === 0 ? (
            'No listing in this selection is on offer'
          ) : (
            <>
              <span className="block">
                {summary.total === 1 ? 'Listing' : 'Listings'} on offer in this selection{summary.currencies.length ? ` · prices in ${summary.currencies.join(', ')}` : ''}
              </span>
              {summary.latest_observation_at ? (
                <span className="block" title={`${fmtDateTime(summary.latest_observation_at)} ${tzLabel(viewerZone)}. A listing whose last observation is stale is never listed as a deal.`}>
                  Latest observation {fmtRelative(summary.latest_observation_at)}
                </span>
              ) : null}
            </>
          )
        }
        title="Listings whose latest fresh observation carries an offer tag, is on promotion or sells below its regular price."
      />
      <StatTile
        label="Own brands vs competitors"
        value={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0">
            <span className="inline-flex items-baseline gap-1.5">
              <OwnershipDot ownership="own" className="translate-y-[-3px]" />
              {fmtNumber(summary.own)}
            </span>
            <span className="inline-flex items-baseline gap-1.5">
              <OwnershipDot ownership="competitor" className="translate-y-[-3px]" />
              {fmtNumber(summary.competitor)}
            </span>
          </span>
        }
        detail={
          ownShare === null
            ? 'No matched listing on offer'
            : `${fmtPct(ownShare, 0)} of the deals are on own brands${unmatched ? ` · ${fmtNumber(unmatched)} on unmatched listings` : ''}`
        }
        footer={
          <SegmentedBar
            className="mt-1"
            height={6}
            parts={[
              { key: 'own', label: 'Own brands', value: summary.own, color: OWN_COLOR },
              { key: 'competitor', label: 'Competitors', value: summary.competitor, color: COMPETITOR_COLOR },
              { key: 'unmatched', label: 'Unmatched listings', value: unmatched, color: DEEMPHASIS },
            ]}
          />
        }
      />
      <StatTile
        label="At their 90-day low"
        value={fmtNumber(summary.lowest_90d)}
        detail={
          summary.lowest_90d > 0
            ? 'Current price is the lowest daily price of the last 90 days'
            : summary.total > 0
              ? 'None yet: a listing needs 7 observed days and a price that moved before its low can be called'
              : 'Lowest daily price of the last 90 days'
        }
        title="Counted from each listing's own stored history: at least 7 observed days in the last 90, and a price that changed in that time."
      />
      <StatTile
        label="Deepest discount"
        value={deepest ? fmtPct(deepest.discount_pct, 1) : DASH}
        detail={
          deepest ? (
            <>
              <span className="line-clamp-2 text-ink-2">{deepest.product_name ?? 'Unmatched listing'}</span>
              <span className="num line-clamp-2">
                {deepest.retailer_name} ({deepest.market_code}) · {fmtMoney(deepest.current_price, deepest.currency_code)}, regular {fmtMoney(deepest.regular_price, deepest.currency_code)}
              </span>
            </>
          ) : (
            'No deal sells below a known regular price'
          )
        }
        onClick={deepest ? () => onOpenListing(deepest.listing_id) : undefined}
        title={deepest ? 'Open this listing' : undefined}
      />
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// Breakdowns: deals by brand / by retailer (click a row to filter)
// ---------------------------------------------------------------------------------------------
interface BarRow {
  key: string;
  label: string;
  sublabel?: string | null;
  ownership?: 'own' | 'competitor' | null;
  deals: number;
  avg: number | null;
  max: number | null;
  color: string;
  /** Present when the row can be used as a filter. */
  filterValue: string | null;
}

/** Rows shown before "Show all": long lists (30 retailers) would otherwise push the deals far down the page. */
const VISIBLE_ROWS = 8;

function BreakdownBars({ rows, selected, onToggle, noun, showOwnership, note }: { rows: BarRow[]; selected: Set<string>; onToggle: (value: string) => void; noun: string; showOwnership?: boolean; note?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const top = Math.max(1, ...rows.map((r) => r.deals));
  const collapsible = rows.length > VISIBLE_ROWS + 1;
  // a row that is an active filter stays visible while the list is collapsed
  const visible = !collapsible || expanded ? rows : rows.filter((r, index) => index < VISIBLE_ROWS || (r.filterValue !== null && selected.has(r.filterValue)));
  return (
    <>
    <ul className="@container -mx-2 flex flex-col">
      {visible.map((r) => {
        const on = r.filterValue !== null && selected.has(r.filterValue);
        const stats = r.avg === null ? 'no deal below a known regular price' : `average ${fmtPct(r.avg, 1)} off · deepest ${fmtPct(r.max, 1)}`;
        const body = (
          <>
            <span className="flex min-w-0 items-baseline justify-between gap-3 text-[12.5px] leading-5">
              <span className="flex min-w-0 items-center gap-2">
                {showOwnership ? <OwnershipDot ownership={r.ownership ?? null} /> : null}
                <span className={cn('truncate text-ink', on && 'font-semibold')}>{r.label}</span>
                {r.sublabel ? <span className="shrink-0 text-[11.5px] text-ink-3">{r.sublabel}</span> : null}
                {on ? <Check className="size-3 shrink-0 text-ink" strokeWidth={3} aria-hidden /> : null}
              </span>
              <span className="flex shrink-0 items-baseline gap-3">
                {/* beside the count when the card is wide enough, under the bar otherwise */}
                <span className="num hidden text-[11.5px] text-ink-3 @md:inline">{stats}</span>
                <span className="num min-w-[4.75rem] text-right text-ink-3">
                  <span className="font-semibold text-ink">{fmtNumber(r.deals)}</span> {r.deals === 1 ? 'deal' : 'deals'}
                </span>
              </span>
            </span>
            <span className="mt-1 block h-1.5 w-full rounded-full bg-wash" aria-hidden>
              <span className="block h-1.5 rounded-r-full" style={{ width: `${(r.deals / top) * 100}%`, background: r.color, minWidth: 2 }} />
            </span>
            <span className="num mt-1 block text-[11.5px] leading-4 text-ink-3 @md:hidden">{stats}</span>
          </>
        );
        return (
          <li key={r.key}>
            {r.filterValue !== null ? (
              <button
                type="button"
                aria-pressed={on}
                title={on ? `Remove the ${noun} filter for ${r.label}` : `Show only deals of ${r.label}`}
                onClick={() => onToggle(r.filterValue!)}
                className={cn('block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sunken', on && 'bg-sunken')}
              >
                {body}
              </button>
            ) : (
              <div className="px-2 py-1.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
      {collapsible || note ? (
        <p className="mt-2 text-[12.5px] leading-5 text-ink-3">
          {collapsible ? (
            <button type="button" className="link" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? `Show the top ${VISIBLE_ROWS} only` : `Show all ${fmtNumber(rows.length)} ${noun}s`}
            </button>
          ) : null}
          {collapsible && note ? ' · ' : null}
          {note}
        </p>
      ) : null}
    </>
  );
}

const empty = <EmptyState title="No deals in this selection" description="Relax the filters to see the breakdown." className="py-8" />;

export const DealsByBrand = memo(function DealsByBrand({ rows, selected, onToggle, refetching }: { rows: DealBrandCount[]; selected: string[]; onToggle: (brandId: string) => void; refetching?: boolean }) {
  const bars: BarRow[] = rows.map((r) => ({
    key: String(r.brand_id ?? 'unmatched'),
    label: r.brand_name,
    ownership: r.ownership,
    deals: r.deals,
    avg: r.avg_discount_pct,
    max: r.max_discount_pct,
    color: r.ownership === 'own' ? OWN_COLOR : r.ownership === 'competitor' ? COMPETITOR_COLOR : DEEMPHASIS,
    filterValue: r.brand_id === null ? null : String(r.brand_id),
  }));
  return (
    <ChartFrame
      title="Deals by brand"
      subtitle="Own brands and competitors. Select a brand to filter the list"
      refetching={refetching}
      empty={bars.length === 0 ? empty : undefined}
      table={{
        columns: ['Brand', 'Ownership', 'Deals', 'Average discount', 'Deepest discount'],
        numeric: [2, 3, 4],
        rows: rows.map((r) => [
          r.brand_name,
          r.ownership === 'own' ? 'Own' : r.ownership === 'competitor' ? 'Competitor' : null,
          r.deals,
          r.avg_discount_pct === null ? null : fmtPct(r.avg_discount_pct, 1),
          r.max_discount_pct === null ? null : fmtPct(r.max_discount_pct, 1),
        ]),
      }}
    >
      <BreakdownBars
        rows={bars}
        selected={new Set(selected)}
        onToggle={onToggle}
        noun="brand"
        showOwnership
        note={rows.length >= 12 ? 'only the 12 brands with the most deals are listed' : null}
      />
    </ChartFrame>
  );
});

export const DealsByRetailer = memo(function DealsByRetailer({ rows, selected, onToggle, refetching }: { rows: DealRetailerCount[]; selected: string[]; onToggle: (retailerId: string) => void; refetching?: boolean }) {
  const bars: BarRow[] = rows.map((r) => ({
    key: String(r.retailer_id),
    label: r.retailer_name,
    sublabel: `${r.market_code} · ${r.currency_code}`,
    deals: r.deals,
    avg: r.avg_discount_pct,
    max: r.max_discount_pct,
    color: '#6b7489',
    filterValue: String(r.retailer_id),
  }));
  return (
    <ChartFrame
      title="Deals by retailer"
      subtitle="Where the offers are. Select a retailer to filter the list"
      refetching={refetching}
      empty={bars.length === 0 ? empty : undefined}
      table={{
        columns: ['Retailer', 'Market', 'Currency', 'Deals', 'Average discount', 'Deepest discount'],
        numeric: [3, 4, 5],
        rows: rows.map((r) => [
          r.retailer_name,
          r.market_name,
          r.currency_code,
          r.deals,
          r.avg_discount_pct === null ? null : fmtPct(r.avg_discount_pct, 1),
          r.max_discount_pct === null ? null : fmtPct(r.max_discount_pct, 1),
        ]),
      }}
    >
      <BreakdownBars rows={bars} selected={new Set(selected)} onToggle={onToggle} noun="retailer" />
    </ChartFrame>
  );
});
