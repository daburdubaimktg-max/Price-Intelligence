/**
 * Prepares the database copy that the public snapshot ships with.
 *
 * The copy is a consistent duplicate of the application database with everything removed that has no
 * place on a public page: sign-in data, sessions, stored credentials, the audit trail, saved activity,
 * and the ids/links of third-party provider datasets. Price observations are copied untouched.
 *
 * The original database is only read.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const ROLE_LABEL = { admin: 'Administrator', analyst: 'Analyst', viewer: 'Viewer' };

/** Links and ids that would let a stranger open the provider's stored datasets or runs. */
const PROVIDER_LINK = /https?:\/\/api\.apify\.com\/v2\/(?:datasets|actor-runs|key-value-stores|request-queues)\/[A-Za-z0-9]+[^\s"'<>)]*/g;
const PROVIDER_ID = /\b(run|dataset|store)(\s+)(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{17}\b/g;

export function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(PROVIDER_LINK, '[provider dataset link withheld in the public snapshot]')
    .replace(PROVIDER_ID, (_m, word, gap) => `${word}${gap}[id withheld]`);
}

function quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function textColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${quote(table)})`)
    .all()
    .filter((c) => /TEXT|CHAR|CLOB/i.test(c.type) || c.type === '')
    .map((c) => c.name);
}

function tables(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);
}

/** Deletes every row of a table, lifting (and restoring) triggers that forbid deletion. */
function clearTable(db, table) {
  const exists = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!exists) return 0;
  const triggers = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`).all(table);
  for (const t of triggers) db.exec(`DROP TRIGGER ${quote(t.name)}`);
  const { changes } = db.prepare(`DELETE FROM ${quote(table)}`).run();
  for (const t of triggers) db.exec(t.sql);
  return Number(changes);
}

/**
 * @param {{ source: string, outDir: string, now?: Date }} options
 * @returns {{ generated_at: string, db_bytes: number, gz_bytes: number, sha256: string, counts: Record<string, number>, latest_observation_at: string | null, viewer: { id: number, name: string } }}
 */
