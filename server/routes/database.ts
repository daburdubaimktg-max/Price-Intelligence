/**
 * "The database on an Excel file":
 *   GET  /database/export.xlsx      – the whole database as one workbook, generated on demand
 *   GET  /database/mirror           – status of the always-current mirror workbook kept on disk
 *   POST /database/mirror/refresh   – regenerate the mirror now
 *   GET  /database/mirror/download  – download the mirror
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.ts';
import { audit } from '../services/core.ts';
import {
  cleanExportTemp,
  exportsDir,
  getMirrorStatus,
  maybeAutoRefreshMirror,
  MIRROR_FILE_NAME,
  mirrorPath,
  refreshMirror,
  writeDatabaseWorkbook,
} from '../services/database-export.ts';
import { downloadName, XLSX_MIME } from '../services/export.ts';

export default async function databaseRoutes(app: FastifyInstance) {
  const { ctx } = app;

  cleanExportTemp(ctx);
  // Keep the Excel mirror current: created on the first scheduler tick, refreshed when data changed.
  ctx.hooks.schedulerTick.push((now) => {
    maybeAutoRefreshMirror(ctx, now);
  });

  app.get('/database/export.xlsx', { config: { permission: 'database.export' } }, async (req, reply) => {
    const user = req.user!;
    const dir = path.join(exportsDir(ctx), 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `export-${crypto.randomBytes(8).toString('hex')}.xlsx`);
    const started = Date.now();
    try {
      const result = await writeDatabaseWorkbook(ctx, file, {
        includeAdminSheets: user.role === 'admin',
        generatedBy: `${user.name} <${user.email}>`,
      });
      audit(
        ctx,
        user,
        'database.export',
        'database',
        null,
        { bytes: result.bytes, observation_rows: result.observationRows, sheets: result.sheets.length, duration_ms: Date.now() - started },
        req.ip,
      );
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
    const stream = fs.createReadStream(file);
    stream.on('close', () => fs.rm(file, { force: true }, () => undefined));
    reply
      .header('Content-Type', XLSX_MIME)
      .header('Content-Length', fs.statSync(file).size)
      .header('Content-Disposition', `attachment; filename="${downloadName('price-intelligence-database', 'xlsx')}"`);
    return reply.send(stream);
  });

  app.get('/database/mirror', { config: { permission: 'database.export' } }, async () => getMirrorStatus(ctx));

  app.post('/database/mirror/refresh', { config: { permission: 'database.export' } }, async (req) => {
    const status = await refreshMirror(ctx);
    audit(ctx, req.user!, 'database.mirror_refresh', 'database', null, { size_bytes: status.size_bytes, observation_rows: status.observation_rows }, req.ip);
    return status;
  });

  app.get('/database/mirror/download', { config: { permission: 'database.export' } }, async (req, reply) => {
    const file = mirrorPath(ctx);
    if (!fs.existsSync(file)) throw new AppError(404, 'not_found', 'The Excel mirror has not been generated yet. Refresh it first.');
    audit(ctx, req.user!, 'database.mirror_download', 'database', null, null, req.ip);
    reply
      .header('Content-Type', XLSX_MIME)
      .header('Content-Length', fs.statSync(file).size)
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="${MIRROR_FILE_NAME}"`);
    return reply.send(fs.createReadStream(file));
  });
}
