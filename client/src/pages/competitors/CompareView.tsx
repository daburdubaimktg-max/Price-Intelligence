/** Competitor Intelligence — one own product against its mapped competitor products. */
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { GitCompareArrows, History, Link2, Tag } from 'lucide-react';
import { DASH, fmtDate, fmtNumber, fmtPct, fmtPrice, fmtUnitPrice } from '@/lib/format.ts';
import { useApiQuery, useIsNarrow } from '@/lib/hooks.ts';
import type { Query } from '@/lib/api.ts';
import { Badge, Card, CardHeader, cn, EmptyState, ErrorState, LoadingBlock, Notice, Tip } from '@/components/ui/primitives.tsx';
import { ChartEmpty, ChartFrame, MAX_SERIES, OWN_COLOR } from '@/components/charts/kit.tsx';
import { seriesTable, TimeSeriesChart, useSeriesChart, type Series } from '@/components/charts/charts.tsx';
import { AvailabilityBadge, DataClassBadge, DemoBadge, DemoNotice, FreshnessCell, FxNote, GapCell, OwnershipDot, PriceCell } from '@/components/domain/domain.tsx';
import { ListingDrawer } from '@/components/domain/observations.tsx';
import type { CompareListingRow, CompetitorCompareResult, CompetitorSummary } from '@shared/api/analytics.ts';
import { Fact, isRefetching } from '../history/parts.tsx';

function EquivalenceBadge({ equivalence, status }: { equivalence: 'equivalent' | 'comparable' | null; status?: string | null }) {
  if (!equivalence) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {equivalence === 'equivalent' ? <Badge tone="good">Equivalent</Badge> : <Badge tone="warn" title="Not a like-for-like product: only unit prices are compared.">Non-equivalent — unit price only</Badge>}
      {status === 'suggested' ? <Badge tone="accent" title="This mapping has not been approved yet.">Suggested</Badge> : null}
    </span>
  );
}

function UnitPrice({ value, currency, basis }: { value: number | null; currency: string; basis: string | null }) {
  if (value === null) return <span className="text-ink-4">{DASH}</span>;
  return (
    <span className="num whitespace-nowrap text-ink-2">
      {fmtUnitPrice(value, currency)}
      {basis ? <span className="ml-1 text-[11px] text-ink-3">{basis.replace('per ', '/')}</span> : null}
    </span>
  );
}

