/**
 * Health: is anything really being collected?
 * Real collection and simulated demo runs are reported side by side and are never added together;
 * a rate is "n/a" when no attempt was made, never a default 100 %.
 */
import { CircleAlert, LoaderCircle, RefreshCw, Timer, TimerOff } from 'lucide-react';
import { useApiQuery } from '@/lib/hooks.ts';
import { Badge, Button, Card, cn, ErrorState, LoadingBlock, Notice, Segmented, Tip } from '@/components/ui/primitives.tsx';
import { FilterBar } from '@/components/ui/filters.tsx';
import type { CollectionHealth, SourceStatus } from '@shared/api/collection.ts';
import { FreshnessCard, ProvenanceCard, RunsChart } from './HealthCharts.tsx';
import { AttentionTiles, RunsPanel, SourceLedger } from './HealthPanels.tsx';
import { kindOf, type SourcesResponse } from './health-shared.tsx';
import { RetailerHealth } from './RetailerHealth.tsx';
import { ViewerTime } from './shared.tsx';
import { cleared, JOB_FILTER_KEYS, SOURCE_FILTER_KEYS, useCollectionUrl } from './url.ts';

const WINDOWS = ['7', '14', '30'] as const;

export function HealthTab() {
  const { state, set } = useCollectionUrl();
  const days = WINDOWS.includes(state.h_days as (typeof WINDOWS)[number]) ? Number(state.h_days) : 14;
  const health = useApiQuery<CollectionHealth>(['collection', 'health'], '/collection/health', { days }, {
    // follow running jobs closely, otherwise a quiet minute-by-minute refresh
    refetchInterval: (query) => {
      const s = query.state.data?.scheduler;
      return s && s.running_jobs + s.queued_jobs > 0 ? 4000 : 60_000;
    },
  });
  const sources = useApiQuery<SourcesResponse>(['collection', 'sources'], '/collection/sources', {}, { refetchInterval: 60_000 });

  const openSources = (statuses: SourceStatus[]) => set({ ...cleared(SOURCE_FILTER_KEYS), tab: 'sources', s_status: statuses.length ? statuses.join(',') : undefined });
  const data = health.data;
  // dim only while a different window is loading — not on every background refresh
  const refetching = health.isPlaceholderData;
  const showSimulated = !!data && (data.sources.simulated > 0 || data.window.simulated.attempts > 0 || !!data.last_simulated_run_at);
  const busy = data ? data.scheduler.running_jobs + data.scheduler.queued_jobs : 0;
  const realSourceCount = sources.data ? sources.data.rows.filter((s) => kindOf(s) === 'real').length : undefined;

  return (
    <div>
      <FilterBar
        trailing={
          <>
            {data ? (
              <span className="text-[12px] text-ink-3">
                As of <ViewerTime iso={data.generated_at} className="!text-ink-3" />
              </span>
            ) : null}
            <Button
              icon={RefreshCw}
              loading={health.isFetching || sources.isFetching}
              onClick={() => {
                void health.refetch();
                void sources.refetch();
              }}
            >
              Refresh
            </Button>
          </>
        }
      >
        <Segmented
          label="Window"
          value={String(days)}
          onChange={(next) => set({ h_days: next })}
          options={WINDOWS.map((w) => ({ value: w, label: `${w} days` }))}
        />
        {data ? (
          data.scheduler.enabled ? (
            <Tip content="The scheduler starts every enabled, fully configured source at its frequency and retries failed runs automatically.">
              <span className="inline-flex">
                <Badge tone="neutral" icon={Timer}>
                  Scheduler on
                </Badge>
              </span>
            </Tip>
          ) : (
            <Tip content="Automatic scheduling is switched off on this server (PIOS_SCHEDULER). Sources run only when someone starts them from the Sources tab.">
              <span className="inline-flex">
                <Badge tone="warn" icon={TimerOff}>
                  Scheduler off — runs are started manually
                </Badge>
              </span>
            </Tip>
          )
        ) : null}
        {busy > 0 && data ? (
          <button type="button" className="inline-flex" onClick={() => set({ ...cleared(JOB_FILTER_KEYS), tab: 'jobs', j_status: 'queued,running', j_page: undefined })} title="Open the jobs in progress">
            <Badge tone="accent" icon={LoaderCircle}>
              {data.scheduler.running_jobs} running · {data.scheduler.queued_jobs} queued
            </Badge>
          </button>
        ) : null}
      </FilterBar>

      {health.isError && !data ? (
        <Card>
          <ErrorState
            error={health.error}
            onRetry={() => {
              void health.refetch();
              if (sources.isError) void sources.refetch();
            }}
          />
        </Card>
      ) : !data ? (
        <Card>
          <LoadingBlock label="Loading collection health…" />
        </Card>
      ) : (
        <div className={cn('flex flex-col gap-4 transition-opacity', refetching && 'opacity-80')}>
          {health.isError ? (
            <Notice tone="crit" icon={CircleAlert} title="The latest refresh failed">
              Showing the figures from <ViewerTime iso={data.generated_at} />.
            </Notice>
          ) : null}
          <div className={cn('grid gap-4', showSimulated && 'lg:grid-cols-2')}>
            <RunsPanel kind="real" health={data} days={data.window_days} realSourceCount={realSourceCount} onOpenSources={openSources} />
            {showSimulated ? <RunsPanel kind="simulated" health={data} days={data.window_days} realSourceCount={realSourceCount} onOpenSources={openSources} /> : null}
          </div>

          <SourceLedger health={data} sources={sources.data?.rows} onOpenSources={openSources} />

          <AttentionTiles health={data} sources={sources.data?.rows} days={data.window_days} go={set} />

          <div className={cn('grid gap-4', showSimulated && 'lg:grid-cols-2')}>
            <RunsChart kind="real" health={data} days={data.window_days} refetching={refetching} />
            {showSimulated ? <RunsChart kind="simulated" health={data} days={data.window_days} refetching={refetching} /> : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <FreshnessCard sources={sources.data?.rows} loading={sources.isPending} error={sources.isError && !sources.data ? sources.error : null} onRetry={() => void sources.refetch()} />
            <ProvenanceCard health={data} />
          </div>

          <RetailerHealth
            sources={sources.data?.rows}
            loading={sources.isPending}
            error={sources.isError && !sources.data ? sources.error : null}
            refetching={sources.isPlaceholderData}
            onRetry={() => void sources.refetch()}
            onOpen={(id) => set({ source: String(id) })}
            view={state.h_view === 'attention' ? 'attention' : 'all'}
            page={Math.max(1, Number(state.h_page) || 1)}
            onView={(next) => set({ h_view: next, h_page: undefined })}
            onPage={(next) => set({ h_page: String(next) })}
            selected={state.source ? Number(state.source) : null}
          />
        </div>
      )}
    </div>
  );
}
