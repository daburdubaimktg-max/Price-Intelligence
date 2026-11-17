/** Alerts Centre: the alert feed, the rules that raise alerts, and personal notification preferences. */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api.ts';
import { useUrlState } from '@/lib/hooks.ts';
import { Page } from '@/app/AppShell.tsx';
import { PageHeader, Tabs } from '@/components/ui/primitives.tsx';
import type { AlertUnreadCount } from '@shared/api/alerts.ts';
import { AlertsTab } from './AlertsTab.tsx';
import { PreferencesTab } from './PreferencesTab.tsx';
import { RulesTab } from './RulesTab.tsx';

type TabKey = 'alerts' | 'rules' | 'preferences';
const TAB_KEYS: TabKey[] = ['alerts', 'rules', 'preferences'];

export default function AlertsPage() {
  const { state, set } = useUrlState<{ tab: string | undefined }>({ tab: 'alerts' });
  const tab: TabKey = TAB_KEYS.includes(state.tab as TabKey) ? (state.tab as TabKey) : 'alerts';
  const unread = useQuery({ queryKey: ['alerts', 'unread-count'], queryFn: () => apiGet<AlertUnreadCount>('/alerts/unread-count'), staleTime: 30_000 });

  return (
    <Page>
      <PageHeader
        title="Alerts Centre"
        description="Alerts are raised from stored observations by the rules you configure — price drops, promotions, stock-outs, pricing gaps, and collection problems. Every alert is kept in the history."
      />
      <Tabs
        value={tab}
        onChange={(next) => set({ tab: next })}
        tabs={[
          { value: 'alerts', label: 'Alerts', count: unread.data ? unread.data.total_open : null },
          { value: 'rules', label: 'Rules' },
          { value: 'preferences', label: 'Notification preferences' },
        ]}
      >
        {tab === 'alerts' ? <AlertsTab /> : tab === 'rules' ? <RulesTab /> : <PreferencesTab />}
      </Tabs>
    </Page>
  );
}
