/** Brand page — Range: every product of the brand with where it is listed and what it currently costs. */
import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowLeftRight, PackageSearch, Tag } from 'lucide-react';
import { toQueryString, type Query } from '@/lib/api.ts';
import { fmtNumber, fmtPct, fmtPrice, fmtUnitPrice, initials } from '@/lib/format.ts';
import { Badge, Button, Card, CardHeader, cn, EmptyState, Notice, Tip } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { SearchInput } from '@/components/ui/filters.tsx';
import { ChangeCell, DemoBadge } from '@/components/domain/domain.tsx';
import { DealTagChips } from '@/components/domain/signals.tsx';
import type { BrandDetailResult, BrandRangeRow } from '@shared/api/brands.ts';
import { LastObserved, matchesProduct, RangeText, TrendSpark, useElementWidth } from './parts.tsx';

type FitColumn = Column<BrandRangeRow> & { minWidth?: number };
type SortKey = 'name' | 'listings' | 'price' | 'unit' | 'promo' | 'change' | 'observed';

const STATUS_LABEL: Record<string, string> = { inactive: 'Inactive', archived: 'Archived' };

/** Lines shown before the rest is folded behind "+N more". */
const LINES = 2;

function More({ count, noun, children }: { count: number; noun: [singular: string, plural: string]; children: ReactNode }) {
  if (count <= 0) return null;
  return (
    <Tip content={<span className="flex flex-col gap-0.5">{children}</span>}>
      <span className="w-fit text-[11.5px] leading-[18px] whitespace-nowrap text-ink-3 underline decoration-dotted underline-offset-2">
        +{count} more {count === 1 ? noun[0] : noun[1]}
      </span>
    </Tip>
  );
}

