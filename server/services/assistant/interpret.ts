/**
 * Turning a question into a QueryPlan without any external service.
 *
 * The catalogue (markets, retailers, brands, categories, products) is the vocabulary: entities are
 * recognised by name, the intent by wording, the period by simple date phrases. The plan is then run by
 * the same executor that runs plans produced by the Claude interpreter.
 */
import { z } from 'zod';
import type { AppContext } from '../../context.ts';
import { addDays } from '../../lib/time.ts';
import type { AssistantIntent, PeriodPreset, QueryPlan } from '../../../shared/api/assistant.ts';
import type { DateRange } from '../../../shared/api/analytics.ts';

export const INTENTS: AssistantIntent[] = [
  'price_history', 'current_prices', 'lowest_price', 'price_changes', 'discount_ranking', 'promotion_frequency', 'positioning', 'volatility',
  'cross_market', 'unsupported',
];
export const PERIOD_PRESETS: PeriodPreset[] = [
  'today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'this_week', 'this_month', 'last_month', 'custom', 'default',
];

/** Schema of a plan — used to validate the built-in result and as the structured-output format for Claude. */
export const PlanSchema = z.object({
  intent: z.enum(INTENTS as [AssistantIntent, ...AssistantIntent[]]),
  products: z.array(z.string()),
  brands: z.array(z.string()),
  retailers: z.array(z.string()),
  markets: z.array(z.string()),
  categories: z.array(z.string()),
  ownership: z.enum(['own', 'competitor', 'any']),
  period: z.object({
    preset: z.enum(PERIOD_PRESETS as [PeriodPreset, ...PeriodPreset[]]),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  direction: z.enum(['up', 'down', 'any']),
  limit: z.number().nullable(),
  reason: z.string().nullable(),
});

export const INTENT_LABELS: Record<AssistantIntent, string> = {
  price_history: 'Price history',
  current_prices: 'Current prices',
  lowest_price: 'Lowest current price',
  price_changes: 'Price changes',
  discount_ranking: 'Discount ranking',
  promotion_frequency: 'Promotion frequency',
  positioning: 'Price positioning vs competitors',
  volatility: 'Price volatility',
  cross_market: 'Cross-market comparison',
  unsupported: 'Not answerable from stored records',
};

// ---------------------------------------------------------------------------------------------
// Catalogue vocabulary
// ---------------------------------------------------------------------------------------------
export interface Catalogue {
  markets: Array<{ id: number; code: string; name: string; country_name: string }>;
  retailers: Array<{ id: number; name: string; market_id: number; market_code: string }>;
  brands: Array<{ id: number; name: string; ownership: 'own' | 'competitor' }>;
  categories: Array<{ id: number; name: string; parent_id: number | null }>;
  products: Array<{ id: number; name: string; code: string; sku: string | null; brand_id: number; brand_name: string; ownership: 'own' | 'competitor' }>;
}

export function loadCatalogue(ctx: AppContext): Catalogue {
  const { db } = ctx;
  return {
    markets: db.all('SELECT id, code, name, country_name FROM markets WHERE is_active = 1 ORDER BY sort_order, name'),
    retailers: db.all(
      `SELECT r.id, r.name, r.market_id, m.code AS market_code FROM retailers r JOIN markets m ON m.id = r.market_id WHERE r.is_active = 1 ORDER BY r.name`,
    ),
    brands: db.all(`SELECT id, name, ownership FROM brands WHERE is_active = 1 ORDER BY name`),
    categories: db.all('SELECT id, name, parent_id FROM categories ORDER BY name'),
    products: db.all(
      `SELECT p.id, p.name, p.code, p.sku, p.brand_id, b.name AS brand_name, b.ownership FROM products p JOIN brands b ON b.id = p.brand_id
       WHERE p.status <> 'archived' ORDER BY p.name`,
    ),
  };
}

const MARKET_ALIASES: Record<string, string[]> = {
  AE: ['uae', 'u a e', 'emirates', 'united arab emirates', 'dubai', 'abu dhabi'],
  SA: ['ksa', 'saudi', 'saudi arabia', 'kingdom of saudi arabia'],
  KW: ['kuwait'],
  QA: ['qatar'],
  BH: ['bahrain'],
  OM: ['oman'],
  IQ: ['iraq'],
  KE: ['kenya'],
  UG: ['uganda'],
  GH: ['ghana'],
};

/** Lower-case, strip punctuation and possessives, join numbers to their units ("200 ml" → "200ml"). */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]s\b/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/(\d+(?:\.\d+)?)\s+(ml|l|g|kg|gm|ltr)\b/g, '$1$2')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokenise = (text: string): string[] => normalise(text).split(' ').filter(Boolean);
const hasPhrase = (haystack: string, phrase: string): boolean => phrase.length > 0 && ` ${haystack} `.includes(` ${phrase} `);

