/**
 * The generated report as one printable sheet: header (what, when, for which scope), headline figures,
 * numbered sections (chart and/or table) and the notes and exchange rates the figures rest on.
 * Downloads re-run the same request on the server, so a file always matches what is on screen.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { Download, FileSpreadsheet, FileText, Printer } from 'lucide-react';
import { download } from '@/lib/api.ts';
import { fmtDate, fmtDateTime, fmtNumber } from '@/lib/format.ts';
import { diffDays } from '@/lib/hooks.ts';
import { Button, cn } from '@/components/ui/primitives.tsx';
import { useToast } from '@/components/ui/overlays.tsx';
import { useSize } from '@/components/charts/kit.tsx';
import { DemoNotice, FxNote } from '@/components/domain/domain.tsx';
import type { ReportResult, ReportSection } from '@shared/api/reports.ts';
import type { ReportRequest } from './params.ts';
import { ReportChartView } from './ReportChart.tsx';
import { ReportTableView } from './ReportTable.tsx';

/** Printable width of an A4 landscape page with 12 mm margins, in CSS pixels. */
const PRINT_WIDTH = 1030;

/**
 * Rules for the report sheet only: denser tables whose headers may wrap, and print. The sheet is printed at
 * its on-screen layout, scaled down to the page (`zoom`), so charts keep the exact geometry they were drawn with.
 */
const SHEET_CSS = `
.report-sheet table.grid-table { font-size: 12.5px; }
.report-sheet table.grid-table thead th { white-space: normal; vertical-align: bottom; padding: 7px 6px; font-size: 10.5px; line-height: 14px; letter-spacing: 0.05em; }
.report-sheet table.grid-table tbody td { padding: 6px 6px; }
.report-sheet table.grid-table tr > :first-child { padding-left: 12px; }
.report-sheet table.grid-table tr > :last-child { padding-right: 12px; }
@media print {
  @page { size: A4 landscape; margin: 12mm; }
  html, body { background: #fff !important; }
  main { padding: 0 !important; max-width: none !important; }
  .report-sheet { zoom: var(--report-print-zoom, 1); border: 0 !important; border-radius: 0 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .report-sheet .table-wrap { overflow: visible !important; }
  .report-sheet table.grid-table thead { display: table-header-group; }
  .report-sheet table.grid-table thead th { position: static; white-space: normal; }
  .report-sheet table.grid-table tr { break-inside: avoid; }
  .report-sheet .report-section-head { break-after: avoid; }
  .report-sheet figure { break-inside: avoid; }
}
`;

