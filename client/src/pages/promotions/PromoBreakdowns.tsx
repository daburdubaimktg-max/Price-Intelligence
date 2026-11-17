/** Breakdowns of promotional activity: by mechanic, own vs competitors, by brand, by retailer, deepest discounts. */
import { memo, useMemo, useState } from 'react';
import { ChartFrame, COMPETITOR_COLOR, OWN_COLOR } from '@/components/charts/kit.tsx';
import { OwnershipDot, PromoBadge, ProductCell, packText } from '@/components/domain/domain.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { Card, CardHeader, EmptyState, Select, cn } from '@/components/ui/primitives.tsx';
import { DASH, fmtNumber, fmtPct } from '@/lib/format.ts';
import { useIsNarrow } from '@/lib/hooks.ts';
import type { PromoBreakdown, PromotionRecord } from '@shared/api/analytics.ts';
import { promoTypeColor, promoTypeLabel, typeRank } from './promo-meta.ts';
import { PromoStatus } from './PromoStatus.tsx';

const dayCount = (value: number | null) => (value === null ? DASH : value.toFixed(1));

// ---------------------------------------------------------------------------------------------
// By promotion type
// ---------------------------------------------------------------------------------------------
export const ByTypeCard = memo(function ByTypeCard({ rows, refetching }: { rows: PromoBreakdown[]; refetching?: boolean }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => typeRank(a.key) - typeRank(b.key)), [rows]);
  const top = Math.max(1, ...sorted.map((r) => r.episodes));
  return (
    <ChartFrame
      title="By promotion type"
      subtitle="Promotions in the period, by mechanic"
      refetching={refetching}
      empty={sorted.length === 0 ? <EmptyState title="No promotions in this selection" description="Widen the date range or relax the filters." className="py-8" /> : undefined}
      table={{
        columns: ['Type', 'Promotions', 'Running now', 'Average discount', 'Highest discount', 'Average duration (days)', 'Listing-days on promotion'],
        numeric: [1, 2, 3, 4, 5, 6],
        rows: sorted.map((r) => [
          promoTypeLabel(r.key), r.episodes, r.current, r.avg_discount_pct === null ? null : fmtPct(r.avg_discount_pct, 1),
          r.max_discount_pct === null ? null : fmtPct(r.max_discount_pct, 1), r.avg_duration_days, r.promo_listing_days,
        ]),
      }}
    >
      {/* one column per mechanic on wide screens; the bars share one scale, so their lengths compare across columns */}
      <ul className="grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
        {sorted.map((r) => (
          <li key={r.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-[13px] leading-5">
              <span className="flex min-w-0 items-center gap-2 font-medium text-ink">
                <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: promoTypeColor(r.key) }} />
                <span className="truncate">{promoTypeLabel(r.key)}</span>
              </span>
              <span className="num shrink-0 font-semibold text-ink">
                {fmtNumber(r.episodes)} <span className="font-normal text-ink-3">promotions</span>
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full rounded-full bg-wash" aria-hidden>
              <div className="h-1.5 rounded-r-full" style={{ width: `${(r.episodes / top) * 100}%`, background: promoTypeColor(r.key), minWidth: 2 }} />
            </div>
            <p className="num mt-1.5 text-[12px] leading-4 text-ink-3">
              {fmtNumber(r.current)} running
              {' · '}
              {r.avg_discount_pct === null ? 'no stated price reduction' : `average ${fmtPct(r.avg_discount_pct, 1)} off, highest ${fmtPct(r.max_discount_pct, 1)}`}
              {r.avg_duration_days === null ? '' : ` · ${dayCount(r.avg_duration_days)} days on average`}
            </p>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
});

// ---------------------------------------------------------------------------------------------
// Own brands vs competitors
// ---------------------------------------------------------------------------------------------
function OwnershipColumn({ row, ownership }: { row: PromoBreakdown | undefined; ownership: 'own' | 'competitor' }) {
  const title = ownership === 'own' ? 'Own brands' : 'Competitors';
  const color = ownership === 'own' ? OWN_COLOR : COMPETITOR_COLOR;
  return (
    <div className="min-w-0 flex-1 px-4 py-3">
      <div className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-ink">
        <OwnershipDot ownership={ownership} />
        {title}
      </div>
      {!row ? (
        <p className="py-4 text-[12.5px] text-ink-3">No promotions observed in this selection.</p>
      ) : (
        <dl className="flex flex-col gap-2 text-[12.5px]">
          {[
            ['Promotions in the period', fmtNumber(row.episodes)],
            ['Running now', fmtNumber(row.current)],
            ['Average discount', fmtPct(row.avg_discount_pct, 1)],
            ['Highest discount', fmtPct(row.max_discount_pct, 1)],
            ['Average duration', row.avg_duration_days === null ? DASH : `${dayCount(row.avg_duration_days)} days`],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
              <dt className="text-ink-3">{label}</dt>
              <dd className="num font-semibold text-ink">{value}</dd>
            </div>
          ))}
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-3">Observed listing-days on promotion</dt>
              <dd className="num font-semibold text-ink">{fmtPct(row.promo_day_share_pct, 1)}</dd>
            </div>
            <div className="mt-1.5 h-1.5 w-full rounded-full bg-wash" aria-hidden>
              <div className="h-1.5 rounded-full" style={{ width: `${Math.max(0, Math.min(100, row.promo_day_share_pct ?? 0))}%`, background: color }} />
            </div>
            <p className="num mt-1 text-[11.5px] text-ink-3">{fmtNumber(row.promo_listing_days)} listing-days</p>
          </div>
        </dl>
      )}
    </div>
  );
}