const RETAILER_NOISE = new Set(['hypermarket', 'supermarket', 'the', 'online', 'store', 'stores', 'market', 'centre', 'center']);

/** "Carrefour UAE" → "carrefour"; "Amazon.ae" → "amazon"; "Lulu Hypermarket Kuwait" → "lulu". */
function retailerShortName(name: string, catalogue: Catalogue): string {
  const marketWords = new Set<string>();
  for (const m of catalogue.markets) {
    for (const w of [...tokenise(m.name), ...tokenise(m.country_name), m.code.toLowerCase(), ...(MARKET_ALIASES[m.code] ?? []).flatMap(tokenise)]) marketWords.add(w);
  }
  const words = tokenise(name.replace(/\.(ae|sa|com|co|ke|ug|gh|qa|kw|bh|om|iq)\b/gi, ' ')).filter((w) => !marketWords.has(w) && !RETAILER_NOISE.has(w));
  return words.join(' ');
}

export interface Resolved {
  ids: number[];
  names: string[];
  unresolved: string[];
}

function resolveBy<T extends { id: number; name: string }>(items: T[], terms: string[], extra: (item: T) => string[] = () => []): Resolved {
  const ids = new Set<number>();
  const unresolved: string[] = [];
  for (const term of terms) {
    const t = normalise(term);
    if (!t) continue;
    // most specific first: the exact name, then an alias (e.g. a retailer's short name), then phrase containment
    let hits = items.filter((i) => normalise(i.name) === t);
    if (!hits.length) hits = items.filter((i) => extra(i).includes(t));
    if (!hits.length) hits = items.filter((i) => hasPhrase(normalise(i.name), t) || extra(i).some((e) => hasPhrase(e, t)));
    if (!hits.length) hits = items.filter((i) => hasPhrase(t, normalise(i.name)));
    if (hits.length) for (const h of hits) ids.add(h.id);
    else unresolved.push(term);
  }
  const list = [...ids];
  return { ids: list, names: items.filter((i) => ids.has(i.id)).map((i) => i.name), unresolved };
}

export function resolveMarkets(catalogue: Catalogue, terms: string[]): Resolved {
  return resolveBy(catalogue.markets, terms, (m) => [m.code.toLowerCase(), normalise(m.country_name), ...(MARKET_ALIASES[m.code] ?? [])]);
}
export function resolveRetailers(catalogue: Catalogue, terms: string[], marketIds: number[] = []): Resolved {
  const pool = marketIds.length ? catalogue.retailers.filter((r) => marketIds.includes(r.market_id)) : catalogue.retailers;
  const res = resolveBy(pool, terms, (r) => [retailerShortName(r.name, catalogue)]);
  if (marketIds.length && res.unresolved.length) {
    // the retailer exists, just not in the requested market: say so instead of "unknown"
    const elsewhere = resolveBy(catalogue.retailers, res.unresolved, (r) => [retailerShortName(r.name, catalogue)]);
    res.unresolved = res.unresolved.map((t) => (elsewhere.unresolved.includes(t) ? t : `${t} (not present in the selected market)`));
  }
  return res;
}
export const resolveBrands = (catalogue: Catalogue, terms: string[]): Resolved => resolveBy(catalogue.brands, terms);
export function resolveCategories(catalogue: Catalogue, terms: string[]): Resolved {
  return resolveBy(catalogue.categories, terms, (c) => [normalise(c.name).replace(/s$/, '')]);
}

