/**
 * Permitted website extraction.
 *
 * Reads the price a retailer publishes on its own product page — and only where that is permitted:
 *   * the source must carry an explicit permission attestation (who confirmed that the site's terms allow it)
 *   * robots.txt is obeyed for every URL; if robots.txt cannot be read the site is treated as off-limits
 *   * one request at a time per host, with the configured pause (or the site's Crawl-delay if longer)
 *   * the request identifies this system honestly through the configured User-Agent
 *
 * Pages are fetched as plain HTML. No JavaScript is executed, no login is performed and nothing is done
 * to get around access controls: a refusal, a captcha or a page without a readable price is reported as
 * a failure with the real reason.
 */
import * as cheerio from 'cheerio';
import robotsParserModule from 'robots-parser';
import type { AppContext } from '../../context.ts';
import type { Availability, CollectionMethod } from '../../../shared/constants.ts';
import type { ConnectorConfigField, ConnectorDescription, SiteCheckResult } from '../../../shared/api/collection.ts';
import { sha256Hex } from '../../lib/crypto.ts';
import { NetError, readBody, safeFetch } from '../../lib/net.ts';
import {
  emptyResult,
  type CollectContext,
  type CollectResult,
  type ConfigCheck,
  type Connector,
  type ListingOutcome,
  type ObservationDraft,
  type SourceListing,
  type SourceRetailer,
} from './types.ts';
import { asText, currencyInText, excerptOf, hostThrottled, mapAvailability, normaliseGtin, normaliseUrlKey, parsePrice, type DecimalSeparator } from './util.ts';

interface RobotsRules {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  isDisallowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
}
// robots-parser is a CommonJS module whose export *is* the parser function; its bundled typings describe
// it as a default export, which does not line up under Node's ESM resolution — hence the cast.
const robotsParser = robotsParserModule as unknown as (url: string, contents: string) => RobotsRules;

type Strategy = 'json_ld' | 'meta' | 'selector' | 'regex';
const ALL_STRATEGIES: Strategy[] = ['json_ld', 'meta', 'selector', 'regex'];
const CONFIDENCE: Record<Strategy, number> = { json_ld: 0.92, meta: 0.85, selector: 0.8, regex: 0.65 };
const STRATEGY_LABEL: Record<Strategy, string> = {
  json_ld: 'schema.org structured data (JSON-LD)',
  meta: 'price meta tags / microdata',
  selector: 'configured CSS selector',
  regex: 'configured regular expression',
};

export interface WebConfig {
  strategies: Strategy[];
  price_selector: string | null;
  price_attribute: string | null;
  regular_price_selector: string | null;
  regular_price_attribute: string | null;
  availability_selector: string | null;
  availability_attribute: string | null;
  price_regex: string | null;
  regular_price_regex: string | null;
  out_of_stock_regex: string | null;
  decimal_separator: DecimalSeparator;
  timeout_ms: number;
}

const str = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
};

export function readWebConfig(raw: Record<string, unknown>): { config: WebConfig; problems: string[] } {
  const problems: string[] = [];
  const requested = Array.isArray(raw.strategies) ? raw.strategies.map((s) => String(s)) : null;
  const strategies = requested ? ALL_STRATEGIES.filter((s) => requested.includes(s)) : ALL_STRATEGIES;
  if (requested && strategies.length === 0) problems.push('At least one extraction strategy must be enabled (strategies)');
  const timeout = Math.floor(Number(raw.timeout_ms));
  const sep = str(raw.decimal_separator);
  const config: WebConfig = {
    strategies,
    price_selector: str(raw.price_selector),
    price_attribute: str(raw.price_attribute),
    regular_price_selector: str(raw.regular_price_selector),
    regular_price_attribute: str(raw.regular_price_attribute),
    availability_selector: str(raw.availability_selector),
    availability_attribute: str(raw.availability_attribute),
    price_regex: str(raw.price_regex),
    regular_price_regex: str(raw.regular_price_regex),
    out_of_stock_regex: str(raw.out_of_stock_regex),
    decimal_separator: sep === ',' || sep === '.' ? sep : 'auto',
    timeout_ms: Number.isFinite(timeout) ? Math.min(60_000, Math.max(2_000, timeout)) : 20_000,
  };
  for (const key of ['price_regex', 'regular_price_regex', 'out_of_stock_regex'] as const) {
    const pattern = config[key];
    if (!pattern) continue;
    if (pattern.length > 500) problems.push(`${key} is too long (maximum 500 characters)`);
    try {
      new RegExp(pattern, 'i');
    } catch (err) {
      problems.push(`${key} is not a valid regular expression: ${(err as Error).message}`);
    }
  }
  return { config, problems };
}

// ---------------------------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------------------------

interface RobotsEntry {
  expires: number;
  /** null → no robots.txt (everything allowed). */
  rules: RobotsRules | null;
  /** Set when robots.txt could not be read: the whole site is treated as disallowed for now. */
  blocked: string | null;
  crawlDelayMs: number;
}

