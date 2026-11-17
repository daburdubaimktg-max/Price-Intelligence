/**
 * Health tab, middle: runs per day (one chart per kind of run), freshness by kind of source, and the
 * observations in the ledger by data class.
 */
import { useMemo } from 'react';
import { Link } from 'react-router';
import { FlaskConical, Radio, UsersRound } from 'lucide-react';
import { DASH, fmtDateTime, fmtNumber, fmtPct, fmtRelative, plural } from '@/lib/format.ts';
import { Card, CardHeader, cn, ErrorState, LoadingBlock, Tip } from '@/components/ui/primitives.tsx';
import { ChartEmpty, ChartFrame, DEEMPHASIS, Legend } from '@/components/charts/kit.tsx';
import { SegmentedBar } from '@/components/charts/charts.tsx';
import { DataClassBadge, DemoBadge } from '@/components/domain/domain.tsx';
import { DATA_CLASSES, DATA_CLASS_LABELS } from '@shared/constants.ts';
import type { CollectionHealth, CollectionSource, JobDataClass } from '@shared/api/collection.ts';
import { CLASS_COLORS, DemoTag, FRESHNESS_COLORS, kindOf, OUTCOME_COLORS, type SourceKind } from './health-shared.tsx';
import { SIMULATED_RUN_NOTE } from './shared.tsx';
import { StackedColumns, type StackDatum, type StackSegment } from './StackedColumns.tsx';