const SIZE_TOKEN = /^\d+(?:\.\d+)?(ml|l|g|kg|gm|ltr)$/;

/** Products best matching a free-text term: brand must agree, a stated pack size must agree. */
export function matchProducts(catalogue: Catalogue, term: string): Catalogue['products'] {
  const t = normalise(term);
  const exact = catalogue.products.filter((p) => normalise(p.name) === t || p.code.toLowerCase() === t || (p.sku ?? '').toLowerCase() === t);
  if (exact.length) return exact;
  const q = new Set(tokenise(term));
  const sizes = [...q].filter((w) => SIZE_TOKEN.test(w));
  const scored: Array<{ p: Catalogue['products'][number]; score: number; matched: number }> = [];
  for (const p of catalogue.products) {
    const name = tokenise(p.name);
    const brand = tokenise(p.brand_name);
    if (sizes.length && !sizes.some((s) => name.includes(s))) continue;
    const matched = name.filter((w) => q.has(w)).length;
    if (matched < 2) continue;
    // when the product name carries its brand ("Dabur Amla Hair Oil"), the brand must be mentioned too, so that
    // "Parachute hair oil 200ml" never matches a Dabur product; names without the brand are matched on their own words
    const brandInName = brand.filter((w) => name.includes(w));
    const brandOk = brandInName.length === 0 || brandInName.every((w) => q.has(w)) || brandInName.filter((w) => q.has(w)).length >= Math.max(1, brandInName.length - 1);
    if (!brandOk) continue;
    scored.push({ p, matched, score: matched / name.length });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.matched - a.matched || b.score - a.score);
  const best = scored[0]!;
  return scored.filter((s) => s.matched === best.matched && best.score - s.score < 0.05).slice(0, 4).map((s) => s.p);
}

export function resolveProducts(catalogue: Catalogue, terms: string[]): Resolved {
  const ids = new Set<number>();
  const unresolved: string[] = [];
  for (const term of terms) {
    const hits = matchProducts(catalogue, term);
    if (hits.length) for (const h of hits) ids.add(h.id);
    else unresolved.push(term);
  }
  return { ids: [...ids], names: catalogue.products.filter((p) => ids.has(p.id)).map((p) => p.name), unresolved };
}

// ---------------------------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------------------------
export interface ResolvedPeriod extends DateRange {
  label: string;
}

const DEFAULT_DAYS: Record<AssistantIntent, number> = {
  price_history: 30, current_prices: 30, lowest_price: 30, price_changes: 7, discount_ranking: 30, promotion_frequency: 90, positioning: 90,
  volatility: 30, cross_market: 30, unsupported: 30,
};

export function resolvePeriod(plan: QueryPlan, today: string): ResolvedPeriod {
  const p = plan.period;
  const lastDays = (n: number, label: string): ResolvedPeriod => ({ from: addDays(today, -(n - 1)), to: today, label });
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  switch (p.preset) {
    case 'today':
      return { from: today, to: today, label: 'today' };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1), label: 'yesterday' };
    case 'last_7_days':
      return lastDays(7, 'the last 7 days');
    case 'last_30_days':
      return lastDays(30, 'the last 30 days');
    case 'last_90_days':
      return lastDays(90, 'the last 90 days');
    case 'this_week':
      return { from: addDays(today, -weekday), to: today, label: 'this week (Monday to date)' };
    case 'this_month':
      return { from: `${today.slice(0, 8)}01`, to: today, label: 'this month to date' };
    case 'last_month': {
      const firstOfThis = `${today.slice(0, 8)}01`;
      const end = addDays(firstOfThis, -1);
      return { from: `${end.slice(0, 8)}01`, to: end, label: 'last month' };
    }
    case 'custom': {
      const valid = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
      const to = valid(p.to) && p.to <= today ? p.to : today;
      const from = valid(p.from) && p.from <= to ? p.from : addDays(to, -(DEFAULT_DAYS[plan.intent] - 1));
      return { from, to, label: `${from} to ${to}` };
    }
    default: {
      const n = DEFAULT_DAYS[plan.intent];
      return lastDays(n, `the last ${n} days`);
    }
  }
}

