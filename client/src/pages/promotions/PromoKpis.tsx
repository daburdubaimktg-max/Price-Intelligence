/** Headline promotion figures for the selected period. Every number comes from GET /promotions/summary. */
import { memo } from 'react';
import { StatTile } from '@/components/ui/primitives.tsx';
import { DASH, fmtNumber, fmtPct } from '@/lib/format.ts';
import { diffDays, type DateRange } from '@/lib/hooks.ts';
import type { PromotionSummary } from '@shared/api/analytics.ts';
import { promoTypeLabel } from './promo-meta.ts';

const days = (value: number | null) => (value === null ? DASH : `${value.toFixed(1)} days`);

export const PromoKpis = memo(function PromoKpis({ summary, period }: { summary: PromotionSummary; period: DateRange }) {
  const k = summary.kpis;
  const periodDays = diffDays(period.from, period.to) + 1;
  const top = k.highest_discount;
  return (
    <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <StatTile
        label="Running now"
        value={fmtNumber(k.current)}
        detail="Promotions last seen on promotion and still being observed"
        title="A promotion counts as running only while its listing has a fresh observation."
      />
      <StatTile label="Promotions observed" value={fmtNumber(k.episodes)} detail="Promotions overlapping the selected period" />
      <StatTile
        label="Listings promoted"
        value={
          <>
            {fmtNumber(k.listings_with_promo)}
            <span className="ml-1 text-[13px] font-medium text-ink-3">of {fmtNumber(k.listings_observed)}</span>
          </>
        }
        detail="Observed listings with at least one promotion in the period"
      />
      <StatTile label="Average discount" value={fmtPct(k.avg_discount_pct, 1)} detail="Mean of each promotion's deepest discount" />
      <StatTile
        label="Highest discount"
        value={fmtPct(k.highest_discount_pct, 1)}
        detail={top ? `${top.product_name ?? 'Unmatched listing'} · ${top.retailer_name}, ${top.market_name} · ${promoTypeLabel(top.promo_type)}` : 'No discounted promotion observed'}
      />
      <StatTile
        label="Promotional days"
        value={
          <>
            {fmtNumber(k.promo_calendar_days)}
            <span className="ml-1 text-[13px] font-medium text-ink-3">of {fmtNumber(periodDays)} days</span>
          </>
        }
        detail={`Days with an observed promotion · ${fmtNumber(k.promo_listing_days)} listing-days on promotion (${fmtPct(k.promo_day_share_pct, 1)} of observed listing-days)`}
        title="Days on which at least one promotion was actually observed. A listing observed on promotion on a given day is one listing-day."
      />
      <StatTile
        label="Promo observations"
        value={fmtPct(k.promo_observation_share_pct, 1)}
        detail={`of ${fmtNumber(k.observations)} observations in the period showed promotional pricing`}
      />
      <StatTile
        label="Discount frequency"
        value={k.frequency_per_listing_30d === null ? DASH : fmtNumber(k.frequency_per_listing_30d, 2)}
        detail="Promotions started per listing per 30 days"
      />
      <StatTile label="Average duration" value={days(k.avg_duration_days)} detail="First to last day a promotion was observed" />
      <StatTile
        label="Between promotions"
        value={days(k.avg_days_between)}
        detail="Average from the end of one promotion to the start of the next, same listing"
      />
    </div>
  );
});