// ---------------------------------------------------------------------------------------------
// Runs per day (one chart per kind — the two are never stacked together)
// ---------------------------------------------------------------------------------------------
export function RunsChart({ kind, health, days, refetching }: { kind: JobDataClass; health: CollectionHealth; days: number; refetching: boolean }) {
  const simulated = kind === 'simulated';
  const segments: StackSegment[] = [
    { key: 'succeeded', label: 'Succeeded', color: OUTCOME_COLORS.succeeded },
    { key: 'partial', label: 'Partial', color: OUTCOME_COLORS.partial },
    { key: 'failed', label: 'Failed', color: OUTCOME_COLORS.failed },
    ...(simulated ? [] : [{ key: 'not_configured', label: 'Not configured (no attempt)', color: OUTCOME_COLORS.not_configured }]),
  ];
  const data = health.daily.map((d): StackDatum => {
    const values: Record<string, number> = simulated
      ? { succeeded: d.simulated_succeeded, partial: d.simulated_partial, failed: d.simulated_failed }
      : { succeeded: d.real_succeeded, partial: d.real_partial, failed: d.real_failed, not_configured: d.real_not_configured };
    return { date: d.date, values };
  });
  const observations = health.daily.map((d) => (simulated ? d.simulated_observations : d.real_observations));
  const total = data.reduce((acc, d) => acc + Object.values(d.values).reduce((a, v) => a + v, 0), 0);
  return (
    <ChartFrame
      title={
        <span className="flex flex-wrap items-center gap-2">
          {simulated ? 'Simulated demo runs per day' : 'Real collection runs per day'}
          {simulated ? <DemoBadge /> : null}
        </span>
      }
      subtitle={simulated ? `${SIMULATED_RUN_NOTE} · by outcome, per UTC day` : 'Runs against real retailer systems · by outcome, per UTC day'}
      legend={<Legend items={segments.map((s) => ({ key: s.key, label: s.label, color: s.color, shape: 'rect' as const }))} />}
      table={{
        columns: ['Date', ...segments.map((s) => s.label), simulated ? 'DEMO observations' : 'Observations stored'],
        rows: data.map((d, i) => [d.date, ...segments.map((s) => d.values[s.key] ?? 0), observations[i] ?? 0]),
        numeric: segments.map((_, i) => i + 1).concat(segments.length + 1),
      }}
      refetching={refetching}
      empty={
        total === 0 ? (
          <ChartEmpty
            title={simulated ? `No simulated run in the last ${days} days` : `No real collection ran in the last ${days} days`}
            description={simulated ? 'Simulated sources have not run in this window.' : 'Runs appear here once a real source is configured and has run. Simulated demo runs are never shown in this chart.'}
          />
        ) : undefined
      }
    >
      <StackedColumns data={data} segments={segments} unit={simulated ? 'Simulated runs' : 'Real runs'} />
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// Freshness by kind of source
// ---------------------------------------------------------------------------------------------
const KIND_META: Record<SourceKind, { label: string; hint: string; icon: typeof Radio }> = {
  real: { label: 'Automated real sources', hint: 'Official APIs, product feeds, permitted website extraction and data providers', icon: Radio },
  people: { label: 'Manual entry and imports', hint: 'Kept up to date by your team', icon: UsersRound },
  simulated: { label: 'Simulated demo sources', hint: 'Illustrative DEMO data', icon: FlaskConical },
};

export function FreshnessCard({ sources, loading, error, onRetry }: { sources: CollectionSource[] | undefined; loading: boolean; error: unknown; onRetry: () => void }) {
  const rows = useMemo(() => {
    const acc: Record<SourceKind, { sources: number; active: number; stale: number; never: number }> = {
      real: { sources: 0, active: 0, stale: 0, never: 0 },
      people: { sources: 0, active: 0, stale: 0, never: 0 },
      simulated: { sources: 0, active: 0, stale: 0, never: 0 },
    };
    for (const s of sources ?? []) {
      const k = acc[kindOf(s)];
      k.sources += 1;
      k.active += s.listings_active;
      k.stale += s.listings_stale;
      k.never += s.listings_never_observed;
    }
    // the demo row only appears while simulated sources exist
    return (['real', 'people', 'simulated'] as SourceKind[]).filter((kind) => kind !== 'simulated' || acc.simulated.sources > 0).map((kind) => ({ kind, ...acc[kind] }));
  }, [sources]);
  return (
    <Card className="flex flex-col">
      <CardHeader title="Data freshness" subtitle="Active listings by how recent their latest observation is, for each kind of source. Stale means older than the source's schedule allows." />
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : loading && !sources ? (
        <LoadingBlock />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const meta = KIND_META[r.kind];
            const fresh = Math.max(0, r.active - r.stale);
            const overdue = Math.max(0, r.stale - r.never);
            return (
              <li key={r.kind} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                    <meta.icon className="size-3.5 text-ink-3" aria-hidden />
                    {meta.label}
                    {r.kind === 'simulated' ? <DemoTag /> : null}
                  </span>
                  <span className="num text-[12px] text-ink-3">
                    {plural(r.sources, 'source')} · {plural(r.active, 'active listing')}
                  </span>
                </div>
                {r.active === 0 ? (
                  <p className="mt-1.5 text-[12.5px] text-ink-3">{r.sources === 0 ? 'No source of this kind.' : 'No active listings yet.'}</p>
                ) : (
                  <>
                    <SegmentedBar
                      className="mt-2"
                      parts={[
                        { key: 'fresh', label: 'Fresh', value: fresh, color: FRESHNESS_COLORS.fresh },
                        { key: 'stale', label: 'Stale', value: overdue, color: FRESHNESS_COLORS.stale },
                        { key: 'never', label: 'Never observed', value: r.never, color: FRESHNESS_COLORS.never },
                      ]}
                    />
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-4 text-ink-2">
                      {[
                        { label: 'Fresh', value: fresh, color: FRESHNESS_COLORS.fresh },
                        { label: 'Stale', value: overdue, color: FRESHNESS_COLORS.stale },
                        { label: 'Never observed', value: r.never, color: FRESHNESS_COLORS.never },
                      ].map((p) => (
                        <li key={p.label} className="flex items-center gap-1.5">
                          <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: p.value > 0 ? p.color : DEEMPHASIS }} />
                          {p.label} <span className="num font-semibold text-ink">{fmtNumber(p.value)}</span>
                          <span className="num text-ink-3">{fmtPct((p.value / r.active) * 100, 0)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-auto border-t border-line px-4 py-2.5 text-[12px] leading-5 text-ink-3">
        <Link className="link" to="/monitor?stale=true">
          Stale listings
        </Link>{' '}
        and{' '}
        <Link className="link" to="/monitor?never_observed=true">
          never-observed listings
        </Link>{' '}
        open in the Live Price Monitor.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Where the observations come from
// ---------------------------------------------------------------------------------------------
export function ProvenanceCard({ health }: { health: CollectionHealth }) {
  const byClass = new Map(health.provenance.map((p) => [p.data_class, p]));
  const total = health.provenance.reduce((acc, p) => acc + p.observations, 0);
  return (
    <Card className="flex flex-col">
      <CardHeader title="Observations by data class" subtitle="How every price in the ledger got there. The four classes are stored separately and never relabelled." />
      <div className="px-4 pt-3">
        <SegmentedBar parts={DATA_CLASSES.map((c) => ({ key: c, label: DATA_CLASS_LABELS[c], value: byClass.get(c)?.observations ?? 0, color: CLASS_COLORS[c] }))} />
      </div>
      <ul className="divide-y divide-line px-4">
        {DATA_CLASSES.map((c) => {
          const row = byClass.get(c);
          const count = row?.observations ?? 0;
          return (
            <li key={c} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2.5">
              <span className="flex w-44 shrink-0 items-center gap-2">
                <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: count > 0 ? CLASS_COLORS[c] : DEEMPHASIS }} />
                <DataClassBadge value={c} />
              </span>
              <span className="min-w-[7rem] flex-1">
                <span className={cn('num text-[15px] leading-6 font-semibold', count === 0 ? 'text-ink-4' : 'text-ink')}>{fmtNumber(count)}</span>
                <span className="num ml-1.5 text-[12px] text-ink-3">{total > 0 ? fmtPct((count / total) * 100, 1) : '0%'}</span>
                <span className="block text-[11.5px] leading-4 text-ink-3">
                  {count === 0 ? (
                    c === 'collected' ? (
                      'No real collection has stored an observation yet'
                    ) : (
                      'None in the ledger'
                    )
                  ) : (
                    <>
                      {plural(row?.listings ?? 0, 'listing')}
                      {row?.demo_observations ? (row.demo_observations === count ? ' · all DEMO' : ` · ${fmtNumber(row.demo_observations)} DEMO`) : ''}
                      {row?.voided ? ` · ${fmtNumber(row.voided)} voided (kept, excluded)` : ''}
                    </>
                  )}
                </span>
              </span>
              <span className="text-right text-[11.5px] leading-4 text-ink-3">
                {row?.last_observed_at ? (
                  <Tip content={`First ${fmtDateTime(row.first_observed_at, 'UTC')} UTC · latest ${fmtDateTime(row.last_observed_at, 'UTC')} UTC`}>
                    <span>latest {fmtRelative(row.last_observed_at)}</span>
                  </Tip>
                ) : (
                  DASH
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-auto border-t border-line px-4 py-2.5 text-[12px] leading-5 text-ink-3">
        <span className="num font-medium text-ink-2">{fmtNumber(total)}</span> observations in the ledger (voided ones excluded). Filter any history view by data class to see one class on its own.
      </p>
    </Card>
  );
}
