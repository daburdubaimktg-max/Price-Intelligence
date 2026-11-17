import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { ago, createFixture, createTestApp, TEST_PASSWORD, type TestApp } from './helpers.ts';
import { fireHook } from '../server/context.ts';
import { ingestObservations } from '../server/services/ingestion.ts';
import { SETTING_DEFAULTS } from '../server/services/core.ts';

let t: TestApp;

before(async () => {
  t = await createTestApp();
});
after(async () => {
  await t.close();
});

/** Calls the API with an arbitrary session token (for users created during the tests). */
async function withToken(token: string, method: string, url: string, body?: unknown) {
  const res = await t.app.inject({ method: method as 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, payload: body as never });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, body: json };
}

async function signIn(email: string, password: string) {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return { status: res.statusCode, token: res.statusCode === 200 ? (res.json().token as string) : '' };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

interface Fixture {
  url: string;
  origin: string;
  requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }>;
  /** What the next responses look like. */
  status: number;
  payload: unknown;
  close: () => Promise<void>;
}

async function startHttpFixture(path = '/hooks/secret-token-ABC'): Promise<Fixture> {
  const fixture: Fixture = { url: '', origin: '', requests: [], status: 200, payload: { ok: true }, close: async () => undefined };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      fixture.requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: raw });
      res.writeHead(fixture.status, { 'content-type': 'application/json' });
      res.end(typeof fixture.payload === 'string' ? fixture.payload : JSON.stringify(fixture.payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture.url = `${fixture.origin}${path}`;
  fixture.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fixture;
}

interface Sink {
  port: number;
  messages: Array<{ from: string; to: string[]; data: string }>;
  close: () => Promise<void>;
}

/** Minimal SMTP server that accepts every message (no TLS, no auth). */
async function startSmtpSink(): Promise<Sink> {
  const messages: Sink['messages'] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let current = { from: '', to: [] as string[], data: '' };
    socket.write('220 localhost ESMTP test sink\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { from: '', to: [], data: '' };
          socket.write('250 OK queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-localhost\r\n250 SIZE 10485760\r\n');
        else if (cmd.startsWith('MAIL FROM')) {
          current.from = line;
          socket.write('250 OK\r\n');
        } else if (cmd.startsWith('RCPT TO')) {
          current.to.push(line);
          socket.write('250 OK\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

const AI_KEY = 'sk-ant-test-SECRETKEYVALUE-7781';
const SMTP_PASSWORD = 'smtp-SECRETPASSWORD-9912';
const FX_KEY = 'fx-SECRETFXKEY-5567';

describe('users and roles', () => {
  it('lists users without any credential material, for administrators only', async () => {
    const res = await t.api('GET', '/users');
    assert.equal(res.status, 200);
    assert.equal(res.body.rows.length, 3);
    const admin = res.body.rows.find((u: any) => u.email === 'admin@test.local');
    assert.equal(admin.role, 'admin');
    assert.equal(admin.role_name, 'Administrator');
    assert.equal(admin.is_active, true);
    assert.equal(admin.locked, false);
    assert.equal(admin.must_change_password, false);
    assert.ok(admin.active_sessions >= 1);
    assert.ok(admin.last_login_at);
    assert.ok(!/scrypt|password_hash|token_hash/.test(res.raw));
    assert.equal((await t.api('GET', '/users', { as: 'analyst' })).status, 403);
    assert.equal((await t.api('GET', '/users', { as: 'viewer' })).status, 403);
    assert.equal((await t.api('GET', '/users', { as: null })).status, 401);
  });

  it('describes roles with their permissions', async () => {
    const res = await t.api('GET', '/roles', { as: 'viewer' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows.map((r: any) => r.key), ['admin', 'analyst', 'viewer']);
    const byKey = Object.fromEntries(res.body.rows.map((r: any) => [r.key, r]));
    assert.ok(byKey.admin.permissions.includes('admin.users'));
    assert.ok(byKey.analyst.permissions.includes('catalogue.write'));
    assert.ok(!byKey.analyst.permissions.includes('admin.users'));
    assert.ok(!byKey.viewer.permissions.includes('observations.write'));
    assert.equal(byKey.admin.user_count, 1);
  });

  it('creates a user with a generated password that works once and must be changed', async () => {
    const created = await t.api('POST', '/users', { body: { email: 'New.Analyst@Test.Local', name: '  New Analyst ', role: 'analyst' } });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.user.email, 'new.analyst@test.local');
    assert.equal(created.body.user.name, 'New Analyst');
    assert.equal(created.body.user.role, 'analyst');
    assert.equal(created.body.user.must_change_password, true);
    const password = created.body.generated_password as string;
    assert.ok(password.length >= 16);

    // the password is shown once only — it is not retrievable afterwards and not audited
    assert.ok(!(await t.api('GET', '/users')).raw.includes(password));
    assert.ok(!JSON.stringify(t.ctx.db.all('SELECT detail FROM audit_log')).includes(password));

    const session = await signIn('new.analyst@test.local', password);
    assert.equal(session.status, 200);
    const me = await withToken(session.token, 'GET', '/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.must_change_password, true);
    const blocked = await withToken(session.token, 'GET', '/alerts');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'password_change_required');

    const changed = await withToken(session.token, 'POST', '/auth/change-password', { current_password: password, new_password: 'A-Brand-New-Pass-2026' });
    assert.equal(changed.status, 200);
    assert.equal((await withToken(session.token, 'GET', '/alerts')).status, 200);
    assert.equal((await signIn('new.analyst@test.local', password)).status, 401, 'the temporary password no longer works');
  });

  it('validates new users', async () => {
    const post = (body: Record<string, unknown>) => t.api('POST', '/users', { body });
    assert.equal((await post({ email: 'new.analyst@test.local', name: 'Dup', role: 'viewer' })).status, 409);
    assert.equal((await post({ email: 'ADMIN@test.local', name: 'Dup', role: 'viewer' })).status, 409);
    assert.equal((await post({ email: 'not-an-email', name: 'X', role: 'viewer' })).status, 422);
    assert.equal((await post({ email: 'x@test.local', name: '', role: 'viewer' })).status, 422);
    assert.equal((await post({ email: 'x@test.local', name: 'X', role: 'owner' })).status, 422);
    const weak = await post({ email: 'x@test.local', name: 'X', role: 'viewer', password: 'short1' });
    assert.equal(weak.status, 422);
    assert.match(weak.body.error.message, /at least 10 characters/);
    assert.equal((await t.api('POST', '/users', { as: 'analyst', body: { email: 'x@test.local', name: 'X', role: 'viewer' } })).status, 403);

    // a supplied password is temporary by default, unless the administrator says otherwise
    const temp = await post({ email: 'temp@test.local', name: 'Temp', role: 'viewer', password: 'Chosen-By-Admin-2026' });
    assert.equal(temp.status, 201);
    assert.equal(temp.body.generated_password, null);
    assert.equal(temp.body.user.must_change_password, true);
    const direct = await post({ email: 'direct@test.local', name: 'Direct', role: 'viewer', password: 'Chosen-By-Admin-2026', must_change_password: false });
    assert.equal(direct.body.user.must_change_password, false);
    const session = await signIn('direct@test.local', 'Chosen-By-Admin-2026');
    assert.equal((await withToken(session.token, 'GET', '/alerts')).status, 200);
  });

  it('changes roles and activation, protecting the acting and the last administrator', async () => {
    const me = (await t.api('GET', '/auth/me')).body.user;
    const selfRole = await t.api('PATCH', `/users/${me.id}`, { body: { role: 'viewer' } });
    assert.equal(selfRole.status, 409);
    assert.match(selfRole.body.error.message, /your own role/);
    assert.equal((await t.api('PATCH', `/users/${me.id}`, { body: { is_active: false } })).status, 409);
    // renaming yourself is fine
    assert.equal((await t.api('PATCH', `/users/${me.id}`, { body: { name: 'Test admin' } })).status, 200);

    const second = await t.api('POST', '/users', { body: { email: 'second.admin@test.local', name: 'Second Admin', role: 'admin', password: TEST_PASSWORD, must_change_password: false } });
    assert.equal(second.status, 201);
    const b = await signIn('second.admin@test.local', TEST_PASSWORD);

    // B demotes A: allowed because B remains an active administrator; A loses admin rights immediately
    const demote = await withToken(b.token, 'PATCH', `/users/${me.id}`, { role: 'analyst' });
    assert.equal(demote.status, 200);
    assert.equal(demote.body.role, 'analyst');
    assert.equal((await t.api('GET', '/users')).status, 403);
    // B is now the only administrator and cannot remove that from themself
    assert.equal((await withToken(b.token, 'PATCH', `/users/${second.body.user.id}`, { role: 'viewer' })).status, 409);
    assert.equal((await withToken(b.token, 'PATCH', `/users/${second.body.user.id}`, { is_active: false })).status, 409);
    assert.equal((await withToken(b.token, 'PATCH', `/users/${me.id}`, { role: 'admin' })).status, 200);

    // deactivating a user ends their sessions
    const off = await t.api('PATCH', `/users/${second.body.user.id}`, { body: { is_active: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.is_active, false);
    assert.equal(off.body.active_sessions, 0);
    assert.equal((await withToken(b.token, 'GET', '/auth/me')).status, 401);
    assert.equal((await signIn('second.admin@test.local', TEST_PASSWORD)).status, 401);

    assert.equal((await t.api('PATCH', '/users/999999', { body: { name: 'x' } })).status, 404);
    assert.equal((await t.api('PATCH', `/users/${second.body.user.id}`, { body: { email: 'other@test.local' } })).status, 422);
    assert.equal((await t.api('PATCH', `/users/${second.body.user.id}`, { as: 'analyst', body: { is_active: true } })).status, 403);
  });

  it('resets a password to a temporary one, revoking existing sessions', async () => {
    const created = await t.api('POST', '/users', { body: { email: 'reset.me@test.local', name: 'Reset Me', role: 'viewer', password: 'Original-Pass-2026', must_change_password: false } });
    const id = created.body.user.id;
    const old = await signIn('reset.me@test.local', 'Original-Pass-2026');
    assert.equal((await withToken(old.token, 'GET', '/auth/me')).status, 200);

    assert.equal((await t.api('POST', `/users/${id}/reset-password`, { as: 'analyst', body: {} })).status, 403);
    const reset = await t.api('POST', `/users/${id}/reset-password`, { body: {} });
    assert.equal(reset.status, 200);
    const temporary = reset.body.temporary_password as string;
    assert.ok(temporary.length >= 16);
    assert.equal(reset.body.user.must_change_password, true);

    assert.equal((await withToken(old.token, 'GET', '/auth/me')).status, 401, 'old sessions are revoked');
    assert.equal((await signIn('reset.me@test.local', 'Original-Pass-2026')).status, 401);
    const fresh = await signIn('reset.me@test.local', temporary);
    assert.equal(fresh.status, 200);
    assert.equal((await withToken(fresh.token, 'GET', '/settings')).status, 403);

    const self = (await t.api('GET', '/auth/me')).body.user.id;
    assert.equal((await t.api('POST', `/users/${self}/reset-password`, { body: {} })).status, 400);
    assert.ok(!JSON.stringify(t.ctx.db.all('SELECT detail FROM audit_log')).includes(temporary));
  });
});

describe('settings', () => {
  it('gives non-administrators only the public subset', async () => {
    const viewer = await t.api('GET', '/settings', { as: 'viewer' });
    assert.deepEqual(viewer.body, { reporting_currency: 'AED', organisation_name: '' });
    const analyst = await t.api('GET', '/settings', { as: 'analyst' });
    assert.deepEqual(Object.keys(analyst.body).sort(), ['organisation_name', 'reporting_currency']);

    const admin = await t.api('GET', '/settings');
    assert.equal(admin.body.promo_gap_days, 10);
    assert.equal(admin.body.alert_max_age_hours, 48);
    assert.equal(admin.body.collection_max_retries, 2);
    assert.deepEqual(admin.body.alert_webhook, { configured: false, target: null });
    assert.equal(admin.body.smtp, null);
    assert.equal(admin.body.fx_provider, SETTING_DEFAULTS.fx_provider_url);
    assert.ok(!('alert_webhook_url' in admin.body));
  });

  it('validates updates', async () => {
    const bad = async (body: Record<string, unknown>, pattern: RegExp) => {
      const res = await t.api('PUT', '/settings', { body });
      assert.equal(res.status, 422, res.raw);
      assert.match(res.body.error.message, pattern);
    };
    await bad({ reporting_currency: 'ZZZ' }, /not a known currency/);
    await bad({ reporting_currency: 'DIRHAM' }, /3-letter/);
    await bad({ promo_gap_days: 0 }, /promo_gap_days must be a whole number between 1 and 60/);
    await bad({ promo_gap_days: 61 }, /between 1 and 60/);
    await bad({ promo_gap_days: 2.5 }, /whole number/);
    await bad({ alert_max_age_hours: 0 }, /between 1 and 720/);
    await bad({ alert_max_age_hours: 721 }, /between 1 and 720/);
    await bad({ collection_max_retries: 6 }, /between 0 and 5/);
    await bad({ collection_max_retries: -1 }, /between 0 and 5/);
    await bad({ organisation_name: 'x'.repeat(121) }, /at most 120/);
    await bad({ alert_webhook_url: 'https://example.com/hook' }, /Invalid settings/);
    assert.equal((await t.api('PUT', '/settings', { as: 'analyst', body: { organisation_name: 'x' } })).status, 403);
    assert.equal((await t.api('PUT', '/settings', { as: 'viewer', body: { organisation_name: 'x' } })).status, 403);
    assert.equal((await t.api('GET', '/settings')).body.promo_gap_days, 10, 'nothing was changed by rejected requests');
  });

  it('applies updates and recomputes promotion episodes when the gap setting changes', async () => {
    const f = createFixture(t.ctx, { retailerName: 'Settings Mart' });
    // two promotional observations 8 days apart: one episode with a 10-day gap, two with a 7-day gap
    ingestObservations(
      t.ctx,
      [
        { listing_id: f.compListingId, observed_at: ago(20), current_price: 24, regular_price: 30 },
        { listing_id: f.compListingId, observed_at: ago(12), current_price: 24, regular_price: 30 },
      ],
      { sourceMethod: 'csv_import' },
    );
    const episodes = () => t.ctx.db.scalar<number>('SELECT COUNT(*) FROM promotions WHERE listing_id = ?', [f.compListingId]);
    assert.equal(episodes(), 1);

    const res = await t.api('PUT', '/settings', {
      body: { reporting_currency: 'usd', organisation_name: '  Dabur International ', promo_gap_days: '7', alert_max_age_hours: 72, collection_max_retries: 3 },
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.settings.reporting_currency, 'USD');
    assert.equal(res.body.settings.organisation_name, 'Dabur International');
    assert.equal(res.body.settings.promo_gap_days, 7);
    assert.equal(res.body.settings.alert_max_age_hours, 72);
    assert.equal(res.body.settings.collection_max_retries, 3);
    assert.ok(res.body.rebuilt_listings >= 1);
    assert.equal(episodes(), 2);

    const same = await t.api('PUT', '/settings', { body: { promo_gap_days: 7 } });
    assert.equal(same.body.rebuilt_listings, null);
    assert.deepEqual((await t.api('GET', '/settings', { as: 'viewer' })).body, { reporting_currency: 'USD', organisation_name: 'Dabur International' });
    assert.equal((await t.api('GET', '/auth/me')).body.app.reporting_currency, 'USD');
    await t.api('PUT', '/settings', { body: { reporting_currency: 'AED', promo_gap_days: 10 } });
    assert.equal(episodes(), 1);
  });
});

describe('integrations', () => {
  let hook: Fixture;
  let sink: Sink;
  before(async () => {
    hook = await startHttpFixture();
    sink = await startSmtpSink();
  });
  after(async () => {
    await hook.close();
    await sink.close();
  });

  it('reports an honest initial status and is restricted to administrators', async () => {
    assert.equal((await t.api('GET', '/integrations', { as: 'analyst' })).status, 403);
    assert.equal((await t.api('GET', '/integrations', { as: 'viewer' })).status, 403);
    const res = await t.api('GET', '/integrations');
    assert.equal(res.status, 200);
    const { ai, smtp, webhook, fx } = res.body;
    assert.equal(ai.provider, 'builtin');
    assert.equal(ai.state, 'built_in');
    assert.deepEqual(ai.api_key, { configured: false, hint: null, updated_at: null });
    assert.match(ai.explanation, /built-in query engine/);
    assert.equal(smtp.configured, false);
    assert.equal(smtp.state, 'not_configured');
    assert.match(smtp.explanation, /not configured \(missing SMTP host and sender address\)/);
    assert.equal(webhook.configured, false);
    assert.equal(webhook.target, null);
    assert.equal(fx.state, 'not_configured');
    assert.equal(fx.uses_default_provider, true);
    assert.equal(fx.provider, SETTING_DEFAULTS.fx_provider_url);
    assert.equal(fx.latest_as_of, null);
    assert.match(fx.explanation, /No exchange rates are stored/);
  });

  it('stores the AI key encrypted and never returns it', async () => {
    assert.equal((await t.api('PUT', '/integrations/ai', { as: 'analyst', body: { provider: 'anthropic' } })).status, 403);
    assert.equal((await t.api('PUT', '/integrations/ai', { body: { provider: 'anthropic', model: 'bad model!' } })).status, 422);
    assert.equal((await t.api('PUT', '/integrations/ai', { body: { provider: 'openai' } })).status, 422);

    const noKey = await t.api('PUT', '/integrations/ai', { body: { provider: 'anthropic', model: 'claude-opus-5-5' } });
    assert.equal(noKey.status, 200);
    assert.equal(noKey.body.state, t.ctx.config.anthropicApiKey ? 'ready' : 'not_configured');

    const put = await t.api('PUT', '/integrations/ai', { body: { provider: 'anthropic', model: 'claude-opus-5-5', api_key: AI_KEY } });
    assert.equal(put.status, 200, put.raw);
    assert.equal(put.body.provider, 'anthropic');
    assert.equal(put.body.model, 'claude-opus-5-5');
    assert.equal(put.body.state, 'ready');
    assert.equal(put.body.api_key.configured, true);
    assert.equal(put.body.api_key.hint, '…7781');
    assert.ok(!put.raw.includes('SECRETKEYVALUE'));
    assert.ok(!(await t.api('GET', '/integrations')).raw.includes('SECRETKEYVALUE'));
    assert.ok(!(await t.api('GET', '/settings')).raw.includes('SECRETKEYVALUE'));
    const stored = t.ctx.db.get<{ ciphertext: string }>(`SELECT ciphertext FROM secrets WHERE name = 'integration:anthropic:api_key'`)!;
    assert.ok(!stored.ciphertext.includes('SECRETKEYVALUE'));
    assert.ok(!Buffer.from(stored.ciphertext, 'base64').toString('latin1').includes('SECRETKEYVALUE'));

    const removed = await t.api('DELETE', '/integrations/ai/key');
    assert.equal(removed.body.api_key.configured, false);
    assert.equal(removed.body.state, t.ctx.config.anthropicApiKey ? 'ready' : 'not_configured');
    const builtin = await t.api('PUT', '/integrations/ai', { body: { provider: 'builtin' } });
    assert.equal(builtin.body.state, 'built_in');
    assert.equal(builtin.body.model, 'claude-opus-5-5', 'the model is kept when not supplied');
  });

  it('configures SMTP, really sends a test e-mail and reports real failures', async () => {
    const notConfigured = await t.api('POST', '/integrations/smtp/test', { body: { to: 'ops@test.local' } });
    assert.equal(notConfigured.status, 400);
    assert.equal(notConfigured.body.error.code, 'not_configured');

    const base = { host: '127.0.0.1', port: sink.port, secure: false, user: '', from: 'Price Alerts <alerts@test.local>' };
    assert.equal((await t.api('PUT', '/integrations/smtp', { body: { ...base, from: 'not an address' } })).status, 422);
    assert.equal((await t.api('PUT', '/integrations/smtp', { body: { ...base, port: 70000 } })).status, 422);
    assert.equal((await t.api('PUT', '/integrations/smtp', { body: { ...base, host: '' } })).status, 422);
    assert.equal((await t.api('PUT', '/integrations/smtp', { body: { ...base, recipients: ['nope'] } })).status, 422);
    assert.equal((await t.api('PUT', '/integrations/smtp', { as: 'analyst', body: base })).status, 403);

    const put = await t.api('PUT', '/integrations/smtp', { body: { ...base, password: SMTP_PASSWORD, recipients: ['Pricing@Test.Local', 'pricing@test.local', 'lead@test.local'] } });
    assert.equal(put.status, 200, put.raw);
    assert.equal(put.body.configured, true);
    assert.equal(put.body.state, 'ready');
    assert.equal(put.body.host, '127.0.0.1');
    assert.equal(put.body.port, sink.port);
    assert.equal(put.body.from, 'Price Alerts <alerts@test.local>');
    assert.equal(put.body.password.configured, true);
    assert.deepEqual(put.body.recipients, ['pricing@test.local', 'lead@test.local']);
    assert.ok(!put.raw.includes('SECRETPASSWORD'));
    assert.ok(!(await t.api('GET', '/settings')).raw.includes('SECRETPASSWORD'));

    assert.equal((await t.api('POST', '/integrations/smtp/test', { body: { to: 'nobody' } })).status, 422);
    const ok = await t.api('POST', '/integrations/smtp/test', { body: { to: 'ops@test.local' } });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.ok, true);
    assert.deepEqual(ok.body.accepted, ['ops@test.local']);
    assert.ok(ok.body.message_id);
    assert.equal(sink.messages.length, 1);
    assert.match(sink.messages[0]!.to[0]!, /ops@test\.local/);
    assert.match(sink.messages[0]!.from, /alerts@test\.local/);
    assert.match(sink.messages[0]!.data, /This is a test message from Price Intelligence OS/);

    // the mail server disappears: the test reports the real failure instead of pretending
    await sink.close();
    const failed = await t.api('POST', '/integrations/smtp/test', { body: { to: 'ops@test.local' } });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.ok, false);
    assert.ok(failed.body.error);
    sink = await startSmtpSink();

    const cleared = await t.api('DELETE', '/integrations/smtp');
    assert.equal(cleared.body.configured, false);
    assert.equal(cleared.body.password.configured, false);
    assert.equal((await t.api('POST', '/integrations/smtp/test', { body: { to: 'ops@test.local' } })).status, 400);

    // PUT with a literal JSON null clears the configuration as well
    await t.api('PUT', '/integrations/smtp', { body: { ...base, password: SMTP_PASSWORD } });
    const viaNull = await t.app.inject({
      method: 'PUT',
      url: '/api/integrations/smtp',
      headers: { authorization: `Bearer ${t.tokens.admin}`, 'content-type': 'application/json' },
      payload: 'null',
    });
    assert.equal(viaNull.statusCode, 200, viaNull.body);
    assert.equal(viaNull.json().configured, false);
    assert.equal(viaNull.json().password.configured, false);
  });

  it('configures the webhook, masks its URL and really posts a test message', async () => {
    assert.equal((await t.api('POST', '/integrations/webhook/test', { body: {} })).status, 400);
    assert.equal((await t.api('PUT', '/integrations/webhook', { body: { url: 'ftp://example.com/hook' } })).status, 422);
    assert.equal((await t.api('PUT', '/integrations/webhook', { body: { url: 'not a url' } })).status, 422);
    assert.equal((await t.api('PUT', '/integrations/webhook', { as: 'analyst', body: { url: hook.url } })).status, 403);

    const put = await t.api('PUT', '/integrations/webhook', { body: { url: hook.url } });
    assert.equal(put.status, 200, put.raw);
    assert.equal(put.body.configured, true);
    assert.equal(put.body.target, `${hook.origin}/…`);
    for (const res of [put, await t.api('GET', '/integrations'), await t.api('GET', '/settings')]) {
      assert.ok(!res.raw.includes('secret-token-ABC'), 'the token-bearing path is never returned');
    }

    const ok = await t.api('POST', '/integrations/webhook/test', { body: {} });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.status, 200);
    assert.equal(typeof ok.body.duration_ms, 'number');
    assert.equal(hook.requests.length, 1);
    assert.equal(hook.requests[0]!.method, 'POST');
    assert.equal(hook.requests[0]!.path, '/hooks/secret-token-ABC');
    const payload = JSON.parse(hook.requests[0]!.body);
    assert.equal(payload.type, 'test');
    assert.match(payload.text, /test notification/);

    hook.status = 503;
    const failed = await t.api('POST', '/integrations/webhook/test', { body: {} });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.status, 503);
    assert.match(failed.body.error, /HTTP 503/);
    hook.status = 200;

    const cleared = await t.api('PUT', '/integrations/webhook', { body: { url: null } });
    assert.equal(cleared.body.configured, false);
    assert.equal((await t.api('POST', '/integrations/webhook/test', { body: {} })).status, 400);
  });

  it('never writes credentials to the audit log', () => {
    const audit = JSON.stringify(t.ctx.db.all('SELECT action, detail FROM audit_log'));
    for (const secret of ['SECRETKEYVALUE', 'SECRETPASSWORD', 'secret-token-ABC']) assert.ok(!audit.includes(secret));
    const entry = t.ctx.db.get<{ detail: string }>(`SELECT detail FROM audit_log WHERE action = 'integration.ai.update' AND detail LIKE '%"api_key_updated":true%'`);
    assert.ok(entry, 'the update itself is audited');
  });
});

describe('exchange rates', () => {
  let provider: Fixture;
  const publishedAt = Math.floor((Date.now() - 3_600_000) / 1000);
  before(async () => {
    provider = await startHttpFixture('/v6/KEY-IN-PATH-4411/latest/USD');
    provider.payload = {
      result: 'success',
      base_code: 'USD',
      time_last_update_unix: publishedAt,
      rates: { USD: 1, AED: 3.6725, SAR: 3.75, KES: 129.98, XXX: 5 },
    };
  });
  after(async () => {
    await provider.close();
  });

  it('starts empty and lists currencies without a rate as missing', async () => {
    const res = await t.api('GET', '/exchange-rates', { as: 'viewer' });
    assert.equal(res.status, 200);
    assert.equal(res.body.base, 'USD');
    assert.equal(res.body.reporting_currency, 'AED');
    assert.deepEqual(res.body.rates, []);
    assert.ok(res.body.missing.some((c: any) => c.code === 'AED'));
    assert.ok(!res.body.missing.some((c: any) => c.code === 'USD'));
    assert.equal(res.body.contains_demo_rates, false);
  });

  it('records manual rates with source and timestamp, append-only', async () => {
    const asOf = ago(2);
    const post = (body: Record<string, unknown>, as: 'admin' | 'analyst' | 'viewer' = 'admin') => t.api('POST', '/exchange-rates', { as, body });
    const created = await post({ currency: 'aed', rate: '3.67', as_of: asOf, source_ref: 'Central bank bulletin' });
    assert.equal(created.status, 201, created.raw);
    assert.deepEqual(created.body, { currency: 'AED', rate: 3.67, as_of: asOf, source: 'manual' });

    const dup = await post({ currency: 'AED', rate: 3.7, as_of: asOf });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /never overwritten/);
    assert.equal((await post({ currency: 'USD', rate: 1 })).status, 422);
    assert.equal((await post({ currency: 'ZZZ', rate: 2 })).status, 422);
    assert.equal((await post({ currency: 'AED', rate: 0 })).status, 422);
    assert.equal((await post({ currency: 'AED', rate: -3 })).status, 422);
    assert.equal((await post({ currency: 'AED', rate: 3.6, as_of: new Date(Date.now() + 86_400_000).toISOString() })).status, 422);
    assert.equal((await post({ currency: 'AED', rate: 3.6, as_of: 'yesterday' })).status, 422);
    assert.equal((await post({ currency: 'AED', rate: 3.6 }, 'analyst')).status, 403);
    assert.equal((await post({ currency: 'AED', rate: 3.6 }, 'viewer')).status, 403);

    const list = await t.api('GET', '/exchange-rates');
    assert.equal(list.body.rates.length, 1);
    const aed = list.body.rates[0];
    assert.equal(aed.currency, 'AED');
    assert.equal(aed.currency_name, 'UAE Dirham');
    assert.equal(aed.rate, 3.67);
    assert.equal(aed.as_of, asOf);
    assert.equal(aed.source, 'manual');
    assert.equal(aed.is_demo, false);
    assert.ok(Math.abs(aed.age_hours - 48) < 0.5);

    // a date-only timestamp is accepted too
    const dated = await post({ currency: 'KWD', rate: 0.307, as_of: ago(5).slice(0, 10) });
    assert.equal(dated.status, 201);
    assert.match(dated.body.as_of, /T00:00:00\.000Z$/);

    const history = await t.api('GET', '/exchange-rates/history?currency=aed');
    assert.equal(history.body.currency, 'AED');
    assert.equal(history.body.rows.length, 1);
    assert.equal(history.body.rows[0].entered_by_name, 'Test admin');
    assert.equal(history.body.rows[0].source_ref, 'Central bank bulletin');
    assert.equal((await t.api('GET', '/exchange-rates/history')).status, 400);
    assert.throws(() => t.ctx.db.run('UPDATE exchange_rates SET rate = 9'), /append-only/);
  });

  it('fetches rates from the configured provider and keeps their published timestamp', async () => {
    const config = await t.api('PUT', '/integrations/fx', { body: { provider_url: provider.url, api_key: FX_KEY, auto_refresh: false } });
    assert.equal(config.status, 200, config.raw);
    assert.equal(config.body.uses_default_provider, false);
    assert.equal(config.body.provider, `${provider.origin}/…`, 'a custom endpoint may embed a key, so only its host is shown');
    assert.equal(config.body.api_key.configured, true);
    assert.ok(!config.raw.includes('KEY-IN-PATH-4411') && !config.raw.includes('SECRETFXKEY'));
    assert.ok(!(await t.api('GET', '/settings')).raw.includes('KEY-IN-PATH-4411'));

    assert.equal((await t.api('POST', '/exchange-rates/fetch', { as: 'analyst', body: {} })).status, 403);
    const fetched = await t.api('POST', '/exchange-rates/fetch', { body: {} });
    assert.equal(fetched.status, 200, fetched.raw);
    assert.equal(fetched.body.inserted, 3);
    assert.equal(fetched.body.unchanged, 0);
    assert.equal(fetched.body.source, '127.0.0.1');
    assert.equal(fetched.body.as_of, new Date(publishedAt * 1000).toISOString());
    assert.deepEqual([...fetched.body.currencies].sort(), ['AED', 'KES', 'SAR']);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]!.headers.authorization, `Bearer ${FX_KEY}`);

    const again = await t.api('POST', '/exchange-rates/fetch', { body: {} });
    assert.deepEqual([again.body.inserted, again.body.unchanged], [0, 3], 'the same publication is not stored twice');

    const list = await t.api('GET', '/exchange-rates');
    const aed = list.body.rates.find((r: any) => r.currency === 'AED');
    assert.equal(aed.rate, 3.6725);
    assert.equal(aed.source, '127.0.0.1');
    assert.equal(list.body.rates.find((r: any) => r.currency === 'KWD').source, 'manual');
    const history = await t.api('GET', '/exchange-rates/history?currency=AED');
    assert.deepEqual(history.body.rows.map((r: any) => r.source), ['127.0.0.1', 'manual']);

    const status = (await t.api('GET', '/integrations')).body.fx;
    assert.equal(status.state, 'ready');
    assert.equal(status.latest_source, '127.0.0.1');
    assert.equal(status.only_demo_rates, false);
  });

  it('reports provider failures instead of inventing rates', async () => {
    const before = t.ctx.db.scalar<number>('SELECT COUNT(*) FROM exchange_rates');
    provider.status = 500;
    const down = await t.api('POST', '/exchange-rates/fetch', { body: {} });
    assert.equal(down.status, 502);
    assert.equal(down.body.error.code, 'provider_failed');
    assert.match(down.body.error.message, /HTTP 500/);
    provider.status = 200;
    const good = provider.payload;
    provider.payload = { result: 'success', base_code: 'USD', time_last_update_unix: publishedAt };
    const malformed = await t.api('POST', '/exchange-rates/fetch', { body: {} });
    assert.equal(malformed.status, 502);
    assert.match(malformed.body.error.message, /rates/);
    provider.payload = { result: 'error', 'error-type': 'invalid-key', rates: {} };
    assert.equal((await t.api('POST', '/exchange-rates/fetch', { body: {} })).status, 502);
    provider.payload = good;
    assert.equal(t.ctx.db.scalar<number>('SELECT COUNT(*) FROM exchange_rates'), before);

    assert.equal((await t.api('PUT', '/integrations/fx', { body: { provider_url: 'file:///etc/passwd' } })).status, 422);
    const restored = await t.api('PUT', '/integrations/fx', { body: { provider_url: 'default' } });
    assert.equal(restored.body.uses_default_provider, true);
    assert.equal(restored.body.provider, SETTING_DEFAULTS.fx_provider_url);
    const noKey = await t.api('DELETE', '/integrations/fx/key');
    assert.equal(noKey.body.api_key.configured, false);
  });

  it('flags illustrative DEMO rates', async () => {
    t.ctx.db.run(
      `INSERT INTO exchange_rates (base_currency, quote_currency, rate, as_of, source, fetched_at, is_demo) VALUES ('USD', 'GHS', 15.5, ?, 'DEMO illustrative rate', ?, 1)`,
      [ago(1), ago(1)],
    );
    const list = await t.api('GET', '/exchange-rates');
    const ghs = list.body.rates.find((r: any) => r.currency === 'GHS');
    assert.equal(ghs.is_demo, true);
    assert.equal(list.body.contains_demo_rates, true);
  });
});

describe('automatic exchange-rate refresh', () => {
  it('refreshes at most once a day when enabled and backs off after a failure', async () => {
    const app = await createTestApp();
    const provider = await startHttpFixture('/latest/USD');
    const publication = (hoursAgo: number) => ({
      result: 'success',
      base_code: 'USD',
      time_last_update_unix: Math.floor((Date.now() - hoursAgo * 3_600_000) / 1000),
      rates: { AED: 3.6725, SAR: 3.75 },
    });
    provider.payload = publication(30);
    try {
      const tick = (offsetMinutes: number) => fireHook(app.ctx, app.ctx.hooks.schedulerTick, new Date(Date.now() + offsetMinutes * 60_000));
      const count = () => app.ctx.db.scalar<number>('SELECT COUNT(*) FROM exchange_rates')!;

      await app.api('PUT', '/integrations/fx', { body: { provider_url: provider.url } });
      tick(0);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(provider.requests.length, 0, 'auto refresh is off by default');

      await app.api('PUT', '/integrations/fx', { body: { auto_refresh: true } });
      tick(1);
      await waitFor(() => count() === 2);
      assert.equal(provider.requests.length, 1);
      tick(60);
      tick(23 * 60);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(provider.requests.length, 1, 'no second call within 24 hours');

      provider.payload = publication(6);
      tick(24 * 60 + 5);
      await waitFor(() => count() === 4);
      assert.equal(provider.requests.length, 2);

      // provider down: nothing is stored, and the next attempt waits (6 h), then succeeds
      provider.status = 500;
      tick(49 * 60);
      await waitFor(() => provider.requests.length === 3);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(count(), 4);
      provider.status = 200;
      provider.payload = publication(1);
      tick(50 * 60);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(provider.requests.length, 3, 'no immediate retry');
      tick(56 * 60);
      await waitFor(() => count() === 6);
      assert.equal(provider.requests.length, 4);
    } finally {
      await provider.close();
      await app.close();
    }
  });
});

describe('audit log', () => {
  it('is restricted to administrators', async () => {
    assert.equal((await t.api('GET', '/audit-log', { as: 'analyst' })).status, 403);
    assert.equal((await t.api('GET', '/audit-log', { as: 'viewer' })).status, 403);
    assert.equal((await t.api('GET', '/audit-log/facets', { as: 'analyst' })).status, 403);
  });

  it('lists entries newest first with filters, parsed details and pagination', async () => {
    const all = await t.api('GET', '/audit-log?page_size=10');
    assert.equal(all.status, 200);
    assert.ok(all.body.total > 20);
    assert.equal(all.body.rows.length, 10);
    assert.ok(all.body.rows.every((r: any, i: number, rows: any[]) => i === 0 || rows[i - 1].id > r.id));
    const second = await t.api('GET', '/audit-log?page_size=10&page=2');
    assert.ok(second.body.rows[0].id < all.body.rows[9].id);

    const users = await t.api('GET', '/audit-log?action=user.&page_size=200');
    assert.ok(users.body.rows.length >= 6);
    assert.ok(users.body.rows.every((r: any) => r.action.startsWith('user.')));
    const create = users.body.rows.find((r: any) => r.action === 'user.create' && r.detail.email === 'new.analyst@test.local');
    assert.equal(create.detail.role, 'analyst');
    assert.equal(create.entity_type, 'user');
    assert.equal(create.user_email, 'admin@test.local');
    assert.equal(create.user_name, 'Test admin');

    const integrations = await t.api('GET', '/audit-log?entity_type=integration&page_size=200');
    assert.ok(integrations.body.rows.length >= 8);
    assert.ok(integrations.body.rows.every((r: any) => r.entity_type === 'integration'));
    const smtp = await t.api('GET', '/audit-log?entity_type=integration&entity_id=smtp&page_size=200');
    assert.ok(smtp.body.rows.length >= 3);
    assert.ok(smtp.body.rows.every((r: any) => r.entity_id === 'smtp'));

    const search = await t.api('GET', `/audit-log?q=${encodeURIComponent('reset.me@test.local')}`);
    assert.ok(search.body.total >= 2);
    const adminId = (await t.api('GET', '/auth/me')).body.user.id;
    const byUser = await t.api('GET', `/audit-log?user_id=${adminId}&action=settings.`);
    assert.ok(byUser.body.total >= 2);
    assert.ok(byUser.body.rows.every((r: any) => r.user_id === adminId && r.action === 'settings.update'));

    assert.equal((await t.api('GET', '/audit-log?from=2099-01-01')).body.total, 0);
    assert.equal((await t.api('GET', `/audit-log?to=${new Date().toISOString().slice(0, 10)}`)).body.total, all.body.total);
    assert.equal((await t.api('GET', '/audit-log?from=tomorrow')).status, 400);

    const facets = await t.api('GET', '/audit-log/facets');
    assert.ok(facets.body.actions.includes('user.create'));
    assert.ok(facets.body.actions.includes('exchange_rate.fetch'));
    assert.ok(facets.body.entity_types.includes('integration'));
  });

  it('cannot be altered', () => {
    assert.throws(() => t.ctx.db.run(`UPDATE audit_log SET action = 'x'`), /append-only/);
    assert.throws(() => t.ctx.db.run('DELETE FROM audit_log'), /append-only/);
  });
});

describe('system information and DEMO dataset management', () => {
  it('reports database, version and data-class figures to administrators', async () => {
    assert.equal((await t.api('GET', '/admin/system', { as: 'analyst' })).status, 403);
    const res = await t.api('GET', '/admin/system');
    assert.equal(res.status, 200);
    assert.match(res.body.version.node, /^v\d+/);
    assert.match(res.body.version.sqlite, /^\d+\.\d+/);
    assert.ok(res.body.version.migration >= 1);
    assert.equal(res.body.scheduler_enabled, false);
    assert.equal(res.body.data_dir, t.dataDir);
    assert.ok(res.body.database.path.startsWith(t.dataDir));
    assert.ok(res.body.database.size_bytes > 0);
    assert.equal(res.body.tables.users, t.ctx.db.scalar<number>('SELECT COUNT(*) FROM users'));
    assert.equal(res.body.tables.markets, 10);
    assert.equal(res.body.tables.price_observations, 2);
    assert.equal(res.body.demo_rows.price_observations, 0);
    assert.equal(res.body.demo_rows.exchange_rates, 1);
    assert.equal(res.body.demo_data_present, false);
    assert.deepEqual(res.body.observations_by_class.map((c: any) => [c.data_class, c.is_demo, c.count]), [['imported', false, 2]]);
    assert.ok(typeof res.body.uptime_seconds === 'number');
  });

  it('restricts DEMO dataset actions to administrators and refuses to seed twice', async () => {
    for (const role of ['analyst', 'viewer'] as const) {
      assert.equal((await t.api('POST', '/admin/demo/purge', { as: role, body: {} })).status, 403);
      assert.equal((await t.api('POST', '/admin/demo/seed', { as: role, body: {} })).status, 403);
    }
    assert.equal((await t.api('POST', '/admin/demo/seed', { as: null, body: {} })).status, 401);
    const now = new Date().toISOString();
    t.ctx.db.run(`INSERT INTO brands (name, ownership, is_demo, created_at, updated_at) VALUES ('Demo Brand', 'own', 1, ?, ?)`, [now, now]);
    assert.equal((await t.api('GET', '/admin/system')).body.demo_data_present, true);
    const seed = await t.api('POST', '/admin/demo/seed', { body: {} });
    assert.equal(seed.status, 409);
    assert.match(seed.body.error.message, /already loaded/);
  });
});
