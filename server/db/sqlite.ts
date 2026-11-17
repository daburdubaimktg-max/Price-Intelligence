/**
 * Thin synchronous wrapper around Node's built-in SQLite driver (`node:sqlite`).
 *
 * The rest of the application only talks to this class, so the storage engine can be swapped
 * (better-sqlite3, PostgreSQL through a sync-compatible adapter, …) without touching services.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// `node:sqlite` prints a one-off ExperimentalWarning on Node 22. The API surface used here has been
// stable since 22.5; filter that single warning so server logs stay clean. Everything else passes.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (typeof text === 'string' && text.includes('SQLite is an experimental feature')) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParam = SqlValue | boolean | undefined;
export type SqlParams = SqlParam[] | Record<string, SqlParam>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export class SqliteError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SqliteError';
    this.code = code;
  }
}

/** Maps SQLite extended result codes to stable symbolic names used by the app. */
function classify(err: unknown): never {
  const e = err as { errcode?: number; message?: string };
  if (typeof e?.errcode === 'number') {
    const primary = e.errcode & 0xff;
    let code = 'SQLITE_ERROR';
    if (e.errcode === 2067 || e.errcode === 1555) code = 'UNIQUE';
    else if (e.errcode === 787) code = 'FOREIGN_KEY';
    else if (e.errcode === 1811) code = 'TRIGGER';
    else if (e.errcode === 275) code = 'CHECK';
    else if (e.errcode === 1299) code = 'NOT_NULL';
    else if (primary === 19) code = 'CONSTRAINT';
    else if (primary === 5 || primary === 6) code = 'BUSY';
    throw new SqliteError(e.message ?? 'SQLite error', code);
  }
  throw err;
}

function normalise(value: SqlParam): SqlValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export class Db {
  readonly path: string;
  private readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private savepointSeq = 0;

  constructor(dbPath: string) {
    this.path = dbPath;
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.raw = new sqlite.DatabaseSync(dbPath);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -65536;
      -- Required so that INSERT OR REPLACE fires DELETE triggers: without it a REPLACE could
      -- silently remove a row from an append-only table.
      PRAGMA recursive_triggers = ON;
    `);
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      try {
        stmt = this.raw.prepare(sql);
      } catch (err) {
        classify(err);
      }
      if (this.statements.size >= 600) {
        // Dynamic SQL (variable IN-lists) can produce many shapes; keep the cache bounded.
        const oldest = this.statements.keys().next().value;
        if (oldest !== undefined) this.statements.delete(oldest);
      }
      this.statements.set(sql, stmt!);
    }
    return stmt!;
  }

  private bind(params?: SqlParams): unknown[] {
    if (!params) return [];
    if (Array.isArray(params)) return params.map(normalise);
    const out: Record<string, SqlValue> = {};
    for (const [k, v] of Object.entries(params)) out[k] = normalise(v);
    return [out];
  }

  exec(sql: string): void {
    try {
      this.raw.exec(sql);
    } catch (err) {
      classify(err);
    }
  }

  run(sql: string, params?: SqlParams): RunResult {
    try {
      const res = (this.prepare(sql).run as (...a: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint })(
        ...this.bind(params),
      );
      return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
    } catch (err) {
      classify(err);
    }
  }

  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
    try {
      return (this.prepare(sql).get as (...a: unknown[]) => unknown)(...this.bind(params)) as T | undefined;
    } catch (err) {
      classify(err);
    }
  }

  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
    try {
      return (this.prepare(sql).all as (...a: unknown[]) => unknown[])(...this.bind(params)) as T[];
    } catch (err) {
      classify(err);
    }
  }

  /** Single scalar value (first column of the first row). */
  scalar<T = number>(sql: string, params?: SqlParams): T | undefined {
    const row = this.get<Record<string, unknown>>(sql, params);
    if (!row) return undefined;
    const keys = Object.keys(row);
    return row[keys[0]!] as T;
  }

  /**
   * Runs `fn` atomically. Must be synchronous: the driver is synchronous and the event loop is
   * single-threaded, so a synchronous body can never interleave with another request.
   * Nested calls use savepoints.
   */
  tx<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth = 1;
      try {
        const result = fn();
        if (result instanceof Promise) throw new Error('Db.tx callback must be synchronous');
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      } finally {
        this.depth = 0;
      }
    }
    const name = `sp_${++this.savepointSeq}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      this.depth--;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /** Online, consistent backup to another file. */
  async backupTo(destination: string): Promise<void> {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await sqlite.backup(this.raw, destination);
  }

  close(): void {
    this.statements.clear();
    try {
      this.raw.exec('PRAGMA optimize');
    } catch {
      /* ignore */
    }
    this.raw.close();
  }
}

/** Builds `?, ?, ?` for IN lists. */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}
