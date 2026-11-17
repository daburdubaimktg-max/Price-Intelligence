/** Audit trail: who did what and when. The log is append-only on the server. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, type Paged } from '@/lib/api.ts';
import { fmtDateTime } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useDates, useUrlState } from '@/lib/hooks.ts';
import { Drawer } from '@/components/ui/overlays.tsx';
import { Card, DescriptionList, EmptyState, ErrorState } from '@/components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { DateRangePicker, FilterBar, MultiSelect, SearchInput } from '@/components/ui/filters.tsx';
import type { AuditLogRow, UserRow } from '@shared/api/admin.ts';
import { JsonBlock } from './shared.tsx';

type AuditUrl = {
  a_user: string | undefined;
  a_action: string | undefined;
  a_entity: string | undefined;
  a_from: string | undefined;
  a_to: string | undefined;
  a_q: string | undefined;
  a_page: string | undefined;
};
const DEFAULTS: AuditUrl = { a_user: undefined, a_action: undefined, a_entity: undefined, a_from: undefined, a_to: undefined, a_q: undefined, a_page: '1' };

function summarise(detail: unknown): string {
  if (detail === null || detail === undefined) return '';
  if (typeof detail !== 'object') return String(detail);
  const entries = Object.entries(detail as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== '');
  return entries
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

export function AuditTab() {
  const { state, set } = useUrlState<AuditUrl>(DEFAULTS);
  const dates = useDates();
  const [selected, setSelected] = useState<AuditLogRow | null>(null);
  const facets = useQuery({ queryKey: ['audit-log', 'facets'], queryFn: () => apiGet<{ actions: string[]; entity_types: string[] }>('/audit-log/facets'), staleTime: 60_000 });
  const users = useQuery({ queryKey: ['users'], queryFn: () => apiGet<{ rows: UserRow[] }>('/users'), staleTime: 60_000 });
  const log = useApiQuery<Paged<AuditLogRow>>(['audit-log', 'list'], '/audit-log', {
    user_id: state.a_user,
    action: state.a_action,
    entity_type: state.a_entity,
    from: state.a_from,
    to: state.a_to,
    q: state.a_q,
    page: state.a_page,
    page_size: 50,
  });

  const activeFilters = (['a_user', 'a_action', 'a_entity', 'a_from', 'a_to', 'a_q'] as const).filter((k) => state[k] !== undefined).length;
  const patch = (changes: Partial<AuditUrl>) => set({ ...changes, a_page: undefined });

  const columns: Array<Column<AuditLogRow>> = [
    {
      key: 'at',
      header: 'Time (your time zone)',
      cell: (row) => <span className="num text-ink-2 sm:whitespace-nowrap">{fmtDateTime(row.at)}</span>,
    },
    {
      key: 'user',
      header: 'User',
      hideBelow: 'sm',
      cell: (row) => (
        <div className="min-w-[8rem]">
          <div className="text-ink">{row.user_name ?? row.user_email ?? 'System'}</div>
          {row.user_name && row.user_email ? <div className="text-[11.5px] text-ink-3">{row.user_email}</div> : null}
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      cell: (row) => (
        <div>
          <span className="mono break-all text-ink sm:break-normal sm:whitespace-nowrap">{row.action}</span>
          <div className="text-[11.5px] text-ink-3 sm:hidden">{row.user_name ?? row.user_email ?? 'System'}</div>
        </div>
      ),
    },
    {
      key: 'entity',
      header: 'Record',
      hideBelow: 'md',
      cell: (row) =>
        row.entity_type ? (
          <span className="whitespace-nowrap text-ink-2">
            {row.entity_type.replace(/_/g, ' ')}
            {row.entity_id ? <span className="mono text-ink-3"> #{row.entity_id}</span> : null}
          </span>
        ) : (
          <span className="text-ink-4">—</span>
        ),
    },
    { key: 'detail', header: 'Detail', hideBelow: 'lg', cell: (row) => <span className="line-clamp-1 max-w-[30rem] text-[12.5px] break-all text-ink-3">{summarise(row.detail) || '—'}</span> },
    { key: 'ip', header: 'IP address', hideBelow: 'xl', cell: (row) => <span className="mono text-ink-3">{row.ip ?? '—'}</span> },
  ];

  return (
    <div>
      <FilterBar activeCount={activeFilters} onReset={() => set({ a_user: undefined, a_action: undefined, a_entity: undefined, a_from: undefined, a_to: undefined, a_q: undefined, a_page: undefined })}>
        <DateRangePicker
          label="When"
          value={{ from: state.a_from, to: state.a_to }}
          today={dates.data?.today ?? new Date().toISOString().slice(0, 10)}
          presets={['today', '7d', '30d', '90d', 'all']}
          onChange={(range) => patch({ a_from: range.from, a_to: range.to })}
        />
        <MultiSelect
          label="User"
          options={(users.data?.rows ?? []).map((u) => ({ value: String(u.id), label: u.name, sublabel: u.email }))}
          value={toList(state.a_user)}
          onChange={(next) => patch({ a_user: fromList(next) })}
        />
        <MultiSelect
          label="Action"
          single
          searchable
          options={(facets.data?.actions ?? []).map((a) => ({ value: a, label: a }))}
          value={state.a_action ? [state.a_action] : []}
          onChange={(next) => patch({ a_action: next[0] })}
        />
        <MultiSelect
          label="Record type"
          single
          options={(facets.data?.entity_types ?? []).map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
          value={state.a_entity ? [state.a_entity] : []}
          onChange={(next) => patch({ a_entity: next[0] })}
        />
        <SearchInput value={state.a_q ?? ''} onChange={(next) => patch({ a_q: next || undefined })} placeholder="Search action, detail, e-mail…" />
      </FilterBar>
      <Card>
        {log.isError ? (
          <ErrorState error={log.error} onRetry={() => void log.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={log.data?.rows}
            rowKey={(row) => row.id}
            dense
            onRowClick={setSelected}
            selectedKey={selected?.id ?? null}
            loading={log.isPending}
            refetching={log.isPlaceholderData || (log.isFetching && !log.isPending)}
            empty={<EmptyState title={activeFilters ? 'No entries match these filters' : 'Nothing has been recorded yet'} />}
          />
        )}
        {log.data ? <Pagination page={log.data.page} pages={log.data.pages} total={log.data.total} pageSize={log.data.page_size} noun="entries" onPage={(page) => set({ a_page: String(page) })} /> : null}
      </Card>
      <p className="mt-2 text-[12px] text-ink-3">Entries can be added but never changed or removed. Credentials and passwords are never written to the log.</p>

      <Drawer open={selected !== null} onClose={() => setSelected(null)} title={selected?.action ?? 'Audit entry'} subtitle={selected ? `${fmtDateTime(selected.at)} · entry #${selected.id}` : undefined}>
        {selected ? (
          <>
            <DescriptionList
              items={[
                { label: 'User', value: selected.user_name ? `${selected.user_name} (${selected.user_email})` : (selected.user_email ?? 'System') },
                { label: 'Time (UTC)', value: <span className="mono">{selected.at}</span> },
                { label: 'Record', value: selected.entity_type ? `${selected.entity_type.replace(/_/g, ' ')}${selected.entity_id ? ` #${selected.entity_id}` : ''}` : '—' },
                { label: 'IP address', value: <span className="mono">{selected.ip ?? '—'}</span> },
              ]}
            />
            <h3 className="eyebrow mt-5 mb-2">Detail</h3>
            {selected.detail === null || selected.detail === undefined ? <p className="text-[12.5px] text-ink-3">No detail was recorded.</p> : <JsonBlock value={selected.detail} />}
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
