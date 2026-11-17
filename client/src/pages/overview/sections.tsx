/** Sections of the executive overview. Every figure is read from the /overview response. */
import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Activity, ArrowDown, ArrowRight, ArrowUp, BadgePercent, Ban, CircleCheck, CircleDashed, Globe, Package, Radio, Store, Tags, TrendingDown,
  TrendingUp, TriangleAlert,
} from 'lucide-react';
import type { MarketOverviewRow, OverviewResult, PositionGroup, PriceEventRow, PromotionRecord, RunStats } from '@shared/api/analytics.ts';
import { DATA_CLASSES, DATA_CLASS_LABELS, type DataClass } from '@shared/constants.ts';
import { ChartEmpty, ChartFrame, COMPETITOR_COLOR, DEEMPHASIS, DIVERGING, Legend, OWN_COLOR, SERIES_COLORS, type TableView } from '@/components/charts/kit.tsx';
import { DivergingColumns, IndexScale, SegmentedBar, seriesTable, TimeSeriesChart, useSeriesChart, type Series } from '@/components/charts/charts.tsx';
import { ChangeCell, DataClassBadge, DemoBadge, MarketTime, packText, ProductCell, PromoBadge } from '@/components/domain/domain.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { Badge, Card, CardHeader, cn, EmptyState, StatTile, Tip } from '@/components/ui/primitives.tsx';
import { DASH, fmtDateShort, fmtNumber, fmtPct, fmtPrice, fmtRelative, plural } from '@/lib/format.ts';
import { useIsNarrow } from '@/lib/hooks.ts';

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">
      {children}
      <ArrowRight className="size-3" aria-hidden />
    </Link>
  );
}

/** "94.7% of 471 runs" — or an honest "no run yet". */
function rateText(stats: RunStats): string {
  if (stats.runs === 0 || stats.success_rate_pct === null) return 'no run yet';
  return `${fmtPct(stats.success_rate_pct, 1)} of ${plural(stats.runs, 'run')}`;
}

/** Sentence fragment for a price premium: "7.6% below" / "3.1% above" / "at parity with". */
function premiumPhrase(premium: number | null): string {
  if (premium === null) return 'not yet comparable with';
  if (Math.abs(premium) < 0.5) return 'at parity with';
  return premium > 0 ? `${fmtPct(premium, 1)} above` : `${fmtPct(Math.abs(premium), 1)} below`;
}

