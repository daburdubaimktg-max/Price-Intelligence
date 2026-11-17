/** Competitor Intelligence — landing view: how own products are positioned against their mapped competitors. */
import { useMemo, useState } from 'react';
import { Ban, Scale } from 'lucide-react';
import { fmtNumber, fmtPct, plural } from '@/lib/format.ts';
import { useApiQuery, useIsNarrow } from '@/lib/hooks.ts';
import { Badge, Card, CardHeader, cn, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { DIVERGING } from '@/components/charts/kit.tsx';
import { IndexScale, SegmentedBar } from '@/components/charts/charts.tsx';
import { DemoBadge, DemoNotice, ProductCell } from '@/components/domain/domain.tsx';
import type { OwnProductPosition, PositionGroup, Positioning } from '@shared/api/analytics.ts';
import type { Query } from '@/lib/api.ts';
import { isRefetching } from '../history/parts.tsx';

interface OverviewResponse {
  products: OwnProductPosition[];
  positioning: Positioning;
}

/** Plain-language reading of a price index (100 = parity). */
export function indexReading(index: number | null, subject = 'Own products'): string {
  if (index === null) return 'No comparable prices yet.';
  const premium = index - 100;
  if (Math.abs(premium) < 0.5) return `${subject} are priced in line with their mapped competitors.`;
  return `${subject} are priced ${fmtPct(Math.abs(premium), 1)} ${premium > 0 ? 'above' : 'below'} their mapped competitors on average.`;
}

const POSITION_META: Record<OwnProductPosition['position'], { label: string; dot?: string; tone: 'neutral' | 'warn' | 'outline'; hint: string }> = {
  premium: { label: 'Premium', dot: DIVERGING.positive, tone: 'neutral', hint: 'Priced more than 2% above mapped competitors.' },
  parity: { label: 'Parity', dot: '#8a8f9c', tone: 'neutral', hint: 'Within 2% of mapped competitors.' },
  discount: { label: 'Discount', dot: DIVERGING.negative, tone: 'neutral', hint: 'Priced more than 2% below mapped competitors.' },
  no_data: { label: 'No data', tone: 'outline', hint: 'Mappings exist, but own and competitor products have no current prices at the same retailer.' },
  not_comparable: { label: 'Not comparable', tone: 'outline', hint: 'Mapped competitors are measured in different units (e.g. g vs ml), so no index is stated.' },
  not_mapped: { label: 'Not mapped', tone: 'warn', hint: 'No approved competitor mapping yet.' },
};

export function PositionBadge({ position }: { position: OwnProductPosition['position'] }) {
  const meta = POSITION_META[position];
  return (
    <Badge tone={meta.tone} title={meta.hint} icon={position === 'not_comparable' ? Ban : undefined}>
      {meta.dot ? <span aria-hidden className="size-1.5 rounded-full" style={{ background: meta.dot }} /> : null}
      {meta.label}
    </Badge>
  );
}

function IndexValue({ index, pairs }: { index: number | null; pairs?: number }) {
  if (index === null) return <span className="text-ink-4">—</span>;
  return (
    <span className="inline-flex items-center justify-end gap-2.5 whitespace-nowrap">
      <span className="hidden sm:inline">
        <IndexScale value={index} width={88} />
      </span>
      <span className="num w-11 text-right font-semibold text-ink">{index.toFixed(1)}</span>
      {pairs !== undefined ? <span className="num hidden w-16 text-right text-[11.5px] text-ink-3 lg:inline">{plural(pairs, 'pair')}</span> : null}
    </span>
  );
}

function Breakdown({ title, groups }: { title: string; groups: PositionGroup[] }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-2">{title}</div>
      {groups.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">No comparable pairs.</p>
      ) : (
        <ul className="flex flex-col">
          {groups.map((g) => (
            <li key={g.key} className="flex items-center justify-between gap-3 border-b border-line py-1.5 text-[13px] last:border-0">
              <span className="min-w-0 truncate text-ink-2">{g.label}</span>
              <IndexValue index={g.index} pairs={g.pairs} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type SortKey = 'product' | 'index' | 'pairs' | 'mappings';

export function OverviewView({ query: scope, onSelect }: { query: Query; onSelect: (productId: number) => void }) {
  const query = useApiQuery<OverviewResponse>(['competitors', 'overview'], '/competitors/overview', scope);
  const [sort, setSort] = useState<string>('product');
  const narrow = useIsNarrow(639);
  const data = query.data;

  const rows = useMemo(() => {
    const list = [...(data?.products ?? [])];
    const desc = sort.startsWith('-');
    const key = sort.replace(/^-/, '') as SortKey;
    const value = (p: OwnProductPosition): number | string | null =>
      key === 'index' ? p.index : key === 'pairs' ? p.pairs : key === 'mappings' ? p.approved_mappings : `${p.brand_name} ${p.product_name}`.toLowerCase();
    list.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // products without an index always sink to the bottom
      if (vb === null) return -1;
      const cmp = typeof va === 'string' ? va.localeCompare(String(vb)) : va - (vb as number);
      return desc ? -cmp : cmp;
    });
    return list;
  }, [data, sort]);

  const columns = useMemo<Array<Column<OwnProductPosition>>>(
    () => [
      {
        key: 'product',
        header: 'Own product',
        sortKey: 'product',
        nowrap: false,
        cell: (p) =>
          narrow ? (
            // phones: the name wraps instead of being cut, and the position sits under it
            <div className="max-w-[13.5rem]">
              <span className="block text-[13px] leading-[18px] font-medium break-words text-ink">{p.product_name}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] leading-4 text-ink-3">
                {[p.brand_name, p.pack].filter(Boolean).join(' · ')}
                {p.is_demo ? <DemoBadge /> : null}
              </span>
            </div>
          ) : (
            <div className="max-w-[17rem] min-w-44">
              <ProductCell name={p.product_name} brand={p.brand_name} pack={[p.pack, p.category_name].filter(Boolean).join(' · ')} ownership="own" isDemo={p.is_demo} />
            </div>
          ),
      },
      {
        key: 'mappings',
        header: 'Mappings',
        sortKey: 'mappings',
        cell: (p) => (
          <span className="inline-flex flex-col items-start gap-0.5 whitespace-nowrap">
            <span className="num text-ink-2">{fmtNumber(p.approved_mappings)} approved</span>
            {p.suggested_mappings > 0 ? <span className="num text-[11.5px] leading-4 font-medium text-accent">{p.suggested_mappings} suggested</span> : null}
          </span>
        ),
        hideBelow: 'md',
      },
      {
        key: 'pairs',
        header: 'Compared',
        align: 'right',
        sortKey: 'pairs',
        headerTitle: 'Same-retailer price comparisons with a current price on both sides',
        cell: (p) =>
          p.pairs === 0 ? (
            <span className="text-ink-4">—</span>
          ) : (
            <span className="inline-flex flex-col items-end">
              <span>{plural(p.pairs, 'pair')}</span>
              <span className="text-[11px] leading-4 text-ink-3">
                {fmtNumber(p.retailers)} retailer{p.retailers === 1 ? '' : 's'} · {fmtNumber(p.markets)} market{p.markets === 1 ? '' : 's'}
              </span>
            </span>
          ),
        hideBelow: 'sm',
      },
      {
        key: 'index',
        header: 'Price index',
        align: 'right',
        sortKey: 'index',
        headerTitle: 'Own ÷ competitor price × 100 (100 = parity)',
        cell: (p) =>
          narrow ? (
            <span className="inline-flex flex-col items-end gap-1">
              <IndexValue index={p.index} />
              <PositionBadge position={p.position} />
            </span>
          ) : (
            <IndexValue index={p.index} />
          ),
      },
      { key: 'position', header: 'Position', cell: (p) => <PositionBadge position={p.position} />, hideBelow: 'sm' },
      {
        key: 'against',
        header: 'Against competitors',
        nowrap: false,
        headerTitle: 'Average gap against the mapped competitor the own product is cheapest against, and the one it is dearest against',
        cell: (p) => {
          if (!p.cheapest_vs) return <span className="text-ink-4">—</span>;
          const lines = p.dearest_vs && p.dearest_vs.product_name !== p.cheapest_vs.product_name ? [p.cheapest_vs, p.dearest_vs] : [p.cheapest_vs];
          return (
            <span className="block max-w-60 min-w-36 text-[12px] leading-[17px]">
              {lines.map((line) => (
                <span key={line.product_name} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-ink-2">{line.product_name}</span>
                  <span className="num shrink-0 font-medium text-ink">{fmtPct(line.gap_pct, 1, true)}</span>
                </span>
              ))}
            </span>
          );
        },
        hideBelow: 'lg',
      },
    ],
    [narrow],
  );

  if (query.isError && !data) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
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

  const overall = data.positioning.overall;
  const parityPairs = Math.max(0, overall.pairs - overall.cheaper_pairs - overall.dearer_pairs);
  const pairParts = [
    { key: 'cheaper', label: 'Own cheaper', value: overall.cheaper_pairs, color: DIVERGING.negative },
    { key: 'parity', label: 'Parity (±0.5)', value: parityPairs, color: '#b7bac3' },
    { key: 'dearer', label: 'Own dearer', value: overall.dearer_pairs, color: DIVERGING.positive },
  ];

  return (
    <div className={cn('transition-opacity', isRefetching(query) && 'opacity-60')}>
      <DemoNotice demo={data.positioning.demo} className="mb-4" />
      <Card className="mb-5">
        <div className="grid gap-x-8 gap-y-5 p-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="min-w-0">
            <div className="text-[12px] leading-4 font-medium text-ink-3">Price index against mapped competitors</div>
            <div className="mt-1 flex items-end gap-3">
              <span className="text-[40px] leading-[44px] font-semibold tracking-[-0.02em] text-ink">{overall.index === null ? '—' : overall.index.toFixed(1)}</span>
              {overall.index !== null ? <IndexScale value={overall.index} width={140} className="mb-4" /> : null}
            </div>
            <p className="mt-1 text-[13.5px] leading-5 font-medium text-ink">{indexReading(overall.index)}</p>
            <p className="mt-1 text-[12.5px] leading-5 text-ink-3">
              {plural(overall.pairs, 'same-retailer comparison')} of {plural(overall.own_products, 'own product')} against {plural(overall.competitor_products, 'competitor product')} at{' '}
              {plural(overall.retailers, 'retailer')}.
            </p>
            {overall.pairs > 0 ? (
              <div className="mt-3">
                <SegmentedBar parts={pairParts} />
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
                  {pairParts.map((p) => (
                    <li key={p.key} className="flex items-center gap-1.5">
                      <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: p.color }} />
                      {p.label} <span className="num font-medium text-ink">{fmtNumber(p.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <div className="min-w-0 border-t border-line pt-4 text-[12.5px] leading-5 text-ink-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
            <div className="eyebrow mb-2">How to read this</div>
            <ul className="flex list-disc flex-col gap-1.5 pl-4">
              <li>
                <strong className="font-semibold text-ink-2">100 means parity.</strong> Above 100 the own product is more expensive than the competitor, below 100 it is cheaper.
              </li>
              <li>Each own product is compared with its approved competitor mappings at the same retailer — same shelf, same currency — using current prices no older than 30 days.</li>
              <li>Shelf prices are compared when packs are identical. Where pack sizes differ, or a mapping is marked non-equivalent, unit prices (per 100 ml / 100 g / unit) are compared instead.</li>
              <li>
                Products measured in different units (grams vs millilitres) are never given an index
                {data.positioning.not_comparable_pairs > 0 ? (
                  <>
                    :{' '}
                    <strong className="font-semibold text-ink-2">
                      {data.positioning.not_comparable_pairs === 1 ? '1 such pair is excluded' : `${fmtNumber(data.positioning.not_comparable_pairs)} such pairs are excluded`}
                    </strong>{' '}
                    from the figures here.
                  </>
                ) : (
                  '.'
                )}
              </li>
            </ul>
          </div>
        </div>
        <div className="grid gap-x-8 gap-y-5 border-t border-line p-4 md:grid-cols-3">
          <Breakdown title="By category" groups={data.positioning.by_category} />
          <Breakdown title="By own brand" groups={data.positioning.by_brand} />
          <Breakdown title="By market" groups={data.positioning.by_market} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Own products"
          subtitle="Select a product to compare it with its mapped competitors across retailers and markets."
        />
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.product_id}
          sort={sort}
          onSort={setSort}
          onRowClick={(p) => onSelect(p.product_id)}
          dense
          empty={<EmptyState icon={Scale} title="No own-brand products in this scope" description="Add own-brand products in the Product Catalogue, or relax the filters." />}
        />
      </Card>
    </div>
  );
}
