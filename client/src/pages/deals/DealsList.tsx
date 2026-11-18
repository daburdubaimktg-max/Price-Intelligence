/**
 * The deals themselves: a table on wide screens, stacked cards on narrow ones (chosen by the width of the
 * card, not the viewport, because the sidebar takes part of it). Selecting a deal opens its listing.
 */
import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowDown, ArrowUp, ExternalLink, Info, Minus, TrendingDown } from 'lucide-react';
import type { DealRow, DealsResponse } from '@shared/api/deals.ts';
import { PROMO_TYPE_LABELS } from '@shared/constants.ts';
import { useSize } from '@/components/charts/kit.tsx';
import { AvailabilityBadge, DataClassBadge, DemoBadge, MarketTime, OwnershipDot, packText, PriceCell, ProductCell } from '@/components/domain/domain.tsx';
import { DealTagChips, RankBadge, RatingBadge, SellerLabel } from '@/components/domain/signals.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { Badge, Button, cn, EmptyState, LoadingBlock, Tip } from '@/components/ui/primitives.tsx';
import { DASH, fmtPct, fmtPrice, fmtUnitPrice } from '@/lib/format.ts';

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
/** "17 Nov" (with the year when it is not the current one) in the market's time zone. */
function marketDate(iso: string | null | undefined, timeZone: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const withYear = d.getUTCFullYear() !== new Date().getUTCFullYear();
  const key = `${timeZone ?? 'local'}:${withYear}`;
  let f = dateFormatters.get(key);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) };
    try {
      f = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timeZone ?? undefined });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', options);
    }
    dateFormatters.set(key, f);
  }
  return f.format(d);
}

function isRealUrl(url: string | null | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url) && !/\.invalid(\/|$)/i.test(url);
}

const dealName = (r: DealRow) => r.product_name ?? r.listing_title ?? r.listing_code;
/** The marketplace seller, when the listing names one other than the retailer itself. */
const sellerOf = (r: DealRow): string | null => {
  const seller = r.seller_name?.trim();
  return seller && seller.toLowerCase() !== r.retailer_name.trim().toLowerCase() ? seller : null;
};
const notInStock = (r: DealRow) => r.availability === 'out_of_stock' || r.availability === 'limited';
/** A listing has price context once it was observed on two or more days. */
const hasContext = (r: DealRow) => r.drop_vs_avg_30d_pct !== null;
const hasSignalLine = (r: DealRow) => r.rating !== null || r.review_count !== null || (r.sales_rank !== null && r.sales_rank > 0) || !!r.sales_rank_label;

/** Text that adds something to the chips: the promotion wording, unless a chip already shows it. */
function offerText(r: DealRow): string | null {
  const description = r.promo_description?.trim();
  if (!description) return null;
  if (r.tag_text && r.tag_text.toLowerCase().includes(description.toLowerCase())) return null;
  return description;
}

// ---------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------
/** Discount against the regular price; for coupons and multi-buy offers the discount stated with the offer. */
function DiscountFigure({ row, className }: { row: DealRow; className?: string }) {
  if (row.discount_pct !== null) {
    return (
      <span className={cn('num whitespace-nowrap', className)} title="How far the current price is below the regular price">
        <span className="font-semibold text-ink">{fmtPct(row.discount_pct, 1)}</span>
        <span className="ml-1 text-[11.5px] text-ink-3">off</span>
      </span>
    );
  }
  if (row.promo_discount_pct !== null && row.promo_discount_pct > 0) {
    return (
      <span className={cn('num whitespace-nowrap', className)} title="Discount stated with the offer. The price is not below a known regular price.">
        <span className="font-semibold text-ink">{fmtPct(row.promo_discount_pct, 1)}</span>
        <span className="ml-1 text-[11.5px] text-ink-3">stated</span>
      </span>
    );
  }
  const label = row.promo_type && row.promo_type !== 'price_cut' ? PROMO_TYPE_LABELS[row.promo_type] : null;
  return (
    <span className={cn('whitespace-nowrap text-[12px] text-ink-3', className)} title="The price is not below a known regular price: this deal comes from its tag or offer.">
      {label ?? 'Tag only'}
    </span>
  );
}