const robotsCache = new Map<string, RobotsEntry>();
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const ROBOTS_ERROR_TTL_MS = 5 * 60 * 1000;
const MAX_CRAWL_DELAY_MS = 60_000;

/** Test hook: forget cached robots.txt files. */
export function clearRobotsCache(): void {
  robotsCache.clear();
}

async function loadRobots(ctx: AppContext, origin: string, userAgent: string, delayMs: number, signal: AbortSignal): Promise<RobotsEntry> {
  const cacheKey = `${origin}|${userAgent}`;
  const cached = robotsCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached;
  const robotsUrl = `${origin}/robots.txt`;
  let entry: RobotsEntry;
  try {
    const res = await hostThrottled(new URL(origin).host, delayMs, () => safeFetch(ctx, robotsUrl, { timeoutMs: 15_000, headers: { accept: 'text/plain, */*' } }), signal);
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => undefined);
      entry = { expires: Date.now() + ROBOTS_TTL_MS, rules: null, blocked: null, crawlDelayMs: 0 };
    } else if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      entry = {
        expires: Date.now() + ROBOTS_ERROR_TTL_MS,
        rules: null,
        blocked: `robots.txt could not be read (HTTP ${res.status}), so the site is treated as not permitting automated access`,
        crawlDelayMs: 0,
      };
    } else {
      const text = await readBody(res, 512 * 1024);
      const rules = robotsParser(robotsUrl, text);
      const delay = Number(rules.getCrawlDelay(userAgent) ?? 0);
      entry = {
        expires: Date.now() + ROBOTS_TTL_MS,
        rules,
        blocked: null,
        crawlDelayMs: Number.isFinite(delay) && delay > 0 ? Math.min(MAX_CRAWL_DELAY_MS, Math.round(delay * 1000)) : 0,
      };
    }
  } catch (err) {
    if ((err as Error).message === 'aborted') throw err;
    const reason = err instanceof NetError ? err.message : (err as Error).message;
    entry = {
      expires: Date.now() + ROBOTS_ERROR_TTL_MS,
      rules: null,
      blocked: `robots.txt could not be read (${reason}), so the site is treated as not permitting automated access`,
      crawlDelayMs: 0,
    };
  }
  robotsCache.set(cacheKey, entry);
  return entry;
}

// ---------------------------------------------------------------------------------------------
// Extraction strategies
// ---------------------------------------------------------------------------------------------

interface Extraction {
  strategy: Strategy;
  current: number | null;
  regular: number | null;
  currency: string | null;
  availability: Availability;
  excerpt: string;
}

type Dom = ReturnType<typeof cheerio.load>;

function jsonLdBlocks($: Dom): unknown[] {
  const blocks: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = ($(el).text() || $(el).html() || '')
      .replace(/^\s*<!--/, '')
      .replace(/-->\s*$/, '')
      .replace(/^\s*\/\/\s*<!\[CDATA\[/, '')
      .replace(/\/\/\s*\]\]>\s*$/, '')
      .trim();
    if (!raw) return;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      try {
        blocks.push(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1')));
      } catch {
        /* malformed structured data is ignored; other strategies may still work */
      }
    }
  });
  return blocks;
}

interface ProductNode {
  node: Record<string, unknown>;
  variant: boolean;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === 'string') as string[];
}

