/** Small cross-cutting services: audit trail, settings and encrypted credentials. */
import type { AppContext, AuthUser } from '../context.ts';
import { nowIso } from '../lib/time.ts';

// ---------------------------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------------------------
export function audit(
  ctx: AppContext,
  user: Pick<AuthUser, 'id' | 'email'> | null,
  action: string,
  entityType?: string | null,
  entityId?: string | number | null,
  detail?: unknown,
  ip?: string | null,
): void {
  ctx.db.run(
    `INSERT INTO audit_log (at, user_id, user_email, action, entity_type, entity_id, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      nowIso(),
      user?.id ?? null,
      user?.email ?? null,
      action,
      entityType ?? null,
      entityId === null || entityId === undefined ? null : String(entityId),
      detail === undefined ? null : JSON.stringify(detail),
      ip ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// Settings (JSON values with typed defaults)
// ---------------------------------------------------------------------------------------------
export interface SettingsShape {
  /** Currency used when prices from different markets are compared. */
  reporting_currency: string;
  /** Organisation name shown in report headers. */
  organisation_name: string;
  /** Two promotional observations further apart than this start a new promotion episode. */
  promo_gap_days: number;
  /** Price events older than this are never turned into alerts (protects against history imports). */
  alert_max_age_hours: number;
  /** Maximum automatic retries for a failed collection job. */
  collection_max_retries: number;
  /** Day the simulated demo price model starts from (YYYY-MM-DD). */
  demo_epoch: string | null;
  /** Exchange-rate provider endpoint (JSON, USD base). */
  fx_provider_url: string;
  fx_auto_refresh: boolean;
  /** Outbound webhook for alert notifications. */
  alert_webhook_url: string | null;
  smtp: { host: string; port: number; secure: boolean; user: string; from: string } | null;
  alert_email_recipients: string[];
  ai: { provider: 'builtin' | 'anthropic'; model: string };
}

export const SETTING_DEFAULTS: SettingsShape = {
  reporting_currency: 'AED',
  organisation_name: '',
  promo_gap_days: 10,
  alert_max_age_hours: 48,
  collection_max_retries: 2,
  demo_epoch: null,
  fx_provider_url: 'https://open.er-api.com/v6/latest/USD',
  fx_auto_refresh: false,
  alert_webhook_url: null,
  smtp: null,
  alert_email_recipients: [],
  ai: { provider: 'builtin', model: 'claude-opus-5-5' },
};

export function getSetting<K extends keyof SettingsShape>(ctx: AppContext, key: K): SettingsShape[K] {
  const row = ctx.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return SETTING_DEFAULTS[key];
  try {
    return JSON.parse(row.value) as SettingsShape[K];
  } catch {
    return SETTING_DEFAULTS[key];
  }
}

export function getAllSettings(ctx: AppContext): SettingsShape {
  const out = { ...SETTING_DEFAULTS } as Record<string, unknown>;
  for (const row of ctx.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (row.key in SETTING_DEFAULTS) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        /* keep default */
      }
    }
  }
  return out as unknown as SettingsShape;
}

export function setSetting<K extends keyof SettingsShape>(
  ctx: AppContext,
  key: K,
  value: SettingsShape[K],
  userId?: number | null,
): void {
  ctx.db.run(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), userId ?? null, nowIso()],
  );
}

// ---------------------------------------------------------------------------------------------
// Encrypted credentials
// ---------------------------------------------------------------------------------------------
export function setSecret(ctx: AppContext, name: string, value: string, userId?: number | null): void {
  const box = ctx.secrets.encrypt(value);
  const hint = value.length > 8 ? `…${value.slice(-4)}` : '…';
  ctx.db.run(
    `INSERT INTO secrets (name, ciphertext, iv, tag, hint, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
       hint = excluded.hint, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [name, box.ciphertext, box.iv, box.tag, hint, userId ?? null, nowIso()],
  );
}

export function getSecret(ctx: AppContext, name: string): string | null {
  const row = ctx.db.get<{ ciphertext: string; iv: string; tag: string }>(
    'SELECT ciphertext, iv, tag FROM secrets WHERE name = ?',
    [name],
  );
  if (!row) return null;
  try {
    return ctx.secrets.decrypt(row);
  } catch {
    // Wrong/rotated encryption key: treat as not configured rather than crashing collection.
    ctx.log.warn({ secret: name }, 'stored credential could not be decrypted (encryption key changed?)');
    return null;
  }
}

export function deleteSecret(ctx: AppContext, name: string): void {
  ctx.db.run('DELETE FROM secrets WHERE name = ?', [name]);
}

/** Safe description of a stored credential: whether it exists and a short recognition hint. Never the value. */
export function secretStatus(ctx: AppContext, name: string): { configured: boolean; hint: string | null; updated_at: string | null } {
  const row = ctx.db.get<{ hint: string | null; updated_at: string }>('SELECT hint, updated_at FROM secrets WHERE name = ?', [name]);
  return { configured: !!row, hint: row?.hint ?? null, updated_at: row?.updated_at ?? null };
}

export const retailerSecretName = (retailerId: number) => `retailer:${retailerId}:credential`;
