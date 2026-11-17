/**
 * Shared pieces of the Data Collection Centre: the status vocabulary (never colour alone), the marker that
 * separates simulated runs from real collection, time / duration cells, and the action runner that reports
 * the REAL outcome of every run, retry and cancellation.
 */
import { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Ban, CircleCheck, CircleDashed, CircleX, Clock, FlaskConical, Hand, Hourglass, Info, LoaderCircle, Pause, Radio, TriangleAlert,
  type LucideIcon, type LucideProps,
} from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { DASH, fmtDateTime, fmtDateTimeShort, fmtNumber, fmtPct, fmtRelative } from '@/lib/format.ts';
import { useToast } from '@/components/ui/overlays.tsx';
import { Badge, cn, Tip, type BadgeTone } from '@/components/ui/primitives.tsx';
import type { CollectionJob, CollectionJobDetail, JobDataClass, JobStatus, RunDueResult, SourceStatus } from '@shared/api/collection.ts';

export function errorText(error: unknown, fallback = 'Something went wrong'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// ---------------------------------------------------------------------------------------------
// Source status — seven states, each with its own icon and label
// ---------------------------------------------------------------------------------------------
export interface StatusMeta {
  label: string;
  tone: BadgeTone;
  icon: LucideIcon;
  hint: string;
}

/** Display order: what needs attention first, the demo generator last. */
export const SOURCE_STATUSES: SourceStatus[] = ['healthy', 'failing', 'not_configured', 'pending', 'paused', 'manual', 'simulated'];

export const SOURCE_STATUS_META: Record<SourceStatus, StatusMeta> = {
  healthy: { label: 'Healthy', tone: 'good', icon: CircleCheck, hint: 'A real source: fully configured, and its latest run captured prices.' },
  failing: { label: 'Failing', tone: 'crit', icon: CircleX, hint: 'A real source whose latest run failed. Nothing new is being captured from it.' },
  not_configured: { label: 'Not configured', tone: 'warn', icon: CircleDashed, hint: 'Required configuration is missing. Nothing is collected from this source until it is provided.' },
  pending: { label: 'No run yet', tone: 'accent', icon: Hourglass, hint: 'Fully configured, but no collection has run yet — nothing has been captured so far.' },
  paused: { label: 'Paused', tone: 'neutral', icon: Pause, hint: 'Scheduled collection is switched off for this source.' },
  manual: { label: 'Manual / import', tone: 'outline', icon: Hand, hint: 'Updated by people — manual price entry or file imports. Nothing is collected automatically.' },
  simulated: { label: 'Simulated demo', tone: 'demo', icon: FlaskConical, hint: 'Generates illustrative DEMO data. It contacts nothing and is not a real integration.' },
};

export function SourceStatusBadge({ status, className }: { status: SourceStatus; className?: string }) {
  const meta = SOURCE_STATUS_META[status] ?? SOURCE_STATUS_META.not_configured;
  return (
    <Tip content={meta.hint}>
      <span className={cn('inline-flex', className)}>
        <Badge tone={meta.tone} icon={meta.icon}>
          {meta.label}
        </Badge>
      </span>
    </Tip>
  );
}

// ---------------------------------------------------------------------------------------------
// Job status
// ---------------------------------------------------------------------------------------------
const Spinning = forwardRef<SVGSVGElement, LucideProps>(function Spinning({ className, ...rest }, ref) {
  return <LoaderCircle ref={ref} className={cn(className, 'animate-spin-slow')} {...rest} />;
}) as LucideIcon;

export const JOB_STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'partial', 'failed', 'not_configured', 'cancelled'];

export const JOB_STATUS_META: Record<JobStatus, StatusMeta> = {
  queued: { label: 'Queued', tone: 'neutral', icon: Clock, hint: 'Waiting to start.' },
  running: { label: 'Running', tone: 'accent', icon: Spinning, hint: 'In progress.' },
  succeeded: { label: 'Succeeded', tone: 'good', icon: CircleCheck, hint: 'Every listing returned a price.' },
  partial: { label: 'Partial', tone: 'warn', icon: TriangleAlert, hint: 'Some listings were captured; others were missing or failed.' },
  failed: { label: 'Failed', tone: 'crit', icon: CircleX, hint: 'The run failed and nothing was captured.' },
  not_configured: { label: 'Not configured', tone: 'warn', icon: CircleDashed, hint: 'No attempt was made, because the source is not configured. This is not a success.' },
  cancelled: { label: 'Cancelled', tone: 'outline', icon: Ban, hint: 'Stopped before it finished.' },
};

