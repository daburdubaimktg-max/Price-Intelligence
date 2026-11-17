/**
 * Price observations: browse the ledger, enter prices manually, attach evidence, void / restore
 * (corrections never modify or delete an observation) and export to CSV / Excel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { SqlValue } from '../db/sqlite.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../lib/errors.ts';
import { idParam, optBool, optionalId, optionalNumber, optionalText, orderBy, paged, pagination, parse, requiredId } from '../lib/http.ts';
import { csvLines } from '../lib/tabular.ts';
import { nowIso, parseTimestamp } from '../lib/time.ts';
import { audit } from '../services/core.ts';
import { CSV_MIME, downloadName, provenanceSheet, writeXlsx, XLSX_MIME, type ColumnSpec } from '../services/export.ts';
import { ingestObservations, restoreObservation, validateObservations, voidObservation, type ObservationInput } from '../services/ingestion.ts';
import { describeFilter, OBS_FROM, OBS_FROM_ALL, OBS_RECORD_COLUMNS, obsWhere, parseObsFilter, UNIT_PRICE_SQL, type ObsFilter } from '../services/obs-filter.ts';
import {
  AVAILABILITY,
  AVAILABILITY_LABELS,
  COLLECTION_METHOD_LABELS,
  DATA_CLASS_LABELS,
  PROMO_TYPE_LABELS,
  PROMO_TYPES,
  type Availability,
  type CollectionMethod,
  type DataClass,
  type PromoType,
} from '../../shared/constants.ts';
import { formatPack, unitBasisLabel } from '../../shared/units.ts';
import type {
  EvidenceRecord,
  ManualObservationResponse,
  ObservationBrief,
  ObservationDetail,
  ObservationRecord,
} from '../../shared/api/observations.ts';

const EXPORT_MAX_ROWS = 250_000;
const EVIDENCE_MAX_BYTES = 15 * 1024 * 1024;
const VOID_JOIN = 'LEFT JOIN observation_voids ov ON ov.observation_id = o.id';
const VOID_COLUMNS = '(ov.observation_id IS NOT NULL) AS voided, ov.reason AS void_reason';

const SORTABLE: Record<string, string> = {
  observed_at: 'o.observed_at',
  collected_at: 'o.collected_at',
  current_price: 'o.current_price',
  regular_price: 'o.regular_price',
  discount_pct: 'o.discount_pct',
  unit_price: UNIT_PRICE_SQL,
  product_name: 'li.product_name',
  brand_name: 'li.brand_name',
  retailer_name: 'li.retailer_name',
  market_name: 'li.market_name',
};

type VoidedMode = 'exclude' | 'include' | 'only';

interface ListScope {
  filter: ObsFilter;
  voided: VoidedMode;
  from: string;
  select: string;
  where: { sql: string; params: SqlValue[] };
}

/** Shared by the list and the export: the same query parameters select the same rows. */
function listScope(query: Record<string, unknown>): ListScope {
  const filter = parseObsFilter(query);
  const voided: VoidedMode = query.include_voided === 'only' ? 'only' : optBool(query.include_voided) ? 'include' : 'exclude';
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  for (const [param, column] of [
    ['import_batch_id', 'o.import_batch_id'],
    ['job_id', 'o.job_id'],
    ['evidence_id', 'o.evidence_id'],
  ] as const) {
    const value = query[param];
    if (value === undefined || value === null || value === '') continue;
    conditions.push(`${column} = ?`);
    params.push(idParam(value, param));
  }
  if (voided === 'only') conditions.push('ov.observation_id IS NOT NULL');
  const from = voided === 'exclude' ? OBS_FROM : `${OBS_FROM_ALL} ${VOID_JOIN}`;
  const select = `SELECT ${OBS_RECORD_COLUMNS}, ${voided === 'exclude' ? '0 AS voided, NULL AS void_reason' : VOID_COLUMNS}`;
  return { filter, voided, from, select, where: obsWhere(filter, { conditions, params }) };
}

