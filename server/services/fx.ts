/**
 * Exchange rates. Prices in different currencies are never compared raw: every conversion goes through
 * this module and carries the rate, its timestamp and its source so the UI and exports can show them.
 *
 * Rates are stored against USD (1 USD = `rate` units of the quote currency) as an append-only history.
 */
import type { AppContext } from '../context.ts';
import { nowIso } from '../lib/time.ts';
import { AppError } from '../lib/errors.ts';
import { getSecret, getSetting } from './core.ts';
import { safeFetch } from '../lib/net.ts';

export const FX_BASE = 'USD';

export interface RateInfo {
  currency: string;
  /** Units of `currency` per 1 USD. */
  rate: number;
  as_of: string;
  source: string;
  is_demo: boolean;
}

export interface Conversion {
  from: string;
  to: string;
  /** Multiply an amount in `from` by this to get `to`. */
  rate: number;
  /** Timestamp of the oldest rate leg used. */
  as_of: string;
  sources: string[];
  is_demo: boolean;
}

/** Latest known rate per currency at or before `asOf` (falls back to the earliest later rate). */
export function latestRates(ctx: AppContext, asOf?: string): Map<string, RateInfo> {
  const cutoff = asOf ?? '9999-12-31T23:59:59.999Z';
  const rows = ctx.db.all<{ quote_currency: string; rate: number; as_of: string; source: string; is_demo: number }>(
    `SELECT quote_currency, rate, as_of, source, is_demo FROM (
       SELECT r.*, ROW_NUMBER() OVER (PARTITION BY quote_currency ORDER BY as_of DESC, id DESC) AS rn
       FROM exchange_rates r WHERE base_currency = ? AND as_of <= ?
     ) WHERE rn = 1`,
    [FX_BASE, cutoff],
  );
  const out = new Map<string, RateInfo>();
  for (const r of rows) {
    out.set(r.quote_currency, { currency: r.quote_currency, rate: r.rate, as_of: r.as_of, source: r.source, is_demo: r.is_demo === 1 });
  }
  if (asOf) {
    // Currencies whose first rate is later than the cut-off: use the earliest available rather than none.
    const later = ctx.db.all<{ quote_currency: string; rate: number; as_of: string; source: string; is_demo: number }>(
      `SELECT quote_currency, rate, as_of, source, is_demo FROM (
         SELECT r.*, ROW_NUMBER() OVER (PARTITION BY quote_currency ORDER BY as_of ASC, id ASC) AS rn
         FROM exchange_rates r WHERE base_currency = ?
       ) WHERE rn = 1`,
      [FX_BASE],
    );
    for (const r of later) {
      if (!out.has(r.quote_currency)) {
        out.set(r.quote_currency, { currency: r.quote_currency, rate: r.rate, as_of: r.as_of, source: r.source, is_demo: r.is_demo === 1 });
      }
    }
  }
  out.set(FX_BASE, { currency: FX_BASE, rate: 1, as_of: asOf ?? nowIso(), source: 'base currency', is_demo: false });
  return out;
}

export interface Converter {
  to: string;
  /** Converts or returns null when no rate is available for `from` (never guesses). */
  convert: (amount: number | null | undefined, from: string) => number | null;
  conversion: (from: string) => Conversion | null;
  /** Conversions actually used so far (for footnotes). */
  used: () => Conversion[];
  /** Currencies that were requested but have no rate. */
  missing: () => string[];
}

export function makeConverter(ctx: AppContext, to: string, asOf?: string): Converter {
  const rates = latestRates(ctx, asOf);
  const used = new Map<string, Conversion>();
  const missing = new Set<string>();
  const conversion = (from: string): Conversion | null => {
    if (from === to) return { from, to, rate: 1, as_of: asOf ?? nowIso(), sources: [], is_demo: false };
    const cached = used.get(from);
    if (cached) return cached;
    const a = rates.get(from);
    const b = rates.get(to);
    if (!a || !b) {
      missing.add(!a ? from : to);
      return null;
    }
    const legs = [a, b].filter((r) => r.currency !== FX_BASE);
    const conv: Conversion = {
      from,
      to,
      rate: b.rate / a.rate,
      as_of: legs.length ? legs.map((l) => l.as_of).sort()[0]! : (asOf ?? nowIso()),
      sources: [...new Set(legs.map((l) => l.source))],
      is_demo: legs.some((l) => l.is_demo),
    };
    used.set(from, conv);
    return conv;
  };
  return {
    to,
    conversion,
    convert: (amount, from) => {
      if (amount === null || amount === undefined) return null;
      const c = conversion(from);
      return c ? amount * c.rate : null;
    },
    used: () => [...used.values()],
    missing: () => [...missing],
  };
}

