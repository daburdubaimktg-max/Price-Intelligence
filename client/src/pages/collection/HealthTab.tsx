/**
 * Health: is anything really being collected?
 * Real collection and simulated demo runs are reported side by side and are never added together;
 * a rate is "n/a" when no attempt was made, never a default 100 %.
 */
import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { CircleAlert, ClockAlert, FlaskConical, PackageSearch, Radio, RefreshCw, Timer, TimerOff, TriangleAlert, UsersRound } from 'lucide-react';
import { DASH, fmtDateTime, fmtNumber, fmtPct, fmtRelative, plural } from '@/lib/format.ts';
import { addDays, useApiQuery } from '@/lib/hooks.ts';
import { Badge, Button, Card, CardHeader, cn, EmptyState, ErrorState, LoadingBlock, Notice, Segmented, StatTile, Tip } from '@/components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '@/components/ui/data-table.tsx';
import { FilterBar } from '@/components/ui/filters.tsx';
import { ChartEmpty, ChartFrame, DEEMPHASIS, Legend, SERIES_COLORS } from '@/components/charts/kit.tsx';
import { SegmentedBar } from '@/components/charts/charts.tsx';
import { DataClassBadge, DemoBadge, FrequencyLabel, MarketTime, MethodLabel } from '@/components/domain/domain.tsx';
import { DATA_CLASSES, DATA_CLASS_LABELS, FREQUENCIES, FREQUENCY_LABELS, type DataClass, type Frequency } from '@shared/constants.ts';
import type { CollectionHealth, CollectionSource, JobDataClass, SourceStatus } from '@shared/api/collection.ts';
import { StackedColumns, type StackSegment } from './StackedColumns.tsx';
import { Fact, fmtRate, JobStatusBadge, SIMULATED_RUN_NOTE, SOURCE_STATUSES, SOURCE_STATUS_META, SourceStatusBadge, ViewerTime } from './shared.tsx';
import { cleared, JOB_FILTER_KEYS, LOG_FILTER_KEYS, SOURCE_FILTER_KEYS, useCollectionUrl, type CollectionPatch } from './url.ts';

/** Outcomes and freshness are states, so they use the status colours — always beside their labels and figures. */
const OUTCOME_COLORS = { succeeded: '#0ca30c', partial: '#fab219', failed: '#d03b3b', not_configured: DEEMPHASIS, cancelled: '#6b7489' } as const;
const FRESHNESS_COLORS = { fresh: '#0ca30c', stale: '#fab219', never: '#ec835a' } as const;
/** Same assignment as the overview's ledger strip: colour follows the data class everywhere. */
const CLASS_COLORS: Record<DataClass, string> = { collected: SERIES_COLORS[5], imported: SERIES_COLORS[6], manual: SERIES_COLORS[4], simulated: SERIES_COLORS[3] };

const WINDOWS = ['7', '14', '30'] as const;
const PAGE_SIZE = 25;
const ATTENTION_ORDER: SourceStatus[] = ['failing', 'not_configured', 'pending', 'healthy', 'paused', 'manual', 'simulated'];

type SourcesResponse = { rows: CollectionSource[]; total: number };
type SourceKind = 'real' | 'people' | 'simulated';
const kindOf = (s: CollectionSource): SourceKind => (s.method === 'simulated' ? 'simulated' : s.runnable ? 'real' : 'people');

function DemoTag() {
  return <span className="hatch rounded-[3px] border border-dashed border-warn/60 px-1 text-[10px] leading-[14px] font-semibold tracking-wide text-warn-ink">DEMO</span>;
}