export function fetchObservation(ctx: AppContext, id: number): ObservationRecord | undefined {
  return ctx.db.get<ObservationRecord>(`SELECT ${OBS_RECORD_COLUMNS}, ${VOID_COLUMNS} ${OBS_FROM_ALL} ${VOID_JOIN} WHERE o.id = ?`, [id]);
}

const EVIDENCE_SELECT = `SELECT e.id, e.kind, e.reference, e.file_name, e.mime_type, e.size_bytes, e.sha256, e.excerpt, e.captured_at,
  e.uploaded_by, u.name AS uploaded_by_name, e.note, e.is_demo, e.created_at, e.file_path
  FROM source_evidence e LEFT JOIN users u ON u.id = e.uploaded_by`;

function fetchEvidence(ctx: AppContext, id: number): (EvidenceRecord & { file_path: string | null }) | undefined {
  const row = ctx.db.get<Omit<EvidenceRecord, 'has_file'> & { file_path: string | null }>(`${EVIDENCE_SELECT} WHERE e.id = ?`, [id]);
  if (!row) return undefined;
  return { ...row, has_file: !!row.file_path && !!resolveStoredFile(ctx, row.file_path) };
}

function publicEvidence(row: EvidenceRecord & { file_path?: string | null }): EvidenceRecord {
  const { file_path: _omit, ...rest } = row;
  return rest;
}

/** Resolves a stored relative path and guarantees it stays inside the evidence / import directories. */
function resolveStoredFile(ctx: AppContext, relative: string): string | null {
  const absolute = path.resolve(ctx.config.dataDir, relative);
  const allowed = [ctx.config.evidenceDir, ctx.config.importDir].map((dir) => path.resolve(dir) + path.sep);
  if (!allowed.some((dir) => absolute.startsWith(dir))) return null;
  return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? absolute : null;
}

interface SniffedFile {
  extension: string;
  mime: string;
  kind: 'screenshot' | 'document' | 'csv_file';
}

/** Accepts images, PDFs and plain text / CSV only, judged by content (not by the declared type). */
function sniffEvidence(buffer: Buffer, fileName: string): SniffedFile | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', mime: 'image/png', kind: 'screenshot' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mime: 'image/jpeg', kind: 'screenshot' };
  }
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return { extension: 'webp', mime: 'image/webp', kind: 'screenshot' };
  }
  if (buffer.length >= 5 && buffer.toString('latin1', 0, 5) === '%PDF-') {
    return { extension: 'pdf', mime: 'application/pdf', kind: 'document' };
  }
  const extension = path.extname(fileName).toLowerCase();
  if ((extension === '.csv' || extension === '.txt') && !buffer.includes(0)) {
    return extension === '.csv'
      ? { extension: 'csv', mime: 'text/csv; charset=utf-8', kind: 'csv_file' }
      : { extension: 'txt', mime: 'text/plain; charset=utf-8', kind: 'document' };
  }
  return null;
}

const cleanFileName = (name: string) => path.basename(name).replace(/[^\w.\- ()]+/g, '_').slice(0, 150) || 'file';

// Optional keys: zod 4 only lets a key be absent when its schema is `.optional()`.
const promoTypeField = z
  .union([z.enum(PROMO_TYPES), z.literal(''), z.null()])
  .optional()
  .transform((v): PromoType | null => (v ? v : null));
const availabilityField = z
  .union([z.enum(AVAILABILITY), z.literal(''), z.null()])
  .optional()
  .transform((v): Availability | null => (v ? v : null));

const manualSchema = z.object({
  listing_id: requiredId(),
  observed_at: optionalText(40),
  observed_date: optionalText(20),
  observed_time: optionalText(12),
  regular_price: optionalNumber(),
  current_price: optionalNumber(),
  promo_price: optionalNumber(),
  discount_pct: optionalNumber(),
  is_promo: z
    .union([z.boolean(), z.null()])
    .optional()
    .transform((v) => v ?? null),
  promo_type: promoTypeField,
  promo_description: optionalText(500),
  promo_starts_on: optionalText(10),
  promo_ends_on: optionalText(10),
  availability: availabilityField,
  product_url: optionalText(2000),
  confidence: optionalNumber(),
  note: optionalText(1000),
  evidence_id: optionalId(),
  evidence: z
    .union([z.object({ kind: z.enum(['url', 'note', 'screenshot']), reference: z.string().trim().min(1).max(2000) }), z.null()])
    .optional()
    .transform((v) => v ?? null),
});