export const SIMULATED_RUN_NOTE = 'Simulated run — not a real collection';

/**
 * Outcome of a run. A simulated run never wears the green "succeeded" badge of a real collection:
 * it is always hatched and says "Simulated".
 */
export function JobStatusBadge({ status, dataClass, className }: { status: JobStatus; dataClass: JobDataClass; className?: string }) {
  const meta = JOB_STATUS_META[status] ?? JOB_STATUS_META.failed;
  if (dataClass === 'simulated') {
    const inProgress = status === 'queued' || status === 'running';
    return (
      <Tip content={`${SIMULATED_RUN_NOTE}. ${meta.hint}`}>
        <span className={cn('inline-flex', className)}>
          <Badge tone="demo" icon={inProgress ? meta.icon : FlaskConical}>
            Simulated · {meta.label.toLowerCase()}
          </Badge>
        </span>
      </Tip>
    );
  }
  return (
    <Tip content={meta.hint}>
      <span className={cn('inline-flex', className)}>
        <Badge tone={meta.tone} icon={meta.icon}>
          {meta.label}
        </Badge>
      </span>
    </Tip>
  );
}

/** Real vs simulated — the two kinds of run are never counted together. */
export function RunKindBadge({ dataClass }: { dataClass: JobDataClass }) {
  return dataClass === 'simulated' ? (
    <Tip content={`${SIMULATED_RUN_NOTE}. It produces illustrative DEMO data only.`}>
      <span className="inline-flex">
        <Badge tone="demo" icon={FlaskConical}>
          Simulated
        </Badge>
      </span>
    </Tip>
  ) : (
    <Tip content="A run against a real retailer system (API, feed, permitted website extraction or data provider).">
      <span className="inline-flex">
        <Badge tone="outline" icon={Radio}>
          Real
        </Badge>
      </span>
    </Tip>
  );
}

export const TRIGGER_LABELS: Record<CollectionJob['trigger_type'], string> = { schedule: 'Scheduled', manual: 'Run manually', retry: 'Retry' };

export const LOG_LEVEL_META: Record<'info' | 'warn' | 'error', { label: string; icon: LucideIcon; className: string }> = {
  error: { label: 'Error', icon: CircleX, className: 'text-crit-ink' },
  warn: { label: 'Warning', icon: TriangleAlert, className: 'text-warn-ink' },
  info: { label: 'Info', icon: Info, className: 'text-ink-3' },
};