function signed(value: number, text: string): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${text}`;
}

function CompetitorTable({ competitors }: { competitors: CompetitorSummary[] }) {
  return (
    <div className="table-wrap">
      <table className="grid-table is-dense">
        <thead>
          <tr>
            <th scope="col">Competitor product</th>
            <th scope="col">Mapping</th>
            <th scope="col" style={{ textAlign: 'right' }} title="Competitor listings with a price gap ÷ all competitor listings in scope">Compared</th>
            <th scope="col" style={{ textAlign: 'right' }} title="Average of (own − competitor) ÷ competitor. Positive = own is more expensive.">Average gap</th>
            <th scope="col" style={{ textAlign: 'right' }} className="hidden md:table-cell">Gap range</th>
            <th scope="col" style={{ textAlign: 'right' }} className="hidden sm:table-cell">Own cheaper / dearer</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map((c) => (
            <tr key={c.mapping_id}>
              <td>
                <div className="max-w-[20rem] min-w-40">
                  <Link to={`/catalogue/products/${c.product_id}`} className="block truncate font-medium text-ink hover:underline">
                    {c.product_name}
                  </Link>
                  <span className="block truncate text-[11.5px] leading-4 text-ink-3">
                    {c.brand_name} · {c.pack || 'pack unknown'}
                  </span>
                </div>
              </td>
              <td>
                <EquivalenceBadge equivalence={c.equivalence} status={c.mapping_status} />
                {c.note ?? c.rationale ? <span className="mt-1 block max-w-sm min-w-48 text-[12px] leading-4 text-ink-3">{c.note ?? c.rationale}</span> : null}
              </td>
              <td className="num text-right whitespace-nowrap">
                {fmtNumber(c.compared_listings)} <span className="text-ink-3">of {fmtNumber(c.listings)}</span>
              </td>
              <td className="text-right">
                <span className="inline-flex justify-end whitespace-nowrap">
                  <GapCell pct={c.avg_gap_pct} basis={!c.comparable ? 'not_comparable' : c.equivalence === 'comparable' ? 'unit' : null} />
                </span>
              </td>
              <td className="num hidden text-right whitespace-nowrap text-ink-2 md:table-cell">
                {c.min_gap_pct === null || c.max_gap_pct === null ? DASH : `${fmtPct(c.min_gap_pct, 1, true)} to ${fmtPct(c.max_gap_pct, 1, true)}`}
              </td>
              <td className="num hidden text-right whitespace-nowrap text-ink-2 sm:table-cell">
                {c.compared_listings === 0 ? DASH : `${fmtNumber(c.own_cheaper_at)} / ${fmtNumber(c.own_dearer_at)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Phone layout of the competitor summary: one block per competitor. */
function CompetitorList({ competitors }: { competitors: CompetitorSummary[] }) {
  return (
    <ul>
      {competitors.map((c) => (
        <li key={c.mapping_id} className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 last:border-0">
          <div className="min-w-0">
            <Link to={`/catalogue/products/${c.product_id}`} className="block text-[13px] leading-[18px] font-medium break-words text-ink hover:underline">
              {c.product_name}
            </Link>
            <span className="block text-[11.5px] leading-4 text-ink-3">
              {c.brand_name} · {c.pack || 'pack unknown'}
            </span>
            <span className="mt-1.5 block">
              <EquivalenceBadge equivalence={c.equivalence} status={c.mapping_status} />
            </span>
            {c.note ? <span className="mt-1 block text-[12px] leading-4 text-ink-3">{c.note}</span> : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
            <GapCell pct={c.avg_gap_pct} basis={!c.comparable ? 'not_comparable' : c.equivalence === 'comparable' ? 'unit' : null} />
            <span className="num text-[11.5px] leading-4 text-ink-3">
              {fmtNumber(c.compared_listings)} of {fmtNumber(c.listings)} compared
            </span>
            {c.compared_listings > 0 ? (
              <span className="num text-[11.5px] leading-4 text-ink-3">
                cheaper {fmtNumber(c.own_cheaper_at)} · dearer {fmtNumber(c.own_dearer_at)}
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

interface RetailerGroup {
  key: string;
  market: string;
  retailer: string;
  currency: string;
  rows: CompareListingRow[];
}

function groupByRetailer(rows: CompareListingRow[]): RetailerGroup[] {
  const map = new Map<string, RetailerGroup>();
  for (const r of rows) {
    const key = `${r.market_id}|${r.retailer_id}`;
    const g = map.get(key);
    if (g) g.rows.push(r);
    else map.set(key, { key, market: r.market_name, retailer: r.retailer_name, currency: r.currency_code, rows: [r] });
  }
  return [...map.values()];
}

function PromoMark({ row }: { row: CompareListingRow }) {
  if (!row.is_promo) return null;
  return (
    <Tip content={row.promo_description ?? 'On promotion'}>
      <span className="inline-flex">
        <Badge tone="warn" icon={Tag}>
          {row.discount_pct !== null ? `${fmtPct(row.discount_pct, 0)} off` : 'On offer'}
        </Badge>
      </span>
    </Tip>
  );
}

/** Phone layout of the comparison: the same rows as the table, as a list with the gap on the right. */
function ComparisonList({ rows, converted, onOpen }: { rows: CompareListingRow[]; converted: string | null; onOpen: (listingId: number) => void }) {
  const groups = useMemo(() => groupByRetailer(rows), [rows]);
  return (
    <div className="max-h-[70dvh] overflow-y-auto">
      {groups.map((g) => (
        <section key={g.key} aria-label={`${g.retailer}, ${g.market}`}>
          <h4 className="sticky top-0 z-[1] border-y border-line bg-sunken px-4 py-1.5 text-[12px]">
            <span className="font-semibold text-ink">{g.retailer}</span>
            <span className="text-ink-3">
              {' '}
              · {g.market} · {g.currency}
            </span>
          </h4>
          <ul>
            {g.rows.map((r) => (
              <li key={r.listing_id} className="border-b border-line last:border-0">
                <button type="button" className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-sunken" onClick={() => onOpen(r.listing_id)}>
                  <OwnershipDot ownership={r.role === 'own' ? 'own' : 'competitor'} className="mt-[5px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] leading-[18px] font-medium break-words text-ink">{r.product_name}</span>
                    <span className="block text-[11.5px] leading-4 text-ink-3">
                      {[r.role === 'own' ? 'Own' : 'Competitor', r.variant_name ?? r.pack].filter(Boolean).join(' · ')}
                      {r.role === 'competitor' && r.equivalence === 'comparable' ? <span className="font-medium text-warn-ink"> · non-equivalent</span> : null}
                      {r.mapping_status === 'suggested' ? <span className="font-medium text-accent"> · suggested</span> : null}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <PriceCell price={r.price} regular={r.regular_price} currency={r.currency_code} isPromo={r.is_promo} />
                      <UnitPrice value={r.unit_price} currency={r.currency_code} basis={r.unit_basis} />
                      <PromoMark row={r} />
                      {r.availability && r.availability !== 'in_stock' ? <AvailabilityBadge value={r.availability} /> : null}
                      {r.is_stale ? <Badge tone="warn">Stale</Badge> : null}
                    </span>
                    {converted && r.converted && r.converted.price !== null ? (
                      <span className="num mt-0.5 block text-[11.5px] leading-4 text-ink-3">
                        ≈ {fmtPrice(r.converted.price, r.converted.currency)} {r.converted.currency}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 flex-col items-end text-right">
                    {r.role === 'own' ? (
                      <span className="text-[12px] text-ink-4">reference</span>
                    ) : r.gap_basis === null ? (
                      <span className="text-[12px] text-ink-4">no own price</span>
                    ) : (
                      <>
                        <GapCell pct={r.gap_pct} basis={r.gap_basis} />
                        {r.own_reference ? <span className="text-[11px] leading-4 text-ink-4">{r.own_reference.scope === 'same_retailer' ? 'vs own here' : 'vs own market avg'}</span> : null}
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ComparisonTable({ rows, converted, onOpen }: { rows: CompareListingRow[]; converted: string | null; onOpen: (listingId: number) => void }) {
  const groups = useMemo(() => groupByRetailer(rows), [rows]);
  const columnCount = converted ? 8 : 7;
  return (
    <div className="table-wrap max-h-[640px] overflow-y-auto">
      <table className="grid-table is-dense">
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col" style={{ textAlign: 'right' }}>Price</th>
            <th scope="col" style={{ textAlign: 'right' }} className="hidden sm:table-cell" title="Price per 100 ml / 100 g / unit">Unit price</th>
            {converted ? (
              <th scope="col" style={{ textAlign: 'right' }} className="hidden md:table-cell" title={`Price and unit price converted to ${converted}`}>
                In {converted}
              </th>
            ) : null}
            <th scope="col" style={{ textAlign: 'right' }} title="Own price against this competitor: positive = own is more expensive">Own vs competitor</th>
            <th scope="col" style={{ textAlign: 'right' }} className="hidden md:table-cell" title="Lowest – highest and average selling price observed in the period">Period low – high</th>
            <th scope="col" className="hidden sm:table-cell" title="Time of the latest observation and the availability it reported">Last observed</th>
            <th scope="col" className="hidden lg:table-cell">Source</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.key}>
              <tr>
                <td colSpan={columnCount} className="bg-sunken py-1.5">
                  <span className="text-[12px] font-semibold text-ink">{g.retailer}</span>
                  <span className="text-[12px] text-ink-3">
                    {' '}
                    · {g.market} · {g.currency}
                  </span>
                </td>
              </tr>
              {g.rows.map((r) => (
                <tr
                  key={r.listing_id}
                  className="is-clickable"
                  tabIndex={0}
                  onClick={() => onOpen(r.listing_id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(r.listing_id);
                    }
                  }}
                >
                  <td>
                    <div className="flex max-w-[18rem] min-w-44 items-start gap-2">
                      <Badge tone={r.role === 'own' ? 'own' : 'comp'} className="mt-0.5">
                        {r.role === 'own' ? 'Own' : 'Competitor'}
                      </Badge>
                      <div className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-ink">{r.product_name}</span>
                          {r.is_demo && r.data_class !== 'simulated' ? <DemoBadge /> : null}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] leading-4 text-ink-3">
                          <span>{[r.brand_name, r.variant_name ?? r.pack].filter(Boolean).join(' · ')}</span>
                          {r.role === 'competitor' && r.equivalence === 'comparable' ? <span className="font-medium text-warn-ink">non-equivalent</span> : null}
                          {r.mapping_status === 'suggested' ? <span className="font-medium text-accent">suggested mapping</span> : null}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="text-right">
                    <span className="inline-flex flex-col items-end gap-0.5">
                      <PriceCell price={r.price} regular={r.regular_price} currency={r.currency_code} isPromo={r.is_promo} showCurrency={false} />
                      <PromoMark row={r} />
                    </span>
                  </td>
                  <td className="hidden text-right sm:table-cell">
                    <UnitPrice value={r.unit_price} currency={r.currency_code} basis={r.unit_basis} />
                  </td>
                  {converted ? (
                    <td className="num hidden text-right whitespace-nowrap md:table-cell">
                      {r.converted && r.converted.price !== null ? (
                        <span className="inline-flex flex-col items-end">
                          <span className="text-ink">{fmtPrice(r.converted.price, r.converted.currency)}</span>
                          <span className="text-[11px] leading-4 text-ink-3">{r.converted.unit_price === null ? '' : `${fmtUnitPrice(r.converted.unit_price, r.converted.currency)} ${r.unit_basis?.replace('per ', '/') ?? ''}`}</span>
                        </span>
                      ) : (
                        <span className="text-ink-4">no rate</span>
                      )}
                    </td>
                  ) : null}
                  <td className="text-right">
                    {r.role === 'own' ? (
                      <span className="text-[12px] text-ink-4">reference</span>
                    ) : r.gap_basis === null ? (
                      <span className="text-[12px] text-ink-4" title="The own product has no current price in this market">
                        no own price
                      </span>
                    ) : (
                      <span className="inline-flex flex-col items-end">
                        <GapCell pct={r.gap_pct} basis={r.gap_basis} />
                        {r.gap_abs !== null ? (
                          <span className="num text-[11px] leading-4 text-ink-3">
                            {signed(r.gap_abs, r.gap_basis === 'unit' ? fmtUnitPrice(Math.abs(r.gap_abs), r.currency_code) : fmtPrice(Math.abs(r.gap_abs), r.currency_code))} {r.currency_code}
                            {r.gap_basis === 'unit' && r.unit_basis ? ` ${r.unit_basis.replace('per ', '/')}` : ''}
                          </span>
                        ) : null}
                        {r.own_reference ? <span className="text-[11px] leading-4 text-ink-4">{r.own_reference.scope === 'same_retailer' ? 'vs own at this retailer' : 'vs own market average'}</span> : null}
                      </span>
                    )}
                  </td>
                  <td className="num hidden text-right whitespace-nowrap md:table-cell">
                    {r.period ? (
                      <span className="inline-flex flex-col items-end">
                        <span className="text-ink-2">
                          {fmtPrice(r.period.min, r.currency_code)} – {fmtPrice(r.period.max, r.currency_code)}
                        </span>
                        <span className="text-[11px] leading-4 text-ink-3">
                          avg {fmtPrice(r.period.avg, r.currency_code)} · {r.period.days} d
                        </span>
                      </span>
                    ) : (
                      <span className="text-ink-4">{DASH}</span>
                    )}
                  </td>
                  <td className="hidden sm:table-cell">
                    <span className="inline-flex flex-col items-start gap-0.5">
                      <FreshnessCell iso={r.observed_at} stale={r.is_stale} timeZone={r.timezone} />
                      {r.observed_at ? <AvailabilityBadge value={r.availability} /> : null}
                    </span>
                  </td>
                  <td className="hidden lg:table-cell">
                    <DataClassBadge value={r.data_class} short />
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryChart({ data }: { data: CompetitorCompareResult }) {
  const { history } = data;
  const format = useMemo(() => (history.metric === 'unit_price' ? (v: number) => fmtUnitPrice(v, history.currency) : (v: number) => fmtPrice(v, history.currency)), [history.metric, history.currency]);
  const series = useMemo<Series[]>(
    () =>
      history.series.slice(0, MAX_SERIES).map((s) => ({
        key: `P${s.product_id}`,
        label: s.label,
        sublabel: s.role === 'own' ? 'own product' : s.equivalence === 'comparable' ? 'non-equivalent' : null,
        color: s.role === 'own' ? OWN_COLOR : undefined,
        points: s.points.map((p) => ({ date: p.date, value: p.value })),
      })),
    [history.series],
  );
  const scope = `competitor-history-${data.product.id}`;
  const chart = useSeriesChart(series, scope);
  const subtitle = [
    history.metric === 'unit_price' ? `Average daily unit price${history.basis ? ` ${history.basis}` : ''}` : 'Average daily shelf price',
    history.currency ?? undefined,
    'averaged across the retailers in scope',
  ]
    .filter(Boolean)
    .join(' · ');
  const hidden = history.series.length - series.length;
  return (
    <ChartFrame
      className="mb-5"
      title="Historical comparison"
      subtitle={subtitle}
      legend={chart.legend}
      table={series.length ? seriesTable(series, format) : null}
      empty={
        series.length === 0 ? (
          history.note ? (
            <Notice tone="warn" className="my-2">
              {history.note}
            </Notice>
          ) : (
            <ChartEmpty description="No priced observations for these products in the selected period." />
          )
        ) : undefined
      }
      footer={
        series.length > 0 && (history.note || hidden > 0) ? (
          <>
            {history.note}
            {hidden > 0 ? ` Showing ${MAX_SERIES} of ${history.series.length} products — narrow the mappings to see the others.` : ''}
          </>
        ) : undefined
      }
    >
      <TimeSeriesChart
        series={series}
        colorScope={scope}
        height={300}
        formatValue={format}
        hiddenKeys={chart.hidden}
        domain={{ from: data.period.from, to: data.period.to }}
        valueLabel={history.metric === 'unit_price' ? 'Unit price' : 'Shelf price'}
      />
    </ChartFrame>
  );
}

export function CompareView({ query: scope, onBack, ready = true }: { query: Query; onBack: () => void; ready?: boolean }) {
  const query = useApiQuery<CompetitorCompareResult>(['competitors', 'compare'], '/competitors/compare', scope, { enabled: ready });
  const [listingId, setListingId] = useState<number | null>(null);
  const narrow = useIsNarrow(639);
  const data = query.data;

  const totals = useMemo(() => {
    const gaps = (data?.rows ?? []).filter((r) => r.role === 'competitor' && r.gap_pct !== null).map((r) => r.gap_pct!);
    return {
      ownListings: (data?.rows ?? []).filter((r) => r.role === 'own').length,
      competitorListings: (data?.rows ?? []).filter((r) => r.role === 'competitor').length,
      compared: gaps.length,
      cheaper: gaps.filter((g) => g < -0.5).length,
      dearer: gaps.filter((g) => g > 0.5).length,
      avg: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    };
  }, [data]);

  if (query.isError && !data) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        <div className="-mt-4 flex justify-center pb-8">
          <button type="button" className="link text-[13px]" onClick={onBack}>
            Back to all own products
          </button>
        </div>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <LoadingBlock className="min-h-72" />
      </Card>
    );
  }

  const { product } = data;
  const nonEquivalent = data.competitors.filter((c) => c.equivalence === 'comparable').length;
  const suggested = data.competitors.filter((c) => c.mapping_status === 'suggested').length;

  return (
    <div className={cn('transition-opacity', isRefetching(query) && 'opacity-60')}>
      <DemoNotice demo={data.demo} className="mb-4" />

      <Card className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-4">
          <div className="min-w-0">
            <div className="eyebrow mb-1">Own product</div>
            <h2 className="flex flex-wrap items-center gap-2 text-[18px] leading-6 font-semibold tracking-[-0.01em] text-ink">
              <span className="min-w-0 break-words">{product.name}</span>
              {product.is_demo ? <DemoBadge /> : null}
            </h2>
            <p className="mt-1 text-[12.5px] leading-5 text-ink-3">
              {[product.brand_name, product.category_name, product.pack, product.code].filter(Boolean).join(' · ')}
              {product.unit_basis ? ` · unit price ${product.unit_basis}` : ''}
            </p>
            <p className="text-[12.5px] leading-5 text-ink-3">
              Latest prices, with lows, highs and averages observed {fmtDate(data.period.from)} – {fmtDate(data.period.to)}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
            <Link to={`/catalogue?tab=mappings&own_product_id=${product.id}`} className="link inline-flex items-center gap-1.5">
              <Link2 className="size-3.5" aria-hidden /> Manage mappings
            </Link>
            <Link to={`/history?product_id=${product.id}`} className="link inline-flex items-center gap-1.5">
              <History className="size-3.5" aria-hidden /> Price history
            </Link>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 border-t border-line p-4 sm:grid-cols-3 lg:grid-cols-5">
          <Fact
            label="Mapped competitors"
            value={fmtNumber(data.competitors.length)}
            detail={
              data.competitors.length === 0
                ? 'none approved'
                : [suggested ? `${suggested} suggested, not approved` : null, nonEquivalent ? `${nonEquivalent} non-equivalent` : suggested ? null : 'all equivalent'].filter(Boolean).join(' · ')
            }
          />
          <Fact label="Listings in scope" value={fmtNumber(totals.ownListings + totals.competitorListings)} detail={`${fmtNumber(totals.ownListings)} own · ${fmtNumber(totals.competitorListings)} competitor`} />
          <Fact label="Price gaps calculated" value={fmtNumber(totals.compared)} detail="competitor listings compared" />
          <Fact
            label="Own cheaper / dearer"
            value={
              <>
                {fmtNumber(totals.cheaper)} <span className="text-ink-4">/</span> {fmtNumber(totals.dearer)}
              </>
            }
            detail="of the compared listings"
          />
          <Fact
            label="Average gap"
            value={totals.avg === null ? DASH : fmtPct(totals.avg, 1, true)}
            detail={totals.avg === null ? 'no comparable prices' : totals.avg > 0.5 ? 'own is more expensive' : totals.avg < -0.5 ? 'own is cheaper' : 'at parity'}
          />
        </div>
      </Card>

      <Card className="mb-5">
        <CardHeader title="Mapped competitors" subtitle="Gap = (own − competitor) ÷ competitor. Positive means the own product is more expensive." />
        {data.competitors.length === 0 ? (
          <EmptyState
            icon={GitCompareArrows}
            title="No approved competitor mapping"
            description="This product has no approved equivalent-product mapping, so there is nothing to compare it with yet. Approve or add mappings in the Product Catalogue, or include suggested mappings with the toggle above."
            action={
              <Link to={`/catalogue?tab=mappings&own_product_id=${product.id}`} className="link text-[13px]">
                Manage mappings
              </Link>
            }
          />
        ) : narrow ? (
          <CompetitorList competitors={data.competitors} />
        ) : (
          <CompetitorTable competitors={data.competitors} />
        )}
      </Card>

      <Card className="mb-5">
        <CardHeader
          title="Price comparison by retailer"
          subtitle={`Latest price of every listing in scope, grouped by retailer${data.currency_mode === 'converted' ? `; converted values in ${data.target_currency}` : ''}. Select a row to open the listing.`}
        />
        {data.rows.length === 0 ? (
          <EmptyState title="No listings in this scope" description="Neither the product nor its mapped competitors are listed at the selected retailers or markets." />
        ) : narrow ? (
          <ComparisonList rows={data.rows} converted={data.currency_mode === 'converted' ? data.target_currency : null} onOpen={setListingId} />
        ) : (
          <ComparisonTable rows={data.rows} converted={data.currency_mode === 'converted' ? data.target_currency : null} onOpen={setListingId} />
        )}
        {data.conversions.length || data.missing_rates.length ? (
          <div className="border-t border-line px-4 py-2.5">
            <FxNote conversions={data.conversions} missing={data.missing_rates} target={data.target_currency} />
          </div>
        ) : null}
      </Card>

      <HistoryChart data={data} />

      {data.notes.length ? (
        <Notice tone="info" title="Notes on this comparison" className="mb-5">
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
            {data.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <ListingDrawer listingId={listingId} onClose={() => setListingId(null)} />
    </div>
  );
}
