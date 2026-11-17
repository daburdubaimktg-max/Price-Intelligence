/**
 * Structured-source connector: official retailer APIs, product feeds and third-party data providers.
 *
 * One generic, configuration-driven connector covers all three, because they differ only in where the
 * data comes from: an HTTP endpoint returning JSON, CSV or XML, an optional credential, and a mapping
 * from the source's fields to ours. Nothing here is specific to a retailer.
 *
 * It only ever reports what the source returned. Missing credentials, rejected requests, unparseable
 * responses and unreadable prices are reported as such — a price is never guessed.
 */
import type { AppContext } from '../../context.ts';
import type { CollectionMethod } from '../../../shared/constants.ts';
import { isPriceCutWording, normaliseDealTags } from '../../../shared/constants.ts';
import type { ConnectorConfigField, ConnectorDescription, ConnectorExample } from '../../../shared/api/collection.ts';
import { sha256Hex } from '../../lib/crypto.ts';
import { NetError, readBody, safeFetch } from '../../lib/net.ts';
import {
  emptyResult,
  type CollectContext,
  type CollectResult,
  type ConfigCheck,
  type Connector,
  type ObservationDraft,
  type SourceListing,
  type SourceRetailer,
} from './types.ts';
import {
  asText,
  currencyInText,
  getPath,
  hostThrottled,
  mapAvailability,
  normaliseExternalId,
  normaliseGtin,
  normaliseUrlKey,
  parseCsvRows,
  parsePercent,
  parsePrice,
  parseSourceTimestamp,
  parseXml,
  redactUrl,
  truncateSample,
  type AvailabilityMap,
  type DecimalSeparator,
} from './util.ts';

type AuthType = 'none' | 'bearer' | 'header' | 'query' | 'basic';
type ListingKey = 'external_id' | 'url' | 'gtin';

export interface StructuredConfig {
  mode: 'bulk' | 'per_listing';
  format: 'json' | 'csv' | 'xml';
  url: string | null;
  url_template: string | null;
  items_path: string;
  auth: { type: AuthType; header_name: string | null; query_param: string | null; username: string | null };
  headers: Record<string, string>;
  fields: {
    current_price: string | null;
    regular_price: string | null;
    promo_price: string | null;
    discount_pct: string | null;
    promo_description: string | null;
    availability: string | null;
    currency: string | null;
    url: string | null;
    title: string | null;
    gtin: string | null;
    source_timestamp: string | null;
    item_id: string | null;
    rating: string | null;
    review_count: string | null;
    sales_rank: string | null;
    sales_rank_label: string | null;
    seller_name: string | null;
  };
  /** Fields holding the tags / badges shown with the price: one text, a list of texts or a list of objects with a text. */
  tags: string[];
  /** Yes/no fields that mean a badge → the wording recorded when the flag is set, e.g. { is_bestseller: 'Best seller' }. */
  flag_tags: Record<string, string>;
  /** 'fetch': observations are dated when this system read the source. 'source': at the item's own timestamp. */
  observed_time: 'fetch' | 'source';
  match: { listing_key: ListingKey; field: string | null };
  availability_map: AvailabilityMap | null;
  price_divisor: number;
  decimal_separator: DecimalSeparator;
  pagination: { type: 'none' | 'page' | 'next_url'; param: string; start: number; max_pages: number; path: string | null };
  discover_listings: boolean;
  discover_limit: number;
  timeout_ms: number;
}

const FIELD_KEYS = [
  'current_price', 'regular_price', 'promo_price', 'discount_pct', 'promo_description', 'availability', 'currency', 'url',
  'title', 'gtin', 'source_timestamp', 'item_id', 'rating', 'review_count', 'sales_rank', 'sales_rank_label', 'seller_name',
] as const;

const CONFIDENCE: Partial<Record<CollectionMethod, number>> = { official_api: 0.97, product_feed: 0.95, third_party: 0.9 };

const str = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
};
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Normalises the stored JSON into a typed config and lists everything that prevents a run. */
export function readStructuredConfig(raw: Record<string, unknown>): { config: StructuredConfig; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const mode = raw.mode === 'per_listing' ? 'per_listing' : 'bulk';
  const formatRaw = str(raw.format)?.toLowerCase() ?? 'json';
  const format = formatRaw === 'csv' || formatRaw === 'xml' || formatRaw === 'json' ? formatRaw : 'json';
  if (!['json', 'csv', 'xml'].includes(formatRaw)) problems.push(`Unsupported format "${formatRaw}" (use json, csv or xml)`);

  const authRaw = obj(raw.auth);
  const authTypeRaw = str(authRaw.type)?.toLowerCase() ?? 'none';
  const authType: AuthType = (['none', 'bearer', 'header', 'query', 'basic'] as const).includes(authTypeRaw as AuthType) ? (authTypeRaw as AuthType) : 'none';
  if (authTypeRaw !== authType) problems.push(`Unsupported authentication type "${authTypeRaw}"`);
  const auth = { type: authType, header_name: str(authRaw.header_name), query_param: str(authRaw.query_param), username: str(authRaw.username) };
  if (auth.type === 'header' && !auth.header_name) problems.push('Name of the HTTP header that carries the API key (auth.header_name)');
  if (auth.type === 'query' && !auth.query_param) problems.push('Name of the URL parameter that carries the API key (auth.query_param)');
  if (auth.type === 'basic' && !auth.username) problems.push('User name for HTTP basic authentication (auth.username)');

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj(raw.headers))) {
    if (typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(key)) headers[key] = value;
  }

  const fieldsRaw = obj(raw.fields);
  const fields = Object.fromEntries(FIELD_KEYS.map((key) => [key, str(fieldsRaw[key])])) as StructuredConfig['fields'];
  if (!fields.current_price) problems.push('Field mapping for the selling price (fields.current_price)');

  const matchRaw = obj(raw.match);
  const keyRaw = str(matchRaw.listing_key) ?? 'external_id';
  const listingKey: ListingKey = keyRaw === 'url' || keyRaw === 'gtin' ? keyRaw : 'external_id';
  const match = { listing_key: listingKey, field: str(matchRaw.field) };

  const url = str(raw.url);
  const urlTemplate = str(raw.url_template);
  const checkUrl = (value: string, label: string) => {
    try {
      const parsed = new URL(value.replace(/\{[a-z_]+\}/g, 'x'));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') problems.push(`${label} must be an http(s) URL`);
    } catch {
      problems.push(`${label} is not a valid URL`);
    }
  };
  if (mode === 'bulk') {
    if (!url) problems.push('Feed / API URL (url)');
    else checkUrl(url, 'Feed / API URL');
    if (!match.field) problems.push('Field that identifies each item so it can be matched to a listing (match.field)');
  } else {
    if (!urlTemplate) problems.push('Request URL template with a placeholder such as {external_id} (url_template)');
    else {
      checkUrl(urlTemplate, 'Request URL template');
      if (!/\{(external_id|url|gtin|sku|listing_code)\}/.test(urlTemplate)) {
        problems.push('The URL template must contain a placeholder: {external_id}, {url}, {gtin}, {sku} or {listing_code}');
      }
    }
  }

  const pagRaw = obj(raw.pagination);
  const pagTypeRaw = str(pagRaw.type) ?? 'none';
  const pagType = pagTypeRaw === 'page' || pagTypeRaw === 'next_url' ? pagTypeRaw : 'none';
  const pagination = {
    type: pagType as StructuredConfig['pagination']['type'],
    param: str(pagRaw.param) ?? 'page',
    start: clampInt(pagRaw.start, 1, 0, 1_000_000),
    max_pages: clampInt(pagRaw.max_pages, 20, 1, 200),
    path: str(pagRaw.path),
  };
  if (pagination.type === 'next_url' && !pagination.path) problems.push('Path of the "next page" link in the response (pagination.path)');
  if (pagination.type === 'next_url' && format === 'csv') problems.push('"next_url" pagination is not available for CSV feeds');
  if (pagination.type !== 'none' && mode === 'per_listing') warnings.push('Pagination is ignored in per-listing mode');

  const tagsRaw = Array.isArray(raw.tags) ? raw.tags : typeof raw.tags === 'string' ? raw.tags.split(/[\n;]+/) : [];
  const tagFields = [...new Set(tagsRaw.map((v) => str(v)).filter((v): v is string => v !== null))].slice(0, 20);
  const flagTags: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj(raw.flag_tags))) {
    const wording = str(value);
    if (key.trim() && wording) flagTags[key.trim()] = wording.slice(0, 120);
  }
  const observedTime = raw.observed_time === 'source' ? 'source' : 'fetch';
  if (observedTime === 'source' && !fields.source_timestamp) {
    problems.push('Field mapping for the item timestamp (fields.source_timestamp) — needed when observations are dated by the source');
  }

  const mapRaw = obj(raw.availability_map);
  let availabilityMap: AvailabilityMap | null = null;
  for (const key of ['in_stock', 'limited', 'out_of_stock'] as const) {
    const list = Array.isArray(mapRaw[key]) ? (mapRaw[key] as unknown[]).map((v) => String(v)) : null;
    if (list?.length) (availabilityMap ??= {})[key] = list;
  }

  const divisor = Number(raw.price_divisor);
  const sepRaw = str(raw.decimal_separator);
  const config: StructuredConfig = {
    mode,
    format,
    url,
    url_template: urlTemplate,
    items_path: str(raw.items_path) ?? '',
    auth,
    headers,
    fields,
    tags: tagFields,
    flag_tags: flagTags,
    observed_time: observedTime,
    match,
    availability_map: availabilityMap,
    price_divisor: Number.isFinite(divisor) && divisor > 0 ? divisor : 1,
    decimal_separator: sepRaw === ',' || sepRaw === '.' ? sepRaw : 'auto',
    pagination,
    discover_listings: raw.discover_listings === true,
    discover_limit: clampInt(raw.discover_limit, 200, 1, 2000),
    timeout_ms: clampInt(raw.timeout_ms, 30_000, 1_000, 120_000),
  };
  if (config.discover_listings && mode === 'per_listing') warnings.push('Listing discovery only works in bulk mode');
  return { config, problems, warnings };
}

