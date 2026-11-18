/**
 * The comparison of the current deals (GET /api/deals/compare), drawn:
 *   ShareCompare   how much of each range is on offer and at what average discount — by brand, product range,
 *                  retailer or market, own brands beside competitors
 *   DepthMix       how each brand's offers are spread over discount depths
 *   HeatGrid       where each brand is on offer (brand × retailer) and with which kind of offer (brand × tag)
 *   OfferTrend     share of the range on offer per day over the last 30 days
 *
 * The range a share is measured against is every fresh, priced listing of the selection, on offer or not, so
 * brands and retailers of different sizes can be compared. Only counts and percentages are shown.
 */
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { DEAL_DISCOUNT_BANDS, type DealCompareBrand, type DealCompareGroup, type DealsComparison, type DealShare } from '@shared/api/deals.ts';
import { DEAL_OFFER_TAGS, DEAL_TAG_LABELS, type DealTag } from '@shared/constants.ts';
import { TimeSeriesChart, type Series } from '@/components/charts/charts.tsx';
import { ChartEmpty, ChartFrame, ChartTooltip, COMPETITOR_COLOR, DEEMPHASIS, Legend, OWN_COLOR, useSize, type LegendItem, type TableView } from '@/components/charts/kit.tsx';
import { OwnershipDot } from '@/components/domain/domain.tsx';
import { cn, ErrorState, LoadingBlock, Segmented } from '@/components/ui/primitives.tsx';
import { DASH, fmtDate, fmtNumber, fmtPct } from '@/lib/format.ts';
import { fromList, toList, useApiQuery } from '@/lib/hooks.ts';
import type { DealFilters } from './filters.ts';

const REFRESH_MS = 60_000;

/**
 * One hue for "how much", light to dark (checked with the palette validator: one hue, monotone lightness,
 * visible steps, the light end clears the surface). Violet, because blue and orange already mean own brand and
 * competitor on this screen.
 */
const DEPTH_COLORS = ['#d9d7cf', '#acadec', '#8a88e0', '#695fd1', '#4d37b7', '#311b82'] as const;
const HEAT_STEPS = ['#ecedfc', '#d2d4f8', '#b3b4f0', '#9290e6', '#7068d7', '#513cbc', '#341c88'] as const;
/** From this step on the cell is dark enough to need white text. */
const HEAT_DARK_FROM = 4;
const HEAT_ZERO = '#f3f2ee';

type FilterParam = 'brand_id' | 'category_id' | 'retailer_id' | 'market_id';
type Who = 'own' | 'competitor' | 'none';
const WHO_COLOR: Record<Who, string> = { own: OWN_COLOR, competitor: COMPETITOR_COLOR, none: DEEMPHASIS };
const WHO_LABEL: Record<Who, string> = { own: 'Own brands', competitor: 'Competitors', none: 'Unmatched' };
const OWNERSHIP_LEGEND: LegendItem[] = [
  { key: 'own', label: 'Own brands', color: OWN_COLOR, shape: 'rect' },
  { key: 'competitor', label: 'Competitors', color: COMPETITOR_COLOR, shape: 'rect' },
];

const pct = (value: number | null | undefined, decimals = 1) => (value === null || value === undefined ? DASH : fmtPct(value, decimals));
const brandKey = (brandId: number | null) => (brandId === null ? 'none' : String(brandId));
const whoOf = (ownership: string | null | undefined): Who => (ownership === 'own' ? 'own' : ownership === 'competitor' ? 'competitor' : 'none');

// ---------------------------------------------------------------------------------------------
// Share of the range on offer
// ---------------------------------------------------------------------------------------------
type Dimension = 'brand' | 'range' | 'retailer' | 'market';
const DIMENSIONS: Array<{ value: Dimension; label: string; noun: string; param: FilterParam }> = [
  { value: 'brand', label: 'Brands', noun: 'brand', param: 'brand_id' },
  { value: 'range', label: 'Product ranges', noun: 'product range', param: 'category_id' },
  { value: 'retailer', label: 'Retailers', noun: 'retailer', param: 'retailer_id' },
  { value: 'market', label: 'Markets', noun: 'market', param: 'market_id' },
];
type SortKey = 'share' | 'discount' | 'size';
const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'share', label: 'On offer' },
  { value: 'discount', label: 'Discount' },
  { value: 'size', label: 'Range size' },
];
const VISIBLE_ROWS = 12;

