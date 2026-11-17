import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './sqlite.ts';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

export interface MigrationResult {
  applied: string[];
  current: number;
}

/** Applies pending `NNN_name.sql` migrations in order, each inside its own transaction. */
export function migrate(db: Db): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const done = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  let current = 0;
  for (const file of files) {
    const version = Number(file.split('_')[0]);
    current = Math.max(current, version);
    if (done.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.tx(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        version,
        file,
        new Date().toISOString(),
      ]);
    });
    applied.push(file);
  }
  return { applied, current };
}
