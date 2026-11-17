/** Request parsing helpers shared by all route modules. */
import { z } from 'zod';
import { AppError, badRequest, unprocessable } from './errors.ts';

export function parse<T extends z.ZodType>(schema: T, data: unknown, what = 'request'): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw unprocessable(
      first ? `Invalid ${what}: ${first.path ? `${first.path} — ` : ''}${first.message}` : `Invalid ${what}`,
      { issues },
    );
  }
  return result.data;
}

export function idParam(value: unknown, what = 'id'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${what}`);
  return n;
}

/** "1,2,3" | ["1","2"] | 1 → [1,2,3]. Ignores blanks; rejects non-integers. */
export function idList(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const out: number[] = [];
  for (const part of parts) {
    const t = String(part).trim();
    if (!t) continue;
    const n = Number(t);
    if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid id "${t}"`);
    out.push(n);
  }
  return out.length ? out : undefined;
}

export function strList(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const out = parts.map((p) => String(p).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

export function optNumber(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`Invalid ${what}`);
  return n;
}

export function optBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return undefined;
}

export interface Page {
  page: number;
  pageSize: number;
  offset: number;
}

export function pagination(query: Record<string, unknown>, defaultSize = 50, maxSize = 500): Page {
  const page = Math.max(1, Math.floor(Number(query.page ?? 1)) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Math.floor(Number(query.page_size ?? defaultSize)) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function paged<T>(rows: T[], total: number, page: Page) {
  return { rows, total, page: page.page, page_size: page.pageSize, pages: Math.max(1, Math.ceil(total / page.pageSize)) };
}

/** Whitelisted ORDER BY. `sort=-name` → `name DESC`. */
export function orderBy(sort: unknown, allowed: Record<string, string>, fallback: string): string {
  if (typeof sort !== 'string' || !sort) return fallback;
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  const column = allowed[key];
  if (!column) return fallback;
  return `${column} ${desc ? 'DESC' : 'ASC'}`;
}

/** Escapes a value for a SQL LIKE pattern used with ESCAPE '\'. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function assert(condition: unknown, error: AppError): asserts condition {
  if (!condition) throw error;
}

/** Accepts '' / null / undefined as "not provided". */
export const optionalText = (max = 500) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      if (v === null || v === undefined) return null;
      const t = v.trim();
      return t ? t.slice(0, max) : null;
    });

export const optionalNumber = () =>
  z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((v, ctx) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: 'custom', message: 'must be a number' });
      return z.NEVER;
    }
    return n;
  });

export const optionalId = () =>
  z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((v, ctx) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      ctx.addIssue({ code: 'custom', message: 'must be a valid id' });
      return z.NEVER;
    }
    return n;
  });

export const requiredId = () =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      ctx.addIssue({ code: 'custom', message: 'must be a valid id' });
      return z.NEVER;
    }
    return n;
  });

export const flag = () =>
  z.union([z.boolean(), z.number(), z.string(), z.null(), z.undefined()]).transform((v) => v === true || v === 1 || v === '1' || v === 'true');
