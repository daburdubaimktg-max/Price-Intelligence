/**
 * Browser stand-in for `server/db/sqlite.ts`.
 *
 * Same interface, backed by SQLite compiled to WebAssembly (sql.js) holding the snapshot database in
 * memory. The snapshot build swaps this module in for the Node driver, so the services and routes run
 * unchanged. Nothing is ever written back to a file: the page only has its own in-memory copy.
 */
import type { Database, Statement } from 'sql.js';

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

/** sql.js reports the SQLite message only; map it to the symbolic names the app uses. */
function classify(err: unknown): never {
  if (err instanceof SqliteError) throw err;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'SQLite error';
  let code = 'SQLITE_ERROR';
  if (/^UNIQUE constraint failed|PRIMARY KEY must be unique/i.test(message)) code = 'UNIQUE';
  else if (/^FOREIGN KEY constraint failed/i.test(message)) code = 'FOREIGN_KEY';
  else if (/^CHECK constraint failed/i.test(message)) code = 'CHECK';
  else if (/^NOT NULL constraint failed/i.test(message)) code = 'NOT_NULL';
  else if (/constraint failed/i.test(message)) code = 'CONSTRAINT';
  else if (/append-only|immutable|cannot be (changed|deleted|modified)/i.test(message)) code = 'TRIGGER';
  else if (/database is locked|database table is locked/i.test(message)) code = 'BUSY';
  throw new SqliteError(message, code);
}

type Bindable = string | number | null | Uint8Array;

function normalise(value: SqlParam): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export class Db {
  readonly path = ':snapshot:';
  private readonly raw: Database;
  private readonly statements = new Map<string, Statement>();
  private depth = 0;
  private savepointSeq = 0;

  constructor(raw: Database) {
    this.raw = raw;
    this.raw.run(`
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -65536;
      PRAGMA recursive_triggers = ON;
    `);
  }

  private prepare(sql: string): Statement {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      try {
        stmt = this.raw.prepare(sql);
      } catch (err) {
        classify(err);
      }
      if (this.statements.size >= 600) {
        const oldest = this.statements.keys().next().value;
        if (oldest !== undefined) {
          this.statements.get(oldest)?.free();
          this.statements.delete(oldest);
        }
      }
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  private bind(stmt: Statement, params?: SqlParams): void {
    if (!params) {
      stmt.bind([]);
      return;
    }
    if (Array.isArray(params)) {
      stmt.bind(params.map(normalise));
      return;
    }
    // Node's driver accepts bare names; SQLite itself wants the prefix that is written in the statement.
    const named: Record<string, Bindable> = {};
    for (const [key, value] of Object.entries(params)) {
      const v = normalise(value);
      if (/^[:@$]/.test(key)) named[key] = v;
      else for (const prefix of [':', '@', '$']) named[`${prefix}${key}`] = v;
    }
    stmt.bind(named);
  }

  exec(sql: string): void {
    try {
      this.raw.run(sql);
    } catch (err) {
      classify(err);
    }
  }

  run(sql: string, params?: SqlParams): RunResult {
    try {
      const stmt = this.prepare(sql);
      try {
        this.bind(stmt, params);
        while (stmt.step()) {
          /* statements with RETURNING produce rows; run() ignores them */
        }
      } finally {
        stmt.reset();
      }
      const changes = this.raw.getRowsModified();
      const idStmt = this.prepare('SELECT last_insert_rowid() AS id');
      let lastInsertRowid = 0;
      try {
        idStmt.bind([]);
        if (idStmt.step()) lastInsertRowid = Number(idStmt.get()[0] ?? 0);
      } finally {
        idStmt.reset();
      }
      return { changes, lastInsertRowid };
    } catch (err) {
      classify(err);
    }
  }

  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
    try {
      const stmt = this.prepare(sql);
      try {
        this.bind(stmt, params);
        return stmt.step() ? (stmt.getAsObject() as T) : undefined;
      } finally {
        stmt.reset();
      }
    } catch (err) {
      classify(err);
    }
  }

  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
    try {
      const stmt = this.prepare(sql);
      const rows: T[] = [];
      try {
        this.bind(stmt, params);
        const names = stmt.getColumnNames();
        const width = names.length;
        while (stmt.step()) {
          const values = stmt.get();
          const row: Record<string, unknown> = {};
          for (let i = 0; i < width; i++) row[names[i]!] = values[i];
          rows.push(row as T);
        }
      } finally {
        stmt.reset();
      }
      return rows;
    } catch (err) {
      classify(err);
    }
  }

  /** Single scalar value (first column of the first row). */
  scalar<T = number>(sql: string, params?: SqlParams): T | undefined {
    try {
      const stmt = this.prepare(sql);
      try {
        this.bind(stmt, params);
        return stmt.step() ? (stmt.get()[0] as T) : undefined;
      } finally {
        stmt.reset();
      }
    } catch (err) {
      classify(err);
    }
  }

  /** Runs `fn` atomically (synchronous body). Nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.raw.run('BEGIN IMMEDIATE');
      this.depth = 1;
      try {
        const result = fn();
        if (result instanceof Promise) throw new Error('Db.tx callback must be synchronous');
        this.raw.run('COMMIT');
        return result;
      } catch (err) {
        try {
          this.raw.run('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      } finally {
        this.depth = 0;
      }
    }
    const name = `sp_${++this.savepointSeq}`;
    this.raw.run(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.raw.run(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.raw.run(`ROLLBACK TO ${name}`);
      this.raw.run(`RELEASE ${name}`);
      throw err;
    } finally {
      this.depth--;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  async backupTo(_destination: string): Promise<void> {
    throw new Error('Backups are not available in the read-only web snapshot');
  }

  close(): void {
    for (const stmt of this.statements.values()) stmt.free();
    this.statements.clear();
    this.raw.close();
  }
}

/** Builds `?, ?, ?` for IN lists. */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}