/** Where a product is listed: retailers and markets, with the listings that do not count towards current prices. */
function ListedAt({ row, stacked }: { row: BrandRangeRow; stacked?: boolean }) {
  if (row.listings === 0) return <span className="text-[12px] text-ink-4">Not listed in this scope</span>;
  return (
    <span className={cn('flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11.5px] leading-[18px] text-ink-3', stacked ? 'flex-col' : 'items-center')}>
      <span className={cn('num whitespace-nowrap', stacked && 'text-[12.5px] text-ink-2')}>
        <span className={stacked ? 'font-medium text-ink' : undefined}>{fmtNumber(row.retailers)}</span> retailer{row.retailers === 1 ? '' : 's'} · {fmtNumber(row.markets)} market{row.markets === 1 ? '' : 's'}
      </span>
      {row.stale + row.never_observed + row.variant_listings > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5">
          {row.stale > 0 ? (
            <Badge tone="warn" title="Observed longer ago than the source's schedule allows. Left out of current prices.">
              {fmtNumber(row.stale)} stale
            </Badge>
          ) : null}
          {row.never_observed > 0 ? (
            <Badge tone="outline" title="Listed, but no price has been recorded yet.">
              {fmtNumber(row.never_observed)} never observed
            </Badge>
          ) : null}
          {row.variant_listings > 0 ? (
            <Tip content="Listings of pack variants (twin packs, bonus packs). They are left out of the shelf prices here because their price differs by construction.">
              <span className="whitespace-nowrap">
                {fmtNumber(row.variant_listings)} pack variant{row.variant_listings === 1 ? '' : 's'}
              </span>
            </Tip>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export function RangeTab({
  data, scope, sort, onSort, query, onQuery, onConvert, reportingCurrency,
}: {
  data: BrandDetailResult;
  /** Scope filters of the page, carried into cross-links. */
  scope: Query;
  sort: string;
  onSort: (sort: string) => void;
  /** Product search shared with the price matrix. */
  query: string;
  onQuery: (query: string) => void;
  /** Switches the page to the reporting currency. */
  onConvert: () => void;
  reportingCurrency: string;
}) {
  const navigate = useNavigate();
  const [ref, width] = useElementWidth();
  const brand = data.brand;
  const phone = width > 0 && width < 620;
  const listedColumn = width >= 1320;
  const converted = data.currency_mode === 'converted';
  const anyTags = data.range.some((r) => !!r.tags?.length);

  const currencies = useMemo(() => [...new Set(data.range.flatMap((r) => r.prices.map((p) => p.currency)))], [data.range]);
  // Prices can only be ordered when every product is priced in one and the same currency.
  const singleCurrency = currencies.length <= 1;

  const rows = useMemo(() => {
    const desc = sort.startsWith('-');
    const key = sort.replace(/^-/, '') as SortKey;
    const valueOf = (r: BrandRangeRow): number | string | null => {
      switch (key) {
        case 'listings':
          return r.listings;
        case 'price':
          return singleCurrency ? (r.prices[0]?.avg ?? null) : null;
        case 'unit':
          return singleCurrency ? (r.prices[0]?.avg_unit_price ?? null) : null;
        case 'promo':
          return r.promo_listings;
        case 'change':
          return r.change_30d_pct;
        case 'observed':
          return r.last_observed_at;
        default:
          return r.name.toLowerCase();
      }
    };
    return data.range
      .filter((r) => matchesProduct(query, [r.name, r.code, r.sku, r.pack, r.category_name, r.subcategory_name]))
      .sort((a, b) => {
        const va = valueOf(a);
        const vb = valueOf(b);
        if (va === null || vb === null) return va === vb ? a.name.localeCompare(b.name) : va === null ? 1 : -1; // no value: always last
        const cmp = typeof va === 'string' ? va.localeCompare(String(vb)) : va - (vb as number);
        return (desc ? -cmp : cmp) || a.name.localeCompare(b.name);
      });
  }, [data.range, sort, singleCurrency, query]);

  const columns = useMemo<FitColumn[]>(
    () => [
      {
        key: 'product',
        header: 'Product',
        sortKey: 'name',
        nowrap: false,
        className: 'align-top',
        cell: (r) => (
          <span className={cn('flex items-start gap-2.5', phone ? 'max-w-[10.5rem] min-w-[8rem]' : 'max-w-[15rem] min-w-[11rem]')}>
            {phone ? null : r.image_url ? (
              <img src={r.image_url} alt="" loading="lazy" className="size-8 shrink-0 rounded-md border border-line object-cover" />
            ) : (
              <span aria-hidden className={cn('flex size-8 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold', brand.ownership === 'own' ? 'bg-own-soft text-own-ink' : 'bg-comp-soft text-comp-ink')}>
                {initials(r.name)}
              </span>
            )}
            <span className="min-w-0">
              <span className="block text-[13px] leading-[18px]">
                {/* retailer-style titles can be very long: three lines, the full name on hover */}
                <Link to={`/catalogue/products/${r.product_id}`} title={r.name} className="line-clamp-3 font-medium break-words text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                  {r.name}
                </Link>
                {r.is_demo ? <DemoBadge className="mt-0.5" /> : null}
              </span>
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] leading-[18px] text-ink-3">
                {[r.pack, r.subcategory_name ?? r.category_name, phone ? null : r.code].filter(Boolean).join(' · ')}
                {STATUS_LABEL[r.status] ? <Badge tone="outline">{STATUS_LABEL[r.status]}</Badge> : null}
              </span>
              {listedColumn ? null : <ListedAt row={r} />}
              {phone && r.change_30d_pct !== null ? (
                <span className="flex items-center gap-1 text-[11.5px] leading-[18px] text-ink-3">
                  30 days <ChangeCell pct={r.change_30d_pct} className="text-[11.5px]" />
                </span>
              ) : null}
            </span>
          </span>
        ),
      },
      {
        key: 'listings',
        header: 'Listed at',
        sortKey: 'listings',
        nowrap: false,
        headerTitle: 'Retailers and markets with an active listing of the product in this scope',
        cell: (r) => <ListedAt row={r} stacked />,
        className: 'align-top',
        minWidth: 1320,
      },
      {
        key: 'price',
        header: data.currency_mode === 'converted' ? `Current price (${data.target_currency})` : 'Current price',
        sortKey: singleCurrency ? 'price' : undefined,
        nowrap: false,
        className: 'align-top',
        headerTitle: 'Lowest to highest current selling price of the standard pack at fresh listings, with the average — one line per currency',
        cell: (r) =>
          r.prices.length === 0 ? (
            <span className="text-[12.5px] text-ink-4">{r.listings === 0 ? 'Not listed' : 'No current price'}</span>
          ) : (
            <span className="flex flex-col">
              {r.prices.slice(0, LINES).map((p) => (
                <span key={p.currency} className={cn('flex items-baseline gap-x-1.5 text-[12.5px] leading-[18px]', phone ? 'flex-col' : 'whitespace-nowrap')}>
                  <RangeText min={p.min} max={p.max} currency={p.currency} />
                  {p.listings > 1 ? <span className="num whitespace-nowrap text-[11.5px] text-ink-3">avg {fmtPrice(p.avg, p.currency)}</span> : null}
                </span>
              ))}
              <More count={r.prices.length - LINES} noun={['currency', 'currencies']}>
                {r.prices.slice(LINES).map((p) => (
                  <span key={p.currency} className="num">
                    {p.currency} {p.min === p.max ? fmtPrice(p.min, p.currency) : `${fmtPrice(p.min, p.currency)} – ${fmtPrice(p.max, p.currency)}`} · avg {fmtPrice(p.avg, p.currency)}
                  </span>
                ))}
              </More>
            </span>
          ),
      },
      {
        key: 'unit',
        header: 'Unit price',
        sortKey: singleCurrency ? 'unit' : undefined,
        align: 'right',
        nowrap: false,
        className: 'align-top',
        headerTitle: 'Average current price per 100 ml / 100 g / unit',
        cell: (r) => {
          const lines = r.prices.filter((p) => p.avg_unit_price !== null).slice(0, LINES);
          if (lines.length === 0) return <span className="text-ink-4">—</span>;
          return (
            <span className="flex flex-col items-end">
              {lines.map((p) => (
                <span key={p.currency} className="num text-[12.5px] leading-[18px] whitespace-nowrap text-ink-2">
                  {fmtUnitPrice(p.avg_unit_price, p.currency)}
                  {r.unit_basis ? <span className="ml-1 text-[11px] text-ink-3">{r.unit_basis.replace('per ', '/')}</span> : null}
                </span>
              ))}
            </span>
          );
        },
        minWidth: 760,
      },
      {
        key: 'cheapest',
        header: 'Cheapest retailer',
        nowrap: false,
        className: 'align-top',
        headerTitle: 'Retailer with the lowest fresh shelf price in each market',
        cell: (r) => {
          // Converted prices are comparable across markets: the cheapest market comes first. Otherwise the lines
          // follow the currency order of the price column, so both columns read line by line.
          const rank = (currency: string) => {
            const i = r.prices.findIndex((p) => p.currency === currency);
            return i < 0 ? r.prices.length : i;
          };
          const cheapest = [...r.cheapest].sort((a, b) => (converted ? a.price - b.price : rank(a.currency) - rank(b.currency)) || a.market_name.localeCompare(b.market_name));
          return cheapest.length === 0 ? (
            <span className="text-ink-4">—</span>
          ) : (
            <span className="flex max-w-[15.5rem] flex-col">
              {cheapest.slice(0, LINES).map((c) => (
                <span key={c.market_id} className="flex items-baseline gap-x-1.5 text-[12.5px] leading-[18px]">
                  <span className="shrink-0 text-[11px] text-ink-3">{c.market_code}</span>
                  <Link
                    to={`/monitor${toQueryString({ retailer_id: c.retailer_id, brand_id: brand.id })}`}
                    className="min-w-0 truncate text-ink hover:underline"
                    title={`${c.retailer_name} — open in the Live Price Monitor, filtered to ${brand.name}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {c.retailer_name}
                  </Link>
                  <span className="num shrink-0 font-medium text-ink">{fmtPrice(c.price, c.currency)}</span>
                  {c.compared === 1 ? (
                    <Tip content="The only retailer of this market with a fresh price for the product — nothing to compare with.">
                      <span className="shrink-0 text-[11px] text-ink-3">only price</span>
                    </Tip>
                  ) : (
                    <span className="shrink-0 text-[11px] text-ink-3" title={c.tied > 0 ? `Lowest of ${c.compared} retailers, shared with ${c.tied} other${c.tied === 1 ? '' : 's'}` : `Lowest of ${c.compared} retailers`}>
                      {c.tied > 0 ? 'tied' : `of ${c.compared}`}
                    </span>
                  )}
                </span>
              ))}
              <More count={cheapest.length - LINES} noun={['market', 'markets']}>
                {cheapest.slice(LINES).map((c) => (
                  <span key={c.market_id} className="num">
                    {c.market_code} · {c.retailer_name} · {c.currency} {fmtPrice(c.price, c.currency)}
                  </span>
                ))}
              </More>
            </span>
          );
        },
        minWidth: 1000,
      },
      {
        key: 'promo',
        header: anyTags ? 'Promotion & tags' : 'On promotion',
        sortKey: 'promo',
        nowrap: false,
        className: 'align-top',
        headerTitle: 'Fresh listings currently on promotion with the deepest current discount, and the deal tags and badges retailers show on the product now',
        cell: (r) => (
          <span className="flex flex-col items-start gap-1">
            {r.promo_listings === 0 ? (
              <span className="text-[12.5px] whitespace-nowrap text-ink-4">None now</span>
            ) : (
              <Link
                to={`/promotions${toQueryString({ ...scope, currency: undefined, brand_id: brand.id, product_id: r.product_id })}`}
                className="group/promo inline-flex flex-col"
                title={`Open the promotions of this product${r.deepest_discount_retailer ? ` — deepest discount at ${r.deepest_discount_retailer}` : ''}`}
                onClick={(e) => e.stopPropagation()}
              >
                <span className="inline-flex">
                  <Badge tone="warn" icon={Tag}>
                    {fmtNumber(r.promo_listings)} listing{r.promo_listings === 1 ? '' : 's'}
                  </Badge>
                </span>
                {r.deepest_discount_pct !== null ? (
                  <span className="num mt-0.5 text-[11.5px] leading-4 whitespace-nowrap text-ink-3 group-hover/promo:underline">up to {fmtPct(r.deepest_discount_pct, 0)} off</span>
                ) : null}
              </Link>
            )}
            {r.tags?.length ? <DealTagChips tags={r.tags} max={2} className="max-w-[11rem]" /> : null}
          </span>
        ),
        minWidth: 900,
      },
      {
        key: 'change',
        header: '30-day change',
        sortKey: 'change',
        className: 'align-top',
        headerTitle: 'Average change of the product’s listing prices over the last 30 days (each listing against its own first price)',
        cell: (r) => <TrendSpark points={r.trend} change={r.change_30d_pct} ownership={brand.ownership} width={64} />,
        minWidth: 620,
      },
      {
        key: 'observed',
        header: 'Last observed',
        sortKey: 'observed',
        className: 'align-top',
        cell: (r) => <LastObserved iso={r.last_observed_at} className="text-[12.5px] text-ink-2" />,
        minWidth: 1480,
      },
    ],
    [phone, listedColumn, converted, anyTags, brand.id, brand.name, brand.ownership, data.currency_mode, data.target_currency, singleCurrency, scope],
  );
  const visible = useMemo(() => columns.filter((c) => !c.minWidth || width >= c.minWidth), [columns, width]);
  const notListed = data.range.filter((r) => r.listings === 0).length;

  return (
    <div ref={ref} className="min-w-0">
      {data.currency_mode === 'native' && currencies.length > 2 ? (
        <Notice
          tone="info"
          icon={ArrowLeftRight}
          className="mb-3"
          action={
            <Button size="sm" onClick={onConvert}>
              Convert to {reportingCurrency}
            </Button>
          }
        >
          This range is priced in {currencies.length} currencies, shown side by side and never merged. Narrow the page to one market, or pick a comparison currency, to rank the products by price.
        </Notice>
      ) : null}
      <Card>
        <CardHeader
          title="Product range"
          subtitle={
            <>
              {query.trim() ? `${fmtNumber(rows.length)} of ${fmtNumber(data.range.length)} products match` : `${fmtNumber(data.range.length)} product${data.range.length === 1 ? '' : 's'}`}
              {notListed > 0 ? ` · ${fmtNumber(notListed)} not listed in this scope` : ''}. Current prices are those of the standard pack at fresh listings; stale and never-observed listings are counted, not priced. Select a
              product to open it.
            </>
          }
          actions={data.range.length > 1 ? <SearchInput value={query} onChange={onQuery} placeholder="Search products…" className="w-52" /> : undefined}
        />
        <DataTable
          columns={visible}
          rows={rows}
          rowKey={(r) => r.product_id}
          sort={sort}
          onSort={onSort}
          onRowClick={(r) => navigate(`/catalogue/products/${r.product_id}`)}
          dense
          empty={
            query.trim() && data.range.length > 0 ? (
              <EmptyState
                icon={PackageSearch}
                title="No product matches the search"
                description={`None of the ${fmtNumber(data.range.length)} products of this range contains “${query.trim()}” in its name, code, pack or category.`}
                action={
                  <Button size="sm" onClick={() => onQuery('')}>
                    Clear the search
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={PackageSearch}
                title="No product in this scope"
                description="The brand has no product in the selected categories. Remove the category filter to see its whole range."
              />
            )
          }
        />
      </Card>
    </div>
  );
}
