/** One retailer as a collection source: honest configuration status, credential, access permission, test, run, listings. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, FlaskConical, Hand, Pause, Pencil, Play, PlugZap, ShieldCheck } from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtDateTime, fmtNumber } from '@/lib/format.ts';
import { ConfirmDialog, Drawer, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, DescriptionList, ErrorState, LoadingBlock, Notice, Segmented } from '@/components/ui/primitives.tsx';
import { DemoBadge, FrequencyLabel, MarketTime, MethodLabel } from '@/components/domain/domain.tsx';
import { AUTOMATED_METHODS } from '@shared/constants.ts';
import type { RetailerRow } from '@shared/api/catalogue.ts';
import type { CollectionJob, CollectionTestResult, SourceConfigStatus } from '@shared/api/collection.ts';
import { RetailerListings } from './RetailerListings.tsx';
import { errorText, PanelTitle, useRefresh } from './shared.tsx';
import { TestResultView } from './TestResult.tsx';

export function RetailerDrawer({ retailerId, initialTab = 'source', onClose, onEdit }: { retailerId: number | null; initialTab?: 'source' | 'listings'; onClose: () => void; onEdit: (retailer: RetailerRow) => void }) {
  const canManage = useCan('sources.manage');
  const canRun = useCan('collection.run');
  const toast = useToast();
  const refresh = useRefresh();
  const [tab, setTab] = useState<'source' | 'listings'>(initialTab);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CollectionTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [startedJob, setStartedJob] = useState<CollectionJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removeCredential, setRemoveCredential] = useState(false);

  useEffect(() => {
    setTab(initialTab);
    setTestResult(null);
    setTestError(null);
    setStartedJob(null);
  }, [retailerId, initialTab]);

  const retailer = useQuery({
    queryKey: ['retailers', 'detail', retailerId],
    queryFn: () => apiGet<RetailerRow>(`/retailers/${retailerId}`),
    enabled: retailerId !== null,
  });
  const status = useQuery({
    queryKey: ['collection', 'retailer-status', retailerId],
    queryFn: () => apiGet<SourceConfigStatus>(`/collection/retailers/${retailerId}/status`),
    enabled: retailerId !== null,
  });
  const r = retailer.data;
  const s = status.data;
  const automated = r ? AUTOMATED_METHODS.includes(r.collection_method) : false;
  const refreshAll = () => refresh(['retailers'], ['collection'], ['reference']);

  async function test() {
    if (!r) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      setTestResult(await apiPost<CollectionTestResult>(`/collection/retailers/${r.id}/test`, { limit: 5 }));
    } catch (err) {
      setTestError(errorText(err));
    } finally {
      setTesting(false);
    }
  }

  async function run() {
    if (!r) return;
    setBusy('run');
    try {
      const result = await apiPost<{ job: CollectionJob }>(`/collection/retailers/${r.id}/run`);
      setStartedJob(result.job);
      toast.success('Collection started', `Job #${result.job.id} for ${r.name}. Follow it in the Data Collection Centre.`);
      await refreshAll();
    } catch (err) {
      toast.error('The collection was not started', errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function setEnabled(enabled: boolean) {
    if (!r) return;
    setBusy('enable');
    try {
      await apiPatch(`/retailers/${r.id}`, { is_enabled: enabled });
      toast.success(enabled ? 'Collection resumed' : 'Collection paused', r.name);
      await refreshAll();
    } catch (err) {
      toast.error('The retailer was not changed', errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteCredential() {
    if (!r) return;
    setBusy('credential');
    try {
      await apiDelete(`/retailers/${r.id}/credential`);
      toast.success('Credential removed', r.name);
      await refreshAll();
    } catch (err) {
      toast.error('The credential was not removed', errorText(err));
    } finally {
      setBusy(null);
      setRemoveCredential(false);
    }
  }

  return (
    <Drawer
      open={retailerId !== null}
      onClose={onClose}
      width="xl"
      title={r ? r.name : 'Retailer'}
      subtitle={
        r ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span>
              {r.market_name} · <MethodLabel method={r.collection_method} />
            </span>
            {r.is_demo ? <DemoBadge /> : null}
            {!r.is_active ? <Badge tone="outline">Inactive</Badge> : !r.is_enabled ? <Badge tone="warn">Paused</Badge> : null}
          </span>
        ) : undefined
      }
    >
      {retailer.isPending ? (
        <LoadingBlock />
      ) : retailer.isError || !r ? (
        <ErrorState error={retailer.error} onRetry={() => void retailer.refetch()} />
      ) : (
        <div>
          <Segmented
            label="Section"
            className="mb-4"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'source', label: 'Source' },
              { value: 'listings', label: `Listings (${fmtNumber(r.listing_count)})` },
            ]}
          />

          {tab === 'listings' ? (
            <RetailerListings retailer={r} />
          ) : (
            <div className="flex flex-col gap-5">
              {/* --- configuration status: what the server says is missing, never a guess --- */}
              {status.isPending ? (
                <LoadingBlock className="min-h-16" />
              ) : status.isError || !s ? (
                <ErrorState error={status.error} onRetry={() => void status.refetch()} className="py-4" />
              ) : r.collection_method === 'simulated' ? (
                <Notice tone="demo" icon={FlaskConical} title="Simulated demo source — not a real integration">
                  {s.explanation} Its runs are always recorded as simulated and never count as real collection.
                </Notice>
              ) : !s.runnable ? (
                <Notice tone="info" icon={Hand} title="People-driven source">
                  {s.explanation}
                </Notice>
              ) : s.configured ? (
                <Notice tone="good" icon={CircleCheck} title="Configured — ready to collect">
                  {s.explanation}
                  {s.warnings.length ? (
                    <ul className="mt-1 list-disc pl-4 text-warn-ink">
                      {s.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  ) : null}
                </Notice>
              ) : (
                <Notice tone="warn" icon={CircleDashed} title="Not configured — no collection is attempted">
                  <p>{s.explanation}</p>
                  <ul className="mt-1 list-disc pl-4">
                    {s.missing.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </Notice>
              )}

              <div className="flex flex-wrap gap-2">
                {canManage ? (
                  <Button icon={Pencil} onClick={() => onEdit(r)}>
                    Edit configuration
                  </Button>
                ) : null}
                {canManage && automated && r.collection_method !== 'simulated' ? (
                  <Button icon={PlugZap} onClick={() => void test()} loading={testing}>
                    Test connection
                  </Button>
                ) : null}
                {canRun && automated ? (
                  <Button icon={Play} onClick={() => void run()} loading={busy === 'run'} disabled={!r.is_active}>
                    Run now
                  </Button>
                ) : null}
                {canManage && automated ? (
                  <Button icon={r.is_enabled ? Pause : Play} onClick={() => void setEnabled(!r.is_enabled)} loading={busy === 'enable'}>
                    {r.is_enabled ? 'Pause collection' : 'Resume collection'}
                  </Button>
                ) : null}
              </div>

              {startedJob ? (
                <Notice tone="info" title={`Job #${startedJob.id} started`}>
                  The run happens in the background{startedJob.data_class === 'simulated' ? ' and is a simulated demo run' : ''}. Its outcome — success, failure or “not
                  configured” — appears in the{' '}
                  <Link to="/collection" className="link">
                    Data Collection Centre
                  </Link>
                  .
                </Notice>
              ) : null}
              {testing ? <LoadingBlock label="Contacting the source…" className="min-h-16" /> : null}
              {testError ? (
                <Notice tone="crit" title="The test could not be run">
                  {testError}
                </Notice>
              ) : null}
              {testResult ? (
                <div>
                  <PanelTitle>Connection test (dry run)</PanelTitle>
                  <TestResultView result={testResult} />
                </div>
              ) : null}

              <div>
                <PanelTitle>Source</PanelTitle>
                <DescriptionList
                  columns={2}
                  items={[
                    { label: 'Market', value: `${r.market_name} (${r.market_code})` },
                    { label: 'Currency', value: r.currency_code },
                    { label: 'Website', value: r.website ? <a href={r.website} target="_blank" rel="noreferrer noopener" className="link break-all">{r.website}</a> : '—' },
                    { label: 'Method', value: <MethodLabel method={r.collection_method} /> },
                    {
                      label: 'Frequency',
                      value: (
                        <span>
                          <FrequencyLabel frequency={r.effective_frequency} />
                          {r.collection_frequency === null ? <span className="text-ink-3"> (market default)</span> : null}
                        </span>
                      ),
                    },
                    { label: 'Delay between requests', value: `${fmtNumber(r.rate_limit_ms)} ms` },
                    { label: 'Last attempt', value: <MarketTime iso={r.last_attempt_at} timeZone={r.timezone} /> },
                    { label: 'Last success', value: <MarketTime iso={r.last_success_at} timeZone={r.timezone} /> },
                    { label: 'Next scheduled run', value: r.next_run_at ? <MarketTime iso={r.next_run_at} timeZone={r.timezone} /> : automated ? 'Not scheduled' : 'Not applicable' },
                    { label: 'Consecutive failures', value: fmtNumber(r.consecutive_failures) },
                    { label: 'Listings', value: `${fmtNumber(r.active_listing_count)} active of ${fmtNumber(r.listing_count)} · ${fmtNumber(r.unmatched_listing_count)} unmatched` },
                    { label: 'Observations on record', value: fmtNumber(r.observation_count) },
                    { label: 'Last observation', value: <MarketTime iso={r.last_observed_at} timeZone={r.timezone} /> },
                    { label: 'Notes', value: r.notes ?? '—', hidden: !r.notes },
                  ]}
                />
              </div>

              {r.collection_method !== 'simulated' && automated ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-line px-3.5 py-3">
                    <PanelTitle>Credential</PanelTitle>
                    <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                      <Badge tone={r.credential.configured ? 'good' : 'outline'}>{r.credential.configured ? `Stored ${r.credential.hint ?? ''}`.trim() : 'None stored'}</Badge>
                      {r.credential.updated_at ? <span className="text-ink-3">updated {fmtDateTime(r.credential.updated_at)}</span> : null}
                    </div>
                    <p className="mt-2 text-[12px] leading-4 text-ink-3">Encrypted at rest and write-only: the value is never shown. Set or replace it under “Edit configuration”.</p>
                    {canManage && r.credential.configured ? (
                      <Button size="sm" variant="danger" className="mt-2" onClick={() => setRemoveCredential(true)}>
                        Remove credential
                      </Button>
                    ) : null}
                  </div>
                  <div className="rounded-lg border border-line px-3.5 py-3">
                    <PanelTitle>Access permission</PanelTitle>
                    {r.permission_attested ? (
                      <>
                        <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                          <ShieldCheck className="size-3.5 text-good-ink" aria-hidden /> Attested
                        </div>
                        <p className="mt-1 text-[12px] leading-4 text-ink-3">
                          By {r.permission_attested_by_name ?? 'an administrator'} on {fmtDateTime(r.permission_attested_at)}: “{r.permission_note}”
                        </p>
                      </>
                    ) : (
                      <>
                        <Badge tone={r.collection_method === 'web_extraction' ? 'warn' : 'outline'}>Not attested</Badge>
                        <p className="mt-2 text-[12px] leading-4 text-ink-3">
                          {r.collection_method === 'web_extraction'
                            ? 'Required before website extraction may run. Attest it under “Edit configuration”.'
                            : 'Only required for website extraction.'}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={removeCredential}
        onClose={() => setRemoveCredential(false)}
        onConfirm={() => void deleteCredential()}
        title="Remove the stored credential?"
        confirmLabel="Remove credential"
        danger
        loading={busy === 'credential'}
      >
        <p>If this source needs the credential, it becomes “not configured” and no collection is attempted until a new one is stored.</p>
      </ConfirmDialog>
    </Drawer>
  );
}
