import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext, AuthUser } from '../context.ts';
import { placeholders, type SqlParam } from '../db/sqlite.ts';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../lib/errors.ts';
import { idList, idParam, likePattern, optBool, orderBy, paged, pagination, parse, strList } from '../lib/http.ts';
import { addDays, isIsoDate, nowIso, todayUtc } from '../lib/time.ts';
import { audit, getSetting } from '../services/core.ts';
import { ensureDefaultAlertRules, registerAlertEngine, resolveStateAlertsOfRule, runStateChecks } from '../services/alerts.ts';
import { flushNotifications, parseChannels, parsePrefs, SEVERITY_RANK, smtpStatus } from '../services/notifications.ts';
import { ALERT_TYPE_INFO, ALERT_TYPES, SEVERITIES, type AlertType, type Severity } from '../../shared/constants.ts';
import type {
  AlertBulkResult,
  AlertDetail,
  AlertNotificationRow,
  AlertRow,
  AlertRuleRow,
  AlertStatus,
  AlertSummary,
  AlertUnreadCount,
  NotificationChannel,
  NotificationChannels,
  NotificationPrefs,
} from '../../shared/api/alerts.ts';

const STATUSES: AlertStatus[] = ['open', 'acknowledged', 'resolved'];

const ALERT_SELECT = `
  SELECT a.id, a.rule_id, ar.name AS rule_name, a.type, a.severity, a.title, a.message, a.status,
    a.listing_id, l.code AS listing_code, a.product_id, p.code AS product_code, p.name AS product_name,
    p.brand_id, b.name AS brand_name, b.ownership, a.retailer_id, r.name AS retailer_name,
    a.market_id, m.code AS market_code, m.name AS market_name, m.timezone,
    a.observation_id, a.job_id, a.payload, a.triggered_at,
    a.acknowledged_by, ua.name AS acknowledged_by_name, a.acknowledged_at,
    a.resolved_by, ur.name AS resolved_by_name, a.resolved_at, a.resolution_note, a.is_demo
  FROM alerts a
  LEFT JOIN alert_rules ar ON ar.id = a.rule_id
  LEFT JOIN retailer_listings l ON l.id = a.listing_id
  LEFT JOIN products p ON p.id = a.product_id
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN retailers r ON r.id = a.retailer_id
  LEFT JOIN markets m ON m.id = a.market_id
  LEFT JOIN users ua ON ua.id = a.acknowledged_by
  LEFT JOIN users ur ON ur.id = a.resolved_by`;

type RawAlert = Omit<AlertRow, 'payload' | 'is_demo'> & { payload: string; is_demo: number };

function toAlert(row: RawAlert): AlertRow {
  let payload: AlertRow['payload'] = {};
  try {
    payload = JSON.parse(row.payload) as AlertRow['payload'];
  } catch {
    payload = {};
  }
  return { ...row, payload, is_demo: row.is_demo === 1 };
}

const RULE_SELECT = `
  SELECT ar.id, ar.name, ar.type, ar.is_enabled, ar.severity, ar.threshold_pct, ar.threshold_count, ar.threshold_hours,
    ar.market_id, m.name AS market_name, ar.retailer_id, r.name AS retailer_name, ar.brand_id, b.name AS brand_name,
    ar.category_id, c.name AS category_name, ar.product_id, p.name AS product_name, ar.channels, ar.cooldown_hours,
    ar.is_demo, ar.created_at, ar.updated_at,
    (SELECT COUNT(*) FROM alerts a WHERE a.rule_id = ar.id) AS alert_count,
    (SELECT COUNT(*) FROM alerts a WHERE a.rule_id = ar.id AND a.status IN ('open', 'acknowledged')) AS open_count,
    (SELECT MAX(a.triggered_at) FROM alerts a WHERE a.rule_id = ar.id) AS last_triggered_at
  FROM alert_rules ar
  LEFT JOIN markets m ON m.id = ar.market_id
  LEFT JOIN retailers r ON r.id = ar.retailer_id
  LEFT JOIN brands b ON b.id = ar.brand_id
  LEFT JOIN categories c ON c.id = ar.category_id
  LEFT JOIN products p ON p.id = ar.product_id`;

