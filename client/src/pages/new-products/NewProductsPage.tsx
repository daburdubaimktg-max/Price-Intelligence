/**
 * New Products (route "/new-products"): the listings that appeared at a retailer after its first load, from
 * GET /api/new-listings — possible launches, kept apart from known products that reached another retailer.
 * What is shown is what collection runs found; nothing is matched or created automatically.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { ClipboardCheck, PackagePlus, Scale, Store, X } from 'lucide-react';
import { COLLECTION_METHOD_LABELS } from '@shared/constants.ts';
import type { NewListingBaseline, NewListingSource, NewListingsResponse } from '@shared/api/new-listings.ts';
import { Page } from '@/app/AppShell.tsx';
import { DemoNotice } from '@/components/domain/domain.tsx';
import { ListingDrawer } from '@/components/domain/observations.tsx';
import { FilterBar, MultiSelect, SearchInput } from '@/components/ui/filters.tsx';
import { Badge, Button, Card, CardHeader, Checkbox, cn, ErrorState, LoadingBlock, Notice, PageHeader, Segmented, Select, StatTile } from '@/components/ui/primitives.tsx';
import { fmtDateTimeShort, fmtNumber, plural } from '@/lib/format.ts';
import { fromList, toList, useApiQuery } from '@/lib/hooks.ts';
import { NewListingsChart } from './NewListingsChart.tsx';
import { NewListingsList } from './NewListingsList.tsx';
import { KIND_LABELS, OWNERSHIP_OPTIONS, PERIOD_OPTIONS, SORT_OPTIONS, useNewProductFilters } from './filters.ts';

const DISCOVERY_META: Record<NewListingSource['discovery'], { label: string; tone: 'good' | 'warn' | 'neutral'; title: string }> = {
  on: { label: 'On', tone: 'good', title: 'Items of the source that are not listings yet are added as unmatched listings for review' },
  off: { label: 'Off', tone: 'warn', title: 'This source only reads the listings it already knows. Switch on “Add unknown items as unmatched listings” in its settings.' },
  not_supported: { label: 'Not with this method', tone: 'neutral', title: 'This method only reads the listings it is given; new listings arrive when somebody adds or imports them.' },
};

function SourcesTable({ sources }: { sources: NewListingSource[] }) {
  if (!sources.length) return <p className="text-[12.5px] text-ink-3">No retailer is set up within these filters.</p>;
  return (
    <div className="table-wrap rounded-md border border-line">
      <table className="grid-table is-dense">
        <thead>
          <tr>
            <th scope="col">Retailer</th>
            <th scope="col" className="hidden sm:table-cell">How prices arrive</th>
            <th scope="col" title="Whether a collection run adds items it does not know as unmatched listings">Finds unknown products</th>
            <th scope="col" className="hidden md:table-cell" title="First sighting of any listing of the retailer; listings first seen within 48 hours of it belong to the first load">
              First load
            </th>
            <th scope="col" style={{ textAlign: 'right' }}>
              Listings
            </th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => {
            const meta = DISCOVERY_META[s.discovery];
            return (
              <tr key={s.retailer_id}>
                <td>
                  <span className="text-ink">{s.retailer_name}</span> <span className="text-ink-3">· {s.market_code}</span>
                  {s.is_demo ? (
                    <Badge tone="demo" className="ml-1.5">
                      DEMO
                    </Badge>
                  ) : null}
                </td>
                <td className="hidden sm:table-cell">{COLLECTION_METHOD_LABELS[s.collection_method] ?? s.collection_method}</td>
                <td>
                  <Badge tone={meta.tone} title={meta.title}>
                    {meta.label}
                  </Badge>
                </td>
                <td className="hidden md:table-cell">
                  {s.baseline_started_at ? (
                    <>
                      <span className="num">{fmtDateTimeShort(s.baseline_started_at)}</span>
                      {s.baseline_ends_at && Date.parse(s.baseline_ends_at) > Date.now() ? (
                        <span className="block text-[11px] leading-4 text-ink-3">still open: listings seen until {fmtDateTimeShort(s.baseline_ends_at)} belong to it</span>
                      ) : null}
                    </>
                  ) : (
                    'No listings yet'
                  )}
                </td>
                <td className="num" style={{ textAlign: 'right' }}>
                  {fmtNumber(s.listings)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Brands met at a retailer for the first time within the period: baselines of their own (the retailers' first loads are in the table above). */
