/**
 * Page side of the snapshot: starts the worker and hands it every `/api/...` request the app makes.
 * The app's own API client (`client/src/lib/api.ts`) is unchanged — it calls `fetch`, and this module
 * answers those calls from the worker instead of the network.
 */
import { getClockOffset } from './clock.ts';
import type { WorkerInbound, WorkerOutbound } from './worker.ts';

export type Progress = { phase: 'download'; loaded: number; total: number } | { phase: 'unpack' | 'open' };

export function startSnapshot(onProgress: (progress: Progress) => void): Promise<void> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const send = (message: WorkerInbound) => worker.postMessage(message);
  const pending = new Map<number, (response: Response) => void>();
  let nextId = 1;

  const ready = new Promise<void>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress(message.phase === 'download' ? { phase: 'download', loaded: message.loaded, total: message.total } : { phase: message.phase });
      } else if (message.type === 'ready') {
        resolve();
      } else if (message.type === 'fatal') {
        reject(new Error(message.message));
      } else {
        const settle = pending.get(message.id);
        if (!settle) return;
        pending.delete(message.id);
        const empty = message.body === null || message.status === 204 || message.status === 304;
        settle(new Response(empty ? null : (message.body as BodyInit), { status: message.status, headers: message.headers }));
      }
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The snapshot could not be started in this browser.'));
  });

  const networkFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, document.baseURI);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return networkFetch(input, init);

    const signal = init?.signal ?? null;
    return new Promise<Response>((resolve, reject) => {
      const aborted = () => new DOMException('The request was cancelled', 'AbortError');
      if (signal?.aborted) {
        reject(aborted());
        return;
      }
      const id = nextId++;
      const onAbort = () => {
        pending.delete(id);
        reject(aborted());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, (response) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(response);
      });
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      send({
        type: 'request',
        id,
        request: {
          method: init?.method ?? 'GET',
          target: `${url.pathname.slice('/api'.length)}${url.search}`,
          headers,
          body: typeof init?.body === 'string' ? init.body : null,
        },
      });
    });
  };

  send({ type: 'init', base: document.baseURI, offset: getClockOffset() });
  return ready;
}
