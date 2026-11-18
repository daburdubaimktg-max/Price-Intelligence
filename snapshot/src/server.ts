/**
 * The application's API, running inside the page.
 *
 * The route modules in `server/routes` and the services behind them are the same code the real server
 * runs. This file gives them the small part of the web framework they use (route registration, request
 * and reply objects, the permission check and the error mapping from `server/app.ts`) and answers every
 * request from the snapshot database held in memory.
 *
 * Rules of the snapshot, enforced here:
 *  - every visitor is the read-only "Snapshot viewer" account, so the app's own role rules apply;
 *  - nothing can be changed: writes are refused, apart from on-screen reports and the assistant, whose
 *    answers are computed from the stored records;
 *  - files (exports, evidence, the Excel database) are not part of the snapshot.
 */
import { ZodError } from 'zod';
import type { Config } from '../../server/config.ts';
import { createHooks, type AppContext, type AuthUser } from '../../server/context.ts';
import { AppError, forbidden, unauthorized } from '../../server/lib/errors.ts';
import type { SecretBox } from '../../server/lib/crypto.ts';
import { roleCan, type Permission, type RoleKey } from '../../shared/constants.ts';
import { Db, SqliteError } from './db.ts';

interface RouteConfig {
  public?: boolean;
  permission?: Permission | 'any';
  allowPendingPassword?: boolean;
}

interface SnapshotRequest {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  headers: Record<string, string>;
  ip: string;
  protocol: string;
  user: AuthUser | null;
  sessionToken: string | null;
  authVia: 'cookie' | 'bearer' | null;
  log: AppContext['log'];
  routeOptions: { config: RouteConfig };
  isMultipart: () => boolean;
  parts: () => AsyncGenerator<never, void, unknown>;
}

class SnapshotReply {
  statusCode = 200;
  headers: Record<string, string> = {};
  sent = false;
  payload: unknown = undefined;

  code(status: number): this {
    this.statusCode = status;
    return this;
  }
  status(status: number): this {
    return this.code(status);
  }
  header(name: string, value: unknown): this {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }
  type(value: string): this {
    return this.header('content-type', value);
  }
  send(payload?: unknown): this {
    this.sent = true;
    this.payload = payload;
    return this;
  }
  setCookie(): this {
    return this;
  }
  clearCookie(): this {
    return this;
  }
}

type Handler = (req: SnapshotRequest, reply: SnapshotReply) => unknown;

interface Route {
  method: string;
  parts: string[];
  /** '0' for a fixed segment, '1' for a parameter: fixed segments win, as in the real router. */
  rank: string;
  config: RouteConfig;
  handler: Handler;
}

class MiniApp {
  readonly routes: Route[] = [];
  readonly ctx: AppContext;
  readonly log: AppContext['log'];
  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.log = ctx.log;
  }

  private add(method: string, path: string, a: unknown, b?: unknown): this {
    const handler = (typeof a === 'function' ? a : b) as Handler;
    const options = (typeof a === 'function' ? {} : (a ?? {})) as { config?: RouteConfig };
    const parts = path.split('/').filter(Boolean);
    this.routes.push({ method, parts, rank: parts.map((p) => (p.startsWith(':') ? '1' : '0')).join(''), config: options.config ?? {}, handler });
    return this;
  }
  get(path: string, a: unknown, b?: unknown): this {
    return this.add('GET', path, a, b);
  }
  post(path: string, a: unknown, b?: unknown): this {
    return this.add('POST', path, a, b);
  }
  put(path: string, a: unknown, b?: unknown): this {
    return this.add('PUT', path, a, b);
  }
  patch(path: string, a: unknown, b?: unknown): this {
    return this.add('PATCH', path, a, b);
  }
  delete(path: string, a: unknown, b?: unknown): this {
    return this.add('DELETE', path, a, b);
  }
  /** Lifecycle hooks (shutdown flushes) have nothing to do in a page. */
  addHook(): this {
    return this;
  }

  find(method: string, parts: string[]): { route: Route; params: Record<string, string> } | null {
    let best: Route | null = null;
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      if (!route.parts.every((p, i) => p.startsWith(':') || p === parts[i])) continue;
      if (!best || route.rank < best.rank) best = route;
    }
    if (!best) return null;
    const params: Record<string, string> = {};
    best.parts.forEach((p, i) => {
      if (p.startsWith(':')) params[p.slice(1)] = parts[i]!;
    });
    return { route: best, params };
  }
}

