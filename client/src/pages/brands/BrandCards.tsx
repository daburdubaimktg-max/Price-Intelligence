/** Brand Explorer — one card per brand: size of the range, where it is listed, how its prices move. */
import { useId } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { fmtNumber, fmtPct, fmtPrice, initials, plural } from '@/lib/format.ts';
import { Badge, cn } from '@/components/ui/primitives.tsx';
import { DemoBadge, OwnershipBadge } from '@/components/domain/domain.tsx';
import { dealTagLabel } from '@/components/domain/signals.tsx';
import type { BrandExplorerRow } from '@shared/api/brands.ts';
import { BrandIndexCell, FreshnessBadges, LastObserved, Metric, MovesCell, PriceRanges, PromoShare, TagCounts, TrendSpark } from './parts.tsx';

function Count({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-0">
      <dd className="num text-[16px] leading-5 font-semibold text-ink">{fmtNumber(value)}</dd>
      <dt className="truncate text-[11.5px] leading-4 text-ink-3">{label}</dt>
    </div>
  );
}

/** One sentence a screen reader announces with the brand name (the card itself is a single link). */
function summaryOf(row: BrandExplorerRow): string {
  const parts = [
    `${row.ownership === 'own' ? 'Own brand' : 'Competitor brand'}${row.is_demo ? ', demo data' : ''}`,
    `${plural(row.products, 'product')}, ${plural(row.listings, 'listing')} at ${plural(row.retailers, 'retailer')} in ${plural(row.markets, 'market')}`,
  ];
  if (row.trend_change_pct !== null) parts.push(`30-day price trend ${row.trend_change_pct === 0 ? 'unchanged' : `${row.trend_change_pct > 0 ? 'up' : 'down'} ${fmtPct(Math.abs(row.trend_change_pct), 1)}`}`);
  if (row.promo.share_pct !== null) parts.push(`${fmtPct(row.promo.share_pct, 0)} of fresh listings on promotion`);
  parts.push(`${fmtNumber(row.moves_7d.increases)} price increases and ${fmtNumber(row.moves_7d.decreases)} decreases in 7 days`);
  if (row.price_index?.index !== null && row.price_index?.index !== undefined) parts.push(`price index ${row.price_index.index.toFixed(1)}`);
  for (const r of row.price_ranges.slice(0, 2)) parts.push(`current prices ${r.currency} ${fmtPrice(r.min, r.currency)} to ${fmtPrice(r.max, r.currency)}`);
  if (row.tags?.length) parts.push(`deal tags now: ${row.tags.map((tag) => `${dealTagLabel(tag, true)} on ${fmtNumber(row.tag_counts?.[tag] ?? 0)}`).join(', ')}`);
  if (row.freshness.stale + row.freshness.never_observed > 0) parts.push(`${fmtNumber(row.freshness.stale)} stale and ${fmtNumber(row.freshness.never_observed)} never-observed listings`);
  return `${parts.join('; ')}.`;
}

function BrandCard({ row, to, converted }: { row: BrandExplorerRow; to: string; converted: boolean }) {
  const moreCategories = row.category_count - row.categories.length;
  const id = useId();
  return (
    <li className="min-w-0">
      <Link to={to} aria-labelledby={`${id}-name`} aria-describedby={`${id}-summary`} className="sheet group flex h-full min-w-0 flex-col transition-colors hover:border-ink-4">
        <span id={`${id}-summary`} className="sr-only">
          {summaryOf(row)}
        </span>
        <div className="flex items-start gap-3 px-4 pt-3.5">
          <span
            aria-hidden
            className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold', row.ownership === 'own' ? 'bg-own-soft text-own-ink' : 'bg-comp-soft text-comp-ink')}
          >
            {initials(row.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 id={`${id}-name`} className="min-w-0 text-[15px] leading-5 font-semibold break-words text-ink group-hover:underline">
                {row.name}
              </h3>
              <OwnershipBadge ownership={row.ownership} />
              {row.is_demo ? <DemoBadge /> : null}
            </div>
            <p className="mt-0.5 truncate text-[12px] leading-4 text-ink-3">{row.manufacturer ?? 'Manufacturer not recorded'}</p>
          </div>
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink" aria-hidden />
        </div>

        <dl className="grid grid-cols-4 gap-2 px-4 pt-3.5">
          <Count value={row.products} label={row.products === 1 ? 'Product' : 'Products'} />
          <Count value={row.listings} label={row.listings === 1 ? 'Listing' : 'Listings'} />
          <Count value={row.retailers} label={row.retailers === 1 ? 'Retailer' : 'Retailers'} />
          <Count value={row.markets} label={row.markets === 1 ? 'Market' : 'Markets'} />
        </dl>

        <div className="flex min-h-5 flex-wrap items-center gap-1.5 px-4 pt-3">
          {row.categories.map((c) => (
            <Badge key={c.id ?? c.name} tone="outline" title={c.parent_name ? `${c.parent_name} › ${c.name}` : undefined}>
              {c.name} <span className="num text-ink-3">{fmtNumber(c.products)}</span>
            </Badge>
          ))}
          {moreCategories > 0 ? <span className="text-[11.5px] text-ink-3">+{moreCategories} more</span> : null}
        </div>

        <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line px-4 py-3">
          <Metric label="30-day price trend">
            <TrendSpark points={row.trend} change={row.trend_change_pct} ownership={row.ownership} />
          </Metric>
          <Metric label="On promotion">
            <PromoShare promo={row.promo} />
          </Metric>
          <Metric label="Price moves · 7 days">
            <MovesCell moves={row.moves_7d} />
          </Metric>
          <Metric label="Price index">
            <BrandIndexCell value={row.price_index} />
          </Metric>
          {row.tags?.length ? (
            <Metric label={`Deal tags now · ${fmtNumber(row.tagged_listings ?? 0)} listing${row.tagged_listings === 1 ? '' : 's'}`} className="col-span-2">
              <TagCounts tags={row.tags} counts={row.tag_counts} max={3} />
            </Metric>
          ) : null}
        </div>

        <div className="border-t border-line px-4 py-3">
          <div className="mb-1 text-[11.5px] leading-4 text-ink-3">{converted ? 'Current prices (converted)' : 'Current prices'}</div>
          <PriceRanges ranges={row.price_ranges} limit={2} />
        </div>

        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 text-[12px] leading-5 text-ink-3">
          <FreshnessBadges freshness={row.freshness} />
          <LastObserved iso={row.freshness.last_observed_at} />
        </div>
      </Link>
    </li>
  );
}

export function BrandCards({ rows, hrefOf, converted }: { rows: BrandExplorerRow[]; hrefOf: (row: BrandExplorerRow) => string; converted: boolean }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4" aria-label="Brands">
      {rows.map((row) => (
        <BrandCard key={row.id} row={row} to={hrefOf(row)} converted={converted} />
      ))}
    </ul>
  );
}