function findProducts(value: unknown, out: ProductNode[], variant = false, depth = 0): void {
  if (value === null || value === undefined || depth > 6) return;
  if (Array.isArray(value)) {
    for (const v of value) findProducts(v, out, variant, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  const types = typesOf(node);
  const isGroup = types.some((t) => /(^|[/#:])ProductGroup$/i.test(t));
  if (types.some((t) => /(^|[/#:])(Product|IndividualProduct|ProductModel)$/i.test(t))) out.push({ node, variant });
  // Deliberately not descending into ItemList / related products: those are other products.
  for (const key of ['@graph', 'mainEntity']) findProducts(node[key], out, variant, depth + 1);
  if (isGroup) findProducts(node.hasVariant, out, true, depth + 1);
}

interface OfferReading {
  current: number | null;
  regular: number | null;
  currency: string | null;
  availability: Availability;
  source: unknown;
}

function readOffer(offer: unknown, depth = 0): OfferReading | null {
  if (offer === null || typeof offer !== 'object' || Array.isArray(offer) || depth > 3) return null;
  const o = offer as Record<string, unknown>;
  let current = parsePrice(o.price);
  let regular: number | null = null;
  let currency = asText(o.priceCurrency);
  const specs = Array.isArray(o.priceSpecification) ? o.priceSpecification : o.priceSpecification ? [o.priceSpecification] : [];
  for (const spec of specs) {
    if (spec === null || typeof spec !== 'object') continue;
    const s = spec as Record<string, unknown>;
    const price = parsePrice(s.price);
    if (price === null) continue;
    const type = asText(s.priceType) ?? '';
    if (/ListPrice|StrikethroughPrice|MSRP|SRP|RegularPrice/i.test(type)) regular = price;
    else if (current === null || /SalePrice/i.test(type)) current = price;
    currency ??= asText(s.priceCurrency);
  }
  if (current === null) current = parsePrice(o.lowPrice); // AggregateOffer
  if (current === null && o.offers) {
    for (const nested of Array.isArray(o.offers) ? o.offers : [o.offers]) {
      const reading = readOffer(nested, depth + 1);
      if (reading) return { ...reading, currency: reading.currency ?? currency };
    }
  }
  const availability = o.availability === undefined ? 'unknown' : mapAvailability(o.availability);
  if (current === null && availability !== 'out_of_stock') return null;
  return { current, regular, currency, availability, source: offer };
}

function readProductOffers(product: Record<string, unknown>): OfferReading | null {
  const offers = product.offers;
  if (!offers) return null;
  for (const offer of Array.isArray(offers) ? offers : [offers]) {
    const reading = readOffer(offer);
    if (reading) return reading;
  }
  return null;
}

function productMatchesListing(product: Record<string, unknown>, listing: SourceListing): boolean {
  const offers = product.offers;
  const firstOffer = (Array.isArray(offers) ? offers[0] : offers) as Record<string, unknown> | undefined;
  const ids = [product.sku, product.productID, product.mpn, firstOffer?.sku].map((v) => asText(v)?.toLowerCase()).filter(Boolean);
  if (listing.external_id && ids.includes(listing.external_id.trim().toLowerCase())) return true;
  const listingGtin = normaliseGtin(listing.gtin);
  if (listingGtin) {
    for (const key of ['gtin', 'gtin13', 'gtin12', 'gtin14', 'gtin8']) {
      if (normaliseGtin(product[key]) === listingGtin || normaliseGtin(firstOffer?.[key]) === listingGtin) return true;
    }
  }
  const listingUrl = normaliseUrlKey(listing.url);
  if (listingUrl) {
    for (const candidate of [product.url, product['@id'], firstOffer?.url]) {
      const text = asText(candidate);
      if (text && /^https?:/i.test(text) && normaliseUrlKey(text) === listingUrl) return true;
    }
  }
  return false;
}

function extractJsonLd($: Dom, listing: SourceListing): Extraction | null {
  const products: ProductNode[] = [];
  for (const block of jsonLdBlocks($)) findProducts(block, products);
  const priced = products
    .map((p) => ({ ...p, reading: readProductOffers(p.node) }))
    .filter((p): p is ProductNode & { reading: OfferReading } => p.reading !== null);
  if (priced.length === 0) return null;
  let chosen = priced.find((p) => productMatchesListing(p.node, listing));
  if (!chosen) {
    const mains = priced.filter((p) => !p.variant);
    if (mains.length > 0) {
      chosen = mains[0];
    } else {
      // Only variants (sizes) are described and none could be tied to this listing: use the price only
      // when every variant has the same one, otherwise it would be a guess between pack sizes.
      const prices = new Set(priced.map((p) => p.reading.current));
      if (prices.size === 1) chosen = priced[0];
    }
  }
  if (!chosen) return null;
  const { reading } = chosen;
  return {
    strategy: 'json_ld',
    current: reading.current,
    regular: reading.regular,
    currency: reading.currency ? reading.currency.toUpperCase() : null,
    availability: reading.availability,
    excerpt: excerptOf(JSON.stringify(reading.source)),
  };
}

function extractMeta($: Dom, config: WebConfig): Extraction | null {
  const opts = { decimalSeparator: config.decimal_separator };
  const meta = (name: string): { value: string; html: string } | null => {
    const el = $(`meta[property="${name}"], meta[name="${name}"]`).first();
    const value = el.attr('content')?.trim();
    return value ? { value, html: $.html(el) } : null;
  };
  const itemprop = (name: string): { value: string; html: string } | null => {
    const el = $(`[itemprop="${name}"]`).first();
    if (!el.length) return null;
    const value = (el.attr('content') ?? el.attr('href') ?? el.text()).trim();
    return value ? { value, html: $.html(el) } : null;
  };
  const amount = meta('product:price:amount') ?? meta('og:price:amount') ?? itemprop('price');
  const sale = meta('product:sale_price:amount') ?? meta('og:sale_price:amount');
  const availabilityRaw = meta('product:availability') ?? meta('og:availability') ?? itemprop('availability');
  const availability = availabilityRaw ? mapAvailability(availabilityRaw.value) : 'unknown';
  let current = amount ? parsePrice(amount.value, opts) : null;
  let regular: number | null = null;
  const salePrice = sale ? parsePrice(sale.value, opts) : null;
  if (salePrice !== null && (current === null || salePrice < current)) {
    regular = current;
    current = salePrice;
  }
  if (current === null && availability !== 'out_of_stock') return null;
  const currency = (meta('product:price:currency') ?? meta('og:price:currency') ?? itemprop('priceCurrency'))?.value ?? null;
  return {
    strategy: 'meta',
    current,
    regular,
    currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null,
    availability,
    excerpt: excerptOf([sale?.html, amount?.html, availabilityRaw?.html].filter(Boolean).join(' ')),
  };
}

function extractSelector($: Dom, config: WebConfig, currencies: ReadonlySet<string>): Extraction | null {
  if (!config.price_selector) return null;
  const opts = { decimalSeparator: config.decimal_separator };
  const read = (selector: string | null, attribute: string | null): { value: string; html: string } | null => {
    if (!selector) return null;
    let el;
    try {
      el = $(selector).first();
    } catch {
      return null;
    }
    if (!el.length) return null;
    const value = (attribute ? (el.attr(attribute) ?? '') : el.text()).trim();
    return value ? { value, html: $.html(el) } : null;
  };
  const price = read(config.price_selector, config.price_attribute);
  const regularRaw = read(config.regular_price_selector, config.regular_price_attribute);
  const availabilityRaw = read(config.availability_selector, config.availability_attribute);
  const availability = availabilityRaw ? mapAvailability(availabilityRaw.value) : 'unknown';
  const current = price ? parsePrice(price.value, opts) : null;
  if (current === null && availability !== 'out_of_stock') return null;
  return {
    strategy: 'selector',
    current,
    regular: regularRaw ? parsePrice(regularRaw.value, opts) : null,
    currency: price ? currencyInText(price.value, currencies) : null,
    availability,
    excerpt: excerptOf([price?.html, regularRaw?.html, availabilityRaw?.html].filter(Boolean).join(' ')),
  };
}

function extractRegex(html: string, config: WebConfig, currencies: ReadonlySet<string>): Extraction | null {
  if (!config.price_regex) return null;
  const opts = { decimalSeparator: config.decimal_separator };
  const run = (pattern: string | null): { value: string; match: string } | null => {
    if (!pattern) return null;
    try {
      const m = new RegExp(pattern, 'i').exec(html);
      return m ? { value: m[1] ?? m[0], match: m[0] } : null;
    } catch {
      return null;
    }
  };
  const price = run(config.price_regex);
  const regular = run(config.regular_price_regex);
  const outOfStock = run(config.out_of_stock_regex);
  const current = price ? parsePrice(price.value, opts) : null;
  if (current === null && !outOfStock) return null;
  return {
    strategy: 'regex',
    current,
    regular: regular ? parsePrice(regular.value, opts) : null,
    currency: price ? currencyInText(price.match, currencies) : null,
    availability: outOfStock ? 'out_of_stock' : 'unknown',
    excerpt: excerptOf([price?.match, regular?.match, outOfStock?.match].filter(Boolean).join(' … ')),
  };
}

const CHALLENGE_PATTERN =
  /captcha|are you a (human|robot)|verify (that )?you('| a)re (a )?human|unusual traffic|access denied|request (was )?blocked|cf-challenge|challenge-platform|px-captcha|robot check|pardon our interruption|bot detection|enable javascript and cookies to continue|attention required/i;

/** Extracts price data from a fetched page, or explains why it could not. Pure (no network). */
export function extractFromHtml(
  html: string,
  listing: SourceListing,
  retailer: Pick<SourceRetailer, 'currency_code'>,
  config: WebConfig,
  currencies: ReadonlySet<string> = new Set(),
  /** `anyCurrency`: do not require the page's currency to be the retailer's (used when no retailer exists yet). */
  options: { anyCurrency?: boolean } = {},
): { extraction: Extraction } | { failure: { code: string; message: string } } {
  let $: Dom;
  try {
    $ = cheerio.load(html);
  } catch (err) {
    return { failure: { code: 'parse_error', message: `The page could not be parsed as HTML: ${(err as Error).message}` } };
  }
  let primary: Extraction | null = null;
  const others: Extraction[] = [];
  for (const strategy of config.strategies) {
    let found: Extraction | null = null;
    if (strategy === 'json_ld') found = extractJsonLd($, listing);
    else if (strategy === 'meta') found = extractMeta($, config);
    else if (strategy === 'selector') found = extractSelector($, config, currencies);
    else found = extractRegex(html, config, currencies);
    if (!found) continue;
    if (!options.anyCurrency && found.currency && found.currency !== retailer.currency_code) {
      return {
        failure: {
          code: 'currency_mismatch',
          message: `The page states its price in ${found.currency} but this retailer is configured for ${retailer.currency_code}; the price was not stored.`,
        },
      };
    }
    if (!primary) primary = found;
    else others.push(found);
  }
  if (!primary) {
    const title = $('title').first().text();
    const visible = $('body').text().replace(/\s+/g, ' ').trim();
    if (CHALLENGE_PATTERN.test(title) || (visible.length < 1500 && CHALLENGE_PATTERN.test(visible))) {
      return {
        failure: {
          code: 'bot_challenge',
          message: 'The site returned a verification / access-check page instead of the product page. This system does not attempt to pass such checks.',
        },
      };
    }
    const scripted = visible.length < 400 && $('script').length > 3;
    const tried = config.strategies.map((s) => STRATEGY_LABEL[s]).join(', ');
    return {
      failure: {
        code: 'no_price_found',
        message: scripted
          ? `No price could be read from the page. It appears to be rendered by JavaScript, which this connector does not execute. (Tried: ${tried}.)`
          : `No price could be read from the page. (Tried: ${tried}.) Configure a CSS selector or regular expression for this site, or use an official API / feed.`,
      },
    };
  }
  // Fill gaps (availability, regular price) from the other strategies; the price itself is never mixed.
  for (const other of others) {
    if (primary.availability === 'unknown' && other.availability !== 'unknown') primary.availability = other.availability;
    if (primary.regular === null && other.regular !== null && primary.current !== null && other.current === primary.current) primary.regular = other.regular;
  }
  if (primary.regular !== null && primary.current !== null && primary.regular < primary.current) primary.regular = null;
  return { extraction: primary };
}

// ---------------------------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------------------------

function failure(listing: SourceListing, code: string, message: string): ListingOutcome {
  return { listing_id: listing.id, status: 'failed', code, message };
}

/** A redirect may land on another host; that host's robots.txt applies to what was returned. */
async function redirectedToDisallowed(cc: CollectContext, requested: URL, finalUrl: string, userAgent: string): Promise<boolean> {
  let final: URL;
  try {
    final = new URL(finalUrl);
  } catch {
    return false;
  }
  if (final.origin === requested.origin) return false;
  const robots = await loadRobots(cc.ctx, final.origin, userAgent, cc.retailer.rate_limit_ms, cc.signal);
  return !!robots.blocked || (robots.rules !== null && robots.rules.isDisallowed(final.toString(), userAgent) === true);
}

async function collectWeb(cc: CollectContext): Promise<CollectResult> {
  const result = emptyResult();
  const { config } = readWebConfig(cc.config);
  const userAgent = cc.ctx.config.userAgent;
  let consecutiveErrors = 0;
  const warnedCrawlDelay = new Set<string>();

  for (const listing of cc.listings) {
    if (cc.signal.aborted) break;
    if (!listing.url) {
      result.outcomes.push(failure(listing, 'no_url', 'This listing has no product page URL.'));
      continue;
    }
    let url: URL;
    try {
      url = new URL(listing.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      result.outcomes.push(failure(listing, 'invalid_url', `"${listing.url}" is not a valid http(s) URL.`));
      continue;
    }

    try {
      const robots = await loadRobots(cc.ctx, url.origin, userAgent, cc.retailer.rate_limit_ms, cc.signal);
      if (robots.blocked) {
        result.outcomes.push(failure(listing, 'robots_unavailable', `${robots.blocked}.`));
        continue;
      }
      if (robots.rules && robots.rules.isDisallowed(url.toString(), userAgent) === true) {
        result.outcomes.push(failure(listing, 'robots_disallowed', `robots.txt of ${url.host} does not allow automated access to this page; it was not requested.`));
        continue;
      }
      const delay = Math.max(cc.retailer.rate_limit_ms, robots.crawlDelayMs);
      if (robots.crawlDelayMs > cc.retailer.rate_limit_ms && !warnedCrawlDelay.has(url.host)) {
        warnedCrawlDelay.add(url.host);
        result.logs.push({
          level: 'info',
          code: 'crawl_delay',
          message: `${url.host} asks for ${Math.round(robots.crawlDelayMs / 1000)} s between requests (Crawl-delay); this is being honoured.`,
        });
      }

      const fetched = await hostThrottled(
        url.host,
        delay,
        async () => {
          const res = await safeFetch(cc.ctx, url.toString(), {
            timeoutMs: config.timeout_ms,
            headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en' },
          });
          const fetchedAt = new Date().toISOString();
          if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return { status: res.status, body: '', fetchedAt, contentType: '', finalUrl: res.url || url.toString() };
          }
          const contentType = res.headers.get('content-type') ?? '';
          const body = await readBody(res, 5 * 1024 * 1024);
          return { status: res.status, body, fetchedAt, contentType, finalUrl: res.url || url.toString() };
        },
        cc.signal,
      );
      result.requests++;

      if (fetched.status === 401 || fetched.status === 403) {
        result.outcomes.push(failure(listing, 'access_denied', `The site refused access to this page (HTTP ${fetched.status}). It may require a login or block automated access.`));
        consecutiveErrors++;
      } else if (fetched.status === 404 || fetched.status === 410) {
        result.outcomes.push(failure(listing, 'not_found', `The product page no longer exists (HTTP ${fetched.status}).`));
        consecutiveErrors = 0;
      } else if (fetched.status === 429) {
        result.outcomes.push(failure(listing, 'rate_limited', 'The site is rate limiting requests (HTTP 429).'));
        result.fatal = { code: 'rate_limited', message: `${url.host} is rate limiting requests (HTTP 429). The run was stopped out of respect for the site; increase the pause between requests.` };
        break;
      } else if (fetched.status >= 400) {
        result.outcomes.push(failure(listing, fetched.status >= 500 ? 'source_error' : 'http_error', `The site answered with HTTP ${fetched.status}.`));
        consecutiveErrors++;
      } else if (fetched.contentType && !/html|xml|text\/plain/i.test(fetched.contentType)) {
        result.outcomes.push(failure(listing, 'unexpected_content', `The URL returned "${fetched.contentType.split(';')[0]}" instead of an HTML page.`));
        consecutiveErrors = 0;
      } else if (await redirectedToDisallowed(cc, url, fetched.finalUrl, userAgent)) {
        consecutiveErrors = 0;
        result.outcomes.push(
          failure(
            listing,
            'robots_disallowed',
            `The page redirected to ${new URL(fetched.finalUrl).host}, whose robots.txt does not permit automated access (or could not be read). Nothing from it was used.`,
          ),
        );
      } else {
        consecutiveErrors = 0;
        const extracted = extractFromHtml(fetched.body, listing, cc.retailer, config, cc.currencies);
        if ('failure' in extracted) {
          result.outcomes.push(failure(listing, extracted.failure.code, extracted.failure.message));
        } else {
          const e = extracted.extraction;
          const observation: ObservationDraft = {
            observed_at: fetched.fetchedAt,
            observed_basis: 'exact',
            currency_code: cc.retailer.currency_code,
            current_price: e.current,
            regular_price: e.regular,
            availability: e.availability,
            product_url: fetched.finalUrl,
            confidence: CONFIDENCE[e.strategy],
            collection_status: e.current !== null && e.availability !== 'unknown' ? 'complete' : 'partial',
          };
          result.evidence.push({
            kind: 'html_snapshot',
            reference: fetched.finalUrl,
            sha256: sha256Hex(fetched.body),
            size_bytes: Buffer.byteLength(fetched.body),
            excerpt: e.excerpt,
            note: `Extracted via ${STRATEGY_LABEL[e.strategy]} (strategy: ${e.strategy})`,
            captured_at: fetched.fetchedAt,
          });
          result.outcomes.push({ listing_id: listing.id, status: 'ok', observation, evidence: result.evidence.length - 1, strategy: e.strategy, excerpt: e.excerpt });
        }
      }
    } catch (err) {
      if ((err as Error).message === 'aborted') break;
      result.requests++;
      const code = err instanceof NetError ? err.code : 'network_error';
      result.outcomes.push(failure(listing, code, err instanceof NetError ? err.message : `Request failed: ${(err as Error).message}`));
      consecutiveErrors++;
    }

    if (consecutiveErrors >= 5) {
      result.fatal = {
        code: 'source_unreachable',
        message: `Stopped after ${consecutiveErrors} consecutive failed page requests so the site is not hammered. See the listing errors for the reasons.`,
      };
      break;
    }
  }
  return result;
}

const CONFIG_FIELDS: ConnectorConfigField[] = [
  {
    key: 'strategies', label: 'Extraction strategies (tried in order)', type: 'string_list', group: 'Extraction',
    default: ALL_STRATEGIES,
    options: ALL_STRATEGIES.map((s) => ({ value: s, label: STRATEGY_LABEL[s] })),
    help: 'Structured data and meta tags need no configuration. Selectors and regular expressions are only used when set below.',
  },
  { key: 'price_selector', label: 'Price — CSS selector', type: 'text', group: 'CSS selectors', placeholder: '.product-price .now' },
  { key: 'price_attribute', label: 'Price — attribute (optional)', type: 'text', group: 'CSS selectors', placeholder: 'data-price', help: 'Read this attribute instead of the element text.' },
  { key: 'regular_price_selector', label: 'Regular price — CSS selector', type: 'text', group: 'CSS selectors', placeholder: '.product-price .was' },
  { key: 'regular_price_attribute', label: 'Regular price — attribute (optional)', type: 'text', group: 'CSS selectors' },
  { key: 'availability_selector', label: 'Availability — CSS selector', type: 'text', group: 'CSS selectors', placeholder: '.stock-status' },
  { key: 'availability_attribute', label: 'Availability — attribute (optional)', type: 'text', group: 'CSS selectors' },
  { key: 'price_regex', label: 'Price — regular expression', type: 'text', group: 'Regular expressions', placeholder: '"price"\\s*:\\s*"?([0-9.,]+)', help: 'Applied to the page source; the first capture group is the price.' },
  { key: 'regular_price_regex', label: 'Regular price — regular expression', type: 'text', group: 'Regular expressions' },
  { key: 'out_of_stock_regex', label: 'Out of stock — regular expression', type: 'text', group: 'Regular expressions', placeholder: 'out of stock|sold out' },
  {
    key: 'decimal_separator', label: 'Decimal separator', type: 'select', group: 'Extraction', default: 'auto',
    options: [{ value: 'auto', label: 'Detect automatically' }, { value: '.', label: 'Point (12.50)' }, { value: ',', label: 'Comma (12,50)' }],
  },
  { key: 'timeout_ms', label: 'Page timeout (ms)', type: 'number', group: 'Extraction', default: 20000 },
];

export const webConnector: Connector = {
  methods: ['web_extraction'],
  runnable: true,
  dataClass: 'real',

  describe(method: CollectionMethod): ConnectorDescription {
    return {
      method,
      label: 'Permitted website extraction',
      summary: 'Reads the published price from a retailer\'s product pages, where the site permits it.',
      description:
        'Requests each listing\'s product page and reads the price from schema.org structured data, price meta tags, or a CSS selector / regular expression you configure. It obeys robots.txt, pauses between requests and identifies itself with the configured User-Agent.',
      runnable: true,
      kind: 'real',
      requirements: [
        'A permission attestation for the website: an administrator confirms that the site\'s terms of use allow this access',
        'A product page URL on every listing',
        'robots.txt of the site must allow the pages (checked automatically on every run)',
        'For sites without structured data: a CSS selector or regular expression for the price',
      ],
      limitations: [
        'No JavaScript is executed: prices that only appear after scripts run cannot be read.',
        'No login, cookie consent or captcha handling — such pages are reported as failures.',
        'Sites that block automated access (HTTP 403/429, verification pages) cannot be collected this way; use an official API, feed or a data provider instead.',
        'The request pace is limited by the pause between requests, so large catalogues take time.',
      ],
      credential: { needed: 'never', label: '', help: '' },
      needs_permission_attestation: true,
      supports_discovery: false,
      config_fields: CONFIG_FIELDS,
      examples: [
        {
          title: 'Site with schema.org structured data',
          description: 'Most product pages publish price and availability as JSON-LD. No configuration is needed beyond the permission attestation.',
          config: {},
        },
        {
          title: 'Site without structured data',
          description: 'Point the connector at the elements that show the prices.',
          config: { price_selector: '.pdp-price .current', regular_price_selector: '.pdp-price .was', availability_selector: '.stock-label' },
        },
      ],
    };
  },

  checkConfig(_ctx: AppContext, retailer: SourceRetailer, raw: Record<string, unknown>): ConfigCheck {
    const { problems } = readWebConfig(raw);
    const missing = [...problems];
    if (retailer.permission_attested !== 1) {
      missing.unshift('Access permission has not been attested for this website (an administrator must confirm that the site\'s terms allow automated access)');
    }
    return { ok: missing.length === 0, missing, warnings: [] };
  },

  canRunWithoutListings(): boolean {
    return false;
  },

  requestsPerListing(): boolean {
    return true;
  },

  collect: collectWeb,
};

// ---------------------------------------------------------------------------------------------
// Site check: can one product page be read directly?
// ---------------------------------------------------------------------------------------------

const DIRECT_NEXT_STEPS = [
  'Add the retailer with the method “Permitted website extraction”, give each listing its product page address, and confirm there that the site’s terms permit this access.',
  'One page says little about a whole site: run “Test connection” on the retailer before relying on it.',
];
const OTHER_ROUTES = 'Other routes: a feed or API from the retailer, or a data provider that is entitled to the data (method “Third-party data integration”).';

/**
 * Requests robots.txt and — only if it allows the page — the page itself, once, exactly as permitted website
 * extraction would, and reports whether a price can be read from it. Nothing is stored.
 */
export async function checkSite(ctx: AppContext, rawUrl: string, signal: AbortSignal = new AbortController().signal): Promise<SiteCheckResult> {
  const url = new URL(rawUrl);
  const userAgent = ctx.config.userAgent;
  const base = { url: url.toString(), host: url.host, checked_at: new Date().toISOString() };
  const robots = await loadRobots(ctx, url.origin, userAgent, 1000, signal);
  const crawlDelay = robots.crawlDelayMs > 0 ? Math.round(robots.crawlDelayMs / 100) / 10 : null;

  if (robots.blocked) {
    return {
      ...base,
      robots: { status: 'unreadable', detail: `${robots.blocked}.`, crawl_delay_s: null },
      page: null,
      verdict: 'not_permitted',
      advice: ['The site’s rules for automated visitors (robots.txt) could not be read, so the page was not requested. This system treats that as “not permitted”.', OTHER_ROUTES],
    };
  }
  if (robots.rules && robots.rules.isDisallowed(url.toString(), userAgent) === true) {
    return {
      ...base,
      robots: { status: 'disallowed', detail: `robots.txt of ${url.host} does not allow automated access to this page.`, crawl_delay_s: crawlDelay },
      page: null,
      verdict: 'not_permitted',
      advice: ['The site’s robots.txt rules out automated visits to this page, so it was not requested and cannot be collected directly.', OTHER_ROUTES],
    };
  }
  const robotsInfo: SiteCheckResult['robots'] = {
    status: robots.rules ? 'allowed' : 'none',
    detail: robots.rules ? `robots.txt of ${url.host} allows automated access to this page.` : `${url.host} has no robots.txt.`,
    crawl_delay_s: crawlDelay,
  };
  const emptyPage = { price: null, regular_price: null, currency: null, availability: null, read_from: null };
  const blocked = (page: NonNullable<SiteCheckResult['page']>, why: string): SiteCheckResult => ({
    ...base,
    robots: robotsInfo,
    page,
    verdict: 'blocked',
    advice: [`${why} This system does not try to get past such checks, so this site cannot be collected directly from here.`, OTHER_ROUTES],
  });

  let fetched: { status: number; body: string; contentType: string };
  try {
    fetched = await hostThrottled(
      url.host,
      Math.max(1000, robots.crawlDelayMs),
      async () => {
        const res = await safeFetch(ctx, url.toString(), { timeoutMs: 20_000, headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en' } });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return { status: res.status, body: '', contentType: '' };
        }
        return { status: res.status, body: await readBody(res, 5 * 1024 * 1024), contentType: res.headers.get('content-type') ?? '' };
      },
      signal,
    );
  } catch (err) {
    if ((err as Error).message === 'aborted') throw err;
    const reason = err instanceof NetError ? err.message : (err as Error).message;
    return blocked({ http_status: null, outcome: 'error', detail: `The page could not be fetched: ${reason}.`, ...emptyPage }, 'The site did not answer the request.');
  }

  if (fetched.status === 401 || fetched.status === 403) {
    return blocked({ http_status: fetched.status, outcome: 'refused', detail: `The site refused access to the page (HTTP ${fetched.status}).`, ...emptyPage }, 'The site refuses automated visits.');
  }
  if (fetched.status === 429) {
    return blocked({ http_status: 429, outcome: 'rate_limited', detail: 'The site is rate limiting requests (HTTP 429).', ...emptyPage }, 'The site is limiting automated requests.');
  }
  if (fetched.status === 404 || fetched.status === 410) {
    return {
      ...base,
      robots: robotsInfo,
      page: { http_status: fetched.status, outcome: 'not_found', detail: `There is no page at this address (HTTP ${fetched.status}).`, ...emptyPage },
      verdict: 'needs_setup',
      advice: ['The address does not lead to a product page. Check it with the address of a product that is on sale now.'],
    };
  }
  if (fetched.status >= 400) {
    return blocked({ http_status: fetched.status, outcome: 'error', detail: `The site answered with HTTP ${fetched.status}.`, ...emptyPage }, 'The site answered with an error.');
  }
  if (fetched.contentType && !/html|xml|text\/plain/i.test(fetched.contentType)) {
    return {
      ...base,
      robots: robotsInfo,
      page: { http_status: fetched.status, outcome: 'not_a_page', detail: `The address returned “${fetched.contentType.split(';')[0]}” instead of a web page.`, ...emptyPage },
      verdict: 'needs_setup',
      advice: ['This address is not a product page. If it is a feed or an API, use the method “Product feed” or “Official API” for it instead.'],
    };
  }

  const { config } = readWebConfig({});
  const listing = { id: 0, external_id: null, url: url.toString(), title: null, gtin: null } as unknown as SourceListing;
  const currencies = new Set(ctx.db.all<{ code: string }>('SELECT code FROM currencies').map((c) => c.code));
  const result = extractFromHtml(fetched.body, listing, { currency_code: '' }, config, currencies, { anyCurrency: true });
  if ('extraction' in result) {
    const e = result.extraction;
    return {
      ...base,
      robots: robotsInfo,
      page: {
        http_status: fetched.status,
        outcome: 'price_found',
        detail: `A price was read from ${STRATEGY_LABEL[e.strategy]}.`,
        price: e.current,
        regular_price: e.regular,
        currency: e.currency,
        availability: e.availability,
        read_from: STRATEGY_LABEL[e.strategy],
      },
      verdict: 'direct',
      advice: ['This page can be read directly, at no cost: the price is in the page itself and the site’s rules allow automated visits to it.', ...DIRECT_NEXT_STEPS],
    };
  }
  if (result.failure.code === 'bot_challenge') {
    return blocked({ http_status: fetched.status, outcome: 'verification_page', detail: result.failure.message, ...emptyPage }, 'The site showed a verification page instead of the product.');
  }
  return {
    ...base,
    robots: robotsInfo,
    page: { http_status: fetched.status, outcome: 'no_price', detail: result.failure.message, ...emptyPage },
    verdict: 'needs_setup',
    advice: [
      'The page opened, but no price could be read from it. Prices that a browser draws with JavaScript are not in the page this system receives.',
      'If the price is in the page’s HTML, a CSS selector in the source’s settings can read it. Otherwise use a retailer feed, an API or a data provider.',
    ],
  };
}
