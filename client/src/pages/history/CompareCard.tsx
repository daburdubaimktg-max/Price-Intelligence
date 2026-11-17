/** Period comparison: average daily price of period A against period B, per group. */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { fmtDate, fmtNumber, fmtPct } from '@/lib/format.ts';
import { useApiQuery, useDates } from '@/lib/hooks.ts';
import { Button, Card, CardHeader, cn, EmptyState, ErrorState, Field, Input, LoadingBlock, Notice, Segmented } from '@/components/ui/primitives.tsx';
import { DataTable, type Column } from '@/components/ui/data-table.tsx';
import { ChangeCell, DemoBadge, FxNote, OwnershipDot } from '@/components/domain/domain.tsx';
import type { CompareRow, GroupBy, Metric, PeriodCompareResult, PeriodStats } from '@shared/api/analytics.ts';
import type { HistoryFilters } from './filters.ts';
import { Chip, GROUP_LABELS, InlineSelect, isRefetching, metricFormatter } from './parts.tsx';

type Preset = 'today_vs_yesterday' | 'last_7_days' | 'last_30_days' | 'last_90_days' | 'custom';
const PRESETS: Array<{ value: Preset; label: string; title: string }> = [
  { value: 'today_vs_yesterday', label: 'Today vs yesterday', title: 'Today compared with yesterday' },
  { value: 'last_7_days', label: '7 days', title: 'Last 7 days compared with the previous 7 days' },
  { value: 'last_30_days', label: '30 days', title: 'Last 30 days compared with the previous 30 days' },
  { value: 'last_90_days', label: '90 days', title: 'Last 90 days compared with the previous 90 days' },
  { value: 'custom', label: 'Custom', title: 'Choose both periods' },
];

function PeriodCell({ stats, format }: { stats: PeriodStats | null; format: (v: number) => string }) {
  if (!stats) return <span className="text-ink-4">No data</span>;
  return (
    <span className="inline-flex flex-col items-end">
      <span className="font-medium text-ink">{format(stats.avg)}</span>
      <span className="text-[11px] leading-4 text-ink-3">
        {format(stats.min)}–{format(stats.max)} · {stats.days} d
      </span>
    </span>
  );
}