function detectPeriod(q: string, today: string): QueryPlan['period'] {
  const preset = (value: PeriodPreset): QueryPlan['period'] => ({ preset: value, from: null, to: null });
  const nMatch = /\b(?:last|past|previous|over the last|over the past)\s+(\d{1,3})\s*(day|week|month)s?\b/.exec(q);
  if (nMatch) {
    const n = Number(nMatch[1]);
    const days = nMatch[2] === 'day' ? n : nMatch[2] === 'week' ? n * 7 : n * 30;
    if (days === 7) return preset('last_7_days');
    if (days === 30) return preset('last_30_days');
    if (days === 90) return preset('last_90_days');
    return { preset: 'custom', from: addDays(today, -(Math.max(1, Math.min(days, 730)) - 1)), to: today };
  }
  const since = /\bsince\s+(\d{4}-\d{2}-\d{2})\b/.exec(q);
  if (since) return { preset: 'custom', from: since[1]!, to: today };
  const between = /\b(\d{4}-\d{2}-\d{2})\s+(?:to|and|until|-)\s+(\d{4}-\d{2}-\d{2})\b/.exec(q);
  if (between) return { preset: 'custom', from: between[1]!, to: between[2]! };
  if (/\byesterday\b/.test(q)) return preset('yesterday');
  if (/\btoday\b|\bright now\b/.test(q)) return preset('today');
  if (/\bthis week\b/.test(q)) return preset('this_week');
  if (/\b(?:last|past|previous) week\b/.test(q)) return preset('last_7_days');
  if (/\bthis month\b/.test(q)) return preset('this_month');
  if (/\b(?:over|in|during) the (?:last|past) month\b|\bpast month\b/.test(q)) return preset('last_30_days');
  if (/\blast month\b|\bprevious month\b/.test(q)) return preset('last_month');
  if (/\b(?:this|last|past) quarter\b|\b(?:last|past) (?:3|three) months\b/.test(q)) return preset('last_90_days');
  return preset('default');
}

