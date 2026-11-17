/**
 * Administration: users and roles, settings, integrations (with honest status), exchange rates,
 * audit log, system information and DEMO dataset management.
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { createUser, revokeUserSessions, setPassword } from '../auth/auth.ts';
import { placeholders, type SqlParam } from '../db/sqlite.ts';
import { passwordProblem, randomPassword } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../lib/errors.ts';
import { idList, idParam, likePattern, paged, pagination, parse } from '../lib/http.ts';
import { assertAllowedUrl, NetError } from '../lib/net.ts';
import { addDays, isIsoDate, nowIso } from '../lib/time.ts';
import { audit, deleteSecret, getAllSettings, getSetting, secretStatus, setSecret, setSetting, SETTING_DEFAULTS } from '../services/core.ts';
import { rebuildAllDerived } from '../services/derived.ts';
import { fetchRatesFromProvider, FX_BASE, latestRates, recordRate } from '../services/fx.ts';
import { maskUrl, parsePrefs, sendTestEmail, sendTestWebhook, SMTP_PASSWORD_SECRET, smtpStatus } from '../services/notifications.ts';
import { PERMISSIONS, ROLE_KEYS, roleCan, type Permission, type RoleKey } from '../../shared/constants.ts';
import type {
  AdminSettings,
  AuditLogRow,
  CreateUserResponse,
  DemoActionResult,
  ExchangeRateHistoryRow,
  ExchangeRatesResponse,
  FxFetchResult,
  IntegrationsStatus,
  PublicSettings,
  ResetPasswordResponse,
  RoleRow,
  SmtpTestResult,
  SystemInfo,
  UserRow,
  WebhookTestResult,
} from '../../shared/api/admin.ts';

const AI_KEY_SECRET = 'integration:anthropic:api_key';
const FX_KEY_SECRET = 'integration:fx:api_key';
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const FROM_ADDRESS = /^(?:[^<>@]+<\s*)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*>?$/;
const FX_REFRESH_INTERVAL_MS = 24 * 3_600_000;
const FX_RETRY_INTERVAL_MS = 6 * 3_600_000;

const numeric = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/, 'must be a number').transform(Number)]);
const email = z.string().trim().max(200).regex(EMAIL, 'must be a valid e-mail address');

type RawUser = Omit<UserRow, 'is_active' | 'must_change_password' | 'uses_default_password' | 'locked'> & {
  is_active: number;
  must_change_password: number;
  uses_default_password: number;
  locked_until: string | null;
};

const USER_SELECT = `
  SELECT u.id, u.email, u.name, r.key AS role, r.name AS role_name, u.is_active, u.must_change_password, u.uses_default_password,
    u.locked_until, u.last_login_at, u.created_at, u.updated_at,
    (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS active_sessions
  FROM users u JOIN roles r ON r.id = u.role_id`;

function toUser(row: RawUser): UserRow {
  const { locked_until, ...rest } = row;
  return {
    ...rest,
    is_active: row.is_active === 1,
    must_change_password: row.must_change_password === 1,
    uses_default_password: row.uses_default_password === 1,
    locked: !!locked_until && locked_until > nowIso(),
  };
}

/** Shows only what identifies the provider: the built-in default in full, anything else with its path masked (it may embed a key). */
function displayProviderUrl(url: string | null): string | null {
  if (!url) return null;
  return url === SETTING_DEFAULTS.fx_provider_url ? url : maskUrl(url);
}

function adminSettings(ctx: AppContext): AdminSettings {
  const s = getAllSettings(ctx);
  return {
    reporting_currency: s.reporting_currency,
    organisation_name: s.organisation_name,
    promo_gap_days: s.promo_gap_days,
    alert_max_age_hours: s.alert_max_age_hours,
    collection_max_retries: s.collection_max_retries,
    demo_epoch: s.demo_epoch,
    fx_provider: displayProviderUrl(s.fx_provider_url),
    fx_auto_refresh: s.fx_auto_refresh,
    alert_webhook: { configured: !!s.alert_webhook_url, target: maskUrl(s.alert_webhook_url) },
    smtp: s.smtp,
    alert_email_recipients: s.alert_email_recipients ?? [],
    ai: s.ai,
  };
}