interface Fetched {
  ok: true;
  body: string;
  fetchedAt: string;
  logUrl: string;
  finalUrl: string;
}
interface FetchFailure {
  ok: false;
  code: string;
  message: string;
  /** Applies to the whole source, not just one listing (stop the run). */
  runLevel: boolean;
}

function authRequest(cfg: StructuredConfig, credential: string | null, rawUrl: string): { url: string; headers: Record<string, string>; logUrl: string } {
  const headers: Record<string, string> = {
    accept: cfg.format === 'json' ? 'application/json' : cfg.format === 'xml' ? 'application/xml, text/xml, */*' : 'text/csv, text/plain, */*',
    ...cfg.headers,
  };
  let url = rawUrl;
  const secretParams: string[] = [];
  if (credential) {
    if (cfg.auth.type === 'bearer') headers.authorization = `Bearer ${credential}`;
    else if (cfg.auth.type === 'header' && cfg.auth.header_name) headers[cfg.auth.header_name] = credential;
    else if (cfg.auth.type === 'basic') headers.authorization = `Basic ${Buffer.from(`${cfg.auth.username ?? ''}:${credential}`).toString('base64')}`;
    else if (cfg.auth.type === 'query' && cfg.auth.query_param) {
      const u = new URL(rawUrl);
      u.searchParams.set(cfg.auth.query_param, credential);
      url = u.toString();
      secretParams.push(cfg.auth.query_param);
    }
  }
  return { url, headers, logUrl: redactUrl(url, secretParams) };
}

async function fetchSource(cc: CollectContext, cfg: StructuredConfig, rawUrl: string, maxBytes: number): Promise<Fetched | FetchFailure> {
  let request: ReturnType<typeof authRequest>;
  try {
    request = authRequest(cfg, cc.credential, rawUrl);
  } catch {
    return { ok: false, code: 'invalid_url', message: `"${redactUrl(rawUrl)}" is not a valid URL`, runLevel: true };
  }
  let host: string;
  try {
    host = new URL(request.url).host;
  } catch {
    return { ok: false, code: 'invalid_url', message: `"${request.logUrl}" is not a valid URL`, runLevel: true };
  }
  try {
    return await hostThrottled(
      host,
      cc.retailer.rate_limit_ms,
      async (): Promise<Fetched | FetchFailure> => {
        const res = await safeFetch(cc.ctx, request.url, { headers: request.headers, timeoutMs: cfg.timeout_ms });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          const status = res.status;
          if (status === 401 || status === 403) {
            return {
              ok: false,
              code: 'auth_failed',
              runLevel: true,
              message:
                cfg.auth.type === 'none'
                  ? `The source refused access (HTTP ${status}) and no authentication is configured for it.`
                  : `The source rejected the stored credential (HTTP ${status}). Check the credential and the authentication settings.`,
            };
          }
          if (status === 404 || status === 410) {
            return { ok: false, code: 'not_found', runLevel: cfg.mode === 'bulk', message: `The source returned HTTP ${status} (not found) for ${request.logUrl}` };
          }
          if (status === 429) {
            return { ok: false, code: 'rate_limited', runLevel: true, message: 'The source is rate limiting requests (HTTP 429). The run was stopped; increase the pause between requests or lower the frequency.' };
          }
          if (status >= 500) {
            return { ok: false, code: 'source_error', runLevel: cfg.mode === 'bulk', message: `The source reported a server error (HTTP ${status}).` };
          }
          return { ok: false, code: 'http_error', runLevel: cfg.mode === 'bulk', message: `The source answered with HTTP ${status}.` };
        }
        const body = await readBody(res, maxBytes);
        return { ok: true, body, fetchedAt: new Date().toISOString(), logUrl: request.logUrl, finalUrl: res.url || request.url };
      },
      cc.signal,
    );
  } catch (err) {
    if (err instanceof NetError) {
      const runLevel = cfg.mode === 'bulk' || err.code === 'blocked_host' || err.code === 'invalid_url';
      return { ok: false, code: err.code, message: err.message, runLevel };
    }
    if ((err as Error).message === 'aborted') return { ok: false, code: 'aborted', message: 'The run was stopped before this request was made.', runLevel: true };
    return { ok: false, code: 'network_error', message: `Request failed: ${(err as Error).message}`, runLevel: cfg.mode === 'bulk' };
  }
}

