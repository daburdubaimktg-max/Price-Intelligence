/** What the current scope contains: volumes, period covered, provenance mix and per-currency price statistics. */
import { DASH, fmtDateTime, fmtNumber, fmtPct, fmtPrice, plural } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { Card, ErrorState, Skeleton, cn } from '@/components/ui/primitives.tsx';
import { SegmentedBar } from '@/components/charts/charts.tsx';
import type { HistorySummary } from '@shared/api/analytics.ts';
import type { HistoryFilters } from './filters.ts';
import { dataClassParts, Fact, isRefetching } from './parts.tsx';

export function useHistorySummary(filters: HistoryFilters) {
  return useApiQuery<HistorySummary>(['history', 'summary'], '/history/summary', filters.scopeQuery, { enabled: filters.ready });
}

export function SummaryStrip({ query }: { query: ReturnType<typeof useHistorySummary> }) {
  const data = query.data;
  if (query.isError && !data) {
    return (
      <Card className="mb-5">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }
  if (!data) {
    return (
      <Card className="mb-5 grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </Card>
    );
  }
  const parts = dataClassParts(data.by_data_class);
  const empty = data.observations === 0;
  return (
    <Card className={cn('mb-5 transition-opacity', isRefetching(query) && 'opacity-60')}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 p-4 sm:grid-cols-3 xl:grid-cols-9">
        <Fact label="Observations" value={fmtNumber(data.observations)} detail="stored records in scope" />
        <Fact label="Listings" value={fmtNumber(data.listings)} detail="product × retailer" />
        <Fact label="Products" value={fmtNumber(data.products)} detail={`${fmtNumber(data.brands)} brand${data.brands === 1 ? '' : 's'}`} />
        <Fact label="Retailers" value={fmtNumber(data.retailers)} detail={`${fmtNumber(data.markets)} market${data.markets === 1 ? '' : 's'}`} />
        <Fact label="First observation" value={data.first_observed_at ? fmtDateTime(data.first_observed_at, 'UTC').split(',')[0]! : DASH} detail={data.first_observed_at ? `${fmtDateTime(data.first_observed_at, 'UTC').split(', ')[1]} UTC` : undefined} />
        <Fact label="Latest observation" value={data.last_observed_at ? fmtDateTime(data.last_observed_at, 'UTC').split(',')[0]! : DASH} detail={data.last_observed_at ? `${fmtDateTime(data.last_observed_at, 'UTC').split(', ')[1]} UTC` : undefined} />
        <Fact label="On promotion" value={fmtPct(data.promo_share_pct, 1)} detail={plural(data.promo_observations, 'observation')} />
        <Fact label="Out of stock" value={fmtPct(data.out_of_stock_share_pct, 1)} detail={plural(data.out_of_stock_observations, 'observation')} />
        <Fact label="Demo records" value={fmtNumber(data.demo_observations)} detail={empty ? undefined : `${fmtPct((data.demo_observations / data.observations) * 100, 0)} of scope`} />
      </div>

      <div className="grid gap-x-8 gap-y-4 border-t border-line p-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="min-w-0">
          <div className="eyebrow mb-2">How these records entered the ledger</div>
          <SegmentedBar parts={parts} />
          <ul className="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[12.5px] leading-4 sm:grid-cols-2">
            {parts.map((p) => (
              <li key={p.key} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
                  <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: p.color }} />
                  <span className="truncate">{p.label}</span>
                </span>
                <span className="num shrink-0 font-medium text-ink">
                  {fmtNumber(p.value)}
                  <span className="ml-1.5 font-normal text-ink-3">{empty ? '' : fmtPct((p.value / data.observations) * 100, p.value > 0 && p.value / data.observations < 0.01 ? 1 : 0)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="min-w-0">
          <div className="eyebrow mb-2">Selling price by currency — never blended across currencies</div>
          {data.by_currency.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">No priced observations in this scope.</p>
          ) : (
            <div className="table-wrap max-h-52 overflow-y-auto rounded-md border border-line">
              <table className="grid-table is-dense">
                <thead>
                  <tr>
                    <th scope="col">Currency</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Observations</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Average</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Median</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Lowest</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Highest</th>
                    <th scope="col" style={{ textAlign: 'right' }} title="Standard deviation ÷ mean of the observed prices">Volatility</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_currency.map((c) => (
                    <tr key={c.currency}>
                      <td className="font-medium text-ink">{c.currency}</td>
                      <td className="num text-right">{fmtNumber(c.observations)}</td>
                      <td className="num text-right">{fmtPrice(c.avg, c.currency)}</td>
                      <td className="num text-right">{fmtPrice(c.median, c.currency)}</td>
                      <td className="num text-right">{fmtPrice(c.min, c.currency)}</td>
                      <td className="num text-right">{fmtPrice(c.max, c.currency)}</td>
                      <td className="num text-right">{fmtPct(c.volatility_pct, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
