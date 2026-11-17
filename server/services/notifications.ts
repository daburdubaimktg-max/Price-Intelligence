/**
 * Alert notification delivery: in-app, webhook and e-mail.
 *
 * Rules
 *   * Delivery never blocks ingestion: external channels are dispatched asynchronously.
 *   * Every attempt is recorded in alert_notifications with its real outcome. A channel that has not
 *     been configured is recorded as `not_configured` — never as delivered.
 *   * One webhook call and one e-mail per recipient per batch (digest), not one per alert.
 */
import nodemailer from 'nodemailer';
import type { AppContext } from '../context.ts';
import { placeholders } from '../db/sqlite.ts';
import { NetError, safeFetch } from '../lib/net.ts';
import { nowIso } from '../lib/time.ts';
import { getSecret, getSetting, type SettingsShape } from './core.ts';
import type { NotificationChannel, NotificationPrefs, NotificationStatus } from '../../shared/api/alerts.ts';
import type { Severity } from '../../shared/constants.ts';

export const SMTP_PASSWORD_SECRET = 'integration:smtp:password';
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
export const DEFAULT_PREFS: NotificationPrefs = { in_app: true, email: false, min_severity: 'info' };

const MAX_ALERTS_PER_MESSAGE = 50;

interface NotifiableAlert {
  id: number;
  type: string;
  severity: Severity;
  title: string;
  message: string;
  status: string;
  triggered_at: string;
  is_demo: number;
  payload: string;
  channels: string | null;
  product_name: string | null;
  brand_name: string | null;
  retailer_name: string | null;
  market_name: string | null;
}

const pending = new WeakMap<AppContext, Set<Promise<void>>>();

export function parsePrefs(raw: string | null | undefined): NotificationPrefs {
  try {
    const value = JSON.parse(raw ?? '{}') as Partial<NotificationPrefs>;
    return {
      in_app: value.in_app !== false,
      email: value.email === true,
      min_severity: value.min_severity === 'warning' || value.min_severity === 'critical' ? value.min_severity : 'info',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function parseChannels(raw: string | null | undefined): NotificationChannel[] {
  let list: unknown = [];
  try {
    list = JSON.parse(raw ?? '[]');
  } catch {
    list = [];
  }
  const out = new Set<NotificationChannel>(['in_app']);
  if (Array.isArray(list)) {
    for (const c of list) if (c === 'email' || c === 'webhook') out.add(c);
  }
  return [...out];
}

/** Scheme + host with the path masked — webhook URLs usually embed a secret token. */
export function maskUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== '/' ? '/…' : ''}`;
  } catch {
    return 'invalid URL';
  }
}

function record(ctx: AppContext, alertId: number, channel: NotificationChannel, status: NotificationStatus, recipient: string | null, error: string | null): void {
  try {
    ctx.db.run(
      `INSERT INTO alert_notifications (alert_id, channel, recipient, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [alertId, channel, recipient ? recipient.slice(0, 300) : null, status, error ? error.slice(0, 500) : null, nowIso()],
    );
  } catch (err) {
    // The alert may have been purged (demo data) or the database closed during shutdown.
    ctx.log.warn({ err, alertId, channel }, 'could not record alert notification');
  }
}

