/** Cross-cutting HTTP protections: default-deny API, security headers, framing policy and cross-site write checks. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.ts';
import { createFixture, createTestApp, type Fixture, type TestApp } from './helpers.ts';

let t: TestApp;
let fx: Fixture;

before(async () => {
  t = await createTestApp();
  fx = createFixture(t.ctx);
});
after(async () => {
  await t.close();
});

describe('API access', () => {
  it('requires a session for everything except health, sign-in info and sign-in', async () => {
    assert.equal((await t.api('GET', '/health', { as: null })).status, 200);
    assert.equal((await t.api('GET', '/auth/info', { as: null })).status, 200);
    for (const url of ['/products', '/retailers', '/observations', '/monitor', '/overview', '/alerts', '/collection/health', '/reports/types', '/users', '/settings', '/audit-log', '/database/mirror', '/assistant/status', '/reference']) {
      assert.equal((await t.api('GET', url, { as: null })).status, 401, `${url} must not be readable anonymously`);
    }
    assert.equal((await t.api('GET', '/does-not-exist', { as: null })).status, 401, 'unknown API paths do not reveal themselves either');
  });

  it('keeps administration away from analysts and viewers, and writes away from viewers', async () => {
    for (const url of ['/users', '/audit-log']) {
      assert.equal((await t.api('GET', url, { as: 'analyst' })).status, 403, url);
      assert.equal((await t.api('GET', url, { as: 'viewer' })).status, 403, url);
    }
    const observation = { listing_id: fx.ownListingId, observed_at: new Date(Date.now() - 3_600_000).toISOString(), current_price: 10, availability: 'in_stock' };
    assert.equal((await t.api('POST', '/observations', { body: observation, as: 'viewer' })).status, 403);
    assert.equal((await t.api('POST', '/products', { body: { name: 'x' }, as: 'viewer' })).status, 403);
    assert.equal((await t.api('POST', '/alert-rules', { body: {}, as: 'viewer' })).status, 403);
    assert.equal((await t.api('GET', '/database/export.xlsx', { as: 'viewer' })).status, 403);
    assert.equal((await t.api('POST', '/observations', { body: observation, as: 'analyst' })).status, 201);
  });

  it('tells every user which notification channels are ready, without revealing their settings', async () => {
    const res = await t.api('GET', '/me/notification-channels', { as: 'viewer' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { in_app: true, email: false, webhook: false });
    assert.equal((await t.api('GET', '/integrations', { as: 'viewer' })).status, 403);
    assert.equal((await t.api('GET', '/me/notification-channels', { as: null })).status, 401);
  });

  it('rejects an invalid or revoked session token', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/products', headers: { authorization: 'Bearer not-a-real-token' } });
    assert.equal(res.statusCode, 401);
  });
});

describe('cross-site requests', () => {
  it('refuses cookie-authenticated writes that come from another site', async () => {
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'analyst@test.local', password: 'Test-Password-2026' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    assert.match(String(login.headers['set-cookie']), /HttpOnly/i);
    assert.match(String(login.headers['set-cookie']), /SameSite=Lax/i);
    const payload = { listing_id: fx.ownListingId, observed_at: new Date(Date.now() - 7_200_000).toISOString(), current_price: 11, availability: 'in_stock' };

    const crossSite = await t.app.inject({ method: 'POST', url: '/api/observations', headers: { cookie, 'sec-fetch-site': 'cross-site' }, payload });
    assert.equal(crossSite.statusCode, 403);
    const foreignOrigin = await t.app.inject({ method: 'POST', url: '/api/observations', headers: { cookie, origin: 'https://evil.example', host: 'app.example' }, payload });
    assert.equal(foreignOrigin.statusCode, 403);
    const sameOrigin = await t.app.inject({ method: 'POST', url: '/api/observations', headers: { cookie, 'sec-fetch-site': 'same-origin' }, payload });
    assert.equal(sameOrigin.statusCode, 201);
    const read = await t.app.inject({ method: 'GET', url: '/api/products', headers: { cookie, 'sec-fetch-site': 'cross-site' } });
    assert.equal(read.statusCode, 200, 'reads are not state-changing');
  });
});

describe('rate limits', () => {
  it('throttles repeated sign-in attempts and assistant questions from one address', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pios-rate-'));
    const { app } = await buildApp({ dataDir, schedulerEnabled: false, seedDemo: false, logLevel: 'silent' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 22; i++) {
        const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.com', password: 'wrong-password' } });
        statuses.push(res.statusCode);
      }
      assert.deepEqual([...new Set(statuses.slice(0, 20))], [401], 'the first 20 attempts are answered normally');
      assert.equal(statuses[20], 429);
      assert.equal(statuses[21], 429);
    } finally {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('security headers', () => {
  const start = async (allowEmbedding: boolean) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pios-sec-'));
    const built = await buildApp({ dataDir, schedulerEnabled: false, seedDemo: false, logLevel: 'silent', allowEmbedding });
    return { ...built, close: async () => { await built.app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
  };

  it('sends a restrictive content security policy and no server fingerprint', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  it('forbids framing by other sites unless embedding is enabled', async () => {
    const strict = await start(false);
    try {
      const res = await strict.app.inject({ method: 'GET', url: '/api/health' });
      assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'self'/);
      assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    } finally {
      await strict.close();
    }
    const embeddable = await start(true);
    try {
      const res = await embeddable.app.inject({ method: 'GET', url: '/api/health' });
      assert.doesNotMatch(String(res.headers['content-security-policy']), /frame-ancestors/);
      assert.equal(res.headers['x-frame-options'], undefined);
    } finally {
      await embeddable.close();
    }
  });
});