interface Half {
  who: Who;
  share: DealShare;
}
interface CompareRow {
  key: string;
  label: string;
  note: string | null;
  /** Ownership dot beside the label (brand rows only). */
  dot: Who | null;
  filterValue: string | null;
  halves: Half[];
  all: DealShare;
}

function groupRows(groups: DealCompareGroup[]): CompareRow[] {
  return groups.map((g) => {
    const halves: Half[] = [
      { who: 'own' as const, share: g.own },
      { who: 'competitor' as const, share: g.competitor },
    ].filter((h) => h.share.listings > 0);
    return { key: String(g.id), label: g.name, note: g.note, dot: null, filterValue: String(g.id), halves: halves.length ? halves : [{ who: 'none', share: g.all }], all: g.all };
  });
}

function brandRows(brands: DealCompareBrand[]): CompareRow[] {
  return brands.map((b) => ({
    key: brandKey(b.brand_id),
    label: b.brand_name,
    note: null,
    dot: whoOf(b.ownership),
    filterValue: b.brand_id === null ? null : String(b.brand_id),
    halves: [{ who: whoOf(b.ownership), share: b }],
    all: b,
  }));
}

/** Below this many listings a percentage says little: it is drawn quieter and labelled. */
const SMALL_BASE = 10;

function ShareBar({ half, max }: { half: Half; max: number }) {
  const value = half.share.share_pct;
  const small = half.share.listings < SMALL_BASE;
  return (
    <div
      className="flex h-5 items-center gap-2"
      title={`${WHO_LABEL[half.who]}: ${fmtNumber(half.share.deals)} of ${fmtNumber(half.share.listings)} listings on offer${small ? ' — only a few listings, read the percentage with care' : ''}`}
    >
      <div className="relative h-2 min-w-0 flex-1 rounded-full bg-wash" aria-hidden>
        <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong/70" />
        <span
          className={cn('absolute inset-y-0 left-0 rounded-r-full', small && 'opacity-40')}
          style={{ width: `${Math.min(100, ((value ?? 0) / max) * 100)}%`, background: WHO_COLOR[half.who], minWidth: value ? 2 : 0 }}
        />
      </div>
      <span className={cn('num w-[3.25rem] shrink-0 text-right text-[12.5px]', small ? 'text-ink-3' : 'font-semibold text-ink')}>{pct(value)}</span>
      <span className="num hidden w-[6.75rem] shrink-0 truncate text-[11.5px] text-ink-3 xl:inline">
        {fmtNumber(half.share.deals)} of {fmtNumber(half.share.listings)}
      </span>
    </div>
  );
}

function DiscountBar({ half, max }: { half: Half; max: number }) {
  const value = half.share.avg_discount_pct;
  return (
    <div className="flex h-5 items-center gap-2" title={value === null ? `${WHO_LABEL[half.who]}: no offer with a price cut` : `${WHO_LABEL[half.who]}: average ${pct(value)} off, deepest ${pct(half.share.max_discount_pct)}`}>
      <div className="relative h-1.5 min-w-0 flex-1 rounded-full bg-wash" aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-r-full opacity-80" style={{ width: `${Math.min(100, ((value ?? 0) / max) * 100)}%`, background: WHO_COLOR[half.who], minWidth: value ? 2 : 0 }} />
      </div>
      <span className="num w-[3.25rem] shrink-0 text-right text-[12.5px] text-ink">{pct(value)}</span>
    </div>
  );
}

function Headline({ who, share }: { who: Who; share: DealShare }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[12px] leading-4 text-ink-3">
        <OwnershipDot ownership={who === 'none' ? null : who} />
        {WHO_LABEL[who]}
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
        <span className="num text-[22px] leading-7 font-semibold tracking-tight text-ink">{pct(share.share_pct)}</span>
        <span className="text-[12.5px] text-ink-2">of the range on offer</span>
      </div>
      <div className="num text-[12px] leading-4 text-ink-3">
        {fmtNumber(share.deals)} of {fmtNumber(share.listings)} listings · average {pct(share.avg_discount_pct)} off
      </div>
    </div>
  );
}