export function recordRate(
  ctx: AppContext,
  input: { quote: string; rate: number; as_of: string; source: string; source_ref?: string | null; userId?: number | null; isDemo?: boolean },
): boolean {
  if (!(input.rate > 0) || !Number.isFinite(input.rate)) throw new AppError(422, 'validation_failed', 'Rate must be a positive number');
  const res = ctx.db.run(
    `INSERT INTO exchange_rates (base_currency, quote_currency, rate, as_of, source, source_ref, fetched_at, entered_by, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (base_currency, quote_currency, as_of, source) DO NOTHING`,
    [FX_BASE, input.quote, input.rate, input.as_of, input.source, input.source_ref ?? null, nowIso(), input.userId ?? null, !!input.isDemo],
  );
  return res.changes > 0;
}

interface ProviderPayload {
  result?: string;
  base_code?: string;
  base?: string;
  time_last_update_unix?: number;
  timestamp?: number;
  date?: string;
  rates?: Record<string, number>;
  conversion_rates?: Record<string, number>;
}

/** Interprets the common "latest rates" JSON shapes (open.er-api.com, exchangerate-api, openexchangerates, frankfurter). */
export function parseProviderRates(payload: ProviderPayload): { base: string; asOf: string; rates: Record<string, number> } {
  const rates = payload.rates ?? payload.conversion_rates;
  if (!rates || typeof rates !== 'object') throw new Error('Provider response does not contain a "rates" object');
  if (payload.result && payload.result !== 'success') throw new Error(`Provider reported "${payload.result}"`);
  const base = (payload.base_code ?? payload.base ?? FX_BASE).toUpperCase();
  const unix = payload.time_last_update_unix ?? payload.timestamp;
  let asOf: string;
  if (typeof unix === 'number' && unix > 0) asOf = new Date(unix * 1000).toISOString();
  else if (typeof payload.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)) asOf = `${payload.date}T00:00:00.000Z`;
  else throw new Error('Provider response does not state when the rates were published');
  return { base, asOf, rates };
}

/** Pulls rates from the configured provider and appends them to the rate history. */
export async function fetchRatesFromProvider(
  ctx: AppContext,
  userId?: number | null,
): Promise<{ inserted: number; unchanged: number; as_of: string; source: string; currencies: string[] }> {
  const url = getSetting(ctx, 'fx_provider_url');
  if (!url) throw new AppError(400, 'not_configured', 'No exchange-rate provider URL is configured');
  const apiKey = getSecret(ctx, 'integration:fx:api_key');
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new AppError(400, 'not_configured', 'The exchange-rate provider URL is not a valid URL');
  }
  let payload: ProviderPayload;
  try {
    const res = await safeFetch(ctx, url, {
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      timeoutMs: 20_000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = (await res.json()) as ProviderPayload;
  } catch (err) {
    throw new AppError(502, 'provider_failed', `Exchange-rate provider request failed: ${(err as Error).message}`);
  }
  let parsed: ReturnType<typeof parseProviderRates>;
  try {
    parsed = parseProviderRates(payload);
  } catch (err) {
    throw new AppError(502, 'provider_failed', (err as Error).message);
  }
  let { rates } = parsed;
  if (parsed.base !== FX_BASE) {
    const usd = rates[FX_BASE];
    if (!usd) throw new AppError(502, 'provider_failed', `Provider base is ${parsed.base} and no USD rate was supplied to rebase`);
    rates = Object.fromEntries(Object.entries(rates).map(([code, value]) => [code, value / usd]));
    rates[parsed.base] = 1 / usd;
  }
  const known = new Set(ctx.db.all<{ code: string }>('SELECT code FROM currencies').map((c) => c.code));
  let inserted = 0;
  let unchanged = 0;
  const currencies: string[] = [];
  ctx.db.tx(() => {
    for (const [code, value] of Object.entries(rates)) {
      if (code === FX_BASE || !known.has(code) || !(value > 0)) continue;
      const added = recordRate(ctx, { quote: code, rate: value, as_of: parsed.asOf, source: host, source_ref: url, userId });
      if (added) inserted++;
      else unchanged++;
      currencies.push(code);
    }
  });
  return { inserted, unchanged, as_of: parsed.asOf, source: host, currencies };
}
