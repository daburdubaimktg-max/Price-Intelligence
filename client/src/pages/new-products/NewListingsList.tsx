/** The list of the New Products screen: one row per listing that was first seen after its baseline. */
import { useMemo } from 'react';
import { Link } from 'react-router';
import { ArrowRight, ExternalLink, PackagePlus } from 'lucide-react';
import type { NewListingRow, NewListingsResponse } from '@shared/api/new-listings.ts';
import { MarketTime, OwnershipDot, PriceCell } from '@/components/domain/domain.tsx';
import { DealTagChips } from '@/components/domain/signals.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { Badge, Button, EmptyState, Tip } from '@/components/ui/primitives.tsx';
import { useCan } from '@/lib/auth.tsx';
import { PAGE_SIZE } from './filters.ts';

const REVIEW_META: Record<NewListingRow['review_state'], { label: string; tone: 'warn' | 'good' | 'neutral'; title: string }> = {
  needs_review: { label: 'Needs review', tone: 'warn', title: 'Not matched to a product yet: match it, create a product for it, or ignore it' },
  matched: { label: 'Matched', tone: 'good', title: 'A person matched this listing to a product' },
  ignored: { label: 'Ignored', tone: 'neutral', title: 'A reviewer set this listing aside' },
};

/** Where a reviewer deals with the listing: the matching queue, or the product it already belongs to. */
function reviewLink(row: NewListingRow): string {
  if (row.review_state === 'matched' && row.product_id !== null) return `/catalogue/products/${row.product_id}`;
  const search = row.listing_code ?? row.external_id ?? row.listing_title ?? '';
  return `/catalogue?tab=matching${row.review_state === 'ignored' ? '&queue=ignored' : ''}&mq=${encodeURIComponent(search)}`;
}

export function KindBadge({ row }: { row: Pick<NewListingRow, 'kind' | 'listed_before_at' | 'listed_before_count' | 'review_state'> }) {
  if (row.kind === 'new_at_retailer') {
    const more = row.listed_before_count - row.listed_before_at.length;
    return (
      <Tip content={`The product was already listed at ${row.listed_before_at.join(', ')}${more > 0 ? ` and ${more} more` : ''} — a distribution change, not a launch.`}>
        <span>
          <Badge tone="outline">New at this retailer</Badge>
        </span>
      </Tip>
    );
  }
  return (
    <Tip
      content={
        row.review_state === 'matched'
          ? 'No other listing of this product was seen before: nothing says it was on sale anywhere earlier.'
          : 'Not matched to a product yet, so nothing says it was on sale anywhere before. It may also be a known product under another name — review it.'
      }
    >
      <span>
        <Badge tone="accent" icon={PackagePlus}>
          New product
        </Badge>
      </span>
    </Tip>
  );
}

function BrandCell({ row }: { row: NewListingRow }) {
  if (row.brand_name === null) return <span className="text-ink-4">Not recognised</span>;
  const guessed = row.brand_basis === 'title' || row.brand_basis === 'url';
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-1.5">
        <OwnershipDot ownership={row.ownership} />
        <span className="truncate text-ink">{row.brand_name}</span>
      </span>
      {guessed ? (
        <Tip content="This listing is not matched to a product, so it has no brand of its own. The name was found in the retailer's wording — a guess that is not stored and matches nothing.">
          <span className="text-[11px] leading-4 whitespace-nowrap text-ink-3 underline decoration-dotted underline-offset-2">
            {row.brand_basis === 'title' ? 'recognised from the title' : 'recognised from the page address'}
          </span>
        </Tip>
      ) : null}
    </span>
  );
}