function SectionView({
  section, index, report, printing, exporting, canExport, onCsv,
}: {
  section: ReportSection;
  index: number;
  report: ReportResult;
  printing: boolean;
  exporting: boolean;
  canExport: boolean;
  onCsv: () => void;
}) {
  const rows = section.table?.rows.length ?? 0;
  return (
    <section className="border-b border-line px-4 py-5 last:border-b-0 sm:px-8" aria-label={section.title}>
      <div className="report-section-head mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="flex items-baseline gap-2.5 text-[15px] leading-6 font-semibold text-ink">
            <span className="num text-[12px] font-medium text-ink-4" aria-hidden>
              {String(index).padStart(2, '0')}
            </span>
            {section.title}
          </h3>
          {section.description ? <p className="mt-0.5 max-w-4xl text-[12.5px] leading-5 text-ink-3">{section.description}</p> : null}
        </div>
        {section.table ? (
          <div className="no-print flex shrink-0 items-center gap-2 text-[12px] text-ink-3">
            <span className="num">
              {fmtNumber(rows)} {rows === 1 ? 'row' : 'rows'}
            </span>
            {canExport ? (
              <Button size="sm" icon={Download} loading={exporting} onClick={onCsv} title={`Download “${section.title}” as CSV`}>
                CSV
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        {section.chart ? <ReportChartView chart={section.chart} scope={`report-${report.type}-${section.id}`} period={report.period} /> : null}
        {section.table ? <ReportTableView table={section.table} printing={printing} label={section.title} /> : null}
        {!section.chart && !section.table ? (
          <p className="rounded-[10px] border border-dashed border-line-strong px-4 py-5 text-center text-[12.5px] text-ink-3">
            Not enough stored observations in this period to draw this section.
          </p>
        ) : null}
        {section.notes?.length ? (
          <ul className="flex flex-col gap-1 text-[12px] leading-5 text-ink-3">
            {section.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function ReportView({
  report,
  request,
  refreshing,
}: {
  report: ReportResult;
  /** The request that produced `report`; null while a different one is loading (downloads are then disabled). */
  request: ReportRequest | null;
  refreshing: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [sheetRef, size] = useSize<HTMLElement>();

  // Printing (button or the browser's own Print command) shows every table in full, not one page of it.
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);

  async function exportFile(format: 'xlsx' | 'csv', section?: ReportSection) {
    if (!request) return;
    setBusy(section ? `section:${section.id}` : format);
    try {
      await download('/reports/export', { ...request, format, section: section?.id }, `${report.type.replace(/_/g, '-')}.${format}`);
      toast.success('Download ready', section ? `“${section.title}” as CSV.` : `${report.title} as ${format === 'xlsx' ? 'an Excel workbook' : 'CSV'}.`);
    } catch (err) {
      toast.fromError(err, 'Download failed');
    } finally {
      setBusy(null);
    }
  }

  const days = diffDays(report.period.from, report.period.to) + 1;
  const zoom = size.width > PRINT_WIDTH ? Number((PRINT_WIDTH / size.width).toFixed(3)) : 1;
  const canExport = !!request;

  return (
    <article
      ref={sheetRef}
      className={cn('report-sheet overflow-hidden rounded-[10px] border border-line bg-surface transition-opacity', refreshing && 'opacity-60')}
      style={{ '--report-print-zoom': zoom } as CSSProperties}
      aria-label={`${report.title} — ${report.subtitle}`}
      aria-busy={refreshing}
    >
      <style>{SHEET_CSS}</style>

      <header className="border-b border-line px-4 py-5 sm:px-8 sm:py-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="eyebrow">{report.organisation ? `${report.organisation} · ` : ''}Pricing report</div>
            <h2 className="mt-1 text-[22px] leading-7 font-semibold tracking-[-0.01em] text-ink">{report.title}</h2>
            <p className="mt-1 text-[13.5px] leading-5 text-ink-2">{report.subtitle}</p>
          </div>
          <div className="no-print flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={FileSpreadsheet} loading={busy === 'xlsx'} disabled={!canExport || (busy !== null && busy !== 'xlsx')} onClick={() => void exportFile('xlsx')}>
              Download Excel
            </Button>
            <Button icon={FileText} loading={busy === 'csv'} disabled={!canExport || (busy !== null && busy !== 'csv')} onClick={() => void exportFile('csv')}>
              Download CSV
            </Button>
            <Button icon={Printer} onClick={() => window.print()}>
              Print
            </Button>
          </div>
        </div>
        <dl className="mt-5 grid gap-x-10 gap-y-3 text-[12.5px] leading-5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
          <div>
            <dt className="eyebrow">Period</dt>
            <dd className="mt-0.5 text-ink">
              <span className="num">
                {fmtDate(report.period.from)} – {fmtDate(report.period.to)}
              </span>
              <span className="num text-ink-3">
                {' '}
                · {days} {days === 1 ? 'day' : 'days'}
              </span>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="eyebrow">Scope</dt>
            <dd className="mt-0.5 text-ink">
              {report.scope.map((line, i) => (
                <div key={i} className="break-words">
                  {line}
                </div>
              ))}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Generated</dt>
            <dd className="mt-0.5 text-ink">
              <span className="num">{fmtDateTime(report.generated_at, 'UTC')} UTC</span>
              {report.generated_by ? <span className="text-ink-3"> · {report.generated_by}</span> : null}
            </dd>
          </div>
        </dl>
        <DemoNotice demo={report.demo} className="mt-4" />
      </header>

      {report.summary.length ? (
        <div className="overflow-hidden border-b border-line" aria-label="Headline figures">
          {/* up to six figures share one row; more are split over two balanced rows */}
          <div className="-mr-px -mb-px flex flex-wrap" style={{ '--figures-per-row': report.summary.length <= 6 ? report.summary.length : Math.ceil(report.summary.length / 2) } as CSSProperties}>
            {report.summary.map((item, i) => (
              <div key={i} className="min-w-0 grow basis-1/2 border-r border-b border-line px-4 py-3 sm:basis-1/3 sm:px-5 xl:basis-[calc(100%/var(--figures-per-row))]">
                <div className="text-[12px] leading-4 font-medium text-ink-3">{item.label}</div>
                <div className="mt-1 text-[20px] leading-7 font-semibold tracking-[-0.01em] text-ink">{item.value}</div>
                {item.detail ? <div className="text-[12px] leading-4 text-ink-3">{item.detail}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {report.sections.map((section, i) => (
        <SectionView
          key={section.id}
          section={section}
          index={i + 1}
          report={report}
          printing={printing}
          canExport={canExport}
          exporting={busy === `section:${section.id}`}
          onCsv={() => void exportFile('csv', section)}
        />
      ))}

      <footer className="border-t border-line bg-sunken px-4 py-4 text-[12px] leading-5 text-ink-3 sm:px-8">
        {report.notes.length ? (
          <div className="mb-3">
            <div className="eyebrow mb-1">Notes</div>
            <ul className="flex flex-col gap-1">
              {report.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <FxNote conversions={report.conversions} className="mb-3" />
        <p>
          Every figure is computed from the stored price observations at the time the report was generated; nothing is estimated or filled in.
          {report.run_id ? <span className="num"> Report run #{report.run_id}.</span> : null}
        </p>
      </footer>
    </article>
  );
}
