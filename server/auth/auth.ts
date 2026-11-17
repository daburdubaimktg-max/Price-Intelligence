import type { AppContext, AuthUser } from '../context.ts';
import type { RoleKey } from '../../shared/constants.ts';
import { hashPassword, newToken, randomPassword, sha256Hex, verifyPassword } from '../lib/crypto.ts';
import { AppError, unauthorized } from '../lib/errors.ts';
import { nowIso } from '../lib/time.ts';
import { audit } from '../services/core.ts';

export const SESSION_COOKIE = 'pios_session';
export const DEMO_PASSWORD = 'PriceIntel-Demo-2026';
export const DEMO_ACCOUNTS: Array<{ email: string; name: string; role: RoleKey }> = [
  { email: 'admin@priceintel.local', name: 'Demo Administrator', role: 'admin' },
  { email: 'analyst@priceintel.local', name: 'Demo Analyst', role: 'analyst' },
  { email: 'viewer@priceintel.local', name: 'Demo Viewer', role: 'viewer' },
];

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;
// Verified against when the e-mail is unknown so response time does not reveal which accounts exist.
let dummyHash: string | null = null;

interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: RoleKey;
  is_active: number;
  must_change_password: number;
  uses_default_password: number;
  failed_login_count: number;
  locked_until: string | null;
}

const USER_SELECT = `SELECT u.id, u.email, u.name, u.password_hash, r.key AS role, u.is_active, u.must_change_password,
  u.uses_default_password, u.failed_login_count, u.locked_until
  FROM users u JOIN roles r ON r.id = u.role_id`;

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    must_change_password: row.must_change_password === 1,
    uses_default_password: row.uses_default_password === 1,
  };
}

export async function createUser(
  ctx: AppContext,
  input: { email: string; name: string; password: string; role: RoleKey; mustChangePassword?: boolean; usesDefaultPassword?: boolean },
): Promise<number> {
  const hash = await hashPassword(input.password);
  const now = nowIso();
  const role = ctx.db.get<{ id: number }>('SELECT id FROM roles WHERE key = ?', [input.role]);
  if (!role) throw new AppError(400, 'bad_request', `Unknown role ${input.role}`);
  return ctx.db.run(
    `INSERT INTO users (email, name, password_hash, role_id, must_change_password, uses_default_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.email.trim().toLowerCase(), input.name.trim(), hash, role.id, !!input.mustChangePassword, !!input.usesDefaultPassword, now, now],
  ).lastInsertRowid;
}

export async function setPassword(ctx: AppContext, userId: number, password: string, mustChange = false): Promise<void> {
  const hash = await hashPassword(password);
  ctx.db.run(
    `UPDATE users SET password_hash = ?, must_change_password = ?, uses_default_password = 0, failed_login_count = 0,
       locked_until = NULL, updated_at = ? WHERE id = ?`,
    [hash, mustChange, nowIso(), userId],
  );
}

/**
 * Creates the first accounts on an empty database.
 *   * PIOS_ADMIN_EMAIL / PIOS_ADMIN_PASSWORD set → that administrator
 *   * demo accounts enabled (default outside production) → three demo accounts with a documented password
 *   * otherwise → one administrator with a random password, printed once, that must be changed on first sign-in
 */
export async function ensureInitialUsers(ctx: AppContext): Promise<{ created: string[]; generatedPassword?: string }> {
  const count = ctx.db.scalar<number>('SELECT COUNT(*) FROM users') ?? 0;
  if (count > 0) return { created: [] };
  const { config } = ctx;
  if (config.adminEmail && config.adminPassword) {
    await createUser(ctx, { email: config.adminEmail, name: 'Administrator', password: config.adminPassword, role: 'admin' });
    return { created: [config.adminEmail] };
  }
  const demoAccounts = process.env.PIOS_DEMO_ACCOUNTS
    ? ['1', 'true', 'yes', 'on'].includes(process.env.PIOS_DEMO_ACCOUNTS.toLowerCase())
    : !config.isProduction;
  if (demoAccounts) {
    for (const account of DEMO_ACCOUNTS) {
      await createUser(ctx, { ...account, password: DEMO_PASSWORD, usesDefaultPassword: true });
    }
    return { created: DEMO_ACCOUNTS.map((a) => a.email) };
  }
  const password = randomPassword();
  const email = config.adminEmail ?? 'admin@priceintel.local';
  await createUser(ctx, { email, name: 'Administrator', password, role: 'admin', mustChangePassword: true });
  return { created: [email], generatedPassword: password };
}

/** Demo accounts that still use the published demo password (shown on the sign-in screen). */
export function demoLoginHint(ctx: AppContext): { accounts: Array<{ email: string; role: string }>; password: string } | null {
  const rows = ctx.db.all<{ email: string; role: string }>(
    `SELECT u.email, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.uses_default_password = 1 AND u.is_active = 1 ORDER BY r.id`,
  );
  return rows.length ? { accounts: rows, password: DEMO_PASSWORD } : null;
}

export async function login(
  ctx: AppContext,
  email: string,
  password: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ user: AuthUser; token: string; expiresAt: string }> {
  const row = ctx.db.get<UserRow>(`${USER_SELECT} WHERE u.email = ?`, [email.trim().toLowerCase()]);
  if (!row || !row.is_active) {
    dummyHash ??= await hashPassword('not-a-real-password');
    await verifyPassword(password, dummyHash);
    throw unauthorized('Incorrect e-mail or password');
  }
  if (row.locked_until && row.locked_until > nowIso()) {
    throw new AppError(429, 'account_locked', 'Too many failed attempts. Try again in a few minutes.');
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    const failures = row.failed_login_count + 1;
    if (failures >= MAX_FAILED_LOGINS) {
      const until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
      ctx.db.run('UPDATE users SET failed_login_count = 0, locked_until = ? WHERE id = ?', [until, row.id]);
      audit(ctx, { id: row.id, email: row.email }, 'auth.locked', 'user', row.id, null, meta.ip);
    } else {
      ctx.db.run('UPDATE users SET failed_login_count = ? WHERE id = ?', [failures, row.id]);
    }
    throw unauthorized('Incorrect e-mail or password');
  }
  const now = new Date();
  const token = newToken();
  const expiresAt = new Date(now.getTime() + ctx.config.sessionIdleHours * 3_600_000).toISOString();
  ctx.db.run('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [now.toISOString(), row.id]);
  ctx.db.run(
    `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, sha256Hex(token), now.toISOString(), now.toISOString(), expiresAt, meta.ip ?? null, (meta.userAgent ?? '').slice(0, 300)],
  );
  ctx.db.run('DELETE FROM sessions WHERE expires_at < ?', [now.toISOString()]);
  audit(ctx, { id: row.id, email: row.email }, 'auth.login', 'user', row.id, null, meta.ip);
  return { user: toAuthUser(row), token, expiresAt };
}

