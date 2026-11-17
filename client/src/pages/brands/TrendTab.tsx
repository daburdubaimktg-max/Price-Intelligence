/**
 * Brand page — Trend.
 *   1. A unit-free price index of the brand next to its benchmark brands (one axis, at most eight lines).
 *   2. The average unit price per category of the brand: one chart per currency and unit basis — prices in
 *      different currencies or per different units are never drawn on a common axis.
 */
import { useMemo } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { toQueryString, type Query } from '@/lib/api.ts';
import { fmtNumber, fmtPct, fmtUnitPrice } from '@/lib/format.ts';
import { Button, Card, Notice, Segmented } from '@/components/ui/primitives.tsx';
import { ChartEmpty, ChartFrame, MAX_SERIES } from '@/components/charts/kit.tsx';
import { seriesTable, TimeSeriesChart, useSeriesChart, type Series } from '@/components/charts/charts.tsx';
import type { TimelineSeries } from '@shared/api/analytics.ts';
import type { BrandDetailResult } from '@shared/api/brands.ts';
import { SectionHeader } from '../history/parts.tsx';
import { LinkButton } from './parts.tsx';

/** More currency / unit-basis combinations than this are not charted side by side: the user is asked to narrow or convert. */
const MAX_GROUPS = 4;

interface ChartGroup {
  key: string;
  currency: string | null;
  basis: string | null;
  series: TimelineSeries[];
}

const indexFormat = (v: number) => v.toFixed(1);

function IndexChart({ data }: { data: BrandDetailResult }) {
  const trend = data.trend;
  const drawn = useMemo<Series[]>(
    () =>
      trend.index.slice(0, MAX_SERIES).map((s) => ({
        key: `B${s.brand_id}`,
        label: s.name,
        sublabel: s.is_self ? 'this brand' : null,
        points: s.points.map((p) => ({ date: p.date, value: p.index })),
      })),
    [trend.index],
  );
  const chart = useSeriesChart(drawn, 'brand-index');
  const self = trend.index.find((s) => s.is_self);
  const empty = drawn.every((s) => s.points.length === 0);
  const others = trend.index.filter((s) => !s.is_self).length;
  return (
    <ChartFrame
      title={others > 0 ? `Price index · ${data.brand.name} and competing brands` : `Price index · ${data.brand.name}`}
      subtitle={
        empty
          ? undefined
          : !self || self.points.length === 0
            ? `${data.brand.name} has no priced observation in this scope and period — only the compared brands are drawn`
            : `First price of each listing in the period = 100${self.change_pct !== null ? ` · ${data.brand.name} ${self.change_pct === 0 ? 'unchanged' : `${self.change_pct > 0 ? 'up' : 'down'} ${fmtPct(Math.abs(self.change_pct), 1)}`}` : ''}`
      }
      legend={chart.legend}
      table={empty ? null : seriesTable(drawn, indexFormat)}
      empty={empty ? <ChartEmpty description="No priced observation of this brand in the period. Choose a longer period or widen the filters." /> : undefined}
      footer="Unit-free: each listing is indexed to its own first price in the period, held for up to 7 days between observations, and the listings of a brand are averaged — so markets, currencies and pack sizes can share one axis. A line ends on the last day the brand was observed."
    >
      <TimeSeriesChart
        series={drawn}
        colorScope="brand-index"
        height={300}
        formatValue={indexFormat}
        reference={{ value: 100, label: 'Start = 100' }}
        hiddenKeys={chart.hidden}
        domain={{ from: trend.period.from, to: trend.period.to }}
        valueLabel="Price index"
      />
    </ChartFrame>
  );
}

