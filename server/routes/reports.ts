import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors.ts';
import { audit } from '../services/core.ts';
import { CSV_MIME, downloadName, XLSX_MIME } from '../services/export.ts';
import { generateReport, listReportRuns, parseReportParams, REPORT_DEFINITIONS, reportToCsv, reportToXlsx } from '../services/reports.ts';
import type { ReportType } from '../../shared/api/reports.ts';

function reportType(value: unknown): ReportType {
  const def = REPORT_DEFINITIONS.find((d) => d.type === value);
  if (!def) throw badRequest('Unknown report type');
  return def.type;
}

export default async function reportRoutes(app: FastifyInstance) {
  const { ctx } = app;

  app.get('/reports/types', async () => ({ rows: REPORT_DEFINITIONS }));

  app.get('/reports/runs', async () => ({ rows: listReportRuns(ctx) }));

  /** Generates a report on screen. Body: { type, from?, to?, days?, market_id?, retailer_id?, brand_id?, category_id?, product_id?, currency? } */
  app.post('/reports/generate', { config: { permission: 'reports.generate' } }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = reportType(body.type);
    const report = generateReport(ctx, type, parseReportParams(ctx, type, body), req.user!);
    audit(ctx, req.user, 'report.generated', 'report', type, { period: report.period, run_id: report.run_id }, req.ip);
    return report;
  });

  /** Same parameters as /reports/generate, as a file: format=xlsx (all sections + chart data) or csv (one section or all tables). */
  app.get('/reports/export', { config: { permission: 'reports.generate' } }, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const type = reportType(q.type);
    const format = q.format === 'csv' ? 'csv' : q.format === 'xlsx' || q.format === undefined ? 'xlsx' : null;
    if (!format) throw badRequest('format must be "csv" or "xlsx"');
    const report = generateReport(ctx, type, parseReportParams(ctx, type, q), req.user!, false);
    audit(ctx, req.user, 'report.exported', 'report', type, { format, period: report.period }, req.ip);
    const base = `${type.replace(/_/g, '-')}-${report.period.from}-to-${report.period.to}`;
    if (format === 'csv') {
      const csv = reportToCsv(report, typeof q.section === 'string' && q.section ? q.section : undefined);
      return reply.header('content-type', CSV_MIME).header('content-disposition', `attachment; filename="${downloadName(base, 'csv')}"`).send(csv);
    }
    const buffer = await reportToXlsx(report);
    return reply.header('content-type', XLSX_MIME).header('content-disposition', `attachment; filename="${downloadName(base, 'xlsx')}"`).send(buffer);
  });
}
