/** The promotion episodes table: every observed promotion in the selection, with its own status / type / depth controls. */
import { useEffect, useState } from 'react';
import { PriceCell, ProductCell, packText } from '@/components/domain/domain.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { MultiSelect } from '@/components/ui/filters.tsx';
import { Badge, Card, CardHeader, cn, EmptyState, ErrorState, Input, LoadingBlock, Segmented, Select, Tip } from '@/components/ui/primitives.tsx';
import type { Paged } from '@/lib/api.ts';
import { fmtDateShort, fmtDateTime, fmtDateTimeShort, fmtNumber, fmtPct, tzLabel } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useDebounced, useIsNarrow } from '@/lib/hooks.ts';
import { PROMO_TYPES } from '@shared/constants.ts';
import type { PromotionRecord } from '@shared/api/analytics.ts';
import { isRefetching, type PromoFilters } from './filters.ts';
import { promoTypeColor, promoTypeLabel } from './promo-meta.ts';
import { PromoStatus } from './PromoStatus.tsx';

const STATUSES = [
  { value: 'all', label: 'All' },
  { value: 'current', label: 'Running', title: 'Last seen on promotion and the listing is still being observed' },
  { value: 'active', label: 'Not ended', title: 'No observation has shown the promotion ending yet (includes listings that are no longer observed)' },
  { value: 'ended', label: 'Ended', title: 'A later observation showed the promotion had ended' },
] as const;
type Status = (typeof STATUSES)[number]['value'];

const PAGE_SIZE = 25;

/** "17–26 Nov" / "28 Oct – 3 Nov": promotion dates as stated by the retailer. */
function statedRange(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  if (start && end && start.slice(0, 7) === end.slice(0, 7)) return `${Number(start.slice(8, 10))}–${fmtDateShort(end)}`;
  return `${start ? fmtDateShort(start) : '…'} – ${end ? fmtDateShort(end) : '…'}`;
}

function TypeBadge({ type }: { type: string }) {
  return (
    <Badge tone="outline">
      <span aria-hidden className="size-2 rounded-[2px]" style={{ background: promoTypeColor(type) }} />
      {promoTypeLabel(type)}
    </Badge>
  );
}

