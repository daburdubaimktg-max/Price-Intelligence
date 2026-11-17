import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkPassword, demoLoginHint, login, logout, revokeUserSessions, SESSION_COOKIE, setPassword } from '../auth/auth.ts';
import { passwordProblem } from '../lib/crypto.ts';
import { badRequest, unprocessable } from '../lib/errors.ts';
import { parse } from '../lib/http.ts';
import { audit, getSetting } from '../services/core.ts';
import { PERMISSIONS, roleCan, type Permission } from '../../shared/constants.ts';

const APP_VERSION = '1.0.0';

export default async function authRoutes(app: FastifyInstance) {
  const { ctx } = app;

  app.get('/health', { config: { public: true } }, async () => {
    ctx.db.scalar('SELECT 1');
    return { status: 'ok', version: APP_VERSION, time: new Date().toISOString() };
  });

  /** What the sign-in screen needs before anyone is authenticated. */
  app.get('/auth/info', { config: { public: true } }, async () => {
    return {
      app: 'Price Intelligence OS',
      version: APP_VERSION,
      demo_login: demoLoginHint(ctx),
    };
  });

  app.post(
    '/auth/login',
    { config: { public: true, rateLimit: { max: 20, timeWindow: '5 minutes' } } },
    async (req, reply) => {
      const body = parse(z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(200) }), req.body);
      const result = await login(ctx, body.email, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
      reply.setCookie(SESSION_COOKIE, result.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.protocol === 'https',
        path: '/',
        maxAge: ctx.config.sessionAbsoluteHours * 3600,
      });
      // The token is also returned so the web client can fall back to an Authorization header where the
      // browser refuses cookies (e.g. when the app is embedded in another site's frame).
      return { user: result.user, token: result.token, expires_at: result.expiresAt };
    },
  );

  app.post('/auth/logout', { config: { permission: 'any', allowPendingPassword: true } }, async (req, reply) => {
    if (req.sessionToken) logout(ctx, req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { config: { allowPendingPassword: true } }, async (req) => {
    const user = req.user!;
    const permissions = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => roleCan(user.role, p));
    const demo = {
      observations: ctx.db.scalar<number>('SELECT COUNT(*) FROM price_observations WHERE is_demo = 1') ?? 0,
      products: ctx.db.scalar<number>('SELECT COUNT(*) FROM products WHERE is_demo = 1') ?? 0,
    };
    const realObservations = ctx.db.scalar<number>('SELECT COUNT(*) FROM price_observations WHERE is_demo = 0') ?? 0;
    return {
      user,
      permissions,
      app: {
        version: APP_VERSION,
        reporting_currency: getSetting(ctx, 'reporting_currency'),
        organisation_name: getSetting(ctx, 'organisation_name'),
        demo_data_present: demo.observations > 0 || demo.products > 0,
        demo_observations: demo.observations,
        real_observations: realObservations,
      },
    };
  });

  app.post('/auth/change-password', { config: { permission: 'any', allowPendingPassword: true } }, async (req) => {
    const body = parse(z.object({ current_password: z.string().min(1), new_password: z.string().min(1).max(200) }), req.body);
    const user = req.user!;
    if (!(await checkPassword(ctx, user.id, body.current_password))) throw badRequest('Current password is incorrect');
    const problem = passwordProblem(body.new_password);
    if (problem) throw unprocessable(problem);
    if (body.new_password === body.current_password) throw unprocessable('Choose a password different from the current one');
    await setPassword(ctx, user.id, body.new_password);
    revokeUserSessions(ctx, user.id, req.sessionToken ?? undefined);
    audit(ctx, user, 'auth.password_changed', 'user', user.id, null, req.ip);
    return { ok: true };
  });
}
