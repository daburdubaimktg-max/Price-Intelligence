/**
 * Background worker of the public snapshot: downloads the database, opens it with SQLite (WebAssembly)
 * and answers the page's API requests with the application's own server code. Running here keeps the
 * page responsive while queries run.
 */
import { setClockOffset } from './clock.ts';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { Db } from './db.ts';
import { createSnapshotServer, type ApiRequest, type ApiResponse, type SnapshotServer } from './server.ts';

export type WorkerInbound =
  | { type: 'init'; base: string; offset: number }
  | { type: 'request'; id: number; request: ApiRequest };

export type WorkerOutbound =
  | { type: 'progress'; phase: 'download'; loaded: number; total: number }
  | { type: 'progress'; phase: 'unpack' | 'open' }
  | { type: 'ready'; routes: number }
  | { type: 'fatal'; message: string }
  | ({ type: 'response'; id: number } & ApiResponse);

const channel = self as unknown as {
  postMessage(message: WorkerOutbound): void;
  onmessage: ((event: { data: WorkerInbound }) => void) | null;
};

let server: Promise<SnapshotServer> | null = null;

async function start(base: string): Promise<SnapshotServer> {
  if (typeof WebAssembly !== 'object' || typeof DecompressionStream !== 'function') {
    throw new Error('This browser is too old to open the snapshot. Please use a current version of Chrome, Edge, Safari or Firefox.');
  }
  const engine = initSqlJs({ locateFile: () => wasmUrl });
  engine.catch(() => undefined);

  const res = await fetch(new URL(`data/snapshot.db.gz?v=${__SNAPSHOT_SHA__}`, base));
  if (!res.ok || !res.body) throw new Error(`The price database could not be downloaded (HTTP ${res.status}).`);
  const total = __SNAPSHOT_GZ_BYTES__;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    channel.postMessage({ type: 'progress', phase: 'download', loaded: Math.min(loaded, total), total });
  }

  channel.postMessage({ type: 'progress', phase: 'unpack' });
  const packed = new Blob(chunks as BlobPart[]);
  const head = chunks[0];
  const gzipped = !!head && head[0] === 0x1f && head[1] === 0x8b;
  const buffer = gzipped
    ? await new Response(packed.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    : await packed.arrayBuffer();

  channel.postMessage({ type: 'progress', phase: 'open' });
  const SQL = await engine;
  const db = new Db(new SQL.Database(new Uint8Array(buffer)));
  return createSnapshotServer(db);
}

async function answer(id: number, request: ApiRequest): Promise<void> {
  let response: ApiResponse;
  try {
    if (!server) throw new Error('The snapshot has not been started');
    response = await (await server).handle(request);
  } catch (err) {
    response = {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: { code: 'snapshot_failed', message: err instanceof Error ? err.message : 'The snapshot could not answer' } }),
    };
  }
  channel.postMessage({ type: 'response', id, ...response });
}

channel.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    setClockOffset(message.offset);
    server = start(message.base);
    server.then(
      (s) => channel.postMessage({ type: 'ready', routes: s.routes }),
      (err: unknown) => channel.postMessage({ type: 'fatal', message: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  if (message.type === 'request') void answer(message.id, message.request);
};