/** Phone layout: one stacked entry per promotion instead of a wide table. */
function EpisodeList({ rows, loading, refetching, onOpen }: { rows: PromotionRecord[] | undefined; loading: boolean; refetching: boolean; onOpen: (listingId: number) => void }) {
  if (loading && !rows?.length) return <LoadingBlock />;
  if (!rows?.length) return <EmptyState title="No promotions match" description="Change the status, type or minimum discount, or widen the page filters." />;
  return (
    <ul className={cn('divide-y divide-line', refetching && 'opacity-60 transition-opacity')}>
      {rows.map((r) => {
        const stated = statedRange(r.stated_start, r.stated_end);
        return (
          <li key={r.id}>
            <button type="button" className="flex w-full flex-col gap-1.5 px-4 py-3 text-left hover:bg-sunken" onClick={() => onOpen(r.listing_id)}>
              <span className="flex w-full items-start justify-between gap-3">
                <span className="min-w-0 flex-1">
                  <ProductCell name={r.product_name} brand={r.brand_name} pack={packText(r)} ownership={r.ownership} isDemo={r.is_demo} compact />
                </span>
                <span className="num shrink-0 text-[15px] leading-5 font-semibold text-ink">{r.max_discount_pct === null ? '—' : fmtPct(r.max_discount_pct, 1)}</span>
              </span>
              <span className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-4">
                <span className="text-[12px] leading-4 text-ink-2">
                  {r.retailer_name} · {r.market_name}
                </span>
                <PromoStatus status={r.status} isCurrent={r.is_current} endReason={r.end_reason} />
              </span>
              <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-[12px] leading-4 text-ink-3">
                <TypeBadge type={r.promo_type} />
                {r.description ? <span>{r.description}</span> : null}
                {stated ? <span className="num">stated {stated}</span> : null}
              </span>
              <span className="flex w-full flex-col gap-0.5 pl-4 text-[12px] leading-4 text-ink-3">
                <span>
                  <PriceCell price={r.min_promo_price} regular={r.regular_price} currency={r.currency_code} isPromo className="text-[12.5px]" />
                </span>
                <span className="num">
                  First seen {fmtDateTimeShort(r.started_at, r.timezone)} · {r.ended_at ? 'ended' : 'last seen'} {fmtDateTimeShort(r.ended_at ?? r.last_seen_at, r.timezone)} · {fmtNumber(r.duration_days)}{' '}
                  {r.duration_days === 1 ? 'day' : 'days'}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function EpisodesTable({ filters, onOpen }: { filters: PromoFilters; onOpen: (listingId: number) => void }) {
  const { state, set } = filters;
  const status: Status = STATUSES.some((s) => s.value === state.status) ? (state.status as Status) : 'all';
  const page = Math.max(1, Number(state.page ?? 1) || 1);
  const sort = state.sort ?? '-started';
  const narrow = useIsNarrow(639);

  // minimum discount: typed locally, written to the URL once typing pauses
  const [minText, setMinText] = useState(state.min_discount ?? '');
  useEffect(() => setMinText(state.min_discount ?? ''), [state.min_discount]);
  const debouncedMin = useDebounced(minText, 350);
  useEffect(() => {
    const clean = debouncedMin.trim();
    const valid = clean === '' || (Number.isFinite(Number(clean)) && Number(clean) >= 0 && Number(clean) <= 100);
    if (valid && clean !== (state.min_discount ?? '')) set({ min_discount: clean || null, page: null });
  }, [debouncedMin]); // eslint-disable-line react-hooks/exhaustive-deps
  const minInvalid = minText.trim() !== '' && !(Number.isFinite(Number(minText)) && Number(minText) >= 0 && Number(minText) <= 100);

  const q = useApiQuery<Paged<PromotionRecord>>(
    ['promotions', 'list'],
    '/promotions',
    filters.query
      ? { ...filters.query, status: status === 'all' ? undefined : status, type: state.type, min_discount: state.min_discount, sort, page, page_size: PAGE_SIZE }
      : undefined,
    { enabled: !!filters.query },
  );

  const columns: Array<Column<PromotionRecord>> = [
    {
      key: 'product',
      header: 'Product',
      sortKey: 'product',
      nowrap: false,
      cell: (r) => (
        <div className="max-w-56 min-w-40">
          <ProductCell name={r.product_name} brand={r.brand_name} pack={packText(r)} ownership={r.ownership} productId={r.product_id} isDemo={r.is_demo} compact />
        </div>
      ),
    },
    {
      key: 'retailer',
      header: 'Retailer',
      sortKey: 'retailer',
      hideBelow: 'sm',
      cell: (r) => (
        <span className="block max-w-32">
          <span className="block truncate text-ink" title={r.retailer_name}>{r.retailer_name}</span>
          <span className="block text-[11.5px] leading-4 text-ink-3">{r.market_name}</span>
        </span>
      ),
    },
    {
      key: 'offer',
      header: 'Offer',
      cell: (r) => {
        const stated = statedRange(r.stated_start, r.stated_end);
        const line = [r.description, stated ? `stated ${stated}` : null].filter(Boolean).join(' · ');
        return (
          <span className="flex max-w-48 flex-col items-start gap-0.5">
            <TypeBadge type={r.promo_type} />
            {line ? (
              <span className="max-w-full truncate text-[11.5px] leading-4 text-ink-3" title={stated ? `${r.description ?? 'Offer'} — promotion dates stated by the retailer: ${stated}` : line}>
                {line}
              </span>
            ) : null}
          </span>
        );
      },
    },
    { key: 'status', header: 'Status', nowrap: true, cell: (r) => <PromoStatus status={r.status} isCurrent={r.is_current} endReason={r.end_reason} stacked /> },
    {
      key: 'price',
      header: 'Regular → promo',
      align: 'right',
      hideBelow: 'md',
      headerTitle: 'Regular price and the lowest promotional price observed during the promotion',
      cell: (r) => <PriceCell price={r.min_promo_price} regular={r.regular_price} currency={r.currency_code} isPromo />,
    },
    {
      key: 'discount',
      header: 'Discount',
      align: 'right',
      sortKey: 'discount',
      headerTitle: 'Highest discount observed during the promotion',
      cell: (r) =>
        r.max_discount_pct === null ? (
          <Tip content="This offer has no stated price reduction (for example a bundle).">
            <span className="text-ink-4">—</span>
          </Tip>
        ) : (
          <span className="font-medium text-ink">{fmtPct(r.max_discount_pct, 1)}</span>
        ),
    },
    {
      key: 'started',
      header: 'First seen',
      sortKey: 'started',
      hideBelow: 'md',
      nowrap: true,
      headerTitle: 'First observation on promotion; below it the last promotional observation ("seen") or the observation that showed the promotion had ended — market-local time',
      cell: (r) => (
        <Tip
          content={`First seen ${fmtDateTime(r.started_at, r.timezone)}, ${r.ended_at ? 'observed to have ended' : 'last seen on promotion'} ${fmtDateTime(r.ended_at ?? r.last_seen_at, r.timezone)} — ${r.market_name} time (${tzLabel(r.timezone, new Date(r.started_at))})`}
        >
          <span className="flex flex-col">
            <span className="num text-ink-2">{fmtDateTimeShort(r.started_at, r.timezone)}</span>
            <span className="text-[11.5px] leading-4 text-ink-3">
              {r.ended_at ? 'ended ' : 'seen '}
              <span className="num">{fmtDateTimeShort(r.ended_at ?? r.last_seen_at, r.timezone)}</span>
            </span>
          </span>
        </Tip>
      ),
    },
    {
      key: 'duration',
      header: 'Days',
      align: 'right',
      sortKey: 'duration',
      hideBelow: 'sm',
      headerTitle: 'Days from the first to the last day the promotion was observed',
      cell: (r) => (
        <Tip content={`Observed on promotion on ${r.promo_days_observed} day${r.promo_days_observed === 1 ? '' : 's'} (${fmtNumber(r.observation_count)} observation${r.observation_count === 1 ? '' : 's'}).`}>
          <span>{fmtNumber(r.duration_days)}</span>
        </Tip>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader title="Promotion episodes" subtitle="Each row is one observed promotion: consecutive promotional observations of a listing" />
      {/* the table's own controls: they scope this table only */}
      <div className="no-print flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5" role="group" aria-label="Promotion episode filters">
        <Segmented label="Promotion status" size="sm" value={status} onChange={(next) => set({ status: next === 'all' ? null : next, page: null })} options={STATUSES.map((s) => ({ ...s }))} />
        <MultiSelect
          label="Type"
          options={PROMO_TYPES.map((t) => ({ value: t, label: promoTypeLabel(t) }))}
          value={toList(state.type)}
          onChange={(next) => set({ type: fromList(next) ?? null, page: null })}
          searchable={false}
        />
        {narrow ? (
          <Select className="w-auto" value={sort} onChange={(e) => set({ sort: e.target.value, page: null })} aria-label="Sort promotions by">
            <option value="-started">Most recent first</option>
            <option value="-discount">Deepest discount first</option>
            <option value="-duration">Longest first</option>
            <option value="product">Product name</option>
            <option value="retailer">Retailer name</option>
          </Select>
        ) : null}
        <label className="flex items-center gap-1.5 text-[12.5px] whitespace-nowrap text-ink-3">
          Min discount
          <span className="relative inline-flex w-20">
            <Input
              inputMode="decimal"
              value={minText}
              onChange={(e) => setMinText(e.target.value)}
              placeholder="0"
              invalid={minInvalid}
              aria-label="Minimum discount in percent"
              className="pr-6"
            />
            <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[12px] text-ink-3">%</span>
          </span>
        </label>
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {narrow ? (
            <EpisodeList rows={q.data?.rows} loading={q.isPending} refetching={isRefetching(q)} onOpen={onOpen} />
          ) : (
            <DataTable
              columns={columns}
              rows={q.data?.rows}
              rowKey={(r) => r.id}
              sort={sort}
              onSort={(next) => set({ sort: next, page: null })}
              onRowClick={(r) => onOpen(r.listing_id)}
              loading={q.isPending}
              refetching={isRefetching(q)}
              dense
              empty={<EmptyState title="No promotions match" description="Change the status, type or minimum discount, or widen the page filters." />}
            />
          )}
          {q.data ? <Pagination page={q.data.page} pages={q.data.pages} total={q.data.total} pageSize={q.data.page_size} noun="promotions" onPage={(next) => set({ page: next === 1 ? null : String(next) })} /> : null}
        </>
      )}
    </Card>
  );
}
