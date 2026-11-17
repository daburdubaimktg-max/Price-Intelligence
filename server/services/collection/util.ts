/** Parsing and politeness helpers shared by the collection connectors. */
import { parse as parseCsvSync } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import type { Availability } from '../../../shared/constants.ts';

// ---------------------------------------------------------------------------------------------
// Paths into structured payloads
// ---------------------------------------------------------------------------------------------

/**
 * Reads `a.b[0].c` / `a.b.0.c` from an object. An exact key match wins first (CSV headers and XML tags
 * may contain dots). Stepping through an array with a property name reads the first element, so
 * `offers.price` works whether `offers` is an object or a list.
 */
export function getPath(source: unknown, path: string | null | undefined): unknown {
  if (path === null || path === undefined) return undefined;
  const trimmed = String(path).trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '$') return source;
  if (source !== null && typeof source === 'object' && !Array.isArray(source) && Object.hasOwn(source, trimmed)) {
    return (source as Record<string, unknown>)[trimmed];
  }
  const parts = trimmed
    .replace(/^\$\.?/, '')
    .replace(/\[(-?\d+)\]/g, '.$1')
    .split('.')
    .filter((p) => p !== '');
  let current: unknown = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (Number.isInteger(index)) {
        current = current[index < 0 ? current.length + index : index];
        continue;
      }
      current = current[0];
      if (current === null || current === undefined) return undefined;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Text of a scalar-ish value (XML nodes with attributes keep their text under `#text`). */