export interface ApiRequest {
  method: string;
  /** Path and query string after the `/api` prefix, e.g. `/deals?market_id=1`. */
  target: string;
  headers?: Record<string, string>;
  /** JSON text, or null. File uploads are refused before they get here. */
  body: string | null;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

const READ_ONLY =
  'This is a read-only public snapshot, so changes are switched off here. Editing, price collection and settings work in the full app.';
const NO_FILES =
  'File downloads are not part of the public snapshot. Exports, evidence files and the Excel database are available in the full app.';
const NOT_AVAILABLE = 'This part of the app is not available in the read-only web snapshot.';

/** The only writes a snapshot answers: both compute their result from the stored records. */
const COMPUTED_WRITES = new Set(['POST /reports/generate', 'POST /assistant/query']);

/** Answers that do not depend on anything a visitor can do, so they can be reused. */
const NOT_CACHED = [/^\/assistant\//, /^\/reports\/runs/, /^\/auth\//, /^\/health/];

function json(status: number, payload: unknown): ApiResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) };
}

function failure(status: number, code: string, message: string, details?: unknown): ApiResponse {
  return json(status, { error: { code, message, details } });
}

function parseQuery(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** Same mapping as the error handler in server/app.ts. */
function errorResponse(err: unknown, log: AppContext['log']): ApiResponse {
  if (err instanceof AppError) return failure(err.status, err.code, err.message, err.details);
  if (err instanceof ZodError) return failure(422, 'validation_failed', 'Invalid request', err.issues);
  if (err instanceof SqliteError) {
    if (err.code === 'UNIQUE') return failure(409, 'conflict', 'A record with the same unique value already exists', err.message);
    if (err.code === 'FOREIGN_KEY') return failure(409, 'in_use', 'This record is referenced by other data and cannot be removed');
    if (err.code === 'TRIGGER') return failure(409, 'not_allowed', err.message);
    if (err.code === 'CHECK' || err.code === 'NOT_NULL' || err.code === 'CONSTRAINT') {
      return failure(422, 'validation_failed', 'The data violates a database constraint', err.message);
    }
  }
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return failure(e.statusCode, e.code ?? 'bad_request', e.message ?? 'Bad request');
  }
  log.error({ err }, 'snapshot: unhandled error');
  return failure(500, 'not_in_snapshot', NOT_AVAILABLE);
}

export interface SnapshotServer {
  handle(request: ApiRequest): Promise<ApiResponse>;
  user: AuthUser;
  routes: number;
}

