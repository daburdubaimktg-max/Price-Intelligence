/**
 * Price Intelligence OS — server entry point.
 * Starts the HTTP API (and serves the built web client), prepares an empty database on first run and
 * starts the always-on collection scheduler.
 */
import { buildApp } from './app.ts';
import { ensureInitialUsers } from './auth/auth.ts';
import { ensureReferenceData } from './seed/reference.ts';

const { app, ctx } = await buildApp();

ensureReferenceData(ctx);

const users = await ensureInitialUsers(ctx);
if (users.generatedPassword) {
  // Printed once, on first start only. The account must choose a new password at first sign-in.
  console.log('\n==================================================================');
  console.log(' First-run administrator account created');
  console.log(`   e-mail:   ${users.created[0]}`);
  console.log(`   password: ${users.generatedPassword}`);
  console.log(' You will be asked to choose a new password when you sign in.');
  console.log('==================================================================\n');
} else if (users.created.length) {
  console.log(`[setup] created account(s): ${users.created.join(', ')}`);
}

// Optional modules are loaded dynamically so the server still starts if one is absent in a slim build.
const catalogueEmpty =
  (ctx.db.scalar<number>('SELECT COUNT(*) FROM products') ?? 0) === 0 && (ctx.db.scalar<number>('SELECT COUNT(*) FROM retailers') ?? 0) === 0;
if (ctx.config.seedDemo && catalogueEmpty) {
  const { seedDemo } = await import('./seed/demo.ts');
  const started = Date.now();
  const summary = await seedDemo(ctx);
  console.log(`[setup] DEMO dataset loaded in ${Date.now() - started} ms: ${JSON.stringify(summary)}`);
}

let scheduler: { stop: () => Promise<void> | void } | null = null;
if (ctx.config.schedulerEnabled) {
  const { startScheduler } = await import('./services/collection/scheduler.ts');
  scheduler = startScheduler(ctx);
} else {
  // PIOS_SCHEDULER=off stops scheduled collection only. Housekeeping that contacts no retailer keeps running:
  // the Excel copy of the database, stale-data and failing-source alerts, exchange-rate refresh.
  const { fireHook } = await import('./context.ts');
  const timer = setInterval(() => fireHook(ctx, ctx.hooks.schedulerTick, new Date()), 60_000);
  timer.unref();
  scheduler = { stop: () => clearInterval(timer) };
  console.log('[setup] scheduled collection is off (PIOS_SCHEDULER=off); sources run only when started manually');
}
try {
  const { markMirrorAutoRefresh } = await import('./services/database-export.ts');
  markMirrorAutoRefresh(ctx, true);
} catch {
  /* the Excel mirror module is optional in a slim build */
}

await app.listen({ port: ctx.config.port, host: ctx.config.host });
console.log(`Price Intelligence OS listening on http://localhost:${ctx.config.port} (${ctx.config.env})`);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[shutdown] ${signal} received`);
  try {
    await scheduler?.stop();
    await app.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