/** The current price against the listing's own stored history. */
function PriceContext({ row, pageHasContext, align = 'end', inline }: { row: DealRow; pageHasContext: boolean; align?: 'start' | 'end'; inline?: boolean }) {
  const lines: ReactNode[] = [];
  if (hasContext(row)) {
    const drop = row.drop_vs_avg_30d_pct!;
    const flat = Math.abs(drop) < 0.5;
    const Icon = flat ? Minus : drop > 0 ? ArrowDown : ArrowUp;
    lines.push(
      <span key="drop" className="num inline-flex items-center gap-0.5 whitespace-nowrap text-ink-2" title={`30-day average ${fmtPrice(row.avg_30d, row.currency_code)} ${row.currency_code}, from ${row.history_days} observed day${row.history_days === 1 ? '' : 's'} in the last 90`}>
        <Icon className="size-3 shrink-0" aria-hidden />
        {flat ? 'At its 30-day average' : `${fmtPct(Math.abs(drop), 1)} ${drop > 0 ? 'below' : 'above'} 30-day avg`}
      </span>,
    );
    if (row.is_lowest_90d) {
      lines.push(
        <Tip key="low" content={`The current price is the lowest daily price of the last 90 days (${row.history_days} observed days; highest ${fmtPrice(row.high_90d, row.currency_code)} ${row.currency_code}).`}>
          <span className="inline-flex">
            <Badge tone="good" icon={TrendingDown}>
              Lowest in 90 days
            </Badge>
          </span>
        </Tip>,
      );
    }
    lines.push(
      <span key="since" className="whitespace-nowrap text-ink-3" title="Start of the current uninterrupted run of observations that qualify as a deal">
        On offer since {marketDate(row.deal_since, row.timezone)}
      </span>,
    );
  } else if (pageHasContext) {
    lines.push(
      <span key="none" className="whitespace-nowrap text-ink-4" title="Price context (30-day average, 90-day low) needs observations on at least two days.">
        History since {marketDate(row.first_observed_at ?? row.observed_at, row.timezone)}
      </span>,
    );
  }
  if (lines.length === 0) return null;
  if (inline) return <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] leading-4">{lines}</span>;
  return <span className={cn('flex flex-col gap-0.5 text-[11.5px] leading-4', align === 'end' ? 'items-end' : 'items-start')}>{lines}</span>;
}