export function NewListingsList({
  data,
  loading,
  refetching,
  sort,
  onPage,
  onOpen,
  selectedId,
  filtered,
  onReset,
}: {
  data: NewListingsResponse;
  loading: boolean;
  refetching: boolean;
  sort: string;
  onPage: (page: number) => void;
  onOpen: (listingId: number) => void;
  selectedId: number | null;
  filtered: boolean;
  onReset: () => void;
}) {
  const canReview = useCan('catalogue.write');
  const columns = useMemo<Array<Column<NewListingRow>>>(
    () => [
      {
        key: 'first_seen',
        header: 'First seen',
        cell: (row) => <MarketTime iso={row.first_seen_at} timeZone={row.timezone} short />,
        headerTitle: 'When this system first saw the listing, in the market’s own time',
        nowrap: true,
      },
      {
        key: 'listing',
        header: 'Listing',
        cell: (row) => (
          <span className="flex min-w-0 flex-col gap-1">
            <span className="line-clamp-2 min-w-0 text-ink">{row.listing_title ?? row.external_id ?? `Listing ${row.listing_id}`}</span>
            {row.product_name && row.product_name !== row.listing_title ? <span className="truncate text-[12px] text-ink-3">Product: {row.product_name}</span> : null}
            <span className="flex flex-wrap items-center gap-1.5">
              <KindBadge row={row} />
              {row.is_demo ? <Badge tone="demo">DEMO</Badge> : null}
              {/* brand and retailer move here where their columns are hidden */}
              <span className="text-[12px] text-ink-3 md:hidden">
                {row.brand_name ?? 'Brand not recognised'} · {row.retailer_name}
              </span>
            </span>
          </span>
        ),
        width: '34%',
      },
      { key: 'brand', header: 'Brand', cell: (row) => <BrandCell row={row} />, hideBelow: 'md' },
      {
        key: 'retailer',
        header: 'Retailer',
        cell: (row) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-ink">{row.retailer_name}</span>
            <span className="text-[11px] leading-4 text-ink-3">{row.market_name}</span>
          </span>
        ),
        hideBelow: 'md',
      },
      {
        key: 'price',
        header: 'First price',
        align: 'right',
        headerTitle: 'The price of the first observation of the listing',
        cell: (row) =>
          row.first_price === null ? (
            <Tip content="The item had no readable price when it was found. No price is assumed.">
              <span className="text-ink-4">No price read</span>
            </Tip>
          ) : (
            <PriceCell price={row.first_price} regular={row.first_regular_price} currency={row.currency_code} />
          ),
      },
      { key: 'tags', header: 'Tags', cell: (row) => <DealTagChips tags={row.tags} tagText={row.tag_text} max={2} empty={<span className="text-ink-4">—</span>} />, hideBelow: 'xl' },
      {
        key: 'review',
        header: 'Review',
        cell: (row) => {
          const meta = REVIEW_META[row.review_state];
          return (
            <span className="flex flex-col items-start gap-1">
              <Badge tone={meta.tone} title={meta.title}>
                {meta.label}
              </Badge>
              {canReview || row.review_state === 'matched' ? (
                <Link to={reviewLink(row)} className="link inline-flex items-center gap-1 text-[12px] whitespace-nowrap text-ink" onClick={(e) => e.stopPropagation()}>
                  {row.review_state === 'matched' ? 'Open product' : 'Review'} <ArrowRight className="size-3" aria-hidden />
                </Link>
              ) : null}
            </span>
          );
        },
        hideBelow: 'sm',
      },
      {
        key: 'link',
        header: <span className="sr-only">Retailer page</span>,
        align: 'right',
        cell: (row) =>
          row.listing_url ? (
            <a
              href={row.listing_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-wash hover:text-ink"
              title={`Open the page at ${row.retailer_name}`}
              aria-label={`Open the page at ${row.retailer_name}`}
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          ) : null,
        hideBelow: 'sm',
      },
    ],
    [canReview],
  );

  return (
    <>
      <DataTable
        columns={columns}
        rows={data.rows}
        rowKey={(row) => row.listing_id}
        sort={sort}
        onRowClick={(row) => onOpen(row.listing_id)}
        selectedKey={selectedId}
        loading={loading}
        refetching={refetching}
        empty={
          <EmptyState
            icon={PackagePlus}
            title={filtered ? 'No new listing matches the filters' : 'No new listings in this period'}
            description={filtered ? 'Relax the filters or choose a longer period.' : 'Nothing was first seen after its retailer’s baseline in this period.'}
            action={
              filtered ? (
                <Button variant="secondary" onClick={onReset}>
                  Reset filters
                </Button>
              ) : undefined
            }
          />
        }
      />
      <Pagination page={data.page} pages={data.pages} total={data.total} pageSize={PAGE_SIZE} onPage={onPage} noun="listings" />
    </>
  );
}