// ---------------------------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------------------------
export function KpiTiles({ data }: { data: OverviewResult }) {
  const navigate = useNavigate();
  const k = data.kpis;
  const days = data.period_days;
  const real = k.collection.real;
  const simulated = k.collection.simulated;
  const missing = k.products_missing_or_stale;
  return (
    <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      <StatTile
        label="Monitored products"
        title="Products with at least one active retailer listing"
        icon={Package}
        value={fmtNumber(k.products_monitored)}
        detail={`of ${plural(k.products_total, 'product')} in the catalogue`}
        onClick={() => navigate('/catalogue')}
      />
      <StatTile
        label="Monitored retailers"
        title="Retailers with at least one active product listing"
        icon={Store}
        value={fmtNumber(k.retailers_monitored)}
        detail={`of ${fmtNumber(k.retailers_total)} configured · ${plural(k.listings_active, 'listing')}`}
      />
      <StatTile
        label="Brands"
        icon={Tags}
        value={fmtNumber(k.brands_total)}
        title={data.market_ids ? 'Brands with products in the catalogue (all markets — brands are not market-specific)' : 'Brands with products in the catalogue'}
        detail={`${fmtNumber(k.brands_own)} own · ${fmtNumber(k.brands_competitor)} competitor${data.market_ids ? ' · all markets' : ''}`}
      />
      <StatTile
        label="Markets"
        title="Active markets with at least one price observation"
        icon={Globe}
        value={fmtNumber(k.markets_with_data)}
        detail={`of ${plural(k.markets_active, 'active market')} ${k.markets_with_data === 1 ? 'has' : 'have'} price data`}
        onClick={() => navigate('/markets')}
      />
      <StatTile
        label="Latest observations"
        title="Price observations recorded in the last 24 hours"
        icon={Activity}
        value={fmtNumber(k.observations_24h)}
        detail={
          <>
            in the last 24 h · latest {k.latest_observation_at ? fmtRelative(k.latest_observation_at) : 'none yet'}
            <span className="block">{fmtNumber(k.observations_total)} in the ledger</span>
          </>
        }
        onClick={() => navigate('/monitor')}
      />
      <StatTile
        label="Price increases"
        title="Selling-price increases detected between consecutive observations"
        icon={TrendingUp}
        value={fmtNumber(k.price_increases)}
        detail={`detected in the last ${days} days`}
        onClick={() => navigate('/history')}
      />
      <StatTile
        label="Price decreases"
        title="Selling-price decreases detected between consecutive observations"
        icon={TrendingDown}
        value={fmtNumber(k.price_decreases)}
        detail={`detected in the last ${days} days`}
        onClick={() => navigate('/history')}
      />
      <StatTile
        label="Active promotions"
        title="Listings whose latest observation shows a promotion and is still fresh"
        icon={BadgePercent}
        value={fmtNumber(k.active_promotions)}
        detail={`across ${plural(k.active_promotion_products, 'product')}`}
        onClick={() => navigate('/promotions')}
      />
      <StatTile
        label="Missing or stale"
        title="Products with at least one listing that has no fresh observation"
        icon={TriangleAlert}
        tone={missing > 0 ? 'warn' : 'default'}
        value={fmtNumber(missing)}
        detail={
          missing > 0
            ? `${plural(missing, 'product')} affected · ${fmtNumber(k.listings_stale)} stale, ${fmtNumber(k.listings_never_observed)} never observed listings`
            : 'Every monitored product has a fresh observation'
        }
        onClick={missing > 0 ? () => navigate('/monitor?stale=true') : undefined}
      />
      <StatTile
        label="Collection success"
        // on the three-column layout the tenth tile takes the whole last row instead of sitting alone
        className="sm:max-xl:col-span-3"
        title="Share of collection runs that captured data. Real sources and the simulated demo source are never blended."
        icon={Radio}
        value={real.runs > 0 && real.success_rate_pct !== null ? fmtPct(real.success_rate_pct, 1) : <span className="text-ink-4">n/a</span>}
        detail={
          real.runs > 0
            ? `real sources · ${plural(real.runs, 'run')}${real.failed ? `, ${fmtNumber(real.failed)} failed` : ''}`
            : 'No real source has run yet'
        }
        footer={
          simulated.runs > 0 ? (
            <span className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-line pt-1.5 text-[12px] leading-4 text-ink-3">
              <DemoBadge />
              <span>
                simulated runs <span className="num font-medium text-ink-2">{rateText(simulated)}</span>
              </span>
            </span>
          ) : real.not_configured > 0 ? (
            <span className="mt-1 border-t border-line pt-1.5 text-[12px] leading-4 text-ink-3">{plural(real.not_configured, 'run')} skipped: not configured</span>
          ) : null
        }
        onClick={() => navigate('/collection')}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Ledger composition (provenance)
// ---------------------------------------------------------------------------------------------
/** Validated as an adjacent set in this order (collected, imported, manual, simulated). */
const CLASS_COLORS: Record<DataClass, string> = {
  collected: SERIES_COLORS[5],
  imported: SERIES_COLORS[6],
  manual: SERIES_COLORS[4],
  simulated: SERIES_COLORS[3],
};

export function ProvenanceStrip({ data }: { data: OverviewResult }) {
  const byClass = new Map(data.provenance.map((p) => [p.data_class, p]));
  const total = data.provenance.reduce((acc, p) => acc + p.observations, 0);
  const parts = DATA_CLASSES.map((c) => ({ key: c, label: DATA_CLASS_LABELS[c], value: byClass.get(c)?.observations ?? 0, color: CLASS_COLORS[c] }));
  return (
    <Card className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[13.5px] leading-5 font-semibold text-ink">Where the prices come from</h3>
        <p className="text-[12px] leading-4 text-ink-3">
          <span className="num">{fmtNumber(total)}</span> observations in the ledger{data.market_ids ? ' for the selected markets' : ''} · each one keeps its source
        </p>
      </div>
      <SegmentedBar parts={parts} className="mt-2.5" />
      <ul className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-2 lg:grid-cols-4">
        {parts.map((p) => {
          const row = byClass.get(p.key);
          return (
            <li key={p.key} className="flex min-w-0 items-start gap-2 text-[12.5px] leading-4">
              <span aria-hidden className="mt-[3px] size-2.5 shrink-0 rounded-[2px]" style={{ background: p.value > 0 ? p.color : DEEMPHASIS }} />
              <span className="min-w-0">
                <span className="block truncate text-ink-2">{p.label}</span>
                <span className="num font-semibold text-ink">{fmtNumber(p.value)}</span>
                <span className="num text-ink-3"> · {total > 0 ? fmtPct((p.value / total) * 100, 1) : '0%'}</span>
                <span className="block text-[11.5px] text-ink-3">{row?.last_observed_at ? `latest ${fmtRelative(row.last_observed_at)}` : p.key === 'collected' ? 'no real collection yet' : 'none'}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// A. Price movement
// ---------------------------------------------------------------------------------------------
const indexFormat = (v: number) => v.toFixed(1);

export function PriceIndexChart({ data, refetching }: { data: OverviewResult; refetching: boolean }) {
  const series = useMemo<Series[]>(
    () =>
      [
        { key: 'own', label: 'Own brands', color: OWN_COLOR, points: data.price_movement.map((d) => ({ date: d.date, value: d.own_index })) },
        { key: 'competitor', label: 'Competitors', color: COMPETITOR_COLOR, points: data.price_movement.map((d) => ({ date: d.date, value: d.competitor_index })) },
      ].filter((s) => s.points.some((p) => p.value !== null)),
    [data.price_movement],
  );
  const chart = useSeriesChart(series, 'overview-index');
  return (
    <ChartFrame
      title="Price level: own brands vs competitors"
      subtitle="Selling prices, indexed to each listing's first price"
      actions={data.demo.present ? <DemoBadge /> : undefined}
      legend={chart.legend}
      table={series.length ? seriesTable(series, indexFormat) : null}
      refetching={refetching}
      empty={series.length === 0 ? <ChartEmpty description="No priced observations in this period. Widen the period or pick another market." /> : undefined}
    >
      <TimeSeriesChart
        series={series}
        colorScope="overview-index"
        hiddenKeys={chart.hidden}
        height={250}
        formatValue={indexFormat}
        reference={{ value: 100, label: 'Period start = 100' }}
        valueLabel="Price index"
      />
    </ChartFrame>
  );
}

export function PriceChangesChart({ data, refetching }: { data: OverviewResult; refetching: boolean }) {
  const rows = data.price_movement;
  const total = rows.reduce((acc, d) => acc + d.increases + d.decreases, 0);
  const table: TableView = {
    columns: ['Date', 'Increases', 'Decreases', 'Average increase', 'Average decrease'],
    numeric: [1, 2, 3, 4],
    rows: [...rows].reverse().map((d) => [d.date, d.increases, d.decreases, d.avg_increase_pct === null ? null : fmtPct(d.avg_increase_pct, 1), d.avg_decrease_pct === null ? null : fmtPct(d.avg_decrease_pct, 1)]),
  };
  return (
    <ChartFrame
      title="Price changes detected per day"
      subtitle={`${fmtNumber(data.kpis.price_increases)} increases and ${fmtNumber(data.kpis.price_decreases)} decreases in the last ${data.period_days} days`}
      actions={data.demo.present ? <DemoBadge /> : undefined}
      legend={
        <Legend
          items={[
            { key: 'up', label: 'Increases (above the line)', color: DIVERGING.positive, shape: 'rect' },
            { key: 'down', label: 'Decreases (below the line)', color: DIVERGING.negative, shape: 'rect' },
          ]}
        />
      }
      table={total > 0 ? table : null}
      refetching={refetching}
      empty={total === 0 ? <ChartEmpty title="No price changes detected" description="No selling price changed between consecutive observations in this period." /> : undefined}
    >
      <DivergingColumns data={rows.map((d) => ({ date: d.date, positive: d.increases, negative: d.decreases }))} height={250} positiveLabel="price increases" negativeLabel="price decreases" />
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// B. Own brand vs competitor
// ---------------------------------------------------------------------------------------------
function PositionRow({ group }: { group: PositionGroup }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_3.25rem] items-center gap-3 py-1.5 text-[13px]">
      <span className="min-w-0">
        <span className="block truncate text-ink">{group.label}</span>
        <span className="block truncate text-[11.5px] leading-4 text-ink-3">
          {premiumPhrase(group.premium_pct).replace(' with', '')} · {plural(group.pairs, 'pair')}
        </span>
      </span>
      <IndexScale value={group.index} width={96} />
      <span className="num text-right font-semibold text-ink">{group.index === null ? DASH : group.index.toFixed(1)}</span>
    </li>
  );
}

export function PositioningCard({ data }: { data: OverviewResult }) {
  const pos = data.positioning;
  const overall = pos.overall;
  const hasData = overall.pairs > 0 && overall.index !== null;
  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Own brands vs competitors"
        subtitle="Price position against mapped competitors"
        actions={pos.demo.any_demo ? <DemoBadge /> : undefined}
      />
      {hasData ? (
        <div className="flex flex-1 flex-col px-4 py-3">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div>
              <div className="eyebrow">Price index</div>
              <div className="text-[30px] leading-9 font-semibold tracking-[-0.01em] text-ink">{overall.index!.toFixed(1)}</div>
            </div>
            <IndexScale value={overall.index} width={160} className="mb-3" />
          </div>
          <p className="mt-1 text-[13px] leading-5 text-ink-2">
            Own products are priced <strong className="font-semibold text-ink">{premiumPhrase(overall.premium_pct)}</strong> their mapped competitors, across{' '}
            <span className="num">{fmtNumber(overall.pairs)}</span> same-retailer comparisons ({plural(overall.own_products, 'own product')} vs{' '}
            {plural(overall.competitor_products, 'competitor product')} at {plural(overall.retailers, 'retailer')}).
          </p>
          <p className="mt-1 text-[12px] leading-4 text-ink-3">
            Cheaper in <span className="num">{fmtNumber(overall.cheaper_pairs)}</span> comparisons, more expensive in <span className="num">{fmtNumber(overall.dearer_pairs)}</span>.
          </p>

          {/* two lists side by side while the card is full-width (below 1400 px), stacked once it sits in the narrow column */}
          <div className="mt-3 grid gap-x-8 gap-y-3 sm:max-[87.49rem]:grid-cols-2">
            <div className="min-w-0">
              <div className="eyebrow border-b border-line pb-1">By category</div>
              <ul className="divide-y divide-line">
                {pos.by_category.map((g) => (
                  <PositionRow key={g.key} group={g} />
                ))}
              </ul>
            </div>
            <div className="min-w-0">
              <div className="eyebrow border-b border-line pb-1">By own brand</div>
              <ul className="divide-y divide-line">
                {pos.by_brand.map((g) => (
                  <PositionRow key={g.key} group={g} />
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
            <p className="max-w-md text-[12px] leading-4 text-ink-3">
              100 = parity. Below 100 own products are cheaper, above 100 more expensive. Unit prices are used where pack sizes differ.
              {pos.not_comparable_pairs > 0 ? ` ${plural(pos.not_comparable_pairs, 'pair')} measured in different units ${pos.not_comparable_pairs === 1 ? 'is' : 'are'} left out.` : ''}
            </p>
            <SectionLink to="/competitors">Competitor intelligence</SectionLink>
          </div>
        </div>
      ) : (
        <EmptyState
          title="No comparable prices yet"
          description="A position appears once an own product and an approved, mapped competitor product both have a recent price at the same retailer."
          action={<SectionLink to="/catalogue?tab=mappings">Review competitor mappings</SectionLink>}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// C. Recent price changes
// ---------------------------------------------------------------------------------------------
export function RecentChangesCard({ data, refetching, onOpenListing }: { data: OverviewResult; refetching: boolean; onOpenListing: (listingId: number) => void }) {
  const columns: Array<Column<PriceEventRow>> = [
    {
      key: 'product',
      header: 'Product · retailer',
      // takes the remaining width and truncates instead of pushing the other columns out of view
      className: 'w-full max-w-0',
      cell: (r) => {
        // On wider screens the Source column already marks simulated rows with the hatched demo badge.
        const simulated = r.data_class === 'simulated';
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1">
              <ProductCell
                name={r.product_name}
                brand={`${r.retailer_name} · ${r.market_name}`}
                pack={packText(r)}
                ownership={r.ownership}
                isDemo={r.is_demo && !simulated}
                compact
              />
            </span>
            {r.is_demo && simulated ? (
              <span className="hidden shrink-0 sm:inline-flex md:hidden">
                <DemoBadge />
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'prices',
      header: 'Previous → current',
      align: 'right',
      cell: (r) => (
        <span className="block">
          <span className="num whitespace-nowrap">
            <span className="text-ink-3">{fmtPrice(r.old_price, r.currency_code)}</span>
            <span className="px-1 text-ink-4" aria-hidden>
              →
            </span>
            <span className="sr-only">to</span>
            <span className="font-medium text-ink">{fmtPrice(r.new_price, r.currency_code)}</span>
            <span className="ml-1 text-[11px] text-ink-3">{r.currency_code}</span>
          </span>
          <span className="mt-0.5 flex items-center justify-end gap-1.5 sm:hidden">
            {r.is_demo && r.data_class === 'simulated' ? <DemoBadge /> : null}
            <ChangeCell pct={r.change_pct} />
          </span>
        </span>
      ),
    },
    { key: 'change', header: 'Change', align: 'right', hideBelow: 'sm', cell: (r) => <ChangeCell pct={r.change_pct} /> },
    { key: 'when', header: 'Observed', hideBelow: 'md', nowrap: true, cell: (r) => <MarketTime iso={r.occurred_at} timeZone={r.timezone} short /> },
    { key: 'source', header: 'Source', hideBelow: 'md', cell: (r) => <DataClassBadge value={r.data_class} short /> },
  ];
  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Recent price changes"
        subtitle="Latest changes in selling price between consecutive observations of a listing"
        actions={<SectionLink to="/history">View all</SectionLink>}
      />
      <DataTable
        columns={columns}
        rows={data.recent_changes.slice(0, 12)}
        rowKey={(r) => r.id}
        dense
        refetching={refetching}
        onRowClick={(r) => onOpenListing(r.listing_id)}
        empty={<EmptyState title="No price changes in this period" description="Changes appear here as soon as a listing is observed at a different selling price." />}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// D. Promotional activity
// ---------------------------------------------------------------------------------------------
const shareFormat = (v: number) => `${v.toFixed(1)}%`;

export function PromoShareChart({ data, refetching }: { data: OverviewResult; refetching: boolean }) {
  const calendar = data.promotions.calendar;
  const series = useMemo<Series[]>(
    () =>
      [
        { key: 'own', label: 'Own brands', color: OWN_COLOR, points: calendar.map((d) => ({ date: d.date, value: d.own_share_pct })) },
        { key: 'competitor', label: 'Competitors', color: COMPETITOR_COLOR, points: calendar.map((d) => ({ date: d.date, value: d.competitor_share_pct })) },
      ].filter((s) => s.points.some((p) => p.value !== null)),
    [calendar],
  );
  const chart = useSeriesChart(series, 'overview-promo');
  return (
    <ChartFrame
      title="Promotional intensity"
      subtitle="Share of observed listings on promotion each day"
      actions={data.demo.present ? <DemoBadge /> : undefined}
      legend={chart.legend}
      table={series.length ? seriesTable(series, shareFormat) : null}
      refetching={refetching}
      empty={series.length === 0 ? <ChartEmpty description="No observations in this period." /> : undefined}
    >
      <TimeSeriesChart series={series} colorScope="overview-promo" hiddenKeys={chart.hidden} height={300} formatValue={shareFormat} formatAxis={(v) => `${v}%`} includeZero valueLabel="Share of listings on promotion" />
    </ChartFrame>
  );
}

export function CurrentPromotionsCard({ data }: { data: OverviewResult }) {
  const promos = data.promotions;
  const total = data.kpis.active_promotions;
  const shown = promos.current.slice(0, 8);
  return (
    <Card className="flex flex-col">
      <CardHeader title="Promotions running now" subtitle="Largest current discounts first" actions={<SectionLink to="/promotions">All promotions</SectionLink>} />
      <dl className="grid grid-cols-3 divide-x divide-line border-b border-line text-center">
        {[
          { label: 'Own brands', value: fmtNumber(promos.own_current) },
          { label: 'Competitors', value: fmtNumber(promos.competitor_current) },
          { label: 'Average discount', value: promos.avg_current_discount_pct === null ? DASH : fmtPct(promos.avg_current_discount_pct, 1) },
        ].map((s) => (
          <div key={s.label} className="px-2 py-2.5">
            <dt className="truncate text-[11.5px] leading-4 text-ink-3">{s.label}</dt>
            <dd className="text-[18px] leading-6 font-semibold text-ink">{s.value}</dd>
          </div>
        ))}
      </dl>
      {shown.length ? (
        <>
          <ul className="divide-y divide-line">
            {shown.map((p: PromotionRecord) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <ProductCell
                    name={p.product_name}
                    brand={`${p.retailer_name} · ${p.market_name}`}
                    pack={`since ${fmtDateShort(p.start_local_date)} · ${plural(p.duration_days, 'day')}`}
                    ownership={p.ownership}
                    productId={p.product_id}
                    isDemo={p.is_demo}
                    compact
                  />
                </div>
                <span className="shrink-0">
                  <PromoBadge type={p.promo_type} discount={p.max_discount_pct} description={p.description} />
                </span>
              </li>
            ))}
          </ul>
          {total > shown.length ? (
            <p className="mt-auto border-t border-line px-4 py-2.5 text-[12px] leading-4 text-ink-3">
              Showing {shown.length} of <span className="num">{fmtNumber(total)}</span> running promotions.
            </p>
          ) : null}
        </>
      ) : (
        <EmptyState title="No promotion is running" description="A promotion shows here while a listing's latest fresh observation carries promotional pricing." />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// E. Market overview
// ---------------------------------------------------------------------------------------------
const MARKET_STATUS: Record<MarketOverviewRow['status'], { label: string; tone: 'good' | 'warn' | 'neutral' | 'outline'; icon: typeof CircleCheck }> = {
  healthy: { label: 'Healthy', tone: 'good', icon: CircleCheck },
  attention: { label: 'Attention', tone: 'warn', icon: TriangleAlert },
  no_data: { label: 'No data', tone: 'neutral', icon: CircleDashed },
  inactive: { label: 'Inactive', tone: 'outline', icon: Ban },
};

function MarketStatusBadge({ market }: { market: MarketOverviewRow }) {
  const meta = MARKET_STATUS[market.status];
  return (
    <Tip content={market.status_reason}>
      <span className="inline-flex">
        <Badge tone={meta.tone} icon={meta.icon}>
          {meta.label}
        </Badge>
      </span>
    </Tip>
  );
}

function CollectionLines({ market }: { market: MarketOverviewRow }) {
  const { real, simulated } = market.collection;
  return (
    <span className="block text-[12px] leading-4">
      <span className="block whitespace-nowrap text-ink-2">
        Real: <span className={cn('num', real.runs > 0 ? 'font-medium text-ink' : 'text-ink-3')}>{rateText(real)}</span>
      </span>
      {simulated.runs > 0 ? (
        <span className="block whitespace-nowrap text-ink-3">
          Simulated: <span className="num">{rateText(simulated)}</span>
        </span>
      ) : null}
    </span>
  );
}

export function MarketsCard({ data, refetching }: { data: OverviewResult; refetching: boolean }) {
  const navigate = useNavigate();
  // Width bands (viewport px): columns are added only where they fit without sideways scrolling.
  const phone = useIsNarrow(639);
  const belowMd = useIsNarrow(767);
  const belowXl = useIsNarrow(1279);
  const below1380 = useIsNarrow(1379);
  const below1500 = useIsNarrow(1499);
  const hidden = new Set<string>([
    ...(below1380 ? ['retailers'] : []),
    ...(belowXl ? ['position', 'last'] : []),
    ...(below1500 ? ['moves'] : []),
    ...(belowMd ? ['collection'] : []),
    ...(phone ? ['status'] : []),
  ]);
  const allColumns: Array<Column<MarketOverviewRow>> = [
    {
      key: 'market',
      header: 'Market',
      cell: (m) => (
        <span className="block min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium text-ink">{m.name}</span>
            {m.demo_only ? <DemoBadge /> : null}
          </span>
          <span className="block truncate text-[11.5px] leading-4 text-ink-3">
            {m.code} · {m.currency_code}
          </span>
          <span className="mt-1 block sm:hidden">
            <MarketStatusBadge market={m} />
          </span>
        </span>
      ),
    },
    {
      key: 'retailers',
      header: 'Retailers',
      align: 'right',
      cell: (m) => (
        <span>
          {fmtNumber(m.retailers.total)}
          {m.retailers.paused > 0 ? <span className="block text-[11.5px] font-normal text-ink-3">{fmtNumber(m.retailers.paused)} paused</span> : null}
        </span>
      ),
    },
    {
      key: 'listings',
      header: 'Listings · freshness',
      cell: (m) => {
        const l = m.listings;
        if (l.active === 0) return <span className="text-[12px] text-ink-3">No listings configured</span>;
        return (
          <span className="block min-w-28 sm:min-w-44">
            <span className="num block text-[12px] leading-4 text-ink-2 sm:whitespace-nowrap">
              <span className="font-medium text-ink">{fmtNumber(l.fresh)}</span> fresh
              {l.stale > 0 ? (
                <>
                  {' · '}
                  <span className="font-medium text-ink">{fmtNumber(l.stale)}</span> stale
                </>
              ) : null}
              {l.never_observed > 0 ? (
                <>
                  {' · '}
                  <span className="font-medium text-ink">{fmtNumber(l.never_observed)}</span> never observed
                </>
              ) : null}
            </span>
            <SegmentedBar
              className="mt-1.5"
              height={4}
              parts={[
                { key: 'fresh', label: 'Fresh', value: l.fresh, color: '#0ca30c' },
                { key: 'stale', label: 'Stale', value: l.stale, color: '#fab219' },
                { key: 'never', label: 'Never observed', value: l.never_observed, color: DEEMPHASIS },
              ]}
            />
          </span>
        );
      },
    },
    {
      key: 'position',
      header: 'Own vs competitors',
      nowrap: true,
      headerTitle: 'Average price index of own products against mapped competitors at the same retailer. 100 = parity.',
      cell: (m) =>
        m.position && m.position.index !== null ? (
          <span className="inline-flex items-center gap-2">
            <IndexScale value={m.position.index} width={64} />
            <span className="num font-medium text-ink">{m.position.index.toFixed(1)}</span>
          </span>
        ) : (
          <span className="text-[12px] text-ink-4">No comparable prices</span>
        ),
    },
    { key: 'last', header: 'Last observation', nowrap: true, cell: (m) => <MarketTime iso={m.last_observation_at} timeZone={m.timezone} short /> },
    {
      key: 'moves',
      header: 'Price moves',
      nowrap: true,
      headerTitle: `Selling-price increases and decreases detected in the last ${data.period_days} days`,
      cell: (m) => (
        <span className="num inline-flex items-center gap-2.5 text-ink-2">
          <span className="inline-flex items-center gap-0.5">
            <ArrowUp className="size-3 text-ink-3" aria-hidden />
            <span className="sr-only">increases</span>
            {fmtNumber(m.events.increases)}
          </span>
          <span className="inline-flex items-center gap-0.5">
            <ArrowDown className="size-3 text-ink-3" aria-hidden />
            <span className="sr-only">decreases</span>
            {fmtNumber(m.events.decreases)}
          </span>
        </span>
      ),
    },
    { key: 'collection', header: 'Collection success', cell: (m) => <CollectionLines market={m} /> },
    { key: 'status', header: 'Status', cell: (m) => <MarketStatusBadge market={m} /> },
  ];
  const columns = allColumns.filter((c) => !hidden.has(c.key));
  return (
    <Card>
      <CardHeader
        title="Market overview"
        subtitle={`Coverage and collection health per market · last ${data.period_days} days`}
        actions={<SectionLink to="/markets">Market intelligence</SectionLink>}
      />
      <DataTable
        columns={columns}
        rows={data.markets}
        rowKey={(m) => m.id}
        refetching={refetching}
        onRowClick={() => navigate('/markets')}
        empty={<EmptyState title="No markets match" description="Clear the market filter to see every configured market." />}
      />
    </Card>
  );
}
