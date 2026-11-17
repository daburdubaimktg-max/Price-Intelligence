import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config.ts';
import { createHooks, type AppContext, type AuthUser } from './context.ts';
import { Db, SqliteError } from './db/sqlite.ts';
import { migrate } from './db/migrate.ts';
import { loadSecretBox } from './lib/crypto.ts';
import { AppError, forbidden, unauthorized } from './lib/errors.ts';
import { authenticate, SESSION_COOKIE } from './auth/auth.ts';
import { roleCan, type Permission } from '../shared/constants.ts';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    user: AuthUser | null;
    sessionToken: string | null;
    authVia: 'cookie' | 'bearer' | null;
  }
  interface FastifyContextConfig {
    /** No session required (sign-in, health). */
    public?: boolean;
    /**
     * Permission needed. Omitted → any signed-in user for GET, administrators only for writes
     * (fail closed). 'any' → any signed-in user, also for writes.
     */
    permission?: Permission | 'any';
    /** Reachable while a password change is still pending. */
    allowPendingPassword?: boolean;
  }
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim() || null;
  return null;
}

/**
 * Cookie-authenticated writes must come from our own pages. Browsers attest this with Sec-Fetch-Site;
 * older clients fall back to an Origin/Host comparison. Bearer-authenticated calls are not exposed to CSRF.
 */
function isCrossSiteWrite(req: FastifyRequest): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function buildApp(overrides: Partial<Config> = {}): Promise<BuiltApp> {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config.dbPath);
  migrate(db);

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  });

  const ctx: AppContext = {
    config,
    db,
    secrets: loadSecretBox(config),
    hooks: createHooks(),
    log: app.log,
  };
  app.decorate('ctx', ctx);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.decorateRequest('authVia', null);

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'https:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        // The app may be shown inside a preview pane or an intranet portal.
        'frame-ancestors': null,
        'upgrade-insecure-requests': null,
      },
    },
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    hsts: config.isProduction && config.trustProxy,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 40 } });
  await app.register(rateLimit, { global: false });

  // ---- authentication & authorisation (default deny) -------------------------------------------
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const bearer = bearerToken(req);
    const cookieToken = req.cookies?.[SESSION_COOKIE] ?? null;
    const token = bearer ?? cookieToken;
    if (!token) return;
    const user = authenticate(ctx, token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
      req.authVia = bearer ? 'bearer' : 'cookie';
    }
  });

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const routeConfig = req.routeOptions?.config ?? {};
    if (routeConfig.public) return;
    if (!req.user) throw unauthorized();
    const write = !SAFE_METHODS.has(req.method);
    if (write && req.authVia === 'cookie' && isCrossSiteWrite(req)) {
      throw forbidden('Cross-site request blocked');
    }
    if (req.user.must_change_password && !routeConfig.allowPendingPassword) {
      throw new AppError(403, 'password_change_required', 'Choose a new password to continue');
    }
    const permission = routeConfig.permission;
    if (permission === 'any') return;
    if (permission) {
      if (!roleCan(req.user.role, permission)) throw forbidden();
      return;
    }
    if (write && req.user.role !== 'admin') throw forbidden();
  });

  // ---- errors ----------------------------------------------------------------------------------
  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.code(422).send({ error: { code: 'validation_failed', message: 'Invalid request', details: err.issues } });
    }
    if (err instanceof SqliteError) {
      if (err.code === 'UNIQUE') {
        return reply.code(409).send({ error: { code: 'conflict', message: 'A record with the same unique value already exists', details: err.message } });
      }
      if (err.code === 'FOREIGN_KEY') {
        return reply.code(409).send({ error: { code: 'in_use', message: 'This record is referenced by other data and cannot be removed' } });
      }
      if (err.code === 'TRIGGER') {
        return reply.code(409).send({ error: { code: 'not_allowed', message: err.message } });
      }
      if (err.code === 'CHECK' || err.code === 'NOT_NULL' || err.code === 'CONSTRAINT') {
        return reply.code(422).send({ error: { code: 'validation_failed', message: 'The data violates a database constraint', details: err.message } });
      }
    }
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message ?? 'Bad request' } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong on the server' } });
  });

  // ---- API routes: every module in ./routes is registered under /api ---------------------------
  const routesDir = path.join(import.meta.dirname, 'routes');
  const routeFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
  for (const file of routeFiles) {
    const mod = (await import(path.join(routesDir, file))) as { default?: (app: FastifyInstance) => Promise<void> | void };
    if (typeof mod.default === 'function') await app.register(mod.default, { prefix: '/api' });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Unknown API endpoint' } });
    }
    if (req.method === 'GET' && fs.existsSync(path.join(config.clientDistDir, 'index.html'))) {
      // Single-page app: unknown paths are client-side routes.
      return reply.type('text/html').send(fs.readFileSync(path.join(config.clientDistDir, 'index.html')));
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found. Build the web client with `npm run build`.' } });
  });

  if (fs.existsSync(config.clientDistDir)) {
    await app.register(fastifyStatic, {
      root: config.clientDistDir,
      prefix: '/',
      wildcard: false,
      setHeaders(reply, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else reply.header('Cache-Control', 'no-cache');
      },
    });
  }

  app.addHook('onClose', async () => {
    db.close();
  });

  return { app, ctx };
}