function loadAlerts(ctx: AppContext, alertIds: number[]): NotifiableAlert[] {
  const out: NotifiableAlert[] = [];
  for (let i = 0; i < alertIds.length; i += 400) {
    const chunk = alertIds.slice(i, i + 400);
    out.push(
      ...ctx.db.all<NotifiableAlert>(
        `SELECT a.id, a.type, a.severity, a.title, a.message, a.status, a.triggered_at, a.is_demo, a.payload, ar.channels,
                p.name AS product_name, b.name AS brand_name, r.name AS retailer_name, m.name AS market_name
         FROM alerts a
         LEFT JOIN alert_rules ar ON ar.id = a.rule_id
         LEFT JOIN products p ON p.id = a.product_id
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN retailers r ON r.id = a.retailer_id
         LEFT JOIN markets m ON m.id = a.market_id
         WHERE a.id IN (${placeholders(chunk.length)})
         ORDER BY a.triggered_at, a.id`,
        chunk,
      ),
    );
  }
  return out;
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

function summaryLine(alerts: NotifiableAlert[]): string {
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const warning = alerts.filter((a) => a.severity === 'warning').length;
  const parts = [`${alerts.length} new alert${alerts.length === 1 ? '' : 's'}`];
  const detail: string[] = [];
  if (critical) detail.push(`${critical} critical`);
  if (warning) detail.push(`${warning} warning`);
  if (detail.length) parts.push(`(${detail.join(', ')})`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------------------------
export interface WebhookResult {
  ok: boolean;
  status: number | null;
  duration_ms: number;
  error: string | null;
}

export async function postWebhook(ctx: AppContext, url: string, payload: unknown): Promise<WebhookResult> {
  const started = Date.now();
  try {
    const res = await safeFetch(ctx, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
      body: JSON.stringify(payload),
      timeoutMs: 15_000,
      maxRedirects: 2,
    });
    await res.body?.cancel().catch(() => undefined);
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, duration_ms: Date.now() - started, error: ok ? null : `Webhook endpoint answered HTTP ${res.status}` };
  } catch (err) {
    const message = err instanceof NetError ? err.message : `Webhook request failed: ${(err as Error).message}`;
    return { ok: false, status: null, duration_ms: Date.now() - started, error: message };
  }
}

function webhookPayload(alerts: NotifiableAlert[]) {
  const demo = alerts.some((a) => a.is_demo === 1);
  const headline = `${demo ? '[DEMO DATA] ' : ''}Price Intelligence OS: ${summaryLine(alerts)}`;
  const lines = alerts.slice(0, 10).map((a) => `• [${a.severity.toUpperCase()}] ${a.title}`);
  if (alerts.length > 10) lines.push(`… and ${alerts.length - 10} more`);
  return {
    source: 'Price Intelligence OS',
    type: 'alerts',
    sent_at: nowIso(),
    count: alerts.length,
    contains_demo_data: demo,
    // `text` keeps the payload directly usable with chat-style incoming webhooks.
    text: [headline, ...lines].join('\n'),
    alerts: alerts.slice(0, MAX_ALERTS_PER_MESSAGE).map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      title: a.title,
      message: a.message,
      triggered_at: a.triggered_at,
      product: a.product_name,
      brand: a.brand_name,
      retailer: a.retailer_name,
      market: a.market_name,
      is_demo: a.is_demo === 1,
      details: safeJson(a.payload),
    })),
    truncated: alerts.length > MAX_ALERTS_PER_MESSAGE,
  };
}

/** Sends a clearly-labelled test message to the configured webhook and reports what really happened. */
export async function sendTestWebhook(ctx: AppContext): Promise<WebhookResult & { configured: boolean }> {
  const url = getSetting(ctx, 'alert_webhook_url');
  if (!url) return { configured: false, ok: false, status: null, duration_ms: 0, error: 'No webhook URL is configured' };
  const result = await postWebhook(ctx, url, {
    source: 'Price Intelligence OS',
    type: 'test',
    sent_at: nowIso(),
    text: 'Price Intelligence OS — test notification. This is a connectivity test; no action is needed.',
    alerts: [],
  });
  return { configured: true, ...result };
}

// ---------------------------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------------------------
export function smtpStatus(ctx: AppContext): { configured: boolean; missing: string[]; smtp: SettingsShape['smtp'] } {
  const smtp = getSetting(ctx, 'smtp');
  const missing: string[] = [];
  if (!smtp || !smtp.host) missing.push('SMTP host');
  if (!smtp || !smtp.from) missing.push('sender address');
  return { configured: missing.length === 0, missing, smtp };
}