export async function createSnapshotServer(db: Db): Promise<SnapshotServer> {
  const log: AppContext['log'] = {
    info: () => undefined,
    warn: (obj, msg) => console.warn(msg ?? '', obj),
    error: (obj, msg) => console.error(msg ?? '', obj),
  };
  const config: Config = {
    env: 'snapshot',
    isProduction: true,
    host: '',
    port: 0,
    trustProxy: false,
    rootDir: '/',
    dataDir: '/data',
    dbPath: db.path,
    evidenceDir: '/data/evidence',
    importDir: '/data/imports',
    clientDistDir: '/',
    seedDemo: false,
    schedulerEnabled: false,
    adminEmail: null,
    adminPassword: null,
    secretKey: null,
    userAgent: 'PriceIntelligenceOS/1.0',
    allowPrivateNetwork: false,
    allowEmbedding: true,
    rateLimits: false,
    anthropicApiKey: null,
    sessionIdleHours: 12,
    sessionAbsoluteHours: 24 * 7,
    logLevel: 'warn',
  };
  const noSecrets = {
    encrypt(): never {
      throw new Error('Credentials cannot be stored in the read-only web snapshot');
    },
    decrypt(): never {
      throw new Error('The read-only web snapshot holds no credentials');
    },
  } as unknown as SecretBox;
  const ctx: AppContext = { config, db: db as unknown as AppContext['db'], secrets: noSecrets, hooks: createHooks(), log };

  const row = db.get<{ id: number; email: string; name: string; role: RoleKey }>(
    `SELECT u.id, u.email, u.name, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.key = 'viewer' AND u.is_active = 1 ORDER BY u.id LIMIT 1`,
  );
  if (!row) throw new Error('The snapshot database has no read-only account');
  const user: AuthUser = { id: row.id, email: row.email, name: row.name, role: row.role, must_change_password: false, uses_default_password: false };

  // Every module in server/routes, in the order the real server registers them.
  const app = new MiniApp(ctx);
  const modules = import.meta.glob<{ default?: (app: never) => Promise<void> | void }>('../../server/routes/*.ts', { eager: true });
  for (const file of Object.keys(modules).sort()) {
    const register = modules[file]!.default;
    if (typeof register === 'function') await register(app as never);
  }

  const cache = new Map<string, ApiResponse>();

  async function handle(request: ApiRequest): Promise<ApiResponse> {
    const method = request.method.toUpperCase();
    const at = request.target.indexOf('?');
    const pathname = at < 0 ? request.target : request.target.slice(0, at);
    const search = at < 0 ? '' : request.target.slice(at + 1);
    let parts: string[];
    try {
      parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return failure(400, 'bad_request', 'Malformed address');
    }
    const found = app.find(method, parts);
    if (!found) return failure(404, 'not_found', 'Unknown API endpoint');
    const query = parseQuery(search);
    const path = `/${parts.join('/')}`;
    const write = method !== 'GET' && method !== 'HEAD';

    // ---- rules of the snapshot -----------------------------------------------------------------
    if (write && !COMPUTED_WRITES.has(`${method} ${path}`)) return failure(403, 'read_only_snapshot', READ_ONLY);
    if (!write) {
      const file =
        path === '/observations/export' ||
        path.startsWith('/database/') ||
        path.startsWith('/imports/templates/') ||
        /^\/evidence\/[^/]+\/file$/.test(path) ||
        (path === '/reports/export' && query.format !== 'csv');
      if (file) return failure(403, 'not_in_snapshot', NO_FILES);
    }

    const cacheKey = !write && !NOT_CACHED.some((p) => p.test(path)) ? request.target : null;
    if (cacheKey) {
      const hit = cache.get(cacheKey);
      if (hit) return hit;
    }

    try {
      // ---- authentication & authorisation: the same checks as server/app.ts ----------------------
      const routeConfig = found.route.config;
      if (!routeConfig.public) {
        if (!user) throw unauthorized();
        const permission = routeConfig.permission;
        if (permission && permission !== 'any') {
          if (!roleCan(user.role, permission)) throw forbidden();
        } else if (!permission && write && user.role !== 'admin') {
          throw forbidden();
        }
      }

      let body: unknown;
      if (request.body) {
        try {
          body = JSON.parse(request.body);
        } catch {
          return failure(400, 'bad_request', 'The request body is not valid JSON');
        }
      }
      const req: SnapshotRequest = {
        method,
        url: `/api${request.target}`,
        params: found.params,
        query,
        body,
        headers: request.headers ?? {},
        ip: 'snapshot',
        protocol: 'https',
        user,
        sessionToken: null,
        authVia: 'bearer',
        log,
        routeOptions: { config: routeConfig },
        isMultipart: () => false,
        parts: async function* () {
          /* no uploads in a snapshot */
        },
      };
      const reply = new SnapshotReply();
      const result = await found.route.handler(req, reply);
      const payload = reply.sent || result === reply ? reply.payload : result;

      let response: ApiResponse;
      if (payload === undefined || payload === null) {
        response = { status: reply.statusCode, headers: reply.headers, body: null };
      } else if (typeof payload === 'string') {
        response = { status: reply.statusCode, headers: { 'content-type': 'text/plain; charset=utf-8', ...reply.headers }, body: payload };
      } else if (payload instanceof Uint8Array) {
        response = { status: reply.statusCode, headers: { 'content-type': 'application/octet-stream', ...reply.headers }, body: payload };
      } else if (typeof (payload as { pipe?: unknown }).pipe === 'function') {
        return failure(403, 'not_in_snapshot', NO_FILES);
      } else {
        response = { status: reply.statusCode, headers: { 'content-type': 'application/json; charset=utf-8', ...reply.headers }, body: JSON.stringify(payload) };
      }
      if (write) cache.clear();
      else if (cacheKey && response.status === 200) cache.set(cacheKey, response);
      return response;
    } catch (err) {
      return errorResponse(err, log);
    }
  }

  return { handle, user, routes: app.routes.length };
}
