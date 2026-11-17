/**
 * Imports of price history and products from CSV or Excel (.xlsx):
 * upload (staged) → validate (dry run) → commit → optionally void a committed price import.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../context.ts';
import { badRequest, forbidden, unprocessable } from '../lib/errors.ts';
import { idParam, paged, pagination, parse } from '../lib/http.ts';
import {
  commitImport,
  describeStagedFile,
  getBatch,
  getBatchDetail,
  IMPORT_MAX_BYTES,
  importTemplate,
  listBatches,
  stageImport,
  validateImport,
  voidImport,
} from '../services/imports.ts';
import { roleCan } from '../../shared/constants.ts';
import type { ImportKind } from '../../shared/api/observations.ts';
import { readUpload } from './observations.ts';

function assertKindPermission(user: AuthUser, kind: ImportKind): void {
  const permission = kind === 'products' ? 'catalogue.write' : 'observations.write';
  if (!roleCan(user.role, permission)) throw forbidden();
}

const kindOf = (value: unknown): ImportKind => {
  if (value === 'observations' || value === 'products') return value;
  throw badRequest('kind must be "observations" (price history) or "products"');
};

export default async function importRoutes(app: FastifyInstance) {
  const { ctx } = app;

  /** Ready-to-fill templates: /imports/templates/observations.csv|.xlsx and products.csv|.xlsx */
  app.get('/imports/templates/:file', async (req, reply) => {
    const match = /^(observations|products)\.(csv|xlsx)$/.exec((req.params as { file: string }).file);
    if (!match) throw badRequest('Unknown template. Available: observations.csv, observations.xlsx, products.csv, products.xlsx');
    const template = await importTemplate(match[1] as ImportKind, match[2] as 'csv' | 'xlsx');
    reply.header('Content-Type', template.mime).header('Content-Disposition', `attachment; filename="${template.fileName}"`);
    return reply.send(template.body);
  });

  app.get('/imports', async (req) => {
    const query = req.query as Record<string, unknown>;
    const page = pagination(query, 25, 100);
    const kind = query.kind === undefined || query.kind === '' ? undefined : kindOf(query.kind);
    const status = typeof query.status === 'string' && query.status ? query.status : undefined;
    const { rows, total } = listBatches(ctx, { kind, status, limit: page.pageSize, offset: page.offset });
    return paged(rows, total, page);
  });

  app.get('/imports/:id', async (req) => getBatchDetail(ctx, idParam((req.params as { id: string }).id)));

  /** Step 1 — upload. The original file is retained as evidence; nothing reaches the ledger yet. */
  app.post('/imports', { config: { permission: 'any' } }, async (req, reply) => {
    if (!req.isMultipart()) throw badRequest('Upload the file as multipart/form-data with the fields "kind" and "file"');
    const upload = await readUpload(req, IMPORT_MAX_BYTES);
    const kind = kindOf(upload.fields.kind);
    assertKindPermission(req.user!, kind);
    if (!upload.file) throw unprocessable('No file was uploaded (expected a form field named "file")');
    const staged = await stageImport(ctx, {
      kind,
      fileName: upload.file.filename,
      buffer: upload.file.buffer,
      sheet: upload.fields.sheet?.trim() || null,
      user: req.user!,
      ip: req.ip,
    });
    return reply.code(201).send(staged);
  });

  /** Excel only — switch to another worksheet of the staged workbook. */
  app.post('/imports/:id/sheet', { config: { permission: 'any' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    assertKindPermission(req.user!, getBatch(ctx, id).kind);
    const body = parse(z.object({ sheet: z.string().trim().min(1).max(100) }), req.body);
    return describeStagedFile(ctx, id, body.sheet);
  });

  /** Step 2 — dry run with the chosen column mapping and options. */
  app.post('/imports/:id/validate', { config: { permission: 'any' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    assertKindPermission(req.user!, getBatch(ctx, id).kind);
    const body = parse(
      z.object({
        mapping: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
      req.body,
    );
    const mapping = body.mapping
      ? (Object.fromEntries(Object.entries(body.mapping).filter(([, header]) => typeof header === 'string' && header !== '')) as Record<string, string>)
      : undefined;
    return validateImport(ctx, id, { mapping, options: body.options });
  });

  /** Step 3 — write the valid rows. */
  app.post('/imports/:id/commit', { config: { permission: 'any' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    assertKindPermission(req.user!, getBatch(ctx, id).kind);
    return commitImport(ctx, id, req.user!, req.ip);
  });

  /** Withdraw a committed price import: its observations are voided (kept in the ledger, out of analytics). */
  app.post('/imports/:id/void', { config: { permission: 'observations.void' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const body = parse(z.object({ reason: z.string().trim().min(3, 'give a reason of at least 3 characters').max(500) }), req.body);
    return voidImport(ctx, id, body.reason, req.user!, req.ip);
  });
}