// ---------------------------------------------------------------------------------------------
// Export layout (shared by CSV and Excel). Header names are recognised by the importer, so an
// export can be edited in Excel and imported again.
// ---------------------------------------------------------------------------------------------
const BASIS_LABELS: Record<string, string> = {
  exact: 'Exact time',
  date_only: 'Date only',
  import_time: 'Import time (original date unknown)',
};

export const OBSERVATION_EXPORT_COLUMNS: ColumnSpec[] = [
  { key: 'id', header: 'Observation ID', type: 'integer' },
  { key: 'listing_code', header: 'Listing code', type: 'text', width: 14 },
  { key: 'retailer_name', header: 'Retailer', type: 'text' },
  { key: 'market_code', header: 'Market', type: 'text', width: 9 },
  { key: 'market_name', header: 'Market name', type: 'text', width: 16 },
  { key: 'country_code', header: 'Country', type: 'text', width: 9 },
  { key: 'brand_name', header: 'Brand', type: 'text', width: 18 },
  { key: 'ownership_label', header: 'Ownership', type: 'text', width: 13 },
  { key: 'product_name', header: 'Product', type: 'text', width: 38 },
  { key: 'product_code', header: 'Product code', type: 'text', width: 13 },
  { key: 'sku', header: 'SKU', type: 'text', width: 16 },
  { key: 'gtin', header: 'GTIN', type: 'text', width: 16 },
  { key: 'category_name', header: 'Category', type: 'text', width: 16 },
  { key: 'subcategory_name', header: 'Subcategory', type: 'text', width: 18 },
  { key: 'pack', header: 'Pack', type: 'text', width: 12 },
  { key: 'currency_code', header: 'Currency', type: 'text', width: 9 },
  { key: 'regular_price', header: 'Regular price', type: 'money' },
  { key: 'current_price', header: 'Current price', type: 'money' },
  { key: 'promo_price', header: 'Promo price', type: 'money' },
  { key: 'discount_pct', header: 'Discount %', type: 'percent' },
  { key: 'is_promo', header: 'On promotion', type: 'boolean', width: 13 },
  { key: 'promo_type_label', header: 'Promo type', type: 'text', width: 12 },
  { key: 'promo_description', header: 'Promo description', type: 'text', width: 28 },
  { key: 'promo_starts_on', header: 'Promo starts on', type: 'date', width: 15 },
  { key: 'promo_ends_on', header: 'Promo ends on', type: 'date', width: 15 },
  { key: 'availability_label', header: 'Availability', type: 'text', width: 13 },
  { key: 'unit_price', header: 'Unit price', type: 'money' },
  { key: 'unit_basis', header: 'Unit price basis', type: 'text', width: 15 },
  { key: 'observed_at', header: 'Observed at (UTC)', type: 'datetime' },
  { key: 'observed_local_date', header: 'Market-local date', type: 'date', width: 16 },
  { key: 'timezone', header: 'Time zone', type: 'text', width: 16 },
  { key: 'basis_label', header: 'Timestamp basis', type: 'text', width: 16 },
  { key: 'collected_at', header: 'Collected at (UTC)', type: 'datetime' },
  { key: 'source_method_label', header: 'Source method', type: 'text', width: 26 },
  { key: 'data_class_label', header: 'Data class', type: 'text', width: 17 },
  { key: 'demo', header: 'Demo data', type: 'text', width: 11 },
  { key: 'confidence', header: 'Confidence', type: 'number', numFmt: '0.00' },
  { key: 'collection_status', header: 'Collection status', type: 'text', width: 16 },
  { key: 'evidence_reference', header: 'Evidence', type: 'text', width: 30 },
  { key: 'url', header: 'Product URL', type: 'text', width: 40 },
  { key: 'note', header: 'Note', type: 'text', width: 30 },
];

