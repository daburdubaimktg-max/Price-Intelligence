/**
 * Data Collection Centre: which sources are really collecting, which are failing or not configured, what was
 * imported or typed in, and which figures are simulated DEMO data — with the jobs, logs and retries behind them.
 */
import { useCallback, useState } from 'react';
import { useApiQuery } from '@/lib/hooks.ts';
import { Page } from '@/app/AppShell.tsx';
import { PageHeader, Tabs } from '@/components/ui/primitives.tsx';
import type { CollectionHealth } from '@shared/api/collection.ts';
import { HealthTab } from './HealthTab.tsx';
import { ImportsTab } from './ImportsTab.tsx';
import { JobDrawer } from './JobDrawer.tsx';
import { JobsTab } from './JobsTab.tsx';
import { LogsTab } from './LogsTab.tsx';
import { MethodsTab } from './MethodsTab.tsx';
import { PlannerTab } from './PlannerTab.tsx';
import { CollectionActionsProvider } from './shared.tsx';
import { SourceDrawer } from './SourceDrawer.tsx';
import { SourcesTab } from './SourcesTab.tsx';
import { TAB_KEYS, useCollectionUrl, type TabKey } from './url.ts';

function CollectionCentre() {
  const { state, set } = useCollectionUrl();
  const tab: TabKey = TAB_KEYS.includes(state.tab as TabKey) ? (state.tab as TabKey) : 'health';
  // Shares the Health tab's cache entry; only used for the tab counters.
  const health = useApiQuery<CollectionHealth>(['collection', 'health'], '/collection/health', { days: 14 }, { staleTime: 30_000 });
  const [testFor, setTestFor] = useState<number | null>(null);
  const sourceId = state.source && Number.isInteger(Number(state.source)) ? Number(state.source) : null;
  const jobId = state.job && Number.isInteger(Number(state.job)) ? Number(state.job) : null;
  const clearTest = useCallback(() => setTestFor(null), []);
  const running = health.data ? health.data.scheduler.running_jobs + health.data.scheduler.queued_jobs : 0;

  return (
    <Page>
      <PageHeader
        title="Data Collection Centre"
        description="Where every price comes from. Real collection, imported history, manual entry and simulated DEMO data are kept apart — and a source that is not configured or has failed says so."
      />
      <Tabs<TabKey>
        value={tab}
        onChange={(next) => set({ tab: next })}
        tabs={[
          { value: 'health', label: 'Health' },
          { value: 'sources', label: 'Sources', count: health.data ? health.data.sources.total : null },
          { value: 'jobs', label: 'Jobs', count: running > 0 ? running : null },
          { value: 'logs', label: 'Logs' },
          { value: 'imports', label: 'Imports & manual entry' },
          { value: 'methods', label: 'Methods' },
          { value: 'planner', label: 'Cost planner' },
        ]}
      >
        {tab === 'health' ? (
          <HealthTab />
        ) : tab === 'sources' ? (
          <SourcesTab
            onTest={(retailerId) => {
              setTestFor(retailerId);
              set({ source: String(retailerId) });
            }}
          />
        ) : tab === 'jobs' ? (
          <JobsTab />
        ) : tab === 'logs' ? (
          <LogsTab />
        ) : tab === 'imports' ? (
          <ImportsTab />
        ) : tab === 'planner' ? (
          <PlannerTab />
        ) : (
          <MethodsTab />
        )}
      </Tabs>

      <SourceDrawer retailerId={sourceId} autoTest={testFor !== null && testFor === sourceId} onAutoTestDone={clearTest} onClose={() => set({ source: undefined })} />
      <JobDrawer jobId={jobId} onClose={() => set({ job: undefined })} />
    </Page>
  );
}

export default function CollectionPage() {
  return (
    <CollectionActionsProvider>
      <CollectionCentre />
    </CollectionActionsProvider>
  );
}
