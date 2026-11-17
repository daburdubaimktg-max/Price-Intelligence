/**
 * Source detail: the real state of one source, what it still needs, its recent runs, and a dry-run
 * connection test. The test shows exactly what came back — blocks, missing configuration and all.
 */
import { useEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  CircleCheck, CircleDashed, CircleX, FlaskConical, KeyRound, ListChecks, MonitorDot, Play, PlugZap, SearchX, Settings2, ShieldCheck, TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { apiGet, apiPost, type Paged } from '@/lib/api.ts';
import { fmtNumber, fmtPct, fmtPrice } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { Drawer, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, cn, DescriptionList, ErrorState, LoadingBlock, Notice, type BadgeTone } from '@/components/ui/primitives.tsx';
import { AvailabilityBadge, DemoBadge, FrequencyLabel, MarketTime } from '@/components/domain/domain.tsx';
import type {
  CollectionJob, CollectionSource, CollectionTestListingResult, CollectionTestResult, ConnectorDescription, SourceConfigStatus,
} from '@shared/api/collection.ts';
import {
  errorText, Fact, fmtDuration, hostOf, JobStatusBadge, LogLevel, runSummary, SectionTitle, SIMULATED_RUN_NOTE, SourceStatusBadge, useCollectionActions, ViewerTime,
} from './shared.tsx';
import { cleared, JOB_FILTER_KEYS, useCollectionUrl } from './url.ts';

// ---------------------------------------------------------------------------------------------
// Connection test result
// ---------------------------------------------------------------------------------------------
const LISTING_RESULT_META: Record<CollectionTestListingResult['status'], { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  ok: { label: 'Price read', tone: 'good', icon: CircleCheck },
  failed: { label: 'Failed', tone: 'crit', icon: CircleX },
  missing: { label: 'Not returned', tone: 'warn', icon: SearchX },
  would_discover: { label: 'New item', tone: 'accent', icon: CircleDashed },
};

function TestResultPanel({ result, simulated }: { result: CollectionTestResult; simulated: boolean }) {
  const headline = !result.configured ? (
    <Notice tone="warn" icon={CircleDashed} title="Not configured — no request was made">
      <ul className="mt-1 list-disc pl-4">
        {result.missing.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </Notice>
  ) : result.fatal ? (
    <Notice tone="crit" icon={CircleX} title="The test failed">
      {result.fatal.message} <span className="mono text-ink-3">({result.fatal.code})</span>
    </Notice>
  ) : result.ok ? (
    simulated ? (
      <Notice tone="demo" icon={FlaskConical} title="Simulated dry run — no retailer was contacted">
        The demo generator produced values for {fmtNumber(result.listings_matched)} of {fmtNumber(result.listings_tested)} listings. This says nothing about a real integration.
      </Notice>
    ) : (
      <Notice tone="good" icon={CircleCheck} title="The source answered and prices could be read">
        {fmtNumber(result.listings_matched)} of {fmtNumber(result.listings_tested)} tested listings returned a price.
      </Notice>
    )
  ) : (
    <Notice tone="warn" icon={TriangleAlert} title="The source answered, but no price could be read">
      Check the field mapping and that the listings carry the identifiers the source uses.
    </Notice>
  );

  return (
    <div className="flex flex-col gap-3">
      {headline}
      <p className="text-[12px] leading-4 text-ink-3">{result.note}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-line px-3 py-3 sm:grid-cols-4">
        <Fact label="Requests made" value={fmtNumber(result.requests)} />
        <Fact label="Duration" value={fmtDuration(result.duration_ms)} />
        <Fact label="Items in the response" value={result.items_found === null ? 'n/a' : fmtNumber(result.items_found)} />
        <Fact label="Listings tested" value={fmtNumber(result.listings_tested)} />
        <Fact label="Price read" value={fmtNumber(result.listings_matched)} />
        <Fact label="Not returned" value={fmtNumber(result.listings_missing)} />
        <Fact label="Failed" value={fmtNumber(result.listings_failed)} />
        <Fact label="New items found" value={fmtNumber(result.would_discover)} hint={result.would_discover ? 'not stored by a test' : undefined} />
      </div>

      {result.results.length ? (
        <div className="table-wrap rounded-lg border border-line">
          <table className="grid-table is-dense">
            <thead>
              <tr>
                <th scope="col">Listing</th>
                <th scope="col">Result</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  Would be stored
                </th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r, index) => {
                const meta = LISTING_RESULT_META[r.status] ?? LISTING_RESULT_META.failed;
                const o = r.observation;
                return (
                  <tr key={`${r.listing_id ?? 'new'}-${index}`}>
                    <td>
                      <div className="max-w-[16rem] min-w-[9rem]">
                        <div className="truncate font-medium text-ink" title={r.title ?? undefined}>
                          {r.title ?? 'Untitled item'}
                        </div>
                        <div className="mono truncate text-ink-3">{r.listing_code ?? 'not a listing yet'}</div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={meta.tone} icon={meta.icon}>
                        {meta.label}
                      </Badge>
                      {r.message ? <p className="mt-1 max-w-[18rem] text-[11.5px] leading-4 text-ink-3">{r.message}</p> : null}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {o && o.current_price !== null ? (
                        <div className="whitespace-nowrap">
                          <div>
                            {o.regular_price !== null && o.regular_price > o.current_price ? <span className="mr-1.5 text-[11.5px] text-ink-4 line-through">{fmtPrice(o.regular_price, o.currency_code)}</span> : null}
                            <span className="font-medium text-ink">{fmtPrice(o.current_price, o.currency_code)}</span>
                            {o.currency_code ? <span className="ml-1 text-[11px] text-ink-3">{o.currency_code}</span> : null}
                          </div>
                          <div className="flex items-center justify-end gap-1.5 text-[11.5px] text-ink-3">
                            {o.discount_pct !== null ? <span>{fmtPct(o.discount_pct, 0)} off</span> : null}
                            {o.availability ? <AvailabilityBadge value={o.availability} /> : null}
                            {o.confidence !== null ? <span title="Extraction confidence">conf. {fmtPct(o.confidence * 100, 0)}</span> : null}
                          </div>
                        </div>
                      ) : (
                        <span className="text-ink-4">Nothing</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {result.logs.length ? (
        <ul className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2.5">
          {result.logs.map((l, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-[12px] leading-5">
              <LogLevel level={l.level} />
              <span className="mono text-ink-3">{l.code}</span>
              <span className="min-w-0 text-ink-2">{l.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {result.sample_items.length ? (
        <details className="rounded-lg border border-line">
          <summary className="px-3 py-2 text-[12.5px] font-medium text-ink-2">First items of the response ({result.sample_items.length})</summary>
          <pre className="mono max-h-64 overflow-auto border-t border-line bg-sunken px-3 py-2 leading-5 text-ink-2">{JSON.stringify(result.sample_items, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------------------------
function CheckRow({ ok, okText, missingText, icon: Icon }: { ok: boolean; okText: string; missingText: string; icon: LucideIcon }) {
  return (
    <li className="flex items-start gap-2 text-[12.5px] leading-5">
      <Icon className={cn('mt-[3px] size-3.5 shrink-0', ok ? 'text-good-ink' : 'text-warn-ink')} aria-hidden />
      <span className={ok ? 'text-ink-2' : 'font-medium text-ink'}>{ok ? okText : missingText}</span>
    </li>
  );
}

export function SourceDrawer({ retailerId, autoTest, onAutoTestDone, onClose }: { retailerId: number | null; autoTest: boolean; onAutoTestDone: () => void; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const actions = useCollectionActions();
  const { set } = useCollectionUrl();
  const open = retailerId !== null;

  const sourceQuery = useApiQuery<{ rows: CollectionSource[] }>(['collection', 'sources', 'one'], '/collection/sources', { retailer_id: retailerId ?? undefined, include_inactive: true }, { enabled: open });
  const source = open ? sourceQuery.data?.rows.find((r) => r.retailer_id === retailerId) : undefined;
  const config = useApiQuery<SourceConfigStatus>(['collection', 'retailer-status', retailerId], `/collection/retailers/${retailerId}/status`, undefined, { enabled: open });
  const connectors = useQuery({ queryKey: ['collection', 'connectors'], queryFn: () => apiGet<{ rows: ConnectorDescription[] }>('/collection/connectors'), staleTime: 10 * 60_000, enabled: open });
  const jobs = useApiQuery<Paged<CollectionJob>>(['collection', 'jobs', 'source'], '/collection/jobs', { retailer_id: retailerId ?? undefined, page_size: 6 }, { enabled: open && !!source?.runnable });
  const connector = connectors.data?.rows.find((c) => c.method === source?.method);

  const test = useMutation({
    mutationFn: (id: number) => apiPost<CollectionTestResult>(`/collection/retailers/${id}/test`),
    onSuccess: (result) => {
      if (!result.configured) toast.error('Not configured — no request was made', result.missing.join('; ') || result.note);
      else if (result.fatal) toast.error('Connection test failed', result.fatal.message);
      else if (result.ok) toast.success(result.method === 'simulated' ? 'Simulated dry run finished' : 'Connection test passed', `${fmtNumber(result.listings_matched)} of ${fmtNumber(result.listings_tested)} listings returned a price. Nothing was stored.`);
      else toast.info('The source answered, but no price could be read', 'Nothing was stored.');
    },
    onError: (err) => toast.error('The connection test could not run', errorText(err)),
  });
  const { mutate: runTest, reset: resetTest } = test;

  // A new source starts with a clean test panel.
  useEffect(() => {
    resetTest();
  }, [retailerId, resetTest]);

  // "Test connection" from the table opens the drawer and starts the test once.
  const started = useRef<number | null>(null);
  useEffect(() => {
    if (!autoTest || retailerId === null) return;
    if (started.current !== retailerId) {
      started.current = retailerId;
      runTest(retailerId);
    }
    onAutoTestDone();
  }, [autoTest, retailerId, runTest, onAutoTestDone]);
  useEffect(() => {
    if (retailerId === null) started.current = null;
  }, [retailerId]);

  const simulated = source?.method === 'simulated';
  const adminLink = retailerId !== null ? `/admin?tab=retailers&retailer=${retailerId}` : '/admin?tab=retailers';
  const running = retailerId !== null && actions.busy.has(`source:${retailerId}`);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={source?.name ?? 'Source'}
      subtitle={
        source ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {source.market_name} · {source.method_label}
              {hostOf(source.website) ? ` · ${hostOf(source.website)}` : ''}
            </span>
            {source.is_demo ? <DemoBadge /> : null}
          </span>
        ) : undefined
      }
      footer={
        source ? (
          <>
            <Button icon={MonitorDot} onClick={() => navigate(`/monitor?retailer_id=${source.retailer_id}`)}>
              Listings
            </Button>
            {/* an unconfigured source needs configuring before running it can achieve anything */}
            {source.status === 'not_configured' ? null : (
              <Button icon={Settings2} onClick={() => navigate(adminLink)}>
                {actions.canManage ? 'Configure' : 'Settings'}
              </Button>
            )}
            {actions.canRun && source.runnable ? (
              <Button variant={source.status === 'not_configured' ? 'secondary' : 'primary'} icon={Play} loading={running} disabled={!source.is_active} onClick={() => void actions.run(source)}>
                {simulated ? 'Run now (simulated)' : 'Run now'}
              </Button>
            ) : null}
            {source.status === 'not_configured' ? (
              <Button variant="primary" icon={Settings2} onClick={() => navigate(adminLink)}>
                {actions.canManage ? 'Configure' : 'Settings'}
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {!open ? null : sourceQuery.isError && !source ? (
        <ErrorState error={sourceQuery.error} onRetry={() => void sourceQuery.refetch()} />
      ) : !source ? (
        sourceQuery.isPending ? <LoadingBlock /> : <ErrorState error={new Error('This source no longer exists.')} />
      ) : (
        <div className="flex flex-col gap-5">
          {/* what is really happening */}
          <section>
            <div className="flex flex-wrap items-center gap-2">
              <SourceStatusBadge status={source.status} />
              {!source.is_active ? <Badge tone="outline">Inactive retailer</Badge> : null}
            </div>
            {/* where a notice below says the same thing in full, the one-line reason is not repeated */}
            {simulated || source.status === 'not_configured' || (source.status === 'failing' && source.latest_job?.error_message) ? null : (
              <p className="mt-2 text-[13px] leading-5 text-ink-2">{source.status_reason}</p>
            )}
            {simulated ? (
              <Notice tone="demo" icon={FlaskConical} className="mt-3" title={SIMULATED_RUN_NOTE}>
                This source generates illustrative DEMO prices and contacts no retailer. Its runs are never counted as real collection.
              </Notice>
            ) : null}
            {source.status === 'failing' && source.latest_job?.error_message ? (
              <Notice tone="crit" icon={CircleX} className="mt-3" title={source.consecutive_failures > 1 ? `${source.consecutive_failures} runs in a row have failed` : 'The last run failed'}>
                {source.latest_job.error_message}
                {source.latest_job.error_code ? <span className="mono text-ink-3"> ({source.latest_job.error_code})</span> : null}
              </Notice>
            ) : null}
            {source.status === 'not_configured' ? (
              <Notice
                tone="warn"
                icon={CircleDashed}
                className="mt-3"
                title="Nothing is being collected from this source"
              >
                It makes no request until {source.missing.length === 1 ? 'the item marked “Missing” below is' : 'everything marked “Missing” below is'} provided.
                {!actions.canManage ? ' An administrator can do this in Administration → Retailers.' : ''}
              </Notice>
            ) : null}
          </section>

          {/* configuration checklist */}
          <section>
            <SectionTitle>What this source needs</SectionTitle>
            {config.isError && !config.data ? (
              <ErrorState error={config.error} onRetry={() => void config.refetch()} className="py-6" />
            ) : !config.data ? (
              <LoadingBlock className="min-h-16" />
            ) : (
              <div className="rounded-lg border border-line px-3 py-3">
                {config.data.configured ? <p className="mb-2.5 text-[12.5px] leading-5 text-ink-2">{config.data.explanation}</p> : null}
                <ul className="flex flex-col gap-1.5">
                  {config.data.missing.map((m) => (
                    <li key={m} className="flex items-start gap-2 text-[12.5px] leading-5">
                      <CircleX className="mt-[3px] size-3.5 shrink-0 text-crit" aria-hidden />
                      <span className="font-medium text-ink">Missing: {m}</span>
                    </li>
                  ))}
                  {config.data.warnings.map((w) => (
                    <li key={w} className="flex items-start gap-2 text-[12.5px] leading-5">
                      <TriangleAlert className="mt-[3px] size-3.5 shrink-0 text-warn-ink" aria-hidden />
                      <span className="text-ink-2">{w}</span>
                    </li>
                  ))}
                  {/* unmet requirements are already listed as "Missing" above; these rows confirm what is in place */}
                  {connector && connector.credential.needed !== 'never' ? (
                    config.data.credential_configured ? (
                      <CheckRow ok icon={KeyRound} okText={`${connector.credential.label || 'Credential'} is stored (encrypted, never shown again)`} missingText="" />
                    ) : connector.credential.needed === 'depends' ? (
                      <li className="flex items-start gap-2 text-[12.5px] leading-5 text-ink-3">
                        <KeyRound className="mt-[3px] size-3.5 shrink-0" aria-hidden />
                        No {(connector.credential.label || 'credential').toLowerCase()} is stored — one is only needed if the endpoint is protected
                      </li>
                    ) : null
                  ) : null}
                  {connector?.needs_permission_attestation && config.data.permission_attested ? (
                    <CheckRow ok icon={ShieldCheck} okText="Access permission is attested: an administrator confirmed that the site's terms allow this access" missingText="" />
                  ) : null}
                  {config.data.runnable ? (
                    <CheckRow
                      ok={config.data.active_listings > 0}
                      icon={ListChecks}
                      okText={`${fmtNumber(config.data.active_listings)} active ${config.data.active_listings === 1 ? 'listing' : 'listings'} to collect`}
                      missingText="No active listings — there is nothing to collect yet"
                    />
                  ) : null}
                </ul>
                {config.data.requirements.length ? (
                  <details className="mt-3 border-t border-line pt-2.5">
                    <summary className="text-[12px] font-medium text-ink-2">Requirements of this method</summary>
                    <ul className="mt-1.5 list-disc pl-4 text-[12.5px] leading-5 text-ink-2">
                      {config.data.requirements.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            )}
          </section>

          {/* facts */}
          <section>
            <SectionTitle>Schedule and coverage</SectionTitle>
            <DescriptionList
              columns={2}
              items={[
                {
                  label: 'Frequency',
                  value: (
                    <>
                      <FrequencyLabel frequency={source.frequency} />
                      {source.frequency_inherited ? <span className="font-normal text-ink-3"> (market default)</span> : null}
                    </>
                  ),
                },
                { label: 'Scheduled collection', value: !source.runnable ? 'Not applicable' : source.is_enabled ? 'On' : 'Paused' },
                { label: 'Next run', value: source.runnable && source.status !== 'not_configured' && source.is_enabled ? <MarketTime iso={source.next_run_at} timeZone={source.timezone} /> : 'Not scheduled' },
                { label: 'Last attempt', value: <MarketTime iso={source.last_attempt_at} timeZone={source.timezone} />, hidden: !source.runnable },
                { label: 'Last success', value: source.last_success_at ? <MarketTime iso={source.last_success_at} timeZone={source.timezone} /> : 'No successful run', hidden: !source.runnable },
                { label: 'Failures in a row', value: fmtNumber(source.consecutive_failures), hidden: !source.runnable },
                {
                  label: 'Active listings',
                  value: (
                    <>
                      {fmtNumber(source.listings_active)}
                      {source.listings_unmatched ? (
                        <>
                          {' · '}
                          <Link className="link font-normal" to="/catalogue?tab=matching">
                            {fmtNumber(source.listings_unmatched)} unmatched
                          </Link>
                        </>
                      ) : null}
                    </>
                  ),
                },
                {
                  label: 'Not updated',
                  value:
                    source.listings_stale > 0 ? (
                      <Link className="link" to={`/monitor?stale=true&retailer_id=${source.retailer_id}`}>
                        {fmtNumber(source.listings_stale)} stale{source.listings_never_observed ? ` (${fmtNumber(source.listings_never_observed)} never observed)` : ''}
                      </Link>
                    ) : (
                      'None — all fresh'
                    ),
                  hidden: source.listings_active === 0,
                },
                { label: 'Latest observation', value: source.last_observed_at ? <MarketTime iso={source.last_observed_at} timeZone={source.timezone} /> : 'None yet' },
                {
                  label: 'Last run captured',
                  value: `${fmtNumber(source.listings_captured_last_run)} listings · ${fmtNumber(source.listings_missing_last_run)} not returned · ${fmtNumber(source.listings_failed_last_run)} failed`,
                  hidden: source.listings_captured_last_run === null,
                },
              ]}
            />
          </section>

          {/* dry-run test */}
          {source.runnable ? (
            <section>
              <SectionTitle
                aside={
                  actions.canManage ? (
                    <Button size="sm" icon={PlugZap} loading={test.isPending} onClick={() => runTest(source.retailer_id)}>
                      {test.data ? 'Test again' : simulated ? 'Run a simulated dry run' : 'Test connection'}
                    </Button>
                  ) : undefined
                }
              >
                Connection test
              </SectionTitle>
              {test.isPending ? (
                <LoadingBlock label={simulated ? 'Running a simulated dry run…' : 'Requesting the source — this follows its rate limit and can take a moment…'} className="min-h-20 rounded-lg border border-line" />
              ) : test.data ? (
                <TestResultPanel result={test.data} simulated={!!simulated} />
              ) : test.isError ? (
                <Notice tone="crit" icon={CircleX} title="The connection test could not run">
                  {errorText(test.error)}
                </Notice>
              ) : (
                <p className="text-[12.5px] leading-5 text-ink-3">
                  {!actions.canManage
                    ? 'Testing a connection requires the Administrator role.'
                    : simulated
                      ? 'A dry run of the demo generator: it shows the DEMO values a simulated run would produce. No retailer is contacted and nothing is stored.'
                      : 'A dry run: the source is requested and parsed exactly as in a real run, but nothing is stored and no job is recorded. robots.txt, access permission and rate limits apply as usual.'}
                </p>
              )}
            </section>
          ) : null}

          {/* recent jobs */}
          {source.runnable ? (
            <section>
              <SectionTitle
                aside={
                  <button type="button" className="link text-[12px]" onClick={() => set({ ...cleared(JOB_FILTER_KEYS), tab: 'jobs', j_retailer: String(source.retailer_id), j_page: undefined, source: undefined })}>
                    All jobs of this source
                  </button>
                }
              >
                Recent jobs
              </SectionTitle>
              {jobs.isError && !jobs.data ? (
                <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} className="py-6" />
              ) : !jobs.data ? (
                <LoadingBlock className="min-h-16" />
              ) : jobs.data.rows.length === 0 ? (
                <p className="rounded-lg border border-line px-3 py-3 text-[12.5px] text-ink-3">No job has been recorded for this source — it has never run.</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {jobs.data.rows.map((job) => (
                    <li key={job.id}>
                      <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-sunken" onClick={() => set({ job: String(job.id) })}>
                        <span className="num w-12 shrink-0 text-[12px] text-ink-3">#{job.id}</span>
                        <JobStatusBadge status={job.status} dataClass={job.data_class} />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{job.error_message && job.status !== 'succeeded' ? job.error_message : runSummary(job)}</span>
                        <ViewerTime iso={job.started_at ?? job.created_at} relative className="text-[12px] !text-ink-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <section>
              <SectionTitle>How this source is updated</SectionTitle>
              <p className="text-[12.5px] leading-5 text-ink-2">
                Nothing runs automatically here. Add prices on the{' '}
                <button type="button" className="link" onClick={() => set({ tab: 'imports', source: undefined })}>
                  Imports &amp; manual entry
                </button>{' '}
                tab — as a CSV or Excel file, or one observation at a time.
              </p>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