function createTransport(ctx: AppContext) {
  const { smtp } = smtpStatus(ctx);
  if (!smtp) throw new Error('SMTP is not configured');
  const password = getSecret(ctx, SMTP_PASSWORD_SECRET);
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: password ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

export interface EmailResult {
  ok: boolean;
  message_id: string | null;
  accepted: string[];
  rejected: string[];
  duration_ms: number;
  error: string | null;
}

async function sendMail(ctx: AppContext, to: string, subject: string, text: string, html?: string): Promise<EmailResult> {
  const started = Date.now();
  const { smtp } = smtpStatus(ctx);
  let transport: ReturnType<typeof createTransport> | null = null;
  try {
    transport = createTransport(ctx);
    const info = await transport.sendMail({ from: smtp!.from, to, subject, text, html });
    const accepted = (info.accepted ?? []).map(String);
    const rejected = (info.rejected ?? []).map(String);
    const ok = accepted.length > 0 && rejected.length === 0;
    return {
      ok,
      message_id: info.messageId ?? null,
      accepted,
      rejected,
      duration_ms: Date.now() - started,
      error: ok ? null : `The mail server rejected: ${rejected.join(', ') || to}`,
    };
  } catch (err) {
    return { ok: false, message_id: null, accepted: [], rejected: [to], duration_ms: Date.now() - started, error: (err as Error).message };
  } finally {
    transport?.close();
  }
}

/** Really sends a test message through the configured SMTP server. */
export async function sendTestEmail(ctx: AppContext, to: string): Promise<EmailResult & { configured: boolean }> {
  const status = smtpStatus(ctx);
  if (!status.configured) {
    return { configured: false, ok: false, message_id: null, accepted: [], rejected: [], duration_ms: 0, error: `E-mail is not configured: missing ${status.missing.join(' and ')}` };
  }
  const result = await sendMail(
    ctx,
    to,
    'Price Intelligence OS — test e-mail',
    'This is a test message from Price Intelligence OS. If you received it, alert e-mails can be delivered to this address.\n\nNo action is needed.',
  );
  return { configured: true, ...result };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function emailContent(alerts: NotifiableAlert[]): { subject: string; text: string; html: string } {
  const demo = alerts.some((a) => a.is_demo === 1);
  const subject = `${demo ? '[DEMO DATA] ' : ''}[Price Intelligence OS] ${summaryLine(alerts)}`;
  const shown = alerts.slice(0, MAX_ALERTS_PER_MESSAGE);
  const more = alerts.length - shown.length;
  const text = [
    `${summaryLine(alerts)}${demo ? ' — includes alerts raised from DEMO (illustrative) data.' : ''}`,
    '',
    ...shown.map((a) => `[${a.severity.toUpperCase()}]${a.is_demo ? ' [DEMO]' : ''} ${a.title}\n  ${a.message}\n  ${a.triggered_at}`),
    ...(more > 0 ? ['', `… and ${more} more. Open the Alerts Centre to see all of them.`] : []),
    '',
    'You receive this message because e-mail notifications are enabled for you in Price Intelligence OS.',
  ].join('\n');
  const rows = shown
    .map(
      (a) =>
        `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${escapeHtml(a.severity.toUpperCase())}${a.is_demo ? ' · DEMO' : ''}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><div style="font-weight:600">${escapeHtml(a.title)}</div><div style="color:#475569">${escapeHtml(a.message)}</div>` +
        `<div style="color:#94a3b8;font-size:12px">${escapeHtml(a.triggered_at)}</div></td></tr>`,
    )
    .join('');
  const html =
    `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0b1f3a;font-size:14px">` +
    `<p><strong>${escapeHtml(summaryLine(alerts))}</strong>${demo ? ' — includes alerts raised from DEMO (illustrative) data.' : ''}</p>` +
    `<table style="border-collapse:collapse;width:100%">${rows}</table>` +
    (more > 0 ? `<p>… and ${more} more. Open the Alerts Centre to see all of them.</p>` : '') +
    `<p style="color:#94a3b8;font-size:12px">You receive this message because e-mail notifications are enabled for you in Price Intelligence OS.</p></div>`;
  return { subject, text, html };
}

interface Recipient {
  email: string;
  minSeverity: Severity;
}

function emailRecipients(ctx: AppContext): Recipient[] {
  const out = new Map<string, Recipient>();
  const users = ctx.db.all<{ email: string; notification_prefs: string }>('SELECT email, notification_prefs FROM users WHERE is_active = 1');
  for (const user of users) {
    const prefs = parsePrefs(user.notification_prefs);
    if (prefs.email) out.set(user.email.toLowerCase(), { email: user.email, minSeverity: prefs.min_severity });
  }
  for (const extra of getSetting(ctx, 'alert_email_recipients') ?? []) {
    const email = String(extra).trim();
    if (email && !out.has(email.toLowerCase())) out.set(email.toLowerCase(), { email, minSeverity: 'info' });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------
async function dispatchExternal(ctx: AppContext, alerts: NotifiableAlert[]): Promise<void> {
  const wants = (a: NotifiableAlert, channel: NotificationChannel) => parseChannels(a.channels).includes(channel);

  const forWebhook = alerts.filter((a) => wants(a, 'webhook'));
  if (forWebhook.length) {
    const url = getSetting(ctx, 'alert_webhook_url');
    if (!url) {
      for (const a of forWebhook) record(ctx, a.id, 'webhook', 'not_configured', null, 'No webhook URL is configured');
    } else {
      const result = await postWebhook(ctx, url, webhookPayload(forWebhook));
      for (const a of forWebhook) record(ctx, a.id, 'webhook', result.ok ? 'delivered' : 'failed', maskUrl(url), result.error);
    }
  }

  const forEmail = alerts.filter((a) => wants(a, 'email'));
  if (forEmail.length) {
    const status = smtpStatus(ctx);
    if (!status.configured) {
      for (const a of forEmail) record(ctx, a.id, 'email', 'not_configured', null, `E-mail is not configured: missing ${status.missing.join(' and ')}`);
      return;
    }
    const recipients = emailRecipients(ctx);
    if (recipients.length === 0) {
      for (const a of forEmail) record(ctx, a.id, 'email', 'not_configured', null, 'No e-mail recipients: nobody has enabled e-mail notifications and no extra recipients are set');
      return;
    }
    for (const recipient of recipients) {
      const mine = forEmail.filter((a) => SEVERITY_RANK[a.severity] >= SEVERITY_RANK[recipient.minSeverity]);
      if (mine.length === 0) continue;
      const content = emailContent(mine);
      const result = await sendMail(ctx, recipient.email, content.subject, content.text, content.html);
      for (const a of mine) record(ctx, a.id, 'email', result.ok ? 'delivered' : 'failed', recipient.email, result.error);
    }
  }
}

/**
 * Records the in-app delivery of the given alerts immediately and dispatches the external channels
 * (webhook, e-mail) in the background. Returns straight away.
 */
export function queueAlertNotifications(ctx: AppContext, alertIds: number[]): void {
  if (alertIds.length === 0) return;
  let alerts: NotifiableAlert[];
  try {
    alerts = loadAlerts(ctx, alertIds);
    ctx.db.tx(() => {
      for (const a of alerts) record(ctx, a.id, 'in_app', 'delivered', null, null);
    });
  } catch (err) {
    ctx.log.error({ err }, 'could not queue alert notifications');
    return;
  }
  const external = alerts.filter((a) => parseChannels(a.channels).some((c) => c !== 'in_app'));
  if (external.length === 0) return;
  let set = pending.get(ctx);
  if (!set) {
    set = new Set();
    pending.set(ctx, set);
  }
  const jobs = set;
  const job: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => dispatchExternal(ctx, external))
    .catch((err) => {
      ctx.log.error({ err }, 'alert notification dispatch failed');
    })
    .finally(() => {
      jobs.delete(job);
    });
  jobs.add(job);
}

/** Waits for all background notification work of this app instance (tests, graceful shutdown). */
export async function flushNotifications(ctx: AppContext): Promise<void> {
  const set = pending.get(ctx);
  while (set && set.size > 0) await Promise.allSettled([...set]);
}
