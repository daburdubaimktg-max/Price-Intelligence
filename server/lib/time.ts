/**
 * Time helpers. Everything is stored in UTC; market-local calendar dates are derived with the
 * market's IANA time zone (so daily buckets line up with the trading day in each market).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(utc: Date | string | number, timeZone: string): ZonedParts {
  const date = utc instanceof Date ? utc : new Date(utc);
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour!, minute: out.minute!, second: out.second! };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Calendar date (YYYY-MM-DD) of a UTC instant in the given time zone. */
export function localDate(utc: Date | string | number, timeZone: string): string {
  const p = zonedParts(utc, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Offset (local − UTC) in milliseconds of a time zone at a given instant. */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  const p = zonedParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a wall-clock time in a time zone to the UTC instant. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = tzOffsetMs(guess, timeZone);
  let utc = guess - offset;
  const offset2 = tzOffsetMs(utc, timeZone);
  if (offset2 !== offset) utc = guess - offset2;
  return new Date(utc);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function hoursAgoIso(hours: number, from: Date = new Date()): string {
  return new Date(from.getTime() - hours * 3_600_000).toISOString();
}

export function daysAgoIso(days: number, from: Date = new Date()): string {
  return hoursAgoIso(days * 24, from);
}

export type DateOrder = 'auto' | 'dmy' | 'mdy' | 'ymd';

export interface ParsedTimestamp {
  utc: string;
  basis: 'exact' | 'date_only';
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parses timestamps as they appear in CSV exports and manual entry.
 *   * ISO-8601 with offset / Z          → exact instant
 *   * date + time without offset        → wall-clock time in `timeZone`
 *   * date only                         → 12:00 local time in `timeZone`, flagged `date_only`
 * Supported date shapes: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY (per `order`), DD-Mon-YYYY, DD Mon YYYY.
 * Returns null when the text cannot be interpreted unambiguously.
 */
export function parseTimestamp(input: string, timeZone: string, order: DateOrder = 'auto'): ParsedTimestamp | null {
  const text = input.trim();
  if (!text) return null;

  // Full ISO instant with explicit offset
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const d = new Date(text.replace(' ', 'T').replace(/\s+/g, ''));
    return Number.isNaN(d.getTime()) ? null : { utc: d.toISOString(), basis: 'exact' };
  }

  let rest = text;
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(rest);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
    rest = rest.slice(m[0].length);
  } else if ((m = /^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]+(\d{2,4})/.exec(rest))) {
    day = Number(m[1]);
    month = MONTHS[m[2]!.slice(0, 3).toLowerCase()] ?? MONTHS[m[2]!.toLowerCase()];
    year = Number(m[3]);
    if (year < 100) year += 2000;
    rest = rest.slice(m[0].length);
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(rest))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    year = Number(m[3]);
    if (year < 100) year += 2000;
    let resolved: DateOrder = order;
    if (resolved === 'auto' || resolved === 'ymd') {
      if (a > 12 && b <= 12) resolved = 'dmy';
      else if (b > 12 && a <= 12) resolved = 'mdy';
      else if (a === b) resolved = 'dmy';
      else return null; // ambiguous (e.g. 03/04/2026) — caller must state the date order
    }
    if (resolved === 'dmy') {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }
    rest = rest.slice(m[0].length);
  } else {
    return null;
  }

  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;

  rest = rest.trim().replace(/^[T,]\s*/i, '');
  if (!rest) {
    return { utc: zonedTimeToUtc(year, month, day, 12, 0, 0, timeZone).toISOString(), basis: 'date_only' };
  }
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(am|pm)?$/i.exec(rest);
  if (!t) return null;
  let hour = Number(t[1]);
  const minute = Number(t[2]);
  const second = t[3] ? Number(t[3]) : 0;
  const meridiem = t[4]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { utc: zonedTimeToUtc(year, month, day, hour, minute, second, timeZone).toISOString(), basis: 'exact' };
}