export function LogLevel({ level }: { level: 'info' | 'warn' | 'error' }) {
  const meta = LOG_LEVEL_META[level] ?? LOG_LEVEL_META.info;
  return (
    <span className={cn('inline-flex items-center gap-1 text-[12px] font-medium whitespace-nowrap', meta.className)}>
      <meta.icon className="size-3.5" aria-hidden />
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Time, duration, rates
// ---------------------------------------------------------------------------------------------
const utcText = (iso: string) => `${iso.replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '')} UTC`;

/** An instant in the viewer's own time zone, with the exact UTC value on hover. */
export function ViewerTime({ iso, relative, long, className }: { iso: string | null | undefined; relative?: boolean; long?: boolean; className?: string }) {
  if (!iso) return <span className="text-ink-4">{DASH}</span>;
  return (
    <Tip content={`${fmtDateTime(iso)} (your time) · ${utcText(iso)}`}>
      <span className={cn('num whitespace-nowrap text-ink-2', className)}>{relative ? fmtRelative(iso) : long ? fmtDateTime(iso) : fmtDateTimeShort(iso)}</span>
    </Tip>
  );
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes - hours * 60} min`;
}

/** A 0–1 success rate as a percentage. `null` means no attempt was made — shown as "n/a", never as 100 %. */
export function fmtRate(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate) ? 'n/a' : fmtPct(rate * 100, 0);
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** "28 of 29 listings captured · 1 not returned" — what a finished run actually did. */
export function runSummary(job: Pick<CollectionJob, 'status' | 'listings_total' | 'listings_succeeded' | 'listings_failed' | 'listings_missing'>): string {
  if (job.status === 'queued') return 'Waiting to start';
  if (job.status === 'running') return 'In progress';
  if (job.status === 'not_configured') return 'No attempt was made';
  const parts = [`${fmtNumber(job.listings_succeeded)} of ${fmtNumber(job.listings_total)} listings captured`];
  if (job.listings_missing) parts.push(`${fmtNumber(job.listings_missing)} not returned`);
  if (job.listings_failed) parts.push(`${fmtNumber(job.listings_failed)} failed`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Actions: run now, retry, cancel, run due. Every action reports what really happened.
// ---------------------------------------------------------------------------------------------
const IN_PROGRESS: JobStatus[] = ['queued', 'running'];
const WATCH_LIMIT_MS = 90_000;
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

interface CollectionActions {
  canRun: boolean;
  canManage: boolean;
  /** Keys with a request in flight: `source:<retailer id>`, `job:<job id>`, `run-due`. */
  busy: ReadonlySet<string>;
  run: (source: { retailer_id: number; name: string }) => Promise<void>;
  retry: (job: { id: number; retailer_name: string }) => Promise<void>;
  cancel: (job: { id: number; retailer_name: string }) => Promise<void>;
  runDue: () => Promise<void>;
  /** Marks everything derived from collection as stale (this screen and the analytics built on the ledger). */
  refresh: () => Promise<void>;
}

const ActionsContext = createContext<CollectionActions | null>(null);

export function CollectionActionsProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const toast = useToast();
  const canRun = useCan('collection.run');
  const canManage = useCan('sources.manage');
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const mark = useCallback((key: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    // New observations change every analytic view, so everything except the session and reference lists is refreshed.
    await client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' && q.queryKey[0] !== 'reference' });
  }, [client]);

  /** Polls a job until it finishes (bounded), then returns its final state. */
  const follow = useCallback(async (job: CollectionJob): Promise<CollectionJob> => {
    let current = job;
    const deadline = Date.now() + WATCH_LIMIT_MS;
    while (IN_PROGRESS.includes(current.status) && Date.now() < deadline && mounted.current) {
      await sleep(current.status === 'queued' ? 1500 : 900);
      try {
        current = (await apiGet<CollectionJobDetail>(`/collection/jobs/${job.id}`)).job;
      } catch {
        break;
      }
    }
    return current;
  }, []);

  const announce = useCallback(
    (job: CollectionJob) => {
      const simulated = job.data_class === 'simulated';
      const name = job.retailer_name;
      const stored = `${fmtNumber(job.observations_created)} ${simulated ? 'DEMO observation' : 'observation'}${job.observations_created === 1 ? '' : 's'} stored`;
      const duplicates = job.duplicates_skipped ? ` · ${fmtNumber(job.duplicates_skipped)} already in the ledger` : '';
      const tail = simulated ? ` ${SIMULATED_RUN_NOTE}.` : '';
      switch (job.status) {
        case 'succeeded':
          toast.success(simulated ? `Simulated run finished — ${name}` : `Collection succeeded — ${name}`, `${runSummary(job)} · ${stored}${duplicates}.${tail}`);
          break;
        case 'partial':
          toast.info(simulated ? `Simulated run finished with gaps — ${name}` : `Collection finished with gaps — ${name}`, `${runSummary(job)} · ${stored}${duplicates}.${job.error_message ? ` ${job.error_message}` : ''}${tail}`);
          break;
        case 'failed':
          toast.error(simulated ? `Simulated run failed — ${name}` : `Collection failed — ${name}`, `${job.error_message ?? 'The run failed.'} Nothing was captured.${tail}`);
          break;
        case 'not_configured':
          toast.error(`Not configured — nothing was collected from ${name}`, job.error_message ?? 'The source is missing required configuration, so no attempt was made.');
          break;
        case 'cancelled':
          toast.info(`Collection cancelled — ${name}`, job.error_message ?? undefined);
          break;
        default:
          toast.info(`Job #${job.id} for ${name} is still ${job.status}`, 'Follow it on the Jobs tab.');
      }
    },
    [toast],
  );

  const start = useCallback(
    async (key: string, request: () => Promise<{ job: CollectionJob }>, failTitle: string) => {
      mark(key, true);
      try {
        const { job } = await request();
        await refresh();
        const final = await follow(job);
        await refresh();
        if (mounted.current) announce(final);
      } catch (err) {
        toast.error(failTitle, errorText(err));
        await refresh();
      } finally {
        mark(key, false);
      }
    },
    [announce, follow, mark, refresh, toast],
  );

  const run = useCallback(
    (source: { retailer_id: number; name: string }) =>
      start(`source:${source.retailer_id}`, () => apiPost<{ job: CollectionJob }>(`/collection/retailers/${source.retailer_id}/run`), `The collection was not started — ${source.name}`),
    [start],
  );

  const retry = useCallback(
    (job: { id: number; retailer_name: string }) =>
      start(`job:${job.id}`, () => apiPost<{ job: CollectionJob }>(`/collection/jobs/${job.id}/retry`), `The retry was not started — ${job.retailer_name}`),
    [start],
  );

  const cancel = useCallback(
    async (job: { id: number; retailer_name: string }) => {
      mark(`job:${job.id}`, true);
      try {
        const result = await apiPost<{ job: CollectionJob }>(`/collection/jobs/${job.id}/cancel`);
        if (result.job.status === 'cancelled') toast.info(`Job #${job.id} cancelled — ${job.retailer_name}`, 'Nothing more will be collected by this run.');
        else toast.info(`Cancellation requested — job #${job.id}`, 'The run stops after its current request.');
      } catch (err) {
        toast.error(`Job #${job.id} was not cancelled`, errorText(err));
      } finally {
        await refresh();
        mark(`job:${job.id}`, false);
      }
    },
    [mark, refresh, toast],
  );

  const runDue = useCallback(async () => {
    mark('run-due', true);
    try {
      const result = await apiPost<RunDueResult>('/collection/run-due');
      await refresh();
      if (result.started.length === 0) {
        toast.info(
          'Nothing is due right now',
          result.skipped.length
            ? `${result.skipped.length} source${result.skipped.length === 1 ? ' was' : 's were'} skipped: ${result.skipped
                .slice(0, 3)
                .map((s) => `${s.name} (${s.reason})`)
                .join('; ')}${result.skipped.length > 3 ? '…' : ''}`
            : 'No source or retry is scheduled to run at this moment.',
        );
        return;
      }
      const finished = await Promise.all(result.started.map((job) => follow(job)));
      await refresh();
      if (!mounted.current) return;
      const describe = (jobs: CollectionJob[]) => {
        const counts = new Map<JobStatus, number>();
        for (const j of jobs) counts.set(j.status, (counts.get(j.status) ?? 0) + 1);
        return JOB_STATUSES.filter((s) => counts.has(s))
          .map((s) => `${counts.get(s)} ${JOB_STATUS_META[s].label.toLowerCase()}`)
          .join(', ');
      };
      const real = finished.filter((j) => j.data_class === 'real');
      const simulated = finished.filter((j) => j.data_class === 'simulated');
      const lines = [real.length ? `Real collection: ${describe(real)}.` : '', simulated.length ? `Simulated demo runs: ${describe(simulated)}.` : ''].filter(Boolean);
      if (result.skipped.length) lines.push(`${result.skipped.length} skipped.`);
      const problem = real.some((j) => j.status === 'failed' || j.status === 'not_configured');
      (problem ? toast.error : toast.info)(`${result.started.length} due job${result.started.length === 1 ? '' : 's'} ran`, lines.join(' '));
    } catch (err) {
      toast.error('Due sources were not run', errorText(err));
      await refresh();
    } finally {
      mark('run-due', false);
    }
  }, [follow, mark, refresh, toast]);

  const value = useMemo<CollectionActions>(() => ({ canRun, canManage, busy, run, retry, cancel, runDue, refresh }), [busy, canManage, canRun, cancel, refresh, retry, run, runDue]);
  return <ActionsContext.Provider value={value}>{children}</ActionsContext.Provider>;
}

export function useCollectionActions(): CollectionActions {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('useCollectionActions must be used inside <CollectionActionsProvider>');
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Small layout helpers
// ---------------------------------------------------------------------------------------------
export function SectionTitle({ children, aside, className }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1', className)}>
      <h3 className="eyebrow">{children}</h3>
      {aside}
    </div>
  );
}

/** One figure with its caption — used in rows of facts where a full stat tile would be too loud. */
export function Fact({ label, value, hint, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="truncate text-[11.5px] leading-4 text-ink-3">{label}</div>
      <div className="num text-[15px] leading-6 font-semibold text-ink">{value}</div>
      {hint ? <div className="text-[11.5px] leading-4 text-ink-3">{hint}</div> : null}
    </div>
  );
}
