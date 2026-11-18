/**
 * Headline figures of the current deals. Everything here describes all deals that match the filters (never
 * just the page shown), and only counts and percentages: prices in different currencies are never added up or
 * averaged. The comparison below the figures lives in DealsCompare.tsx.
 */
import { memo } from 'react';
import type { DealsSummary } from '@shared/api/deals.ts';
import { COMPETITOR_COLOR, DEEMPHASIS, OWN_COLOR } from '@/components/charts/kit.tsx';
import { SegmentedBar } from '@/components/charts/charts.tsx';
import { OwnershipDot } from '@/components/domain/domain.tsx';
import { StatTile } from '@/components/ui/primitives.tsx';
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