function integrations(ctx: AppContext): IntegrationsStatus {
  const s = getAllSettings(ctx);
  const aiKey = secretStatus(ctx, AI_KEY_SECRET);
  const envKey = !!ctx.config.anthropicApiKey;
  const aiReady = s.ai.provider === 'anthropic' && (aiKey.configured || envKey);
  const smtp = smtpStatus(ctx);
  const subscribed = ctx.db
    .all<{ notification_prefs: string }>('SELECT notification_prefs FROM users WHERE is_active = 1')
    .filter((u) => parsePrefs(u.notification_prefs).email).length;
  const latestReal = ctx.db.get<{ as_of: string; source: string }>(
    'SELECT as_of, source FROM exchange_rates WHERE is_demo = 0 ORDER BY as_of DESC, id DESC LIMIT 1',
  );
  const anyRate = (ctx.db.scalar<number>('SELECT COUNT(*) FROM exchange_rates') ?? 0) > 0;
  return {
    ai: {
      provider: s.ai.provider,
      model: s.ai.model,
      api_key: aiKey,
      env_key_present: envKey,
      state: s.ai.provider === 'builtin' ? 'built_in' : aiReady ? 'ready' : 'not_configured',
      explanation:
        s.ai.provider === 'builtin'
          ? 'The assistant uses the built-in query engine: it answers a fixed range of pricing questions directly from stored records and needs no external service. To understand free-form questions, select Anthropic Claude and provide an API key (created at console.anthropic.com).'
          : aiReady
            ? `Anthropic Claude (${s.ai.model}) turns each question into a structured query; the answer and every figure in it are then computed from the stored records, and no prices are sent to the model. The API key is ${aiKey.configured ? 'stored encrypted in this database' : 'read from the ANTHROPIC_API_KEY environment variable'}.`
            : 'Anthropic Claude is selected but no API key is available. Enter a key here or set ANTHROPIC_API_KEY on the server; until then the assistant falls back to the built-in query engine.',
    },
    smtp: {
      configured: smtp.configured,
      host: smtp.smtp?.host ?? null,
      port: smtp.smtp?.port ?? null,
      secure: smtp.smtp?.secure ?? null,
      user: smtp.smtp?.user ?? null,
      from: smtp.smtp?.from ?? null,
      password: secretStatus(ctx, SMTP_PASSWORD_SECRET),
      recipients: s.alert_email_recipients ?? [],
      subscribed_users: subscribed,
      state: smtp.configured ? 'ready' : 'not_configured',
      explanation: smtp.configured
        ? 'Alert e-mails are sent through this SMTP server to users who enabled e-mail notifications and to the extra recipients listed here. Use "Send test e-mail" to verify delivery.'
        : `E-mail notifications are not configured (missing ${smtp.missing.join(' and ')}). Required: SMTP host and port, whether the connection uses TLS, a sender address and — if your server needs it — a user name and password. Until then e-mail deliveries are recorded as "not configured".`,
    },
    webhook: {
      configured: !!s.alert_webhook_url,
      target: maskUrl(s.alert_webhook_url),
      state: s.alert_webhook_url ? 'ready' : 'not_configured',
      explanation: s.alert_webhook_url
        ? 'Alerts whose rule includes the webhook channel are POSTed as JSON to this endpoint, one request per batch. The full URL is hidden because it usually contains a token.'
        : 'No webhook is configured. Provide an HTTPS endpoint that accepts a JSON POST (for example a chat incoming-webhook URL). Until then webhook deliveries are recorded as "not configured".',
    },
    fx: {
      provider: displayProviderUrl(s.fx_provider_url),
      uses_default_provider: s.fx_provider_url === SETTING_DEFAULTS.fx_provider_url,
      auto_refresh: s.fx_auto_refresh,
      api_key: secretStatus(ctx, FX_KEY_SECRET),
      latest_as_of: latestReal?.as_of ?? null,
      latest_source: latestReal?.source ?? null,
      only_demo_rates: anyRate && !latestReal,
      state: latestReal ? 'ready' : 'not_configured',
      explanation: latestReal
        ? `Cross-currency comparisons use the stored exchange rates; the most recent real rate is from ${latestReal.source} as of ${latestReal.as_of}. Every converted figure shows the rate timestamp and source.`
        : anyRate
          ? 'Only illustrative DEMO exchange rates are stored. Fetch rates from the provider or enter them manually before relying on converted comparisons.'
          : 'No exchange rates are stored, so prices in different currencies cannot be compared yet. Fetch rates from the provider (a JSON "latest rates" endpoint with USD base) or enter them manually.',
    },
  };
}

function parseAsOf(value: string | undefined): string {
  if (!value) return nowIso();
  const date = isIsoDate(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) throw unprocessable('as_of must be a date (YYYY-MM-DD) or an ISO-8601 timestamp');
  if (date.getTime() > Date.now() + 5 * 60_000) throw unprocessable('as_of cannot be in the future');
  if (date.getUTCFullYear() < 2000) throw unprocessable('as_of is implausibly old');
  return date.toISOString();
}

