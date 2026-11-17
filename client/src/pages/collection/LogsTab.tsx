/** Logs: what the collection engine recorded — per source, per job, per listing. */
import { X } from 'lucide-react';
import { type Paged } from '@/lib/api.ts';
import { fromList, toList, useApiQuery, useDates, useReference } from '@/lib/hooks.ts';
import { Button, Card, CardHeader, EmptyState, ErrorState, Segmented } from '@/components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { DateRangePicker, FilterBar, MultiSelect, SearchInput } from '@/components/ui/filters.tsx';
import type { CollectionLog } from '@shared/api/collection.ts';
import { LogLevel, RunKindBadge, ViewerTime } from './shared.tsx';
import { cleared, countActive, LOG_FILTER_KEYS, useCollectionUrl } from './url.ts';

const LEVELS = ['error', 'warn', 'info'] as const;

export function LogsTab() {
  const { ref } = useReference();
  const dates = useDates();
  const { state, set } = useCollectionUrl();
  const page = Math.max(1, Number(state.l_page) || 1);
  const level = LEVELS.includes(state.l_level as (typeof LEVELS)[number]) ? (state.l_level as (typeof LEVELS)[number]) : 'all';
  const logs = useApiQuery<Paged<CollectionLog>>(
    ['collection', 'logs'],
    '/collection/logs',
    { from: state.l_from, to: state.l_to, level: level === 'all' ? undefined : level, retailer_id: state.l_retailer, data_class: state.l_class, job_id: state.l_job, q: state.l_q, page, page_size: 100 },
    { refetchInterval: 60_000 },
  );
  const patch = (changes: Parameters<typeof set>[0]) => set({ ...changes, l_page: undefined });
  const activeFilters = countActive(state, LOG_FILTER_KEYS);
  const today = dates.data?.today ?? new Date().toISOString().slice(0, 10);

  const columns: Array<Column<CollectionLog>> = [
    {
      key: 'time',
      header: 'Time',
      width: '8.5rem',
      headerTitle: 'In your own time zone; hover for UTC',
      cell: (l) => (
        <div>
          <ViewerTime iso={l.created_at} />
          {/* on phones the level sits under the time so the message keeps the width */}
          <div className="mt-0.5 sm:hidden">
            <LogLevel level={l.level} />
          </div>
        </div>
      ),
    },
    { key: 'level', header: 'Level', width: '6rem', hideBelow: 'sm', cell: (l) => <LogLevel level={l.level} /> },
    {
      key: 'source',
      header: 'Source',
      hideBelow: 'md',
      cell: (l) => (
        <div className="max-w-[16rem] min-w-[9rem]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-ink">{l.retailer_name}</span>
            {l.job_data_class === 'simulated' ? <RunKindBadge dataClass="simulated" /> : null}
          </div>
          {l.listing_code ? (
            <div className="truncate text-[11.5px] text-ink-3" title={l.listing_title ?? undefined}>
              <span className="mono">{l.listing_code}</span>
              {l.listing_title ? ` · ${l.listing_title}` : ''}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'message',
      header: 'Message',
      nowrap: false,
      cell: (l) => (
        <div className="min-w-[11rem] sm:min-w-[14rem]">
          <p className="mono leading-5 break-words text-ink-2">{l.message}</p>
          <p className="mono text-ink-4">
            {l.code}
            <span className="md:hidden"> · {l.retailer_name}</span>
            <span className="sm:hidden">
              {' · '}
              <button type="button" className="link" onClick={() => set({ job: String(l.job_id) })}>
                job #{l.job_id}
              </button>
            </span>
          </p>
        </div>
      ),
    },
    {
      key: 'job',
      header: 'Job',
      align: 'right',
      width: '5rem',
      hideBelow: 'sm',
      cell: (l) => (
        <button
          type="button"
          className="link"
          title="Open this job"
          onClick={(e) => {
            e.stopPropagation();
            set({ job: String(l.job_id) });
          }}
        >
          #{l.job_id}
        </button>
      ),
    },
  ];

  return (
    <div>
      <FilterBar activeCount={activeFilters} onReset={() => set({ ...cleared(LOG_FILTER_KEYS), l_page: undefined })}>
        <DateRangePicker label="Logged" value={{ from: state.l_from, to: state.l_to }} onChange={(next) => patch({ l_from: next.from, l_to: next.to })} today={today} presets={['today', '7d', '30d', 'all']} />
        <Segmented
          label="Level"
          value={level}
          onChange={(next) => patch({ l_level: next === 'all' ? undefined : next })}
          options={[
            { value: 'all', label: 'All levels' },
            { value: 'error', label: 'Errors' },
            { value: 'warn', label: 'Warnings' },
            { value: 'info', label: 'Info' },
          ]}
        />
        <Segmented
          label="Kind of run"
          value={state.l_class === 'real' || state.l_class === 'simulated' ? state.l_class : 'all'}
          onChange={(next) => patch({ l_class: next === 'all' ? undefined : next })}
          options={[
            { value: 'all', label: 'All runs' },
            { value: 'real', label: 'Real' },
            { value: 'simulated', label: 'Simulated' },
          ]}
        />
        <MultiSelect
          label="Source"
          options={(ref?.retailers ?? []).map((r) => ({ value: String(r.id), label: r.name, sublabel: ref?.markets.find((m) => m.id === r.market_id)?.name }))}
          value={toList(state.l_retailer)}
          onChange={(next) => patch({ l_retailer: fromList(next) })}
        />
        <SearchInput value={state.l_q ?? ''} onChange={(next) => patch({ l_q: next || undefined })} placeholder="Search message or code…" />
        {state.l_job ? (
          <Button variant="accent" iconRight={X} onClick={() => patch({ l_job: undefined })} title="Show the log of all jobs">
            Job #{state.l_job}
          </Button>
        ) : null}
      </FilterBar>

      <Card>
        <CardHeader title="Collection log" subtitle="Warnings and errors written while sources ran, newest first — blocked pages, missing listings, failed requests and unreadable prices. Lines of simulated runs are marked." />
        {logs.isError && !logs.data ? (
          <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={logs.data?.rows}
            rowKey={(l) => l.id}
            dense
            loading={logs.isPending}
            refetching={logs.isPlaceholderData}
            empty={
              activeFilters > 0 ? (
                <EmptyState title="No log line matches these filters" description="Widen the date range or remove a filter." action={<Button size="sm" onClick={() => set({ ...cleared(LOG_FILTER_KEYS), l_page: undefined })}>Reset filters</Button>} />
              ) : (
                <EmptyState title="The log is empty" description="Lines appear here when a collection run reports a warning or an error." />
              )
            }
            footer={logs.data ? <Pagination page={logs.data.page} pages={logs.data.pages} total={logs.data.total} pageSize={logs.data.page_size} onPage={(p) => set({ l_page: String(p) })} noun="lines" /> : undefined}
          />
        )}
      </Card>
    </div>
  );
}