export const OwnVsCompetitorsCard = memo(function OwnVsCompetitorsCard({ rows, refetching }: { rows: PromoBreakdown[]; refetching?: boolean }) {
  const own = rows.find((r) => r.ownership === 'own');
  const competitor = rows.find((r) => r.ownership === 'competitor');
  return (
    <Card className={cn('flex flex-col', refetching && 'opacity-60 transition-opacity')}>
      <CardHeader title="Own brands vs competitors" subtitle="How often and how deeply each side discounts" />
      <div className="flex flex-1 flex-col divide-y divide-line sm:flex-row sm:divide-x sm:divide-y-0">
        <OwnershipColumn row={own} ownership="own" />
        <OwnershipColumn row={competitor} ownership="competitor" />
      </div>
    </Card>
  );
});

// ---------------------------------------------------------------------------------------------
// By brand / by retailer (sortable in the browser — the breakdown is already complete)
// ---------------------------------------------------------------------------------------------
const SORTERS: Record<string, (r: PromoBreakdown) => number | string | null> = {
  label: (r) => r.label.toLowerCase(),
  episodes: (r) => r.episodes,
  current: (r) => r.current,
  avg: (r) => r.avg_discount_pct,
  max: (r) => r.max_discount_pct,
  duration: (r) => r.avg_duration_days,
  share: (r) => r.promo_day_share_pct,
};

function sortRows(rows: PromoBreakdown[], sort: string): PromoBreakdown[] {
  const desc = sort.startsWith('-');
  const pick = SORTERS[desc ? sort.slice(1) : sort] ?? SORTERS.episodes!;
  return [...rows].sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1; // unknown values always last
    if (y === null) return -1;
    const cmp = typeof x === 'string' ? x.localeCompare(String(y)) : x - Number(y);
    return desc ? -cmp : cmp;
  });
}