type RawRule = Omit<AlertRuleRow, 'channels' | 'is_enabled' | 'is_demo'> & { channels: string; is_enabled: number; is_demo: number };

const toRule = (row: RawRule): AlertRuleRow => ({
  ...row,
  channels: parseChannels(row.channels),
  is_enabled: row.is_enabled === 1,
  is_demo: row.is_demo === 1,
});

// Accept JSON numbers as well as numeric strings coming from form fields; `undefined` = not provided.
const numeric = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/, 'must be a number').transform(Number)]);
const optionalNumeric = z.union([numeric, z.null(), z.literal('').transform(() => null)]).optional();
const optionalBoolean = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === 1));

const ruleFields = {
  name: z.string().trim().min(1, 'is required').max(120),
  severity: z.enum(SEVERITIES).optional(),
  is_enabled: optionalBoolean,
  threshold_pct: optionalNumeric,
  threshold_count: optionalNumeric,
  threshold_hours: optionalNumeric,
  market_id: optionalNumeric,
  retailer_id: optionalNumeric,
  brand_id: optionalNumeric,
  category_id: optionalNumeric,
  product_id: optionalNumeric,
  channels: z.array(z.enum(['in_app', 'email', 'webhook'])).max(3).optional(),
  cooldown_hours: optionalNumeric,
};
const createRuleSchema = z.object({ ...ruleFields, type: z.enum(ALERT_TYPES) }).strict();
const updateRuleSchema = z.object({ ...ruleFields, name: ruleFields.name.optional(), type: z.enum(ALERT_TYPES).optional() }).strict();

interface RuleValues {
  name: string;
  type: AlertType;
  severity: Severity;
  is_enabled: boolean;
  threshold_pct: number | null;
  threshold_count: number | null;
  threshold_hours: number | null;
  market_id: number | null;
  retailer_id: number | null;
  brand_id: number | null;
  category_id: number | null;
  product_id: number | null;
  channels: NotificationChannel[];
  cooldown_hours: number;
}