function CategoryChart({ group, height, range }: { group: ChartGroup; height: number; range: { from: string; to: string } }) {
  const format = useMemo(() => (v: number) => fmtUnitPrice(v, group.currency), [group.currency]);
  const drawn = useMemo<Series[]>(
    () => group.series.slice(0, MAX_SERIES).map((s) => ({ key: s.key, label: s.label, sublabel: null, points: s.points.map((p) => ({ date: p.date, value: p.value })) })),
    [group.series],
  );
  const scope = `brand-category-${group.key}`;
  const chart = useSeriesChart(drawn, scope);
  const hidden = group.series.length - drawn.length;
  const title = ['Average unit price', group.currency, group.basis].filter(Boolean).join(' · ');
  return (
    <ChartFrame
      title={title}
      subtitle={`${fmtNumber(group.series.length)} categor${group.series.length === 1 ? 'y' : 'ies'} · ${fmtNumber(group.series.reduce((n, s) => n + s.listing_count, 0))} listings`}
      legend={chart.legend}
      table={seriesTable(drawn, format)}
      footer={hidden > 0 ? `Showing the ${MAX_SERIES} categories with most observations of ${fmtNumber(group.series.length)}.` : undefined}
    >
      <TimeSeriesChart series={drawn} colorScope={scope} height={height} formatValue={format} hiddenKeys={chart.hidden} domain={range} valueLabel={title} />
    </ChartFrame>
  );
}

export function TrendTab({
  data, days, onDays, onConvert, reportingCurrency, scope,
}: {
  data: BrandDetailResult;
  days: string;
  onDays: (days: string) => void;
  /** Switches the page to the reporting currency. */
  onConvert: () => void;
  reportingCurrency: string;
  scope: Query;
}) {
  const trend = data.trend;
  const groups = useMemo<ChartGroup[]>(() => {
    const map = new Map<string, ChartGroup>();
    for (const s of trend.by_category.series) {
      const key = `${s.currency ?? ''}|${s.basis ?? ''}`;
      const g = map.get(key);
      if (g) g.series.push(s);
      else map.set(key, { key, currency: s.currency, basis: s.basis, series: [s] });
    }
    return [...map.values()].sort((a, b) => b.series.reduce((n, s) => n + s.points.length, 0) - a.series.reduce((n, s) => n + s.points.length, 0));
  }, [trend.by_category.series]);
  const currencies = new Set(groups.map((g) => g.currency));
  const historyHref = `/history${toQueryString({ ...scope, brand_id: data.brand.id, tl_group: 'category', tl_metric: 'unit_price', period: days === '90' ? '90d' : '30d' })}`;

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Price index">
        <SectionHeader
          title="How the brand’s prices moved"
          subtitle="An index instead of a price: it follows every listing of the brand in the scope, whatever its currency or pack size."
          controls={
            <Segmented
              label="Period"
              value={days === '90' ? '90' : '30'}
              onChange={onDays}
              options={[
                { value: '30', label: '30 days' },
                { value: '90', label: '90 days' },
              ]}
            />
          }
        />
        <IndexChart data={data} />
      </section>

      <section aria-label="Unit price by category">
        <SectionHeader
          title="Unit price by category"
          subtitle="Daily average price per 100 ml / 100 g / unit of the brand’s listings in each category. Lines break where observations are missing."
          controls={
            <LinkButton to={historyHref} title="Open the same selection in the Historical Price Explorer">
              Open in Price History
            </LinkButton>
          }
        />
        {trend.by_category.series.length === 0 ? (
          <Card>
            <ChartEmpty description="No priced observation with a known pack size in this period. Unit prices need the product’s pack size." />
          </Card>
        ) : groups.length > MAX_GROUPS ? (
          <Notice
            tone="warn"
            icon={ArrowLeftRight}
            title={`This brand is priced in ${currencies.size} currencies here`}
            action={
              data.currency_mode === 'native' ? (
                <Button size="sm" variant="primary" onClick={onConvert}>
                  Convert to {reportingCurrency}
                </Button>
              ) : undefined
            }
          >
            Prices in different currencies are never drawn on one axis ({[...currencies].filter(Boolean).join(', ')}). Narrow the page to one market, or choose a comparison currency to see these charts — the exchange
            rates used are then stated.
          </Notice>
        ) : (
          <div className={groups.length > 1 ? 'grid gap-4 xl:grid-cols-2' : ''}>
            {groups.map((g) => (
              <CategoryChart key={g.key} group={g} height={groups.length > 1 ? 240 : 300} range={trend.period} />
            ))}
          </div>
        )}
        {trend.by_category.truncated ? (
          <Notice tone="info" className="mt-3">
            Showing the {fmtNumber(trend.by_category.series.length)} series with most observations of {fmtNumber(trend.by_category.total_series)}.
          </Notice>
        ) : null}
      </section>
    </div>
  );
}
