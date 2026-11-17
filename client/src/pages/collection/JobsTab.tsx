/**
 * Jobs: every collection run that was recorded, with its real outcome. Failed, partial, cancelled and
 * not-configured runs can be retried; simulated runs are marked and never read as real collection.
 */
import { CircleStop, RotateCw } from 'lucide-react';
import { type Paged } from '@/lib/api.ts';
import { DASH, fmtNumber } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useDates, useReference } from '@/lib/hooks.ts';
import { Button, Card, CardHeader, EmptyState, ErrorState, Segmented } from '@/components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { DateRangePicker, FilterBar, MultiSelect } from '@/components/ui/filters.tsx';
import { DemoBadge } from '@/components/domain/domain.tsx';
import type { CollectionJob } from '@shared/api/collection.ts';
import { fmtDuration, JOB_STATUSES, JOB_STATUS_META, JobStatusBadge, TRIGGER_LABELS, useCollectionActions, ViewerTime } from './shared.tsx';
import { cleared, countActive, JOB_FILTER_KEYS, useCollectionUrl } from './url.ts';

const RETRYABLE: Array<CollectionJob['status']> = ['failed', 'partial', 'not_configured', 'cancelled'];

export function JobsTab() {
  const actions = useCollectionActions();
  const { ref } = useReference();
  const dates = useDates();
  const { state, set } = useCollectionUrl();
  const page = Math.max(1, Number(state.j_page) || 1);
  const jobs = useApiQuery<Paged<CollectionJob>>(
    ['collection', 'jobs'],
    '/collection/jobs',
    { from: state.j_from, to: state.j_to, retailer_id: state.j_retailer, status: state.j_status, data_class: state.j_class, trigger_type: state.j_trigger, page, page_size: 50 },
    {
      // follow queued and running jobs until they finish
      refetchInterval: (query) => (query.state.data?.rows.some((j) => j.status === 'queued' || j.status === 'running') ? 2500 : 60_000),
    },
  );
  const patch = (changes: Parameters<typeof set>[0]) => set({ ...changes, j_page: undefined });
  const activeFilters = countActive(state, JOB_FILTER_KEYS);
  const today = dates.data?.today ?? new Date().toISOString().slice(0, 10);

  const columns: Array<Column<CollectionJob>> = [
    {
      key: 'job',
      header: 'Job',
      cell: (j) => (
        <div className="min-w-[10rem]">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-ink">{j.retailer_name}</span>
            {j.is_demo ? <DemoBadge /> : null}
          </div>
          <div className="num text-[11.5px] text-ink-3">
            #{j.id} · {j.market_name}
            {j.attempt > 1 ? ` · attempt ${j.attempt}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Outcome',
      cell: (j) => (
        <div className="max-w-[22rem] min-w-[8rem]">
          <JobStatusBadge status={j.status} dataClass={j.data_class} />
          {j.error_message && j.status !== 'succeeded' ? (
            <p className="mt-1 hidden text-[11.5px] leading-4 text-ink-3 md:line-clamp-2" title={j.error_message}>
              {j.error_message}
            </p>
          ) : null}
        </div>
      ),
    },
    { key: 'trigger', header: 'Started by', hideBelow: 'lg', cell: (j) => <span className="text-[12.5px] whitespace-nowrap text-ink-2">{TRIGGER_LABELS[j.trigger_type] ?? j.trigger_type}{j.requested_by_name ? <span className="block text-[11.5px] text-ink-3">{j.requested_by_name}</span> : null}</span> },
    {
      key: 'started',
      header: 'Started',
      hideBelow: 'sm',
      headerTitle: 'In your own time zone; hover for UTC',
      cell: (j) => (
        <div className="whitespace-nowrap">
          <ViewerTime iso={j.started_at ?? j.created_at} />
          <div className="num text-[11.5px] text-ink-3">{j.status === 'queued' ? 'not started' : j.status === 'running' ? 'in progress' : `took ${fmtDuration(j.duration_ms)}`}</div>
        </div>
      ),
    },
    {
      key: 'listings',
      header: 'Listings',
      align: 'right',
      hideBelow: 'md',
      headerTitle: 'Listings that returned a price / listings attempted',
      cell: (j) =>
        j.status === 'not_configured' || j.status === 'queued' ? (
          <span className="text-ink-4">{DASH}</span>
        ) : (
          <span>
            {fmtNumber(j.listings_succeeded)}
            <span className="text-ink-3"> / {fmtNumber(j.listings_total)}</span>
          </span>
        ),
    },
    {
      key: 'gaps',
      header: 'Missing · errors',
      align: 'right',
      hideBelow: 'lg',
      headerTitle: 'Listings the source did not return · listings that failed during extraction',
      cell: (j) =>
        j.listings_missing || j.listings_failed ? (
          <span>
            <span className={j.listings_missing ? 'text-ink' : 'text-ink-4'}>{fmtNumber(j.listings_missing)}</span>
            <span className="text-ink-4"> · </span>
            <span className={j.listings_failed ? 'font-medium text-crit-ink' : 'text-ink-4'}>{fmtNumber(j.listings_failed)}</span>
          </span>
        ) : (
          <span className="text-ink-4">{DASH}</span>
        ),
    },
    {
      key: 'stored',
      header: 'Stored',
      align: 'right',
      headerTitle: 'Observations added to the ledger by this run. Identical re-reads of an observation that is already stored are skipped, never stored twice.',
      cell: (j) => (
        <span>
          {fmtNumber(j.observations_created)}
          {j.duplicates_skipped ? <span className="block text-[11.5px] font-normal text-ink-3">{fmtNumber(j.duplicates_skipped)} duplicate{j.duplicates_skipped === 1 ? '' : 's'} skipped</span> : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '96px',
      cell: (j) => {
        if (!actions.canRun) return null;
        const busy = actions.busy.has(`job:${j.id}`);
        return (
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {RETRYABLE.includes(j.status) ? (
              <Button size="sm" icon={RotateCw} loading={busy} onClick={() => void actions.retry(j)}>
                Retry
              </Button>
            ) : j.status === 'queued' || j.status === 'running' ? (
              <Button size="sm" icon={CircleStop} loading={busy} onClick={() => void actions.cancel(j)}>
                Cancel
              </Button>
            ) : null}
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <FilterBar activeCount={activeFilters} onReset={() => set({ ...cleared(JOB_FILTER_KEYS), j_page: undefined })}>
        <DateRangePicker
          label="Created"
          value={{ from: state.j_from, to: state.j_to }}
          onChange={(next) => patch({ j_from: next.from, j_to: next.to })}
          today={today}
          presets={['today', '7d', '30d', 'all']}
        />
        <Segmented
          label="Kind of run"
          value={state.j_class === 'real' || state.j_class === 'simulated' ? state.j_class : 'all'}
          onChange={(next) => patch({ j_class: next === 'all' ? undefined : next })}
          options={[
            { value: 'all', label: 'All runs' },
            { value: 'real', label: 'Real', title: 'Runs against real retailer systems' },
            { value: 'simulated', label: 'Simulated', title: 'Runs of the demo generator — not real collection' },
          ]}
        />
        <MultiSelect
          label="Outcome"
          options={JOB_STATUSES.map((s) => ({ value: s, label: JOB_STATUS_META[s].label }))}
          value={toList(state.j_status)}
          onChange={(next) => patch({ j_status: fromList(next) })}
        />
        <MultiSelect
          label="Source"
          options={(ref?.retailers ?? []).map((r) => ({ value: String(r.id), label: r.name, sublabel: ref?.markets.find((m) => m.id === r.market_id)?.name }))}
          value={toList(state.j_retailer)}
          onChange={(next) => patch({ j_retailer: fromList(next) })}
        />
        <MultiSelect
          label="Started by"
          options={(Object.keys(TRIGGER_LABELS) as Array<keyof typeof TRIGGER_LABELS>).map((t) => ({ value: t, label: TRIGGER_LABELS[t] }))}
          value={toList(state.j_trigger)}
          onChange={(next) => patch({ j_trigger: fromList(next) })}
        />
      </FilterBar>

      <Card>
        <CardHeader
          title="Collection jobs"
          subtitle="One row per run, newest first. A run that could not be attempted is recorded as “Not configured” — never as a success. Select a row for its log and retry chain."
        />
        {jobs.isError && !jobs.data ? (
          <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={jobs.data?.rows}
            rowKey={(j) => j.id}
            loading={jobs.isPending}
            refetching={jobs.isPlaceholderData}
            onRowClick={(j) => set({ job: String(j.id) })}
            selectedKey={state.job ? Number(state.job) : null}
            empty={
              activeFilters > 0 ? (
                <EmptyState title="No job matches these filters" description="Widen the date range or remove a filter." action={<Button size="sm" onClick={() => set({ ...cleared(JOB_FILTER_KEYS), j_page: undefined })}>Reset filters</Button>} />
              ) : (
                <EmptyState
                  title="No collection job has run yet"
                  description="Jobs appear here when a source runs — on its schedule, or when someone starts it from the Sources tab."
                  action={
                    <Button size="sm" onClick={() => set({ tab: 'sources' })}>
                      Open sources
                    </Button>
                  }
                />
              )
            }
            footer={jobs.data ? <Pagination page={jobs.data.page} pages={jobs.data.pages} total={jobs.data.total} pageSize={jobs.data.page_size} onPage={(p) => set({ j_page: String(p) })} noun="jobs" /> : undefined}
          />
        )}
      </Card>
    </div>
  );
}
