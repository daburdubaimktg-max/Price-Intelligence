/**
 * "The database on an Excel file": download the whole database as one workbook, and the always-current
 * Excel mirror kept on the server. Also where the illustrative DEMO dataset is removed or loaded.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Download, FileSpreadsheet, FlaskConical, RefreshCw, Trash2 } from 'lucide-react';
import { apiGet, apiPost, download } from '@/lib/api.ts';
import { useAuth } from '@/lib/auth.tsx';
import { fmtBytes, fmtNumber, fmtRelative, titleCase } from '@/lib/format.ts';
import { ConfirmDialog, useToast } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, DescriptionList, ErrorState, LoadingBlock, Notice } from '@/components/ui/primitives.tsx';
import { MarketTime } from '@/components/domain/domain.tsx';
import type { DemoActionResult, SystemInfo } from '@shared/api/admin.ts';
import type { CollectionHealth } from '@shared/api/collection.ts';
import type { DatabaseMirrorStatus } from '@shared/api/observations.ts';
import { errorText, PathLine } from './shared.tsx';

function CountsTable({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (!entries.length) return <p className="text-[12.5px] text-ink-3">Nothing was changed.</p>;
  return (
    <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
      {entries.map(([name, n]) => (
        <li key={name} className="flex justify-between gap-2">
          <span className="text-ink-2">{titleCase(name)}</span>
          <span className="num font-medium text-ink">{fmtNumber(n)}</span>
        </li>
      ))}
    </ul>
  );
}

export function DatabaseTab() {
  const { app, can, user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const toast = useToast();
  const client = useQueryClient();
  const canDemo = can('admin.demo');
  const canSystem = can('admin.settings');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [demoBusy, setDemoBusy] = useState<'purge' | 'seed' | null>(null);
  const [demoResult, setDemoResult] = useState<DemoActionResult | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);

  const mirror = useQuery({
    queryKey: ['database', 'mirror'],
    queryFn: () => apiGet<DatabaseMirrorStatus>('/database/mirror'),
    refetchInterval: (query) => (query.state.data?.generating ? 3000 : 60_000),
  });
  const system = useQuery({ queryKey: ['admin', 'system'], queryFn: () => apiGet<SystemInfo>('/admin/system'), enabled: canSystem });
  // The mirror is refreshed by the server's scheduler; its status endpoint does not say whether that scheduler runs.
  const health = useQuery({
    queryKey: ['collection', 'health', { days: 1 }],
    queryFn: () => apiGet<CollectionHealth>('/collection/health', { days: 1 }),
    staleTime: 5 * 60_000,
  });
  const schedulerOff = health.data ? !health.data.scheduler.enabled : false;

  async function downloadFile(kind: 'export' | 'mirror') {
    setDownloading(kind);
    try {
      if (kind === 'export') await download('/database/export.xlsx', undefined, 'price-intelligence-database.xlsx');
      else await download('/database/mirror/download', undefined, 'price-intelligence-database.xlsx');
    } catch (err) {
      toast.error('The workbook could not be downloaded', errorText(err));
    } finally {
      setDownloading(null);
    }
  }

  async function refreshMirror() {
    setRefreshing(true);
    try {
      const status = await apiPost<DatabaseMirrorStatus>('/database/mirror/refresh');
      client.setQueryData(['database', 'mirror'], status);
      toast.success('Excel mirror refreshed', `${fmtNumber(status.observation_rows)} price observations · ${fmtBytes(status.size_bytes)}`);
    } catch (err) {
      toast.error('The mirror was not refreshed', errorText(err));
      void mirror.refetch();
    } finally {
      setRefreshing(false);
    }
  }

  async function demoAction(action: 'purge' | 'seed') {
    setDemoBusy(action);
    setDemoError(null);
    setDemoResult(null);
    try {
      const result = await apiPost<DemoActionResult>(`/admin/demo/${action}`);
      setDemoResult(result);
      toast.success(action === 'purge' ? 'Demo data removed' : 'Demo data loaded');
      // Every screen depends on this, so everything is reloaded.
      await client.invalidateQueries();
    } catch (err) {
      setDemoError(errorText(err));
    } finally {
      setDemoBusy(null);
      setConfirmPurge(false);
    }
  }

  const m = mirror.data;
  const demoPresent = system.data?.demo_data_present ?? app?.demo_data_present ?? false;
  const demoRows = system.data ? Object.entries(system.data.demo_rows).filter(([, n]) => n > 0) : [];

  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Card className="xl:col-span-2">
        <CardHeader title="Your database as an Excel file" subtitle="Everything that is stored, in one workbook — one sheet per table." />
        <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="text-[13px] leading-[1.55] text-ink-2">
            <p>
              The <strong className="font-semibold text-ink">system of record is the relational database</strong>. Its price ledger is append-only: an observation can be added but
              never changed or deleted, duplicates are rejected, and collection keeps writing while people work. An Excel file cannot guarantee those things, so Excel is offered
              as an <strong className="font-semibold text-ink">always-available copy</strong> rather than as the storage itself.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                One sheet per table — products, retailers, listings, price observations with their source and DEMO flag, promotions, alerts, exchange rates and more — plus a
                README and a data dictionary.
              </li>
              <li>
                {isAdmin
                  ? 'Because you are an administrator, your download also contains the Users and Audit log sheets. The mirror file on the server never does.'
                  : 'The Users and Audit log sheets are only included when an administrator downloads the workbook.'}
              </li>
              <li>Passwords, sessions, integration credentials and connector settings are never included.</li>
              <li>Editing the file does not change the database. To bring data in, use the CSV / Excel import (prices: Data Collection Centre; products: Product Catalogue).</li>
            </ul>
          </div>
          <div className="flex flex-col gap-2 self-start rounded-lg border border-line bg-sunken px-4 py-4">
            <Button variant="primary" size="lg" icon={Download} onClick={() => void downloadFile('export')} loading={downloading === 'export'}>
              Download full database (.xlsx)
            </Button>
            <p className="text-[12px] leading-4 text-ink-3">
              Generated now from the live database, so it is always current. Large ledgers can take a little while; sheets beyond one million rows are split automatically.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Excel mirror on the server"
          subtitle="A workbook file kept on the server, regenerated when the data has changed."
          actions={
            m ? (
              m.generating || refreshing ? (
                <Badge tone="accent">Generating…</Badge>
              ) : !m.exists ? (
                <Badge tone="warn">Not generated yet</Badge>
              ) : m.stale ? (
                <Badge tone="warn">Behind the database</Badge>
              ) : (
                <Badge tone="good">Up to date</Badge>
              )
            ) : undefined
          }
        />
        <div className="px-4 py-3.5">
          {mirror.isPending ? (
            <LoadingBlock />
          ) : mirror.isError || !m ? (
            <ErrorState error={mirror.error} onRetry={() => void mirror.refetch()} />
          ) : (
            <>
              {!m.enabled ? (
                <Notice tone="warn" className="mb-3">
                  The automatic mirror is switched off on this server (PIOS_EXCEL_MIRROR=off). You can still generate it on demand.
                </Notice>
              ) : null}
              {m.enabled && schedulerOff ? (
                <Notice tone="warn" className="mb-3" title="Not refreshed automatically on this server">
                  The server’s scheduler is switched off (PIOS_SCHEDULER=off), and it is the scheduler that keeps the mirror current. The file only changes when someone presses
                  “Refresh now”.
                </Notice>
              ) : null}
              {m.last_error ? (
                <Notice tone="crit" className="mb-3" title="The last automatic refresh failed">
                  {m.last_error}
                  {m.last_error_at ? ` (${fmtRelative(m.last_error_at)})` : ''}
                </Notice>
              ) : null}
              <div className="mb-2.5">
                <PathLine label="File on the server" path={m.path} />
              </div>
              <DescriptionList
                items={[
                  { label: 'Generated', value: m.generated_at ? <span><MarketTime iso={m.generated_at} /> · {fmtRelative(m.generated_at)}</span> : 'Not yet' },
                  { label: 'Size', value: fmtBytes(m.size_bytes) },
                  { label: 'Price observations in the file', value: m.observation_rows === null ? '—' : fmtNumber(m.observation_rows) },
                  { label: 'Sheets', value: m.sheets.length ? fmtNumber(m.sheets.length) : '—' },
                  {
                    label: 'Compared with the database',
                    value: !m.exists ? 'No file yet' : m.stale ? 'Data changed since this file was generated' : 'Identical to the current data',
                  },
                  {
                    label: 'Automatic refresh',
                    value: !m.enabled ? 'Off' : schedulerOff ? 'Not running (scheduler off)' : `When data changed, at most every ${fmtNumber(m.interval_minutes)} minutes`,
                  },
                ]}
              />
              <div className="mt-3.5 flex flex-wrap gap-2">
                <Button icon={RefreshCw} onClick={() => void refreshMirror()} loading={refreshing || m.generating}>
                  Refresh now
                </Button>
                <Button icon={FileSpreadsheet} onClick={() => void downloadFile('mirror')} loading={downloading === 'mirror'} disabled={!m.exists}>
                  Download mirror
                </Button>
              </div>
              <p className="mt-2 text-[12px] leading-4 text-ink-3">
                The file is replaced atomically, so it can be opened or copied at any time — for example from the mounted data folder of the server.
              </p>
              {m.sheets.length ? (
                <details className="mt-3">
                  <summary className="text-[12.5px] font-medium text-ink-2">Sheets in the mirror</summary>
                  <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-[12.5px] sm:grid-cols-2">
                    {m.sheets.map((sheet) => (
                      <li key={sheet.name} className="flex justify-between gap-2 border-b border-line py-0.5">
                        <span className="truncate text-ink-2">{sheet.name}</span>
                        <span className="num text-ink-3">{fmtNumber(sheet.rows)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Demo data"
          subtitle="The illustrative dataset that makes the product usable before real data exists."
          actions={demoPresent ? <Badge tone="demo" icon={FlaskConical}>Loaded</Badge> : <Badge tone="outline">Not loaded</Badge>}
        />
        <div className="px-4 py-3.5 text-[13px] leading-[1.55] text-ink-2">
          <p>
            Demo brands, products, retailers, listings and several months of <strong className="font-semibold text-ink">fictional</strong> prices. Nothing in it was collected
            from a retailer; every demo record carries a DEMO marker, and its collection runs are recorded as simulated.
          </p>
          <DescriptionList
            className="mt-3"
            items={[
              { label: 'Demo observations', value: fmtNumber(app?.demo_observations ?? 0) },
              { label: 'Real observations', value: fmtNumber(app?.real_observations ?? 0) },
            ]}
          />
          {demoRows.length ? (
            <details className="mt-2">
              <summary className="text-[12.5px] font-medium text-ink-2">Demo records by table</summary>
              <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-[12.5px] sm:grid-cols-2">
                {demoRows.map(([name, n]) => (
                  <li key={name} className="flex justify-between gap-2 border-b border-line py-0.5">
                    <span className="mono text-ink-2">{name}</span>
                    <span className="num text-ink-3">{fmtNumber(n)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {demoError ? (
            <Notice tone="crit" className="mt-3" title="The demo dataset was not changed">
              {demoError}
            </Notice>
          ) : null}
          {demoResult ? (
            <Notice tone="good" className="mt-3" title={demoResult.action === 'purge' ? 'Demo data removed — real data was not touched' : 'Demo data loaded'}>
              <CountsTable counts={demoResult.counts} />
            </Notice>
          ) : null}

          {canDemo ? (
            <div className="mt-3.5 flex flex-wrap gap-2">
              {demoPresent ? (
                <Button variant="danger" icon={Trash2} onClick={() => setConfirmPurge(true)} loading={demoBusy === 'purge'}>
                  Remove demo data
                </Button>
              ) : (
                <Button icon={Database} onClick={() => void demoAction('seed')} loading={demoBusy === 'seed'}>
                  Load demo data
                </Button>
              )}
            </div>
          ) : (
            <p className="mt-3 text-[12px] text-ink-3">Only administrators can remove or load the demo dataset.</p>
          )}
          <p className="mt-2 text-[12px] leading-4 text-ink-3">
            To replace demo data with real data: add your markets’ retailers and listings, import or collect prices, then remove the demo dataset here.
          </p>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmPurge}
        onClose={() => setConfirmPurge(false)}
        onConfirm={() => void demoAction('purge')}
        title="Remove all demo data?"
        confirmLabel="Remove demo data"
        danger
        loading={demoBusy === 'purge'}
      >
        <p>
          This permanently deletes every record of the demo dataset — demo brands, products, retailers, listings, {fmtNumber(app?.demo_observations ?? 0)} demo observations,
          their promotions, alerts, collection runs and the illustrative exchange rates.
        </p>
        <p className="mt-2">
          <strong className="font-semibold text-ink">Real data is never touched.</strong> Markets, alert rules, users and settings stay. Real listings that were matched to a
          demo product become unmatched, and a demo retailer that already has real listings is kept as a manual source. You can load the demo dataset again later.
        </p>
      </ConfirmDialog>
    </div>
  );
}