async function validatedUrl(ctx: AppContext, url: string, what: string): Promise<string> {
  try {
    return (await assertAllowedUrl(ctx, url)).toString();
  } catch (err) {
    if (err instanceof NetError) throw unprocessable(`${what}: ${err.message}`);
    throw err;
  }
}

const COUNTED_TABLES = [
  'users', 'markets', 'currencies', 'brands', 'categories', 'products', 'product_variants', 'retailers', 'retailer_listings',
  'competitor_mappings', 'price_observations', 'observation_voids', 'promotions', 'price_events', 'collection_jobs',
  'collection_logs', 'import_batches', 'source_evidence', 'exchange_rates', 'alert_rules', 'alerts', 'audit_log',
];
const DEMO_TABLES = [
  'brands', 'categories', 'products', 'retailers', 'retailer_listings', 'competitor_mappings', 'price_observations',
  'promotions', 'collection_jobs', 'import_batches', 'source_evidence', 'exchange_rates', 'alerts',
];

function demoDataPresent(ctx: AppContext): boolean {
  return ['products', 'retailers', 'brands', 'price_observations'].some(
    (table) => (ctx.db.scalar<number>(`SELECT EXISTS (SELECT 1 FROM ${table} WHERE is_demo = 1)`) ?? 0) === 1,
  );
}

