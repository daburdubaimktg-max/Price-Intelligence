/**
 * Reports — choose one of the six report types, set its filters, generate it, read it on screen and take
 * it away as Excel, CSV or print. The type and filters live in the URL, so a report can be bookmarked or
 * shared; opening such a link generates the report again from the records stored at that moment.
 */
import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, RefreshCw } from 'lucide-react';
import { Page } from '@/app/AppShell.tsx';
import { apiPost } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { useApiQuery } from '@/lib/hooks.ts';
import { Button, Card, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader } from '@/components/ui/primitives.tsx';
import type { ReportDefinition, ReportResult } from '@shared/api/reports.ts';
import { PARAM_LABELS, requestKey, useReportForm, type ReportRequest } from './params.ts';
import { DataExports, RecentReports } from './RailCards.tsx';
import { ReportParams } from './ReportParams.tsx';
import { ReportPicker } from './ReportPicker.tsx';
import { ReportView } from './ReportView.tsx';

export default function ReportsPage() {
  const canGenerate = useCan('reports.generate');
  const client = useQueryClient();
  const types = useApiQuery<{ rows: ReportDefinition[] }>(['reports', 'types'], '/reports/types', undefined, { staleTime: 5 * 60_000 });
  const form = useReportForm(types.data?.rows);
  const def = form.definition;

  /** The request whose report is on screen (or being generated). Changing the form does not change it. */
  const [applied, setApplied] = useState<ReportRequest | null>(null);
  const appliedKey = requestKey(applied);
  const report = useQuery({
    queryKey: ['reports', 'generate', appliedKey],
    queryFn: () => apiPost<ReportResult>('/reports/generate', applied),
    enabled: !!applied && canGenerate,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });

  // A link that carries run=1 (a bookmarked or shared report) generates on opening — once.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !form.ready) return;
    opened.current = true;
    if (form.autoRun && form.request && canGenerate) setApplied(form.request);
  }, [form.ready, form.autoRun, form.request, canGenerate]);

  // every generation is recorded server-side; keep the "recent reports" list in step
  useEffect(() => {
    if (report.dataUpdatedAt) void client.invalidateQueries({ queryKey: ['reports', 'runs'] });
  }, [report.dataUpdatedAt, client]);

  function generate() {
    if (!form.request) return;
    form.markRun();
    if (requestKey(form.request) === appliedKey) void report.refetch();
    else setApplied(form.request);
  }

  const forThisType = !!applied && !!def && applied.type === def.type;
  const shown = forThisType && report.data && report.data.type === applied.type ? report.data : null;
  const upToDate = !!shown && !report.isPlaceholderData;
  const generating = forThisType && report.isFetching;
  // the form was edited after the report on screen was generated
  const edited = forThisType && upToDate && !report.isFetching && requestKey(form.request) !== appliedKey;

  return (
    <Page>
      <div className="no-print">
        <PageHeader
          title="Reports"
          description="Six standard reports, each computed from the stored price observations at the moment it is generated. Read it here, then download it as Excel or CSV, or print it."
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <div className="no-print flex min-w-0 flex-col gap-4">
          {types.isError && !types.data ? (
            <Card>
              <ErrorState error={types.error} onRetry={() => void types.refetch()} />
            </Card>
          ) : (
            <>
              <ReportPicker definitions={types.data?.rows} value={def?.type ?? null} onChange={form.setType} />
              {def ? <ReportParams form={form} canGenerate={canGenerate} generating={generating} onGenerate={generate} /> : null}
            </>
          )}
        </div>

        <div className="min-w-0 xl:col-span-2 xl:row-start-2">
          {!def ? null : !forThisType ? (
            <Card className="no-print">
              <EmptyState
                icon={FileText}
                title={`${def.title}: not generated yet`}
                description={
                  !canGenerate
                    ? 'Your role cannot generate reports.'
                    : form.missing.length
                      ? `Choose a ${form.missing.map((k) => PARAM_LABELS[k].toLowerCase()).join(' and a ')} above, then generate the report.`
                      : 'Set the period and filters above, then generate the report. It is built from the observations stored at that moment.'
                }
                action={
                  canGenerate && form.request ? (
                    <Button variant="primary" icon={FileText} onClick={generate}>
                      Generate report
                    </Button>
                  ) : undefined
                }
                className="py-12"
              />
            </Card>
          ) : report.isError && !shown ? (
            <Card className="no-print">
              <ErrorState error={report.error} onRetry={() => void report.refetch()} />
            </Card>
          ) : !shown ? (
            <Card className="no-print">
              <LoadingBlock label={`Generating the ${def.title.toLowerCase()} from stored observations…`} className="min-h-64" />
            </Card>
          ) : (
            <>
              {report.isError ? (
                <Notice tone="crit" className="no-print mb-3" title="The report could not be regenerated" action={<Button size="sm" onClick={() => void report.refetch()}>Try again</Button>}>
                  {report.error instanceof Error ? report.error.message : 'Something went wrong.'} The report below is the previous result.
                </Notice>
              ) : edited ? (
                <Notice
                  tone="info"
                  className="no-print mb-3"
                  action={
                    form.request ? (
                      <Button size="sm" variant="primary" icon={RefreshCw} onClick={generate}>
                        Generate again
                      </Button>
                    ) : undefined
                  }
                >
                  The period or filters above have changed since this report was generated. The report and its downloads still reflect the earlier selection.
                </Notice>
              ) : null}
              <ReportView report={shown} request={upToDate ? applied : null} refreshing={report.isFetching} />
            </>
          )}
        </div>

        <aside className="no-print flex min-w-0 flex-col gap-4 xl:col-start-2 xl:row-start-1" aria-label="Recent reports and data exports">
          <RecentReports
            activeRunId={upToDate ? (shown?.run_id ?? null) : null}
            onOpen={(run) => {
              if (!canGenerate) return;
              setApplied(form.loadRun(run));
            }}
          />
          <DataExports />
        </aside>
      </div>
    </Page>
  );
}