export function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? asText(value[0]) : null;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['#text', 'value', 'name', 'text']) {
      if (key in o) return asText(o[key]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------

export type DecimalSeparator = 'auto' | '.' | ',';

const NUMBER_TOKEN = /(\d{1,3}(?:[   ']\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)*)/;

/**
 * Reads a price from numbers and from text such as "AED 12.50", "12,50 €", "1,234.50", "1.234,50",
 * "KSh 1,250" or "١٢٫٥٠". Returns null when no non-negative number can be read — callers never guess.
 *
 * In `auto` mode a lone comma followed by exactly three digits is a thousands separator ("1,250" → 1250)
 * and a lone dot is always a decimal point ("1.250" → 1.25, as used for KWD/BHD/OMR).
 */
export function parsePrice(value: unknown, options: { divisor?: number; decimalSeparator?: DecimalSeparator } = {}): number | null {
  const divisor = options.divisor && options.divisor > 0 ? options.divisor : 1;
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value / divisor : null;
  if (Array.isArray(value)) return value.length ? parsePrice(value[0], options) : null;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['#text', 'value', 'amount', 'price']) {
      if (key in o) return parsePrice(o[key], options);
    }
    return null;
  }
  const text = String(value)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
  const match = NUMBER_TOKEN.exec(text);
  if (!match) return null;
  if (match.index > 0 && /[-−]/.test(text[match.index - 1]!)) return null;
  const token = match[0].replace(/[   ']/g, '');
  const separator = options.decimalSeparator ?? 'auto';
  const hasDot = token.includes('.');
  const hasComma = token.includes(',');
  let normalised: string;
  if (separator === ',') {
    normalised = token.replace(/\./g, '').replace(',', '.');
  } else if (separator === '.') {
    normalised = token.replace(/,/g, '');
  } else if (hasDot && hasComma) {
    normalised = token.lastIndexOf('.') > token.lastIndexOf(',') ? token.replace(/,/g, '') : token.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    const parts = token.split(',');
    normalised = parts.length === 2 && parts[1]!.length !== 3 ? `${parts[0]}.${parts[1]}` : parts.join('');
  } else if (hasDot) {
    const parts = token.split('.');
    normalised = parts.length > 2 ? parts.join('') : token;
  } else {
    normalised = token;
  }
  const amount = Number(normalised);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount / divisor;
}

export function parsePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parsePrice(String(value).replace('%', ''));
  if (n === null || !Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/** Source timestamps: ISO strings, unix seconds or unix milliseconds. Unparseable → null. */
export function parseSourceTimestamp(value: unknown): string | null {
  const text = asText(value);
  if (text === null) return null;
  let date: Date;
  if (/^\d{9,13}$/.test(text)) {
    const n = Number(text);
    date = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    date = new Date(text);
  }
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) return null;
  return date.toISOString();
}

// ---------------------------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------------------------

export type AvailabilityMap = Partial<Record<'in_stock' | 'limited' | 'out_of_stock', string[]>>;

const IN_STOCK = new Set(['instock', 'available', 'true', 'yes', 'y', 'onlineonly', 'instoreonly', 'inventoryavailable', 'ok']);
const LIMITED = new Set(['limited', 'limitedavailability', 'lowstock', 'limitedstock', 'fewleft', 'low']);
const OUT_OF_STOCK = new Set([
  'outofstock', 'soldout', 'unavailable', 'notavailable', 'false', 'no', 'n', 'discontinued', 'oos', 'currentlyunavailable',
]);

/**
 * Maps a source's stock value to our availability. The retailer-specific map (exact, case-insensitive)
 * wins; then schema.org URLs and common wordings; numbers are treated as stock quantities.
 * Anything unrecognised is `unknown` — never assumed to be in stock.
 */
export function mapAvailability(value: unknown, custom?: AvailabilityMap | null): Availability {
  if (value === null || value === undefined || value === '') return 'unknown';
  if (typeof value === 'boolean') return value ? 'in_stock' : 'out_of_stock';
  if (typeof value === 'number') return value > 0 ? 'in_stock' : 'out_of_stock';
  const text = asText(value);
  if (text === null) return 'unknown';
  const raw = text.toLowerCase();
  if (custom) {
    for (const key of ['in_stock', 'limited', 'out_of_stock'] as const) {
      if (custom[key]?.some((candidate) => String(candidate).trim().toLowerCase() === raw)) return key;
    }
  }
  const compact = raw.replace(/^https?:\/\/schema\.org\//, '').replace(/[\s_-]+/g, '');
  if (IN_STOCK.has(compact)) return 'in_stock';
  if (LIMITED.has(compact)) return 'limited';
  if (OUT_OF_STOCK.has(compact)) return 'out_of_stock';
  if (/^\d+(\.\d+)?$/.test(compact)) return Number(compact) > 0 ? 'in_stock' : 'out_of_stock';
  // Free text such as "In stock (22 available)" or "Sorry, this item is sold out": only explicit wording
  // counts, negative wording is checked first, and anything else stays unknown.
  if (/\bout[\s-]of[\s-]stock\b|\bsold[\s-]?out\b|\bunavailable\b|\bnot (currently |yet )?available\b|\bno longer available\b/.test(raw)) return 'out_of_stock';
  if (/\b(only|just) \d+ (left|remaining)\b|\blow stock\b|\blimited (stock|availability)\b|\bfew left\b/.test(raw)) return 'limited';
  if (/\bin[\s-]?stock\b/.test(raw)) return 'in_stock';
  return 'unknown';
}

/**
 * ISO currency code written next to a price ("15.00 AED", "USD 3.99"), if it is one of the known codes.
 * Currency symbols are deliberately ignored: "$" or "ر.س" alone do not identify a currency reliably.
 */
export function currencyInText(value: unknown, known: ReadonlySet<string>): string | null {
  if (typeof value !== 'string') return null;
  for (const match of value.toUpperCase().matchAll(/\b[A-Z]{3}\b/g)) {
    if (known.has(match[0])) return match[0];
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Identifier normalisation (matching feed items to listings)
// ---------------------------------------------------------------------------------------------

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_)$/i;

export function normaliseUrlKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const query = url.searchParams.toString();
    return `${url.protocol}//${url.host.toLowerCase()}${path}${query ? `?${query}` : ''}`;
  } catch {
    return text.toLowerCase();
  }
}

export function normaliseGtin(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  const digits = text.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 6 ? digits : null;
}

export function normaliseExternalId(value: unknown): string | null {
  const text = asText(value);
  return text ? text.toLowerCase() : null;
}

// ---------------------------------------------------------------------------------------------
// Feed formats
// ---------------------------------------------------------------------------------------------

function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let bestCount = -1;
  for (const candidate of [',', ';', '\t', '|']) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === candidate && !quoted) count++;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsvRows(text: string): Array<Record<string, string>> {
  return parseCsvSync(text, {
    columns: (header: string[]) => header.map((h) => String(h).trim()),
    bom: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
    delimiter: detectDelimiter(text),
  }) as Array<Record<string, string>>;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

export function parseXml(text: string): unknown {
  return xmlParser.parse(text);
}

/** Shortens long strings inside a sample payload so diagnostics stay readable. */
export function truncateSample(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 5) return '…';
  if (Array.isArray(value)) return value.slice(0, 8).map((v) => truncateSample(v, depth + 1));
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (count++ >= 40) {
      out['…'] = 'more fields omitted';
      break;
    }
    out[key] = truncateSample(v, depth + 1);
  }
  return out;
}

export function excerptOf(text: string, max = 500): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

// ---------------------------------------------------------------------------------------------
// Politeness: one request at a time per host, with a minimum pause between requests
// ---------------------------------------------------------------------------------------------

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const hostQueues = new Map<string, Promise<void>>();
const hostLastDone = new Map<string, number>();

/**
 * Runs `fn` (one outbound request) for `host`: strictly sequential per host and never sooner than
 * `minDelayMs` after the previous request to that host finished — across all jobs in this process.
 */
export async function hostThrottled<T>(host: string, minDelayMs: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => gate,
    () => gate,
  );
  hostQueues.set(host, tail);
  await previous.catch(() => undefined);
  try {
    const last = hostLastDone.get(host);
    if (last !== undefined) {
      const wait = last + minDelayMs - Date.now();
      if (wait > 0) await sleep(wait, signal);
    }
    return await fn();
  } finally {
    hostLastDone.set(host, Date.now());
    release();
    if (hostQueues.get(host) === tail) hostQueues.delete(host);
  }
}

/** Removes the value of a secret query parameter from a URL before it is logged or stored. */
export function redactUrl(rawUrl: string, secretParams: string[] = []): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (secretParams.includes(key) || /^(api[_-]?key|apikey|token|access[_-]?token|key|secret|password|auth|signature)$/i.test(key)) {
        url.searchParams.set(key, 'REDACTED');
      }
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}