const VOIDED_EXPORT_COLUMNS: ColumnSpec[] = [
  { key: 'voided', header: 'Voided', type: 'boolean' },
  { key: 'void_reason', header: 'Void reason', type: 'text', width: 40 },
];

type ExportRow = ObservationRecord & { evidence_reference: string | null };

export function decorateForExport(row: ExportRow): Record<string, unknown> {
  return {
    ...row,
    ownership_label: row.ownership === 'own' ? 'Own brand' : row.ownership === 'competitor' ? 'Competitor' : null,
    pack: row.pack_size ? formatPack(row.pack_size, row.pack_unit, row.units_per_pack) : null,
    promo_type_label: row.promo_type ? PROMO_TYPE_LABELS[row.promo_type] : null,
    availability_label: AVAILABILITY_LABELS[row.availability] ?? row.availability,
    unit_basis: row.unit_price === null ? null : unitBasisLabel(row.content_dimension),
    basis_label: BASIS_LABELS[row.observed_basis] ?? row.observed_basis,
    source_method_label: COLLECTION_METHOD_LABELS[row.source_method as CollectionMethod] ?? row.source_method,
    data_class_label: DATA_CLASS_LABELS[row.data_class as DataClass] ?? row.data_class,
    demo: row.is_demo ? 'DEMO' : null,
    url: row.product_url ?? row.listing_url,
  };
}

/** Pages through the matching observations (newest first) without loading them all into memory. */
function* iterateExportRows(ctx: AppContext, scope: ListScope, chunk = 2000): Generator<Record<string, unknown>> {
  const select = `${scope.select}, ev.reference AS evidence_reference`;
  const from = `${scope.from} LEFT JOIN source_evidence ev ON ev.id = o.evidence_id`;
  let cursor: { observed_at: string; id: number } | null = null;
  for (;;) {
    const sql: string =
      `${select} ${from} ${scope.where.sql}` +
      (cursor ? ' AND (o.observed_at < ? OR (o.observed_at = ? AND o.id < ?))' : '') +
      ` ORDER BY o.observed_at DESC, o.id DESC LIMIT ${chunk}`;
    const params: SqlValue[] = cursor ? [...scope.where.params, cursor.observed_at, cursor.observed_at, cursor.id] : scope.where.params;
    const rows: ExportRow[] = ctx.db.all<ExportRow>(sql, params);
    for (const row of rows) yield decorateForExport(row);
    if (rows.length < chunk) return;
    const last: ExportRow = rows[rows.length - 1]!;
    cursor = { observed_at: last.observed_at, id: last.id };
  }
}

function filterNames(ctx: AppContext, filter: ObsFilter) {
  const lookup = (table: string, ids: number[] | undefined) => {
    const map = new Map<number, string>();
    for (const id of ids ?? []) {
      const row = ctx.db.get<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, [id]);
      if (row) map.set(id, row.name);
    }
    return map;
  };
  return {
    markets: lookup('markets', filter.market_ids),
    retailers: lookup('retailers', filter.retailer_ids),
    brands: lookup('brands', filter.brand_ids),
    products: lookup('products', filter.product_ids),
    categories: lookup('categories', filter.category_ids),
  };
}