// ---------------------------------------------------------------------------------------------
// Built-in interpreter
// ---------------------------------------------------------------------------------------------
function detectIntent(q: string, hasProduct: boolean, period: QueryPlan['period']): AssistantIntent {
  const has = (re: RegExp) => re.test(q);
  if (has(/\bvolatil|\bfluctuat|\bunstable\b|\bmost variable\b/)) return 'volatility';
  if (has(/\b(across|between|by|per|each|every|compare)\b.*\b(markets?|countries|country)\b/) && hasProduct && !has(/\bincreases?\b|\bdecreases?\b|\bdrops?\b/)) return 'cross_market';
  if (has(/\blowest\b|\bcheapest\b|\bbest price\b|\bleast expensive\b/) && has(/\bpric|\bretailer|\bstore|\bwhere\b|\bwho\b|\bwhich\b/)) return 'lowest_price';
  if (has(/\bhow (often|frequently|frequent)\b|\bfrequency\b|\bhow many (promotions?|promos?|offers?|deals?)\b|\bhow regularly\b/) && has(/\bpromo|\bdiscount|\boffer|\bdeal|\bsale\b/)) {
    return 'promotion_frequency';
  }
  if (has(/\bdiscount(ed|ing|s)?\b.*\b(most|biggest|highest|deepest|largest|heaviest)\b|\b(most|biggest|highest|deepest|largest|heaviest)\b.*\b(discount|promo|promotion|offer)s?\b/)) {
    return 'discount_ranking';
  }
  if (
    has(/\bposition(ing|ed)?\b|\bprice (gap|index|difference)\b|\bpremium\b|\b(vs|versus|against|compared (to|with)|relative to)\b.*\bcompetit|\bmore expensive than\b|\bcheaper than\b/) ||
    has(/\bpriced? (above|below|over|under|higher|lower)\b|\b(above|below|higher than|lower than|more expensive|cheaper|pricier)\b.*\b(competit|rivals?)\b|\bundercut/)
  ) {
    return 'positioning';
  }
  if (has(/\bprice (increase|decrease|rise|drop|cut|reduction|change|hike|move)s?\b|\b(increase|decrease|rise|drop|cut|reduction|hike)s? in price\b|\b(went|gone|going) (up|down)\b|\b(raised|reduced|lowered|increased|decreased|dropped) (their |its |the )?prices?\b|\bprice movements?\b/)) {
    return 'price_changes';
  }
  if (has(/\bpromotions?\b|\bpromos?\b|\bdiscounts?\b|\boffers?\b/)) return 'promotion_frequency';
  if (has(/\bprice history\b|\bhistor(y|ical)\b|\btrend\b|\bover time\b|\bwhat (was|were)\b|\bhow has\b|\bhow have\b|\bover the (last|past)\b/)) return hasProduct ? 'price_history' : 'unsupported';
  if (has(/\bcurrent(ly)?\b|\blatest\b|\bnow\b|\bhow much\b|\bprice of\b|\bprices? (at|on|in)\b|\bwhat is the price\b/)) {
    return hasProduct ? (period.preset === 'default' || period.preset === 'today' ? 'current_prices' : 'price_history') : 'unsupported';
  }
  if (hasProduct) return period.preset === 'default' ? 'current_prices' : 'price_history';
  return 'unsupported';
}

export interface Interpretation {
  plan: QueryPlan;
  /** Why the plan needs the user's input (e.g. "this product" with no product named). */
  clarification: string | null;
}