export function buildSnapshotDb({ source, outDir, now = new Date() }) {
  if (!fs.existsSync(source)) throw new Error(`Database not found: ${source}`);
  fs.mkdirSync(outDir, { recursive: true });
  const work = path.join(outDir, 'snapshot.work.db');
  for (const leftover of [work, `${work}-journal`, `${work}-wal`, `${work}-shm`]) fs.rmSync(leftover, { force: true });

  // 1. A consistent copy (safe while the application is running).
  const original = new DatabaseSync(source, { readOnly: true });
  try {
    original.exec(`VACUUM INTO '${work.replace(/'/g, "''")}'`);
  } finally {
    original.close();
  }

  const db = new DatabaseSync(work);
  try {
    db.exec('PRAGMA foreign_keys = OFF');

    // 2. Sign-in data, credentials and saved activity never leave the building.
    for (const table of ['sessions', 'secrets', 'audit_log', 'assistant_queries', 'report_runs', 'alert_notifications']) {
      clearTable(db, table);
    }
    db.prepare(`DELETE FROM settings WHERE key IN ('excel_mirror')`).run();

    // 3. Accounts: no usable passwords, no personal names or addresses.
    const users = db
      .prepare(`SELECT u.id, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id`)
      .all();
    const perRole = {};
    for (const u of users) perRole[u.role] = (perRole[u.role] ?? 0) + 1;
    const update = db.prepare(
      `UPDATE users SET name = ?, email = ?, password_hash = 'disabled-in-public-snapshot', must_change_password = 0,
         uses_default_password = 0, failed_login_count = 0, locked_until = NULL, last_login_at = NULL,
         notification_prefs = '{"in_app":true,"email":false,"min_severity":"info"}' WHERE id = ?`,
    );
    for (const u of users) {
      const label = ROLE_LABEL[u.role] ?? 'User';
      update.run(perRole[u.role] > 1 ? `${label} ${u.id}` : label, `user-${u.id}@snapshot.invalid`, u.id);
    }
    // The visitor of the public page is shown the app as this read-only account.
    let viewer = db
      .prepare(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'viewer' AND u.is_active = 1 ORDER BY u.id LIMIT 1`)
      .get();
    if (!viewer) {
      const role = db.prepare(`SELECT id FROM roles WHERE key = 'viewer'`).get();
      if (!role) throw new Error('The database has no viewer role');
      const stamp = now.toISOString();
      const res = db
        .prepare(
          `INSERT INTO users (email, name, password_hash, role_id, is_active, created_at, updated_at)
           VALUES ('viewer@snapshot.invalid', 'Snapshot viewer', 'disabled-in-public-snapshot', ?, 1, ?, ?)`,
        )
        .run(role.id, stamp, stamp);
      viewer = { id: Number(res.lastInsertRowid) };
    }
    db.prepare(`UPDATE users SET name = 'Snapshot viewer', email = 'viewer@snapshot.invalid' WHERE id = ?`).run(viewer.id);

    // 4. Provider references: keep what was collected and by which tool, withhold ids and links.
    const rewrite = { source_evidence: ['reference', 'excerpt', 'note'], retailers: ['notes'] };
    for (const [table, columns] of Object.entries(rewrite)) {
      const rows = db.prepare(`SELECT id, ${columns.map(quote).join(', ')} FROM ${quote(table)}`).all();
      for (const row of rows) {
        const changed = columns.filter((c) => redact(row[c]) !== row[c]);
        if (!changed.length) continue;
        db.prepare(`UPDATE ${quote(table)} SET ${changed.map((c) => `${quote(c)} = ?`).join(', ')} WHERE id = ?`).run(
          ...changed.map((c) => redact(row[c])),
          row.id,
        );
      }
    }

    // 5. Nothing of that kind may be left anywhere.
    const leftovers = [];
    for (const table of tables(db)) {
      for (const column of textColumns(db, table)) {
        const rows = db
          .prepare(`SELECT ${quote(column)} AS v FROM ${quote(table)} WHERE ${quote(column)} LIKE '%apify%' OR ${quote(column)} LIKE '%dataset%' OR ${quote(column)} LIKE '% run %'`)
          .all();
        for (const row of rows) {
          if (typeof row.v === 'string' && redact(row.v) !== row.v) {
            leftovers.push(`${table}.${column}`);
            break;
          }
        }
      }
    }
    if (leftovers.length) throw new Error(`Provider ids or links are still present in: ${leftovers.join(', ')}`);
    const hashes = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE password_hash <> 'disabled-in-public-snapshot'`).get().n;
    if (hashes) throw new Error('A password hash survived the clean-up');

    const counts = {
      observations: db.prepare('SELECT COUNT(*) AS n FROM price_observations').get().n,
      products: db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status = 'active'`).get().n,
      listings: db.prepare('SELECT COUNT(*) AS n FROM retailer_listings').get().n,
      retailers: db.prepare('SELECT COUNT(*) AS n FROM retailers').get().n,
      demo_observations: db.prepare('SELECT COUNT(*) AS n FROM price_observations WHERE is_demo = 1').get().n,
    };
    const latest = db.prepare('SELECT MAX(observed_at) AS at FROM price_observations').get().at ?? null;

    // 6. Compact single-file form (the browser cannot read write-ahead-log databases).
    db.exec('PRAGMA foreign_keys = ON');
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`The clean-up left ${broken.length} dangling reference(s)`);
    db.exec('ANALYZE');
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('VACUUM');
    db.close();

    const bytes = fs.readFileSync(work);
    const gz = zlib.gzipSync(bytes, { level: 9 });
    fs.writeFileSync(path.join(outDir, 'snapshot.db.gz'), gz);
    const meta = {
      generated_at: now.toISOString(),
      db_bytes: bytes.length,
      gz_bytes: gz.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      counts,
      latest_observation_at: latest,
      viewer: { id: Number(viewer.id), name: 'Snapshot viewer' },
    };
    fs.writeFileSync(path.join(outDir, 'snapshot.json'), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    for (const leftover of [work, `${work}-journal`, `${work}-wal`, `${work}-shm`]) fs.rmSync(leftover, { force: true });
  }
}