/** Resolves a session token to its user, sliding the idle timeout (bounded by the absolute lifetime). */
export function authenticate(ctx: AppContext, token: string): AuthUser | null {
  const tokenHash = sha256Hex(token);
  const row = ctx.db.get<UserRow & { session_id: number; created_at: string; last_seen_at: string; expires_at: string }>(
    `SELECT u.id, u.email, u.name, u.password_hash, r.key AS role, u.is_active, u.must_change_password,
       u.uses_default_password, u.failed_login_count, u.locked_until,
       s.id AS session_id, s.created_at, s.last_seen_at, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
     WHERE s.token_hash = ?`,
    [tokenHash],
  );
  if (!row) return null;
  const now = Date.now();
  if (!row.is_active || Date.parse(row.expires_at) <= now) {
    ctx.db.run('DELETE FROM sessions WHERE id = ?', [row.session_id]);
    return null;
  }
  if (now - Date.parse(row.last_seen_at) > 60_000) {
    const absoluteEnd = Date.parse(row.created_at) + ctx.config.sessionAbsoluteHours * 3_600_000;
    const idleEnd = now + ctx.config.sessionIdleHours * 3_600_000;
    ctx.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [
      new Date(now).toISOString(),
      new Date(Math.min(absoluteEnd, idleEnd)).toISOString(),
      row.session_id,
    ]);
  }
  return toAuthUser(row);
}

export function logout(ctx: AppContext, token: string): void {
  ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256Hex(token)]);
}

export function revokeUserSessions(ctx: AppContext, userId: number, exceptToken?: string): void {
  if (exceptToken) {
    ctx.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, sha256Hex(exceptToken)]);
  } else {
    ctx.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
}

export async function checkPassword(ctx: AppContext, userId: number, password: string): Promise<boolean> {
  const row = ctx.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [userId]);
  return row ? verifyPassword(password, row.password_hash) : false;
}
