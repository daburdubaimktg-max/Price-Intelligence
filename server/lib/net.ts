/**
 * Outbound HTTP for connectors, exchange-rate providers and webhooks.
 *   * http/https only, every redirect hop re-validated
 *   * private / loopback / link-local targets are refused unless explicitly allowed (SSRF protection)
 *   * hard timeout and response size cap
 *   * honest, configurable User-Agent
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import type { AppContext } from '../context.ts';

export class NetError extends Error {
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'NetError';
    this.code = code;
    this.status = status;
  }
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateIp(mapped[1]!);
  }
  return false;
}

/** Validates a URL for outbound use. Throws NetError when it must not be contacted. */
export async function assertAllowedUrl(ctx: AppContext, rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetError('invalid_url', `"${rawUrl}" is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetError('invalid_url', `Only http and https URLs are supported (got ${url.protocol})`);
  }
  if (url.username || url.password) throw new NetError('invalid_url', 'Credentials must not be embedded in the URL');
  if (ctx.config.allowPrivateNetwork) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new NetError('blocked_host', `${host} is a private address; set PIOS_ALLOW_PRIVATE_NETWORK=true to allow internal sources`);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new NetError('blocked_host', `${host} is a private address; set PIOS_ALLOW_PRIVATE_NETWORK=true to allow internal sources`);
    return url;
  }
  try {
    const addresses = await dns.lookup(host, { all: true });
    if (addresses.some((a) => isPrivateIp(a.address))) {
      throw new NetError('blocked_host', `${host} resolves to a private address; set PIOS_ALLOW_PRIVATE_NETWORK=true to allow internal sources`);
    }
  } catch (err) {
    if (err instanceof NetError) throw err;
    // Name resolution may legitimately happen at an outbound proxy; the request itself will report failures.
  }
  return url;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
}

/** fetch() with validation of the target (and each redirect), a timeout and our User-Agent. */
export async function safeFetch(ctx: AppContext, rawUrl: string, options: SafeFetchOptions = {}): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const signal = AbortSignal.timeout(timeoutMs);
  let current = rawUrl;
  let method = options.method ?? 'GET';
  let body = options.body;
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
    const url = await assertAllowedUrl(ctx, current);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        body,
        redirect: 'manual',
        signal,
        headers: { 'user-agent': options.userAgent ?? ctx.config.userAgent, ...(options.headers ?? {}) },
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new NetError('timeout', `No response from ${url.host} within ${Math.round(timeoutMs / 1000)}s`);
      const cause = e.cause?.code ?? e.cause?.message ?? e.message;
      throw new NetError('network_error', `Could not reach ${url.host}: ${cause}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      await res.body?.cancel();
      continue;
    }
    return res;
  }
  throw new NetError('too_many_redirects', 'Too many redirects');
}

/** Reads a response body as text, refusing bodies larger than `maxBytes`. */
export async function readBody(res: Response, maxBytes = 15 * 1024 * 1024): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new NetError('too_large', `Response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new NetError('too_large', `Response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