/** Applies the per-type threshold rules and checks that scope references exist. Throws 422 with a precise reason. */
function validateRule(ctx: AppContext, v: RuleValues): RuleValues {
  const info = ALERT_TYPE_INFO[v.type];
  const out = { ...v };
  const reject = (field: string, why: string) => unprocessable(`${field} ${why}`, { issues: [{ path: field, message: why }] });

  if (info.threshold !== 'pct' && v.threshold_pct !== null) throw reject('threshold_pct', `does not apply to "${info.label}" rules`);
  if (info.threshold !== 'count' && v.threshold_count !== null) throw reject('threshold_count', `does not apply to "${info.label}" rules`);
  if (info.threshold !== 'hours' && v.threshold_hours !== null) throw reject('threshold_hours', `does not apply to "${info.label}" rules`);
  if (info.threshold === 'pct') {
    const pct = v.threshold_pct ?? info.defaultThreshold ?? 0;
    const max = v.type === 'competitor_promotion' ? 100 : 1000;
    if (!(pct >= 0) || pct > max) throw reject('threshold_pct', `must be between 0 and ${max}`);
    out.threshold_pct = pct;
  } else if (info.threshold === 'count') {
    const count = v.threshold_count ?? info.defaultThreshold ?? 3;
    if (!Number.isInteger(count) || count < 1 || count > 100) throw reject('threshold_count', 'must be a whole number between 1 and 100');
    out.threshold_count = count;
  } else if (info.threshold === 'hours' && v.threshold_hours !== null) {
    if (!(v.threshold_hours > 0) || v.threshold_hours > 8760) throw reject('threshold_hours', 'must be greater than 0 and at most 8760 (one year)');
  }

  const scopes: Array<[keyof RuleValues, string, string]> = [
    ['market_id', 'markets', 'Market'],
    ['retailer_id', 'retailers', 'Retailer'],
    ['brand_id', 'brands', 'Brand'],
    ['category_id', 'categories', 'Category'],
    ['product_id', 'products', 'Product'],
  ];
  for (const [field, table, label] of scopes) {
    const id = v[field] as number | null;
    if (id === null) continue;
    if (!Number.isInteger(id) || id <= 0) throw reject(field, 'must be a valid id');
    if (!ctx.db.get(`SELECT 1 AS ok FROM ${table} WHERE id = ?`, [id])) throw reject(field, `refers to a ${label.toLowerCase()} that does not exist`);
  }
  if (v.type === 'collection_failed' && (v.brand_id !== null || v.category_id !== null || v.product_id !== null)) {
    throw unprocessable('A collection rule can only be scoped by market or retailer');
  }
  if (v.retailer_id !== null && v.market_id !== null) {
    const retailer = ctx.db.get<{ market_id: number }>('SELECT market_id FROM retailers WHERE id = ?', [v.retailer_id]);
    if (retailer && retailer.market_id !== v.market_id) throw reject('retailer_id', 'does not belong to the selected market');
  }
  if (!(v.cooldown_hours >= 0) || v.cooldown_hours > 720) throw reject('cooldown_hours', 'must be between 0 and 720');
  out.channels = (['in_app', 'email', 'webhook'] as NotificationChannel[]).filter((c) => c === 'in_app' || v.channels.includes(c));
  return out;
}

const RULE_COLUMNS = [
  'name', 'type', 'severity', 'is_enabled', 'threshold_pct', 'threshold_count', 'threshold_hours', 'market_id', 'retailer_id',
  'brand_id', 'category_id', 'product_id', 'channels', 'cooldown_hours',
] as const;

function ruleParams(v: RuleValues): SqlParam[] {
  return [
    v.name, v.type, v.severity, v.is_enabled, v.threshold_pct, v.threshold_count, v.threshold_hours, v.market_id, v.retailer_id,
    v.brand_id, v.category_id, v.product_id, JSON.stringify(v.channels), v.cooldown_hours,
  ];
}

type AlertAction = 'acknowledge' | 'resolve' | 'reopen';

/** Applies a status transition. Returns false when the alert is already in the target state; throws on an invalid move. */
function transition(
  ctx: AppContext,
  alert: { id: number; status: AlertStatus },
  action: AlertAction,
  user: AuthUser,
  note: string | null,
  strict: boolean,
): boolean {
  const now = nowIso();
  if (action === 'acknowledge') {
    if (alert.status === 'acknowledged') return false;
    if (alert.status === 'resolved') {
      if (strict) throw conflict('This alert is already resolved. Reopen it first.');
      return false;
    }
    ctx.db.run(`UPDATE alerts SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?`, [user.id, now, alert.id]);
    return true;
  }
  if (action === 'resolve') {
    if (alert.status === 'resolved') return false;
    ctx.db.run(`UPDATE alerts SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?`, [user.id, now, note, alert.id]);
    return true;
  }
  if (alert.status === 'open') return false;
  ctx.db.run(
    `UPDATE alerts SET status = 'open', acknowledged_by = NULL, acknowledged_at = NULL, resolved_by = NULL, resolved_at = NULL, resolution_note = NULL WHERE id = ?`,
    [alert.id],
  );
  return true;
}

