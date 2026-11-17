/**
 * Cross-market comparison. Prices from different markets are never compared raw: every figure is converted
 * to one comparison currency (rate, timestamp and source shown) and pack sizes are normalised to unit prices.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Globe, Info } from 'lucide-react';
import { BarList, IndexScale } from '@/components/charts/charts.tsx';
import { ChartFrame } from '@/components/charts/kit.tsx';
import { DemoBadge, DemoNotice, FxNote, MarketTime, OwnershipBadge, PriceCell } from '@/components/domain/domain.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { FilterBar, MultiSelect, ProductPicker, type Option } from '@/components/ui/filters.tsx';
import { Badge, Card, CardHeader, cn, EmptyState, ErrorState, LoadingBlock, Notice, Segmented, Select, StatTile, Tip } from '@/components/ui/primitives.tsx';
import { DASH, fmtDate, fmtDateTime, fmtDateTimeShort, fmtMoney, fmtNumber, fmtPct, fmtPrice, fmtUnitPrice, plural } from '@/lib/format.ts';
import { diffDays, useApiQuery, useDates, useReference } from '@/lib/hooks.ts';
import type { Conversion, CrossMarketGroupRow, CrossMarketProductResult, CrossMarketRow, DemoNote } from '@shared/api/analytics.ts';
import { useCardWidth } from './layout.ts';
import type { MarketParams, MarketUrl } from './MarketsPage.tsx';

type ProductResponse = { mode: 'product' } & CrossMarketProductResult;
interface GroupResponse {
  mode: 'group';
  currency: string;
  rows: CrossMarketGroupRow[];
  missing_rates: string[];
  notes: string[];
  demo: DemoNote;
}
type CrossResponse = ProductResponse | GroupResponse;

const MODES = [
  { value: 'product', label: 'Product' },
  { value: 'category', label: 'Category' },
  { value: 'brand', label: 'Brand' },
] as const;
type Mode = (typeof MODES)[number]['value'];

const isRefetching = (q: { isFetching: boolean; isPending: boolean }) => q.isFetching && !q.isPending;

function uniqueConversions(rows: Array<{ conversion: Conversion | null }>): Conversion[] {
  const seen = new Map<string, Conversion>();
  for (const r of rows) if (r.conversion && !seen.has(r.conversion.from)) seen.set(r.conversion.from, r.conversion);
  return [...seen.values()];
}

const rateText = (conversion: Conversion) => `1 ${conversion.from} = ${conversion.rate >= 1 ? conversion.rate.toFixed(4) : conversion.rate.toPrecision(4)} ${conversion.to}`;

function RateCell({ conversion }: { conversion: Conversion | null }) {
  if (!conversion) return <span className="text-crit-ink">No rate available</span>;
  if (conversion.from === conversion.to) return <span className="text-ink-3">Same currency</span>;
  return (
    <Tip content={`Rate as of ${fmtDateTime(conversion.as_of, 'UTC')} UTC · source: ${conversion.sources.join(', ') || 'n/a'}${conversion.is_demo ? ' · illustrative demo rate, not a market rate' : ''}`}>
      <span className="flex flex-col">
        <span className="num text-ink-2">{rateText(conversion)}</span>
        <span className="flex items-center gap-1.5 text-[11.5px] leading-4 text-ink-3">
          <span className="num">{fmtDateTimeShort(conversion.as_of, 'UTC')} UTC</span>
          {conversion.is_demo ? <DemoBadge /> : <span className="max-w-28 truncate">{conversion.sources.join(', ')}</span>}
        </span>
      </span>
    </Tip>
  );
}

/** The rate spelled out in full (no tooltip needed) for the stacked phone layout. */
function RateLine({ conversion }: { conversion: Conversion | null }) {
  if (!conversion) return <span className="text-crit-ink">No rate available</span>;
  if (conversion.from === conversion.to) return <>Same currency</>;
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span>{rateText(conversion)}</span>
      <span className="inline-flex flex-wrap items-center justify-end gap-x-1.5 text-ink-3">
        <span>as of {fmtDateTimeShort(conversion.as_of, 'UTC')} UTC</span>
        {conversion.is_demo ? <DemoBadge /> : <span>{conversion.sources.join(', ') || 'source n/a'}</span>}
      </span>
    </span>
  );
}

