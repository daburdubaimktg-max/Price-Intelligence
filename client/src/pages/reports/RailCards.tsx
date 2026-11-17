/** Side cards of the Reports screen: recently generated reports and the raw-data exports that already exist. */
import { useState } from 'react';
import { Link } from 'react-router';
import { Database, Download, FileSpreadsheet, History } from 'lucide-react';
import { download } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtDateTimeShort, fmtNumber } from '@/lib/format.ts';
import { useApiQuery } from '@/lib/hooks.ts';
import { Button, Card, CardHeader, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/primitives.tsx';
import { useToast } from '@/components/ui/overlays.tsx';
import type { ReportRun } from '@shared/api/reports.ts';

export function RecentReports({ onOpen, activeRunId }: { onOpen: (run: ReportRun) => void; activeRunId: number | null }) {
  const runs = useApiQuery<{ rows: ReportRun[] }>(['reports', 'runs'], '/reports/runs');
  const rows = runs.data?.rows;
  return (
    <Card>
      <CardHeader title="Recent reports" subtitle="Select one to generate it again with the same period and filters." />
      {runs.isError && !rows ? (
        <ErrorState error={runs.error} onRetry={() => void runs.refetch()} className="py-6" />
      ) : !rows ? (
        <LoadingBlock className="min-h-24" />
      ) : rows.length === 0 ? (
        <EmptyState icon={History} title="No reports generated yet" description="Reports you generate are listed here so they can be repeated." className="py-7" />
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto">
          {rows.map((run) => {
            const [title, ...rest] = run.title.split(' — ');
            return (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onOpen(run)}
                  className={`block w-full px-4 py-2.5 text-left transition-colors hover:bg-sunken ${run.id === activeRunId ? 'bg-sunken' : ''}`}
                  aria-current={run.id === activeRunId ? 'true' : undefined}
                >
                  <span className="block truncate text-[13px] leading-5 font-medium text-ink">{title}</span>
                  {rest.length ? <span className="block truncate text-[12px] leading-4 text-ink-2">{rest.join(' — ')}</span> : null}
                  <span className="num mt-0.5 block truncate text-[11.5px] leading-4 text-ink-3">
                    {fmtDateTimeShort(run.generated_at)}
                    {run.generated_by ? ` · ${run.generated_by}` : ''} · {fmtNumber(run.row_count)} {run.row_count === 1 ? 'row' : 'rows'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function DataExports() {
  const toast = useToast();
  const canDatabase = useCan('database.export');
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, path: string, query: Record<string, string> | undefined, fallbackName: string, done: string) {
    setBusy(key);
    try {
      await download(path, query, fallbackName);
      toast.success('Download ready', done);
    } catch (err) {
      toast.fromError(err, 'Download failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader title="Data exports" subtitle="The records the reports are computed from." />
      <div className="divide-y divide-line">
        <div className="px-4 py-3">
          <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <Download className="size-3.5 text-ink-3" aria-hidden /> Price observations
          </p>
          <p className="mt-1 text-[12px] leading-[18px] text-ink-3">
            Every stored observation with its timestamp, source and confidence. To export a selection, choose the filters in the{' '}
            <Link to="/history" className="link">
              Historical Price Explorer
            </Link>{' '}
            and export from there.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              loading={busy === 'obs-csv'}
              disabled={busy !== null && busy !== 'obs-csv'}
              onClick={() => void run('obs-csv', '/observations/export', { format: 'csv' }, 'price-observations.csv', 'All price observations as CSV.')}
            >
              All observations · CSV
            </Button>
            <Button
              size="sm"
              loading={busy === 'obs-xlsx'}
              disabled={busy !== null && busy !== 'obs-xlsx'}
              onClick={() => void run('obs-xlsx', '/observations/export', { format: 'xlsx' }, 'price-observations.xlsx', 'All price observations as an Excel workbook.')}
            >
              Excel
            </Button>
          </div>
        </div>
        <div className="px-4 py-3">
          <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <Database className="size-3.5 text-ink-3" aria-hidden /> Full database workbook
          </p>
          <p className="mt-1 text-[12px] leading-[18px] text-ink-3">
            The whole database — catalogue, retailers, listings, every observation, promotions and alerts — as one Excel workbook. A copy that is kept up to date on the server is under{' '}
            <Link to="/admin?tab=database" className="link">
              Administration → Database (Excel)
            </Link>
            .
          </p>
          {canDatabase ? (
            <Button
              size="sm"
              icon={FileSpreadsheet}
              className="mt-2"
              loading={busy === 'database'}
              disabled={busy !== null && busy !== 'database'}
              onClick={() => void run('database', '/database/export.xlsx', undefined, 'price-intelligence-database.xlsx', 'The full database as an Excel workbook.')}
            >
              Download workbook
            </Button>
          ) : (
            <p className="mt-2 text-[12px] leading-[18px] text-ink-2">Downloading the full database requires the Analyst or Administrator role.</p>
          )}
        </div>
      </div>
    </Card>
  );
}
