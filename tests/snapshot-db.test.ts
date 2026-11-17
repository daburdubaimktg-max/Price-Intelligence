/**
 * The public snapshot ships a copy of the database. These tests pin what must never be in that copy
 * (sign-in data, sessions, credentials, the audit trail, provider dataset ids and links) and what must
 * survive untouched (the price observations).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
// @ts-expect-error plain JavaScript build script without type declarations
import { buildSnapshotDb, redact } from '../snapshot/build-db.mjs';
import { nowIso } from '../server/lib/time.ts';
import { audit, setSecret } from '../server/services/core.ts';
import { createTestApp, type TestApp } from './helpers.ts';

const DATASET_ID = 'qlZGIq9hv4LoDvr4d';
const RUN_ID = '49QFn3KaMeiBWwMtI';

let t: TestApp;
let outDir: string;
let copy: DatabaseSync;
let meta: { generated_at: string; counts: Record<string, number>; viewer: { id: number; name: string }; sha256: string; gz_bytes: number };
let rawBytes: Buffer;

before(async () => {
  t = await createTestApp();
  const { db } = t.ctx;
  const now = nowIso();
  db.run(
    `INSERT INTO source_evidence (kind, reference, excerpt, note, is_demo, created_at) VALUES ('api_response', ?, ?, ?, 0, ?)`,
    [
      `Apify dataset ${DATASET_ID} — search results`,
      `https://api.apify.com/v2/datasets/${DATASET_ID}/items?format=json&clean=true`,
      `Collected by the Apify actor someone/some-scraper (run ${RUN_ID}); second dataset ${DATASET_ID}.`,
      now,
    ],
  );
  const market = db.get<{ id: number; currency_code: string; country_code: string }>('SELECT id, currency_code, country_code FROM markets ORDER BY id LIMIT 1')!;
  db.run(
    `INSERT INTO retailers (name, country_code, market_id, currency_code, collection_method, notes, created_at, updated_at) VALUES ('Shop', ?, ?, ?, 'manual', ?, ?, ?)`,
    [market.country_code, market.id, market.currency_code, `Loaded from a provider run ${RUN_ID}, dataset ${DATASET_ID}. Replace <TASK_ID> in the URL.`, now, now],
  );
  setSecret(t.ctx, 'smtp_password', 'hunter2-very-secret');
  audit(t.ctx, null, 'test.event', 'thing', 1, { note: `dataset ${DATASET_ID}` }, '203.0.113.9');

  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pios-snapshot-'));
  meta = buildSnapshotDb({ source: t.ctx.config.dbPath, outDir });
  rawBytes = zlib.gunzipSync(fs.readFileSync(path.join(outDir, 'snapshot.db.gz')));
  fs.writeFileSync(path.join(outDir, 'check.db'), rawBytes);
  copy = new DatabaseSync(path.join(outDir, 'check.db'), { readOnly: true });
});

after(async () => {
  copy?.close();
  await t?.close();
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

const count = (sql: string): number => Number((copy.prepare(sql).get() as { n: number }).n);

test('sign-in data, sessions, credentials and the audit trail are not in the copy', () => {
  assert.ok(t.ctx.db.scalar<number>('SELECT COUNT(*) FROM sessions')! > 0, 'the source has sessions');
  assert.ok(t.ctx.db.scalar<number>('SELECT COUNT(*) FROM secrets')! > 0, 'the source has a stored credential');
  assert.ok(t.ctx.db.scalar<number>('SELECT COUNT(*) FROM audit_log')! > 0, 'the source has an audit trail');
  for (const table of ['sessions', 'secrets', 'audit_log', 'assistant_queries', 'report_runs', 'alert_notifications']) {
    assert.equal(count(`SELECT COUNT(*) AS n FROM ${table}`), 0, table);
  }
  assert.equal(count(`SELECT COUNT(*) AS n FROM users WHERE password_hash <> 'disabled-in-public-snapshot'`), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM users WHERE email NOT LIKE '%@snapshot.invalid'`), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM users WHERE name LIKE 'Test %'`), 0);
  const text = rawBytes.toString('latin1');
  for (const needle of ['hunter2', 'scrypt', '@test.local', '203.0.113.9']) assert.ok(!text.includes(needle), `"${needle}" must not be in the file`);
});

test('provider dataset ids and links are withheld, the rest of the note is kept', () => {
  const text = rawBytes.toString('latin1');
  assert.ok(!text.includes(DATASET_ID) && !text.includes(RUN_ID), 'no provider id anywhere in the file');
  assert.ok(!text.includes('api.apify.com/v2/datasets'));
  const evidence = copy.prepare('SELECT reference, excerpt, note FROM source_evidence').get() as { reference: string; excerpt: string; note: string };
  assert.equal(evidence.reference, 'Apify dataset [id withheld] — search results');
  assert.equal(evidence.excerpt, '[provider dataset link withheld in the public snapshot]');
  assert.match(evidence.note, /someone\/some-scraper \(run \[id withheld\]\); second dataset \[id withheld\]\./);
  const retailer = copy.prepare(`SELECT notes FROM retailers WHERE name = 'Shop'`).get() as { notes: string };
  assert.equal(retailer.notes, 'Loaded from a provider run [id withheld], dataset [id withheld]. Replace <TASK_ID> in the URL.');
});

test('redaction leaves ordinary wording alone', () => {
  assert.equal(redact('The last run finished at 10:00 and the dataset was complete.'), 'The last run finished at 10:00 and the dataset was complete.');
  assert.equal(redact('https://api.apify.com/v2/actor-tasks/<TASK_ID>/runs/last/dataset/items?status=SUCCEEDED'), 'https://api.apify.com/v2/actor-tasks/<TASK_ID>/runs/last/dataset/items?status=SUCCEEDED');
  assert.equal(redact(null), null);
});

test('the copy is a single-file database with a read-only visitor account and its triggers intact', () => {
  assert.equal((copy.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
  const viewer = copy
    .prepare(`SELECT u.id, u.name, u.email, r.key AS role, u.is_active FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`)
    .get(meta.viewer.id) as { name: string; email: string; role: string; is_active: number };
  assert.deepEqual({ ...viewer }, { id: meta.viewer.id, name: 'Snapshot viewer', email: 'viewer@snapshot.invalid', role: 'viewer', is_active: 1 });
  const triggers = (copy.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as Array<{ name: string }>).map((r) => r.name);
  for (const name of ['trg_audit_no_update', 'trg_audit_no_delete', 'trg_observations_no_update', 'trg_observations_no_delete']) {
    assert.ok(triggers.includes(name), name);
  }
  assert.equal(count('SELECT COUNT(*) AS n FROM pragma_foreign_key_check'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM price_observations'), t.ctx.db.scalar<number>('SELECT COUNT(*) FROM price_observations'));
  assert.equal(meta.counts.observations, count('SELECT COUNT(*) AS n FROM price_observations'));
  assert.match(meta.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(meta.gz_bytes, fs.statSync(path.join(outDir, 'snapshot.db.gz')).size);
});

test('the original database is left exactly as it was', () => {
  assert.ok(t.ctx.db.scalar<number>('SELECT COUNT(*) FROM sessions')! > 0);
  assert.ok(t.ctx.db.scalar<number>(`SELECT COUNT(*) FROM users WHERE email LIKE '%@test.local'`)! >= 3);
  assert.match(t.ctx.db.scalar<string>('SELECT reference FROM source_evidence LIMIT 1')!, new RegExp(DATASET_ID));
});