/** Label / value pairs of one stacked phone entry. */
function Facts({ items }: { items: Array<[string, ReactNode] | null> }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px] leading-4">
      {items
        .filter((item): item is [string, ReactNode] => item !== null)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-3">{label}</dt>
            <dd className="num m-0 text-right text-ink-2">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Market name with its code and currency; the demo marker sits on the second line so the cell never wraps. */
function MarketName({ name, code, currency, base, demo }: { name: string; code: string; currency: string; base?: boolean; demo: boolean }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="font-medium text-ink">{name}</span>
        {base ? <Badge tone="accent">Base</Badge> : null}
      </span>
      <span className="flex items-center gap-1.5 text-[11.5px] leading-4 whitespace-nowrap text-ink-3">
        {code} · {currency}
        {demo ? <DemoBadge /> : null}
      </span>
    </span>
  );
}

const fix1 = (value: number) => value.toFixed(1);

function IndexCell({ value, missing, scale = true }: { value: number | null; missing?: string; scale?: boolean }) {
  if (value === null) {
    return missing ? (
      <Tip content={missing}>
        <span className="text-ink-4">{DASH}</span>
      </Tip>
    ) : (
      <span className="text-ink-4">{DASH}</span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {scale ? <IndexScale value={value} width={64} /> : null}
      <span className="num inline-block w-10 text-right font-medium text-ink">{fix1(value)}</span>
    </span>
  );
}

function Notes({ notes, plain }: { notes: string[]; plain?: boolean }) {
  if (!notes.length) return null;
  if (notes.length === 1) return <p className={plain ? undefined : 'text-[12px] leading-5 text-ink-3'}>{notes[0]}</p>;
  return (
    <ul className={plain ? 'flex list-disc flex-col gap-1 pl-4' : 'flex list-disc flex-col gap-1 pl-4 text-[12px] leading-5 text-ink-3'}>
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// One product across markets
// ---------------------------------------------------------------------------------------------
function ProductComparison({ data, refetching }: { data: ProductResponse; refetching: boolean }) {
  const { maps } = useReference();
  // By the width of the table's own card: all eight columns need about 1030px; the exchange-rate column
  // goes first (every rate is also stated under the table), then the last-observed column and the index
  // graphic; in a narrower card each market becomes a stacked entry that spells everything out.
  const [cardRef, cardWidth] = useCardWidth();
  const layout = cardWidth >= 1045 ? 'full' : cardWidth >= 865 ? 'no-rate' : cardWidth >= 720 ? 'core' : 'list';
  const [sort, setSort] = useState('-converted');
  const priced = data.rows.filter((r) => r.converted?.avg !== null && r.converted?.avg !== undefined);
  const base = data.rows.find((r) => r.market_id === data.base_market_id) ?? null;
  const ranked = [...priced].sort((a, b) => b.converted!.avg! - a.converted!.avg!);
  const highest = ranked[0] ?? null;
  const lowest = ranked[ranked.length - 1] ?? null;
  const spread = highest && lowest && lowest.converted!.avg! > 0 ? ((highest.converted!.avg! - lowest.converted!.avg!) / lowest.converted!.avg!) * 100 : null;
  const periodDays = diffDays(data.period.from, data.period.to) + 1;

  const sorted = useMemo(() => {
    const desc = sort.startsWith('-');
    const key = desc ? sort.slice(1) : sort;
    const pick = (r: CrossMarketRow): number | string | null =>
      key === 'market' ? r.market_name.toLowerCase() : key === 'unit' ? (r.converted?.unit_avg ?? null) : key === 'index' ? r.index : key === 'period' ? r.period_avg_converted : (r.converted?.avg ?? null);
    return [...data.rows].sort((a, b) => {
      const x = pick(a);
      const y = pick(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp = typeof x === 'string' ? x.localeCompare(String(y)) : x - Number(y);
      return desc ? -cmp : cmp;
    });
  }, [data.rows, sort]);

  const columns: Array<Column<CrossMarketRow>> = [
    {
      key: 'market',
      header: 'Market',
      sortKey: 'market',
      nowrap: true,
      cell: (r) => <MarketName name={r.market_name} code={r.market_code} currency={r.currency_code} base={r.market_id === data.base_market_id} demo={r.is_demo} />,
    },
    {
      key: 'native',
      header: 'Local price',
      align: 'right',
      headerTitle: 'Average of the latest fresh selling prices across retailers, in the market currency (lowest – highest below)',
      cell: (r) =>
        r.native ? (
          <span className="flex flex-col items-end">
            <PriceCell price={r.native.avg} currency={r.currency_code} />
            <span className="num text-[11.5px] leading-4 text-ink-3">
              {r.native.min === r.native.max ? 'single price' : `${fmtPrice(r.native.min, r.currency_code)} – ${fmtPrice(r.native.max, r.currency_code)}`}
            </span>
          </span>
        ) : (
          <span className="text-[12px] text-ink-3">No fresh price</span>
        ),
    },
    {
      key: 'converted',
      header: `In ${data.currency}`,
      align: 'right',
      sortKey: 'converted',
      headerTitle: `Average latest price converted to ${data.currency}; below it the average daily price ${fmtDate(data.period.from)} – ${fmtDate(data.period.to)}`,
      cell: (r) =>
        r.converted?.avg === null || r.converted?.avg === undefined ? (
          <span className="text-ink-4">{DASH}</span>
        ) : (
          <span className="flex flex-col items-end">
            <span className="font-semibold text-ink">{fmtPrice(r.converted.avg, data.currency)}</span>
            {r.period_avg_converted !== null ? <span className="text-[11.5px] leading-4 text-ink-3">{periodDays}-day avg {fmtPrice(r.period_avg_converted, data.currency)}</span> : null}
          </span>
        ),
    },
    {
      key: 'unit',
      header: data.product.unit_basis ? data.product.unit_basis.replace('per ', 'Per ') : 'Unit price',
      align: 'right',
      sortKey: 'unit',
      headerTitle: `Unit price in ${data.currency} — pack sizes normalised`,
      cell: (r) => (r.converted?.unit_avg === null || r.converted?.unit_avg === undefined ? <span className="text-ink-4">{DASH}</span> : fmtUnitPrice(r.converted.unit_avg, data.currency)),
    },
    {
      key: 'index',
      header: layout === 'core' ? 'Index' : 'Index vs base',
      align: 'right',
      sortKey: 'index',
      headerTitle: base ? `Converted average price relative to ${base.market_name} (= 100)` : 'Converted average price relative to the base market (= 100)',
      cell: (r) => <IndexCell value={r.index} scale={layout !== 'core'} />,
    },
    {
      key: 'listings',
      header: 'Listings',
      align: 'right',
      headerTitle: 'Retailers listing the product, and how many of its listings are on promotion now',
      cell: (r) => (
        <span className="flex flex-col items-end">
          <span>{plural(r.retailers, 'retailer')}</span>
          <span className="text-[11.5px] leading-4 text-ink-3">
            {fmtNumber(r.on_promo)} of {fmtNumber(r.listings)} on promotion
          </span>
        </span>
      ),
    },
    {
      key: 'observed',
      header: 'Last observed',
      headerTitle: 'Hover for the exact market-local and UTC time',
      cell: (r) => <MarketTime iso={r.last_observed_at} timeZone={maps.market.get(r.market_id)?.timezone} relative />,
    },
    { key: 'rate', header: 'Exchange rate', nowrap: true, cell: (r) => <RateCell conversion={r.conversion} /> },
  ];
  const shown = columns.filter((c) => (c.key === 'rate' ? layout === 'full' : c.key === 'observed' ? layout === 'full' || layout === 'no-rate' : true));

  return (
    <div className="flex flex-col gap-4">
      <DemoNotice demo={data.demo} />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/catalogue/products/${data.product.id}`} className="text-[15px] leading-6 font-semibold text-ink hover:underline">
                {data.product.name}
              </Link>
              <OwnershipBadge ownership={data.product.ownership === 'own' ? 'own' : data.product.ownership === 'competitor' ? 'competitor' : null} />
              {data.product.is_demo ? <DemoBadge /> : null}
            </div>
            <p className="mt-0.5 text-[12px] leading-4 text-ink-3">
              {[data.product.brand_name, data.product.pack, <span key="code" className="mono">{data.product.code}</span>].map((part, i) => (
                <span key={i}>
                  {i ? ' · ' : ''}
                  {part}
                </span>
              ))}
            </p>
          </div>
          <p className="text-[12.5px] leading-5 text-ink-3">
            Compared in <span className="font-semibold text-ink">{data.currency}</span>
            {data.product.unit_basis ? <> · unit prices {data.product.unit_basis}</> : null} · pack variants excluded
          </p>
        </div>
      </Card>

      {priced.length === 0 ? (
        <Card>
          <EmptyState
            icon={Globe}
            title="No market has a fresh price for this product"
            description={
              data.rows.length
                ? 'The product is listed, but no listing has a recent observation or no exchange rate is available. Check the Live Price Monitor and the exchange rates.'
                : 'The product has no active retailer listing in any market yet.'
            }
          />
        </Card>
      ) : (
        <>
          <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Markets compared"
              value={
                <>
                  {fmtNumber(priced.length)}
                  <span className="ml-1 text-[13px] font-medium text-ink-3">of {fmtNumber(data.rows.length)}</span>
                </>
              }
              detail="Markets where the product is listed with a fresh, convertible price"
            />
            <StatTile label="Lowest average price" value={fmtMoney(lowest!.converted!.avg, data.currency)} detail={lowest!.market_name} />
            <StatTile label="Highest average price" value={fmtMoney(highest!.converted!.avg, data.currency)} detail={highest!.market_name} />
            <StatTile
              label="Spread, highest vs lowest"
              value={spread === null ? DASH : fmtPct(spread, 1)}
              detail={base ? `Index base: ${base.market_name} = 100` : 'No base market available'}
            />
          </div>

          <ChartFrame
            title={`Average price by market, in ${data.currency}`}
            subtitle="Latest fresh selling price, averaged across retailers and converted"
            refetching={refetching}
            table={{
              columns: ['Market', 'Local currency', 'Local average', `Average in ${data.currency}`, 'Index vs base'],
              numeric: [2, 3, 4],
              rows: ranked.map((r) => [r.market_name, r.currency_code, r.native ? fmtPrice(r.native.avg, r.currency_code) : null, fmtPrice(r.converted!.avg, data.currency), r.index]),
            }}
          >
            <BarList
              data={ranked.map((r) => ({
                key: String(r.market_id),
                label: r.market_name,
                sublabel: r.index === null ? undefined : `index ${fix1(r.index)}`,
                value: r.converted!.avg,
                display: fmtMoney(r.converted!.avg, data.currency),
              }))}
            />
          </ChartFrame>
        </>
      )}

      <div ref={cardRef} className="min-w-0">
        <Card>
          <CardHeader title="By market" subtitle={`Latest prices per market, normalised to ${data.currency} and to unit price`} />
          {layout === 'list' ? (
            <>
              <label className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px] text-ink-3">
                <span className="shrink-0 whitespace-nowrap">Sort by</span>
                <Select className="min-w-0 flex-1" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort markets by">
                  <option value="-converted">Highest price in {data.currency}</option>
                  <option value="converted">Lowest price in {data.currency}</option>
                  <option value="-unit">Highest unit price</option>
                  <option value="-period">Highest {periodDays}-day average</option>
                  <option value="market">Market name</option>
                </Select>
              </label>
              {sorted.length === 0 ? (
                <EmptyState title="The product is not listed in any market" />
              ) : (
                <ul className={cn('m-0 list-none divide-y divide-line p-0 transition-opacity', refetching && 'opacity-60')}>
                  {sorted.map((r) => (
                    <li key={r.market_id} className="flex flex-col gap-2 px-4 py-3">
                      <div className="flex items-start justify-between gap-3 text-[13.5px] leading-5">
                        <MarketName name={r.market_name} code={r.market_code} currency={r.currency_code} base={r.market_id === data.base_market_id} demo={r.is_demo} />
                        <span className="flex shrink-0 flex-col items-end">
                          {r.converted?.avg === null || r.converted?.avg === undefined ? (
                            <span className="text-[12px] text-ink-3">{r.native ? 'No exchange rate' : 'No fresh price'}</span>
                          ) : (
                            <span className="num font-semibold text-ink">{fmtMoney(r.converted.avg, data.currency)}</span>
                          )}
                          {r.index === null ? null : <span className="num text-[11.5px] leading-4 text-ink-3">index {fix1(r.index)}</span>}
                        </span>
                      </div>
                      <Facts
                        items={[
                          r.native
                            ? [
                                'Local price',
                                `${fmtMoney(r.native.avg, r.currency_code)}${r.native.min === r.native.max ? '' : ` (${fmtPrice(r.native.min, r.currency_code)} – ${fmtPrice(r.native.max, r.currency_code)})`}`,
                              ]
                            : null,
                          r.period_avg_converted === null ? null : [`${periodDays}-day average`, fmtMoney(r.period_avg_converted, data.currency)],
                          r.converted?.unit_avg === null || r.converted?.unit_avg === undefined
                            ? null
                            : [data.product.unit_basis ? data.product.unit_basis.replace('per ', 'Per ') : 'Unit price', `${data.currency} ${fmtUnitPrice(r.converted.unit_avg, data.currency)}`],
                          ['Listings', `${plural(r.retailers, 'retailer')} · ${fmtNumber(r.on_promo)} of ${fmtNumber(r.listings)} on promotion`],
                          ['Last observed', <MarketTime iso={r.last_observed_at} timeZone={maps.market.get(r.market_id)?.timezone} short />],
                          ['Exchange rate', <RateLine conversion={r.conversion} />],
                        ]}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <DataTable columns={shown} rows={sorted} rowKey={(r) => r.market_id} sort={sort} onSort={setSort} refetching={refetching} empty={<EmptyState title="The product is not listed in any market" />} />
          )}
          <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
            <FxNote conversions={uniqueConversions(data.rows)} missing={data.missing_rates} target={data.currency} />
            <Notes notes={data.notes} />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// A category or brand across markets
// ---------------------------------------------------------------------------------------------
function GroupComparison({ data, refetching, scopeLabel }: { data: GroupResponse; refetching: boolean; scopeLabel: string }) {
  // the exchange-rate column needs a card of about 835px (the rates are also stated under the table);
  // in a card too narrow for the other five columns each market / unit basis becomes a stacked entry
  const [cardRef, cardWidth] = useCardWidth();
  const layout = cardWidth >= 845 ? 'full' : cardWidth >= 670 ? 'no-rate' : 'list';
  const sideText = (s: CrossMarketGroupRow['own']) =>
    s ? `${data.currency} ${fmtUnitPrice(s.unit_avg, data.currency)} · ${plural(s.products, 'product')}, ${plural(s.listings, 'listing')}` : 'Not listed';
  const empty = (
    <EmptyState icon={Globe} title="No fresh, convertible price in this selection" description="No listing in this scope has a recent observation with known pack content, or no exchange rate is available." />
  );
  const side = (s: CrossMarketGroupRow['own']) =>
    s ? (
      <span className="flex flex-col items-end">
        <span className="font-medium text-ink">{fmtUnitPrice(s.unit_avg, data.currency)}</span>
        <span className="text-[11.5px] leading-4 text-ink-3">
          {fmtNumber(s.products)} {s.products === 1 ? 'product' : 'products'} · {fmtNumber(s.listings)} {s.listings === 1 ? 'listing' : 'listings'}
        </span>
      </span>
    ) : (
      <span className="text-[12px] text-ink-3">Not listed</span>
    );
  const columns: Array<Column<CrossMarketGroupRow>> = [
    {
      key: 'market',
      header: 'Market',
      cell: (r) => (
        <span className="flex min-w-28">
          <MarketName name={r.market_name} code={r.market_code} currency={r.currency_code} demo={r.is_demo} />
        </span>
      ),
    },
    { key: 'basis', header: 'Unit basis', cell: (r) => <Badge tone="outline">{r.basis}</Badge> },
    { key: 'own', header: `Own brands, ${data.currency}`, align: 'right', headerTitle: 'Average converted unit price of own-brand listings', cell: (r) => side(r.own) },
    { key: 'competitor', header: `Competitors, ${data.currency}`, align: 'right', headerTitle: 'Average converted unit price of competitor listings', cell: (r) => side(r.competitor) },
    {
      key: 'index',
      header: 'Own ÷ competitor',
      align: 'right',
      headerTitle: 'Own average unit price as an index of the competitor average (100 = same level). Same unit basis only.',
      cell: (r) => <IndexCell value={r.index} missing="An index needs both own-brand and competitor listings on the same unit basis in this market." />,
    },
    { key: 'rate', header: 'Exchange rate', nowrap: true, cell: (r) => <RateCell conversion={r.conversion} /> },
  ];
  const shown = layout === 'full' ? columns : columns.filter((c) => c.key !== 'rate');
  return (
    <div className="flex flex-col gap-4">
      <DemoNotice demo={data.demo} />
      {data.notes.length ? (
        <Notice tone="info" icon={Info}>
          <Notes notes={data.notes} plain />
        </Notice>
      ) : null}
      <div ref={cardRef} className="min-w-0">
        <Card>
          <CardHeader title={`${scopeLabel} across markets`} subtitle={`Average unit prices of fresh listings, converted to ${data.currency}; one row per market and unit basis`} />
          {layout !== 'list' ? (
            <DataTable columns={shown} rows={data.rows} rowKey={(r) => `${r.market_id}|${r.basis}`} refetching={refetching} empty={empty} />
          ) : data.rows.length === 0 ? (
            empty
          ) : (
            <ul className={cn('m-0 list-none divide-y divide-line p-0 transition-opacity', refetching && 'opacity-60')}>
              {data.rows.map((r) => (
                <li key={`${r.market_id}|${r.basis}`} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-3 text-[13.5px] leading-5">
                    <MarketName name={r.market_name} code={r.market_code} currency={r.currency_code} demo={r.is_demo} />
                    <Badge tone="outline">{r.basis}</Badge>
                  </div>
                  <Facts
                    items={[
                      ['Own brands', sideText(r.own)],
                      ['Competitors', sideText(r.competitor)],
                      ['Own ÷ competitor', r.index === null ? 'Needs both sides on this unit basis' : <span className="font-medium text-ink">index {fix1(r.index)}</span>],
                      ['Exchange rate', <RateLine conversion={r.conversion} />],
                    ]}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
            <FxNote conversions={uniqueConversions(data.rows)} missing={data.missing_rates} target={data.currency} />
            <p className="text-[12px] leading-5 text-ink-3">For like-for-like gaps between mapped products, use Competitor Intelligence.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------
export function CrossMarket({ url }: { url: MarketUrl }) {
  const { state, set } = url;
  const dates = useDates();
  const { ref } = useReference();
  const mode: Mode = MODES.some((m) => m.value === state.mode) ? (state.mode as Mode) : 'product';
  const reporting = dates.data?.reporting_currency;
  const currency = state.currency ?? reporting;
  const days = ['7', '30', '90'].includes(state.days ?? '') ? Number(state.days) : 30;

  const selection = mode === 'product' ? state.product_id : mode === 'category' ? state.category_id : state.brand_id;
  const query: Record<string, string | number | undefined> | undefined =
    selection && currency
      ? mode === 'product'
        ? { product_id: selection, currency, days, base_market_id: state.base_market_id }
        : mode === 'category'
          ? { category_id: selection, currency }
          : { brand_id: selection, currency }
      : undefined;
  const q = useApiQuery<CrossResponse>(['market-intel', 'cross-market'], '/market-intel/cross-market', query, { enabled: !!query });

  const categoryOptions = useMemo<Option[]>(() => {
    const out: Option[] = [];
    for (const parent of (ref?.categories ?? []).filter((c) => c.parent_id === null)) {
      out.push({ value: String(parent.id), label: `All ${parent.name}`, group: parent.name });
      for (const child of (ref?.categories ?? []).filter((c) => c.parent_id === parent.id)) out.push({ value: String(child.id), label: child.name, group: parent.name });
    }
    return out;
  }, [ref]);
  const brandOptions = useMemo<Option[]>(
    () =>
      (ref?.brands ?? [])
        .filter((b) => b.is_active)
        .map((b) => ({ value: String(b.id), label: b.name, group: b.ownership === 'own' ? 'Own brands' : 'Competitors' }))
        .sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : a.group === 'Own brands' ? -1 : 1)),
    [ref],
  );
  const scopeLabel =
    mode === 'category'
      ? (categoryOptions.find((o) => o.value === state.category_id)?.label.replace(/^All /, '') ?? 'the category')
      : (brandOptions.find((o) => o.value === state.brand_id)?.label ?? 'the brand');

  const data = q.data;
  const baseMarkets = data?.mode === 'product' ? data.rows.filter((r) => r.converted?.avg) : [];
  const patch = (next: Partial<Record<keyof MarketParams, string | null>>) => set(next);

  return (
    <>
      <FilterBar>
        <Segmented label="Compare by" value={mode} onChange={(next) => patch({ mode: next === 'product' ? null : next, base_market_id: null })} options={MODES.map((m) => ({ ...m }))} />
        {mode === 'product' ? (
          <ProductPicker multiple={false} value={state.product_id ? [state.product_id] : []} onChange={(next) => patch({ product_id: next[0] ?? null, base_market_id: null })} />
        ) : mode === 'category' ? (
          <MultiSelect single label="Category" options={categoryOptions} value={state.category_id ? [state.category_id] : []} onChange={(next) => patch({ category_id: next[0] ?? null })} searchable={false} />
        ) : (
          <MultiSelect single label="Brand" options={brandOptions} value={state.brand_id ? [state.brand_id] : []} onChange={(next) => patch({ brand_id: next[0] ?? null })} />
        )}
        <label className="flex shrink-0 items-center gap-2 text-[13px] whitespace-nowrap text-ink-3">
          Compare in
          <Select
            className="w-auto"
            value={currency ?? ''}
            onChange={(e) => patch({ currency: e.target.value === reporting ? null : e.target.value })}
            aria-label="Comparison currency"
          >
            {(ref?.currencies ?? []).map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
                {c.code === reporting ? ' (reporting currency)' : ''}
              </option>
            ))}
          </Select>
        </label>
        {mode === 'product' && baseMarkets.length > 0 ? (
          <label className="flex shrink-0 items-center gap-2 text-[13px] whitespace-nowrap text-ink-3">
            Base market
            <Select className="w-auto" value={state.base_market_id ?? ''} onChange={(e) => patch({ base_market_id: e.target.value || null })} aria-label="Base market for the index">
              <option value="">Automatic{data?.mode === 'product' && data.base_market_id && !state.base_market_id ? ` (${baseMarkets.find((r) => r.market_id === data.base_market_id)?.market_name ?? ''})` : ''}</option>
              {baseMarkets.map((r) => (
                <option key={r.market_id} value={r.market_id}>
                  {r.market_name}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        {mode === 'product' ? (
          <Segmented
            label="Period of the average shown under the converted price"
            value={String(days)}
            onChange={(next) => patch({ days: next === '30' ? null : next })}
            options={[
              { value: '7', label: '7-day avg' },
              { value: '30', label: '30-day avg' },
              { value: '90', label: '90-day avg' },
            ]}
          />
        ) : null}
      </FilterBar>

      {!selection ? (
        <Card>
          <EmptyState
            icon={Globe}
            title={mode === 'product' ? 'Choose a product to compare across markets' : mode === 'category' ? 'Choose a category to compare across markets' : 'Choose a brand to compare across markets'}
            description="Prices are converted to one currency with a stated exchange rate, and pack sizes are normalised to unit prices, so markets can be compared fairly."
          />
        </Card>
      ) : q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        </Card>
      ) : !data ? (
        <LoadingBlock className="min-h-64" label="Comparing markets…" />
      ) : data.mode === 'product' ? (
        <ProductComparison data={data} refetching={isRefetching(q)} />
      ) : (
        <GroupComparison data={data} refetching={isRefetching(q)} scopeLabel={scopeLabel} />
      )}
    </>
  );
}
