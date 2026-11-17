/**
 * API client.
 *
 * Sessions use an HttpOnly cookie. Where the browser refuses cookies (for example when the app is shown
 * inside another site's frame), the client falls back to sending the session token in an Authorization
 * header — decided once, right after sign-in.
 */

const TOKEN_KEY = 'pios.session';
let bearer: string | null = null;

function readStoredToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function storeToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: keep the token in memory only */
  }
}
bearer = readStoredToken();

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;
export type Query = Record<string, QueryValue>;

export function toQueryString(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  /** Skip the Authorization header for this call (used to probe whether the cookie works). */
  cookieOnly?: boolean;
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (bearer && !options.cookieOnly) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`/api${path}${toQueryString(options.query)}`, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    credentials: 'same-origin',
    signal: options.signal,
  });
  if (!res.ok) {
    let code = 'error';
    let message = `Request failed (${res.status})`;
    let details: unknown;
    try {
      const payload = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      if (payload?.error) {
        code = payload.error.code ?? code;
        message = payload.error.message ?? message;
        details = payload.error.details;
      }
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 && !path.startsWith('/auth/login') && !options.cookieOnly) {
      for (const listener of unauthorizedListeners) listener();
    }
    throw new ApiError(res.status, code, message, details);
  }
  return res;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await request(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiGet = <T = unknown>(path: string, query?: Query, signal?: AbortSignal) => api<T>(path, { query, signal });
export const apiPost = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} });
export const apiPut = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body: body ?? {} });
export const apiPatch = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body: body ?? {} });
export const apiDelete = <T = unknown>(path: string) => api<T>(path, { method: 'DELETE' });
export const apiUpload = <T = unknown>(path: string, form: FormData) => api<T>(path, { method: 'POST', form });

/** Downloads a file from an authenticated endpoint (works in cookie and bearer mode). */
export async function download(path: string, query?: Query, fallbackName = 'download'): Promise<void> {
  const res = await request(path, { query });
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1]!) : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Loads a protected binary (e.g. an evidence image) as an object URL. Caller revokes it. */
export async function fetchObjectUrl(path: string): Promise<string> {
  const res = await request(path);
  return URL.createObjectURL(await res.blob());
}

export interface LoginResult {
  user: { id: number; email: string; name: string; role: string; must_change_password: boolean };
  token: string;
}

export async function signIn(email: string, password: string): Promise<LoginResult> {
  bearer = null;
  storeToken(null);
  const result = await api<LoginResult>('/auth/login', { method: 'POST', body: { email, password } });
  // Prefer the HttpOnly cookie. Only keep the token client-side when the cookie did not stick.
  try {
    await api('/auth/me', { cookieOnly: true });
  } catch {
    bearer = result.token;
    storeToken(result.token);
  }
  return result;
}

export async function signOut(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
  } finally {
    bearer = null;
    storeToken(null);
  }
}

export function clearSession(): void {
  bearer = null;
  storeToken(null);
}

/** Standard paged list envelope returned by list endpoints. */
export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}