export default async function adminRoutes(app: FastifyInstance) {
  const { ctx } = app;

  const getUser = (id: number): UserRow => {
    const row = ctx.db.get<RawUser>(`${USER_SELECT} WHERE u.id = ?`, [id]);
    if (!row) throw notFound('User');
    return toUser(row);
  };
  const otherActiveAdmins = (exceptUserId: number): number =>
    ctx.db.scalar<number>(
      `SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'admin' AND u.is_active = 1 AND u.id <> ?`,
      [exceptUserId],
    ) ?? 0;

  // ---- users & roles ------------------------------------------------------------------------
  app.get('/users', { config: { permission: 'admin.users' } }, async () => {
    return { rows: ctx.db.all<RawUser>(`${USER_SELECT} ORDER BY u.is_active DESC, u.name COLLATE NOCASE`).map(toUser) };
  });

  app.get('/roles', async (): Promise<{ rows: RoleRow[] }> => {
    const rows = ctx.db.all<{ key: RoleKey; name: string; description: string; user_count: number }>(
      `SELECT r.key, r.name, r.description, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_active = 1) AS user_count
       FROM roles r ORDER BY r.id`,
    );
    return {
      rows: rows.map((r) => ({ ...r, permissions: (Object.keys(PERMISSIONS) as Permission[]).filter((p) => roleCan(r.key, p)) })),
    };
  });

  app.post('/users', { config: { permission: 'admin.users' } }, async (req, reply): Promise<CreateUserResponse> => {
    const body = parse(
      z.object({
        email,
        name: z.string().trim().min(1, 'is required').max(120),
        role: z.enum(ROLE_KEYS),
        password: z.string().max(200).nullish(),
        // Only meaningful with a supplied password; a generated password must always be changed.
        must_change_password: z.boolean().optional(),
      }),
      req.body,
      'user',
    );
    if (ctx.db.get('SELECT 1 AS ok FROM users WHERE email = ?', [body.email.toLowerCase()])) {
      throw conflict('A user with this e-mail address already exists');
    }
    let generated: string | null = null;
    let password = body.password ?? '';
    if (password) {
      const problem = passwordProblem(password);
      if (problem) throw unprocessable(problem);
    } else {
      generated = randomPassword();
      password = generated;
    }
    // A password set by an administrator is temporary by default: the person chooses their own at first sign-in.
    const mustChange = generated !== null || body.must_change_password !== false;
    const id = await createUser(ctx, { email: body.email, name: body.name, role: body.role, password, mustChangePassword: mustChange });
    audit(ctx, req.user, 'user.create', 'user', id, { email: body.email.toLowerCase(), role: body.role }, req.ip);
    reply.code(201);
    return { user: getUser(id), generated_password: generated };
  });

  app.patch('/users/:id', { config: { permission: 'admin.users' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const existing = getUser(id);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(120).optional(), role: z.enum(ROLE_KEYS).optional(), is_active: z.boolean().optional() }).strict(),
      req.body,
      'user',
    );
    const roleChanges = body.role !== undefined && body.role !== existing.role;
    const deactivates = body.is_active === false && existing.is_active;
    if (id === req.user!.id && (roleChanges || deactivates)) {
      throw conflict('You cannot change your own role or deactivate your own account. Ask another administrator.');
    }
    if (existing.role === 'admin' && existing.is_active && (deactivates || (roleChanges && body.role !== 'admin')) && otherActiveAdmins(id) === 0) {
      throw conflict('At least one active administrator is required');
    }
    const sets: string[] = [];
    const params: SqlParam[] = [];
    if (body.name !== undefined) {
      sets.push('name = ?');
      params.push(body.name);
    }
    if (roleChanges) {
      sets.push('role_id = (SELECT id FROM roles WHERE key = ?)');
      params.push(body.role!);
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?');
      params.push(body.is_active);
    }
    if (sets.length) {
      ctx.db.run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...params, nowIso(), id]);
      if (deactivates) revokeUserSessions(ctx, id);
      audit(ctx, req.user, 'user.update', 'user', id, body, req.ip);
    }
    return getUser(id);
  });

  app.post('/users/:id/reset-password', { config: { permission: 'admin.users' } }, async (req): Promise<ResetPasswordResponse> => {
    const id = idParam((req.params as { id: string }).id);
    const existing = getUser(id);
    if (id === req.user!.id) throw badRequest('Use "Change password" to change your own password');
    const temporary = randomPassword();
    await setPassword(ctx, id, temporary, true);
    revokeUserSessions(ctx, id);
    audit(ctx, req.user, 'user.reset_password', 'user', id, { email: existing.email }, req.ip);
    return { user: getUser(id), temporary_password: temporary };
  });

  // ---- settings -----------------------------------------------------------------------------
  app.get('/settings', async (req): Promise<PublicSettings | AdminSettings> => {
    if (roleCan(req.user!.role, 'admin.settings')) return adminSettings(ctx);
    return { reporting_currency: getSetting(ctx, 'reporting_currency'), organisation_name: getSetting(ctx, 'organisation_name') };
  });

  app.put('/settings', { config: { permission: 'admin.settings' } }, async (req) => {
    const body = parse(
      z
        .object({
          reporting_currency: z.string().trim().toUpperCase().length(3, 'must be a 3-letter currency code').optional(),
          organisation_name: z.string().trim().max(120, 'must be at most 120 characters').optional(),
          promo_gap_days: numeric.optional(),
          alert_max_age_hours: numeric.optional(),
          collection_max_retries: numeric.optional(),
        })
        .strict(),
      req.body,
      'settings',
    );
    const range = (value: number, min: number, max: number, field: string, whole: boolean) => {
      if (value < min || value > max || (whole && !Number.isInteger(value))) {
        throw unprocessable(`${field} must be ${whole ? 'a whole number ' : ''}between ${min} and ${max}`, { issues: [{ path: field, message: 'out of range' }] });
      }
    };
    if (body.reporting_currency !== undefined && !ctx.db.get('SELECT 1 AS ok FROM currencies WHERE code = ?', [body.reporting_currency])) {
      throw unprocessable(`reporting_currency: ${body.reporting_currency} is not a known currency`, { issues: [{ path: 'reporting_currency', message: 'unknown currency' }] });
    }
    if (body.promo_gap_days !== undefined) range(body.promo_gap_days, 1, 60, 'promo_gap_days', true);
    if (body.alert_max_age_hours !== undefined) range(body.alert_max_age_hours, 1, 720, 'alert_max_age_hours', false);
    if (body.collection_max_retries !== undefined) range(body.collection_max_retries, 0, 5, 'collection_max_retries', true);

    const previousGap = getSetting(ctx, 'promo_gap_days');
    const userId = req.user!.id;
    ctx.db.tx(() => {
      if (body.reporting_currency !== undefined) setSetting(ctx, 'reporting_currency', body.reporting_currency, userId);
      if (body.organisation_name !== undefined) setSetting(ctx, 'organisation_name', body.organisation_name, userId);
      if (body.promo_gap_days !== undefined) setSetting(ctx, 'promo_gap_days', body.promo_gap_days, userId);
      if (body.alert_max_age_hours !== undefined) setSetting(ctx, 'alert_max_age_hours', body.alert_max_age_hours, userId);
      if (body.collection_max_retries !== undefined) setSetting(ctx, 'collection_max_retries', body.collection_max_retries, userId);
    });
    let rebuilt: number | null = null;
    if (body.promo_gap_days !== undefined && body.promo_gap_days !== previousGap) {
      // Promotion episodes depend on this setting, so they are recomputed from the ledger.
      rebuilt = rebuildAllDerived(ctx);
    }
    audit(ctx, req.user, 'settings.update', 'settings', null, body, req.ip);
    return { settings: adminSettings(ctx), rebuilt_listings: rebuilt };
  });

  // ---- integrations -------------------------------------------------------------------------
  app.get('/integrations', { config: { permission: 'admin.integrations' } }, async () => integrations(ctx));

  app.put('/integrations/ai', { config: { permission: 'admin.integrations' } }, async (req) => {
    const body = parse(
      z.object({
        provider: z.enum(['builtin', 'anthropic']),
        model: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:\-\[\]]+$/, 'is not a valid model identifier').optional(),
        api_key: z.string().trim().max(500).optional(),
      }),
      req.body,
      'AI integration',
    );
    setSetting(ctx, 'ai', { provider: body.provider, model: body.model ?? getSetting(ctx, 'ai').model }, req.user!.id);
    if (body.api_key) setSecret(ctx, AI_KEY_SECRET, body.api_key, req.user!.id);
    audit(ctx, req.user, 'integration.ai.update', 'integration', 'ai', { provider: body.provider, model: body.model, api_key_updated: !!body.api_key }, req.ip);
    return integrations(ctx).ai;
  });

  app.delete('/integrations/ai/key', { config: { permission: 'admin.integrations' } }, async (req) => {
    deleteSecret(ctx, AI_KEY_SECRET);
    audit(ctx, req.user, 'integration.ai.key_removed', 'integration', 'ai', null, req.ip);
    return integrations(ctx).ai;
  });

  const clearSmtp = (userId: number) => {
    setSetting(ctx, 'smtp', null, userId);
    deleteSecret(ctx, SMTP_PASSWORD_SECRET);
  };

  app.put('/integrations/smtp', { config: { permission: 'admin.integrations' } }, async (req) => {
    if (req.body === null || (req.body as { clear?: unknown } | undefined)?.clear === true) {
      clearSmtp(req.user!.id);
      audit(ctx, req.user, 'integration.smtp.clear', 'integration', 'smtp', null, req.ip);
      return integrations(ctx).smtp;
    }
    const body = parse(
      z.object({
        host: z.string().trim().min(1, 'is required').max(255).regex(/^[A-Za-z0-9.\-_\[\]:]+$/, 'must be a host name'),
        port: numeric.refine((n) => Number.isInteger(n) && n >= 1 && n <= 65535, 'must be between 1 and 65535'),
        secure: z.boolean(),
        user: z.string().trim().max(255).nullish(),
        from: z.string().trim().min(3).max(255).regex(FROM_ADDRESS, 'must be an e-mail address, e.g. alerts@example.com or "Price Alerts <alerts@example.com>"'),
        password: z.string().max(500).optional(),
        recipients: z.array(email).max(50).optional(),
      }),
      req.body,
      'SMTP settings',
    );
    setSetting(ctx, 'smtp', { host: body.host, port: body.port, secure: body.secure, user: body.user ?? '', from: body.from }, req.user!.id);
    if (body.password) setSecret(ctx, SMTP_PASSWORD_SECRET, body.password, req.user!.id);
    if (body.recipients) setSetting(ctx, 'alert_email_recipients', [...new Set(body.recipients.map((r) => r.toLowerCase()))], req.user!.id);
    audit(
      ctx,
      req.user,
      'integration.smtp.update',
      'integration',
      'smtp',
      { host: body.host, port: body.port, secure: body.secure, user: body.user ?? '', from: body.from, password_updated: !!body.password, recipients: body.recipients?.length },
      req.ip,
    );
    return integrations(ctx).smtp;
  });

  app.delete('/integrations/smtp', { config: { permission: 'admin.integrations' } }, async (req) => {
    clearSmtp(req.user!.id);
    audit(ctx, req.user, 'integration.smtp.clear', 'integration', 'smtp', null, req.ip);
    return integrations(ctx).smtp;
  });

  app.post('/integrations/smtp/test', { config: { permission: 'admin.integrations' } }, async (req): Promise<SmtpTestResult> => {
    const body = parse(z.object({ to: email }), req.body);
    const { configured, ...result } = await sendTestEmail(ctx, body.to);
    if (!configured) throw new AppError(400, 'not_configured', result.error ?? 'E-mail is not configured');
    audit(ctx, req.user, 'integration.smtp.test', 'integration', 'smtp', { to: body.to, ok: result.ok, error: result.error }, req.ip);
    return result;
  });

  app.put('/integrations/webhook', { config: { permission: 'admin.integrations' } }, async (req) => {
    const body = parse(z.object({ url: z.string().trim().max(2000).nullable() }), req.body, 'webhook');
    const url = body.url ? await validatedUrl(ctx, body.url, 'Webhook URL') : null;
    setSetting(ctx, 'alert_webhook_url', url, req.user!.id);
    audit(ctx, req.user, url ? 'integration.webhook.update' : 'integration.webhook.clear', 'integration', 'webhook', { target: maskUrl(url) }, req.ip);
    return integrations(ctx).webhook;
  });

  app.post('/integrations/webhook/test', { config: { permission: 'admin.integrations' } }, async (req): Promise<WebhookTestResult> => {
    const { configured, ...result } = await sendTestWebhook(ctx);
    if (!configured) throw new AppError(400, 'not_configured', result.error ?? 'No webhook URL is configured');
    audit(ctx, req.user, 'integration.webhook.test', 'integration', 'webhook', { ok: result.ok, status: result.status, error: result.error }, req.ip);
    return result;
  });

  app.put('/integrations/fx', { config: { permission: 'admin.integrations' } }, async (req) => {
    const body = parse(
      z.object({
        // Omit (or send an empty string) to keep the current endpoint; send "default" to restore the built-in provider.
        provider_url: z.string().trim().max(2000).optional(),
        auto_refresh: z.boolean().optional(),
        api_key: z.string().trim().max(500).optional(),
      }),
      req.body,
      'exchange-rate provider',
    );
    if (body.provider_url) {
      const url = body.provider_url === 'default' ? SETTING_DEFAULTS.fx_provider_url : await validatedUrl(ctx, body.provider_url, 'Provider URL');
      setSetting(ctx, 'fx_provider_url', url, req.user!.id);
    }
    if (body.auto_refresh !== undefined) setSetting(ctx, 'fx_auto_refresh', body.auto_refresh, req.user!.id);
    if (body.api_key) setSecret(ctx, FX_KEY_SECRET, body.api_key, req.user!.id);
    audit(
      ctx,
      req.user,
      'integration.fx.update',
      'integration',
      'fx',
      { provider_updated: !!body.provider_url, auto_refresh: body.auto_refresh, api_key_updated: !!body.api_key },
      req.ip,
    );
    return integrations(ctx).fx;
  });

  app.delete('/integrations/fx/key', { config: { permission: 'admin.integrations' } }, async (req) => {
    deleteSecret(ctx, FX_KEY_SECRET);
    audit(ctx, req.user, 'integration.fx.key_removed', 'integration', 'fx', null, req.ip);
    return integrations(ctx).fx;
  });

  // ---- exchange rates -----------------------------------------------------------------------
  app.get('/exchange-rates', async (): Promise<ExchangeRatesResponse> => {
    const latest = latestRates(ctx);
    const currencies = ctx.db.all<{ code: string; name: string }>('SELECT code, name FROM currencies ORDER BY code');
    const now = Date.now();
    const rates: ExchangeRatesResponse['rates'] = [];
    const missing: ExchangeRatesResponse['missing'] = [];
    for (const c of currencies) {
      if (c.code === FX_BASE) continue;
      const r = latest.get(c.code);
      if (!r) {
        missing.push(c);
        continue;
      }
      rates.push({
        currency: c.code,
        currency_name: c.name,
        rate: r.rate,
        as_of: r.as_of,
        source: r.source,
        is_demo: r.is_demo,
        age_hours: Math.max(0, Math.round(((now - Date.parse(r.as_of)) / 3_600_000) * 10) / 10),
      });
    }
    return {
      base: 'USD',
      reporting_currency: getSetting(ctx, 'reporting_currency'),
      rates,
      missing,
      contains_demo_rates: rates.some((r) => r.is_demo),
      auto_refresh: getSetting(ctx, 'fx_auto_refresh'),
    };
  });

  app.get('/exchange-rates/history', async (req) => {
    const query = req.query as Record<string, unknown>;
    const currency = String(query.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('currency must be a 3-letter code');
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(query.limit ?? 200)) || 200));
    const rows = ctx.db
      .all<Omit<ExchangeRateHistoryRow, 'is_demo'> & { is_demo: number }>(
        `SELECT er.id, er.quote_currency AS currency, er.rate, er.as_of, er.source, er.source_ref, er.fetched_at, er.entered_by,
                u.name AS entered_by_name, er.is_demo
         FROM exchange_rates er LEFT JOIN users u ON u.id = er.entered_by
         WHERE er.base_currency = ? AND er.quote_currency = ? ORDER BY er.as_of DESC, er.id DESC LIMIT ?`,
        [FX_BASE, currency, limit],
      )
      .map((r): ExchangeRateHistoryRow => ({ ...r, is_demo: r.is_demo === 1 }));
    return { currency, base: FX_BASE, rows };
  });

  app.post('/exchange-rates', { config: { permission: 'admin.settings' } }, async (req, reply) => {
    const body = parse(
      z.object({
        currency: z.string().trim().toUpperCase().length(3, 'must be a 3-letter currency code'),
        rate: numeric.refine((n) => n > 0 && Number.isFinite(n), 'must be greater than zero'),
        as_of: z.string().trim().max(40).optional(),
        source_ref: z.string().trim().max(500).nullish(),
      }),
      req.body,
      'exchange rate',
    );
    if (body.currency === FX_BASE) throw unprocessable(`${FX_BASE} is the base currency; rates are entered as units of another currency per 1 ${FX_BASE}`);
    if (!ctx.db.get('SELECT 1 AS ok FROM currencies WHERE code = ?', [body.currency])) throw unprocessable(`${body.currency} is not a known currency`);
    const asOf = parseAsOf(body.as_of);
    const created = recordRate(ctx, { quote: body.currency, rate: body.rate, as_of: asOf, source: 'manual', source_ref: body.source_ref || null, userId: req.user!.id });
    if (!created) throw conflict('A manual rate for this currency and timestamp is already recorded. Rates are never overwritten: record it with a different timestamp.');
    audit(ctx, req.user, 'exchange_rate.create', 'exchange_rate', body.currency, { rate: body.rate, as_of: asOf, source_ref: body.source_ref || null }, req.ip);
    reply.code(201);
    return { currency: body.currency, rate: body.rate, as_of: asOf, source: 'manual' };
  });

  app.post('/exchange-rates/fetch', { config: { permission: 'admin.settings' } }, async (req): Promise<FxFetchResult> => {
    const result = await fetchRatesFromProvider(ctx, req.user!.id);
    audit(ctx, req.user, 'exchange_rate.fetch', 'exchange_rate', null, { inserted: result.inserted, unchanged: result.unchanged, as_of: result.as_of, source: result.source }, req.ip);
    return result;
  });

  // Daily automatic refresh (opt-in). A failure is logged and retried later — never papered over.
  let lastFxAttempt = 0;
  let lastFxOk = true;
  let fxRunning = false;
  ctx.hooks.schedulerTick.push((now) => {
    if (fxRunning || !getSetting(ctx, 'fx_auto_refresh')) return;
    const interval = lastFxOk ? FX_REFRESH_INTERVAL_MS : FX_RETRY_INTERVAL_MS;
    if (now.getTime() - lastFxAttempt < interval) return;
    const lastFetched = ctx.db.scalar<string | null>(`SELECT MAX(fetched_at) FROM exchange_rates WHERE is_demo = 0 AND source <> 'manual'`);
    if (lastFxAttempt === 0 && lastFetched && now.getTime() - Date.parse(lastFetched) < FX_REFRESH_INTERVAL_MS) {
      lastFxAttempt = Date.parse(lastFetched);
      return;
    }
    lastFxAttempt = now.getTime();
    fxRunning = true;
    fetchRatesFromProvider(ctx, null)
      .then((result) => {
        lastFxOk = true;
        ctx.log.info({ inserted: result.inserted, as_of: result.as_of, source: result.source }, 'exchange rates refreshed');
      })
      .catch((err) => {
        lastFxOk = false;
        ctx.log.warn({ err: (err as Error).message }, 'automatic exchange-rate refresh failed');
      })
      .finally(() => {
        fxRunning = false;
      });
  });

  // ---- audit log ----------------------------------------------------------------------------
  app.get('/audit-log', { config: { permission: 'admin.audit' } }, async (req) => {
    const query = req.query as Record<string, unknown>;
    const conditions: string[] = [];
    const params: SqlParam[] = [];
    const users = idList(query.user_id);
    if (users?.length) {
      conditions.push(`al.user_id IN (${placeholders(users.length)})`);
      params.push(...users);
    }
    if (typeof query.action === 'string' && query.action.trim()) {
      conditions.push(`al.action LIKE ? ESCAPE '\\'`);
      params.push(`${query.action.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (typeof query.entity_type === 'string' && query.entity_type.trim()) {
      conditions.push('al.entity_type = ?');
      params.push(query.entity_type.trim());
    }
    if (query.entity_id !== undefined && query.entity_id !== null && String(query.entity_id).trim() !== '') {
      conditions.push('al.entity_id = ?');
      params.push(String(query.entity_id).trim());
    }
    for (const key of ['from', 'to'] as const) {
      const value = query[key];
      if (value === undefined || value === null || value === '') continue;
      if (!isIsoDate(value)) throw badRequest(`"${key}" must be a date in YYYY-MM-DD format`);
      if (key === 'from') {
        conditions.push('al.at >= ?');
        params.push(`${value}T00:00:00.000Z`);
      } else {
        conditions.push('al.at < ?');
        params.push(`${addDays(value, 1)}T00:00:00.000Z`);
      }
    }
    if (typeof query.q === 'string' && query.q.trim()) {
      const pattern = likePattern(query.q.trim());
      conditions.push(`(al.action LIKE ? ESCAPE '\\' OR al.detail LIKE ? ESCAPE '\\' OR al.user_email LIKE ? ESCAPE '\\' OR al.entity_id LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern, pattern, pattern);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const page = pagination(query, 50, 200);
    const total = ctx.db.scalar<number>(`SELECT COUNT(*) FROM audit_log al ${where}`, params) ?? 0;
    const rows = ctx.db
      .all<Omit<AuditLogRow, 'detail'> & { detail: string | null }>(
        `SELECT al.id, al.at, al.user_id, al.user_email, u.name AS user_name, al.action, al.entity_type, al.entity_id, al.detail, al.ip
         FROM audit_log al LEFT JOIN users u ON u.id = al.user_id ${where}
         ORDER BY al.id DESC LIMIT ? OFFSET ?`,
        [...params, page.pageSize, page.offset],
      )
      .map((r): AuditLogRow => {
        let detail: unknown = null;
        if (r.detail !== null) {
          try {
            detail = JSON.parse(r.detail);
          } catch {
            detail = r.detail;
          }
        }
        return { ...r, detail };
      });
    return paged(rows, total, page);
  });

  /** Distinct actions and entity types, for the audit-log filters. */
  app.get('/audit-log/facets', { config: { permission: 'admin.audit' } }, async () => {
    return {
      actions: ctx.db.all<{ action: string }>('SELECT DISTINCT action FROM audit_log ORDER BY action').map((r) => r.action),
      entity_types: ctx.db
        .all<{ entity_type: string }>('SELECT DISTINCT entity_type FROM audit_log WHERE entity_type IS NOT NULL ORDER BY entity_type')
        .map((r) => r.entity_type),
    };
  });

  // ---- system -------------------------------------------------------------------------------
  app.get('/admin/system', { config: { permission: 'admin.settings' } }, async (): Promise<SystemInfo> => {
    const size = (file: string) => {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    };
    const tables: Record<string, number> = {};
    for (const table of COUNTED_TABLES) tables[table] = ctx.db.scalar<number>(`SELECT COUNT(*) FROM ${table}`) ?? 0;
    const demo_rows: Record<string, number> = {};
    for (const table of DEMO_TABLES) demo_rows[table] = ctx.db.scalar<number>(`SELECT COUNT(*) FROM ${table} WHERE is_demo = 1`) ?? 0;
    const migration = ctx.db.get<{ version: number; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1');
    return {
      version: {
        node: process.version,
        sqlite: ctx.db.scalar<string>('SELECT sqlite_version()') ?? 'unknown',
        migration: migration?.version ?? 0,
        migration_name: migration?.name ?? null,
      },
      environment: ctx.config.env,
      uptime_seconds: Math.round(process.uptime()),
      scheduler_enabled: ctx.config.schedulerEnabled,
      data_dir: ctx.config.dataDir,
      database: { path: ctx.config.dbPath, size_bytes: size(ctx.config.dbPath), wal_size_bytes: size(`${ctx.config.dbPath}-wal`) },
      tables,
      demo_rows,
      demo_data_present: demoDataPresent(ctx),
      observations_by_class: ctx.db
        .all<{ data_class: string; is_demo: number; count: number; last_observed_at: string | null }>(
          `SELECT data_class, is_demo, COUNT(*) AS count, MAX(observed_at) AS last_observed_at
           FROM price_observations GROUP BY data_class, is_demo ORDER BY is_demo, data_class`,
        )
        .map((r) => ({ ...r, is_demo: r.is_demo === 1 })),
    };
  });

  // ---- DEMO dataset -------------------------------------------------------------------------
  app.post('/admin/demo/purge', { config: { permission: 'admin.demo' } }, async (req): Promise<DemoActionResult> => {
    const { purgeDemo } = await import('../seed/demo.ts');
    const counts = purgeDemo(ctx);
    audit(ctx, req.user, 'demo.purge', 'demo_dataset', null, counts, req.ip);
    return { action: 'purge', counts };
  });

  app.post('/admin/demo/seed', { config: { permission: 'admin.demo' } }, async (req): Promise<DemoActionResult> => {
    if (demoDataPresent(ctx)) throw conflict('DEMO data is already loaded. Remove it first if you want to load a fresh copy.');
    const { seedDemo } = await import('../seed/demo.ts');
    const counts = await seedDemo(ctx);
    audit(ctx, req.user, 'demo.seed', 'demo_dataset', null, counts, req.ip);
    return { action: 'seed', counts };
  });
}
