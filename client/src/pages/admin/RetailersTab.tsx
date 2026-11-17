/** Retailers (collection sources) and their listings. Adding a retailer is configuration only. */
import { useState } from 'react';
import { Ellipsis, KeyRound, List, Pause, Pencil, Play, Plus, Power, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost, type Paged } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtNumber } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useReference, useUrlState } from '@/lib/hooks.ts';
import { ConfirmDialog, Menu, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, IconButton, Notice, Segmented } from '@/components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { FilterBar, MultiSelect, SearchInput } from '@/components/ui/filters.tsx';
import { DemoBadge, FrequencyLabel, MarketTime, MethodLabel } from '@/components/domain/domain.tsx';
import { AUTOMATED_METHODS, COLLECTION_METHODS, COLLECTION_METHOD_LABELS } from '@shared/constants.ts';
import type { RetailerRow } from '@shared/api/catalogue.ts';
import type { CollectionHealth, CollectionJob } from '@shared/api/collection.ts';
import { RetailerDialog, useConnectors } from './RetailerDialog.tsx';
import { RetailerDrawer } from './RetailerDrawer.tsx';
import { errorText, useRefresh } from './shared.tsx';

type RetailersUrl = {
  r_market: string | undefined;
  r_method: string | undefined;
  r_q: string | undefined;
  r_state: string | undefined;
  r_page: string | undefined;
  r_sort: string | undefined;
  retailer: string | undefined;
  r_view: string | undefined;
};
const DEFAULTS: RetailersUrl = { r_market: undefined, r_method: undefined, r_q: undefined, r_state: 'active', r_page: '1', r_sort: undefined, retailer: undefined, r_view: undefined };

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function RetailersTab() {
  const canManage = useCan('sources.manage');
  const canRun = useCan('collection.run');
  const canListings = useCan('catalogue.write');
  const toast = useToast();
  const refresh = useRefresh();
  const { ref } = useReference();
  const { state, set } = useUrlState<RetailersUrl>(DEFAULTS);
  const [editing, setEditing] = useState<RetailerRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<RetailerRow | null>(null);
  const [busy, setBusy] = useState(false);

  // What each method needs (credential, access attestation) comes from the server's connector descriptions.
  const connectors = useConnectors();
  const connectorOf = (method: RetailerRow['collection_method']) => connectors.data?.rows.find((c) => c.method === method);

  // Scheduled "next run" times only mean something while the server's scheduler is running.
  const health = useQuery({
    queryKey: ['collection', 'health', { days: 1 }],
    queryFn: () => apiGet<CollectionHealth>('/collection/health', { days: 1 }),
    staleTime: 5 * 60_000,
  });

  const stateFilter = state.r_state ?? 'active';
  const retailers = useApiQuery<Paged<RetailerRow>>(['retailers', 'list'], '/retailers', {
    market_id: state.r_market,
    method: state.r_method,
    q: state.r_q,
    active: stateFilter === 'all' ? undefined : stateFilter === 'active',
    sort: state.r_sort,
    page: state.r_page,
    page_size: 50,
  });

  const activeFilters = (['r_market', 'r_method', 'r_q', 'r_state'] as const).filter((k) => state[k] !== undefined && state[k] !== DEFAULTS[k]).length;
  const patch = (changes: Partial<RetailersUrl>) => set({ ...changes, r_page: undefined });
  const refreshAll = () => refresh(['retailers'], ['reference'], ['collection'], ['markets'], ['market-intel']);

  async function update(retailer: RetailerRow, body: Record<string, unknown>, done: string) {
    try {
      await apiPatch(`/retailers/${retailer.id}`, body);
      toast.success(done, retailer.name);
      await refreshAll();
    } catch (err) {
      toast.error('The retailer was not changed', errorText(err));
    }
  }

  async function run(retailer: RetailerRow) {
    try {
      const result = await apiPost<{ job: CollectionJob }>(`/collection/retailers/${retailer.id}/run`);
      toast.success('Collection started', `Job #${result.job.id} for ${retailer.name}. Follow it in the Data Collection Centre.`);
      await refreshAll();
    } catch (err) {
      toast.error('The collection was not started', errorText(err));
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await apiDelete(`/retailers/${deleting.id}`);
      toast.success('Retailer deleted', deleting.name);
      await refreshAll();
    } catch (err) {
      toast.error('The retailer was not deleted', errorText(err));
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }

  const columns: Array<Column<RetailerRow>> = [
    {
      key: 'name',
      header: 'Retailer',
      sortKey: 'name',
      cell: (r) => (
        <div className="min-w-[12rem]">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-ink">{r.name}</span>
            {r.is_demo ? <DemoBadge /> : null}
          </div>
          <div className="text-[11.5px] text-ink-3">
            <span className="md:hidden">{r.market_name} · </span>
            {hostOf(r.website) ?? 'No website recorded'}
          </div>
        </div>
      ),
    },
    {
      key: 'market',
      header: 'Market',
      sortKey: 'market',
      hideBelow: 'md',
      cell: (r) => (
        <span className="whitespace-nowrap text-ink-2">
          {r.market_name} <span className="num text-[11px] text-ink-3">{r.currency_code}</span>
        </span>
      ),
    },
    {
      key: 'method',
      header: 'Method',
      sortKey: 'method',
      hideBelow: 'sm',
      cell: (r) => (
        <div className="min-w-[9rem] text-[12.5px]">
          <div className="text-ink-2">
            <MethodLabel method={r.collection_method} />
          </div>
          <div className="text-[11.5px] text-ink-3">
            <FrequencyLabel frequency={r.effective_frequency} />
            {r.collection_frequency === null ? ' · market default' : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'Collection',
      cell: (r) => {
        if (!r.is_active) return <Badge tone="outline">Inactive</Badge>;
        if (r.collection_method === 'simulated') return <Badge tone="demo">{r.is_enabled ? 'Simulated' : 'Simulated · paused'}</Badge>;
        if (!AUTOMATED_METHODS.includes(r.collection_method)) return <Badge tone="neutral">People-driven</Badge>;
        return r.is_enabled ? <Badge tone="good">Scheduled</Badge> : <Badge tone="warn">Paused</Badge>;
      },
    },
    {
      key: 'access',
      header: 'Access',
      headerTitle: 'Stored credential and recorded access permission, where the method needs them',
      hideBelow: 'lg',
      cell: (r) => {
        const connector = connectorOf(r.collection_method);
        if (!connector) return <span className="text-[12px] text-ink-4">—</span>;
        const credential = connector.credential.needed;
        const attestation = connector.needs_permission_attestation;
        if (credential === 'never' && !attestation) return <span className="text-[12px] text-ink-4">Not needed</span>;
        return (
          <span className="flex flex-col items-start gap-1">
            {credential === 'never' ? null : r.credential.configured ? (
              <Badge tone="good" icon={KeyRound}>
                Credential stored
              </Badge>
            ) : (
              <span className="text-[12px] whitespace-nowrap text-ink-3">{credential === 'always' ? 'No credential yet' : 'No credential'}</span>
            )}
            {attestation ? (
              r.permission_attested ? (
                <Badge tone="good" icon={ShieldCheck}>
                  Permission attested
                </Badge>
              ) : (
                <Badge tone="warn" icon={ShieldAlert}>
                  Permission not attested
                </Badge>
              )
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'listings',
      header: 'Listings',
      sortKey: 'listing_count',
      align: 'right',
      headerTitle: 'Active listings / all listings',
      cell: (r) => (
        <span>
          {fmtNumber(r.active_listing_count)}
          {r.listing_count !== r.active_listing_count ? <span className="text-ink-3"> / {fmtNumber(r.listing_count)}</span> : null}
        </span>
      ),
    },
    {
      key: 'runs',
      header: 'Last success · next run',
      sortKey: 'last_success_at',
      hideBelow: 'lg',
      headerTitle: 'Last successful collection and the next scheduled run, in the market’s time',
      cell: (r) => (
        <div className="text-[12.5px] whitespace-nowrap">
          <div className="text-ink-2">{r.last_success_at ? <MarketTime iso={r.last_success_at} timeZone={r.timezone} relative /> : <span className="text-ink-4">No successful run yet</span>}</div>
          <div className="text-[11.5px] text-ink-3">
            {r.next_run_at ? (
              <>
                Next <MarketTime iso={r.next_run_at} timeZone={r.timezone} short />
              </>
            ) : (
              'Nothing scheduled'
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '48px',
      cell: (r) => {
        const automated = AUTOMATED_METHODS.includes(r.collection_method);
        return (
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Menu
              trigger={<IconButton icon={Ellipsis} label={`Actions for ${r.name}`} size="sm" />}
              items={[
                { label: 'Open source', onSelect: () => set({ retailer: String(r.id), r_view: undefined }) },
                { label: 'Listings', icon: List, onSelect: () => set({ retailer: String(r.id), r_view: 'listings' }) },
                {
                  label: 'Edit configuration',
                  icon: Pencil,
                  hidden: !canManage,
                  onSelect: () => {
                    setEditing(r);
                    setDialogOpen(true);
                  },
                },
                { label: 'Run now', icon: Play, hidden: !canRun || !automated, disabled: !r.is_active, onSelect: () => void run(r) },
                {
                  label: r.is_enabled ? 'Pause collection' : 'Resume collection',
                  icon: r.is_enabled ? Pause : Play,
                  hidden: !canManage || !automated,
                  onSelect: () => void update(r, { is_enabled: !r.is_enabled }, r.is_enabled ? 'Collection paused' : 'Collection resumed'),
                },
                {
                  label: r.is_active ? 'Deactivate' : 'Reactivate',
                  icon: Power,
                  hidden: !canManage,
                  separatorBefore: true,
                  onSelect: () => void update(r, { is_active: !r.is_active }, r.is_active ? 'Retailer deactivated' : 'Retailer reactivated'),
                },
                { label: 'Delete', icon: Trash2, danger: true, hidden: !canManage, onSelect: () => setDeleting(r) },
              ]}
            />
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <FilterBar activeCount={activeFilters} onReset={() => set({ r_market: undefined, r_method: undefined, r_q: undefined, r_state: undefined, r_page: undefined })}>
        <Segmented
          label="State"
          value={stateFilter}
          onChange={(next) => patch({ r_state: next })}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
            { value: 'all', label: 'All' },
          ]}
        />
        <MultiSelect
          label="Market"
          options={(ref?.markets ?? []).map((m) => ({ value: String(m.id), label: m.name, sublabel: m.currency_code }))}
          value={toList(state.r_market)}
          onChange={(next) => patch({ r_market: fromList(next) })}
        />
        <MultiSelect
          label="Method"
          options={COLLECTION_METHODS.map((m) => ({ value: m, label: COLLECTION_METHOD_LABELS[m] }))}
          value={toList(state.r_method)}
          onChange={(next) => patch({ r_method: fromList(next) })}
        />
        <SearchInput value={state.r_q ?? ''} onChange={(next) => patch({ r_q: next || undefined })} placeholder="Search retailer or website…" />
      </FilterBar>

      {health.data && !health.data.scheduler.enabled ? (
        <Notice tone="warn" className="mb-3" title="Automatic collection is switched off on this server">
          The scheduler is off (PIOS_SCHEDULER=off). “Next” times show when a source becomes due, but nothing starts by itself until the scheduler is switched on. “Run now”
          still works.
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="Retailers & listings"
          subtitle="Each retailer is a collection source with its own method, schedule and listings. Select a row for its configuration status, connection test and listings."
          actions={
            canManage ? (
              <Button
                variant="primary"
                icon={Plus}
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                Add retailer
              </Button>
            ) : undefined
          }
        />
        {retailers.isError ? (
          <ErrorState error={retailers.error} onRetry={() => void retailers.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={retailers.data?.rows}
            rowKey={(r) => r.id}
            sort={state.r_sort}
            onSort={(sort) => set({ r_sort: sort, r_page: undefined })}
            onRowClick={(r) => set({ retailer: String(r.id), r_view: undefined })}
            selectedKey={state.retailer ? Number(state.retailer) : null}
            loading={retailers.isPending}
            refetching={retailers.isPlaceholderData || (retailers.isFetching && !retailers.isPending)}
            empty={
              <EmptyState
                title={activeFilters > 0 ? 'No retailers match these filters' : 'No retailers yet'}
                description={activeFilters > 0 ? undefined : 'Add a retailer to start collecting, importing or entering its prices.'}
              />
            }
          />
        )}
        {retailers.data ? (
          <Pagination page={retailers.data.page} pages={retailers.data.pages} total={retailers.data.total} pageSize={retailers.data.page_size} noun="retailers" onPage={(page) => set({ r_page: String(page) })} />
        ) : null}
      </Card>
      {!canManage ? (
        <p className="mt-2 text-[12px] text-ink-3">
          Only administrators can change source configuration and credentials.{' '}
          {canListings ? 'You can still add and edit listings: open a retailer and choose Listings.' : 'Your role can view sources and listings.'}
        </p>
      ) : null}

      <RetailerDrawer
        retailerId={state.retailer ? Number(state.retailer) : null}
        initialTab={state.r_view === 'listings' ? 'listings' : 'source'}
        onClose={() => set({ retailer: undefined, r_view: undefined })}
        onEdit={(r) => {
          setEditing(r);
          setDialogOpen(true);
        }}
      />
      <RetailerDialog retailer={editing} open={dialogOpen} onClose={() => setDialogOpen(false)} onSaved={(id) => !editing && set({ retailer: String(id), r_view: undefined })} />
      <ConfirmDialog open={deleting !== null} onClose={() => setDeleting(null)} onConfirm={() => void remove()} title="Delete this retailer?" confirmLabel="Delete retailer" danger loading={busy}>
        <p>
          <strong className="font-semibold text-ink">{deleting?.name}</strong> can only be deleted while it has no listings. If it has listings, nothing is deleted — deactivate
          the retailer instead, so its price history is preserved.
        </p>
      </ConfirmDialog>
    </div>
  );
}