function BaselineList({ baselines }: { baselines: NewListingBaseline[] }) {
  const brands = baselines.filter((b) => b.scope === 'brand');
  if (!brands.length) return null;
  const shown = brands.slice(0, 12);
  return (
    <div>
      <div className="eyebrow mb-1.5">Brands first seen at a retailer in this period — baselines, not counted as new</div>
      <ul className="grid gap-x-6 gap-y-1 text-[12.5px] leading-5 text-ink-2 sm:grid-cols-2">
        {shown.map((b) => (
          <li key={`${b.retailer_id}:${b.brand_id ?? ''}`} className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">
              <span className="text-ink">{b.brand_name}</span> at {b.retailer_name} <span className="text-ink-3">({b.market_code}) · first seen {fmtDateTimeShort(b.started_at)}</span>
            </span>
            <span className="num shrink-0 text-ink-3">{plural(b.listings, 'listing')}</span>
          </li>
        ))}
      </ul>
      {brands.length > shown.length ? <p className="mt-1 text-[12px] text-ink-3">and {fmtNumber(brands.length - shown.length)} more.</p> : null}
      <p className="mt-1 text-[12px] text-ink-3">
        When a brand appears at a retailer for the first time, the system cannot tell a market entry from a brand that was only just added to the source. It is recorded as that brand’s baseline there.
      </p>
    </div>
  );
}

/** What the page can and cannot know, with the state of every source. Always shown: it is the method of the page. */
function HowItWorks({ data }: { data: NewListingsResponse }) {
  const able = data.sources.filter((s) => s.discovery !== 'not_supported');
  const on = able.filter((s) => s.discovery === 'on').length;
  return (
    <Card>
      <CardHeader
        title="How a listing counts as new"
        subtitle={
          able.length
            ? `Finding unknown products is switched on for ${on} of ${able.length} ${able.length === 1 ? 'source' : 'sources'} that can do it`
            : 'No source within these filters can find unknown products by itself'
        }
      />
      <div className="flex flex-col gap-4 px-4 pb-4 text-[12.5px] leading-5 text-ink-2">
        <ul className="list-disc space-y-1 pl-4">
          <li>
            <strong className="font-semibold text-ink">First seen</strong> is when this system first saw a listing — not when the retailer put it on sale. What was already on the shelf when a retailer was first
            loaded says nothing about a launch.
          </li>
          <li>
            <strong className="font-semibold text-ink">Baseline rule.</strong> A listing counts as new only if it was first seen more than {data.baseline_hours} hours after the first listing of its retailer and,
            where its brand is known, of that brand at that retailer. The first load of a retailer, or of a brand at a retailer, is a baseline — not a launch.
          </li>
          <li>
            <strong className="font-semibold text-ink">New product</strong> means nothing says the product was on sale anywhere before.{' '}
            <strong className="font-semibold text-ink">New at a retailer</strong> means the product was already listed somewhere else: a distribution change.
          </li>
          <li>
            A listing that is not matched to a product has no brand of its own. Where the page shows one, it was recognised in the retailer’s title or page address — a guess that is not stored. Nothing is matched or
            created automatically.
          </li>
        </ul>
        <div>
          <div className="eyebrow mb-1.5">Sources</div>
          <SourcesTable sources={data.sources} />
          <p className="mt-1.5 text-[12px] text-ink-3">
            The switch is “Add unknown items as unmatched listings”, in Administration → Retailers &amp; listings → the source’s settings (feeds, APIs and data providers).{' '}
            <Link to="/admin?tab=retailers" className="link text-ink">
              Open the retailers
            </Link>
            . To be told about new listings, see the rule “New products found at a retailer” in{' '}
            <Link to="/alerts?tab=rules" className="link text-ink">
              Alerts Centre → Rules
            </Link>
            .
          </p>
        </div>
        <BaselineList baselines={data.baselines} />
      </div>
    </Card>
  );
}

