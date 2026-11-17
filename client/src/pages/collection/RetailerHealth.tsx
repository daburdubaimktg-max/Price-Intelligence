/** Health tab, bottom: every source with its status, last success, last attempt and freshness — attention first. */
import { useMemo } from 'react';
import { Link } from 'react-router';
import { fmtNumber, fmtRelative } from '@/lib/format.ts';
import { Card, CardHeader, EmptyState, ErrorState, Segmented } from '@/components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { SegmentedBar } from '@/components/charts/charts.tsx';
import { DemoBadge, FrequencyLabel, MarketTime, MethodLabel } from '@/components/domain/domain.tsx';
import type { CollectionSource, SourceStatus } from '@shared/api/collection.ts';
import { FRESHNESS_COLORS } from './health-shared.tsx';
import { JobStatusBadge, SourceStatusBadge } from './shared.tsx';

const PAGE_SIZE = 25;
const ATTENTION_ORDER: SourceStatus[] = ['failing', 'not_configured', 'pending', 'healthy', 'paused', 'manual', 'simulated'];

function needsAttention(s: CollectionSource): boolean {
  return s.status === 'failing' || s.status === 'not_configured' || s.status === 'pending' || s.listings_stale > 0 || s.consecutive_failures > 0;
}

export function RetailerHealth({
  sources, loading, error, refetching, onRetry, onOpen, view, page, onView, onPage, selected,
}: {
  sources: CollectionSource[] | undefined;
  loading: boolean;
  error: unknown;
  refetching: boolean;
  onRetry: () => void;
  onOpen: (retailerId: number) => void;
  view: 'all' | 'attention';
  page: number;
  onView: (next: 'all' | 'attention') => void;
  onPage: (next: number) => void;
  selected: number | null;
}) {
  const sorted = useMemo(() => {
    const list = [...(sources ?? [])].filter((s) => view === 'all' || needsAttention(s));
    list.sort(
      (a, b) =>
        ATTENTION_ORDER.indexOf(a.status) - ATTENTION_ORDER.indexOf(b.status) || b.listings_stale - a.listings_stale || a.name.localeCompare(b.name),
    );
    return list;
  }, [sources, view]);
  const attention = useMemo(() => (sources ?? []).filter(needsAttention).length, [sources]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = sorted.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const columns: Array<Column<CollectionSource>> = [
    {
      key: 'source',
      header: 'Source',
      cell: (s) => (
        <div className="min-w-[7rem] sm:min-w-[10rem]">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="font-medium text-ink">{s.name}</span>
            {s.is_demo ? <DemoBadge /> : null}
          </div>
          <div className="text-[11.5px] leading-4 text-ink-3">
            {s.market_name} · <MethodLabel method={s.method} />
            {s.runnable ? (
              <>
                {' · '}
                <FrequencyLabel frequency={s.frequency} />
                {s.frequency_inherited ? ' (market default)' : ''}
              </>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => (
        <div className="max-w-[26rem] md:min-w-[12rem]">
          <SourceStatusBadge status={s.status} />
          <p className="mt-1 hidden text-[11.5px] leading-4 text-ink-3 md:line-clamp-2" title={s.status_reason}>
            {s.status_reason}
          </p>
        </div>
      ),
    },
    {
      key: 'success',
      header: 'Last success · next run',
      hideBelow: 'md',
      headerTitle: 'Last run that captured prices and the next time the source is due, in the market’s own time',
      cell: (s) => (
        <div className="text-[12.5px] whitespace-nowrap">
          <div>{s.last_success_at ? <MarketTime iso={s.last_success_at} timeZone={s.timezone} relative /> : <span className="text-ink-4">{s.runnable ? 'No successful run' : 'Not applicable'}</span>}</div>
          <div className="text-[11.5px] text-ink-3">
            {!s.runnable ? (
              'Not scheduled — updated by people'
            ) : s.status === 'not_configured' ? (
              'Will not run until configured'
            ) : s.status === 'paused' ? (
              'Paused'
            ) : s.next_run_at ? (
              <>
                Next <MarketTime iso={s.next_run_at} timeZone={s.timezone} short />
              </>
            ) : (
              'Nothing scheduled'
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'attempt',
      header: 'Last attempt',
      hideBelow: 'lg',
      headerTitle: 'Outcome of the most recent run: listings captured, not returned by the source, and failed',
      cell: (s) =>
        s.latest_job ? (
          <div className="flex min-w-[9rem] flex-col items-start gap-1">
            <JobStatusBadge status={s.latest_job.status} dataClass={s.latest_job.data_class} />
            <span className="num text-[11.5px] leading-4 text-ink-3">
              {s.latest_job.status === 'not_configured'
                ? `No attempt was made · ${fmtRelative(s.latest_job.created_at)}`
                : s.last_attempt_at
                  ? fmtRelative(s.last_attempt_at)
                  : fmtRelative(s.latest_job.created_at)}
              {s.latest_job.status !== 'not_configured' && s.listings_captured_last_run !== null ? ` · ${fmtNumber(s.listings_captured_last_run)} captured` : ''}
              {s.listings_missing_last_run ? ` · ${fmtNumber(s.listings_missing_last_run)} not returned` : ''}
              {s.listings_failed_last_run ? <span className="text-crit-ink"> · {fmtNumber(s.listings_failed_last_run)} failed</span> : null}
              {s.consecutive_failures > 1 ? <span className="text-crit-ink"> · {s.consecutive_failures} failures in a row</span> : null}
            </span>
          </div>
        ) : (
          <span className="text-[12.5px] whitespace-nowrap text-ink-4">{s.runnable ? 'Never attempted' : 'Not applicable'}</span>
        ),
    },
    {
      key: 'freshness',
      header: 'Freshness',
      headerTitle: 'Active listings with a fresh observation; stale ones open in the Live Price Monitor',
      cell: (s) => {
        if (s.listings_active === 0) return <span className="text-[12.5px] whitespace-nowrap text-ink-4">No active listings</span>;
        const fresh = Math.max(0, s.listings_active - s.listings_stale);
        const overdue = Math.max(0, s.listings_stale - s.listings_never_observed);
        return (
          <div className="min-w-[6.5rem] sm:min-w-[7.5rem]">
            <SegmentedBar
              height={6}
              className="max-w-[9rem]"
              parts={[
                { key: 'fresh', label: 'Fresh', value: fresh, color: FRESHNESS_COLORS.fresh },
                { key: 'stale', label: 'Stale', value: overdue, color: FRESHNESS_COLORS.stale },
                { key: 'never', label: 'Never observed', value: s.listings_never_observed, color: FRESHNESS_COLORS.never },
              ]}
            />
            <div className="num mt-1 text-[11.5px] whitespace-nowrap text-ink-3">
              {fmtNumber(fresh)} of {fmtNumber(s.listings_active)} fresh
              {s.listings_stale > 0 ? (
                <>
                  {' · '}
                  <Link
                    className="link"
                    to={`/monitor?stale=true&retailer_id=${s.retailer_id}`}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    title="Open these listings in the Live Price Monitor"
                  >
                    {fmtNumber(s.listings_stale)} stale
                  </Link>
                </>
              ) : null}
            </div>
          </div>
        );
      },
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Retailer health"
        subtitle="Every source, the ones that need attention first. Select a row for what it needs, its recent jobs and a connection test."
        actions={
          <Segmented
            size="sm"
            label="Rows"
            value={view}
            onChange={onView}
            options={[
              { value: 'all', label: `All ${sources ? fmtNumber(sources.length) : ''}`.trim() },
              { value: 'attention', label: `Needs attention ${sources ? fmtNumber(attention) : ''}`.trim() },
            ]}
          />
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : (
        <DataTable
          columns={columns}
          rows={sources ? rows : undefined}
          rowKey={(s) => s.retailer_id}
          loading={loading}
          refetching={refetching}
          onRowClick={(s) => onOpen(s.retailer_id)}
          selectedKey={selected}
          empty={
            view === 'attention' ? (
              <EmptyState title="No source needs attention" description="No source is failing, unconfigured or waiting for its first run, and no listing is stale." />
            ) : (
              <EmptyState
                title="No sources yet"
                description="A source is a retailer with a collection method. Add one in Administration, then come back here to watch it."
                action={
                  <Link to="/admin?tab=retailers" className="link text-[13px]">
                    Open Administration → Retailers
                  </Link>
                }
              />
            )
          }
          footer={<Pagination page={current} pages={pages} total={sorted.length} pageSize={PAGE_SIZE} onPage={onPage} noun="sources" />}
        />
      )}
    </Card>
  );
}
