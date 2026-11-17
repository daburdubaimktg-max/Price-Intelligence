/**
 * Sources: every retailer as a collection source — what state it is really in, when it last ran and what it
 * needs. A source that is not configured says so (and says what is missing); it is never shown as working.
 */
import { useNavigate } from 'react-router';
import { Ellipsis, ListChecks, MonitorDot, PanelRight, Play, PlugZap, ScrollText, Settings2, TimerOff } from 'lucide-react';
import { fmtNumber, fmtRelative } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useReference } from '@/lib/hooks.ts';
import { Menu } from '@/components/ui/overlays.tsx';
import { Button, Card, CardHeader, EmptyState, ErrorState, IconButton, Notice, Tip } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { FilterBar, MultiSelect, SearchInput } from '@/components/ui/filters.tsx';
import { DemoBadge, FrequencyLabel, MarketTime, MethodLabel } from '@/components/domain/domain.tsx';
import { COLLECTION_METHODS, COLLECTION_METHOD_LABELS } from '@shared/constants.ts';
import type { CollectionHealth, CollectionSource } from '@shared/api/collection.ts';
import { hostOf, JobStatusBadge, runSummary, SOURCE_STATUSES, SOURCE_STATUS_META, SourceStatusBadge, useCollectionActions } from './shared.tsx';
import { cleared, countActive, JOB_FILTER_KEYS, LOG_FILTER_KEYS, SOURCE_FILTER_KEYS, useCollectionUrl } from './url.ts';

type SourcesResponse = { rows: CollectionSource[]; total: number };