export default function NewProductsPage() {
  const filters = useNewProductFilters();
  const { state, filter, set, reset, options, filtered, days, kind, sort } = filters;
  const [listingId, setListingId] = useState<number | null>(null);

  const query = useApiQuery<NewListingsResponse>(['new-listings'], '/new-listings', filters.query);
  const data = query.data;
  const summary = data?.summary;
  const refetching = query.isFetching && !query.isPending && query.isPlaceholderData;
  const periodLabel = `Last ${days} days`;
  const nothingYet = !!summary && summary.total === 0 && !filtered;

  return (
    <Page>
      <PageHeader
        title="New Products"
        description="Listings that appeared at a retailer after its first load: possible launches, and known products that reached another retailer. Found by collection runs — nothing is matched or created automatically."
      />

      <FilterBar>
        <Segmented label="Period" value={String(days)} onChange={(v) => filter({ days: v })} options={PERIOD_OPTIONS} />
        <MultiSelect label="Market" options={options.market} value={toList(state.market_id)} onChange={(next) => filter({ market_id: fromList(next), retailer_id: undefined })} />
        <MultiSelect label="Retailer" options={options.retailer} value={toList(state.retailer_id)} onChange={(next) => filter({ retailer_id: fromList(next) })} />
        <MultiSelect label="Brand" options={options.brand} value={toList(state.brand_id)} onChange={(next) => filter({ brand_id: fromList(next) })} />
        <Segmented label="Ownership" value={state.ownership ?? 'all'} onChange={(v) => filter({ ownership: v })} options={OWNERSHIP_OPTIONS} />
        <SearchInput value={state.q ?? ''} onChange={(q) => filter({ q: q || undefined })} placeholder="Search title, brand, retailer…" />
        {filtered ? (
          <Button variant="ghost" icon={X} onClick={reset}>
            Reset
          </Button>
        ) : null}
      </FilterBar>

      {query.isError && !data ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !data || !summary ? (
        <LoadingBlock className="min-h-64" label="Looking for new listings…" />
      ) : (
        <div className="flex flex-col gap-4">
          <DemoNotice demo={summary.demo} />

          {nothingYet ? (
            <Notice tone="info" icon={PackagePlus} title={`No new listings in the last ${days} days`}>
              Every listing in this selection belongs to the first load of its retailer, so there is nothing to call new yet. New products appear here after the next collection run of a source that has “Add
              unknown items as unmatched listings” switched on — the table below shows which sources do.
            </Notice>
          ) : null}

          <div className={cn('grid grid-cols-2 gap-3 transition-opacity lg:grid-cols-4', refetching && 'opacity-60')}>
            <StatTile
              label="New products"
              value={fmtNumber(summary.new_products)}
              detail="not seen anywhere before"
              icon={PackagePlus}
              onClick={() => filter({ kind: kind === 'new_product' ? 'all' : 'new_product' })}
              title="Listings whose product was not on sale anywhere before, as far as the stored records show. Click to filter."
            />
            <StatTile
              label="New at a retailer"
              value={fmtNumber(summary.new_at_retailer)}
              detail="already listed elsewhere"
              icon={Store}
              onClick={() => filter({ kind: kind === 'new_at_retailer' ? 'all' : 'new_at_retailer' })}
              title="Known products that appeared at another retailer: a distribution change, not a launch. Click to filter."
            />
            <StatTile
              label="Needs review"
              value={fmtNumber(summary.needs_review)}
              detail="unmatched: match, create or ignore"
              icon={ClipboardCheck}
              tone={summary.needs_review > 0 ? 'warn' : 'default'}
            />
            <StatTile
              label="Own brands vs competitors"
              value={
                <span>
                  {fmtNumber(summary.own)} <span className="text-ink-3">·</span> {fmtNumber(summary.competitor)}
                </span>
              }
              detail={summary.unrecognised > 0 ? `plus ${fmtNumber(summary.unrecognised)} with no recognised brand` : 'own · competitor'}
              icon={Scale}
            />
          </div>

          {summary.total > 0 ? <NewListingsChart series={data.series} refetching={refetching} periodLabel={periodLabel} /> : null}

          {summary.total > 0 || filtered ? (
            <Card>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 text-[12.5px] leading-5 text-ink-3">
                <span className="min-w-0 flex-1 basis-full lg:basis-0">
                  <span className="num font-semibold text-ink">{fmtNumber(data.total)}</span> {data.total === 1 ? 'listing' : 'listings'}
                  {filtered ? ' match the filters' : ` first seen in the last ${days} days`}
                  {summary.latest_first_seen_at ? <span className="hidden lg:inline"> · latest {fmtDateTimeShort(summary.latest_first_seen_at)}</span> : null}
                </span>
                <Segmented
                  label="Kind"
                  size="sm"
                  value={kind ?? 'all'}
                  onChange={(v) => filter({ kind: v })}
                  options={[
                    { value: 'all', label: `All ${fmtNumber(summary.total)}` },
                    { value: 'new_product', label: `${KIND_LABELS.new_product} ${fmtNumber(summary.new_products)}` },
                    { value: 'new_at_retailer', label: `${KIND_LABELS.new_at_retailer} ${fmtNumber(summary.new_at_retailer)}` },
                  ]}
                />
                {summary.ignored > 0 || state.include_ignored === 'true' ? (
                  <Checkbox
                    label={`Include ignored (${fmtNumber(summary.ignored)})`}
                    checked={state.include_ignored === 'true'}
                    onChange={(e) => filter({ include_ignored: e.target.checked ? 'true' : undefined })}
                  />
                ) : null}
                <label className="flex items-center gap-2 whitespace-nowrap">
                  Sort by
                  <Select className="w-44" value={sort} onChange={(e) => set({ sort: e.target.value, page: undefined })} aria-label="Sort the listings by">
                    {SORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <NewListingsList
                data={data}
                loading={query.isPending}
                refetching={refetching}
                sort={sort}
                onPage={(page) => set({ page: String(page) })}
                onOpen={setListingId}
                selectedId={listingId}
                filtered={filtered || kind !== undefined}
                onReset={reset}
              />
            </Card>
          ) : null}

          <HowItWorks data={data} />
        </div>
      )}

      <ListingDrawer listingId={listingId} onClose={() => setListingId(null)} />
    </Page>
  );
}
