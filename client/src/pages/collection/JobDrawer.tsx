/** One collection run: what it did, why it failed, its retry chain and its log lines. */
import { CircleStop, CircleX, FlaskConical, PanelRight, RotateCw, ScrollText } from 'lucide-react';
import { DASH, fmtNumber } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { Drawer } from '@/components/ui/overlays.tsx';
import { Button, cn, DescriptionList, ErrorState, LoadingBlock, Notice } from '@/components/ui/primitives.tsx';
import { DemoBadge, MethodLabel } from '@/components/domain/domain.tsx';
import type { CollectionJobDetail } from '@shared/api/collection.ts';
import { Fact, fmtDuration, JobStatusBadge, LogLevel, RunKindBadge, runSummary, SectionTitle, SIMULATED_RUN_NOTE, TRIGGER_LABELS, useCollectionActions, ViewerTime } from './shared.tsx';
import { cleared, LOG_FILTER_KEYS, useCollectionUrl } from './url.ts';

export function JobDrawer({ jobId, onClose }: { jobId: number | null; onClose: () => void }) {
  const actions = useCollectionActions();
  const { set } = useCollectionUrl();
  const open = jobId !== null;
  const detail = useApiQuery<CollectionJobDetail>(['collection', 'job', jobId], `/collection/jobs/${jobId}`, undefined, {
    enabled: open,
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === 'queued' || status === 'running' ? 1500 : false;
    },
  });
  const data = open && detail.data?.job.id === jobId ? detail.data : undefined;
  const job = data?.job;
  const simulated = job?.data_class === 'simulated';
  const busy = jobId !== null && actions.busy.has(`job:${jobId}`);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={job ? `Job #${job.id} — ${job.retailer_name}` : jobId !== null ? `Job #${jobId}` : 'Job'}
      subtitle={
        job ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {job.market_name} · <MethodLabel method={job.method} />
            </span>
            {job.is_demo ? <DemoBadge /> : null}
          </span>
        ) : undefined
      }
      footer={
        job ? (
          <>
            <Button icon={PanelRight} onClick={() => set({ source: String(job.retailer_id), job: undefined })}>
              Open source
            </Button>
            {actions.canRun && data?.can_cancel ? (
              <Button icon={CircleStop} loading={busy} onClick={() => void actions.cancel(job)}>
                Cancel run
              </Button>
            ) : null}
            {actions.canRun && data?.can_retry ? (
              <Button variant="primary" icon={RotateCw} loading={busy} onClick={() => void actions.retry(job)}>
                Retry this job
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {!open ? null : detail.isError && !data ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : !data || !job ? (
        <LoadingBlock />
      ) : (
        <div className="flex flex-col gap-5">
          <section>
            <div className="flex flex-wrap items-center gap-2">
              <JobStatusBadge status={job.status} dataClass={job.data_class} />
              {simulated ? null : <RunKindBadge dataClass={job.data_class} />}
              <span className="text-[12.5px] text-ink-3">
                {TRIGGER_LABELS[job.trigger_type] ?? job.trigger_type}
                {job.requested_by_name ? ` by ${job.requested_by_name}` : ''}
                {job.attempt > 1 ? ` · attempt ${job.attempt}` : ''}
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-5 text-ink-2">{runSummary(job)}.</p>
            {simulated ? (
              <Notice tone="demo" icon={FlaskConical} className="mt-3" title={SIMULATED_RUN_NOTE}>
                The demo generator produced these figures. No retailer was contacted and the observations are labelled DEMO.
              </Notice>
            ) : null}
            {job.error_message && job.status !== 'succeeded' ? (
              <Notice
                tone={job.status === 'failed' ? 'crit' : 'warn'}
                icon={CircleX}
                className="mt-3"
                title={job.status === 'failed' ? 'Why it failed' : job.status === 'not_configured' ? 'Why no attempt was made' : job.status === 'cancelled' ? 'Cancelled' : 'What was incomplete'}
              >
                {job.error_message}
                {job.error_code ? <span className="mono text-ink-3"> ({job.error_code})</span> : null}
              </Notice>
            ) : null}
            {!data.can_retry && actions.canRun && ['failed', 'partial', 'not_configured', 'cancelled'].includes(job.status) ? (
              <p className="mt-2 text-[12px] leading-4 text-ink-3">Another job is already queued or running for this source, so this one cannot be retried right now.</p>
            ) : null}
          </section>

          <section>
            <SectionTitle>What the run did</SectionTitle>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-line px-3 py-3 sm:grid-cols-3">
              <Fact label="Listings attempted" value={job.status === 'not_configured' ? DASH : fmtNumber(job.listings_total)} />
              <Fact label="Returned a price" value={job.status === 'not_configured' ? DASH : fmtNumber(job.listings_succeeded)} />
              <Fact label={simulated ? 'DEMO observations stored' : 'Observations stored'} value={fmtNumber(job.observations_created)} />
              <Fact label="Not returned by the source" value={fmtNumber(job.listings_missing)} />
              <Fact label="Extraction errors" value={fmtNumber(job.listings_failed)} />
              <Fact label="Duplicates skipped" value={fmtNumber(job.duplicates_skipped)} hint="identical re-reads, never stored twice" />
            </div>
          </section>

          <section>
            <SectionTitle>Timing</SectionTitle>
            <DescriptionList
              columns={2}
              items={[
                { label: 'Scheduled for', value: <ViewerTime iso={job.scheduled_for} long />, hidden: !job.scheduled_for },
                { label: 'Created', value: <ViewerTime iso={job.created_at} long /> },
                { label: 'Started', value: job.started_at ? <ViewerTime iso={job.started_at} long /> : 'Not started' },
                { label: 'Finished', value: job.finished_at ? <ViewerTime iso={job.finished_at} long /> : job.status === 'running' ? 'Still running' : DASH },
                { label: 'Duration', value: fmtDuration(job.duration_ms) },
              ]}
            />
          </section>

          {data.chain.length > 1 ? (
            <section>
              <SectionTitle>Retry chain</SectionTitle>
              <ol className="divide-y divide-line rounded-lg border border-line">
                {data.chain.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={cn('flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-sunken', c.id === job.id && 'bg-sunken')}
                      aria-current={c.id === job.id ? 'true' : undefined}
                      onClick={() => set({ job: String(c.id) })}
                    >
                      <span className="num w-24 shrink-0 text-[12px] text-ink-3">
                        Attempt {c.attempt} · #{c.id}
                      </span>
                      <JobStatusBadge status={c.status} dataClass={c.data_class} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{c.error_message && c.status !== 'succeeded' ? c.error_message : runSummary(c)}</span>
                      <ViewerTime iso={c.started_at ?? c.created_at} className="text-[12px] !text-ink-3" />
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section>
            <SectionTitle
              aside={
                <button type="button" className="link inline-flex items-center gap-1 text-[12px]" onClick={() => set({ ...cleared(LOG_FILTER_KEYS), tab: 'logs', l_job: String(job.id), l_page: undefined, job: undefined })}>
                  <ScrollText className="size-3" aria-hidden /> Open in the log
                </button>
              }
            >
              Log of this run ({fmtNumber(data.logs.length)})
            </SectionTitle>
            {data.logs.length === 0 ? (
              <p className="rounded-lg border border-line px-3 py-3 text-[12.5px] text-ink-3">
                {job.status === 'queued' || job.status === 'running' ? 'Nothing logged yet — the run is in progress.' : 'This run logged no warnings or errors.'}
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {data.logs.map((l) => (
                  <li key={l.id} className="px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <LogLevel level={l.level} />
                      <span className="mono text-ink-3">{l.code}</span>
                      <ViewerTime iso={l.created_at} className="ml-auto text-[11.5px] !text-ink-4" />
                    </div>
                    <p className="mono mt-1 leading-5 break-words text-ink-2">{l.message}</p>
                    {l.listing_code ? (
                      <p className="mt-0.5 text-[11.5px] leading-4 text-ink-3">
                        Listing <span className="mono">{l.listing_code}</span>
                        {l.listing_title ? ` · ${l.listing_title}` : ''}
                      </p>
                    ) : null}
                    {l.detail !== null && l.detail !== undefined ? (
                      <details className="mt-1">
                        <summary className="text-[11.5px] text-ink-3">Detail</summary>
                        <pre className="mono mt-1 max-h-40 overflow-auto rounded-md bg-sunken px-2 py-1.5 leading-5 text-ink-2">{typeof l.detail === 'string' ? l.detail : JSON.stringify(l.detail, null, 2)}</pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