export const BreakdownTable = memo(function BreakdownTable({
  title,
  subtitle,
  firstColumn,
  rows,
  showOwnership,
  refetching,
  maxHeight,
}: {
  title: string;
  subtitle: string;
  firstColumn: string;
  rows: PromoBreakdown[];
  showOwnership?: boolean;
  refetching?: boolean;
  maxHeight?: number;
}) {
  const [sort, setSort] = useState('-episodes');
  const narrow = useIsNarrow(639);
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const topShare = Math.max(1, ...rows.map((r) => r.promo_day_share_pct ?? 0));
  const columns: Array<Column<PromoBreakdown>> = [
    {
      key: 'label',
      header: firstColumn,
      sortKey: 'label',
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          {showOwnership ? <OwnershipDot ownership={r.ownership ?? null} /> : null}
          <span className="truncate font-medium text-ink">{r.label}</span>
        </span>
      ),
    },
    { key: 'episodes', header: 'Promotions', align: 'right', sortKey: 'episodes', cell: (r) => fmtNumber(r.episodes) },
    { key: 'current', header: 'Running', align: 'right', sortKey: 'current', cell: (r) => fmtNumber(r.current) },
    { key: 'avg', header: 'Avg discount', align: 'right', sortKey: 'avg', cell: (r) => fmtPct(r.avg_discount_pct, 1) },
    { key: 'max', header: 'Highest', align: 'right', sortKey: 'max', hideBelow: 'sm', cell: (r) => fmtPct(r.max_discount_pct, 1) },
    { key: 'duration', header: 'Avg days', align: 'right', sortKey: 'duration', hideBelow: 'sm', headerTitle: 'Average promotion duration in days', cell: (r) => dayCount(r.avg_duration_days) },
    {
      key: 'share',
      header: 'Promo-day share',
      align: 'right',
      sortKey: 'share',
      headerTitle: 'Share of observed listing-days on promotion in the period',
      cell: (r) => (
        <span className="inline-flex items-center justify-end gap-2.5">
          <span className="hidden h-1.5 w-24 rounded-full bg-wash md:inline-block" aria-hidden>
            <span className="block h-1.5 rounded-r-full bg-s1" style={{ width: `${Math.max(0, Math.min(100, ((r.promo_day_share_pct ?? 0) / topShare) * 100))}%` }} />
          </span>
          <span className="inline-block w-12">{fmtPct(r.promo_day_share_pct, 1)}</span>
        </span>
      ),
    },
  ];
  if (narrow) {
    return (
      <Card className={cn(refetching && 'opacity-60 transition-opacity')}>
        <CardHeader title={title} subtitle={subtitle} />
        <label className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px] text-ink-3">
          Sort by
          <Select className="w-auto" value={sort} onChange={(e) => setSort(e.target.value)} aria-label={`Sort ${firstColumn.toLowerCase()}s by`}>
            <option value="-episodes">Most promotions</option>
            <option value="-current">Most running now</option>
            <option value="-avg">Highest average discount</option>
            <option value="-max">Deepest discount</option>
            <option value="-share">Highest promo-day share</option>
            <option value="label">Name</option>
          </Select>
        </label>
        {sorted.length === 0 ? (
          <EmptyState title="No promotions in this selection" description="Widen the date range or relax the filters." className="py-8" />
        ) : (
          <ul className="max-h-[26rem] divide-y divide-line overflow-y-auto">
            {sorted.map((r) => (
              <li key={r.key} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-3 text-[13px] leading-5">
                  <span className="flex min-w-0 items-center gap-2 font-medium text-ink">
                    {showOwnership ? <OwnershipDot ownership={r.ownership ?? null} /> : null}
                    <span className="truncate">{r.label}</span>
                  </span>
                  <span className="num shrink-0 font-semibold text-ink">
                    {fmtNumber(r.episodes)} <span className="font-normal text-ink-3">promotions</span>
                  </span>
                </div>
                <p className="num mt-0.5 text-[12px] leading-4 text-ink-3">
                  {fmtNumber(r.current)} running · average {fmtPct(r.avg_discount_pct, 1)}, highest {fmtPct(r.max_discount_pct, 1)} · {dayCount(r.avg_duration_days)} days · on promotion{' '}
                  {fmtPct(r.promo_day_share_pct, 1)} of observed listing-days
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <DataTable
        columns={columns}
        rows={sorted}
        rowKey={(r) => r.key}
        sort={sort}
        onSort={setSort}
        dense
        refetching={refetching}
        maxHeight={maxHeight}
        empty={<EmptyState title="No promotions in this selection" description="Widen the date range or relax the filters." className="py-8" />}
      />
    </Card>
  );
});

// ---------------------------------------------------------------------------------------------
// Deepest discounts
// ---------------------------------------------------------------------------------------------
export const TopDiscountsCard = memo(function TopDiscountsCard({ rows, onOpen, refetching }: { rows: PromotionRecord[]; onOpen: (listingId: number) => void; refetching?: boolean }) {
  // two columns on wide screens, read down the first column and then the second
  const perColumn = Math.ceil(rows.length / 2);
  return (
    <Card className={cn(refetching && 'opacity-60 transition-opacity')}>
      <CardHeader title="Deepest discounts" subtitle="Promotions with the highest observed discount in the period" />
      {rows.length === 0 ? (
        <EmptyState title="No discounted promotion in this selection" className="py-8" />
      ) : (
        <ol className="lg:grid lg:grid-flow-col lg:grid-cols-2" style={{ gridTemplateRows: `repeat(${perColumn}, auto)` }}>
          {rows.map((r, index) => (
            <li key={r.id} className={cn('min-w-0 border-line', index > 0 && 'border-t', index === perColumn && 'lg:border-t-0', index >= perColumn && 'lg:border-l')}>
              <button type="button" className="flex h-full w-full items-center gap-3 px-4 py-2 text-left hover:bg-sunken" onClick={() => onOpen(r.listing_id)}>
                <span className="num w-4 shrink-0 text-right text-[12px] text-ink-4">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <ProductCell name={r.product_name} brand={r.brand_name} pack={packText(r)} ownership={r.ownership} isDemo={r.is_demo} compact />
                  <span className="mt-0.5 block truncate pl-4 text-[11.5px] leading-4 text-ink-3">
                    {r.retailer_name} · {r.market_name}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <PromoBadge type={r.promo_type} discount={r.max_discount_pct} description={r.description} />
                  <PromoStatus status={r.status} isCurrent={r.is_current} />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
});