export function CompareCard({ filters }: { filters: HistoryFilters }) {
  const { state, set } = filters;
  const dates = useDates();
  const preset = (PRESETS.some((p) => p.value === state.cmp) ? state.cmp : 'last_30_days') as Preset;
  const groupBy = (state.cmp_group ?? 'product') as GroupBy;
  const metric = (state.cmp_metric === 'unit_price' ? 'unit_price' : 'price') as Metric;

  // custom periods are edited locally and applied together
  const [draft, setDraft] = useState({ a_from: state.a_from ?? '', a_to: state.a_to ?? '', b_from: state.b_from ?? '', b_to: state.b_to ?? '' });
  useEffect(() => {
    setDraft({ a_from: state.a_from ?? '', a_to: state.a_to ?? '', b_from: state.b_from ?? '', b_to: state.b_to ?? '' });
  }, [state.a_from, state.a_to, state.b_from, state.b_to]);
  const customReady = !!state.a_from && !!state.a_to && !!state.b_from && !!state.b_to;
  const draftComplete = !!draft.a_from && !!draft.a_to && !!draft.b_from && !!draft.b_to;
  const draftInvalid = draftComplete && (draft.a_from > draft.a_to || draft.b_from > draft.b_to);

  const query = useApiQuery<PeriodCompareResult & { preset: string }>(
    ['history', 'compare'],
    '/history/compare',
    {
      ...filters.dimensionQuery,
      preset,
      group_by: groupBy,
      metric,
      currency: filters.currency,
      ...(preset === 'custom' ? { a_from: state.a_from, a_to: state.a_to, b_from: state.b_from, b_to: state.b_to } : {}),
    },
    { enabled: filters.ready && (preset !== 'custom' || customReady) },
  );
  const data = preset === 'custom' && !customReady ? undefined : query.data;

  const choosePreset = (next: Preset) => {
    if (next === 'custom' && !customReady) {
      // start the custom ranges from the standard 30-day comparison
      const base = dates.data?.presets.last_30_days;
      set({ cmp: next, a_from: base?.a.from, a_to: base?.a.to, b_from: base?.b.from, b_to: base?.b.to });
    } else {
      set({ cmp: next });
    }
  };

  const columns = useMemo<Array<Column<CompareRow>>>(() => {
    const fmt = (row: CompareRow) => metricFormatter(metric, row.currency);
    return [
      {
        key: 'group',
        header: GROUP_LABELS[groupBy].split(' (')[0],
        nowrap: false,
        cell: (row) => (
          <span className="flex max-w-[10.5rem] min-w-0 items-center gap-2 sm:max-w-[24rem]">
            {row.ownership === 'own' || row.ownership === 'competitor' ? <OwnershipDot ownership={row.ownership} /> : null}
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                {groupBy === 'product' && row.ref.product_id ? (
                  <Link to={`/catalogue/products/${row.ref.product_id}`} className="truncate font-medium text-ink hover:underline">
                    {row.label}
                  </Link>
                ) : (
                  <span className="truncate font-medium text-ink">{row.label}</span>
                )}
                {row.is_demo ? <DemoBadge /> : null}
              </span>
              <span className="block truncate text-[11.5px] leading-4 text-ink-3">{[row.sublabel, row.currency, row.basis].filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join(' · ')}</span>
            </span>
          </span>
        ),
      },
      { key: 'a', header: 'Period A', align: 'right', cell: (row) => <PeriodCell stats={row.a} format={fmt(row)} />, headerTitle: 'Average of the daily prices; lowest–highest and days observed below' },
      { key: 'b', header: 'Period B', align: 'right', cell: (row) => <PeriodCell stats={row.b} format={fmt(row)} /> },
      {
        key: 'delta',
        header: 'Difference',
        align: 'right',
        cell: (row) => (row.delta_abs === null ? <span className="text-ink-4">—</span> : `${row.delta_abs > 0 ? '+' : row.delta_abs < 0 ? '−' : ''}${fmt(row)(Math.abs(row.delta_abs))}`),
        hideBelow: 'sm',
      },
      { key: 'pct', header: 'Change', align: 'right', cell: (row) => <ChangeCell pct={row.delta_pct} /> },
      { key: 'promo_a', header: 'Promo A', align: 'right', cell: (row) => (row.a ? fmtPct(row.a.promo_share_pct, 0) : '—'), headerTitle: 'Share of observed listing-days on promotion in period A', hideBelow: 'md' },
      { key: 'promo_b', header: 'Promo B', align: 'right', cell: (row) => (row.b ? fmtPct(row.b.promo_share_pct, 0) : '—'), headerTitle: 'Share of observed listing-days on promotion in period B', hideBelow: 'md' },
    ];
  }, [groupBy, metric]);

  return (
    <Card className="mb-6">
      <CardHeader
        title="Period comparison"
        subtitle="Average daily prices of two periods, side by side. The comparison uses its own periods — the date range at the top of the page does not apply here; all other filters do."
      />
      <div className="flex flex-col gap-3 border-b border-line px-4 py-3">
        <div className="no-print flex flex-wrap items-center gap-x-3 gap-y-2">
          <Segmented label="Comparison periods" value={preset} onChange={choosePreset} options={PRESETS} />
          <InlineSelect
            label="Group by"
            value={groupBy}
            onChange={(v) => set({ cmp_group: v })}
            width="w-56"
            options={(Object.keys(GROUP_LABELS) as GroupBy[]).map((g) => ({ value: g, label: GROUP_LABELS[g] }))}
          />
          <InlineSelect
            label="Metric"
            value={metric}
            onChange={(v) => set({ cmp_metric: v })}
            width="w-36"
            options={[
              { value: 'price', label: 'Selling price' },
              { value: 'unit_price', label: 'Unit price' },
            ]}
          />
        </div>
        {preset === 'custom' ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draftComplete || draftInvalid) return;
              set({ ...draft });
            }}
          >
            <fieldset className="flex items-end gap-2">
              <legend className="eyebrow mb-1">Period A</legend>
              <Field label="From">
                <Input type="date" value={draft.a_from} max={draft.a_to || filters.today} onChange={(e) => setDraft((d) => ({ ...d, a_from: e.target.value }))} required />
              </Field>
              <Field label="To">
                <Input type="date" value={draft.a_to} min={draft.a_from} max={filters.today} onChange={(e) => setDraft((d) => ({ ...d, a_to: e.target.value }))} required />
              </Field>
            </fieldset>
            <fieldset className="flex items-end gap-2">
              <legend className="eyebrow mb-1">Period B</legend>
              <Field label="From">
                <Input type="date" value={draft.b_from} max={draft.b_to || filters.today} onChange={(e) => setDraft((d) => ({ ...d, b_from: e.target.value }))} required />
              </Field>
              <Field label="To">
                <Input type="date" value={draft.b_to} min={draft.b_from} max={filters.today} onChange={(e) => setDraft((d) => ({ ...d, b_to: e.target.value }))} required />
              </Field>
            </fieldset>
            <Button type="submit" variant="primary" disabled={!draftComplete || draftInvalid}>
              Compare
            </Button>
            {draftInvalid ? <span className="text-[12px] text-crit-ink">A period starts after it ends.</span> : null}
          </form>
        ) : null}
        {data ? (
          <div className={cn('flex flex-wrap items-center gap-2 transition-opacity', isRefetching(query) && 'opacity-60')}>
            <span className="text-[12.5px] text-ink-2">
              <span className="font-medium text-ink">A</span> {fmtDate(data.period_a.from)}
              {data.period_a.from !== data.period_a.to ? ` – ${fmtDate(data.period_a.to)}` : ''} <span className="text-ink-4">vs</span> <span className="font-medium text-ink">B</span> {fmtDate(data.period_b.from)}
              {data.period_b.from !== data.period_b.to ? ` – ${fmtDate(data.period_b.to)}` : ''}
            </span>
            <span className="flex-1" />
            <Chip value={fmtNumber(data.summary.increased)} label="increased" tone="up" />
            <Chip value={fmtNumber(data.summary.decreased)} label="decreased" tone="down" />
            <Chip value={fmtNumber(data.summary.unchanged)} label="unchanged" />
            <Chip value={fmtPct(data.summary.avg_change_pct, 1, true)} label="average change" />
            {data.summary.only_in_a + data.summary.only_in_b > 0 ? (
              <Chip value={fmtNumber(data.summary.only_in_a + data.summary.only_in_b)} label={`in one period only (${data.summary.only_in_a} A · ${data.summary.only_in_b} B)`} />
            ) : null}
          </div>
        ) : null}
      </div>

      {preset === 'custom' && !customReady ? (
        <EmptyState title="Choose both periods" description="Set the start and end of period A and period B, then select Compare." />
      ) : query.isError && !data ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <LoadingBlock className="min-h-40" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={data.rows}
            rowKey={(row) => row.key}
            dense
            maxHeight={440}
            refetching={isRefetching(query)}
            empty={<EmptyState title="Nothing to compare" description="No priced observations in either period for the current filters." />}
          />
          {data.rows.length > 0 ? (
            <div className="border-t border-line px-4 py-2.5 text-[12px] leading-5 text-ink-3">
              {fmtNumber(data.summary.comparable)} of {fmtNumber(data.summary.groups)} {data.summary.groups === 1 ? 'group has' : 'groups have'} data in both periods; rows are ordered by the size of
              the change.
              {data.currency_mode === 'native' ? ' Each row is in its own currency — rows are never added up across currencies.' : ''}
            </div>
          ) : null}
          {data.conversions.length || data.missing_rates.length ? (
            <div className="border-t border-line px-4 py-2.5">
              <FxNote conversions={data.conversions} missing={data.missing_rates} target={data.target_currency} />
            </div>
          ) : null}
          {data.demo.any_demo && !data.demo.all_demo ? (
            <div className="border-t border-line px-4 py-2.5">
              <Notice tone="demo">Some rows include demo data; they carry a DEMO marker.</Notice>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
