/**
 * Data Collection Centre API (`/api/collection/*`): source health, jobs, logs, connector catalogue,
 * manual runs, dry-run tests and retries.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { placeholders, type SqlValue } from '../db/sqlite.ts';
import { badRequest, notFound, unprocessable } from '../lib/errors.ts';
import { idList, idParam, likePattern, optBool, paged, pagination, parse, strList } from '../lib/http.ts';
import { isIsoDate, addDays } from '../lib/time.ts';
import { audit } from '../services/core.ts';
import { collectionHealth, listSources, sourceConfigStatus } from '../services/collection/health.ts';
import { describeConnectors } from '../services/collection/registry.ts';
import { cancelJob, engine, enqueueJob, enqueueRetry, startJob, testRetailer } from '../services/collection/runner.ts';
import { runSchedulerTick } from '../services/collection/scheduler.ts';
import { getJob, JOB_SELECT, LOG_SELECT, mapJob, mapLog } from '../services/collection/sources.ts';
import { checkSite } from '../services/collection/web.ts';
import type { CollectionJob, CollectionJobDetail, CollectionLog, SiteCheckResult } from '../../shared/api/collection.ts';

const JOB_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'not_configured', 'cancelled'];
const SOURCE_STATUSES = ['healthy', 'failing', 'not_configured', 'paused', 'manual', 'simulated', 'pending'];

function dateRange(query: Record<string, unknown>, column: string, conditions: string[], params: SqlValue[]): void {
  for (const key of ['from', 'to'] as const) {
    const value = query[key];
    if (value === undefined || value === null || value === '') continue;
    if (!isIsoDate(value)) throw badRequest(`"${key}" must be a date in YYYY-MM-DD format`);
    if (key === 'from') {
      conditions.push(`${column} >= ?`);
      params.push(`${value}T00:00:00.000Z`);
    } else {
      conditions.push(`${column} < ?`);
      params.push(`${addDays(value, 1)}T00:00:00.000Z`);
    }
  }
}

function inList(column: string, values: Array<string | number> | undefined, conditions: string[], params: SqlValue[]): void {
  if (!values?.length) return;
  conditions.push(`${column} IN (${placeholders(values.length)})`);
  params.push(...values);
}

export default async function collectionRoutes(app: FastifyInstance) {
  const { ctx } = app;

  app.get('/collection/health', async (req) => {
    const query = req.query as Record<string, unknown>;
    const days = Number(query.days ?? 14);
    if (!Number.isFinite(days) || days < 1) throw badRequest('"days" must be a positive number');
    return collectionHealth(ctx, days);
  });

  app.get('/collection/sources', async (req) => {
    const query = req.query as Record<string, unknown>;
    const sources = listSources(ctx, {
      market_ids: idList(query.market_id),
      retailer_ids: idList(query.retailer_id),
      methods: strList(query.method),
      statuses: strList(query.status)?.filter((s) => SOURCE_STATUSES.includes(s)),
      search: typeof query.q === 'string' && query.q.trim() ? query.q.trim() : undefined,
      include_inactive: optBool(query.include_inactive),
    });
    return { rows: sources, total: sources.length };
  });

  app.get('/collection/connectors', async () => ({ rows: describeConnectors() }));

  /**
   * POST /api/collection/site-check { url } — can this product page be read directly? Requests robots.txt and, only
   * if it allows the page, the page itself (once), the way permitted website extraction would. Stores nothing.
   */
  app.post('/collection/site-check', { config: { permission: 'sources.manage' } }, async (req): Promise<SiteCheckResult> => {
    const body = parse(z.object({ url: z.string().trim().url('Enter the full address of a product page, starting with https://').max(2000) }), req.body);
    const url = new URL(body.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw unprocessable('Enter a web address starting with http:// or https://');
    const result = await checkSite(ctx, url.toString());
    audit(ctx, req.user, 'collection.site_checked', 'site', url.host, { verdict: result.verdict, robots: result.robots.status, page: result.page?.outcome ?? null }, req.ip);
    return result;
  });

  app.get('/collection/retailers/:id/status', async (req) => {
    return sourceConfigStatus(ctx, idParam((req.params as { id: string }).id, 'retailer id'));
  });

  // ---- jobs ----------------------------------------------------------------------------------
  app.get('/collection/jobs', async (req) => {
    const query = req.query as Record<string, unknown>;
    const conditions: string[] = [];
    const params: SqlValue[] = [];
    inList('j.retailer_id', idList(query.retailer_id), conditions, params);
    inList('r.market_id', idList(query.market_id), conditions, params);
    inList('j.status', strList(query.status)?.filter((s) => JOB_STATUSES.includes(s)), conditions, params);
    inList('j.data_class', strList(query.data_class)?.filter((s) => s === 'real' || s === 'simulated'), conditions, params);
    inList('j.trigger_type', strList(query.trigger_type)?.filter((s) => ['schedule', 'manual', 'retry'].includes(s)), conditions, params);
    dateRange(query, 'j.created_at', conditions, params);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const page = pagination(query, 50, 200);
    const total =
      ctx.db.scalar<number>(`SELECT COUNT(*) FROM collection_jobs j JOIN retailers r ON r.id = j.retailer_id ${where}`, params) ?? 0;
    const rows = ctx.db
      .all<Omit<CollectionJob, 'duration_ms'>>(`${JOB_SELECT} ${where} ORDER BY j.id DESC LIMIT ? OFFSET ?`, [...params, page.pageSize, page.offset])
      .map(mapJob);
    return paged(rows, total, page);
  });

  app.get('/collection/jobs/:id', async (req): Promise<CollectionJobDetail> => {
    const id = idParam((req.params as { id: string }).id, 'job id');
    const job = getJob(ctx, id);
    if (!job) throw notFound('Collection job');
    const logs = ctx.db
      .all<Omit<CollectionLog, 'detail'> & { detail: string | null }>(
        `${LOG_SELECT} WHERE g.job_id = ? ORDER BY CASE g.level WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, g.id LIMIT 2000`,
        [id],
      )
      .map(mapLog);
    // Retry chain: walk up to the first attempt, then collect every descendant.
    let rootId = job.id;
    for (let hops = 0, parent = job.parent_job_id; parent !== null && hops < 50; hops++) {
      rootId = parent;
      parent = ctx.db.get<{ parent_job_id: number | null }>('SELECT parent_job_id FROM collection_jobs WHERE id = ?', [parent])?.parent_job_id ?? null;
    }
    const chain = ctx.db
      .all<Omit<CollectionJob, 'duration_ms'>>(
        `WITH RECURSIVE chain(id) AS (
           SELECT ? UNION ALL SELECT j.id FROM collection_jobs j JOIN chain c ON j.parent_job_id = c.id
         )
         ${JOB_SELECT} WHERE j.id IN (SELECT id FROM chain) ORDER BY j.id`,
        [rootId],
      )
      .map(mapJob);
    const inFlight = !!ctx.db.get(`SELECT 1 AS x FROM collection_jobs WHERE retailer_id = ? AND status IN ('queued', 'running') LIMIT 1`, [job.retailer_id]);
    return {
      job,
      logs,
      chain,
      can_retry: ['failed', 'partial', 'not_configured', 'cancelled'].includes(job.status) && !inFlight,
      can_cancel: job.status === 'queued' || (job.status === 'running' && engine(ctx).active.has(job.id)),
    };
  });

  app.get('/collection/logs', async (req) => {
    const query = req.query as Record<string, unknown>;
    const conditions: string[] = [];
    const params: SqlValue[] = [];
    inList('g.level', strList(query.level)?.filter((l) => ['info', 'warn', 'error'].includes(l)), conditions, params);
    inList('g.retailer_id', idList(query.retailer_id), conditions, params);
    inList('g.job_id', idList(query.job_id), conditions, params);
    inList('g.listing_id', idList(query.listing_id), conditions, params);
    inList('g.code', strList(query.code), conditions, params);
    inList('j.data_class', strList(query.data_class)?.filter((s) => s === 'real' || s === 'simulated'), conditions, params);
    if (typeof query.q === 'string' && query.q.trim()) {
      conditions.push(`(g.message LIKE ? ESCAPE '\\' OR g.code LIKE ? ESCAPE '\\')`);
      const pattern = likePattern(query.q.trim());
      params.push(pattern, pattern);
    }
    dateRange(query, 'g.created_at', conditions, params);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const page = pagination(query, 100, 500);
    const total =
      ctx.db.scalar<number>(`SELECT COUNT(*) FROM collection_logs g JOIN collection_jobs j ON j.id = g.job_id ${where}`, params) ?? 0;
    const rows = ctx.db
      .all<Omit<CollectionLog, 'detail'> & { detail: string | null }>(`${LOG_SELECT} ${where} ORDER BY g.id DESC LIMIT ? OFFSET ?`, [
        ...params,
        page.pageSize,
        page.offset,
      ])
      .map(mapLog);
    return paged(rows, total, page);
  });

  // ---- actions -------------------------------------------------------------------------------
  /** Queue a manual run. Returns immediately with the job; poll GET /collection/jobs/:id for the outcome. */
  app.post('/collection/retailers/:id/run', { config: { permission: 'collection.run' } }, async (req, reply) => {
    const retailerId = idParam((req.params as { id: string }).id, 'retailer id');
    const job = enqueueJob(ctx, retailerId, { trigger: 'manual', requestedBy: req.user!.id });
    void startJob(ctx, job.id);
    audit(ctx, req.user, 'collection.run', 'retailer', retailerId, { job_id: job.id, method: job.method, data_class: job.data_class }, req.ip);
    return reply.code(202).send({ job: getJob(ctx, job.id) ?? job });
  });

  /** Dry run: fetch and parse only. Nothing is stored and no job is recorded. */
  app.post('/collection/retailers/:id/test', { config: { permission: 'sources.manage' } }, async (req) => {
    const retailerId = idParam((req.params as { id: string }).id, 'retailer id');
    const body = parse(z.object({ limit: z.coerce.number().int().min(1).max(10).optional() }), req.body);
    const result = await testRetailer(ctx, retailerId, { limit: body.limit });
    audit(ctx, req.user, 'collection.test', 'retailer', retailerId, { ok: result.ok, configured: result.configured, requests: result.requests }, req.ip);
    return result;
  });

  app.post('/collection/jobs/:id/retry', { config: { permission: 'collection.run' } }, async (req, reply) => {
    const jobId = idParam((req.params as { id: string }).id, 'job id');
    const job = enqueueRetry(ctx, jobId, req.user!.id);
    void startJob(ctx, job.id);
    audit(ctx, req.user, 'collection.retry', 'collection_job', jobId, { retry_job_id: job.id, retailer_id: job.retailer_id }, req.ip);
    return reply.code(202).send({ job: getJob(ctx, job.id) ?? job });
  });

  app.post('/collection/jobs/:id/cancel', { config: { permission: 'collection.run' } }, async (req) => {
    const jobId = idParam((req.params as { id: string }).id, 'job id');
    const job = cancelJob(ctx, jobId);
    audit(ctx, req.user, 'collection.cancel', 'collection_job', jobId, { retailer_id: job.retailer_id }, req.ip);
    return { job: getJob(ctx, jobId) ?? job };
  });

  /** Runs everything that is due right now (what the scheduler would do on its next pass). */
  app.post('/collection/run-due', { config: { permission: 'collection.run' } }, async (req, reply) => {
    const result = await runSchedulerTick(ctx, new Date(), { skipHooks: true });
    audit(ctx, req.user, 'collection.run_due', null, null, { started: result.started.length, skipped: result.skipped.length }, req.ip);
    return reply.code(202).send({ started: result.started, skipped: result.skipped });
  });
}
