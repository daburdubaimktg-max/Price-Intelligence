/** The part of sql.js (SQLite compiled to WebAssembly) that the snapshot uses. */
declare module 'sql.js' {
  export type BindValue = string | number | null | Uint8Array;
  export interface Statement {
    bind(values?: BindValue[] | Record<string, BindValue>): boolean;
    step(): boolean;
    get(): BindValue[];
    getAsObject(): Record<string, BindValue>;
    getColumnNames(): string[];
    reset(): void;
    free(): boolean;
  }
  export interface Database {
    run(sql: string, params?: BindValue[]): Database;
    prepare(sql: string): Statement;
    getRowsModified(): number;
    close(): void;
  }
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}

declare module '*.wasm?url' {
  const url: string;
  export default url;
}

/** Set by the snapshot build (snapshot/vite.config.ts). */
declare const __SNAPSHOT_AT__: string;
declare const __SNAPSHOT_SHA__: string;
declare const __SNAPSHOT_GZ_BYTES__: number;
declare const __SNAPSHOT_LATEST__: string;
declare const __SNAPSHOT_COUNTS__: { observations: number; products: number; listings: number; retailers: number; demo_observations: number };
