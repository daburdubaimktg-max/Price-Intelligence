/** Alert feed: summary, one filter row, sortable table with bulk actions, and the detail drawer. */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BellOff, BellRing, Check, CircleAlert, CircleCheck, FlaskConical, RefreshCw, RotateCcw } from 'lucide-react';
import { apiPost, type Paged } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtNumber } from '@/lib/format.ts';
import { fromList, toList, useApiQuery, useDates, useReference, useUrlState } from '@/lib/hooks.ts';
import { useToast } from '@/components/ui/overlays.tsx';
import { Button, Card, CardHeader, EmptyState, ErrorState, Notice, Segmented, StatTile } from '@/components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { DateRangePicker, FilterBar, MultiSelect, SearchInput } from '@/components/ui/filters.tsx';
import { BarList, Sparkline, TimeSeriesChart } from '@/components/charts/charts.tsx';
import { ChartEmpty, ChartFrame } from '@/components/charts/kit.tsx';
import { DemoBadge, MarketTime } from '@/components/domain/domain.tsx';
import { ALERT_TYPES, ALERT_TYPE_INFO, SEVERITIES } from '@shared/constants.ts';
import type { AlertBulkResult, AlertRow, AlertStatus, AlertSummary, StateCheckResult } from '@shared/api/alerts.ts';
import { AlertDrawer } from './AlertDrawer.tsx';
import { AlertStatusBadge, alertTypeLabel, errorText, SEVERITY_META, SeverityBadge, STATUS_LABELS } from './shared.tsx';

type AlertsUrl = {
  status: string | undefined;
  severity: string | undefined;
  type: string | undefined;
  market_id: string | undefined;
  retailer_id: string | undefined;
  brand_id: string | undefined;
  from: string | undefined;
  to: string | undefined;
  q: string | undefined;
  sort: string | undefined;
  page: string | undefined;
  alert: string | undefined;
};

const DEFAULTS: AlertsUrl = {
  status: 'open',
  severity: undefined,
  type: undefined,
  market_id: undefined,
  retailer_id: undefined,
  brand_id: undefined,
  from: undefined,
  to: undefined,
  q: undefined,
  sort: '-triggered_at',
  page: '1',
  alert: undefined,
};
const FILTER_KEYS = ['status', 'severity', 'type', 'market_id', 'retailer_id', 'brand_id', 'from', 'to', 'q'] as const;
const PAGE_SIZE = 50;

