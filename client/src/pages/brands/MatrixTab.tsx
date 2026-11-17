/**
 * Brand page — Price matrix: products × retailers of ONE market, in that market's own currency.
 * The lowest fresh shelf price of each product is marked with an icon and a label (never colour alone); a retailer
 * that does not carry a product shows "Not listed". A cell opens the listing with its history.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowDownToLine, Clock, Grid3x3, Minus, PackageX, Tag } from 'lucide-react';
import { toQueryString } from '@/lib/api.ts';
import { fmtNumber, fmtPct, fmtPrice, fmtRelative, fmtUnitPrice } from '@/lib/format.ts';
import { SearchInput } from '@/components/ui/filters.tsx';
import { Badge, Button, Card, CardHeader, cn, EmptyState, Segmented, Tip } from '@/components/ui/primitives.tsx';
import { DemoBadge, OwnershipDot, PriceCell } from '@/components/domain/domain.tsx';
import { ListingDrawer } from '@/components/domain/observations.tsx';
import { DealTagChip, DealTagChips, dealTagLabel } from '@/components/domain/signals.tsx';
import type { BrandDetailResult, BrandMatrix, BrandMatrixCell, BrandMatrixRow } from '@shared/api/brands.ts';
import { InlineSelect } from '../history/parts.tsx';
import { matchesProduct, useElementWidth } from './parts.tsx';

function cellSummary(cell: BrandMatrixCell, product: string, retailer: string): string {
  const parts = [`${product} at ${retailer}`];
  if (cell.never_observed) parts.push('never observed');
  else if (cell.current_price === null) parts.push('no price recorded');
  else parts.push(`${cell.currency} ${fmtPrice(cell.current_price, cell.currency)}`);
  if (cell.is_cheapest) parts.push('lowest price');
  if (cell.is_promo) parts.push('on promotion');
  if (cell.tags?.length) parts.push(cell.tags.map((tag) => dealTagLabel(tag, true)).join(', '));
  if (cell.is_stale) parts.push('stale');
  if (cell.availability === 'out_of_stock') parts.push('out of stock');
  return `${parts.join(', ')}. Open the listing.`;
}

function MatrixCell({ cell, row, retailer, basis, tied, onOpen }: { cell: BrandMatrixCell | null; row: BrandMatrixRow; retailer: string; basis: string | null; tied: boolean; onOpen: (listingId: number) => void }) {
  if (!cell) {
    return (
      <td className="px-1 py-1 align-top">
        <span className="inline-flex items-center gap-1 px-2 py-1.5 text-[12px] whitespace-nowrap text-ink-4">
          <Minus className="size-3" aria-hidden /> Not listed
        </span>
      </td>
    );
  }
  const variantOnly = cell.is_variant;
  return (
    <td className={cn('px-1 py-1 align-top', cell.is_cheapest && 'bg-good-soft/50')}>
      <button
        type="button"
        onClick={() => onOpen(cell.listing_id)}
        aria-label={cellSummary(cell, row.name, retailer)}
        className="flex w-full min-w-[7.25rem] flex-col items-start gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-wash"
      >
        {cell.never_observed ? (
          <Badge tone="outline">Never observed</Badge>
        ) : cell.current_price === null ? (
          <span className="text-[12.5px] text-ink-3">No price recorded</span>
        ) : (
          <span className={cn('flex flex-col items-start', cell.is_stale && 'opacity-60')}>
            <PriceCell price={cell.current_price} regular={cell.regular_price} currency={cell.currency} isPromo={cell.is_promo} showCurrency={false} className="text-[13.5px]" />
            {cell.unit_price !== null ? (
              <span className="num text-[11.5px] leading-4 whitespace-nowrap text-ink-3">
                {fmtUnitPrice(cell.unit_price, cell.currency)}
                {basis ? ` ${basis.replace('per ', '/')}` : ''}
              </span>
            ) : null}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-1">
          {cell.is_cheapest ? (
            <Badge tone="good" icon={ArrowDownToLine} title={tied ? 'Lowest fresh shelf price for this product, shared with another retailer' : 'Lowest fresh shelf price for this product among the retailers shown'}>
              {tied ? 'Lowest · tied' : 'Lowest'}
            </Badge>
          ) : null}
          {cell.is_promo ? (
            <Badge tone="warn" icon={Tag} title="On promotion at the latest observation">
              {cell.discount_pct !== null ? `${fmtPct(cell.discount_pct, 0)} off` : 'Offer'}
            </Badge>
          ) : null}
          {cell.is_stale ? (
            <Badge tone="warn" icon={Clock} title="Observed longer ago than this source's schedule allows — shown for reference, never compared">
              Stale · {fmtRelative(cell.observed_at)}
            </Badge>
          ) : null}
          {cell.tags?.length ? <DealTagChips tags={cell.tags} tagText={cell.tag_text} max={2} /> : null}
          {cell.availability === 'out_of_stock' ? (
            <Badge tone="crit" icon={PackageX}>
              Out of stock
            </Badge>
          ) : null}
          {variantOnly ? (
            <Badge tone="outline" title="This retailer lists a pack variant only. Its shelf price is not compared with the standard pack.">
              {cell.variant_name ?? 'Pack variant'}
            </Badge>
          ) : null}
          {cell.more_listings.length ? (
            <span className="text-[11px] whitespace-nowrap text-ink-3" title={cell.more_listings.map((l) => `${l.variant_name ?? 'Listing'}: ${l.current_price === null ? 'no price' : fmtPrice(l.current_price, cell.currency)}`).join(' · ')}>
              +{cell.more_listings.length} more listing{cell.more_listings.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </span>
      </button>
    </td>
  );
}

function Legend({ tags }: { tags: boolean }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-2.5 text-[12px] leading-5 text-ink-3">
      <li className="flex items-center gap-1.5">
        <Badge tone="good" icon={ArrowDownToLine}>
          Lowest
        </Badge>
        lowest fresh price of the product
      </li>
      <li className="flex items-center gap-1.5">
        <Badge tone="warn" icon={Tag}>
          % off
        </Badge>
        on promotion, regular price struck through
      </li>
      <li className="flex items-center gap-1.5">
        <Badge tone="warn" icon={Clock}>
          Stale
        </Badge>
        old price, not compared
      </li>
      {tags ? (
        <li className="flex items-center gap-1.5">
          <DealTagChip tag="limited_time_deal" />
          <DealTagChip tag="best_seller" />
          tags and badges the retailer shows now
        </li>
      ) : null}
      <li className="flex items-center gap-1.5">
        <Minus className="size-3" aria-hidden /> Not listed: the retailer does not carry the product
      </li>
    </ul>
  );
}

export function MatrixTab({
  data, brandId, order, onOrder, onMarket, query, onQuery,
}: {
  data: BrandDetailResult;
  brandId: number;
  /** name | spread */
  order: string;
  onOrder: (order: string) => void;
  onMarket: (marketId: string) => void;
  /** Product search shared with the range table. */
  query: string;
  onQuery: (query: string) => void;
}) {
  const [listingId, setListingId] = useState<number | null>(null);
  const [ref, width] = useElementWidth();
  const matrix: BrandMatrix | null = data.matrix;

  const rows = useMemo(() => {
    const list = (matrix?.rows ?? []).filter((r) => matchesProduct(query, [r.name, r.code, r.pack, r.category_name]));
    if (order === 'spread') list.sort((a, b) => (b.spread_pct ?? -1) - (a.spread_pct ?? -1) || a.name.localeCompare(b.name));
    return list;
  }, [matrix, order, query]);

  if (!matrix) {
    return (
      <Card>
        <EmptyState
          icon={Grid3x3}
          title="No retailer lists this brand in the current scope"
          description="The price matrix compares the brand’s products across the retailers of one market. Widen the market, retailer or category filters, or add listings for the brand’s products."
        />
      </Card>
    );
  }

  const narrow = width > 0 && width < 560;
  const firstColumn = narrow ? 132 : width < 1000 ? 190 : 220;
  // The spread gets its own column only when the whole matrix still fits; otherwise it moves under the product name.
  const showSpread = width >= firstColumn + matrix.retailers.length * 152 + 104;
  const compared = rows.filter((r) => r.compared >= 2).length;

  return (
    <div ref={ref} className="min-w-0">
      <Card>
        <CardHeader
          title={
            <>
              Price matrix · {matrix.market.name} <span className="font-normal text-ink-3">({matrix.currency})</span>
            </>
          }
          subtitle={`${query.trim() ? `${fmtNumber(rows.length)} of ${fmtNumber(matrix.rows.length)} products` : `${fmtNumber(matrix.rows.length)} product${matrix.rows.length === 1 ? '' : 's'}`} at ${fmtNumber(matrix.retailers.length)} retailer${matrix.retailers.length === 1 ? '' : 's'} · ${
            compared > 0 ? `${fmtNumber(compared)} with at least two prices to compare` : 'no product has two fresh prices to compare yet'
          }. Prices are the latest selling prices in ${matrix.currency}. Select a cell to open the listing.`}
          actions={
            <>
              {data.markets.length > 1 ? (
                <InlineSelect
                  label="Market"
                  value={String(matrix.market.id)}
                  onChange={onMarket}
                  width="w-56"
                  options={data.markets.map((m) => ({ value: String(m.id), label: `${m.name} · ${m.currency_code} · ${m.listings} listing${m.listings === 1 ? '' : 's'}` }))}
                />
              ) : null}
              {matrix.rows.length > 1 ? <SearchInput value={query} onChange={onQuery} placeholder="Search products…" className="w-52" /> : null}
              <Segmented
                label="Row order"
                size="sm"
                value={order === 'spread' ? 'spread' : 'name'}
                onChange={onOrder}
                options={[
                  { value: 'name', label: 'A–Z' },
                  { value: 'spread', label: 'Widest spread', title: 'Products whose price differs most between retailers first' },
                ]}
              />
            </>
          }
        />
        <Legend tags={matrix.rows.some((row) => row.cells.some((cell) => !!cell?.tags?.length))} />
        <div className="table-wrap">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-[2] border-r border-line" style={{ minWidth: firstColumn }}>
                  Product
                </th>
                {matrix.retailers.map((r) => (
                  <th key={r.id} scope="col" className="align-bottom" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    <Link
                      to={`/monitor${toQueryString({ retailer_id: r.id, brand_id: brandId })}`}
                      className="text-[12.5px] font-semibold text-ink hover:underline"
                      title={`Open ${r.name} in the Live Price Monitor, filtered to this brand`}
                    >
                      {r.name}
                    </Link>
                    <span className="num block text-[11px] leading-4 font-normal text-ink-3">
                      {fmtNumber(r.products)} product{r.products === 1 ? '' : 's'}
                      {r.cheapest_count > 0 ? ` · lowest in ${fmtNumber(r.cheapest_count)}` : ''}
                    </span>
                  </th>
                ))}
                {showSpread ? (
                  <th scope="col" style={{ textAlign: 'right' }} title="(highest − lowest) ÷ lowest fresh shelf price across the retailers compared">
                    Spread
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.product_id}>
                  <th scope="row" className="sticky left-0 z-[1] border-r border-b border-line bg-surface px-3 py-2 text-left align-top font-normal [tr:last-child>&]:border-b-0" style={{ minWidth: firstColumn, maxWidth: narrow ? 148 : 280 }}>
                    <span className="flex items-start gap-2">
                      <OwnershipDot ownership={data.brand.ownership} className="mt-[7px]" />
                      <span className="min-w-0">
                        <Link to={`/catalogue/products/${row.product_id}`} title={row.name} className="line-clamp-3 text-[13px] leading-[18px] font-medium break-words text-ink hover:underline">
                          {row.name}
                        </Link>
                        <span className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] leading-4 text-ink-3">
                          {[row.pack, narrow ? null : row.category_name].filter(Boolean).join(' · ')}
                          {row.is_demo ? <DemoBadge /> : null}
                        </span>
                        {!showSpread && row.spread_pct !== null ? (
                          <span className="num block text-[11.5px] leading-4 text-ink-3" title="(highest − lowest) ÷ lowest fresh shelf price across the retailers compared">
                            Spread <span className="font-medium text-ink-2">{fmtPct(row.spread_pct, 1)}</span>
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </th>
                  {row.cells.map((cell, i) => (
                    <MatrixCell
                      key={matrix.retailers[i]!.id}
                      cell={cell}
                      row={row}
                      retailer={matrix.retailers[i]!.name}
                      basis={row.unit_basis}
                      tied={row.cheapest_retailer_ids.length > 1}
                      onOpen={setListingId}
                    />
                  ))}
                  {showSpread ? (
                    <td className="num align-top whitespace-nowrap" style={{ textAlign: 'right' }}>
                      {row.spread_pct === null ? (
                        <Tip content="A spread needs fresh shelf prices at two or more retailers.">
                          <span className="text-ink-4">—</span>
                        </Tip>
                      ) : (
                        <span className="inline-flex flex-col items-end py-1.5">
                          <span className="font-medium text-ink">{fmtPct(row.spread_pct, 1)}</span>
                          <span className="text-[11px] leading-4 text-ink-3">
                            {fmtPrice(row.min_price, matrix.currency)} – {fmtPrice(row.max_price, matrix.currency)}
                          </span>
                        </span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={Grid3x3}
            title="No product matches the search"
            description={`None of the ${fmtNumber(matrix.rows.length)} products listed in ${matrix.market.name} contains “${query.trim()}”.`}
            action={
              <Button size="sm" onClick={() => onQuery('')}>
                Clear the search
              </Button>
            }
            className="py-8"
          />
        ) : null}
        {matrix.retailers_without_brand.length || matrix.products_not_listed.length || matrix.other_currencies.length ? (
          <div className="flex flex-col gap-1 border-t border-line px-4 py-2.5 text-[12px] leading-5 text-ink-3">
            {matrix.retailers_without_brand.length ? (
              <p>
                <span className="font-medium text-ink-2">Retailers of {matrix.market.name} with none of these products:</span> {matrix.retailers_without_brand.map((r) => r.name).join(', ')}.
              </p>
            ) : null}
            {matrix.products_not_listed.length ? (
              <p>
                <span className="font-medium text-ink-2">Not listed at any retailer of {matrix.market.name}:</span>{' '}
                {matrix.products_not_listed.slice(0, 8).map((p, i) => (
                  <span key={p.product_id}>
                    {i ? ', ' : ''}
                    <Link to={`/catalogue/products/${p.product_id}`} className="link">
                      {p.name}
                    </Link>
                  </span>
                ))}
                {matrix.products_not_listed.length > 8 ? ` and ${matrix.products_not_listed.length - 8} more` : ''}.
              </p>
            ) : null}
            {matrix.other_currencies.length ? (
              <p>
                Some retailers of this market price in {matrix.other_currencies.join(', ')}: their prices are shown but never compared with the {matrix.currency} prices.
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>
      <ListingDrawer listingId={listingId} onClose={() => setListingId(null)} />
    </div>
  );
}