// ---------------------------------------------------------------------------------------------
// Real collection | simulated demo runs
// ---------------------------------------------------------------------------------------------
function RunsPanel({
  kind, health, days, realSourceCount, onOpenSources,
}: {
  kind: JobDataClass;
  health: CollectionHealth;
  days: number;
  /** Sources with a real, automated collection method (from the source list; health alone cannot tell a paused real source from a paused demo one). */
  realSourceCount: number | undefined;
  onOpenSources: (statuses: SourceStatus[]) => void;
}) {
  const simulated = kind === 'simulated';
  const stats = health.window[kind];
  const latest = health.latest_runs[kind];
  const last = simulated ? health.last_simulated_run_at : health.last_real_success_at;
  const recorded = stats.attempts + stats.not_configured + stats.cancelled;
  const outcomes = [
    { key: 'succeeded', label: 'Succeeded', value: stats.succeeded, color: OUTCOME_COLORS.succeeded, always: true },
    { key: 'partial', label: 'Partial', value: stats.partial, color: OUTCOME_COLORS.partial, always: true },
    { key: 'failed', label: 'Failed', value: stats.failed, color: OUTCOME_COLORS.failed, always: true },
    { key: 'not_configured', label: 'Not configured (no attempt)', value: stats.not_configured, color: OUTCOME_COLORS.not_configured, always: !simulated },
    { key: 'cancelled', label: 'Cancelled', value: stats.cancelled, color: OUTCOME_COLORS.cancelled, always: false },
  ].filter((o) => o.always || o.value > 0);
  const real = health.sources;
  const realSources = realSourceCount ?? real.active + real.not_configured;
  const waiting: SourceStatus[] = (['failing', 'not_configured', 'pending'] as SourceStatus[]).filter((s) => real[s] > 0);

  return (
    <section className={cn('sheet flex min-w-0 flex-col', simulated && 'hatch border-dashed !border-warn/70')} aria-label={simulated ? 'Simulated demo runs' : 'Real collection'}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <span className="eyebrow flex items-center gap-1.5">
          {simulated ? <FlaskConical className="size-3.5" aria-hidden /> : <Radio className="size-3.5" aria-hidden />}
          {simulated ? 'Simulated demo runs' : 'Real collection'}
        </span>
        {simulated ? <DemoBadge /> : null}
      </div>

      <div className="px-4 pt-2 pb-3">
        {last ? (
          <>
            <p className="text-[12px] leading-4 text-ink-3">{simulated ? 'Last simulated run' : 'Last successful real collection'}</p>
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
              <span className="text-[22px] leading-8 font-semibold tracking-[-0.01em] text-ink">{fmtRelative(last)}</span>
              <ViewerTime iso={last} long className="text-[12.5px] !text-ink-3" />
            </p>
            {simulated ? (
              <p className="mt-1 max-w-xl text-[12.5px] leading-5 text-ink-2">
                {SIMULATED_RUN_NOTE}. The demo generator contacts no retailer; its figures are kept apart from real collection everywhere on this screen.
              </p>
            ) : null}
          </>
        ) : simulated ? (
          <p className="text-[13px] leading-5 text-ink-2">No simulated run has finished yet.</p>
        ) : (
          <>
            <p className="flex items-center gap-2 text-[18px] leading-7 font-semibold tracking-[-0.01em] text-ink">
              <CircleAlert className="size-4 shrink-0 text-warn-ink" aria-hidden />
              No real collection has run yet
            </p>
            <p className="mt-1 max-w-xl text-[12.5px] leading-5 text-ink-2">
              {realSources === 0 ? (
                <>
                  No retailer is set up with a real collection method. Every price in the ledger so far was imported, typed in or generated by the simulated demo.{' '}
                  <Link className="link" to="/admin?tab=retailers">
                    Add a real source in Administration
                  </Link>
                  .
                </>
              ) : (
                <>
                  {plural(realSources, 'real source')} {realSources === 1 ? 'exists' : 'exist'}, but none has completed a successful run
                  {waiting.length ? ` (${waiting.map((s) => `${real[s]} ${SOURCE_STATUS_META[s].label.toLowerCase()}`).join(', ')})` : ''}.{' '}
                  <button type="button" className="link" onClick={() => onOpenSources(waiting.length ? waiting : ['paused'])}>
                    See what they need
                  </button>
                  .
                </>
              )}
            </p>
          </>
        )}
      </div>

      <div className={cn('border-t px-4 py-3', simulated ? 'border-warn/40' : 'border-line')}>
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-[12px] leading-4 text-ink-3">
          <span>Runs in the last {days} days, by outcome</span>
          <span className="num">{recorded === 0 ? 'none recorded' : `${fmtNumber(recorded)} recorded`}</span>
        </div>
        <SegmentedBar parts={outcomes.map((o) => ({ key: o.key, label: o.label, value: o.value, color: o.color }))} />
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-4 text-ink-2">
          {outcomes.map((o) => (
            <li key={o.key} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: o.color }} />
              {o.label} <span className="num font-semibold text-ink">{fmtNumber(o.value)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={cn('grid grid-cols-2 gap-x-4 gap-y-3 border-t px-4 py-3 sm:grid-cols-5', simulated ? 'border-warn/40' : 'border-line')}>
        <Fact label="Runs attempted" value={fmtNumber(stats.attempts)} />
        <Fact
          label="Fully successful"
          value={fmtRate(stats.success_rate)}
          hint={stats.success_rate === null ? 'no attempt was made' : `${fmtNumber(stats.succeeded)} of ${fmtNumber(stats.attempts)}`}
        />
        <Fact label={simulated ? 'DEMO observations' : 'Observations stored'} value={fmtNumber(stats.observations_created)} />
        <Fact label="Listings not returned" value={fmtNumber(stats.listings_missing)} />
        <Fact label="Extraction failures" value={fmtNumber(stats.listings_failed)} />
      </div>

      <p className={cn('mt-auto border-t px-4 py-2.5 text-[12px] leading-5 text-ink-3', simulated ? 'border-warn/40' : 'border-line')}>
        {latest.sources === 0 ? (
          simulated ? (
            'No simulated source has a finished run.'
          ) : (
            'No real source has a finished run, so no product has been captured by real collection.'
          )
        ) : (
          <>
            Latest run of each source ({plural(latest.sources, 'source')}):{' '}
            <span className="num font-medium text-ink-2">
              {plural(latest.listings_captured, 'listing')} captured ({plural(latest.products_captured, 'product')})
            </span>{' '}
            · <span className="num">{fmtNumber(latest.listings_missing)}</span> not returned · <span className="num">{fmtNumber(latest.listings_failed)}</span> failed
          </>
        )}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Sources by status
// ---------------------------------------------------------------------------------------------
function SourceLedger({ health, sources, onOpenSources }: { health: CollectionHealth; sources: CollectionSource[] | undefined; onOpenSources: (statuses: SourceStatus[]) => void }) {
  const byFrequency = useMemo(() => {
    const counts = new Map<Frequency, number>();
    for (const s of sources ?? []) counts.set(s.frequency, (counts.get(s.frequency) ?? 0) + 1);
    return FREQUENCIES.filter((f) => counts.has(f)).map((f) => ({ frequency: f, count: counts.get(f)! }));
  }, [sources]);
  return (
    <Card>
      <CardHeader
        title="Sources by status"
        subtitle={
          <>
            <span className="num">{plural(health.sources.total, 'source')}</span> in total ·{' '}
            <span className="num">{fmtNumber(health.sources.active)}</span> automated real {health.sources.active === 1 ? 'source is' : 'sources are'} enabled and fully configured
          </>
        }
        actions={
          <Button size="sm" onClick={() => onOpenSources([])}>
            All sources
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4 lg:grid-cols-7">
        {SOURCE_STATUSES.map((status) => {
          const meta = SOURCE_STATUS_META[status];
          const count = health.sources[status];
          return (
            <Tip key={status} content={meta.hint}>
              <button
                type="button"
                className="flex min-w-0 flex-col gap-0.5 bg-surface px-4 py-3 text-left transition-colors hover:bg-sunken"
                onClick={() => onOpenSources([status])}
                aria-label={`${meta.label}: ${count} sources. Open them.`}
              >
                <span className="flex items-center gap-1.5 text-[12px] leading-4 font-medium text-ink-3">
                  <meta.icon
                    className={cn('size-3.5 shrink-0', count === 0 ? 'text-ink-4' : meta.tone === 'crit' ? 'text-crit' : meta.tone === 'warn' || meta.tone === 'demo' ? 'text-warn-ink' : meta.tone === 'good' ? 'text-good-ink' : 'text-ink-3')}
                    aria-hidden
                  />
                  <span className="truncate">{meta.label}</span>
                </span>
                <span className={cn('num text-[22px] leading-7 font-semibold tracking-[-0.01em]', count === 0 ? 'text-ink-4' : 'text-ink')}>{fmtNumber(count)}</span>
              </button>
            </Tip>
          );
        })}
        <div className="bg-surface lg:hidden" aria-hidden />
      </div>
      {byFrequency.length ? (
        <p className="border-t border-line px-4 py-2.5 text-[12px] leading-5 text-ink-3">
          Collection frequency:{' '}
          {byFrequency.map((f, i) => (
            <span key={f.frequency}>
              {i ? ' · ' : ''}
              {FREQUENCY_LABELS[f.frequency]} <span className="num font-medium text-ink-2">{fmtNumber(f.count)}</span>
            </span>
          ))}
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// What needs attention
// ---------------------------------------------------------------------------------------------
function SimulatedLine({ children }: { children: ReactNode }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] leading-4 text-ink-3">
      <DemoTag />
      {children}
    </span>
  );
}

function AttentionTiles({ health, days, go }: { health: CollectionHealth; days: number; go: (patch: CollectionPatch) => void }) {
  const navigate = useNavigate();
  const real = health.window.real;
  const sim = health.window.simulated;
  const hasSimulated = health.sources.simulated > 0 || sim.attempts > 0;
  const realRecorded = real.attempts + real.not_configured > 0;
  const staleReal = health.stale.real + health.stale.manual;
  const from = addDays(health.generated_at.slice(0, 10), -(days - 1));
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        label="Failed jobs · real sources"
        icon={TriangleAlert}
        tone={real.failed > 0 ? 'crit' : 'default'}
        value={realRecorded ? fmtNumber(real.failed) : DASH}
        detail={
          realRecorded
            ? `of ${plural(real.attempts, 'real run')} in the last ${days} days${real.not_configured ? ` · ${fmtNumber(real.not_configured)} more made no attempt (not configured)` : ''}`
            : `No real run was attempted in the last ${days} days`
        }
        footer={hasSimulated ? <SimulatedLine>Simulated: {fmtNumber(sim.failed)} of {fmtNumber(sim.attempts)} runs failed</SimulatedLine> : undefined}
        onClick={() => go({ ...cleared(JOB_FILTER_KEYS), tab: 'jobs', j_status: 'failed', j_class: real.failed > 0 ? 'real' : undefined, j_from: from, j_page: undefined })}
        title="Open the failed jobs"
      />
      <StatTile
        label="Listings not updated"
        icon={ClockAlert}
        tone={staleReal > 0 ? 'warn' : 'default'}
        value={fmtNumber(staleReal)}
        detail={`without a fresh observation · automated real sources ${fmtNumber(health.stale.real)} · manual / import ${fmtNumber(health.stale.manual)}`}
        footer={hasSimulated ? <SimulatedLine>Simulated sources: {fmtNumber(health.stale.simulated)} not updated</SimulatedLine> : undefined}
        onClick={() => navigate('/monitor?stale=true')}
        title="Open the stale listings in the Live Price Monitor"
      />
      <StatTile
        label="Missing prices"
        icon={PackageSearch}
        tone={health.stale.never_observed > 0 ? 'warn' : 'default'}
        value={fmtNumber(health.stale.never_observed)}
        detail={`${health.stale.never_observed === 1 ? 'listing has' : 'listings have'} never been observed · ${fmtNumber(health.latest_runs.real.listings_missing)} not returned in the latest real runs`}
        footer={hasSimulated ? <SimulatedLine>Simulated: {fmtNumber(health.latest_runs.simulated.listings_missing)} not returned in the latest runs</SimulatedLine> : undefined}
        onClick={() => navigate('/monitor?never_observed=true')}
        title="Open the never-observed listings in the Live Price Monitor"
      />
      <StatTile
        label="Extraction errors · real sources"
        icon={CircleAlert}
        tone={real.listings_failed > 0 ? 'crit' : 'default'}
        value={real.attempts > 0 ? fmtNumber(real.listings_failed) : DASH}
        detail={real.attempts > 0 ? `${real.listings_failed === 1 ? 'listing' : 'listings'} could not be read during real runs in the last ${days} days` : 'No real run was attempted, so nothing could fail'}
        footer={hasSimulated ? <SimulatedLine>Simulated: {fmtNumber(sim.listings_failed)} listing failures</SimulatedLine> : undefined}
        onClick={() => go({ ...cleared(LOG_FILTER_KEYS), tab: 'logs', l_level: 'error', l_from: from, l_page: undefined })}
        title="Open the error log"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Runs per day (one chart per kind — the two are never stacked together)
// ---------------------------------------------------------------------------------------------
function RunsChart({ kind, health, days, refetching }: { kind: JobDataClass; health: CollectionHealth; days: number; refetching: boolean }) {
  const simulated = kind === 'simulated';
  const segments: StackSegment[] = [
    { key: 'succeeded', label: 'Succeeded', color: OUTCOME_COLORS.succeeded },
    { key: 'partial', label: 'Partial', color: OUTCOME_COLORS.partial },
    { key: 'failed', label: 'Failed', color: OUTCOME_COLORS.failed },
    ...(simulated ? [] : [{ key: 'not_configured', label: 'Not configured (no attempt)', color: OUTCOME_COLORS.not_configured }]),
  ];
  const data = health.daily.map((d) => ({
    date: d.date,
    values: simulated
      ? { succeeded: d.simulated_succeeded, partial: d.simulated_partial, failed: d.simulated_failed }
      : { succeeded: d.real_succeeded, partial: d.real_partial, failed: d.real_failed, not_configured: d.real_not_configured },
  }));
  const observations = health.daily.map((d) => (simulated ? d.simulated_observations : d.real_observations));
  const total = data.reduce((acc, d) => acc + Object.values(d.values).reduce((a: number, v) => a + v, 0), 0);
  const stored = observations.reduce((a, v) => a + v, 0);
  return (
    <ChartFrame
      title={
        <span className="flex flex-wrap items-center gap-2">
          {simulated ? 'Simulated demo runs per day' : 'Real collection runs per day'}
          {simulated ? <DemoBadge /> : null}
        </span>
      }
      subtitle={simulated ? `${SIMULATED_RUN_NOTE} · last ${days} days, by outcome` : `Runs against real retailer systems · last ${days} days, by outcome`}
      legend={<Legend items={segments.map((s) => ({ key: s.key, label: s.label, color: s.color, shape: 'rect' as const }))} />}
      table={{
        columns: ['Date', ...segments.map((s) => s.label), simulated ? 'DEMO observations' : 'Observations stored'],
        rows: data.map((d, i) => [d.date, ...segments.map((s) => (d.values as Record<string, number>)[s.key] ?? 0), observations[i] ?? 0]),
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
      footer={
        total > 0 ? (
          <>
            <span className="num font-medium text-ink-2">{fmtNumber(stored)}</span> {simulated ? 'DEMO observations generated' : 'observations stored'} by{' '}
            <span className="num">{fmtNumber(total)}</span> {simulated ? 'simulated runs' : 'real runs'} in this window
          </>
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

function FreshnessCard({ sources, loading, error, onRetry }: { sources: CollectionSource[] | undefined; loading: boolean; error: unknown; onRetry: () => void }) {
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
    return (['real', 'people', 'simulated'] as SourceKind[]).map((kind) => ({ kind, ...acc[kind] }));
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
function ProvenanceCard({ health }: { health: CollectionHealth }) {
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

// ---------------------------------------------------------------------------------------------
// Retailer-level health
// ---------------------------------------------------------------------------------------------
function needsAttention(s: CollectionSource): boolean {
  return s.status === 'failing' || s.status === 'not_configured' || s.status === 'pending' || s.listings_stale > 0 || s.consecutive_failures > 0;
}

function RetailerHealth({
  sources, loading, error, refetching, onRetry, onOpen, view, page, onView, onPage, selected,
}: {
  sources: CollectionSource[] | undefined;
  loading: boolean;
  error: unknown;
  refetching: boolean;
  onRetry: () => void;
  onOpen: (retailerId: number) => void;
  view: 'all' | 'attention';
  page: number;
  onView: (next: 'all' | 'attention') => void;
  onPage: (next: number) => void;
  selected: number | null;
}) {
  const sorted = useMemo(() => {
    const list = [...(sources ?? [])].filter((s) => view === 'all' || needsAttention(s));
    list.sort(
      (a, b) =>
        ATTENTION_ORDER.indexOf(a.status) - ATTENTION_ORDER.indexOf(b.status) || b.listings_stale - a.listings_stale || a.name.localeCompare(b.name),
    );
    return list;
  }, [sources, view]);
  const attention = useMemo(() => (sources ?? []).filter(needsAttention).length, [sources]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = sorted.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const columns: Array<Column<CollectionSource>> = [
    {
      key: 'source',
      header: 'Source',
      cell: (s) => (
        <div className="min-w-[10rem]">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-ink">{s.name}</span>
            {s.is_demo ? <DemoBadge /> : null}
          </div>
          <div className="text-[11.5px] text-ink-3">
            {s.market_name} · <MethodLabel method={s.method} />
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => (
        <div className="max-w-[24rem] min-w-[8rem]">
          <SourceStatusBadge status={s.status} />
          <p className="mt-1 hidden text-[11.5px] leading-4 text-ink-3 md:line-clamp-2" title={s.status_reason}>
            {s.status_reason}
          </p>
        </div>
      ),
    },
    {
      key: 'schedule',
      header: 'Frequency · next run',
      hideBelow: 'xl',
      cell: (s) => (
        <div className="text-[12.5px] whitespace-nowrap">
          <div className="text-ink-2">
            <FrequencyLabel frequency={s.frequency} />
            {s.frequency_inherited ? <span className="text-ink-3"> · market default</span> : null}
          </div>
          <div className="text-[11.5px] text-ink-3">
            {s.next_run_at ? (
              <>
                Next <MarketTime iso={s.next_run_at} timeZone={s.timezone} short />
              </>
            ) : s.runnable ? (
              'Nothing scheduled'
            ) : (
              'Not scheduled — updated by people'
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'success',
      header: 'Last success',
      hideBelow: 'md',
      headerTitle: 'Last run that captured prices, in the market’s own time',
      cell: (s) =>
        s.last_success_at ? (
          <MarketTime iso={s.last_success_at} timeZone={s.timezone} relative />
        ) : (
          <span className="text-[12.5px] whitespace-nowrap text-ink-4">{s.runnable ? 'No successful run' : 'Not applicable'}</span>
        ),
    },
    {
      key: 'attempt',
      header: 'Last attempt',
      hideBelow: 'lg',
      cell: (s) =>
        s.latest_job ? (
          <div className="flex flex-col items-start gap-1">
            <JobStatusBadge status={s.latest_job.status} dataClass={s.latest_job.data_class} />
            <span className="text-[11.5px] whitespace-nowrap text-ink-3">
              {s.last_attempt_at ? fmtRelative(s.last_attempt_at) : DASH}
              {s.consecutive_failures > 1 ? ` · ${s.consecutive_failures} failures in a row` : ''}
            </span>
          </div>
        ) : (
          <span className="text-[12.5px] whitespace-nowrap text-ink-4">{s.runnable ? 'Never attempted' : 'Not applicable'}</span>
        ),
    },
    {
      key: 'captured',
      header: 'Last run',
      hideBelow: 'xl',
      headerTitle: 'Listings captured, not returned and failed in the most recent finished run',
      cell: (s) =>
        s.listings_captured_last_run === null ? (
          <span className="text-[12.5px] text-ink-4">{DASH}</span>
        ) : (
          <span className="num text-[12.5px] whitespace-nowrap text-ink-2">
            {fmtNumber(s.listings_captured_last_run)} captured
            {s.listings_missing_last_run ? <span className="text-ink-3"> · {fmtNumber(s.listings_missing_last_run)} not returned</span> : null}
            {s.listings_failed_last_run ? <span className="text-crit-ink"> · {fmtNumber(s.listings_failed_last_run)} failed</span> : null}
          </span>
        ),
    },
    {
      key: 'freshness',
      header: 'Freshness',
      headerTitle: 'Active listings with a fresh observation; stale ones open in the Live Price Monitor',
      cell: (s) => {
        if (s.listings_active === 0) return <span className="text-[12.5px] whitespace-nowrap text-ink-4">No active listings</span>;
        const fresh = Math.max(0, s.listings_active - s.listings_stale);
        const overdue = Math.max(0, s.listings_stale - s.listings_never_observed);
        return (
          <div className="min-w-[7.5rem]">
            <SegmentedBar
              height={6}
              className="max-w-[9rem]"
              parts={[
                { key: 'fresh', label: 'Fresh', value: fresh, color: FRESHNESS_COLORS.fresh },
                { key: 'stale', label: 'Stale', value: overdue, color: FRESHNESS_COLORS.stale },
                { key: 'never', label: 'Never observed', value: s.listings_never_observed, color: FRESHNESS_COLORS.never },
              ]}
            />
            <div className="num mt-1 text-[11.5px] whitespace-nowrap text-ink-3">
              {fmtNumber(fresh)} of {fmtNumber(s.listings_active)} fresh
              {s.listings_stale > 0 ? (
                <>
                  {' · '}
                  <Link
                    className="link"
                    to={`/monitor?stale=true&retailer_id=${s.retailer_id}`}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    title="Open these listings in the Live Price Monitor"
                  >
                    {fmtNumber(s.listings_stale)} stale
                  </Link>
                </>
              ) : null}
            </div>
          </div>
        );
      },
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Retailer health"
        subtitle="Every source, the ones that need attention first. Select a row for what it needs, its recent jobs and a connection test."
        actions={
          <Segmented
            size="sm"
            label="Rows"
            value={view}
            onChange={onView}
            options={[
              { value: 'all', label: `All ${sources ? fmtNumber(sources.length) : ''}`.trim() },
              { value: 'attention', label: `Needs attention ${sources ? fmtNumber(attention) : ''}`.trim() },
            ]}
          />
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : (
        <DataTable
          columns={columns}
          rows={sources ? rows : undefined}
          rowKey={(s) => s.retailer_id}
          loading={loading}
          refetching={refetching}
          onRowClick={(s) => onOpen(s.retailer_id)}
          selectedKey={selected}
          empty={
            view === 'attention' ? (
              <EmptyState title="No source needs attention" description="No source is failing, unconfigured or waiting for its first run, and no listing is stale." />
            ) : (
              <EmptyState
                title="No sources yet"
                description="A source is a retailer with a collection method. Add one in Administration, then come back here to watch it."
                action={
                  <Link to="/admin?tab=retailers" className="link text-[13px]">
                    Open Administration → Retailers
                  </Link>
                }
              />
            )
          }
          footer={<Pagination page={current} pages={pages} total={sorted.length} pageSize={PAGE_SIZE} onPage={onPage} noun="sources" />}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------------------------
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
  const refetching = health.isFetching && !health.isPending;
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
                <Badge tone={busy > 0 ? 'accent' : 'neutral'} icon={Timer}>
                  Scheduler on{busy > 0 ? ` · ${data.scheduler.running_jobs} running, ${data.scheduler.queued_jobs} queued` : ''}
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
      </FilterBar>

      {health.isError && !data ? (
        <Card>
          <ErrorState error={health.error} onRetry={() => void health.refetch()} />
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

          <AttentionTiles health={data} days={data.window_days} go={set} />

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
            refetching={sources.isFetching && !sources.isPending}
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
