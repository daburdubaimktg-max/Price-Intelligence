/**
 * Brand page: one brand in depth — header figures, then four views kept in the URL:
 * Range (every product), Price matrix (products × retailers of one market), Trend and Competing brands.
 */
import { useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowDown, ArrowLeft, ArrowUp, ChartLine, Link2, Package, Radar, Tag, Tags, X } from 'lucide-react';
import { Page } from '@/app/AppShell.tsx';
import { ApiError, toQueryString, type Query } from '@/lib/api.ts';
import { fmtNumber, fmtPct } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useDates, useUrlState } from '@/lib/hooks.ts';
import { FilterBar, MultiSelect } from '@/components/ui/filters.tsx';
import { Badge, Button, Card, cn, EmptyState, ErrorState, LoadingBlock, Notice, StatTile, TabPanel, Tabs } from '@/components/ui/primitives.tsx';
import { DemoBadge, DemoNotice, FxNote, OwnershipBadge } from '@/components/domain/domain.tsx';
import type { BrandDetailResult } from '@shared/api/brands.ts';
import { CurrencySelect, isRefetching } from '../history/parts.tsx';
import { CompetitorsTab } from './CompetitorsTab.tsx';
import { MatrixTab } from './MatrixTab.tsx';
import { BRANDS, LastObserved, LinkButton, TagCounts, useScopeOptions } from './parts.tsx';
import { RangeTab } from './RangeTab.tsx';
import { TrendTab } from './TrendTab.tsx';

type TabKey = 'range' | 'matrix' | 'trend' | 'competitors';
const TABS: TabKey[] = ['range', 'matrix', 'trend', 'competitors'];

type DetailState = {
  tab: string | undefined;
  market_id: string | undefined;
  retailer_id: string | undefined;
  category_id: string | undefined;
  /** native | reporting | ISO code */
  currency: string | undefined;
  /** Market shown in the price matrix when the scope holds several. */
  matrix_market: string | undefined;
  /** Row order of the price matrix: name | spread */
  matrix_order: string | undefined;
  /** Period of the trend charts: 30 | 90 */
  days: string | undefined;
  /** Sort of the range table. */
  range_sort: string | undefined;
  /** Product search of the range table and the price matrix. */
  product_q: string | undefined;
};

const DEFAULTS: DetailState = {
  tab: 'range',
  market_id: undefined,
  retailer_id: undefined,
  category_id: undefined,
  currency: 'native',
  matrix_market: undefined,
  matrix_order: 'name',
  days: '30',
  range_sort: 'name',
  product_q: undefined,
};

/** "6.3% below" / "in line with" / "4.0% above" — the own side of an index against the other side. */
function indexGap(index: number): string {
  const gap = index - 100;
  return Math.abs(gap) < 0.5 ? 'in line with' : `${fmtPct(Math.abs(gap), 1)} ${gap > 0 ? 'above' : 'below'}`;
}

function HeaderTiles({ data, onPromotions }: { data: BrandDetailResult; onPromotions: () => void }) {
  const b = data.brand;
  const notListed = b.products_total - b.products;
  const idx = b.price_index;
  const notFresh = [b.freshness.stale ? `${fmtNumber(b.freshness.stale)} stale` : null, b.freshness.never_observed ? `${fmtNumber(b.freshness.never_observed)} never observed` : null].filter(Boolean);
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <StatTile
        label="Listed products"
        value={fmtNumber(b.products)}
        detail={notListed > 0 ? `${fmtNumber(notListed)} of ${fmtNumber(b.products_total)} not listed here` : b.products_total > 0 ? 'the whole range is listed' : 'no product in the catalogue'}
        icon={Package}
      />
      <StatTile
        label="Retailer listings"
        value={fmtNumber(b.listings)}
        detail={b.listings === 0 ? 'none in this scope' : `${fmtNumber(b.freshness.fresh)} fresh${notFresh.length ? ` · ${notFresh.join(' · ')}` : ''}`}
        tone={b.freshness.stale + b.freshness.never_observed > 0 ? 'warn' : 'default'}
        title="Fresh listings were observed recently enough for their source's schedule. Only they count towards current prices."
      />
      <StatTile label="Retailers" value={fmtNumber(b.retailers)} detail={`in ${fmtNumber(b.markets)} market${b.markets === 1 ? '' : 's'}`} />
      <StatTile
        label="On promotion"
        value={b.promo.share_pct === null ? '—' : fmtPct(b.promo.share_pct, b.promo.share_pct > 0 && b.promo.share_pct < 10 ? 1 : 0)}
        detail={
          b.promo.share_pct === null
            ? 'no fresh listing'
            : b.promo.listings === 0
              ? 'no fresh listing on promotion'
              : `${fmtNumber(b.promo.listings)} of ${fmtNumber(b.freshness.fresh)} fresh listings${b.promo.avg_discount_pct !== null ? ` · avg ${fmtPct(b.promo.avg_discount_pct, 0)} off` : ''}`
        }
        icon={Tag}
        onClick={onPromotions}
        title="Open the brand’s promotions"
      />
      <StatTile
        label="Price moves · 7 days"
        value={
          <span className="num inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <ArrowUp className="size-4 text-crit-ink" aria-hidden />
              {fmtNumber(b.moves_7d.increases)}
              <span className="sr-only"> increases</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <ArrowDown className="size-4 text-good-ink" aria-hidden />
              {fmtNumber(b.moves_7d.decreases)}
              <span className="sr-only"> decreases</span>
            </span>
          </span>
        }
        detail={`30 days: ${fmtNumber(b.moves_30d.increases)} up · ${fmtNumber(b.moves_30d.decreases)} down`}
      />
      <StatTile
        label="Price index"
        value={idx?.index === null || idx?.index === undefined ? '—' : idx.index.toFixed(1)}
        detail={
          !idx
            ? 'no approved mapping with current prices'
            : idx.index === null
              ? 'mapped products are not comparable'
              : `${idx.perspective === 'own_vs_competitors' ? `${indexGap(idx.index)} mapped competitors` : `own products ${indexGap(idx.index)} this brand`} · ${fmtNumber(idx.pairs)} pair${idx.pairs === 1 ? '' : 's'}`
        }
        title="Own ÷ competitor price × 100 over approved mappings at the same retailer. 100 = parity."
      />
    </div>
  );
}