/** Rule-based interpretation of a question against the catalogue vocabulary. */
export function interpretBuiltin(question: string, catalogue: Catalogue, today: string): Interpretation {
  const q = normalise(question);
  const period = detectPeriod(q, today);

  const markets = catalogue.markets.filter((m) =>
    [normalise(m.name), normalise(m.country_name), ...(MARKET_ALIASES[m.code] ?? [])].some((alias) => hasPhrase(q, alias)),
  );
  const marketIds = markets.map((m) => m.id);

  // products first: their names contain brand and category words
  const products = matchProducts(catalogue, question).filter((p) => {
    // a whole-question match must still mention something specific to the product beyond its brand
    const brandWords = new Set(tokenise(p.brand_name));
    return tokenise(p.name).some((w) => !brandWords.has(w) && hasPhrase(q, w));
  });
  const productBrandIds = new Set(products.map((p) => p.brand_id));

  // a brand word that is simply part of a matched product's name is not a separate brand filter
  const productNames = products.map((p) => normalise(p.name));
  const brands = catalogue.brands.filter((b) => hasPhrase(q, normalise(b.name)) && !productBrandIds.has(b.id) && !productNames.some((name) => hasPhrase(name, normalise(b.name))));
  // a brand whose name is a prefix of another matched brand ("Dabur" in "Dabur Amla") is dropped
  const brandNames = brands
    .filter((b) => !brands.some((o) => o.id !== b.id && hasPhrase(normalise(o.name), normalise(b.name))))
    .map((b) => b.name);

  const retailerPool = marketIds.length ? catalogue.retailers.filter((r) => marketIds.includes(r.market_id)) : catalogue.retailers;
  // "Carrefour" alone means every Carrefour; "Carrefour UAE" means that one. When a retailer is named in full, others
  // that merely share its short name ("Acceptance Mart" vs "Acceptance Online") are not pulled in.
  const retailerMatches = retailerPool
    .map((r) => {
      const short = retailerShortName(r.name, catalogue);
      return { r, short, full: hasPhrase(q, normalise(r.name)), partial: short.length > 2 && hasPhrase(q, short) };
    })
    .filter((m) => m.full || m.partial);
  // A phrase after "at / on / from" that is part of several retailer names ("at Acceptance") means all of them.
  const CAP = "[A-Z][\\w&.'’-]*(?:\\s+[A-Z][\\w&.'’-]*)*";
  const listed = new RegExp(`\\b(at|on|from|in|across)\\s+(${CAP}(?:\\s*(?:,|\\band\\b|\\bor\\b)\\s*${CAP})*)`, 'g');
  for (const m of question.matchAll(listed)) {
    if (m[1] === 'in' || m[1] === 'across') continue;
    for (const part of m[2]!.split(/\s*(?:,|\band\b|\bor\b)\s*/)) {
      const phrase = normalise(part.replace(/[?.!,]+$/, ''));
      if (phrase.length < 3) continue;
      for (const r of retailerPool) {
        if (hasPhrase(normalise(r.name), phrase) && !retailerMatches.some((x) => x.r.id === r.id)) retailerMatches.push({ r, short: phrase, full: false, partial: true });
      }
    }
  }
  // the longest full name wins: "Test Mart Online" is not also "Test Mart"
  const fullNames = retailerMatches.filter((m) => m.full).map((m) => normalise(m.r.name));
  const namedInFull = fullNames.filter((name) => !fullNames.some((other) => other !== name && hasPhrase(other, name)));
  const retailers = retailerMatches
    .filter((m) => (m.full ? namedInFull.includes(normalise(m.r.name)) : !namedInFull.some((name) => hasPhrase(name, m.short))))
    .map((m) => m.r);

  const categories = products.length
    ? []
    : catalogue.categories.filter((c) => {
        const n = normalise(c.name);
        return hasPhrase(q, n) || hasPhrase(q, `${n}s`) || (n.endsWith('s') && hasPhrase(q, n.slice(0, -1)));
      });

  const ownership: QueryPlan['ownership'] = /\bcompetitors?\b|\bcompeting\b|\brivals?\b/.test(q)
    ? 'competitor'
    : /\b(our|own|my)\b(?!.*\bvs\b)/.test(q) && !/\bcompetitors?\b/.test(q)
      ? 'own'
      : 'any';
  const direction: QueryPlan['direction'] = /\bincreas|\brise|\brose\b|\bhike|\braised\b|\bwent up\b|\bup\b(?= )/.test(q) && !/\bdecreas|\bdrop|\bcut|\breduc|\blower/.test(q)
    ? 'up'
    : /\bdecreas|\bdrop|\bcut|\breduc|\blower|\bwent down\b|\bfell\b/.test(q) && !/\bincreas|\brise|\bhike/.test(q)
      ? 'down'
      : 'any';
  const limitMatch = /\btop\s+(\d{1,2})\b/.exec(q);

  // Named things that are NOT in the catalogue must not be silently dropped: pass them through so the
  // executor reports that no data exists for them.
  const known = (phrase: string): boolean => {
    const n = normalise(phrase);
    if (!n) return true;
    const inName = (name: string) => hasPhrase(normalise(name), n) || hasPhrase(n, normalise(name));
    return (
      catalogue.markets.some((m) => inName(m.name) || inName(m.country_name) || (MARKET_ALIASES[m.code] ?? []).some((a) => hasPhrase(a, n) || hasPhrase(n, a))) ||
      catalogue.retailers.some((r) => inName(r.name) || hasPhrase(retailerShortName(r.name, catalogue), n)) ||
      catalogue.brands.some((b) => inName(b.name)) ||
      catalogue.categories.some((c) => inName(c.name)) ||
      products.some((p) => hasPhrase(normalise(p.name), n))
    );
  };
  const TIME_WORDS = /^(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|q[1-4]|today|yesterday)$/i;
  const unknownRetailers: string[] = [];
  const unknownMarkets: string[] = [];
  for (const m of question.matchAll(listed)) {
    for (const part of m[2]!.split(/\s*(?:,|\band\b|\bor\b)\s*/)) {
      const phrase = part.replace(/[?.!,]+$/, '').trim();
      if (!phrase || TIME_WORDS.test(phrase) || known(phrase)) continue;
      if (m[1] === 'in' || m[1] === 'across') unknownMarkets.push(phrase);
      else unknownRetailers.push(phrase);
    }
  }
  let unknownProduct: string | null = null;
  if (products.length === 0) {
    // A product that is named but not in the catalogue: "price of X", "price history of X", "how much does X cost",
    // "how much is X", "cost of X", "what does X cost".
    const STOP = "(?=\\s+(?:at|on|in|over|during|from|across|last|this|since|between|today|yesterday|now|currently|right|costs?)\\b|[?.!]|$)";
    const NAMED_PRODUCT = [
      new RegExp(`\\bprices?\\s+(?:history\\s+)?(?:of|for)\\s+(?:the\\s+)?(.+?)${STOP}`, 'i'),
      new RegExp(`\\bhow much\\s+(?:does|do|did|is|are|was|were)\\s+(?:the\\s+)?(.+?)${STOP}`, 'i'),
      new RegExp(`\\b(?:cost|pricing)\\s+of\\s+(?:the\\s+)?(.+?)${STOP}`, 'i'),
      new RegExp(`\\bwhat\\s+(?:does|do|did)\\s+(?:the\\s+)?(.+?)${STOP}`, 'i'),
    ];
    const candidate = NAMED_PRODUCT.map((re) => re.exec(question)?.[1]?.trim()).find((c) => !!c);
    if (candidate && !/^(this|that|the|a|an|it|its|their|our)\b/i.test(candidate) && !/^(product|products|item|items)$/i.test(candidate) && !catalogue.brands.some((b) => normalise(b.name) === normalise(candidate)) && !catalogue.categories.some((c) => normalise(c.name) === normalise(candidate))) {
      unknownProduct = candidate;
    }
  }

  let intent = detectIntent(q, products.length > 0 || unknownProduct !== null, period);
  let clarification: string | null = null;
  const refersToUnnamedProduct = /\b(this|that|the) (product|item|sku)\b/.test(q) && products.length === 0;
  if ((intent === 'lowest_price' || intent === 'cross_market' || intent === 'price_history' || intent === 'current_prices') && products.length === 0) {
    if (refersToUnnamedProduct || intent === 'lowest_price' || intent === 'cross_market') {
      clarification = 'Which product do you mean? Name it (for example "Dabur Amla Hair Oil 200ml") and ask again.';
    }
  }
  if (intent === 'positioning' && ownership === 'competitor' && brandNames.length === 0 && products.length === 0) {
    // "positioning against competitors" with no own brand named → all own brands
  }
  let reason: string | null = null;
  if (/\b(will|forecast|forecasts|predict|prediction|projected|projection|expected to|going to be|next (year|month|week|quarter))\b/.test(q)) {
    intent = 'unsupported';
    clarification = null;
    reason = 'Forecasts are not available: only prices that were actually observed are stored, and nothing is estimated beyond them.';
  } else if (intent === 'unsupported' && !clarification) {
    reason =
      'I could not relate this question to the stored price records. I can answer questions about price history, current and lowest prices, price changes, discounts and promotions, positioning against competitors, volatility and cross-market comparisons.';
  }
  // the dimension was named as a filter for the competitor ranking, not as the thing being ranked
  if (intent === 'discount_ranking' && ownership === 'any' && /\bcompetitor/.test(q)) intent = 'discount_ranking';

  return {
    plan: {
      intent,
      products: products.length ? products.map((p) => p.name) : unknownProduct ? [unknownProduct] : [],
      brands: brandNames,
      retailers: [...new Set([...retailers.map((r) => r.name), ...unknownRetailers])],
      markets: [...markets.map((m) => m.name), ...unknownMarkets],
      categories: categories.map((c) => c.name),
      ownership,
      period,
      direction,
      limit: limitMatch ? Number(limitMatch[1]) : null,
      reason,
    },
    clarification,
  };
}
