/** Administration: users, markets, retailers & listings, exchange rates, integrations, settings, database (Excel), audit, system. */
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth.tsx';
import { useUrlState } from '@/lib/hooks.ts';
import { Page } from '@/app/AppShell.tsx';
import { PageHeader, Tabs } from '@/components/ui/primitives.tsx';
import type { Permission } from '@shared/constants.ts';
import { AuditTab } from './AuditTab.tsx';
import { DatabaseTab } from './DatabaseTab.tsx';
import { IntegrationsTab } from './IntegrationsTab.tsx';
import { MarketsTab } from './MarketsTab.tsx';
import { RatesTab } from './RatesTab.tsx';
import { RetailersTab } from './RetailersTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { NoAccess } from './shared.tsx';
import { SystemTab } from './SystemTab.tsx';
import { UsersTab } from './UsersTab.tsx';

type TabKey = 'users' | 'markets' | 'retailers' | 'rates' | 'integrations' | 'settings' | 'database' | 'audit' | 'system';

interface TabDef {
  key: TabKey;
  label: string;
  /** Permission needed to open the tab at all. null = every signed-in user may view it (writes are gated inside). */
  permission: Permission | null;
  needs: string;
  render: () => ReactNode;
}

const TABS: TabDef[] = [
  { key: 'users', label: 'Users', permission: 'admin.users', needs: 'Managing users requires the Administrator role.', render: () => <UsersTab /> },
  { key: 'markets', label: 'Markets', permission: null, needs: '', render: () => <MarketsTab /> },
  { key: 'retailers', label: 'Retailers & listings', permission: null, needs: '', render: () => <RetailersTab /> },
  { key: 'rates', label: 'Exchange rates', permission: null, needs: '', render: () => <RatesTab /> },
  { key: 'integrations', label: 'Integrations', permission: 'admin.integrations', needs: 'Integration credentials can only be managed by administrators.', render: () => <IntegrationsTab /> },
  { key: 'settings', label: 'Settings', permission: 'admin.settings', needs: 'Workspace settings can only be changed by administrators.', render: () => <SettingsTab /> },
  { key: 'database', label: 'Database (Excel)', permission: 'database.export', needs: 'Exporting the database requires the Analyst or Administrator role.', render: () => <DatabaseTab /> },
  { key: 'audit', label: 'Audit log', permission: 'admin.audit', needs: 'The audit log is visible to administrators only.', render: () => <AuditTab /> },
  { key: 'system', label: 'System', permission: 'admin.settings', needs: 'System information is visible to administrators only.', render: () => <SystemTab /> },
];

export default function AdminPage() {
  const { can } = useAuth();
  const allowed = TABS.filter((t) => t.permission === null || can(t.permission));
  const { state, set } = useUrlState<{ tab: string | undefined }>({ tab: undefined });
  const requested = TABS.find((t) => t.key === state.tab);
  const active = requested ?? allowed[0]!;
  const permitted = allowed.some((t) => t.key === active.key);
  // A tab the role cannot use is not offered — but a direct link to it gets a clear explanation, not a broken screen.
  const shown = permitted ? allowed : [...allowed, active];

  return (
    <Page>
      <PageHeader
        title="Administration"
        description="Who can sign in, which markets and retailers are monitored, how currencies are converted, which integrations are connected — and your data as an Excel workbook."
      />
      <Tabs value={active.key} onChange={(next) => set({ tab: next })} tabs={shown.map((t) => ({ value: t.key, label: t.label }))}>
        {permitted ? active.render() : <NoAccess what={active.label} needs={active.needs} />}
      </Tabs>
    </Page>
  );
}