function parseBody(cfg: StructuredConfig, body: string): { ok: true; root: unknown } | { ok: false; message: string } {
  try {
    if (cfg.format === 'json') return { ok: true, root: JSON.parse(body.replace(/^﻿/, '')) };
    if (cfg.format === 'csv') return { ok: true, root: parseCsvRows(body) };
    return { ok: true, root: parseXml(body) };
  } catch (err) {
    return { ok: false, message: `The response is not valid ${cfg.format.toUpperCase()}: ${(err as Error).message.split('\n')[0]}` };
  }
}

function extractItems(cfg: StructuredConfig, root: unknown): { ok: true; items: unknown[] } | { ok: false; message: string } {
  if (cfg.format === 'csv') return { ok: true, items: root as unknown[] };
  const value = cfg.items_path ? getPath(root, cfg.items_path) : root;
  if (Array.isArray(value)) return { ok: true, items: value };
  if (value === undefined || value === null || value === '') {
    return cfg.items_path
      ? { ok: false, message: `Nothing was found at items_path "${cfg.items_path}" in the response.` }
      : { ok: false, message: 'The response is empty.' };
  }
  if (typeof value === 'object') {
    // A single item (XML feeds collapse one-element lists; some APIs return an object for one result).
    if (cfg.items_path) return { ok: true, items: [value] };
    return { ok: false, message: 'The response is an object, not a list of items. Set items_path to the list inside the response.' };
  }
  return { ok: false, message: 'The response does not contain a list of items.' };
}

interface ItemReading {
  draft?: ObservationDraft;
  problem?: { code: string; message: string };
}

