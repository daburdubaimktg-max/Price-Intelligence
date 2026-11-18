/** Brand page — Competing brands: declared benchmarks and brands linked by product mappings, in the same scope. */
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowLeftRight, Swords } from 'lucide-react';
import type { Query } from '@/lib/api.ts';
import { fmtNumber, plural } from '@/lib/format.ts';
import { Badge, Card, CardHeader, EmptyState, Tip } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { DemoBadge, OwnershipDot } from '@/components/domain/domain.tsx';
import type { BrandCompetitorRow, BrandDetailResult } from '@shared/api/brands.ts';
import { brandHref, IndexFigure, indexSentence, MovesCell, PriceRanges, PromoShare, TrendSpark, useElementWidth } from './parts.tsx';

type FitColumn = Column<BrandCompetitorRow> & { minWidth?: number };

export function CompetitorsTab({ data, scope }: { data: BrandDetailResult; scope: Query }) {
  const navigate = useNavigate();
  const [ref, width] = useElementWidth();
  const brand = data.brand;
  const own = brand.ownership === 'own';

  const columns = useMemo<FitColumn[]>(
    () => [
      {
        key: 'brand',
        header: own ? 'Competing brand' : 'Own brand',
        nowrap: false,
        cell: (c) => (
          <span className="flex max-w-[15rem] min-w-[7.5rem] items-start gap-2">
            <OwnershipDot ownership={c.brand.ownership} className="mt-[7px]" />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <Link to={brandHref(c.brand.id, scope)} className="font-medium break-words text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                  {c.brand.name}
                </Link>
                {c.brand.is_demo ? <DemoBadge /> : null}
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1">
                {c.is_benchmark ? (
                  <Badge tone="accent" title="Declared as a benchmark brand in the catalogue">
                    Benchmark
                  </Badge>
                ) : (
                  <Badge tone="outline" title="Not declared as a benchmark brand: it appears here because products of the two brands are mapped to each other">
                    Mapped only
                  </Badge>
                )}
              </span>
            </span>
          </span>
        ),
      },
      {
        key: 'range',
        header: 'Range',
        nowrap: false,
        headerTitle: 'Listed products and active listings of that brand in this scope',
        cell: (c) =>
          c.brand.listings === 0 ? (
            <span className="text-[12.5px] text-ink-4">Not listed here</span>
          ) : (
            <span className="num flex flex-col whitespace-nowrap">
              <span className="text-ink-2">
                <span className="font-medium text-ink">{fmtNumber(c.brand.products)}</span> product{c.brand.products === 1 ? '' : 's'}
              </span>
              <span className="text-[11.5px] leading-4 text-ink-3">
                {plural(c.brand.listings, 'listing')} · {plural(c.brand.retailers, 'retailer')}
              </span>
            </span>
          ),
        minWidth: 520,
      },
      {
        key: 'mappings',
        header: 'Mappings',
        nowrap: false,
        headerTitle: 'Product mappings between the two brands. Only approved mappings are compared.',
        cell: (c) =>
          c.approved_mappings + c.suggested_mappings === 0 ? (
            <span className="text-[12.5px] text-ink-4">None</span>
          ) : (
            <span className="num flex flex-col whitespace-nowrap">
              <span className="text-ink-2">{fmtNumber(c.approved_mappings)} approved</span>
              {c.suggested_mappings > 0 ? <span className="text-[11.5px] leading-4 font-medium text-accent">{fmtNumber(c.suggested_mappings)} suggested</span> : null}
            </span>
          ),
        minWidth: 900,
      },
      {
        key: 'index',
        header: 'Price index',
        nowrap: false,
        headerTitle: 'Own ÷ competitor price × 100 over the mapped same-retailer pairs of the two brands (100 = parity)',
        cell: (c) =>
          c.index === null ? (
            <Tip
              content={
                c.not_comparable_pairs > 0
                  ? 'The mapped products are measured in different units (g vs ml), so no index is stated.'
                  : c.approved_mappings === 0
                    ? 'No approved product mapping between the two brands yet.'
                    : 'The mapped products have no current prices at the same retailer in this scope.'
              }
            >
              <span className="text-[12.5px] text-ink-3">{c.not_comparable_pairs > 0 ? 'Not comparable' : c.approved_mappings === 0 ? 'Not mapped' : 'No current pair'}</span>
            </Tip>
          ) : (
            <span className="flex max-w-[16rem] min-w-[8.5rem] flex-col">
              <IndexFigure index={c.index} scale={width >= 520} />
              <span className="text-[11.5px] leading-4 text-ink-3">
                {indexSentence(c.index, c.own_brand_name, c.competitor_brand_name)} {plural(c.pairs, 'pair')}
                {c.pairs > 1 ? `: cheaper in ${fmtNumber(c.cheaper_pairs)}, dearer in ${fmtNumber(c.dearer_pairs)}` : ''}.
              </span>
            </span>
          ),
      },
      {
        key: 'trend',
        header: '30-day trend',
        headerTitle: 'Average change of that brand’s listing prices over the last 30 days',
        cell: (c) => <TrendSpark points={c.brand.trend} change={c.brand.trend_change_pct} ownership={c.brand.ownership} width={64} />,
        minWidth: 680,
      },
      {
        key: 'promo',
        header: 'On promotion',
        align: 'right',
        headerTitle: 'Share of that brand’s fresh listings currently on promotion',
        cell: (c) => <PromoShare promo={c.brand.promo} className="items-end" />,
        minWidth: 780,
      },
      { key: 'moves', header: 'Moves 7 d', headerTitle: 'Price increases and decreases of that brand in the last 7 days', cell: (c) => <MovesCell moves={c.brand.moves_7d} />, minWidth: 1000 },
      {
        key: 'prices',
        header: data.currency_mode === 'converted' ? 'Current prices (converted)' : 'Current prices',
        nowrap: false,
        cell: (c) => <PriceRanges ranges={c.brand.price_ranges} limit={2} showMedian={false} />,
        minWidth: 1120,
      },
    ],
    [own, scope, width, data.currency_mode],
  );
  const visible = useMemo(() => columns.filter((c) => !c.minWidth || width >= c.minWidth), [columns, width]);
  const mappingsHref = '/catalogue?tab=mappings';

  return (
    <div ref={ref} className="min-w-0">
      <Card>
        <CardHeader
          title={own ? 'Competing brands' : 'Own brands compared with this brand'}
          subtitle={
            own
              ? `Brands ${brand.name} is benchmarked against in the catalogue, and brands whose products are mapped to its products. The price index compares ${brand.name} with each of them on approved mappings at the same retailer.`
              : `Own brands that benchmark against ${brand.name} or have products mapped to its products. The index is always own ÷ competitor: above 100 the own brand is the more expensive one.`
          }
          actions={
            <Link to={mappingsHref} className="link inline-flex items-center gap-1 text-[12.5px]">
              <ArrowLeftRight className="size-3" aria-hidden /> Manage mappings
            </Link>
          }
        />
        <DataTable
          columns={visible}
          rows={data.competitors}
          rowKey={(c) => c.brand.id}
          onRowClick={(c) => navigate(brandHref(c.brand.id, scope))}
          dense
          empty={
            <EmptyState
              icon={Swords}
              title={own ? 'No competing brand recorded yet' : 'No own brand is compared with this brand yet'}
              description={
                own
                  ? 'Declare benchmark brands for this brand under Brands & categories, or map its products to competitor products. Both make the comparison appear here.'
                  : 'Declare this brand as a benchmark of an own brand under Brands & categories, or map an own product to one of its products.'
              }
              action={
                <Link to="/catalogue?tab=taxonomy" className="link text-[13px]">
                  Open Brands &amp; categories
                </Link>
              }
            />
          }
        />
      </Card>
    </div>
  );
}