export default function BrandDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const id = Number(params.id);
  const valid = Number.isInteger(id) && id > 0;
  const { state, set } = useUrlState<DetailState>(DEFAULTS);
  const dates = useDates();
  const reportingCurrency = dates.data?.reporting_currency ?? 'USD';
  const options = useScopeOptions(state.market_id);

  const tab: TabKey = TABS.includes(state.tab as TabKey) ? (state.tab as TabKey) : 'range';
  // A tab reports its selection on pointer-down and again on focus, before the URL has changed: without this guard
  // one click would leave two history entries and "Back" would appear to do nothing.
  const requestedTab = useRef(tab);
  requestedTab.current = tab;
  const setProductQuery = useCallback((next: string) => set({ product_q: next || undefined }), [set]);
  const selectTab = (next: TabKey) => {
    if (next === requestedTab.current) return;
    requestedTab.current = next;
    set({ tab: next }, { replace: false });
  };
  const currency = state.currency ?? 'native';
  const days = state.days === '90' ? '90' : '30';

  const query = useApiQuery<BrandDetailResult>(
    [BRANDS, 'detail', id],
    `/brand-explorer/${id}`,
    {
      market_id: state.market_id,
      retailer_id: state.retailer_id,
      category_id: state.category_id,
      matrix_market_id: /^\d+$/.test(state.matrix_market ?? '') ? state.matrix_market : undefined,
      days,
      currency: currency === 'native' ? undefined : currency,
    },
    { enabled: valid },
  );
  // While another brand loads, the previous brand's figures must not appear under the new address.
  const data = query.data && query.data.brand.id === id ? query.data : undefined;

  /** Scope filters carried into links to other screens. */
  const scope = useMemo<Query>(
    () => ({ market_id: state.market_id, retailer_id: state.retailer_id, category_id: state.category_id, currency: currency === 'native' ? undefined : currency }),
    [state.market_id, state.retailer_id, state.category_id, currency],
  );
  const dimensions = useMemo<Query>(() => ({ market_id: state.market_id, retailer_id: state.retailer_id, category_id: state.category_id }), [state.market_id, state.retailer_id, state.category_id]);
  const scopeCount = [state.market_id, state.retailer_id, state.category_id].filter(Boolean).length + (currency !== 'native' ? 1 : 0);

  const back = (
    <Link to={`/brands${toQueryString(scope)}`} className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink">
      <ArrowLeft className="size-3.5" aria-hidden /> Brand Explorer
    </Link>
  );

  if (!valid || (query.isError && query.error instanceof ApiError && query.error.status === 404)) {
    return (
      <Page>
        {back}
        <Card>
          <EmptyState icon={Tags} title="Brand not found" description="It may have been deleted, or the link is incorrect." action={<LinkButton to="/brands">Back to the Brand Explorer</LinkButton>} />
        </Card>
      </Page>
    );
  }
  if (query.isError && !data) {
    return (
      <Page>
        {back}
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      </Page>
    );
  }
  if (!data) {
    return (
      <Page>
        {back}
        <LoadingBlock className="min-h-64" label="Loading brand…" />
      </Page>
    );
  }

  const b = data.brand;
  const productQuery = state.product_q ?? '';
  const promotionsHref = `/promotions${toQueryString({ ...dimensions, brand_id: b.id })}`;

  return (
    <Page>
      {back}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="eyebrow mb-1">{b.ownership === 'own' ? 'Own brand' : 'Competitor brand'}</div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] break-words text-ink">{b.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px] text-ink-3">
            <OwnershipBadge ownership={b.ownership} />
            {b.is_demo ? <DemoBadge /> : null}
            {!b.is_active ? <Badge tone="outline">Inactive in the catalogue</Badge> : null}
            {b.manufacturer ? <span>{b.manufacturer}</span> : null}
            <span aria-hidden>·</span>
            {b.freshness.last_observed_at ? (
              <span>
                Last observed <LastObserved iso={b.freshness.last_observed_at} className="text-ink-2" />
              </span>
            ) : (
              <span>{b.listings === 0 ? 'Not listed in this scope' : 'No price observed yet'}</span>
            )}
          </div>
          {b.tags?.length ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ink-3">
              <span>
                Deal tags now · {fmtNumber(b.tagged_listings ?? 0)} listing{b.tagged_listings === 1 ? '' : 's'}
              </span>
              <TagCounts tags={b.tags} counts={b.tag_counts} max={6} />
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LinkButton to={`/catalogue${toQueryString({ brand_id: b.id, category_id: state.category_id, market_id: state.market_id })}`} icon={Package} title="The brand’s products in the Product Catalogue">
            Catalogue
          </LinkButton>
          <LinkButton to={`/history${toQueryString({ ...dimensions, brand_id: b.id })}`} icon={ChartLine} title="The brand in the Historical Price Explorer">
            Price history
          </LinkButton>
          <LinkButton to={promotionsHref} icon={Tag} title="The brand’s promotions">
            Promotions
          </LinkButton>
          <LinkButton to={`/monitor${toQueryString({ ...dimensions, brand_id: b.id })}`} icon={Radar} title="The brand’s listings in the Live Price Monitor">
            Live prices
          </LinkButton>
        </div>
      </header>

      <FilterBar
        trailing={<CurrencySelect label="Prices in" value={currency} reportingCurrency={reportingCurrency} onChange={(v) => set({ currency: v })} />}
      >
        <MultiSelect label="Market" options={options.market} value={toList(state.market_id)} onChange={(next) => set({ market_id: fromList(next), retailer_id: undefined, matrix_market: undefined })} />
        <MultiSelect label="Retailer" options={options.retailer} value={toList(state.retailer_id)} onChange={(next) => set({ retailer_id: fromList(next) })} searchable />
        <MultiSelect label="Category" options={options.category} value={toList(state.category_id)} onChange={(next) => set({ category_id: fromList(next) })} />
        {scopeCount > 0 ? (
          <Button variant="ghost" icon={X} onClick={() => set({ market_id: undefined, retailer_id: undefined, category_id: undefined, currency: undefined, matrix_market: undefined })}>
            Reset
          </Button>
        ) : null}
      </FilterBar>

      <div className={cn('transition-opacity', isRefetching(query) && 'opacity-60')}>
        <DemoNotice demo={data.demo} className="mb-4" />
        {data.unmatched.count > 0 ? (
          <Notice tone="info" icon={Link2} className="mb-4">
            <strong className="font-semibold text-ink">
              {fmtNumber(data.unmatched.count)} unmatched listing{data.unmatched.count === 1 ? '' : 's'}
            </strong>{' '}
            {data.unmatched.count === 1 ? 'names' : 'name'} “{data.unmatched.search}” in {data.unmatched.count === 1 ? 'its' : 'their'} title. Until {data.unmatched.count === 1 ? 'it is' : 'they are'} matched to a product, {data.unmatched.count === 1 ? 'it is' : 'they are'} not part
            of any figure on this page.{' '}
            <Link to={`/catalogue${toQueryString({ tab: 'matching', mq: data.unmatched.search, m_market: state.market_id, m_retailer: state.retailer_id })}`} className="link whitespace-nowrap">
              Review in the matching queue
            </Link>
          </Notice>
        ) : null}

        <HeaderTiles data={data} onPromotions={() => navigate(promotionsHref)} />
        <FxNote conversions={data.conversions} missing={data.missing_rates} target={data.target_currency} className="mb-4" />

        <Tabs<TabKey>
          value={tab}
          onChange={selectTab}
          tabs={[
            { value: 'range', label: 'Range', count: data.range.length },
            { value: 'matrix', label: 'Price matrix' },
            { value: 'trend', label: 'Trend' },
            { value: 'competitors', label: b.ownership === 'own' ? 'Competing brands' : 'Compared with', count: data.competitors.length },
          ]}
        >
          <TabPanel value="range">
            <RangeTab data={data} scope={scope} sort={state.range_sort ?? 'name'} onSort={(next) => set({ range_sort: next })} query={productQuery} onQuery={setProductQuery} onConvert={() => set({ currency: 'reporting' })} reportingCurrency={reportingCurrency} />
          </TabPanel>
          <TabPanel value="matrix">
            <MatrixTab
              data={data}
              brandId={b.id}
              order={state.matrix_order === 'spread' ? 'spread' : 'name'}
              onOrder={(next) => set({ matrix_order: next })}
              onMarket={(next) => set({ matrix_market: next })}
              query={productQuery}
              onQuery={setProductQuery}
            />
          </TabPanel>
          <TabPanel value="trend">
            <TrendTab data={data} days={days} onDays={(next) => set({ days: next })} onConvert={() => set({ currency: 'reporting' })} reportingCurrency={reportingCurrency} scope={dimensions} />
          </TabPanel>
          <TabPanel value="competitors">
            <CompetitorsTab data={data} scope={scope} />
          </TabPanel>
        </Tabs>
      </div>
    </Page>
  );
}
