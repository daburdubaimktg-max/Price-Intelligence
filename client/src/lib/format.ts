/** Display formatting. Timestamps are stored in UTC and shown in the market's local time. */

const CURRENCY_DECIMALS: Record<string, number> = { KWD: 3, BHD: 3, OMR: 3, JOD: 3, IQD: 0, UGX: 0, TZS: 0 };

/** Called once reference data is loaded so newly added currencies format correctly. */
export function registerCurrencies(currencies: Array<{ code: string; decimals: number }>): void {
  for (const c of currencies) CURRENCY_DECIMALS[c.code] = c.decimals;
}

export function currencyDecimals(currency: string | null | undefined): number {
  return currency ? (CURRENCY_DECIMALS[currency] ?? 2) : 2;
}

const numberFormatters = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = numberFormatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-GB', { minimumFractionDigits: min, maximumFractionDigits: max });
    numberFormatters.set(key, f);
  }
  return f;
}

export const DASH = '—';

/** Price without the currency code, using the currency's own decimals (e.g. 12.50, 1.250, 4,250). */
export function fmtPrice(value: number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const d = currencyDecimals(currency);
  return nf(d, d).format(value);
}

/** Price with currency code: "AED 12.50". */
export function fmtMoney(value: number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return currency ? `${currency} ${fmtPrice(value, currency)}` : fmtPrice(value, currency);
}

/** Unit prices need more precision than shelf prices in high-value currencies. */
export function fmtUnitPrice(value: number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const d = Math.max(currencyDecimals(currency), value < 1 ? 3 : 2);
  return nf(currencyDecimals(currency) === 0 ? 0 : d, currencyDecimals(currency) === 0 ? 1 : d).format(value);
}

export function fmtNumber(value: number | null | undefined, maxDecimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return nf(0, maxDecimals).format(value);
}

export function fmtCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${nf(0, 1).format(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${nf(0, 1).format(value / 1_000)}K`;
  return nf(0, 0).format(value);
}

export function fmtPct(value: number | null | undefined, decimals = 1, signed = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const text = nf(decimals, decimals).format(Math.abs(value));
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  return `${sign}${text}%`;
}

/** Signed % with a direction word for screen readers and plain-text contexts. */
export function fmtDelta(value: number | null | undefined, decimals = 1): string {
  return fmtPct(value, decimals, true);
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
function dtf(timeZone: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone ?? 'local'}:${JSON.stringify(options)}`;
  let f = dateTimeFormatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { ...options, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', options);
    }
    dateTimeFormatters.set(key, f);
  }
  return f;
}

/** "17 Nov 2026, 13:05" in the given IANA time zone (viewer's zone when omitted). */
export function fmtDateTime(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return dtf(timeZone ?? undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** Short form without the year: "17 Nov, 13:05". */
export function fmtDateTimeShort(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return dtf(timeZone ?? undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** Calendar date "2026-11-17" → "17 Nov 2026". */
export function fmtDate(isoDate: string | null | undefined): string {
  if (!isoDate) return DASH;
  const d = new Date(isoDate.length === 10 ? `${isoDate}T00:00:00Z` : isoDate);
  if (Number.isNaN(d.getTime())) return DASH;
  return dtf('UTC', { day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

export function fmtDateShort(isoDate: string | null | undefined): string {
  if (!isoDate) return DASH;
  const d = new Date(isoDate.length === 10 ? `${isoDate}T00:00:00Z` : isoDate);
  if (Number.isNaN(d.getTime())) return DASH;
  return dtf('UTC', { day: '2-digit', month: 'short' }).format(d);
}

/** "GMT+4" style label for a time zone (at the given instant). */
export function tzLabel(timeZone: string | null | undefined, at: Date = new Date()): string {
  if (!timeZone) return '';
  try {
    const part = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

export function fmtRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return DASH;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return DASH;
  const seconds = Math.round((now - then) / 1000);
  const abs = Math.abs(seconds);
  const suffix = seconds >= 0 ? 'ago' : 'from now';
  if (abs < 60) return seconds >= 0 ? 'just now' : 'in a moment';
  if (abs < 3600) return `${Math.round(abs / 60)} min ${suffix}`;
  if (abs < 86_400) return `${Math.round(abs / 3600)} h ${suffix}`;
  if (abs < 86_400 * 45) return `${Math.round(abs / 86_400)} d ${suffix}`;
  return `${Math.round(abs / (86_400 * 30))} mo ${suffix}`;
}

export function fmtHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return DASH;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return DASH;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${nf(0, 1).format(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${nf(0, 1).format(bytes / 1024 / 1024)} MB`;
  return `${nf(0, 2).format(bytes / 1024 / 1024 / 1024)} GB`;
}

export function titleCase(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${fmtNumber(count)} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

export function initials(text: string | null | undefined): string {
  if (!text) return '?';
  const words = text.trim().split(/\s+/).slice(0, 2);
  return words.map((w) => w[0]!.toUpperCase()).join('');
}