export function SourcesTab({ onTest }: { onTest: (retailerId: number) => void }) {
  const navigate = useNavigate();
  const actions = useCollectionActions();
  const { ref } = useReference();
  const { state, set } = useCollectionUrl();
  const sources = useApiQuery<SourcesResponse>(['collection', 'sources'], '/collection/sources', { status: state.s_status, method: state.s_method, market_id: state.s_market, q: state.s_q }, {
    refetchInterval: 60_000,
  });
  // Only for the scheduler state: "next run" means something different when nothing runs automatically.
  const health = useApiQuery<CollectionHealth>(['collection', 'health'], '/collection/health', { days: 14 }, { staleTime: 30_000 });
  const schedulerOff = health.data ? !health.data.scheduler.enabled : false;
  const activeFilters = countActive(state, SOURCE_FILTER_KEYS);

  const columns: Array<Column<CollectionSource>> = [
    {
      key: 'source',
      header: 'Source',
      cell: (s) => (
        <div className="min-w-[7.5rem] sm:min-w-[10rem]">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="font-medium text-ink">{s.name}</span>
            {s.is_demo ? <DemoBadge /> : null}
          </div>
          <div className="text-[11.5px] text-ink-3">
            {s.market_name}
            <span className="num"> · {s.currency_code}</span>
            {hostOf(s.website) ? <span className="hidden sm:inline"> · {hostOf(s.website)}</span> : null}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => (
        <div className="max-w-[28rem] sm:min-w-[8.5rem] lg:min-w-[15rem]">
          <SourceStatusBadge status={s.status} />
          <p className="mt-1 hidden text-[11.5px] leading-4 text-ink-3 sm:line-clamp-2" title={s.status_reason}>
            {s.status_reason}
          </p>
        </div>
      ),
    },
    {
      key: 'method',
      header: 'Method · frequency',
      hideBelow: 'md',
      cell: (s) => (
        <div className="min-w-[9rem] text-[12.5px]">
          <div className="text-ink-2">
            <MethodLabel method={s.method} />
          </div>
          <div className="text-[11.5px] text-ink-3">
            <FrequencyLabel frequency={s.frequency} />
            {s.frequency_inherited ? ' · market default' : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'last',
      header: 'Last run',
      hideBelow: 'lg',
      headerTitle: 'Outcome of the most recent run. Simulated runs are marked as such and are not real collection.',
      cell: (s) =>
        s.latest_job ? (
          <div className="flex min-w-[10rem] flex-col items-start gap-1">
            <JobStatusBadge status={s.latest_job.status} dataClass={s.latest_job.data_class} />
            <span className="text-[11.5px] leading-4 text-ink-3">
              {fmtRelative(s.latest_job.finished_at ?? s.latest_job.started_at ?? s.latest_job.created_at)} · {runSummary(s.latest_job)}
            </span>
          </div>
        ) : (
          <span className="text-[12.5px] whitespace-nowrap text-ink-4">{s.runnable ? 'Never run' : 'Nothing to run'}</span>
        ),
    },
    {
      key: 'next',
      header: 'Next run',
      hideBelow: 'xl',
      headerTitle: 'When the source is next due, in the market’s own time',
      cell: (s) => (
        <span className="text-[12.5px] whitespace-nowrap">
          {!s.runnable ? (
            <span className="text-ink-4">Not scheduled</span>
          ) : s.status === 'not_configured' ? (
            <span className="text-ink-3">Not until configured</span>
          ) : s.status === 'paused' ? (
            <span className="text-ink-3">Paused</span>
          ) : s.next_run_at ? (
            <MarketTime iso={s.next_run_at} timeZone={s.timezone} short />
          ) : (
            <span className="text-ink-3">{s.frequency === 'manual' ? 'Manual runs only' : 'Nothing scheduled'}</span>
          )}
        </span>
      ),
    },
    {
      key: 'listings',
      header: 'Listings',
      align: 'right',
      hideBelow: 'sm',
      headerTitle: 'Active listings at this retailer',
      cell: (s) => (
        <span>
          {fmtNumber(s.listings_active)}
          {s.listings_unmatched ? <span className="block text-[11.5px] text-ink-3">{fmtNumber(s.listings_unmatched)} unmatched</span> : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '48px',
      cell: (s) => (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Menu
            trigger={<IconButton icon={Ellipsis} label={`Actions for ${s.name}`} size="sm" />}
            items={[
              { label: 'Open source', icon: PanelRight, onSelect: () => set({ source: String(s.retailer_id) }) },
              {
                label: s.method === 'simulated' ? 'Run now (simulated)' : 'Run now',
                icon: Play,
                hidden: !actions.canRun || !s.runnable,
                disabled: !s.is_active || actions.busy.has(`source:${s.retailer_id}`),
                onSelect: () => void actions.run(s),
              },
              { label: 'Test connection', icon: PlugZap, hidden: !actions.canManage || !s.runnable, onSelect: () => onTest(s.retailer_id) },
              { label: actions.canManage ? 'Configure in Administration' : 'View in Administration', icon: Settings2, onSelect: () => navigate(`/admin?tab=retailers&retailer=${s.retailer_id}`) },
              {
                label: 'Jobs of this source',
                icon: ListChecks,
                separatorBefore: true,
                hidden: !s.runnable,
                onSelect: () => set({ ...cleared(JOB_FILTER_KEYS), tab: 'jobs', j_retailer: String(s.retailer_id), j_page: undefined }),
              },
              {
                label: 'Logs of this source',
                icon: ScrollText,
                hidden: !s.runnable,
                onSelect: () => set({ ...cleared(LOG_FILTER_KEYS), tab: 'logs', l_retailer: String(s.retailer_id), l_page: undefined }),
              },
              { label: 'Listings in the Live Price Monitor', icon: MonitorDot, onSelect: () => navigate(`/monitor?retailer_id=${s.retailer_id}`) },
            ]}
          />
        </span>
      ),
    },
  ];

  return (
    <div>
      <FilterBar activeCount={activeFilters} onReset={() => set(cleared(SOURCE_FILTER_KEYS))}>
        <MultiSelect
          label="Status"
          options={SOURCE_STATUSES.map((s) => ({ value: s, label: SOURCE_STATUS_META[s].label }))}
          value={toList(state.s_status)}
          onChange={(next) => set({ s_status: fromList(next) })}
        />
        <MultiSelect
          label="Method"
          options={COLLECTION_METHODS.map((m) => ({ value: m, label: COLLECTION_METHOD_LABELS[m] }))}
          value={toList(state.s_method)}
          onChange={(next) => set({ s_method: fromList(next) })}
        />
        <MultiSelect
          label="Market"
          options={(ref?.markets ?? []).map((m) => ({ value: String(m.id), label: m.name, sublabel: m.currency_code }))}
          value={toList(state.s_market)}
          onChange={(next) => set({ s_market: fromList(next) })}
        />
        <SearchInput value={state.s_q ?? ''} onChange={(next) => set({ s_q: next || undefined })} placeholder="Search source or website…" />
      </FilterBar>

      {schedulerOff && (sources.data?.rows.some((s) => s.runnable) ?? false) ? (
        <Notice tone="warn" icon={TimerOff} className="mb-4" title="Automatic scheduling is switched off on this server">
          Nothing runs by itself: “Next run” shows when a source becomes due. Start a source with Run now, or everything that is due with “Run due sources now”.
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="Sources"
          subtitle="One row per retailer, with what is really happening at each."
          actions={
            <>
              {actions.canRun ? (
                <Tip content="Starts every enabled source whose run is due, and every retry that is due — what the scheduler does on its next pass.">
                  <span className="inline-flex">
                    <Button icon={Play} loading={actions.busy.has('run-due')} onClick={() => void actions.runDue()}>
                      Run due sources now
                    </Button>
                  </span>
                </Tip>
              ) : null}
              <Button icon={Settings2} onClick={() => navigate('/admin?tab=retailers')}>
                {actions.canManage ? 'Add or configure' : 'Source settings'}
              </Button>
            </>
          }
        />
        {sources.isError && !sources.data ? (
          <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={sources.data?.rows}
            rowKey={(s) => s.retailer_id}
            loading={sources.isPending}
            refetching={sources.isPlaceholderData}
            onRowClick={(s) => set({ source: String(s.retailer_id) })}
            selectedKey={state.source ? Number(state.source) : null}
            empty={
              activeFilters > 0 ? (
                <EmptyState title="No source matches these filters" description="Remove a filter to see more sources." action={<Button size="sm" onClick={() => set(cleared(SOURCE_FILTER_KEYS))}>Reset filters</Button>} />
              ) : (
                <EmptyState
                  title="No sources yet"
                  description="A source is a retailer with a collection method — an official API, a product feed, permitted website extraction, a data provider, file imports or manual entry."
                  action={
                    <Button size="sm" variant="primary" onClick={() => navigate('/admin?tab=retailers')}>
                      Add a retailer in Administration
                    </Button>
                  }
                />
              )
            }
            footer={
              sources.data && sources.data.rows.length > 0 ? (
                <div className="border-t border-line px-4 py-2.5 text-[12.5px] text-ink-3">
                  <span className="num">{fmtNumber(sources.data.total)}</span> {sources.data.total === 1 ? 'source' : 'sources'}
                  {activeFilters > 0 ? ' match the filters' : ''}
                </div>
              ) : undefined
            }
          />
        )}
      </Card>
    </div>
  );
}