export default async function observationRoutes(app: FastifyInstance) {
  const { ctx } = app;

  // ---- list ---------------------------------------------------------------------------------
  app.get('/observations', async (req) => {
    const query = req.query as Record<string, unknown>;
    const scope = listScope(query);
    const page = pagination(query, 50, 500);
    const order = `${orderBy(query.sort, SORTABLE, 'o.observed_at DESC')}, o.id DESC`;
    const total = ctx.db.scalar<number>(`SELECT COUNT(*) ${scope.from} ${scope.where.sql}`, scope.where.params) ?? 0;
    const rows = ctx.db.all<ObservationRecord>(`${scope.select} ${scope.from} ${scope.where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`, [
      ...scope.where.params,
      page.pageSize,
      page.offset,
    ]);
    return paged(rows, total, page);
  });

  // ---- export (registered before :id; static segments win over parameters anyway) -------------
  app.get('/observations/export', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const format = query.format === undefined || query.format === '' ? 'csv' : String(query.format).toLowerCase();
    if (format !== 'csv' && format !== 'xlsx') throw badRequest('format must be "csv" or "xlsx"');
    const scope = listScope(query);
    const breakdown = ctx.db.all<{ data_class: DataClass; is_demo: number; n: number }>(
      `SELECT o.data_class AS data_class, o.is_demo AS is_demo, COUNT(*) AS n ${scope.from} ${scope.where.sql} GROUP BY o.data_class, o.is_demo`,
      scope.where.params,
    );
    const total = breakdown.reduce((sum, b) => sum + b.n, 0);
    if (total > EXPORT_MAX_ROWS) {
      throw new AppError(
        413,
        'too_large',
        `This export would contain ${total.toLocaleString('en-US')} rows; the limit is ${EXPORT_MAX_ROWS.toLocaleString('en-US')}. Narrow the date range or filters, or download the full Excel database instead.`,
      );
    }
    const user = req.user!;
    const columns = scope.voided === 'exclude' ? OBSERVATION_EXPORT_COLUMNS : [...OBSERVATION_EXPORT_COLUMNS, ...VOIDED_EXPORT_COLUMNS];
    audit(ctx, user, 'observations.export', 'observation', null, { format, rows: total, filter: scope.filter }, req.ip);

    if (format === 'csv') {
      reply.header('Content-Type', CSV_MIME).header('Content-Disposition', `attachment; filename="${downloadName('price-observations', 'csv')}"`);
      const flags = columns.filter((c) => c.type === 'boolean').map((c) => c.key);
      const csvRows = (function* () {
        for (const row of iterateExportRows(ctx, scope)) {
          for (const key of flags) {
            if (row[key] !== null && row[key] !== undefined) row[key] = row[key] ? 'Yes' : 'No';
          }
          yield row;
        }
      })();
      return reply.send(Readable.from(csvLines(columns, csvRows)));
    }

    const demoRows = breakdown.filter((b) => b.is_demo).reduce((sum, b) => sum + b.n, 0);
    const filterLines = describeFilter(scope.filter, filterNames(ctx, scope.filter));
    const provenance: Array<string | [string, unknown]> = [
      ['Export', 'Price observations'],
      ['Generated at (UTC)', new Date()],
      ['Generated by', `${user.name} <${user.email}>`],
      ['Rows', total],
      ...(filterLines.length ? filterLines.map((line): [string, unknown] => ['Filter', line]) : [['Filter', 'None — all observations'] as [string, unknown]]),
      ['Voided observations', scope.voided === 'exclude' ? 'Excluded' : scope.voided === 'only' ? 'Only voided observations' : 'Included (see "Voided" column)'],
      ...(['collected', 'imported', 'manual', 'simulated'] as DataClass[]).map((cls): [string, unknown] => [
        `Rows — ${DATA_CLASS_LABELS[cls]}`,
        breakdown.filter((b) => b.data_class === cls).reduce((sum, b) => sum + b.n, 0),
      ]),
      ...(demoRows > 0
        ? [
            `WARNING: ${demoRows.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} rows are DEMO DATA — illustrative, fictional prices marked "DEMO" in the "Demo data" column. They are not real market observations.`,
          ]
        : []),
      'Timestamps are in UTC. "Market-local date" is the calendar date in the time zone of the market.',
      'Unit price = price per 100 ml, per 100 g or per unit (see "Unit price basis").',
    ];
    const stream = new PassThrough();
    writeXlsx(
      [
        { name: 'Price observations', columns, rows: iterateExportRows(ctx, scope) },
        provenanceSheet('Price Intelligence OS — price observations export', provenance),
      ],
      stream,
      { title: 'Price observations export' },
    ).catch((err) => {
      req.log.error({ err }, 'observation export failed');
      stream.destroy(err as Error);
    });
    reply.header('Content-Type', XLSX_MIME).header('Content-Disposition', `attachment; filename="${downloadName('price-observations', 'xlsx')}"`);
    return reply.send(stream);
  });

  // ---- detail -------------------------------------------------------------------------------
  const detail = (id: number): ObservationDetail => {
    const observation = fetchObservation(ctx, id);
    if (!observation) throw notFound('Observation');
    const voidRow = ctx.db.get<{ reason: string; voided_at: string; voided_by: number | null; voided_by_name: string | null; import_batch_id: number | null }>(
      `SELECT v.reason, v.voided_at, v.voided_by, u.name AS voided_by_name, v.import_batch_id
       FROM observation_voids v LEFT JOIN users u ON u.id = v.voided_by WHERE v.observation_id = ?`,
      [id],
    );
    const evidence = observation.evidence_id ? fetchEvidence(ctx, observation.evidence_id) : undefined;
    const job = observation.job_id
      ? ctx.db.get<NonNullable<ObservationDetail['job']>>(
          'SELECT id, status, method, data_class, trigger_type, started_at, finished_at FROM collection_jobs WHERE id = ?',
          [observation.job_id],
        )
      : undefined;
    const batch = observation.import_batch_id
      ? ctx.db.get<NonNullable<ObservationDetail['import_batch']>>('SELECT id, file_name, status, created_at FROM import_batches WHERE id = ?', [
          observation.import_batch_id,
        ])
      : undefined;
    const enteredBy = observation.entered_by
      ? ctx.db.get<{ id: number; name: string; email: string }>('SELECT id, name, email FROM users WHERE id = ?', [observation.entered_by])
      : undefined;
    const briefColumns = `id, observed_at, observed_local_date, regular_price, current_price, promo_price, discount_pct, is_promo,
      availability, source_method, data_class`;
    const previous = ctx.db.get<ObservationBrief>(
      `SELECT ${briefColumns} FROM v_observations WHERE listing_id = ? AND (observed_at < ? OR (observed_at = ? AND id < ?))
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
      [observation.listing_id, observation.observed_at, observation.observed_at, id],
    );
    const next = ctx.db.get<ObservationBrief>(
      `SELECT ${briefColumns} FROM v_observations WHERE listing_id = ? AND (observed_at > ? OR (observed_at = ? AND id > ?))
       ORDER BY observed_at ASC, id ASC LIMIT 1`,
      [observation.listing_id, observation.observed_at, observation.observed_at, id],
    );
    return {
      observation,
      void: voidRow ?? null,
      evidence: evidence ? publicEvidence(evidence) : null,
      job: job ?? null,
      import_batch: batch ?? null,
      entered_by: enteredBy ?? null,
      previous: previous ?? null,
      next: next ?? null,
    };
  };

  app.get('/observations/:id', async (req) => detail(idParam((req.params as { id: string }).id)));

  // ---- manual price entry -------------------------------------------------------------------
  app.post('/observations', { config: { permission: 'observations.write' } }, async (req, reply) => {
    const body = parse(manualSchema, req.body, 'observation');
    const user = req.user!;
    const listing = ctx.db.get<{ id: number; is_demo: number; timezone: string; retailer_name: string }>(
      `SELECT l.id, l.is_demo, m.timezone, r.name AS retailer_name
       FROM retailer_listings l JOIN retailers r ON r.id = l.retailer_id JOIN markets m ON m.id = r.market_id WHERE l.id = ?`,
      [body.listing_id],
    );
    if (!listing) throw notFound('Listing');

    let observedAt = nowIso();
    let basis: 'exact' | 'date_only' = 'exact';
    const stamp = body.observed_at ?? (body.observed_date ? `${body.observed_date} ${body.observed_time ?? ''}`.trim() : null);
    if (stamp) {
      const parsed = parseTimestamp(stamp, listing.timezone, 'ymd');
      if (!parsed) {
        throw unprocessable('The observation date/time could not be understood. Use YYYY-MM-DD and an optional HH:mm time (market local time), or a full ISO timestamp.');
      }
      observedAt = parsed.utc;
      basis = parsed.basis;
    } else if (body.observed_time) {
      throw unprocessable('A time was given without a date');
    }

    const input: ObservationInput = {
      listing_id: listing.id,
      observed_at: observedAt,
      observed_basis: basis,
      regular_price: body.regular_price,
      current_price: body.current_price,
      promo_price: body.promo_price,
      discount_pct: body.discount_pct,
      is_promo: body.is_promo,
      promo_type: body.promo_type,
      promo_description: body.promo_description,
      promo_starts_on: body.promo_starts_on,
      promo_ends_on: body.promo_ends_on,
      availability: body.availability,
      product_url: body.product_url,
      confidence: body.confidence ?? 0.95,
      note: body.note,
    };

    // Check everything before anything is written, so a rejected entry leaves no trace.
    const check = validateObservations(ctx, [input]);
    if (check.rejected.length) throw unprocessable(check.rejected[0]!.reason);
    const existing = ctx.db.get<{ id: number }>('SELECT id FROM price_observations WHERE dedupe_key = ?', [check.valid[0]!.row.dedupe_key]);
    if (existing) {
      throw conflict('An identical observation (same listing, time and prices) is already recorded — nothing was added.', {
        observation_id: existing.id,
      });
    }
    if (body.evidence_id) {
      if (!ctx.db.get('SELECT id FROM source_evidence WHERE id = ?', [body.evidence_id])) throw unprocessable('The referenced evidence does not exist');
      input.evidence_id = body.evidence_id;
    } else if (body.evidence) {
      input.evidence_id = ctx.db.run(
        `INSERT INTO source_evidence (kind, reference, captured_at, uploaded_by, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [body.evidence.kind, body.evidence.reference, observedAt, user.id, listing.is_demo, nowIso()],
      ).lastInsertRowid;
    }

    const result = ingestObservations(ctx, [input], { sourceMethod: 'manual', userId: user.id });
    if (result.rejected.length) throw unprocessable(result.rejected[0]!.reason);
    if (result.inserted !== 1) throw conflict('An identical observation is already recorded — nothing was added.');
    const id = result.observationIds[0]!;
    audit(ctx, user, 'observation.create', 'observation', id, { listing_id: listing.id, observed_at: observedAt, current_price: input.current_price, superseded: result.superseded }, req.ip);
    const response: ManualObservationResponse = { observation: fetchObservation(ctx, id)!, superseded: result.superseded };
    return reply.code(201).send(response);
  });

  // ---- void / restore (corrections never touch the ledger rows) --------------------------------
  app.post('/observations/:id/void', { config: { permission: 'observations.void' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const body = parse(z.object({ reason: z.string().trim().min(3, 'give a reason of at least 3 characters').max(500) }), req.body);
    const current = fetchObservation(ctx, id);
    if (!current) throw notFound('Observation');
    if (current.voided) throw conflict('This observation is already voided');
    voidObservation(ctx, id, body.reason, req.user!.id);
    audit(ctx, req.user!, 'observation.void', 'observation', id, { reason: body.reason, listing_id: current.listing_id }, req.ip);
    return detail(id);
  });

  app.post('/observations/:id/restore', { config: { permission: 'observations.void' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const current = fetchObservation(ctx, id);
    if (!current) throw notFound('Observation');
    if (!current.voided) throw conflict('This observation is not voided');
    const clash = ctx.db.get<{ id: number }>('SELECT id FROM v_observations WHERE listing_id = ? AND observed_at = ? AND id <> ?', [
      current.listing_id,
      current.observed_at,
      id,
    ]);
    if (clash) {
      throw conflict(`Observation #${clash.id} is recorded for the same listing and timestamp. Void that one first if this one should apply instead.`, {
        observation_id: clash.id,
      });
    }
    restoreObservation(ctx, id);
    audit(ctx, req.user!, 'observation.restore', 'observation', id, { listing_id: current.listing_id }, req.ip);
    return detail(id);
  });

  // ---- evidence ------------------------------------------------------------------------------
  app.post('/evidence', { config: { permission: 'observations.write' } }, async (req, reply) => {
    if (!req.isMultipart()) throw badRequest('Upload the evidence file as multipart/form-data');
    const upload = await readUpload(req, EVIDENCE_MAX_BYTES);
    if (!upload.file) throw badRequest('No file was uploaded (expected a form field named "file")');
    const sniffed = sniffEvidence(upload.file.buffer, upload.file.filename);
    if (!sniffed) throw unprocessable('Unsupported evidence file. Allowed: PNG, JPEG or WebP images, PDF, CSV and plain text.');
    const sha = sha256Hex(upload.file.buffer);
    fs.mkdirSync(ctx.config.evidenceDir, { recursive: true });
    const stored = `${sha}.${sniffed.extension}`;
    const absolute = path.join(ctx.config.evidenceDir, stored);
    if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, upload.file.buffer, { mode: 0o640 });
    const fileName = cleanFileName(upload.file.filename);
    let capturedAt: string | null = null;
    if (upload.fields.captured_at) {
      const d = new Date(upload.fields.captured_at);
      if (Number.isNaN(d.getTime())) throw unprocessable('captured_at is not a valid timestamp');
      capturedAt = d.toISOString();
    }
    const requestedKind = upload.fields.kind;
    const kind = requestedKind === 'screenshot' || requestedKind === 'document' || requestedKind === 'csv_file' ? requestedKind : sniffed.kind;
    const id = ctx.db.run(
      `INSERT INTO source_evidence (kind, reference, file_path, file_name, mime_type, size_bytes, sha256, captured_at, uploaded_by, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        kind,
        (upload.fields.reference ?? '').trim().slice(0, 2000) || fileName,
        path.relative(ctx.config.dataDir, absolute),
        fileName,
        sniffed.mime,
        upload.file.buffer.length,
        sha,
        capturedAt,
        req.user!.id,
        (upload.fields.note ?? '').trim().slice(0, 1000) || null,
        nowIso(),
      ],
    ).lastInsertRowid;
    audit(ctx, req.user!, 'evidence.upload', 'evidence', id, { file_name: fileName, sha256: sha, size_bytes: upload.file.buffer.length }, req.ip);
    return reply.code(201).send(publicEvidence(fetchEvidence(ctx, id)!));
  });

  app.get('/evidence/:id', async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const row = fetchEvidence(ctx, id);
    if (!row) throw notFound('Evidence');
    const count = ctx.db.scalar<number>('SELECT COUNT(*) FROM price_observations WHERE evidence_id = ?', [id]) ?? 0;
    return { ...publicEvidence(row), observation_count: count };
  });

  app.get('/evidence/:id/file', async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    const row = fetchEvidence(ctx, id);
    if (!row) throw notFound('Evidence');
    const absolute = row.file_path ? resolveStoredFile(ctx, row.file_path) : null;
    if (!absolute) throw notFound('Evidence file');
    const mime = row.mime_type ?? 'application/octet-stream';
    const inline = mime.startsWith('image/');
    reply
      .header('Content-Type', mime)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=3600')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${cleanFileName(row.file_name ?? `evidence-${id}`)}"`);
    return reply.send(fs.createReadStream(absolute));
  });
}

export interface UploadedForm {
  file: { filename: string; mimetype: string; buffer: Buffer } | null;
  fields: Record<string, string>;
}

/** Reads a multipart form with at most one file (kept in memory, size-capped) and its text fields. */
export async function readUpload(req: FastifyRequest, maxBytes: number): Promise<UploadedForm> {
  const form: UploadedForm = { file: null, fields: {} };
  for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 1 } })) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (!form.file && part.filename) form.file = { filename: part.filename, mimetype: part.mimetype, buffer };
    } else if (typeof part.value === 'string') {
      form.fields[part.fieldname] = part.value;
    }
  }
  return form;
}