/** Value at a mapped path. "sale_price || price" names alternatives: the first one that has a value is used. */
export function readField(item: unknown, path: string | null | undefined): unknown {
  if (!path) return undefined;
  if (!path.includes('||')) return getPath(item, path);
  for (const option of path.split('||')) {
    const value = getPath(item, option.trim());
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

const TAG_TEXT_LIMIT = 12;
/** A "regular price" above this multiple of the selling price is treated as misread and is not stored. */
export const IMPLAUSIBLE_REGULAR_FACTOR = 10;
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

/** The wording of every tag / badge an item carries, in the order of the mapping. Emoji and private-use glyphs are dropped. */
function readTagTexts(cfg: StructuredConfig, item: unknown): string[] {
  const out: string[] = [];
  const push = (value: unknown, depth = 0): void => {
    if (value === null || value === undefined || typeof value === 'boolean' || depth > 3 || out.length >= TAG_TEXT_LIMIT) return;
    if (Array.isArray(value)) {
      for (const entry of value) push(entry, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      const o = value as Record<string, unknown>;
      for (const key of ['text', 'label', 'title', 'name', 'value', '#text']) {
        if (o[key] !== undefined && o[key] !== null && typeof o[key] !== 'object') {
          push(o[key], depth + 1);
          return;
        }
      }
      return;
    }
    const text = String(value)
      .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{E000}-\u{F8FF}\u{FE0F}\u{200E}\u{200F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    if (text && !out.includes(text)) out.push(text);
  };
  for (const path of cfg.tags) push(readField(item, path));
  for (const [path, wording] of Object.entries(cfg.flag_tags)) {
    const value = readField(item, path);
    if (value === true || value === 1 || (typeof value === 'string' && /^(true|yes|y|1)$/i.test(value.trim()))) push(wording);
  }
  return out;
}

function readRating(value: unknown): number | null {
  const text = asText(value);
  const m = text === null ? null : /\d+(?:[.,]\d+)?/.exec(text);
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  // 0 is how sources say "not rated yet"
  return Number.isFinite(n) && n > 0 && n <= 5 ? Math.round(n * 100) / 100 : null;
}

function readCount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const text = asText(value);
  const m = text === null ? null : /^\(?\s*(\d[\d.,\s]*?)\s*([km])?\+?(?:\s|\)|$)/i.exec(text.trim());
  if (!m) return null;
  const digits = m[1]!.replace(/\s/g, '');
  const n = m[2]
    ? Number(digits.replace(',', '.')) * (m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000)
    : /^\d{1,3}(?:[.,]\d{3})+$/.test(digits)
      ? Number(digits.replace(/\D/g, ''))
      : /^\d+$/.test(digits)
        ? Number(digits)
        : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n) : null;
}

/** "3", "#3" or "#3 in Shampoos" → the position, and the full wording as the label when it says more than the number. */
function readRank(value: unknown): { rank: number | null; label: string | null } {
  if (typeof value === 'number') return { rank: Number.isInteger(value) && value > 0 ? value : null, label: null };
  const text = asText(value);
  const m = text === null ? null : /^(?:#|no\.?\s*|rank\s*#?)?\s*(\d{1,7})(?![\d.,])\s*(.*)$/i.exec(text.trim());
  if (!m) return { rank: null, label: null };
  const rank = Number(m[1]);
  return { rank: rank > 0 ? rank : null, label: m[2]!.trim() ? text!.trim().slice(0, 200) : null };
}

const RANK_WORDING = /^#\s*\d{1,7}\s+in\s+\S/i;

/** Turns one source item into an observation draft, or explains precisely why it cannot. */
function readItem(
  cfg: StructuredConfig,
  retailer: SourceRetailer,
  item: unknown,
  observedAt: string,
  fallbackUrl: string | null,
  currencies: ReadonlySet<string>,
): ItemReading {
  const priceOpts = { divisor: cfg.price_divisor, decimalSeparator: cfg.decimal_separator };
  const field = (path: string | null) => readField(item, path);

  // The currency comes from its own field when mapped, otherwise from a code written next to the price.
  const currency =
    asText(field(cfg.fields.currency))?.toUpperCase() ??
    currencyInText(asText(field(cfg.fields.current_price)), currencies) ??
    currencyInText(asText(field(cfg.fields.promo_price)), currencies);
  if (currency && /^[A-Z]{3}$/.test(currency) && currency !== retailer.currency_code) {
    return {
      problem: {
        code: 'currency_mismatch',
        message: `The source reports the price in ${currency} but this retailer is configured for ${retailer.currency_code}; the price was not stored.`,
      },
    };
  }

  const rawCurrent = field(cfg.fields.current_price);
  const current = parsePrice(rawCurrent, priceOpts);
  let regular = parsePrice(field(cfg.fields.regular_price), priceOpts);
  // A list price below the selling price is not a "was" price (search results sometimes carry a per-unit figure there).
  if (regular !== null && current !== null && regular < current * 0.999) regular = null;
  // …and one that is more than ten times the selling price is a misread figure (a lost decimal point), not a discount of 90 %+.
  let implausibleRegular: number | null = null;
  if (regular !== null && current !== null && regular > current * IMPLAUSIBLE_REGULAR_FACTOR) {
    implausibleRegular = regular;
    regular = null;
  }
  const promo = parsePrice(field(cfg.fields.promo_price), priceOpts);
  const availabilityMapped = !!cfg.fields.availability;
  const availability = availabilityMapped ? mapAvailability(field(cfg.fields.availability), cfg.availability_map) : 'unknown';

  if (current === null && regular === null && promo === null && availability !== 'out_of_stock') {
    const shown = asText(rawCurrent);
    return {
      problem: {
        code: 'no_price',
        message:
          rawCurrent === undefined
            ? `The item has no value at "${cfg.fields.current_price}".`
            : `No price could be read from "${cfg.fields.current_price}" (value: ${shown === null ? typeof rawCurrent : JSON.stringify(shown.slice(0, 60))}).`,
      },
    };
  }

  const url = asText(field(cfg.fields.url));

  // A provider snapshot is dated when the provider saw the price, so reading the same snapshot again adds nothing.
  const sourceTimestamp = parseSourceTimestamp(field(cfg.fields.source_timestamp));
  const datedBySource =
    cfg.observed_time === 'source' && sourceTimestamp !== null && Date.parse(sourceTimestamp) <= Date.parse(observedAt) + FUTURE_TOLERANCE_MS;

  // Tags and signals shown with the price. "#3 in Shampoos" among the badges is a sales rank, not a tag.
  let rank = readRank(field(cfg.fields.sales_rank));
  const tagTexts: string[] = [];
  for (const text of readTagTexts(cfg, item)) {
    if (RANK_WORDING.test(text)) {
      if (rank.rank === null || rank.label === null) rank = { rank: rank.rank ?? readRank(text).rank, label: text };
      continue;
    }
    if (isPriceCutWording(text)) continue; // "Save 30%" is a lower price, which the prices themselves already say
    tagTexts.push(text);
  }
  const rankLabel = asText(field(cfg.fields.sales_rank_label))?.slice(0, 200) ?? rank.label;

  // An offer that needs several units ("Buy 3 for 27") is a multi-buy promotion unless the shelf price itself was cut.
  const tags = normaliseDealTags(tagTexts);
  const shelfPriceCut = (regular !== null && current !== null && current < regular * 0.995) || (promo !== null && (current === null || promo < current));
  const promoType = tags.includes('multi_buy') && !shelfPriceCut ? ('multi_buy' as const) : undefined;

  const draft: ObservationDraft = {
    observed_at: datedBySource ? sourceTimestamp! : observedAt,
    observed_basis: 'exact',
    currency_code: retailer.currency_code,
    current_price: current,
    regular_price: regular,
    promo_price: promo,
    discount_pct: parsePercent(field(cfg.fields.discount_pct)),
    promo_type: promoType,
    promo_description: asText(field(cfg.fields.promo_description)),
    availability,
    product_url: url && /^https?:\/\//i.test(url) ? url : fallbackUrl,
    source_timestamp: sourceTimestamp,
    confidence: CONFIDENCE[retailer.collection_method] ?? 0.9,
    collection_status: current !== null && (!availabilityMapped || availability !== 'unknown') ? 'complete' : 'partial',
    tags,
    tag_text: tagTexts.length ? tagTexts.join(' · ').slice(0, 500) : null,
    rating: readRating(field(cfg.fields.rating)),
    review_count: readCount(field(cfg.fields.review_count)),
    sales_rank: rank.rank,
    sales_rank_label: rankLabel,
    seller_name: asText(field(cfg.fields.seller_name))?.slice(0, 200) ?? null,
    note:
      implausibleRegular === null
        ? undefined
        : `The source's list price (${implausibleRegular}) is more than ${IMPLAUSIBLE_REGULAR_FACTOR} times the selling price and was not stored as the regular price.`,
  };
  return { draft };
}

function listingKeyOf(listing: SourceListing, key: ListingKey): string | null {
  if (key === 'external_id') return normaliseExternalId(listing.external_id);
  if (key === 'url') return normaliseUrlKey(listing.url);
  return normaliseGtin(listing.gtin);
}

function itemKeyOf(value: unknown, key: ListingKey): string | null {
  if (key === 'external_id') return normaliseExternalId(value);
  if (key === 'url') return normaliseUrlKey(asText(value));
  return normaliseGtin(value);
}

const KEY_LABEL: Record<ListingKey, string> = { external_id: 'retailer item id', url: 'URL', gtin: 'barcode (GTIN)' };

async function collectBulk(cc: CollectContext, cfg: StructuredConfig): Promise<CollectResult> {
  const result = emptyResult();
  const evidenceKind = cc.retailer.collection_method === 'product_feed' ? 'feed_item' : 'api_response';
  const items: Array<{ item: unknown; evidence: number; observedAt: string }> = [];

  let nextUrl: string | null = cfg.url!;
  const seen = new Set<string>();
  let page = cfg.pagination.start;
  const maxPages = cfg.pagination.type === 'none' || cc.dryRun ? 1 : cfg.pagination.max_pages;
  let pagesFetched = 0;
  let lastPageHadItems = false;

  while (nextUrl && pagesFetched < maxPages) {
    if (cc.signal.aborted) break;
    let requestUrl = nextUrl;
    if (cfg.pagination.type === 'page') {
      const u = new URL(nextUrl);
      u.searchParams.set(cfg.pagination.param, String(page));
      requestUrl = u.toString();
    }
    if (seen.has(requestUrl)) break;
    seen.add(requestUrl);

    const fetched = await fetchSource(cc, cfg, requestUrl, 30 * 1024 * 1024);
    result.requests++;
    if (!fetched.ok) {
      result.fatal = { code: fetched.code, message: fetched.message };
      break;
    }
    const parsed = parseBody(cfg, fetched.body);
    if (!parsed.ok) {
      result.fatal = { code: 'parse_error', message: parsed.message };
      break;
    }
    const extracted = extractItems(cfg, parsed.root);
    if (!extracted.ok) {
      // An empty later page simply ends pagination; an unusable first page is a failure.
      if (pagesFetched > 0) break;
      result.fatal = { code: 'items_not_found', message: extracted.message };
      break;
    }
    pagesFetched++;
    lastPageHadItems = extracted.items.length > 0;
    if (extracted.items.length === 0) break;

    result.evidence.push({
      kind: evidenceKind,
      reference: fetched.logUrl,
      sha256: sha256Hex(fetched.body),
      size_bytes: Buffer.byteLength(fetched.body),
      captured_at: fetched.fetchedAt,
      note: `${cfg.format.toUpperCase()} response with ${extracted.items.length} item(s)${cfg.pagination.type !== 'none' ? ` (page ${pagesFetched})` : ''}`,
    });
    const evidenceIndex = result.evidence.length - 1;
    for (const item of extracted.items) items.push({ item, evidence: evidenceIndex, observedAt: fetched.fetchedAt });
    if (result.sample.length < 3) result.sample.push(...extracted.items.slice(0, 3 - result.sample.length).map((i) => truncateSample(i)));

    if (cfg.pagination.type === 'page') {
      page++;
    } else if (cfg.pagination.type === 'next_url') {
      const next = asText(getPath(parsed.root, cfg.pagination.path));
      try {
        nextUrl = next ? new URL(next, fetched.finalUrl).toString() : null;
      } catch {
        nextUrl = null;
      }
    } else {
      nextUrl = null;
    }
  }

  if (cc.dryRun && cfg.pagination.type !== 'none') {
    result.logs.push({ level: 'info', code: 'dry_run_first_page', message: 'Test run: only the first page of the source was requested.' });
  } else if (cfg.pagination.type !== 'none' && pagesFetched >= maxPages && lastPageHadItems && !result.fatal) {
    result.logs.push({
      level: 'warn',
      code: 'pagination_cap_reached',
      message: `Stopped after ${maxPages} pages (pagination.max_pages). Items on later pages were not read, so some listings may be reported as missing.`,
    });
  }

  result.itemsFound = items.length;
  if (result.fatal && items.length === 0) return result;

  // ---- match items to configured listings ---------------------------------------------------
  const key = cfg.match.listing_key;
  const byKey = new Map<string, SourceListing>();
  const unkeyed: SourceListing[] = [];
  for (const listing of cc.listings) {
    const k = listingKeyOf(listing, key);
    if (k) byKey.set(k, listing);
    else unkeyed.push(listing);
  }
  const matched = new Set<number>();
  let unmatchedItems = 0;
  let itemsWithoutKey = 0;
  let duplicateItems = 0;
  let knownButNotCollected = 0;
  const discoveredKeys = new Set<string>();

  for (const { item, evidence, observedAt } of items) {
    const itemKey = itemKeyOf(readField(item, cfg.match.field), key);
    if (!itemKey) {
      itemsWithoutKey++;
      continue;
    }
    const listing = byKey.get(itemKey);
    if (listing) {
      if (matched.has(listing.id)) {
        duplicateItems++;
        continue;
      }
      matched.add(listing.id);
      const reading = readItem(cfg, cc.retailer, item, observedAt, listing.url, cc.currencies);
      if (reading.draft) {
        result.outcomes.push({ listing_id: listing.id, status: 'ok', observation: reading.draft, evidence, strategy: evidenceKind === 'feed_item' ? 'feed' : 'api' });
      } else {
        result.outcomes.push({ listing_id: listing.id, status: 'failed', code: reading.problem!.code, message: reading.problem!.message });
      }
      continue;
    }

    // Not a configured listing.
    const externalId = key === 'external_id' ? asText(readField(item, cfg.match.field)) : asText(readField(item, cfg.fields.item_id));
    const urlValue = key === 'url' ? asText(readField(item, cfg.match.field)) : asText(readField(item, cfg.fields.url));
    const url = urlValue && /^https?:\/\//i.test(urlValue) ? urlValue : null;
    const gtinRaw = key === 'gtin' ? asText(readField(item, cfg.match.field)) : asText(readField(item, cfg.fields.gtin));
    const known =
      (externalId !== null && cc.known.externalIds.has(externalId.toLowerCase())) ||
      (url !== null && cc.known.urls.has(normaliseUrlKey(url)!)) ||
      (key === 'gtin' && cc.known.gtins.has(itemKey));
    if (known) {
      knownButNotCollected++;
      continue;
    }
    unmatchedItems++;
    if (!cfg.discover_listings || discoveredKeys.has(itemKey) || result.discovered.length >= cfg.discover_limit) continue;
    if (!externalId && !url) continue;
    discoveredKeys.add(itemKey);
    const reading = readItem(cfg, cc.retailer, item, observedAt, url, cc.currencies);
    result.discovered.push({
      external_id: externalId ? externalId.slice(0, 200) : null,
      url,
      title: asText(readField(item, cfg.fields.title))?.slice(0, 300) ?? null,
      gtin: gtinRaw ? gtinRaw.replace(/\D/g, '').slice(0, 20) || null : null,
      observation: reading.draft,
      evidence: reading.draft ? evidence : undefined,
    });
  }

  // Configured listings that the source did not return.
  if (!result.fatal) {
    for (const listing of cc.listings) {
      if (matched.has(listing.id)) continue;
      const hasKey = !unkeyed.includes(listing);
      result.outcomes.push({
        listing_id: listing.id,
        status: 'missing',
        code: hasKey ? 'listing_missing' : 'missing_identifier',
        message: hasKey
          ? `The source did not return an item whose ${KEY_LABEL[key]} matches this listing.`
          : `This listing has no ${KEY_LABEL[key]}, so it cannot be matched to items of the source.`,
      });
    }
  }

  if (itemsWithoutKey > 0) {
    result.logs.push({ level: 'warn', code: 'items_without_identifier', message: `${itemsWithoutKey} item(s) had no value at "${cfg.match.field}" and were skipped.` });
  }
  if (duplicateItems > 0) {
    result.logs.push({ level: 'warn', code: 'duplicate_items', message: `${duplicateItems} item(s) repeated a listing that had already been read in this run; the first occurrence was used.` });
  }
  if (knownButNotCollected > 0) {
    result.logs.push({ level: 'info', code: 'inactive_listings_skipped', message: `${knownButNotCollected} item(s) belong to listings that are inactive or ignored and were not collected.` });
  }
  if (unmatchedItems > 0) {
    const discoveredNote = cfg.discover_listings
      ? `${result.discovered.length} ${cc.dryRun ? 'would be' : 'will be'} added as unmatched listings for review${unmatchedItems > result.discovered.length ? ` (limit ${cfg.discover_limit} per run or no usable identifier)` : ''}.`
      : 'Enable listing discovery to add them as unmatched listings for review.';
    result.logs.push({ level: 'info', code: 'unmatched_items', message: `${unmatchedItems} item(s) of the source do not correspond to a configured listing. ${discoveredNote}` });
  }
  return result;
}

function expandTemplate(template: string, listing: SourceListing): { url?: string; missing?: string } {
  const values: Record<string, string | null> = {
    external_id: listing.external_id,
    url: listing.url,
    gtin: listing.gtin,
    sku: listing.sku,
    listing_code: listing.code,
  };
  let missing: string | undefined;
  const url = template.replace(/\{(external_id|url|gtin|sku|listing_code)\}/g, (_, name: string) => {
    const value = values[name];
    if (!value) {
      missing ??= name;
      return '';
    }
    return encodeURIComponent(value);
  });
  return missing ? { missing } : { url };
}

async function collectPerListing(cc: CollectContext, cfg: StructuredConfig): Promise<CollectResult> {
  const result = emptyResult();
  let consecutiveErrors = 0;
  for (const listing of cc.listings) {
    if (cc.signal.aborted) break;
    const expanded = expandTemplate(cfg.url_template!, listing);
    if (!expanded.url) {
      result.outcomes.push({
        listing_id: listing.id,
        status: 'failed',
        code: 'missing_identifier',
        message: `The request URL needs the listing's ${expanded.missing!.replace('_', ' ')}, which is not set.`,
      });
      continue;
    }
    const fetched = await fetchSource(cc, cfg, expanded.url, 5 * 1024 * 1024);
    result.requests++;
    if (!fetched.ok) {
      if (fetched.code === 'aborted') break;
      if (fetched.runLevel) {
        result.fatal = { code: fetched.code, message: fetched.message };
        break;
      }
      result.outcomes.push({ listing_id: listing.id, status: 'failed', code: fetched.code, message: fetched.message });
      consecutiveErrors = fetched.code === 'not_found' ? 0 : consecutiveErrors + 1;
      if (consecutiveErrors >= 5) {
        result.fatal = { code: 'source_unreachable', message: `Stopped after ${consecutiveErrors} consecutive failed requests. Last error: ${fetched.message}` };
        break;
      }
      continue;
    }
    consecutiveErrors = 0;
    const parsed = parseBody(cfg, fetched.body);
    if (!parsed.ok) {
      result.outcomes.push({ listing_id: listing.id, status: 'failed', code: 'parse_error', message: parsed.message });
      continue;
    }
    let item: unknown = cfg.format === 'csv' ? (parsed.root as unknown[])[0] : cfg.items_path ? getPath(parsed.root, cfg.items_path) : parsed.root;
    if (Array.isArray(item)) item = item[0];
    if (item === undefined || item === null || typeof item !== 'object') {
      result.outcomes.push({
        listing_id: listing.id,
        status: 'failed',
        code: 'item_not_found',
        message: cfg.items_path ? `The response contains no item at "${cfg.items_path}".` : 'The response contains no item.',
      });
      continue;
    }
    if (result.sample.length < 3) result.sample.push(truncateSample(item));
    const reading = readItem(cfg, cc.retailer, item, fetched.fetchedAt, listing.url, cc.currencies);
    if (!reading.draft) {
      result.outcomes.push({ listing_id: listing.id, status: 'failed', code: reading.problem!.code, message: reading.problem!.message });
      continue;
    }
    result.evidence.push({
      kind: 'api_response',
      reference: fetched.logUrl,
      sha256: sha256Hex(fetched.body),
      size_bytes: Buffer.byteLength(fetched.body),
      captured_at: fetched.fetchedAt,
      note: `${cfg.format.toUpperCase()} response for listing ${listing.code}`,
    });
    result.outcomes.push({ listing_id: listing.id, status: 'ok', observation: reading.draft, evidence: result.evidence.length - 1, strategy: 'api' });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Description (drives the configuration form and the "what is required" explanations)
// ---------------------------------------------------------------------------------------------

const CONFIG_FIELDS: ConnectorConfigField[] = [
  {
    key: 'mode', label: 'Request mode', type: 'select', group: 'Request', required: true, default: 'bulk',
    options: [
      { value: 'bulk', label: 'Bulk — one request returns many products' },
      { value: 'per_listing', label: 'Per listing — one request per product' },
    ],
  },
  {
    key: 'format', label: 'Response format', type: 'select', group: 'Request', required: true, default: 'json',
    options: [{ value: 'json', label: 'JSON' }, { value: 'csv', label: 'CSV' }, { value: 'xml', label: 'XML' }],
  },
  { key: 'url', label: 'Feed / API URL', type: 'url', group: 'Request', required: true, placeholder: 'https://api.retailer.example/v1/products', show_if: { key: 'mode', in: ['bulk'] } },
  {
    key: 'url_template', label: 'Request URL template', type: 'text', group: 'Request', required: true,
    placeholder: 'https://api.retailer.example/v1/products/{external_id}',
    help: 'Placeholders: {external_id}, {url}, {gtin}, {sku}, {listing_code}. Values are URL-encoded.',
    show_if: { key: 'mode', in: ['per_listing'] },
  },
  { key: 'items_path', label: 'Path to the items', type: 'text', group: 'Request', placeholder: 'data.items', help: 'Where the list of products sits inside the response (dot path). Leave empty when the response itself is the list. Not used for CSV.' },
  {
    key: 'auth.type', label: 'Authentication', type: 'select', group: 'Authentication', default: 'none',
    options: [
      { value: 'none', label: 'None' },
      { value: 'bearer', label: 'Bearer token (Authorization header)' },
      { value: 'header', label: 'API key in a custom header' },
      { value: 'query', label: 'API key in the URL' },
      { value: 'basic', label: 'HTTP basic (user name + password)' },
    ],
    help: 'The secret itself is stored encrypted under the source credential, never in this configuration.',
  },
  { key: 'auth.header_name', label: 'Header name', type: 'text', group: 'Authentication', placeholder: 'X-API-Key', show_if: { key: 'auth.type', in: ['header'] } },
  { key: 'auth.query_param', label: 'URL parameter name', type: 'text', group: 'Authentication', placeholder: 'api_key', show_if: { key: 'auth.type', in: ['query'] } },
  { key: 'auth.username', label: 'User name', type: 'text', group: 'Authentication', show_if: { key: 'auth.type', in: ['basic'] } },
  { key: 'headers', label: 'Additional request headers', type: 'key_value', group: 'Request', help: 'Static, non-secret headers such as Accept-Language.' },
  {
    key: 'match.listing_key', label: 'Match items to listings by', type: 'select', group: 'Matching', default: 'external_id',
    options: [{ value: 'external_id', label: 'Retailer item id' }, { value: 'url', label: 'Product URL' }, { value: 'gtin', label: 'Barcode (GTIN)' }],
    show_if: { key: 'mode', in: ['bulk'] },
  },
  { key: 'match.field', label: 'Item field holding that identifier', type: 'text', group: 'Matching', required: true, placeholder: 'sku', show_if: { key: 'mode', in: ['bulk'] } },
  {
    key: 'fields.current_price', label: 'Selling price field', type: 'text', group: 'Field mapping', required: true, placeholder: 'price.current',
    help: 'Any field can name alternatives: "sale_price || price" uses the first one that has a value.',
  },
  { key: 'fields.regular_price', label: 'Regular (list) price field', type: 'text', group: 'Field mapping', placeholder: 'price.was' },
  { key: 'fields.promo_price', label: 'Promotional price field', type: 'text', group: 'Field mapping' },
  { key: 'fields.discount_pct', label: 'Discount % field', type: 'text', group: 'Field mapping' },
  { key: 'fields.promo_description', label: 'Promotion description field', type: 'text', group: 'Field mapping' },
  { key: 'fields.availability', label: 'Availability field', type: 'text', group: 'Field mapping', placeholder: 'stock.status' },
  { key: 'fields.currency', label: 'Currency field', type: 'text', group: 'Field mapping', help: 'When mapped, a currency different from the retailer currency rejects the item.' },
  { key: 'fields.url', label: 'Product URL field', type: 'text', group: 'Field mapping' },
  { key: 'fields.title', label: 'Product title field', type: 'text', group: 'Field mapping', help: 'Used as the title of newly discovered listings.' },
  { key: 'fields.gtin', label: 'Barcode (GTIN) field', type: 'text', group: 'Field mapping' },
  { key: 'fields.item_id', label: 'Item id field', type: 'text', group: 'Field mapping' },
  { key: 'fields.source_timestamp', label: 'Item timestamp field', type: 'text', group: 'Field mapping', help: 'When the source itself saw or updated the price. Stored as the source timestamp; see "Observation time" for how observations are dated.' },
  {
    key: 'tags', label: 'Tag / badge fields', type: 'string_list', group: 'Tags and signals',
    help: 'Fields holding the deal tags or badges shown with the price, e.g. deal_tag.text or nudges. A field may hold one text, a list of texts or a list of objects with a text. Wording such as "#3 in Shampoos" is read as the sales rank; a plain "Save 30%" is a price cut, not a tag.',
  },
  {
    key: 'flag_tags', label: 'Yes/no fields that mean a badge', type: 'key_value', group: 'Tags and signals',
    help: 'Field name → the wording to record when the flag is set, e.g. is_bestseller → Best seller.',
  },
  { key: 'fields.rating', label: 'Rating field', type: 'text', group: 'Tags and signals', placeholder: 'rating.value', help: 'Average customer rating, 0–5.' },
  { key: 'fields.review_count', label: 'Number of reviews field', type: 'text', group: 'Tags and signals', placeholder: 'rating.count' },
  { key: 'fields.sales_rank', label: 'Sales rank field', type: 'text', group: 'Tags and signals', help: 'A position (3) or wording such as "#3 in Shampoos".' },
  { key: 'fields.sales_rank_label', label: 'Sales rank label field', type: 'text', group: 'Tags and signals' },
  { key: 'fields.seller_name', label: 'Seller field', type: 'text', group: 'Tags and signals', help: 'Who sells the item on the listing: the retailer itself or a marketplace seller.' },
  { key: 'availability_map.in_stock', label: 'Values meaning "in stock"', type: 'string_list', group: 'Value interpretation' },
  { key: 'availability_map.limited', label: 'Values meaning "limited stock"', type: 'string_list', group: 'Value interpretation' },
  { key: 'availability_map.out_of_stock', label: 'Values meaning "out of stock"', type: 'string_list', group: 'Value interpretation' },
  { key: 'price_divisor', label: 'Price divisor', type: 'number', group: 'Value interpretation', default: 1, help: 'Use 100 when prices are given in minor units (e.g. 1250 = 12.50).' },
  {
    key: 'decimal_separator', label: 'Decimal separator', type: 'select', group: 'Value interpretation', default: 'auto',
    options: [{ value: 'auto', label: 'Detect automatically' }, { value: '.', label: 'Point (12.50)' }, { value: ',', label: 'Comma (12,50)' }],
  },
  {
    key: 'observed_time', label: 'Observation time', type: 'select', group: 'Value interpretation', default: 'fetch',
    options: [
      { value: 'fetch', label: 'When this system reads the source' },
      { value: 'source', label: "The item's own timestamp (provider snapshots)" },
    ],
    help: "For snapshots delivered by a provider, use the item timestamp: each price is dated when the provider saw it, and reading the same snapshot twice adds nothing. Items without a usable timestamp are dated when they are read.",
  },
  {
    key: 'pagination.type', label: 'Pagination', type: 'select', group: 'Pagination', default: 'none',
    options: [{ value: 'none', label: 'Single response' }, { value: 'page', label: 'Page number parameter' }, { value: 'next_url', label: 'Link to the next page in the response' }],
    show_if: { key: 'mode', in: ['bulk'] },
  },
  { key: 'pagination.param', label: 'Page parameter', type: 'text', group: 'Pagination', default: 'page', show_if: { key: 'pagination.type', in: ['page'] } },
  { key: 'pagination.start', label: 'First page number', type: 'number', group: 'Pagination', default: 1, show_if: { key: 'pagination.type', in: ['page'] } },
  { key: 'pagination.path', label: 'Path of the next-page link', type: 'text', group: 'Pagination', placeholder: 'links.next', show_if: { key: 'pagination.type', in: ['next_url'] } },
  { key: 'pagination.max_pages', label: 'Maximum pages per run', type: 'number', group: 'Pagination', default: 20, show_if: { key: 'pagination.type', in: ['page', 'next_url'] } },
  { key: 'discover_listings', label: 'Add unknown items as unmatched listings', type: 'boolean', group: 'Listing discovery', default: false, help: 'New items are never matched automatically — they wait for review in Product Catalogue → Matching.', show_if: { key: 'mode', in: ['bulk'] } },
  { key: 'discover_limit', label: 'Maximum new listings per run', type: 'number', group: 'Listing discovery', default: 200, show_if: { key: 'discover_listings', in: [true] } },
  { key: 'timeout_ms', label: 'Request timeout (ms)', type: 'number', group: 'Request', default: 30000 },
];

const EXAMPLES: Record<'official_api' | 'product_feed' | 'third_party', ConnectorExample[]> = {
  official_api: [
    {
      title: 'Retailer product API (one request per product, bearer token)',
      description: 'Each listing is requested by the retailer item id. The token is stored under the source credential.',
      config: {
        mode: 'per_listing',
        format: 'json',
        url_template: 'https://api.retailer.example/v2/products/{external_id}',
        auth: { type: 'bearer' },
        items_path: 'data',
        fields: { current_price: 'pricing.current', regular_price: 'pricing.list', availability: 'stock.status', currency: 'pricing.currency', url: 'links.web', source_timestamp: 'updated_at' },
      },
    },
    {
      title: 'Retailer catalogue API (paged, API key header)',
      description: 'A paged list endpoint; items are matched to listings by SKU.',
      config: {
        mode: 'bulk',
        format: 'json',
        url: 'https://api.retailer.example/v2/products?page_size=200',
        auth: { type: 'header', header_name: 'X-API-Key' },
        items_path: 'items',
        match: { listing_key: 'external_id', field: 'sku' },
        fields: { current_price: 'price', regular_price: 'list_price', availability: 'in_stock', title: 'name', url: 'url' },
        pagination: { type: 'page', param: 'page', start: 1, max_pages: 50 },
      },
    },
  ],
  product_feed: [
    {
      title: 'Google Merchant style XML feed',
      description: 'Standard shopping feed. Sale price becomes the promotional price.',
      config: {
        mode: 'bulk',
        format: 'xml',
        url: 'https://www.retailer.example/feeds/products.xml',
        items_path: 'rss.channel.item',
        match: { listing_key: 'external_id', field: 'g:id' },
        fields: { current_price: 'g:price', promo_price: 'g:sale_price', availability: 'g:availability', gtin: 'g:gtin', title: 'title', url: 'link' },
        discover_listings: true,
      },
    },
    {
      title: 'CSV price file published by a retailer',
      description: 'Columns are addressed by their header names; the delimiter is detected automatically.',
      config: {
        mode: 'bulk',
        format: 'csv',
        url: 'https://partners.retailer.example/exports/prices.csv',
        match: { listing_key: 'gtin', field: 'barcode' },
        fields: { current_price: 'selling_price', regular_price: 'regular_price', availability: 'stock', title: 'description' },
        decimal_separator: 'auto',
      },
    },
  ],
  third_party: [
    {
      title: 'Apify — items of the last successful run of an actor',
      description:
        'Reads the dataset of the most recent successful run of an actor you schedule in your own Apify account. This is only a template: it stays "not configured" until you store your own Apify API token as the source credential, replace <ACTOR_ID>, and map the fields to what your actor actually outputs.',
      config: {
        mode: 'bulk',
        format: 'json',
        url: 'https://api.apify.com/v2/acts/<ACTOR_ID>/runs/last/dataset/items?status=SUCCEEDED&clean=true&format=json',
        auth: { type: 'bearer' },
        items_path: '',
        match: { listing_key: 'url', field: 'url' },
        fields: { current_price: 'price', regular_price: 'listPrice', availability: 'inStock', title: 'title', url: 'url' },
      },
      notes: [
        'Field names differ per actor — check the actor\'s output and adjust the mapping.',
        'You are responsible for using a provider and actor that collect data in a way the retailer permits.',
      ],
    },
    {
      title: 'Apify — last run of a scheduled task, with deal tags, ratings and seller',
      description:
        'For actors that output marketplace listings with badges. Create a task for the actor in your own Apify account (its input decides the country and brands), schedule it there, then store your Apify API token as the source credential and replace <TASK_ID>. Field names differ per actor: adjust the mapping to the output you see in Apify.',
      config: {
        mode: 'bulk',
        format: 'json',
        url: 'https://api.apify.com/v2/actor-tasks/<TASK_ID>/runs/last/dataset/items?status=SUCCEEDED&clean=true&format=json',
        auth: { type: 'bearer' },
        items_path: '',
        match: { listing_key: 'external_id', field: 'sku' },
        fields: {
          current_price: 'sale_price || price', regular_price: 'price', availability: 'is_buyable', currency: 'currency', title: 'name', url: 'productUrl', item_id: 'sku',
          source_timestamp: '_scrapedAt', rating: 'product_rating.value', review_count: 'product_rating.count', sales_rank: 'best_seller_rank', seller_name: 'store_name',
        },
        tags: ['deal_tag.text', 'nudges'],
        flag_tags: { is_bestseller: 'Best seller' },
        observed_time: 'source',
        discover_listings: true,
      },
      notes: [
        'Observations are dated by the provider\'s own timestamp, so a snapshot that has not changed adds nothing.',
        'New items arrive as unmatched listings for review; nothing is matched automatically.',
        'You are responsible for using a provider and actor that collect data in a way the retailer permits.',
      ],
    },
    {
      title: 'Any data provider with a JSON delivery endpoint',
      description: 'Providers that deliver snapshots over HTTPS (dataset or delivery API) work the same way: URL, credential, field mapping.',
      config: {
        mode: 'bulk',
        format: 'json',
        url: 'https://api.provider.example/datasets/<DATASET_ID>/latest',
        auth: { type: 'header', header_name: 'X-API-Key' },
        items_path: 'records',
        match: { listing_key: 'gtin', field: 'ean' },
        fields: { current_price: 'final_price', regular_price: 'initial_price', availability: 'availability', url: 'product_url', currency: 'currency' },
      },
    },
  ],
};

const DESCRIPTIONS: Record<'official_api' | 'product_feed' | 'third_party', Pick<ConnectorDescription, 'summary' | 'description' | 'requirements' | 'credential'>> = {
  official_api: {
    summary: 'Prices from an API the retailer provides to partners.',
    description:
      'Calls a retailer\'s documented API with the credential the retailer issued to you and maps its response to price observations. Works with JSON, XML or CSV responses, in bulk or one request per product.',
    requirements: [
      'API access granted by the retailer (endpoint URL and documentation)',
      'The API credential, stored encrypted as the source credential',
      'A field mapping from the API response to price, availability and identifiers',
      'Listings with the retailer item id (or URL / barcode) the API uses',
    ],
    credential: { needed: 'depends', label: 'API key or token', help: 'Required unless the API is public. Stored encrypted; never shown again.' },
  },
  product_feed: {
    summary: 'Prices from a product feed file (JSON, CSV or XML).',
    description:
      'Downloads a feed the retailer publishes for partners or shopping channels and reads price and availability for every configured listing. Items that are not yet listings can be added as unmatched listings for review.',
    requirements: [
      'The feed URL, with the retailer\'s permission to use it',
      'A field mapping (price, identifier and, ideally, availability)',
      'Listings carrying the identifier used in the feed',
    ],
    credential: { needed: 'depends', label: 'Feed credential', help: 'Only when the feed is protected by a token or password.' },
  },
  third_party: {
    summary: 'Prices delivered by a data provider you have a contract with.',
    description:
      'Pulls the latest dataset from a third-party data provider\'s delivery endpoint using your own account credential. The provider does the collection; this system stores what it delivers, labelled as third-party data.',
    requirements: [
      'An account with the data provider and a dataset / actor that outputs product prices',
      'Your provider API token, stored encrypted as the source credential',
      'A field mapping matching the provider\'s output',
      'Confirmation that the provider collects the data in a way the retailer permits',
    ],
    credential: { needed: 'always', label: 'Provider API token', help: 'Your own token from the provider. Stored encrypted; never shown again.' },
  },
};

export const structuredConnector: Connector = {
  methods: ['official_api', 'product_feed', 'third_party'],
  runnable: true,
  dataClass: 'real',

  describe(method: CollectionMethod): ConnectorDescription {
    const key = method as 'official_api' | 'product_feed' | 'third_party';
    const base = DESCRIPTIONS[key];
    return {
      method,
      label: method === 'official_api' ? 'Official API' : method === 'product_feed' ? 'Product feed' : 'Third-party data integration',
      ...base,
      runnable: true,
      kind: 'real',
      limitations: [
        'Reads what the endpoint returns; it cannot work around access restrictions.',
        'Pagination by page number or next-page link only.',
      ],
      needs_permission_attestation: false,
      supports_discovery: true,
      config_fields: CONFIG_FIELDS,
      examples: EXAMPLES[key],
    };
  },

  checkConfig(_ctx: AppContext, retailer: SourceRetailer, raw: Record<string, unknown>, credentialPresent: boolean): ConfigCheck {
    const { config, problems, warnings } = readStructuredConfig(raw);
    const missing = [...problems];
    if (config.auth.type !== 'none' && !credentialPresent) {
      missing.push('The API credential is not stored for this source (add it as the source credential)');
    }
    if (retailer.collection_method === 'third_party' && config.auth.type === 'none') {
      missing.push('Authentication for the data provider (auth.type) — provider endpoints require your account token');
    }
    if (config.url && /<[A-Z_]+>/.test(config.url)) missing.push('Replace the placeholder in the URL (e.g. <ACTOR_ID>) with your own value');
    return { ok: missing.length === 0, missing, warnings };
  },

  canRunWithoutListings(raw: Record<string, unknown>): boolean {
    const { config } = readStructuredConfig(raw);
    return config.mode === 'bulk' && config.discover_listings;
  },

  requestsPerListing(raw: Record<string, unknown>): boolean {
    return readStructuredConfig(raw).config.mode === 'per_listing';
  },

  async collect(cc: CollectContext): Promise<CollectResult> {
    const { config, problems } = readStructuredConfig(cc.config);
    if (problems.length) {
      const result = emptyResult();
      result.fatal = { code: 'config_invalid', message: `Configuration incomplete: ${problems.join('; ')}` };
      return result;
    }
    return config.mode === 'bulk' ? collectBulk(cc, config) : collectPerListing(cc, config);
  },
};