export default async function alertRoutes(app: FastifyInstance) {
  const { ctx } = app;

  ensureDefaultAlertRules(ctx);
  registerAlertEngine(ctx);
  app.addHook('onClose', async () => {
    await flushNotifications(ctx);
  });

  const getAlert = (id: number): AlertRow => {
    const row = ctx.db.get<RawAlert>(`${ALERT_SELECT} WHERE a.id = ?`, [id]);
    if (!row) throw notFound('Alert');
    return toAlert(row);
  };
  const getRule = (id: number): AlertRuleRow => {
    const row = ctx.db.get<RawRule>(`${RULE_SELECT} WHERE ar.id = ?`, [id]);
    if (!row) throw notFound('Alert rule');
    return toRule(row);
  };

  // ---- alerts -------------------------------------------------------------------------------
  app.get('/alerts', async (req) => {
    const query = req.query as Record<string, unknown>;
    const conditions: string[] = [];
    const params: SqlParam[] = [];
    const inList = (column: string, values: Array<string | number> | undefined) => {
      if (!values?.length) return;
      conditions.push(`${column} IN (${placeholders(values.length)})`);
      params.push(...values);
    };
    inList('a.status', strList(query.status)?.filter((s) => (STATUSES as string[]).includes(s)));
    inList('a.severity', strList(query.severity)?.filter((s) => (SEVERITIES as readonly string[]).includes(s)));
    inList('a.type', strList(query.type)?.filter((t) => (ALERT_TYPES as readonly string[]).includes(t)));
    inList('a.market_id', idList(query.market_id));
    inList('a.retailer_id', idList(query.retailer_id));
    inList('a.product_id', idList(query.product_id));
    inList('p.brand_id', idList(query.brand_id));
    inList('a.rule_id', idList(query.rule_id));
    for (const key of ['from', 'to'] as const) {
      const value = query[key];
      if (value === undefined || value === null || value === '') continue;
      if (!isIsoDate(value)) throw badRequest(`"${key}" must be a date in YYYY-MM-DD format`);
      if (key === 'from') {
        conditions.push('a.triggered_at >= ?');
        params.push(`${value}T00:00:00.000Z`);
      } else {
        conditions.push('a.triggered_at < ?');
        params.push(`${addDays(value, 1)}T00:00:00.000Z`);
      }
    }
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q) {
      const pattern = likePattern(q);
      conditions.push(`(a.title LIKE ? ESCAPE '\\' OR a.message LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern);
    }
    const demo = optBool(query.is_demo);
    if (demo !== undefined) {
      conditions.push('a.is_demo = ?');
      params.push(demo ? 1 : 0);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const page = pagination(query, 50, 200);
    const order = orderBy(
      query.sort,
      {
        triggered_at: 'a.triggered_at',
        severity: `CASE a.severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END`,
        status: `CASE a.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END`,
        type: 'a.type',
      },
      'a.triggered_at DESC',
    );
    const total =
      ctx.db.scalar<number>(`SELECT COUNT(*) FROM alerts a LEFT JOIN products p ON p.id = a.product_id ${where}`, params) ?? 0;
    const rows = ctx.db
      .all<RawAlert>(`${ALERT_SELECT} ${where} ORDER BY ${order}, a.id DESC LIMIT ? OFFSET ?`, [...params, page.pageSize, page.offset])
      .map(toAlert);
    return paged(rows, total, page);
  });

  app.get('/alerts/summary', async (req): Promise<AlertSummary> => {
    const query = req.query as Record<string, unknown>;
    const days = Math.min(90, Math.max(1, Math.floor(Number(query.days ?? 14)) || 14));
    const today = todayUtc();
    const fromDate = addDays(today, -(days - 1));
    const since = `${fromDate}T00:00:00.000Z`;
    const byStatus = new Map(ctx.db.all<{ status: AlertStatus; n: number }>('SELECT status, COUNT(*) AS n FROM alerts GROUP BY status').map((r) => [r.status, r.n]));
    const active_by_severity: Record<Severity, number> = { info: 0, warning: 0, critical: 0 };
    for (const r of ctx.db.all<{ severity: Severity; n: number }>(
      `SELECT severity, COUNT(*) AS n FROM alerts WHERE status IN ('open', 'acknowledged') GROUP BY severity`,
    )) {
      active_by_severity[r.severity] = r.n;
    }
    const typeRows = new Map(
      ctx.db
        .all<{ type: AlertType; total: number; active: number }>(
          `SELECT type, COUNT(*) AS total, SUM(CASE WHEN status IN ('open', 'acknowledged') THEN 1 ELSE 0 END) AS active
           FROM alerts WHERE triggered_at >= ? GROUP BY type`,
          [since],
        )
        .map((r) => [r.type, r]),
    );
    const trendRows = ctx.db.all<{ d: string; severity: Severity; n: number }>(
      `SELECT substr(triggered_at, 1, 10) AS d, severity, COUNT(*) AS n FROM alerts WHERE triggered_at >= ? GROUP BY d, severity`,
      [since],
    );
    const trend: AlertSummary['trend'] = [];
    for (let i = 0; i < days; i++) trend.push({ date: addDays(fromDate, i), total: 0, info: 0, warning: 0, critical: 0 });
    const byDate = new Map(trend.map((t) => [t.date, t]));
    let triggered = 0;
    for (const r of trendRows) {
      const day = byDate.get(r.d);
      if (!day) continue;
      day[r.severity] += r.n;
      day.total += r.n;
      triggered += r.n;
    }
    return {
      days,
      open: byStatus.get('open') ?? 0,
      acknowledged: byStatus.get('acknowledged') ?? 0,
      resolved: byStatus.get('resolved') ?? 0,
      demo_active: ctx.db.scalar<number>(`SELECT COUNT(*) FROM alerts WHERE status IN ('open', 'acknowledged') AND is_demo = 1`) ?? 0,
      active_by_severity,
      by_type: ALERT_TYPES.map((type) => ({
        type,
        label: ALERT_TYPE_INFO[type].label,
        total: typeRows.get(type)?.total ?? 0,
        active: typeRows.get(type)?.active ?? 0,
      })),
      trend,
      triggered_in_period: triggered,
    };
  });

  app.get('/alerts/unread-count', async (req): Promise<AlertUnreadCount> => {
    const row = ctx.db.get<{ notification_prefs: string }>('SELECT notification_prefs FROM users WHERE id = ?', [req.user!.id]);
    const prefs = parsePrefs(row?.notification_prefs);
    const counts = ctx.db.all<{ severity: Severity; n: number }>(`SELECT severity, COUNT(*) AS n FROM alerts WHERE status = 'open' GROUP BY severity`);
    const total = counts.reduce((sum, c) => sum + c.n, 0);
    if (!prefs.in_app) return { open: 0, critical: 0, total_open: total };
    const visible = counts.filter((c) => SEVERITY_RANK[c.severity] >= SEVERITY_RANK[prefs.min_severity]);
    return {
      open: visible.reduce((sum, c) => sum + c.n, 0),
      critical: visible.find((c) => c.severity === 'critical')?.n ?? 0,
      total_open: total,
    };
  });

  app.get('/alerts/:id', async (req): Promise<AlertDetail> => {
    const alert = getAlert(idParam((req.params as { id: string }).id));
    const notifications = ctx.db.all<AlertNotificationRow>(
      'SELECT id, alert_id, channel, recipient, status, error, created_at FROM alert_notifications WHERE alert_id = ? ORDER BY id',
      [alert.id],
    );
    return { ...alert, notifications };
  });

  for (const action of ['acknowledge', 'resolve', 'reopen'] as const) {
    app.post(`/alerts/:id/${action}`, { config: { permission: 'alerts.manage' } }, async (req) => {
      const id = idParam((req.params as { id: string }).id);
      const body = parse(z.object({ note: z.string().trim().max(1000).nullish() }), req.body);
      const alert = getAlert(id);
      const changed = transition(ctx, alert, action, req.user!, body.note || null, true);
      if (changed) audit(ctx, req.user, `alert.${action}`, 'alert', id, body.note ? { note: body.note } : undefined, req.ip);
      return getAlert(id);
    });
  }

  app.post('/alerts/bulk', { config: { permission: 'alerts.manage' } }, async (req): Promise<AlertBulkResult> => {
    const body = parse(
      z.object({
        ids: z.array(z.number().int().positive()).min(1).max(1000),
        action: z.enum(['acknowledge', 'resolve', 'reopen']),
        note: z.string().trim().max(1000).nullish(),
      }),
      req.body,
    );
    const ids = [...new Set(body.ids)];
    let updated = 0;
    ctx.db.tx(() => {
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        const rows = ctx.db.all<{ id: number; status: AlertStatus }>(`SELECT id, status FROM alerts WHERE id IN (${placeholders(chunk.length)})`, chunk);
        for (const row of rows) if (transition(ctx, row, body.action, req.user!, body.note || null, false)) updated++;
      }
    });
    audit(ctx, req.user, `alert.bulk_${body.action}`, 'alert', null, { requested: ids.length, updated }, req.ip);
    return { updated, skipped: ids.length - updated };
  });

  app.post('/alerts/evaluate', { config: { permission: 'alerts.manage' } }, async (req) => {
    const result = runStateChecks(ctx);
    audit(ctx, req.user, 'alert.evaluate', null, null, { stale: result.stale_observation, collection_failed: result.collection_failed }, req.ip);
    return result;
  });

  // ---- rules --------------------------------------------------------------------------------
  app.get('/alert-rules', async () => {
    const rows = ctx.db.all<RawRule>(`${RULE_SELECT} ORDER BY ar.id`).map(toRule);
    return { rows, types: ALERT_TYPE_INFO };
  });

  app.post('/alert-rules', { config: { permission: 'alerts.manage' } }, async (req, reply) => {
    const body = parse(createRuleSchema, req.body, 'alert rule');
    const values = validateRule(ctx, {
      name: body.name,
      type: body.type,
      severity: body.severity ?? 'warning',
      is_enabled: body.is_enabled ?? true,
      threshold_pct: body.threshold_pct ?? null,
      threshold_count: body.threshold_count ?? null,
      threshold_hours: body.threshold_hours ?? null,
      market_id: body.market_id ?? null,
      retailer_id: body.retailer_id ?? null,
      brand_id: body.brand_id ?? null,
      category_id: body.category_id ?? null,
      product_id: body.product_id ?? null,
      channels: body.channels ?? ['in_app'],
      cooldown_hours: body.cooldown_hours ?? 0,
    });
    const now = nowIso();
    const id = ctx.db.run(
      `INSERT INTO alert_rules (${RULE_COLUMNS.join(', ')}, created_by, is_demo, created_at, updated_at)
       VALUES (${placeholders(RULE_COLUMNS.length)}, ?, 0, ?, ?)`,
      [...ruleParams(values), req.user!.id, now, now],
    ).lastInsertRowid;
    audit(ctx, req.user, 'alert_rule.create', 'alert_rule', id, { name: values.name, type: values.type }, req.ip);
    return reply.code(201).send(getRule(id));
  });

  app.patch('/alert-rules/:id', { config: { permission: 'alerts.manage' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const existing = getRule(id);
    const body = parse(updateRuleSchema, req.body, 'alert rule');
    if (body.type !== undefined && body.type !== existing.type) {
      throw unprocessable('The type of an alert rule cannot be changed. Create a new rule instead.');
    }
    const pick = <T>(incoming: T | undefined, current: T): T => (incoming === undefined ? current : incoming);
    const values = validateRule(ctx, {
      name: body.name ?? existing.name,
      type: existing.type,
      severity: body.severity ?? existing.severity,
      is_enabled: body.is_enabled ?? existing.is_enabled,
      threshold_pct: pick(body.threshold_pct, existing.threshold_pct),
      threshold_count: pick(body.threshold_count, existing.threshold_count),
      threshold_hours: pick(body.threshold_hours, existing.threshold_hours),
      market_id: pick(body.market_id, existing.market_id),
      retailer_id: pick(body.retailer_id, existing.retailer_id),
      brand_id: pick(body.brand_id, existing.brand_id),
      category_id: pick(body.category_id, existing.category_id),
      product_id: pick(body.product_id, existing.product_id),
      channels: body.channels ?? existing.channels,
      cooldown_hours: body.cooldown_hours ?? existing.cooldown_hours,
    });
    ctx.db.run(`UPDATE alert_rules SET ${RULE_COLUMNS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...ruleParams(values), nowIso(), id]);
    if (existing.is_enabled && !values.is_enabled) resolveStateAlertsOfRule(ctx, id, 'Resolved automatically: the alert rule was switched off.');
    audit(ctx, req.user, 'alert_rule.update', 'alert_rule', id, body, req.ip);
    return getRule(id);
  });

  app.post('/alert-rules/:id/toggle', { config: { permission: 'alerts.manage' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const existing = getRule(id);
    const body = parse(z.object({ enabled: z.boolean().optional() }), req.body);
    const enabled = body.enabled ?? !existing.is_enabled;
    ctx.db.run('UPDATE alert_rules SET is_enabled = ?, updated_at = ? WHERE id = ?', [enabled, nowIso(), id]);
    if (!enabled) resolveStateAlertsOfRule(ctx, id, 'Resolved automatically: the alert rule was switched off.');
    audit(ctx, req.user, enabled ? 'alert_rule.enable' : 'alert_rule.disable', 'alert_rule', id, null, req.ip);
    return getRule(id);
  });

  app.delete('/alert-rules/:id', { config: { permission: 'alerts.manage' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const existing = getRule(id);
    // Alerts already raised by the rule are history: they stay (their rule reference is cleared). Its open
    // state alerts are closed first because nothing would resolve them afterwards.
    ctx.db.tx(() => {
      resolveStateAlertsOfRule(ctx, id, 'Resolved automatically: the alert rule was deleted.');
      ctx.db.run('DELETE FROM alert_rules WHERE id = ?', [id]);
    });
    audit(ctx, req.user, 'alert_rule.delete', 'alert_rule', id, { name: existing.name, type: existing.type }, req.ip);
    return { ok: true };
  });

  // ---- personal notification preferences ----------------------------------------------------
  /** Which delivery channels are set up — readiness only, no addresses or hosts — so every user can see what "e-mail" will do. */
  app.get('/me/notification-channels', async (): Promise<NotificationChannels> => ({
    in_app: true,
    email: smtpStatus(ctx).configured,
    webhook: !!getSetting(ctx, 'alert_webhook_url'),
  }));

  app.get('/me/notification-prefs', async (req): Promise<NotificationPrefs> => {
    const row = ctx.db.get<{ notification_prefs: string }>('SELECT notification_prefs FROM users WHERE id = ?', [req.user!.id]);
    return parsePrefs(row?.notification_prefs);
  });

  app.put('/me/notification-prefs', { config: { permission: 'any' } }, async (req): Promise<NotificationPrefs> => {
    const body = parse(
      z.object({ in_app: z.boolean().optional(), email: z.boolean().optional(), min_severity: z.enum(SEVERITIES).optional() }).strict(),
      req.body,
      'notification preferences',
    );
    const row = ctx.db.get<{ notification_prefs: string }>('SELECT notification_prefs FROM users WHERE id = ?', [req.user!.id]);
    if (!row) throw new AppError(404, 'not_found', 'User not found');
    const next: NotificationPrefs = { ...parsePrefs(row.notification_prefs), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    ctx.db.run('UPDATE users SET notification_prefs = ?, updated_at = ? WHERE id = ?', [JSON.stringify(next), nowIso(), req.user!.id]);
    return next;
  });
}