function RetailerLink({ row, className }: { row: DealRow; className?: string }) {
  if (!isRealUrl(row.listing_url)) return null;
  return (
    <a
      href={row.listing_url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open the listing at ${row.retailer_name} in a new tab`}
      title={`Open the listing at ${row.retailer_name}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-wash hover:text-ink', className)}
    >
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

function SourceBadges({ row }: { row: DealRow }) {
  return (
    <span className="inline-flex items-center gap-1">
      <DataClassBadge value={row.data_class} short />
      {row.is_demo && row.data_class !== 'simulated' ? <DemoBadge /> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Table (wide) and cards (narrow)
// ---------------------------------------------------------------------------------------------
function useDealColumns(width: number, pageHasContext: boolean): Array<Column<DealRow>> {
  const showRetailer = width >= 1040;
  const showObserved = width >= 860;
  return useMemo(() => {
    const product: Column<DealRow> = {
      key: 'product',
      header: showRetailer ? 'Product' : 'Product · retailer',
      className: 'w-full max-w-0',
      cell: (r) => (
        <span className="block min-w-0">
          <ProductCell
            name={dealName(r)}
            brand={r.product_id === null ? 'Not matched to a product yet' : r.brand_name}
            pack={r.pack_size ? packText(r) : null}
            variant={r.variant_name}
            ownership={r.ownership}
            productId={r.product_id}
            isDemo={!!r.is_demo && !showObserved}
            compact
          />
          {!showRetailer ? (
            <span className="block truncate pl-4 text-[11.5px] leading-4 text-ink-3">
              {r.retailer_name} · {r.market_name}
              {sellerOf(r) ? ` · sold by ${sellerOf(r)}` : ''}
            </span>
          ) : null}
          {!showObserved ? (
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-4 text-[11.5px] leading-4">
              <MarketTime iso={r.observed_at} timeZone={r.timezone} relative />
              <DataClassBadge value={r.data_class} short />
            </span>
          ) : null}
        </span>
      ),
    };

    const retailer: Column<DealRow> = {
      key: 'retailer',
      header: 'Retailer',
      cell: (r) => (
        <span className="block max-w-48 min-w-0">
          <span className="block truncate text-ink">{r.retailer_name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-ink-3">
            {sellerOf(r) ? (
              <>
                <span className="shrink-0" title={r.market_name}>
                  {r.market_code}
                </span>
                <SellerLabel seller={sellerOf(r)} prefix={null} />
              </>
            ) : (
              <span className="truncate">{r.market_name}</span>
            )}
          </span>
        </span>
      ),
    };

    const price: Column<DealRow> = {
      key: 'price',
      header: 'Price',
      align: 'right',
      sortKey: 'price',
      headerTitle: 'Current price, with the regular price struck through. Sorting keeps each currency apart: prices in different currencies are never ranked against each other.',
      cell: (r) => (
        <span className="block">
          <PriceCell price={r.current_price} regular={r.regular_price} currency={r.currency_code} isPromo />
          {r.unit_price !== null ? (
            <span className="num block text-[11.5px] leading-4 text-ink-3">
              {fmtUnitPrice(r.unit_price, r.currency_code)} {r.unit_basis?.replace('per ', '/') ?? ''}
            </span>
          ) : null}
          {notInStock(r) ? (
            <span className="mt-0.5 flex justify-end">
              <AvailabilityBadge value={r.availability} />
            </span>
          ) : null}
        </span>
      ),
    };

    const discount: Column<DealRow> = {
      key: 'discount',
      header: pageHasContext ? 'Discount · history' : 'Discount',
      align: 'right',
      sortKey: 'discount',
      nowrap: false,
      headerTitle: pageHasContext
        ? "Discount against the regular price. Underneath: the price against the listing's own 30-day average, its 90-day low, and since when it has been on offer."
        : 'Discount against the regular price.',
      cell: (r) => (
        <span className="flex flex-col items-end gap-0.5">
          <DiscountFigure row={r} />
          <PriceContext row={r} pageHasContext={pageHasContext} />
        </span>
      ),
    };

    const signals: Column<DealRow> = {
      key: 'signals',
      header: 'Tags · rating',
      headerTitle: "What the retailer shows with the price: deal tags and badges in its own wording, the customer rating and the sales rank.",
      cell: (r) => {
        const text = offerText(r);
        const nothing = r.tags.length === 0 && !text && !hasSignalLine(r);
        if (nothing) return <span className="text-ink-4">{DASH}</span>;
        return (
          <span className="flex max-w-60 min-w-36 flex-col items-start gap-1">
            <DealTagChips tags={r.tags} tagText={r.tag_text} variant="full" max={3} />
            {text ? (
              <span className="block max-w-full truncate text-[11.5px] leading-4 text-ink-3" title={text}>
                {text}
              </span>
            ) : null}
            {hasSignalLine(r) ? (
              <span className="flex max-w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] leading-4">
                <RatingBadge rating={r.rating} reviews={r.review_count} />
                <RankBadge rank={r.sales_rank} label={r.sales_rank_label} />
              </span>
            ) : null}
          </span>
        );
      },
    };

    const observed: Column<DealRow> = {
      key: 'observed',
      header: 'Observed',
      sortKey: 'observed',
      nowrap: true,
      cell: (r) => (
        <span className="inline-flex flex-col items-start gap-1">
          <MarketTime iso={r.observed_at} timeZone={r.timezone} relative />
          <SourceBadges row={r} />
        </span>
      ),
    };

    const link: Column<DealRow> = {
      key: 'link',
      header: <span className="sr-only">Retailer page</span>,
      align: 'right',
      width: '44px',
      cell: (r) => <RetailerLink row={r} />,
    };

    return [product, ...(showRetailer ? [retailer] : []), price, discount, signals, ...(showObserved ? [observed] : []), link];
  }, [showRetailer, showObserved, pageHasContext]);
}

function DealCards({ rows, onOpen, pageHasContext }: { rows: DealRow[]; onOpen: (listingId: number) => void; pageHasContext: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => {
        const text = offerText(r);
        return (
          <li key={r.listing_id}>
            <div
              role="button"
              tabIndex={0}
              aria-label={`${dealName(r)} at ${r.retailer_name}: open the listing`}
              onClick={() => onOpen(r.listing_id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(r.listing_id);
                }
              }}
              className="flex cursor-pointer flex-col gap-1.5 px-4 py-3 text-left hover:bg-sunken"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  <OwnershipDot ownership={r.ownership} className="mt-[7px]" />
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-[13.5px] leading-5 font-medium text-ink">{dealName(r)}</div>
                    <div className="truncate text-[11.5px] leading-4 text-ink-3">
                      {[r.product_id === null ? 'Not matched to a product yet' : r.brand_name, r.variant_name ?? (r.pack_size ? packText(r) : null)].filter(Boolean).join(' · ') || DASH}
                    </div>
                    <div className="truncate text-[11.5px] leading-4 text-ink-3">
                      {r.retailer_name} · {r.market_name}
                      {sellerOf(r) ? ` · sold by ${sellerOf(r)}` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5 text-[13px]">
                  <DiscountFigure row={r} />
                  <PriceCell price={r.current_price} regular={r.regular_price} currency={r.currency_code} isPromo />
                  {r.unit_price !== null ? (
                    <span className="num text-[11.5px] leading-4 text-ink-3">
                      {fmtUnitPrice(r.unit_price, r.currency_code)} {r.unit_basis?.replace('per ', '/') ?? ''}
                    </span>
                  ) : null}
                </div>
              </div>
              {r.tags.length || text || notInStock(r) ? (
                <div className="flex flex-wrap items-center gap-1.5 pl-4">
                  <DealTagChips tags={r.tags} tagText={r.tag_text} variant="full" max={3} />
                  {notInStock(r) ? <AvailabilityBadge value={r.availability} /> : null}
                  {text ? <span className="min-w-0 truncate text-[11.5px] leading-4 text-ink-3">{text}</span> : null}
                </div>
              ) : null}
              {hasSignalLine(r) ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 text-[12px] leading-4">
                  <RatingBadge rating={r.rating} reviews={r.review_count} />
                  <RankBadge rank={r.sales_rank} label={r.sales_rank_label} />
                </div>
              ) : null}
              {hasContext(r) || pageHasContext ? (
                <div className="pl-4">
                  <PriceContext row={r} pageHasContext={pageHasContext} inline />
                </div>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-4 text-[11.5px] leading-4">
                <span className="flex flex-wrap items-center gap-1.5">
                  <MarketTime iso={r.observed_at} timeZone={r.timezone} relative />
                  <SourceBadges row={r} />
                </span>
                <span className="flex items-center gap-3">
                  {r.product_id ? (
                    <Link to={`/catalogue/products/${r.product_id}`} className="link" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      Product
                    </Link>
                  ) : null}
                  {isRealUrl(r.listing_url) ? (
                    <a href={r.listing_url} target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      Retailer page <ExternalLink className="size-3 shrink-0" aria-hidden />
                    </a>
                  ) : null}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------
export interface DealsListProps {
  data: DealsResponse | undefined;
  loading: boolean;
  refetching: boolean;
  sort: string;
  onSort: (sort: string) => void;
  onPage: (page: number) => void;
  onOpen: (listingId: number) => void;
  selectedId: number | null;
  /** True when a filter other than sorting / paging is active. */
  filtered: boolean;
  onReset: () => void;
}

export function DealsList({ data, loading, refetching, sort, onSort, onPage, onOpen, selectedId, filtered, onReset }: DealsListProps) {
  const navigate = useNavigate();
  const [ref, size] = useSize<HTMLDivElement>();
  const width = size.width || (typeof window === 'undefined' ? 1280 : window.innerWidth);
  const rows = data?.rows;
  const pageHasContext = !!rows?.some(hasContext);
  const columns = useDealColumns(width, pageHasContext);
  const cards = width < 640;

  // When no listing on the page has two observed days yet, say so once instead of repeating it in every row.
  const historyStart = useMemo(() => {
    if (!rows?.length || pageHasContext) return null;
    let first: DealRow | null = null;
    for (const r of rows) {
      const at = r.first_observed_at ?? r.observed_at;
      if (first === null || at < (first.first_observed_at ?? first.observed_at)) first = r;
    }
    return first ? marketDate(first.first_observed_at ?? first.observed_at, first.timezone) : null;
  }, [rows, pageHasContext]);

  const empty = filtered ? (
    <EmptyState
      title="No deals match these filters"
      description="Relax or reset the filters. Tag and discount filters only keep deals that carry that tag or reach that discount."
      action={
        <Button size="sm" onClick={onReset}>
          Reset filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      title="No deals right now"
      description="A deal needs a fresh observation that carries an offer tag, is on promotion or sells below its regular price. Listings whose last observation is older than their source's schedule allows are left out until they are collected again."
      action={
        <Button size="sm" onClick={() => navigate('/monitor')}>
          Open the Live Price Monitor
        </Button>
      }
    />
  );

  return (
    <div ref={ref} className="min-w-0">
      {historyStart ? (
        <p className="flex items-start gap-2 border-b border-line bg-sunken px-4 py-2 text-[12px] leading-5 text-ink-3">
          <Info className="mt-[3px] size-3.5 shrink-0" aria-hidden />
          <span>
            History starts {historyStart}. Price context (how far a price is below its 30-day average, whether it is the lowest in 90 days, how long a deal has been running) builds up as days
            are collected.
          </span>
        </p>
      ) : null}
      {cards ? (
        <div className={cn('transition-opacity', refetching && 'opacity-60')}>
          {loading && !rows?.length ? <LoadingBlock /> : rows && rows.length === 0 ? empty : <DealCards rows={rows ?? []} onOpen={onOpen} pageHasContext={pageHasContext} />}
          {data ? <Pagination page={data.page} pages={data.pages} total={data.total} pageSize={data.page_size} onPage={onPage} noun="deals" /> : null}
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.listing_id}
          sort={sort}
          onSort={onSort}
          onRowClick={(r) => onOpen(r.listing_id)}
          selectedKey={selectedId}
          loading={loading}
          refetching={refetching}
          empty={empty}
          footer={data ? <Pagination page={data.page} pages={data.pages} total={data.total} pageSize={data.page_size} onPage={onPage} noun="deals" /> : null}
        />
      )}
    </div>
  );
}