export function AlertsTab() {
  const canManage = useCan('alerts.manage');
  const toast = useToast();
  const client = useQueryClient();
  const { state, set } = useUrlState<AlertsUrl>(DEFAULTS);
  const { ref } = useReference();
  const dates = useDates();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<StateCheckResult | null>(null);

  const status = state.status ?? 'open';
  const query = {
    status: status === 'all' ? undefined : status,
    severity: state.severity,
    type: state.type,
    market_id: state.market_id,
    retailer_id: state.retailer_id,
    brand_id: state.brand_id,
    from: state.from,
    to: state.to,
    q: state.q,
    sort: state.sort,
    page: state.page,
    page_size: PAGE_SIZE,
  };
  const alerts = useApiQuery<Paged<AlertRow>>(['alerts', 'list'], '/alerts', query);
  const summary = useApiQuery<AlertSummary>(['alerts', 'summary'], '/alerts/summary', { days: 14 });

  const rows = alerts.data?.rows;
  const visibleIds = useMemo(() => new Set((rows ?? []).map((r) => r.id)), [rows]);
  // A selection only ever refers to rows that are on screen.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleIds]);

  const activeFilters = FILTER_KEYS.filter((key) => state[key] !== undefined && state[key] !== DEFAULTS[key]).length;
  const patch = (changes: Partial<AlertsUrl>) => set({ ...changes, page: undefined });
  const resetFilters = () => set({ status: undefined, severity: undefined, type: undefined, market_id: undefined, retailer_id: undefined, brand_id: undefined, from: undefined, to: undefined, q: undefined, page: undefined });

  const refreshAll = () =>
    Promise.all([client.invalidateQueries({ queryKey: ['alerts'] }), client.invalidateQueries({ queryKey: ['alert-rules'] })]);

  async function bulk(action: 'acknowledge' | 'resolve' | 'reopen') {
    if (selected.size === 0) return;
    setBusy(action);
    try {
      const result = await apiPost<AlertBulkResult>('/alerts/bulk', { ids: [...selected], action });
      const verb = action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : 'reopened';
      toast.success(
        `${fmtNumber(result.updated)} alert${result.updated === 1 ? '' : 's'} ${verb}`,
        result.skipped ? `${fmtNumber(result.skipped)} skipped because they were already in that state or cannot make that move.` : undefined,
      );
      setSelected(new Set());
      await refreshAll();
    } catch (err) {
      toast.error('The alerts were not updated', errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function runChecks() {
    setBusy('evaluate');
    try {
      const result = await apiPost<StateCheckResult>('/alerts/evaluate');
      setCheckResult(result);
      await refreshAll();
    } catch (err) {
      toast.error('The checks could not be run', errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const marketIds = toList(state.market_id);
  const retailerOptions = (ref?.retailers ?? [])
    .filter((r) => marketIds.length === 0 || marketIds.includes(String(r.market_id)))
    .map((r) => ({ value: String(r.id), label: r.name, sublabel: ref?.markets.find((m) => m.id === r.market_id)?.name, tag: r.is_demo ? <DemoBadge /> : undefined }));

  const allSelected = !!rows?.length && rows.every((r) => selected.has(r.id));
  const columns: Array<Column<AlertRow>> = [
    ...(canManage
      ? [
          {
            key: 'select',
            width: '36px',
            header: (
              <input
                type="checkbox"
                aria-label="Select all alerts on this page"
                className="size-3.5 accent-[var(--color-navy)]"
                checked={allSelected}
                onChange={(e) => setSelected(e.target.checked ? new Set((rows ?? []).map((r) => r.id)) : new Set())}
              />
            ),
            cell: (row: AlertRow) => (
              <input
                type="checkbox"
                aria-label={`Select alert ${row.id}`}
                className="size-3.5 accent-[var(--color-navy)]"
                checked={selected.has(row.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(row.id);
                    else next.delete(row.id);
                    return next;
                  })
                }
              />
            ),
          } satisfies Column<AlertRow>,
        ]
      : []),
    { key: 'severity', header: 'Severity', sortKey: 'severity', width: '104px', cell: (row) => <SeverityBadge severity={row.severity} /> },
    {
      key: 'alert',
      header: 'Alert',
      cell: (row) => (
        <div className="min-w-[11.5rem] sm:min-w-[13rem]">
          <div className="flex items-start gap-1.5">
            <span className="line-clamp-2 font-medium text-ink">{row.title}</span>
            {row.is_demo ? <DemoBadge className="mt-px" /> : null}
          </div>
          <p className="mt-0.5 line-clamp-1 text-[12px] leading-4 text-ink-3">{row.message}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-3 md:hidden">
            <MarketTime iso={row.triggered_at} timeZone={row.timezone} short />
            <AlertStatusBadge status={row.status} />
          </p>
        </div>
      ),
    },
    {
      key: 'where',
      header: 'Where',
      hideBelow: 'lg',
      cell: (row) => (
        <div className="min-w-[9rem] text-[12.5px]">
          <div className="text-ink-2">{row.retailer_name ?? '—'}</div>
          <div className="text-[11.5px] text-ink-3">{[row.market_name, row.brand_name].filter(Boolean).join(' · ')}</div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type · rule',
      sortKey: 'type',
      hideBelow: 'xl',
      cell: (row) => (
        <div className="max-w-[15rem] text-[12.5px]">
          <div className="truncate text-ink-2">{alertTypeLabel(row.type)}</div>
          <div className="truncate text-[11.5px] text-ink-3" title={row.rule_name ?? undefined}>
            {row.rule_name ?? 'Rule deleted'}
          </div>
        </div>
      ),
    },
    { key: 'triggered', header: 'Triggered', sortKey: 'triggered_at', hideBelow: 'md', nowrap: true, cell: (row) => <MarketTime iso={row.triggered_at} timeZone={row.timezone} short /> },
    { key: 'status', header: 'Status', sortKey: 'status', hideBelow: 'md', cell: (row) => <AlertStatusBadge status={row.status} /> },
  ];

  const s = summary.data;
  const trend = s?.trend ?? [];
  const typeBars = (s?.by_type ?? [])
    .filter((t) => t.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((t) => ({
      key: t.type,
      label: t.label,
      value: t.total,
      display: `${fmtNumber(t.total)} · ${fmtNumber(t.active)} active`,
      onClick: () => patch({ type: t.type, status: 'all' }),
    }));
  const selectedRows = (rows ?? []).filter((r) => selected.has(r.id));
  const canAck = selectedRows.some((r) => r.status === 'open');
  const canResolve = selectedRows.some((r) => r.status !== 'resolved');
  const canReopen = selectedRows.some((r) => r.status !== 'open');

  return (
    <div>
      {summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Open" value={fmtNumber(s?.open)} icon={BellRing} detail="Waiting for someone to look" onClick={() => patch({ status: 'open' })} />
          <StatTile
            label="Critical, active"
            value={fmtNumber(s?.active_by_severity?.critical)}
            icon={CircleAlert}
            tone={(s?.active_by_severity?.critical ?? 0) > 0 ? 'crit' : 'default'}
            detail={`${fmtNumber(s?.active_by_severity?.warning)} warning · ${fmtNumber(s?.active_by_severity?.info)} info`}
            onClick={() => patch({ severity: 'critical', status: 'all' })}
          />
          <StatTile label="Acknowledged" value={fmtNumber(s?.acknowledged)} icon={BellOff} detail="Seen, condition still present" onClick={() => patch({ status: 'acknowledged' })} />
          <StatTile label="Resolved" value={fmtNumber(s?.resolved)} icon={CircleCheck} detail="Closed" onClick={() => patch({ status: 'resolved' })} />
          <StatTile
            className="col-span-2 lg:col-span-1"
            label={`Raised in the last ${s?.days ?? 14} days`}
            value={fmtNumber(s?.triggered_in_period)}
            footer={<Sparkline values={trend.map((t) => t.total)} width={120} height={22} label="Alerts raised per day" />}
          />
        </div>
      )}

      {s && s.demo_active > 0 ? (
        <Notice tone="demo" icon={FlaskConical} className="mt-3">
          <strong className="font-semibold text-ink">{fmtNumber(s.demo_active)}</strong> of the {fmtNumber(s.open + s.acknowledged)} active alerts were raised from the
          illustrative demo dataset and carry a DEMO marker.
        </Notice>
      ) : null}

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ChartFrame
          title="Alerts raised per day"
          subtitle={`Last ${s?.days ?? 14} days, by the day (UTC) the alert was triggered`}
          refetching={summary.isFetching && !summary.isPending}
          table={{
            columns: ['Date', 'Total', 'Critical', 'Warning', 'Info'],
            numeric: [1, 2, 3, 4],
            rows: [...trend].reverse().map((t) => [t.date, t.total, t.critical, t.warning, t.info]),
          }}
          empty={trend.every((t) => t.total === 0) ? <ChartEmpty title="No alerts were raised in this period" description="Rules are evaluated every time new observations arrive." /> : undefined}
        >
          <TimeSeriesChart
            series={[{ key: 'total', label: 'Alerts raised', points: trend.map((t) => ({ date: t.date, value: t.total })) }]}
            colorScope="alerts-trend"
            height={170}
            includeZero
            formatValue={(v) => fmtNumber(v)}
            valueLabel="Alerts raised"
          />
        </ChartFrame>
        <Card className="flex flex-col">
          <div className="px-4 pt-3">
            <div className="text-[13.5px] leading-5 font-semibold text-ink">By alert type</div>
            <div className="mt-0.5 text-[12px] leading-4 text-ink-3">Raised in the period · still active. Select a type to filter the list.</div>
          </div>
          <div className="flex-1 px-4 py-3">
            <BarList data={typeBars} emptyText="No alerts were raised in this period." />
          </div>
        </Card>
      </div>

      <FilterBar className="mt-5" activeCount={activeFilters} onReset={resetFilters}>
        <Segmented
          label="Status"
          value={status}
          onChange={(next) => patch({ status: next })}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'acknowledged', label: 'Acknowledged' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'all', label: 'All' },
          ]}
        />
        <DateRangePicker
          label="Triggered"
          value={{ from: state.from, to: state.to }}
          today={dates.data?.today ?? new Date().toISOString().slice(0, 10)}
          presets={['today', '7d', '30d', '90d', 'all']}
          onChange={(range) => patch({ from: range.from, to: range.to })}
        />
        <MultiSelect
          label="Severity"
          options={SEVERITIES.map((sev) => ({ value: sev, label: SEVERITY_META[sev].label }))}
          value={toList(state.severity)}
          onChange={(next) => patch({ severity: fromList(next) })}
        />
        <MultiSelect
          label="Type"
          options={ALERT_TYPES.map((t) => ({ value: t, label: ALERT_TYPE_INFO[t].label }))}
          value={toList(state.type)}
          onChange={(next) => patch({ type: fromList(next) })}
        />
        <MultiSelect
          label="Market"
          options={(ref?.markets ?? []).map((m) => ({ value: String(m.id), label: m.name, sublabel: m.currency_code }))}
          value={marketIds}
          onChange={(next) => patch({ market_id: fromList(next) })}
        />
        <MultiSelect label="Retailer" options={retailerOptions} value={toList(state.retailer_id)} onChange={(next) => patch({ retailer_id: fromList(next) })} />
        <MultiSelect
          label="Brand"
          options={(ref?.brands ?? []).map((b) => ({ value: String(b.id), label: b.name, group: b.ownership === 'own' ? 'Own brands' : 'Competitors' }))}
          value={toList(state.brand_id)}
          onChange={(next) => patch({ brand_id: fromList(next) })}
        />
        <SearchInput value={state.q ?? ''} onChange={(next) => patch({ q: next || undefined })} placeholder="Search title or message…" />
      </FilterBar>

      {checkResult ? (
        <Notice
          tone="info"
          className="mb-3"
          title="Checks completed"
          action={
            <button type="button" className="link text-[12.5px]" onClick={() => setCheckResult(null)}>
              Dismiss
            </button>
          }
        >
          No fresh observation: {fmtNumber(checkResult.stale_observation.opened)} opened, {fmtNumber(checkResult.stale_observation.updated)} updated,{' '}
          {fmtNumber(checkResult.stale_observation.resolved)} resolved. Collection failing: {fmtNumber(checkResult.collection_failed.opened)} opened,{' '}
          {fmtNumber(checkResult.collection_failed.updated)} updated, {fmtNumber(checkResult.collection_failed.resolved)} resolved.
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title={status === 'all' ? 'All alerts' : `${STATUS_LABELS[status as AlertStatus] ?? 'Open'} alerts`}
          subtitle="Select a row for the evidence, the notification attempts and the actions."
          actions={
            canManage ? (
              <Button icon={RefreshCw} onClick={() => void runChecks()} loading={busy === 'evaluate'} title="Runs the stale-observation and failing-source checks immediately">
                Run checks now
              </Button>
            ) : undefined
          }
        />
        {canManage && selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken px-4 py-2.5 text-[13px]" role="region" aria-label="Bulk actions">
            <span className="num mr-1 font-medium text-ink">{fmtNumber(selected.size)} selected</span>
            <Button size="sm" icon={BellOff} onClick={() => void bulk('acknowledge')} loading={busy === 'acknowledge'} disabled={!canAck || busy !== null}>
              Acknowledge
            </Button>
            <Button size="sm" icon={Check} onClick={() => void bulk('resolve')} loading={busy === 'resolve'} disabled={!canResolve || busy !== null}>
              Resolve
            </Button>
            <Button size="sm" icon={RotateCcw} onClick={() => void bulk('reopen')} loading={busy === 'reopen'} disabled={!canReopen || busy !== null}>
              Reopen
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        ) : null}
        {alerts.isError ? (
          <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            sort={state.sort}
            onSort={(sort) => set({ sort, page: undefined })}
            onRowClick={(row) => set({ alert: String(row.id) })}
            selectedKey={state.alert ? Number(state.alert) : null}
            loading={alerts.isPending}
            refetching={alerts.isPlaceholderData || (alerts.isFetching && !alerts.isPending)}
            empty={
              <EmptyState
                icon={CircleCheck}
                title={activeFilters > 0 || status !== 'open' ? 'No alerts match these filters' : 'No open alerts'}
                description={
                  activeFilters > 0
                    ? 'Try a wider date range or fewer filters.'
                    : 'Rules are evaluated as new observations arrive. The stale-data and failing-source checks run periodically while the server’s scheduler is on, or when someone presses “Run checks now”.'
                }
                action={
                  activeFilters > 0 ? (
                    <Button size="sm" onClick={resetFilters}>
                      Reset filters
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
        {alerts.data ? (
          <Pagination page={alerts.data.page} pages={alerts.data.pages} total={alerts.data.total} pageSize={alerts.data.page_size} noun="alerts" onPage={(page) => set({ page: String(page) })} />
        ) : null}
      </Card>
      <p className="mt-2 text-[12px] leading-5 text-ink-3">
        Acknowledge an alert to show it has been seen. Resolving closes it; a stale-data or failing-source alert re-opens at the next check if its condition still holds, so use
        Acknowledge to keep those quiet.
      </p>

      <AlertDrawer alertId={state.alert ? Number(state.alert) : null} onClose={() => set({ alert: undefined })} />
    </div>
  );
}