const ShareCompare = memo(function ShareCompare({
  data, selected, onToggle, refetching,
}: {
  data: DealsComparison;
  selected: Record<FilterParam, string[]>;
  onToggle: (param: FilterParam, value: string) => void;
  refetching: boolean;
}) {
  const [dimension, setDimension] = useState<Dimension>('brand');
  const [sortKey, setSortKey] = useState<SortKey>('share');
  const [expanded, setExpanded] = useState(false);
  const meta = DIMENSIONS.find((d) => d.value === dimension)!;

  const rows = useMemo(() => {
    const list = dimension === 'brand' ? brandRows(data.brands) : groupRows(dimension === 'range' ? data.ranges : dimension === 'retailer' ? data.retailers : data.markets);
    const value = (row: CompareRow) => (sortKey === 'share' ? row.all.share_pct : sortKey === 'discount' ? row.all.avg_discount_pct : row.all.listings);
    return [...list].sort((a, b) => (value(b) ?? -1) - (value(a) ?? -1) || a.label.localeCompare(b.label));
  }, [data, dimension, sortKey]);

  const chosen = new Set(selected[meta.param]);
  // A selected row is always shown, however far down the order it is.
  const visible = expanded ? rows : rows.filter((row, i) => i < VISIBLE_ROWS || (row.filterValue !== null && chosen.has(row.filterValue)));
  const maxDiscount = Math.max(10, Math.ceil(Math.max(0, ...rows.flatMap((r) => r.halves.map((h) => h.share.avg_discount_pct ?? 0))) / 10) * 10);
  const { own, competitor } = data.totals;
  const gap = own.share_pct !== null && competitor.share_pct !== null ? own.share_pct - competitor.share_pct : null;

  const table: TableView = {
    columns: [meta.label.replace(/s$/, ''), 'Group', 'Listings in range', 'On offer', 'Share on offer', 'Average discount', 'Deepest discount'],
    numeric: [2, 3, 4, 5, 6],
    rows: rows.flatMap((row) =>
      row.halves.map((h) => [row.note ? `${row.label} (${row.note})` : row.label, WHO_LABEL[h.who], h.share.listings, h.share.deals, pct(h.share.share_pct), pct(h.share.avg_discount_pct), pct(h.share.max_discount_pct)]),
    ),
  };

  return (
    <ChartFrame
      title="How much of each range is on offer"
      subtitle={`Share of the listed range on offer right now and the average discount. Select a ${meta.noun} to filter everything on this page`}
      refetching={refetching}
      legend={<Legend items={OWNERSHIP_LEGEND} />}
      table={table}
      actions={
        <>
          <Segmented
            label="Compare by"
            size="sm"
            value={dimension}
            onChange={(v) => {
              setDimension(v);
              setExpanded(false);
              // Brands read best by how much is on offer; ranges, retailers and markets by their size (small ones swing wildly).
              setSortKey(v === 'brand' ? 'share' : 'size');
            }}
            options={DIMENSIONS.map((d) => ({ value: d.value, label: d.label }))}
          />
          <Segmented label="Sort by" size="sm" value={sortKey} onChange={setSortKey} options={SORTS} />
        </>
      }
      empty={rows.length === 0 ? <ChartEmpty title="No listings in this selection" description="Relax the filters to compare." /> : undefined}
      footer={
        data.brands_omitted > 0 && dimension === 'brand'
          ? `The ${fmtNumber(data.brands.length)} brands with the largest ranges are compared; ${fmtNumber(data.brands_omitted)} smaller ${data.brands_omitted === 1 ? 'brand is' : 'brands are'} left out.`
          : undefined
      }
    >
      <div className="grid gap-x-8 gap-y-3 border-b border-line pb-3 sm:grid-cols-[auto_auto_minmax(0,1fr)]">
        <Headline who="own" share={own} />
        <Headline who="competitor" share={competitor} />
        {gap !== null && own.listings > 0 && competitor.listings > 0 ? (
          <p className="self-end text-[12.5px] leading-5 text-ink-2 sm:text-right">
            {Math.abs(gap) < 0.05 ? (
              'Own brands and competitors have the same share of their ranges on offer.'
            ) : (
              <>
                Own brands have <strong className="num font-semibold text-ink">{fmtPct(Math.abs(gap), 1).replace('%', '')} points</strong> {gap > 0 ? 'more' : 'less'} of their range on offer than competitors.
              </>
            )}
          </p>
        ) : null}
      </div>

      <div className="mt-2 hidden grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,10rem)] gap-x-5 px-2 text-[11px] leading-4 text-ink-3 sm:grid" aria-hidden>
        <span />
        <span className="flex justify-between pr-[3.75rem] xl:pr-[11rem]">
          <span>On offer · 0%</span>
          <span>50%</span>
          <span>100%</span>
        </span>
        <span className="flex justify-between pr-[3.75rem]">
          <span>Avg. discount</span>
          <span>{maxDiscount}%</span>
        </span>
      </div>
      <ul className="mt-1 divide-y divide-line/70">
        {visible.map((row) => {
          const on = row.filterValue !== null && chosen.has(row.filterValue);
          const label = (
            <span className="flex min-w-0 items-center gap-2 text-[12.5px] leading-5">
              {row.dot ? <OwnershipDot ownership={row.dot === 'none' ? null : row.dot} /> : null}
              <span className={cn('truncate text-ink', on && 'font-semibold')}>{row.label}</span>
              {row.note ? <span className="shrink-0 text-[11.5px] text-ink-3">{row.note}</span> : null}
              {on ? <Check className="size-3 shrink-0 text-ink" strokeWidth={3} aria-hidden /> : null}
            </span>
          );
          return (
            <li key={row.key} className={cn('grid grid-cols-1 items-center gap-x-5 gap-y-0.5 px-2 py-1.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,10rem)]', on && 'bg-sunken')}>
              {row.filterValue !== null ? (
                <button
                  type="button"
                  aria-pressed={on}
                  title={on ? `Remove the ${meta.noun} filter for ${row.label}` : `Show only ${row.label}`}
                  className="-mx-1 min-w-0 rounded px-1 text-left hover:bg-wash"
                  onClick={() => onToggle(meta.param, row.filterValue!)}
                >
                  {label}
                </button>
              ) : (
                label
              )}
              <div>
                {row.halves.map((h) => (
                  <ShareBar key={h.who} half={h} max={100} />
                ))}
              </div>
              <div className="flex items-center gap-2 sm:block">
                <span className="w-24 shrink-0 text-[11px] text-ink-3 sm:hidden">Avg. discount</span>
                <div className="min-w-0 flex-1">
                  {row.halves.map((h) => (
                    <DiscountBar key={h.who} half={h} max={maxDiscount} />
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {rows.length > VISIBLE_ROWS ? (
        <p className="mt-2 text-[12.5px] leading-5 text-ink-3">
          <button type="button" className="link" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? `Show the first ${VISIBLE_ROWS} only` : `Show all ${fmtNumber(rows.length)} ${meta.noun}s`}
          </button>
        </p>
      ) : null}
    </ChartFrame>
  );
});

// ---------------------------------------------------------------------------------------------
// Discount depth
// ---------------------------------------------------------------------------------------------
interface Hover {
  x: number;
  y: number;
  content: ReactNode;
}

/** Tracks the pointer inside a chart container so marks can show a tooltip beside it. */
function useHover() {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  const show = (event: { clientX: number; clientY: number }, content: ReactNode) => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setHover({ x: event.clientX - box.left, y: event.clientY - box.top + 12, content });
  };
  return { ref, width: size.width, hover, show, hide: () => setHover(null) };
}

const DEEP_FROM = 4; // index of the "30–50%" band: this band and deeper count as deep offers

const DepthMix = memo(function DepthMix({ data, refetching }: { data: DealsComparison; refetching: boolean }) {
  const [mode, setMode] = useState<'share' | 'count'>('share');
  const { ref, width, hover, show, hide } = useHover();
  const rows = useMemo(
    () =>
      data.brands
        .filter((b) => b.deals > 0)
        .map((b) => ({ brand: b, deep: b.bands.slice(DEEP_FROM).reduce((a, n) => a + n, 0) / b.deals }))
        .sort((a, b) => b.deep - a.deep || a.brand.brand_name.localeCompare(b.brand.brand_name)),
    [data.brands],
  );
  const most = Math.max(1, ...rows.map((r) => r.brand.deals));
  const legend: LegendItem[] = DEAL_DISCOUNT_BANDS.map((band, i) => ({ key: band.key, label: band.short, color: DEPTH_COLORS[i]!, shape: 'rect' }));
  const table: TableView = {
    columns: ['Brand', 'Offers', ...DEAL_DISCOUNT_BANDS.map((b) => b.label), '30% off or more'],
    numeric: [1, 2, 3, 4, 5, 6, 7, 8],
    rows: rows.map((r) => [r.brand.brand_name, r.brand.deals, ...r.brand.bands, fmtPct(r.deep * 100, 0)]),
  };
  return (
    <ChartFrame
      title="How deep the offers go"
      subtitle="Each brand's offers by discount against the regular price, deepest discounters first"
      refetching={refetching}
      legend={<Legend items={legend} />}
      table={table}
      actions={
        <Segmented
          label="Bar length"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'share', label: 'Mix', title: 'Every bar is 100% of the brand’s offers' },
            { value: 'count', label: 'Number', title: 'Bar length is the number of offers' },
          ]}
        />
      }
      empty={rows.length === 0 ? <ChartEmpty title="No offers in this selection" description="Relax the filters to see the depth of the discounts." /> : undefined}
    >
      <div ref={ref} className="relative" onMouseLeave={hide}>
        <ul className="flex flex-col gap-2">
          {rows.map(({ brand, deep }) => (
            <li key={brandKey(brand.brand_id)} className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_auto] items-center gap-x-3">
              <span className="flex min-w-0 items-center gap-2 text-[12.5px] leading-5 text-ink">
                <OwnershipDot ownership={brand.ownership} />
                <span className="truncate">{brand.brand_name}</span>
              </span>
              <div className="flex h-3.5 min-w-0 gap-[2px]" role="img" aria-label={`${brand.brand_name}: ${DEAL_DISCOUNT_BANDS.map((b, i) => `${brand.bands[i]} ${b.label.toLowerCase()}`).join(', ')}`}>
                {brand.bands.map((count, i) => {
                  if (count === 0) return null;
                  const band = DEAL_DISCOUNT_BANDS[i]!;
                  const share = count / brand.deals;
                  return (
                    <span
                      key={band.key}
                      className="h-full min-w-[3px] first:rounded-l-[3px] last:rounded-r-[3px]"
                      style={{ width: `${(mode === 'share' ? share : count / most) * 100}%`, background: DEPTH_COLORS[i] }}
                      onMouseMove={(e) =>
                        show(
                          e,
                          <>
                            <div className="font-semibold text-ink">{brand.brand_name}</div>
                            <div className="mt-0.5 text-ink-2">{band.label}</div>
                            <div className="num mt-0.5 text-ink">
                              {fmtNumber(count)} {count === 1 ? 'offer' : 'offers'} · {fmtPct(share * 100, 0)} of the brand’s offers
                            </div>
                          </>,
                        )
                      }
                    />
                  );
                })}
              </div>
              <span className="num w-[5.5rem] text-right text-[12px] leading-4 text-ink-3">
                {mode === 'share' ? (
                  <>
                    <span className="font-semibold text-ink">{fmtPct(deep * 100, 0)}</span> at 30% +
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-ink">{fmtNumber(brand.deals)}</span> offers
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
        {hover ? (
          <ChartTooltip x={hover.x} y={hover.y} containerWidth={width}>
            {hover.content}
          </ChartTooltip>
        ) : null}
      </div>
    </ChartFrame>
  );
});

// ---------------------------------------------------------------------------------------------
// Heat grid: brand × retailer, brand × kind of offer
// ---------------------------------------------------------------------------------------------
type GridColumns = 'retailer' | 'tag';
type GridMetric = 'share' | 'discount';

/** Lower bounds of the seven colour steps, per reading. */
const SCALES: Record<'share' | 'discount' | 'tag', { bounds: number[]; label: string }> = {
  share: { bounds: [0, 15, 30, 45, 60, 75, 90], label: 'Share of the range on offer' },
  discount: { bounds: [0, 10, 20, 30, 40, 50, 60], label: 'Average discount' },
  tag: { bounds: [0, 2, 5, 10, 20, 35, 50], label: 'Share of the range carrying the offer' },
};

function stepOf(value: number, bounds: number[]): number {
  let step = 0;
  for (let i = 0; i < bounds.length; i++) if (value >= bounds[i]!) step = i;
  return step;
}

interface GridCell {
  value: number | null;
  /** Listings behind the cell; 0 = the brand is not listed there. */
  listings: number;
  detail: string;
}

const HeatGrid = memo(function HeatGrid({
  data, selected, onPick, refetching,
}: {
  data: DealsComparison;
  selected: Record<FilterParam, string[]>;
  onPick: (brandId: number, retailerId: number) => void;
  refetching: boolean;
}) {
  const [columnsBy, setColumnsBy] = useState<GridColumns>('retailer');
  const [metric, setMetric] = useState<GridMetric>('share');
  const { ref, width, hover, show, hide } = useHover();
  const scale = SCALES[columnsBy === 'tag' ? 'tag' : metric];

  const brands = useMemo(
    () => [...data.brands].sort((a, b) => (a.ownership === b.ownership ? b.listings - a.listings : a.ownership === 'own' ? -1 : b.ownership === 'own' ? 1 : 0)),
    [data.brands],
  );
  const retailers = useMemo(() => [...data.retailers].sort((a, b) => (a.note ?? '').localeCompare(b.note ?? '') || b.all.listings - a.all.listings), [data.retailers]);
  const cells = useMemo(() => new Map(data.cells.map((c) => [`${brandKey(c.brand_id)}|${c.retailer_id}`, c])), [data.cells]);
  const tags = DEAL_OFFER_TAGS as readonly DealTag[];

  const columns: Array<{ key: string; label: string; note: string | null }> =
    columnsBy === 'retailer' ? retailers.map((r) => ({ key: String(r.id), label: r.name, note: r.note })) : tags.map((tag) => ({ key: tag, label: DEAL_TAG_LABELS[tag], note: null }));

  const cellOf = (brand: DealCompareBrand, columnKey: string): GridCell => {
    if (columnsBy === 'tag') {
      const count = brand.tags[columnKey as DealTag] ?? 0;
      return {
        value: brand.listings > 0 ? (count / brand.listings) * 100 : null,
        listings: brand.listings,
        detail: `${fmtNumber(count)} of ${fmtNumber(brand.listings)} listings`,
      };
    }
    const cell = cells.get(`${brandKey(brand.brand_id)}|${columnKey}`);
    if (!cell) return { value: null, listings: 0, detail: 'Not listed at this retailer' };
    return {
      value: metric === 'share' ? cell.share_pct : cell.avg_discount_pct,
      listings: cell.listings,
      detail: `${fmtNumber(cell.deals)} of ${fmtNumber(cell.listings)} listings on offer · average ${pct(cell.avg_discount_pct)} off`,
    };
  };

  const table: TableView = {
    columns: ['Brand', ...columns.map((c) => (c.note ? `${c.label} (${c.note})` : c.label))],
    numeric: columns.map((_, i) => i + 1),
    rows: brands.map((b) => [b.brand_name, ...columns.map((c) => pct(cellOf(b, c.key).value))]),
  };

  return (
    <ChartFrame
      title={columnsBy === 'retailer' ? 'Where each brand is on offer' : 'Which kind of offer each brand runs'}
      subtitle={
        columnsBy === 'retailer'
          ? `${scale.label} per brand and retailer. Select a cell to see those offers`
          : 'Share of each brand’s range that carries the retailer’s offer tag (a listing can carry several)'
      }
      refetching={refetching}
      table={table}
      actions={
        <>
          <Segmented
            label="Columns"
            size="sm"
            value={columnsBy}
            onChange={setColumnsBy}
            options={[
              { value: 'retailer', label: 'Retailers' },
              { value: 'tag', label: 'Kinds of offer' },
            ]}
          />
          {columnsBy === 'retailer' ? (
            <Segmented
              label="Colour shows"
              size="sm"
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'share', label: 'On offer' },
                { value: 'discount', label: 'Discount' },
              ]}
            />
          ) : null}
        </>
      }
      empty={brands.length === 0 || columns.length === 0 ? <ChartEmpty title="No listings in this selection" description="Relax the filters to compare." /> : undefined}
      footer={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span>{scale.label}</span>
          <span className="flex items-center gap-[2px]" aria-hidden>
            {HEAT_STEPS.map((color, i) => (
              <span key={color} className="flex flex-col items-start gap-0.5">
                <span className="block h-2.5 w-7 rounded-[2px]" style={{ background: color }} />
                <span className="num text-[10.5px] leading-3">{scale.bounds[i]}%</span>
              </span>
            ))}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="block h-2.5 w-4 rounded-[2px] border border-line" style={{ background: HEAT_ZERO }} aria-hidden /> none
          </span>
          {columnsBy === 'retailer' ? (
            <span className="flex items-center gap-1.5">
              <span className="block h-2.5 w-4 rounded-[2px] border border-dashed border-line-strong" aria-hidden /> not listed
            </span>
          ) : null}
        </div>
      }
    >
      <div ref={ref} className="relative" onMouseLeave={hide}>
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-[2px] text-[11.5px] leading-4">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-[1] min-w-[7.5rem] bg-surface text-left font-normal text-ink-3">
                  Brand
                </th>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className="min-w-[3.75rem] px-1 pb-1 text-center align-bottom font-normal text-ink-2">
                    <span className="line-clamp-2">{c.label}</span>
                    {c.note ? <span className="block text-[10.5px] text-ink-3">{c.note}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {brands.map((brand) => (
                <tr key={brandKey(brand.brand_id)}>
                  <th scope="row" className="sticky left-0 z-[1] bg-surface pr-2 text-left font-normal">
                    <span className="flex min-w-0 items-center gap-2 text-[12.5px] leading-5 text-ink">
                      <OwnershipDot ownership={brand.ownership} />
                      <span className="max-w-[9rem] truncate">{brand.brand_name}</span>
                    </span>
                  </th>
                  {columns.map((c) => {
                    const cell = cellOf(brand, c.key);
                    const missing = cell.listings === 0;
                    const zero = !missing && (cell.value === null || cell.value === 0);
                    const step = missing || zero ? -1 : stepOf(cell.value!, scale.bounds);
                    const clickable = columnsBy === 'retailer' && !missing && brand.brand_id !== null;
                    const active = clickable && selected.brand_id.includes(String(brand.brand_id)) && selected.retailer_id.includes(c.key);
                    const tip = (
                      <>
                        <div className="font-semibold text-ink">
                          {brand.brand_name} · {c.label}
                          {c.note ? ` (${c.note})` : ''}
                        </div>
                        <div className="num mt-0.5 text-ink-2">{cell.detail}</div>
                      </>
                    );
                    const body = (
                      <span
                        className={cn(
                          'num flex h-7 items-center justify-center rounded-[3px]',
                          missing && 'border border-dashed border-line-strong text-ink-4',
                          zero && 'border border-line text-ink-3',
                          active && 'ring-2 ring-ink ring-offset-1',
                        )}
                        style={missing ? undefined : { background: zero ? HEAT_ZERO : HEAT_STEPS[step], color: step >= HEAT_DARK_FROM ? '#fff' : undefined }}
                      >
                        {missing ? '·' : !zero && cell.value! < 0.5 ? '<1%' : pct(cell.value, 0)}
                      </span>
                    );
                    return (
                      <td key={c.key} className="p-0" onMouseMove={(e) => show(e, tip)}>
                        {clickable ? (
                          <button type="button" className="block w-full" aria-pressed={active} aria-label={`${brand.brand_name} at ${c.label}: ${cell.detail}`} onClick={() => onPick(brand.brand_id!, Number(c.key))}>
                            {body}
                          </button>
                        ) : (
                          body
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hover ? (
          <ChartTooltip x={hover.x} y={hover.y} containerWidth={width}>
            {hover.content}
          </ChartTooltip>
        ) : null}
      </div>
    </ChartFrame>
  );
});

// ---------------------------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------------------------
const OfferTrend = memo(function OfferTrend({ data, refetching }: { data: DealsComparison; refetching: boolean }) {
  const [by, setBy] = useState<'ownership' | 'brand'>('ownership');
  const { trend } = data;

  const series = useMemo<Series[]>(() => {
    if (by === 'brand') {
      return trend.series.map((s) => ({
        key: brandKey(s.brand_id),
        label: s.brand_name,
        sublabel: s.ownership === 'own' ? 'own' : s.ownership === 'competitor' ? 'competitor' : null,
        points: s.points.map((p) => ({ date: p.date, value: p.share_pct })),
      }));
    }
    // Own brands and competitors: listings and offers are summed per day, the share follows from the sums.
    const sums = new Map<Who, Map<string, { listings: number; deals: number }>>();
    for (const s of trend.series) {
      const who = whoOf(s.ownership);
      if (who === 'none') continue;
      const days = sums.get(who) ?? new Map<string, { listings: number; deals: number }>();
      sums.set(who, days);
      for (const p of s.points) {
        const day = days.get(p.date) ?? { listings: 0, deals: 0 };
        day.listings += p.listings;
        day.deals += p.deals;
        days.set(p.date, day);
      }
    }
    return (['own', 'competitor'] as const)
      .filter((who) => sums.has(who))
      .map((who) => ({
        key: who,
        label: WHO_LABEL[who],
        color: WHO_COLOR[who],
        points: [...sums.get(who)!.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => ({ date, value: d.listings > 0 ? (d.deals / d.listings) * 100 : null })),
      }));
  }, [trend.series, by]);

  const table: TableView = {
    columns: ['Day', ...series.map((s) => s.label)],
    numeric: series.map((_, i) => i + 1),
    rows: [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort().map((date) => [date, ...series.map((s) => pct(s.points.find((p) => p.date === date)?.value))]),
  };
  const tooFew = trend.observed_days < 2;

  return (
    <ChartFrame
      title="Offers over the last 30 days"
      subtitle="Share of the range on offer per day, counted from the listings observed that day"
      refetching={refetching}
      table={tooFew ? null : table}
      actions={
        <Segmented
          label="Lines"
          size="sm"
          value={by}
          onChange={setBy}
          options={[
            { value: 'ownership', label: 'Own vs competitors' },
            { value: 'brand', label: 'By brand' },
          ]}
        />
      }
      empty={
        trend.observed_days === 0 ? (
          <ChartEmpty title="Nothing was observed in the last 30 days" description="The trend appears once prices have been collected." />
        ) : tooFew ? (
          <ChartEmpty
            title="One collected day so far"
            description={`Prices in this selection were collected on ${fmtDate(trend.to)} only. A line needs at least two days: it draws itself as collection continues.`}
          />
        ) : undefined
      }
      footer={trend.not_applied.length ? `Not applied to the daily figures: ${trend.not_applied.join(', ')}.` : undefined}
    >
      <TimeSeriesChart series={series} colorScope="deals-trend" height={240} formatValue={(v) => fmtPct(v, 1)} formatAxis={(v) => fmtPct(v, 0)} includeZero domain={{ from: trend.from, to: trend.to }} maxGapDays={4} valueLabel="On offer" />
    </ChartFrame>
  );
});

// ---------------------------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------------------------
export function DealsCompare({ filters }: { filters: DealFilters }) {
  const { state, filter, query: listQuery } = filters;
  // The comparison describes every matching deal: sorting and paging of the list do not concern it.
  const compareQuery = useMemo(() => ({ ...listQuery, sort: undefined, page: undefined, page_size: undefined }), [listQuery]);
  const query = useApiQuery<DealsComparison>(['deals', 'compare'], '/deals/compare', compareQuery, { refetchInterval: REFRESH_MS });
  const data = query.data;
  const refetching = query.isFetching && !query.isPending && query.isPlaceholderData;

  const selected: Record<FilterParam, string[]> = {
    brand_id: toList(state.brand_id),
    category_id: toList(state.category_id),
    retailer_id: toList(state.retailer_id),
    market_id: toList(state.market_id),
  };
  const toggle = (param: FilterParam, value: string) => {
    const current = selected[param];
    filter({ [param]: fromList(current.includes(value) ? current.filter((v) => v !== value) : [...current, value]) });
  };
  const pick = (brandId: number, retailerId: number) => {
    const same = selected.brand_id.length === 1 && selected.brand_id[0] === String(brandId) && selected.retailer_id.length === 1 && selected.retailer_id[0] === String(retailerId);
    filter(same ? { brand_id: undefined, retailer_id: undefined } : { brand_id: String(brandId), retailer_id: String(retailerId) });
  };

  if (query.isError && !data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!data) return <LoadingBlock className="min-h-48" label="Comparing the offers…" />;
  return (
    <section aria-label="Comparison of the offers" className="flex flex-col gap-4">
      <ShareCompare data={data} selected={selected} onToggle={toggle} refetching={refetching} />
      <HeatGrid data={data} selected={selected} onPick={pick} refetching={refetching} />
      <div className="grid gap-4 xl:grid-cols-2">
        <DepthMix data={data} refetching={refetching} />
        <OfferTrend data={data} refetching={refetching} />
      </div>
    </section>
  );
}
