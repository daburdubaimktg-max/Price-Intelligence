/**
 * Alert engine.
 *
 * Event rules react to the change events derived from newly ingested observations (price changes,
 * promotion starts, availability changes). State rules (stale observations, repeatedly failing
 * collection) are re-evaluated periodically and keep exactly one open alert per rule and retailer,
 * which is updated in place and resolved automatically once the condition clears.
 *
 * Every alert is generated from stored records — observations, listing state and collection jobs.
 */
import type { AppContext, IngestedSummary, PriceEvent } from '../context.ts';
import { placeholders, type SqlParam } from '../db/sqlite.ts';
import { nowIso } from '../lib/time.ts';
import {
  ALERT_TYPE_INFO,
  AUTOMATED_METHODS,
  AVAILABILITY_LABELS,
  MANUAL_STALE_HOURS,
  staleAfterHours,
  type AlertType,
  type Availability,
  type CollectionMethod,
  type Frequency,
  type Severity,
} from '../../shared/constants.ts';
import { formatPack, unitBasisLabel } from '../../shared/units.ts';
import type {
  CollectionFailedPayload,
  ComparedListing,
  OwnMoreExpensivePayload,
  PriceAlertPayload,
  StaleAlertPayload,
  StateCheckResult,
} from '../../shared/api/alerts.ts';
import { queueAlertNotifications } from './notifications.ts';

export const EVENT_RULE_TYPES: AlertType[] = [
  'competitor_price_drop',
  'own_more_expensive',
  'competitor_promotion',
  'product_unavailable',
  'price_change',
  'price_increase',
];
export const STATE_RULE_TYPES: AlertType[] = ['collection_failed', 'stale_observation'];

/** A counterpart price older than this is not used for own-vs-competitor comparisons. */
const COUNTERPART_MAX_AGE_DAYS = 30;
const STATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export interface RuleRecord {
  id: number;
  name: string;
  type: AlertType;
  is_enabled: number;
  severity: Severity;
  threshold_pct: number | null;
  threshold_count: number | null;
  threshold_hours: number | null;
  market_id: number | null;
  retailer_id: number | null;
  brand_id: number | null;
  category_id: number | null;
  product_id: number | null;
  channels: string;
  cooldown_hours: number;
  is_demo: number;
}

interface ListingInfo {
  listing_id: number;
  listing_code: string | null;
  listing_title: string | null;
  listing_active: number;
  listing_is_demo: number;
  retailer_id: number;
  retailer_name: string;
  market_id: number;
  market_name: string;
  currency_code: string;
  product_id: number | null;
  product_name: string | null;
  brand_id: number | null;
  brand_name: string | null;
  ownership: 'own' | 'competitor' | null;
  category_id: number | null;
  subcategory_id: number | null;
  pack_size: number | null;
  pack_unit: string | null;
  units_per_pack: number | null;
  content_amount: number | null;
  content_dimension: 'volume' | 'mass' | 'count' | null;
  unit_factor: number | null;
}

const LISTING_COLUMNS = `li.listing_id, li.listing_code, li.listing_title, li.listing_active, li.listing_is_demo, li.retailer_id,
  li.retailer_name, li.market_id, li.market_name, li.currency_code, li.product_id, li.product_name, li.brand_id, li.brand_name,
  li.ownership, li.category_id, li.subcategory_id, li.pack_size, li.pack_unit, li.units_per_pack, li.content_amount,
  li.content_dimension, li.unit_factor`;

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------
const decimalsCache = new WeakMap<AppContext, Map<string, number>>();

function currencyDecimals(ctx: AppContext, code: string): number {
  let map = decimalsCache.get(ctx);
  if (!map || !map.has(code)) {
    map = new Map(ctx.db.all<{ code: string; decimals: number }>('SELECT code, decimals FROM currencies').map((c) => [c.code, c.decimals]));
    decimalsCache.set(ctx, map);
  }
  return map.get(code) ?? 2;
}

function money(ctx: AppContext, amount: number | null, currency: string, extraDecimals = 0): string {
  if (amount === null) return 'n/a';
  const d = currencyDecimals(ctx, currency) + extraDecimals;
  return `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

const signedPct = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const round = (value: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
};

const listingName = (li: ListingInfo) => li.product_name ?? li.listing_title ?? li.listing_code ?? `listing #${li.listing_id}`;
const packOf = (li: ListingInfo) => formatPack(li.pack_size, li.pack_unit, li.units_per_pack);
const withPack = (li: ListingInfo) => {
  const pack = packOf(li);
  const name = listingName(li);
  return pack === '—' ? name : `${name} (${pack})`;
};

function ageText(hours: number): string {
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------
function loadRules(ctx: AppContext, types: AlertType[]): RuleRecord[] {
  return ctx.db.all<RuleRecord>(
    `SELECT id, name, type, is_enabled, severity, threshold_pct, threshold_count, threshold_hours, market_id, retailer_id,
            brand_id, category_id, product_id, channels, cooldown_hours, is_demo
     FROM alert_rules WHERE is_enabled = 1 AND type IN (${placeholders(types.length)}) ORDER BY id`,
    types,
  );
}

function pctThreshold(rule: RuleRecord): number {
  return rule.threshold_pct ?? ALERT_TYPE_INFO[rule.type].defaultThreshold ?? 0;
}

function inScope(rule: RuleRecord, li: ListingInfo): boolean {
  if (rule.market_id !== null && rule.market_id !== li.market_id) return false;
  if (rule.retailer_id !== null && rule.retailer_id !== li.retailer_id) return false;
  if (rule.brand_id !== null && rule.brand_id !== li.brand_id) return false;
  if (rule.category_id !== null && rule.category_id !== li.category_id && rule.category_id !== li.subcategory_id) return false;
  if (rule.product_id !== null && rule.product_id !== li.product_id) return false;
  return true;
}

const DEFAULT_RULES: Array<{
  name: string;
  type: AlertType;
  severity: Severity;
  threshold_pct?: number;
  threshold_count?: number;
  is_enabled?: boolean;
}> = [
  { name: 'Competitor reduces price by 10% or more', type: 'competitor_price_drop', severity: 'warning', threshold_pct: 10 },
  { name: 'Own brand priced above a mapped competitor', type: 'own_more_expensive', severity: 'warning', threshold_pct: 0 },
  { name: 'Competitor launches a significant promotion (15%+)', type: 'competitor_promotion', severity: 'warning', threshold_pct: 15 },
  { name: 'Product becomes unavailable', type: 'product_unavailable', severity: 'warning' },
  // Fires on every selling-price move, so it ships switched off; enable it (optionally scoped) when wanted.
  { name: 'Retailer changes selling price (any change of 1%+)', type: 'price_change', severity: 'info', threshold_pct: 1, is_enabled: false },
  { name: 'Unexpected price increase (5%+)', type: 'price_increase', severity: 'warning', threshold_pct: 5 },
  { name: 'Collection failing repeatedly', type: 'collection_failed', severity: 'critical', threshold_count: 3 },
  { name: 'No fresh observation within the expected timeframe', type: 'stale_observation', severity: 'warning' },
];

/** Creates the standard rule set on an empty installation (configuration, not demo data). */
export function ensureDefaultAlertRules(ctx: AppContext): number {
  if ((ctx.db.scalar<number>('SELECT COUNT(*) FROM alert_rules') ?? 0) > 0) return 0;
  const now = nowIso();
  ctx.db.tx(() => {
    for (const rule of DEFAULT_RULES) {
      ctx.db.run(
        `INSERT INTO alert_rules (name, type, is_enabled, severity, threshold_pct, threshold_count, threshold_hours, channels, cooldown_hours, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, '["in_app"]', 0, 0, ?, ?)`,
        [rule.name, rule.type, rule.is_enabled === false ? 0 : 1, rule.severity, rule.threshold_pct ?? null, rule.threshold_count ?? null, now, now],
      );
    }
  });
  return DEFAULT_RULES.length;
}

// ---------------------------------------------------------------------------------------------
// Alert creation
// ---------------------------------------------------------------------------------------------
interface NewAlert {
  rule: RuleRecord;
  title: string;
  message: string;
  payload: unknown;
  listing_id: number | null;
  product_id: number | null;
  retailer_id: number | null;
  market_id: number | null;
  observation_id: number | null;
  job_id: number | null;
  dedupe_key: string;
  triggered_at: string;
  is_demo: number;
}

function insertAlert(ctx: AppContext, a: NewAlert): number | null {
  const res = ctx.db.run(
    `INSERT INTO alerts (rule_id, type, severity, title, message, status, listing_id, product_id, retailer_id, market_id,
       observation_id, job_id, payload, dedupe_key, triggered_at, is_demo)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    [
      a.rule.id, a.rule.type, a.rule.severity, a.title.slice(0, 300), a.message.slice(0, 2000), a.listing_id, a.product_id,
      a.retailer_id, a.market_id, a.observation_id, a.job_id, JSON.stringify(a.payload), a.dedupe_key, a.triggered_at, a.is_demo ? 1 : 0,
    ],
  );
  return res.changes > 0 ? res.lastInsertRowid : null;
}

/** True when the same rule already alerted on this listing within the rule's cool-down window before `at`. */
function inCooldown(ctx: AppContext, rule: RuleRecord, listingId: number | null, at: string, competitorListingId?: number): boolean {
  if (!(rule.cooldown_hours > 0) || listingId === null) return false;
  const since = new Date(Date.parse(at) - rule.cooldown_hours * 3_600_000).toISOString();
  const params: SqlParam[] = [rule.id, listingId, since, at];
  let sql = `SELECT 1 AS hit FROM alerts WHERE rule_id = ? AND listing_id = ? AND triggered_at > ? AND triggered_at <= ?`;
  if (competitorListingId !== undefined) {
    sql += ` AND json_extract(payload, '$.competitor.listing_id') = ?`;
    params.push(competitorListingId);
  }
  return !!ctx.db.get(`${sql} LIMIT 1`, params);
}

function loadListings(ctx: AppContext, listingIds: number[]): Map<number, ListingInfo> {
  const out = new Map<number, ListingInfo>();
  const unique = [...new Set(listingIds)];
  for (let i = 0; i < unique.length; i += 400) {
    const chunk = unique.slice(i, i + 400);
    const rows = ctx.db.all<ListingInfo>(
      `SELECT ${LISTING_COLUMNS} FROM v_listing_info li WHERE li.listing_id IN (${placeholders(chunk.length)})`,
      chunk,
    );
    for (const row of rows) out.set(row.listing_id, row);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Event rules
// ---------------------------------------------------------------------------------------------
function basePayload(e: PriceEvent, li: ListingInfo, threshold: number | null): PriceAlertPayload {
  return {
    event_kind: e.kind === 'promo_end' ? 'price_change' : e.kind,
    currency_code: li.currency_code,
    old_price: e.old_price,
    new_price: e.new_price,
    change_abs: e.change_abs,
    change_pct: e.change_pct,
    direction: e.direction,
    old_availability: e.old_availability,
    new_availability: e.new_availability,
    observed_at: e.occurred_at,
    local_date: e.occurred_local_date,
    pack: packOf(li),
    threshold,
    listing_title: li.listing_title,
  };
}

function priceLine(ctx: AppContext, e: PriceEvent, li: ListingInfo): string {
  const pct = e.change_pct === null ? '' : ` (${signedPct(e.change_pct)})`;
  return `${withPack(li)} at ${li.retailer_name}, ${li.market_name}: ${money(ctx, e.old_price, li.currency_code)} → ${money(ctx, e.new_price, li.currency_code)}${pct} on ${prettyDate(e.occurred_local_date)}.`;
}

interface Counterpart extends ListingInfo {
  mapping_id: number;
  equivalence: 'equivalent' | 'comparable';
  mapping_market_id: number | null;
  current_price: number;
  observed_at: string;
}

/**
 * Mapped counterpart products listed at the same retailer as `li`, each with its price as of `atIso`
 * (its most recent observation at or before that instant). Using the price that was valid at the time of
 * the event keeps the comparison truthful for live data and for replayed / back-filled history alike.
 */
function counterparts(ctx: AppContext, li: ListingInfo, atIso: string, cutoffIso: string): Counterpart[] {
  if (li.product_id === null || li.ownership === null) return [];
  const mine = li.ownership === 'own' ? 'cm.own_product_id' : 'cm.competitor_product_id';
  const theirs = li.ownership === 'own' ? 'cm.competitor_product_id' : 'cm.own_product_id';
  const rows = ctx.db.all<Omit<Counterpart, 'current_price' | 'observed_at'>>(
    `SELECT cm.id AS mapping_id, cm.equivalence, cm.market_id AS mapping_market_id, ${LISTING_COLUMNS}
     FROM competitor_mappings cm
     JOIN v_listing_info li ON li.product_id = ${theirs} AND li.retailer_id = ?
     WHERE ${mine} = ? AND cm.status = 'approved' AND (cm.market_id IS NULL OR cm.market_id = ?) AND li.listing_active = 1
     ORDER BY (cm.market_id IS NULL) ASC, cm.id ASC`,
    [li.retailer_id, li.product_id, li.market_id],
  );
  const out: Counterpart[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    // A market-specific mapping takes precedence over a global one for the same counterpart listing.
    if (seen.has(row.listing_id)) continue;
    seen.add(row.listing_id);
    const price = ctx.db.get<{ current_price: number | null; observed_at: string }>(
      `SELECT current_price, observed_at FROM v_observations WHERE listing_id = ? AND observed_at <= ? ORDER BY observed_at DESC, id DESC LIMIT 1`,
      [row.listing_id, atIso],
    );
    if (!price || price.current_price === null || price.observed_at < cutoffIso) continue;
    out.push({ ...row, current_price: price.current_price, observed_at: price.observed_at });
  }
  return out;
}

interface Comparison {
  basis: 'shelf' | 'unit';
  unitBasis: string | null;
  /** Converts a pack price of the own / competitor listing to the comparison basis. */
  own: (price: number) => number;
  competitor: (price: number) => number;
}

/**
 * How an own listing and a competitor listing may be compared:
 *   like-for-like packs of an 'equivalent' mapping → shelf price
 *   anything else                                   → price per 100 ml / 100 g / unit
 *   different content dimensions (ml vs g)          → not comparable (null)
 */
export function comparisonBasis(
  own: Pick<ListingInfo, 'content_amount' | 'content_dimension' | 'unit_factor'>,
  competitor: Pick<ListingInfo, 'content_amount' | 'content_dimension' | 'unit_factor'>,
  equivalence: 'equivalent' | 'comparable',
): Comparison | null {
  const ownKnown = own.content_amount !== null && own.content_amount > 0 && own.content_dimension !== null;
  const compKnown = competitor.content_amount !== null && competitor.content_amount > 0 && competitor.content_dimension !== null;
  if (ownKnown && compKnown && own.content_dimension !== competitor.content_dimension) return null;
  const identity = (price: number) => price;
  if (equivalence === 'equivalent') {
    const sameContent =
      ownKnown && compKnown && Math.abs(own.content_amount! - competitor.content_amount!) <= 1e-6 * Math.max(own.content_amount!, competitor.content_amount!);
    if (sameContent || !ownKnown || !compKnown) return { basis: 'shelf', unitBasis: null, own: identity, competitor: identity };
  }
  if (!ownKnown || !compKnown) return null;
  return {
    basis: 'unit',
    unitBasis: unitBasisLabel(own.content_dimension),
    own: (price) => (price * (own.unit_factor ?? 1)) / own.content_amount!,
    competitor: (price) => (price * (competitor.unit_factor ?? 1)) / competitor.content_amount!,
  };
}

const unitPriceOf = (li: ListingInfo, price: number): number | null =>
  li.content_amount && li.content_amount > 0 && li.unit_factor ? round((price * li.unit_factor) / li.content_amount, 4) : null;

function compared(li: ListingInfo, price: number, observedAt: string): ComparedListing {
  return {
    listing_id: li.listing_id,
    product_id: li.product_id!,
    product_name: listingName(li),
    brand_name: li.brand_name,
    pack: packOf(li),
    price,
    unit_price: unitPriceOf(li, price),
    observed_at: observedAt,
  };
}

function ownMoreExpensive(ctx: AppContext, rule: RuleRecord, e: PriceEvent, li: ListingInfo, created: number[]): void {
  if (e.old_price === null || e.new_price === null || li.ownership === null) return;
  const threshold = pctThreshold(rule);
  const cutoff = new Date(Date.parse(e.occurred_at) - COUNTERPART_MAX_AGE_DAYS * 86_400_000).toISOString();
  for (const other of counterparts(ctx, li, e.occurred_at, cutoff)) {
    const ownLi = li.ownership === 'own' ? li : other;
    const compLi = li.ownership === 'own' ? other : li;
    if (!inScope(rule, ownLi)) continue;
    const basis = comparisonBasis(ownLi, compLi, other.equivalence);
    if (!basis) continue;
    const ownChanged = li.ownership === 'own';
    const ownNow = basis.own(ownChanged ? e.new_price : other.current_price);
    const ownBefore = basis.own(ownChanged ? e.old_price : other.current_price);
    const compNow = basis.competitor(ownChanged ? other.current_price : e.new_price);
    const compBefore = basis.competitor(ownChanged ? other.current_price : e.old_price);
    if (!(compNow > 0) || !(compBefore > 0)) continue;
    const gapNow = ((ownNow - compNow) / compNow) * 100;
    const gapBefore = ((ownBefore - compBefore) / compBefore) * 100;
    const exceeds = (gap: number) => gap > 1e-9 && gap >= threshold - 1e-9;
    if (!exceeds(gapNow) || exceeds(gapBefore)) continue;
    if (inCooldown(ctx, rule, ownLi.listing_id, e.occurred_at, compLi.listing_id)) continue;

    const ownPrice = ownChanged ? e.new_price : other.current_price;
    const compPrice = ownChanged ? other.current_price : e.new_price;
    const payload: OwnMoreExpensivePayload = {
      mapping_id: other.mapping_id,
      equivalence: other.equivalence,
      basis: basis.basis,
      unit_basis: basis.unitBasis,
      currency_code: li.currency_code,
      own: compared(ownLi, ownPrice, ownChanged ? e.occurred_at : other.observed_at),
      competitor: compared(compLi, compPrice, ownChanged ? other.observed_at : e.occurred_at),
      gap_pct: round(gapNow, 2),
      gap_abs: round(ownNow - compNow, 4),
      previous_gap_pct: round(gapBefore, 2),
      trigger: ownChanged ? 'own_price_change' : 'competitor_price_change',
      threshold,
      local_date: e.occurred_local_date,
    };
    const basisText = basis.basis === 'shelf' ? 'pack price, like-for-like packs' : `price ${basis.unitBasis}${other.equivalence === 'comparable' ? ', non-equivalent products' : ''}`;
    const fmt = (v: number) => money(ctx, v, li.currency_code, basis.basis === 'unit' ? 1 : 0);
    const id = insertAlert(ctx, {
      rule,
      title: `Own product priced above competitor: ${listingName(ownLi)} vs ${listingName(compLi)} at ${li.retailer_name} (${signedPct(gapNow)})`,
      message:
        `${withPack(ownLi)} is now ${signedPct(gapNow)} against ${withPack(compLi)} at ${li.retailer_name}, ${li.market_name} ` +
        `(${basisText}): ${fmt(ownNow)} vs ${fmt(compNow)}. Before this ${ownChanged ? 'own' : 'competitor'} price change on ` +
        `${prettyDate(e.occurred_local_date)} the gap was ${signedPct(gapBefore)}. Shelf prices: own ${money(ctx, ownPrice, li.currency_code)}, competitor ${money(ctx, compPrice, li.currency_code)}.`,
      payload,
      listing_id: ownLi.listing_id,
      product_id: ownLi.product_id,
      retailer_id: li.retailer_id,
      market_id: li.market_id,
      observation_id: e.observation_id,
      job_id: null,
      dedupe_key: `rule:${rule.id}:obs:${e.observation_id}:own_vs:${ownLi.listing_id}:${compLi.listing_id}`,
      triggered_at: e.occurred_at,
      is_demo: e.is_demo || ownLi.listing_is_demo || compLi.listing_is_demo ? 1 : 0,
    });
    if (id) created.push(id);
  }
}

function evaluateEvent(
  ctx: AppContext,
  rule: RuleRecord,
  e: PriceEvent,
  li: ListingInfo,
  coincident: Set<string>,
  created: number[],
): void {
  if (rule.type === 'own_more_expensive') {
    if (e.kind === 'price_change') ownMoreExpensive(ctx, rule, e, li, created);
    return;
  }
  if (!inScope(rule, li)) return;
  const threshold = pctThreshold(rule);
  let title: string | null = null;
  let message = '';
  let payload: PriceAlertPayload | null = null;

  if (rule.type === 'competitor_price_drop') {
    if (e.kind !== 'price_change' || e.direction !== 'down' || li.ownership !== 'competitor' || e.change_pct === null) return;
    if (Math.abs(e.change_pct) < threshold - 1e-9) return;
    title = `Competitor price drop: ${listingName(li)} ${signedPct(e.change_pct)} at ${li.retailer_name}`;
    message = priceLine(ctx, e, li) + (coincident.has('promo_start') ? ' A promotion started with this change.' : '');
    payload = basePayload(e, li, threshold);
  } else if (rule.type === 'price_change') {
    if (e.kind !== 'price_change' || e.change_pct === null || Math.abs(e.change_pct) < threshold - 1e-9) return;
    title = `Price change: ${listingName(li)} ${signedPct(e.change_pct)} at ${li.retailer_name}`;
    message =
      priceLine(ctx, e, li) +
      (coincident.has('promo_start') ? ' A promotion started with this change.' : coincident.has('promo_end') ? ' A promotion ended with this change.' : '');
    payload = basePayload(e, li, threshold);
  } else if (rule.type === 'price_increase') {
    if (e.kind !== 'price_change' || e.direction !== 'up' || e.change_pct === null || e.new_price === null) return;
    let pct = e.change_pct;
    let note = '';
    // A price returning to its regular level when a promotion ends is expected, not an "unexpected increase".
    const prev = ctx.db.get<{ is_promo: number; regular_price: number | null }>('SELECT is_promo, regular_price FROM price_observations WHERE id = ?', [
      e.prev_observation_id,
    ]);
    if (prev?.is_promo === 1) {
      if (prev.regular_price === null || !(prev.regular_price > 0)) return;
      pct = round(((e.new_price - prev.regular_price) / prev.regular_price) * 100, 2);
      note = ` The previous price was promotional; against the previous regular price of ${money(ctx, prev.regular_price, li.currency_code)} the increase is ${signedPct(pct)}.`;
    }
    if (pct < threshold - 1e-9) return;
    title = `Price increase: ${listingName(li)} ${signedPct(pct)} at ${li.retailer_name}`;
    message = priceLine(ctx, e, li) + note;
    payload = basePayload(e, li, threshold);
    if (prev?.is_promo === 1) {
      payload.regular_price = prev.regular_price;
      payload.change_vs_regular_pct = pct;
    }
  } else if (rule.type === 'competitor_promotion') {
    if (e.kind !== 'promo_start' || li.ownership !== 'competitor') return;
    const obs = ctx.db.get<{
      regular_price: number | null;
      current_price: number | null;
      promo_price: number | null;
      discount_pct: number | null;
      promo_type: string | null;
      promo_description: string | null;
    }>('SELECT regular_price, current_price, promo_price, discount_pct, promo_type, promo_description FROM price_observations WHERE id = ?', [e.observation_id]);
    const discount = obs?.discount_pct ?? e.change_pct;
    // A promotion whose depth is unknown only counts when the rule accepts any promotion (threshold 0).
    if (discount === null ? threshold > 0 : discount < threshold - 1e-9) return;
    const depth = discount === null ? 'promotion started' : `${discount.toFixed(discount % 1 === 0 ? 0 : 1)}% off`;
    title = `Competitor promotion: ${listingName(li)} ${depth} at ${li.retailer_name}`;
    const promoPrice = obs?.promo_price ?? obs?.current_price ?? e.new_price;
    message =
      `${withPack(li)} at ${li.retailer_name}, ${li.market_name} went on promotion on ${prettyDate(e.occurred_local_date)}` +
      `${obs?.promo_description ? ` — "${obs.promo_description}"` : ''}: ` +
      `${money(ctx, promoPrice, li.currency_code)}${obs?.regular_price ? ` (regular ${money(ctx, obs.regular_price, li.currency_code)})` : ''}` +
      `${discount === null ? '; discount depth not stated' : `, ${depth}`}.`;
    payload = {
      ...basePayload(e, li, threshold),
      discount_pct: discount,
      promo_type: obs?.promo_type ?? null,
      promo_description: obs?.promo_description ?? null,
      promo_price: obs?.promo_price ?? null,
      regular_price: obs?.regular_price ?? null,
    };
  } else if (rule.type === 'product_unavailable') {
    if (e.kind !== 'availability_change' || e.new_availability !== 'out_of_stock') return;
    title = `Out of stock: ${listingName(li)} at ${li.retailer_name}`;
    const was = e.old_availability ? AVAILABILITY_LABELS[e.old_availability as Availability]?.toLowerCase() : null;
    message =
      `${withPack(li)} at ${li.retailer_name}, ${li.market_name} became unavailable on ${prettyDate(e.occurred_local_date)}` +
      `${was ? ` (previously ${was})` : ''}.` +
      `${e.old_price !== null ? ` Last selling price: ${money(ctx, e.old_price, li.currency_code)}.` : ''}`;
    payload = basePayload(e, li, null);
  }

  if (!title || !payload) return;
  if (inCooldown(ctx, rule, li.listing_id, e.occurred_at)) return;
  const id = insertAlert(ctx, {
    rule,
    title,
    message,
    payload,
    listing_id: li.listing_id,
    product_id: li.product_id,
    retailer_id: li.retailer_id,
    market_id: li.market_id,
    observation_id: e.observation_id,
    job_id: null,
    dedupe_key: `rule:${rule.id}:obs:${e.observation_id}:${e.kind}`,
    triggered_at: e.occurred_at,
    is_demo: e.is_demo || li.listing_is_demo ? 1 : 0,
  });
  if (id) created.push(id);
}

/**
 * Turns the change events of an ingestion batch into alerts. Idempotent: evaluating the same events
 * again creates nothing. Events older than `summary.alertMaxAgeHours` are ignored, so importing
 * history never raises alerts. Returns the number of alerts created.
 */
export function evaluateIngested(ctx: AppContext, summary: IngestedSummary): number {
  const created: number[] = [];
  const cutoff = new Date(Date.now() - summary.alertMaxAgeHours * 3_600_000).toISOString();
  const events = summary.events
    .filter((e) => e.occurred_at >= cutoff)
    .sort((a, b) => (a.occurred_at === b.occurred_at ? a.id - b.id : a.occurred_at < b.occurred_at ? -1 : 1));
  if (events.length > 0) {
    const rules = loadRules(ctx, EVENT_RULE_TYPES);
    if (rules.length > 0) {
      const listings = loadListings(ctx, events.map((e) => e.listing_id));
      const kindsByObservation = new Map<number, Set<string>>();
      for (const e of events) {
        const set = kindsByObservation.get(e.observation_id) ?? new Set<string>();
        set.add(e.kind);
        kindsByObservation.set(e.observation_id, set);
      }
      ctx.db.tx(() => {
        for (const e of events) {
          const li = listings.get(e.listing_id);
          if (!li) continue;
          for (const rule of rules) evaluateEvent(ctx, rule, e, li, kindsByObservation.get(e.observation_id)!, created);
        }
      });
    }
  }
  // Fresh observations may clear "no fresh observation" alerts straight away.
  if (summary.listingIds.length > 0) {
    const open = ctx.db
      .all<{ retailer_id: number }>(
        `SELECT DISTINCT retailer_id FROM alerts WHERE type = 'stale_observation' AND status IN ('open', 'acknowledged') AND retailer_id IS NOT NULL`,
      )
      .map((r) => r.retailer_id);
    if (open.length > 0) {
      const touched = new Set(summary.listingIds);
      const affected = open.filter((retailerId) =>
        ctx.db.all<{ id: number }>('SELECT id FROM retailer_listings WHERE retailer_id = ?', [retailerId]).some((l) => touched.has(l.id)),
      );
      if (affected.length > 0) runStateChecks(ctx, new Date(), { retailerIds: affected, only: 'stale_observation', notify: false });
    }
  }
  queueAlertNotifications(ctx, created);
  return created.length;
}

// ---------------------------------------------------------------------------------------------
// State rules
// ---------------------------------------------------------------------------------------------
interface ActiveStateAlert {
  id: number;
  retailer_id: number;
  status: string;
}

function activeStateAlerts(ctx: AppContext, rule: RuleRecord): Map<number, ActiveStateAlert> {
  const rows = ctx.db.all<ActiveStateAlert>(
    `SELECT id, retailer_id, status FROM alerts WHERE rule_id = ? AND type = ? AND status IN ('open', 'acknowledged') AND retailer_id IS NOT NULL ORDER BY id`,
    [rule.id, rule.type],
  );
  return new Map(rows.map((r) => [r.retailer_id, r]));
}

function resolveAutomatically(ctx: AppContext, alertId: number, note: string, at: string): void {
  ctx.db.run(`UPDATE alerts SET status = 'resolved', resolved_at = ?, resolved_by = NULL, resolution_note = ? WHERE id = ?`, [at, note, alertId]);
}

export interface StateCheckOptions {
  /** Restrict the check to these retailers (alerts of other retailers are left untouched). */
  retailerIds?: number[];
  only?: 'stale_observation' | 'collection_failed';
  /** Send notifications for newly opened alerts (default true). */
  notify?: boolean;
}

interface StaleListingRow {
  listing_id: number;
  listing_code: string | null;
  listing_created_at: string;
  retailer_id: number;
  retailer_name: string;
  retailer_is_demo: number;
  market_id: number;
  market_name: string;
  is_enabled: number;
  collection_method: CollectionMethod;
  frequency: Frequency | null;
  product_name: string | null;
  last_observed_at: string | null;
}

/** Freshness window (hours) that applies to a source. */
export function freshnessWindowHours(rule: Pick<RuleRecord, 'threshold_hours'>, source: { is_enabled: number; collection_method: string; frequency: string | null }): number {
  if (rule.threshold_hours !== null && rule.threshold_hours > 0) return rule.threshold_hours;
  const scheduled =
    source.is_enabled === 1 && (AUTOMATED_METHODS as string[]).includes(source.collection_method) && source.frequency !== null && source.frequency !== 'manual';
  // Paused sources and sources updated by people are judged by the manual window, not by a schedule they do not follow.
  return scheduled ? staleAfterHours(source.frequency as Frequency) : MANUAL_STALE_HOURS;
}

function checkStale(ctx: AppContext, rule: RuleRecord, now: Date, options: StateCheckOptions, result: StateCheckResult): void {
  const conditions = [`l.is_active = 1`, `l.match_status = 'matched'`, `r.is_active = 1`, `p.status = 'active'`];
  const params: SqlParam[] = [];
  const scope = (column: string, value: number | null) => {
    if (value !== null) {
      conditions.push(`${column} = ?`);
      params.push(value);
    }
  };
  scope('r.market_id', rule.market_id);
  scope('r.id', rule.retailer_id);
  scope('p.brand_id', rule.brand_id);
  scope('p.id', rule.product_id);
  if (rule.category_id !== null) {
    conditions.push('(p.category_id = ? OR p.subcategory_id = ?)');
    params.push(rule.category_id, rule.category_id);
  }
  if (options.retailerIds?.length) {
    conditions.push(`r.id IN (${placeholders(options.retailerIds.length)})`);
    params.push(...options.retailerIds);
  }
  const rows = ctx.db.all<StaleListingRow>(
    `SELECT l.id AS listing_id, l.code AS listing_code, l.created_at AS listing_created_at, r.id AS retailer_id, r.name AS retailer_name,
            r.is_demo AS retailer_is_demo, r.market_id, m.name AS market_name, r.is_enabled, r.collection_method,
            COALESCE(r.collection_frequency, m.default_frequency) AS frequency, p.name AS product_name, s.last_observed_at
     FROM retailer_listings l
     JOIN retailers r ON r.id = l.retailer_id
     JOIN markets m ON m.id = r.market_id
     JOIN products p ON p.id = l.product_id
     LEFT JOIN listing_state s ON s.listing_id = l.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.id, COALESCE(s.last_observed_at, '') ASC, l.id`,
    params,
  );

  interface Group {
    first: StaleListingRow;
    window: number;
    total: number;
    stale: StaleListingRow[];
    never: number;
    oldest: string | null;
  }
  const groups = new Map<number, Group>();
  for (const row of rows) {
    let g = groups.get(row.retailer_id);
    if (!g) {
      g = { first: row, window: freshnessWindowHours(rule, row), total: 0, stale: [], never: 0, oldest: null };
      groups.set(row.retailer_id, g);
    }
    g.total++;
    const limit = new Date(now.getTime() - g.window * 3_600_000).toISOString();
    if (row.last_observed_at === null) {
      if (row.listing_created_at < limit) {
        g.stale.push(row);
        g.never++;
      }
    } else if (row.last_observed_at < limit) {
      g.stale.push(row);
      if (g.oldest === null || row.last_observed_at < g.oldest) g.oldest = row.last_observed_at;
    }
  }

  const active = activeStateAlerts(ctx, rule);
  const at = now.toISOString();
  for (const [retailerId, g] of groups) {
    if (g.stale.length === 0) continue;
    const oldestAge = g.oldest ? round((now.getTime() - Date.parse(g.oldest)) / 3_600_000, 1) : null;
    const payload: StaleAlertPayload = {
      stale_count: g.stale.length,
      total_listings: g.total,
      never_observed: g.never,
      oldest_observed_at: g.oldest,
      oldest_age_hours: oldestAge,
      window_hours: g.window,
      frequency: g.first.frequency,
      sample: g.stale.slice(0, 5).map((l) => ({ listing_id: l.listing_id, listing_code: l.listing_code, product_name: l.product_name, last_observed_at: l.last_observed_at })),
      checked_at: at,
    };
    const title = `No fresh prices: ${g.stale.length} of ${g.total} listing${g.total === 1 ? '' : 's'} at ${g.first.retailer_name} (${g.first.market_name})`;
    const parts = [
      `${g.stale.length} of ${g.total} monitored listing${g.total === 1 ? '' : 's'} at ${g.first.retailer_name}, ${g.first.market_name} ${g.stale.length === 1 ? 'has' : 'have'} no observation within the expected ${ageText(g.window)} window.`,
    ];
    if (g.oldest && oldestAge !== null) parts.push(`Oldest latest observation: ${g.oldest.slice(0, 16).replace('T', ' ')} UTC (${ageText(oldestAge)} ago).`);
    if (g.never > 0) parts.push(`${g.never} ${g.never === 1 ? 'listing has' : 'listings have'} never been observed.`);
    if (g.first.is_enabled === 0) parts.push('This source is paused.');
    const message = parts.join(' ');
    const existing = active.get(retailerId);
    if (existing) {
      ctx.db.run('UPDATE alerts SET title = ?, message = ?, payload = ?, severity = ? WHERE id = ?', [title, message, JSON.stringify(payload), rule.severity, existing.id]);
      result.stale_observation.updated++;
    } else {
      const id = insertAlert(ctx, {
        rule,
        title,
        message,
        payload,
        listing_id: null,
        product_id: null,
        retailer_id: retailerId,
        market_id: g.first.market_id,
        observation_id: null,
        job_id: null,
        dedupe_key: `rule:${rule.id}:stale:retailer:${retailerId}:${at}`,
        triggered_at: at,
        is_demo: g.first.retailer_is_demo,
      });
      if (id) {
        result.stale_observation.opened++;
        result.opened_alert_ids.push(id);
      }
    }
  }
  for (const [retailerId, alert] of active) {
    if (options.retailerIds?.length && !options.retailerIds.includes(retailerId)) continue;
    const g = groups.get(retailerId);
    if (!g || g.stale.length === 0) {
      resolveAutomatically(ctx, alert.id, 'Resolved automatically: every monitored listing has a fresh observation again (or is no longer monitored).', at);
      result.stale_observation.resolved++;
    }
  }
}

interface FailingRetailerRow {
  id: number;
  name: string;
  market_id: number;
  market_name: string;
  is_demo: number;
  collection_method: string;
  consecutive_failures: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
}

function checkCollectionFailed(ctx: AppContext, rule: RuleRecord, now: Date, options: StateCheckOptions, result: StateCheckResult): void {
  const threshold = Math.max(1, rule.threshold_count ?? ALERT_TYPE_INFO.collection_failed.defaultThreshold ?? 3);
  const conditions = ['r.is_active = 1'];
  const params: SqlParam[] = [];
  if (rule.market_id !== null) {
    conditions.push('r.market_id = ?');
    params.push(rule.market_id);
  }
  if (rule.retailer_id !== null) {
    conditions.push('r.id = ?');
    params.push(rule.retailer_id);
  }
  if (options.retailerIds?.length) {
    conditions.push(`r.id IN (${placeholders(options.retailerIds.length)})`);
    params.push(...options.retailerIds);
  }
  const retailers = ctx.db.all<FailingRetailerRow>(
    `SELECT r.id, r.name, r.market_id, m.name AS market_name, r.is_demo, r.collection_method, r.consecutive_failures, r.last_attempt_at, r.last_success_at
     FROM retailers r JOIN markets m ON m.id = r.market_id WHERE ${conditions.join(' AND ')}`,
    params,
  );
  const active = activeStateAlerts(ctx, rule);
  const at = now.toISOString();
  const failing = new Set<number>();
  for (const r of retailers) {
    if (r.consecutive_failures < threshold) continue;
    failing.add(r.id);
    const lastJob = ctx.db.get<{ id: number; error_code: string | null; error_message: string | null }>(
      `SELECT id, error_code, error_message FROM collection_jobs
       WHERE retailer_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 1`,
      [r.id],
    );
    const payload: CollectionFailedPayload = {
      consecutive_failures: r.consecutive_failures,
      threshold,
      method: r.collection_method,
      last_attempt_at: r.last_attempt_at,
      last_success_at: r.last_success_at,
      last_error_code: lastJob?.error_code ?? null,
      last_error_message: lastJob?.error_message ?? null,
      checked_at: at,
    };
    const title = `Collection failing: ${r.name} (${r.market_name}) — ${r.consecutive_failures} consecutive failed runs`;
    const message =
      `Collection for ${r.name}, ${r.market_name} has failed ${r.consecutive_failures} times in a row (alert threshold ${threshold}).` +
      `${lastJob?.error_message ? ` Latest error: ${lastJob.error_message}` : ''}` +
      `${r.last_success_at ? ` Last successful collection: ${r.last_success_at.slice(0, 16).replace('T', ' ')} UTC.` : ' This source has never completed a successful collection.'}`;
    const existing = active.get(r.id);
    if (existing) {
      ctx.db.run('UPDATE alerts SET title = ?, message = ?, payload = ?, severity = ?, job_id = ? WHERE id = ?', [
        title, message, JSON.stringify(payload), rule.severity, lastJob?.id ?? null, existing.id,
      ]);
      result.collection_failed.updated++;
    } else {
      const id = insertAlert(ctx, {
        rule,
        title,
        message,
        payload,
        listing_id: null,
        product_id: null,
        retailer_id: r.id,
        market_id: r.market_id,
        observation_id: null,
        job_id: lastJob?.id ?? null,
        dedupe_key: `rule:${rule.id}:collection_failed:retailer:${r.id}:${at}`,
        triggered_at: at,
        is_demo: r.is_demo,
      });
      if (id) {
        result.collection_failed.opened++;
        result.opened_alert_ids.push(id);
      }
    }
  }
  for (const [retailerId, alert] of active) {
    if (options.retailerIds?.length && !options.retailerIds.includes(retailerId)) continue;
    if (!failing.has(retailerId)) {
      resolveAutomatically(ctx, alert.id, 'Resolved automatically: the source is no longer failing repeatedly.', at);
      result.collection_failed.resolved++;
    }
  }
}

/**
 * Closes the open state alerts of a rule that is being disabled or deleted — nothing would update or
 * resolve them any more. Returns the number of alerts resolved.
 */
export function resolveStateAlertsOfRule(ctx: AppContext, ruleId: number, reason: string): number {
  return ctx.db.run(
    `UPDATE alerts SET status = 'resolved', resolved_at = ?, resolved_by = NULL, resolution_note = ?
     WHERE rule_id = ? AND status IN ('open', 'acknowledged') AND type IN (${placeholders(STATE_RULE_TYPES.length)})`,
    [nowIso(), reason, ruleId, ...STATE_RULE_TYPES],
  ).changes;
}

/** Re-evaluates the state-based rules (stale observations, repeatedly failing collection). */
export function runStateChecks(ctx: AppContext, now: Date = new Date(), options: StateCheckOptions = {}): StateCheckResult {
  const result: StateCheckResult = {
    checked_at: now.toISOString(),
    stale_observation: { opened: 0, updated: 0, resolved: 0 },
    collection_failed: { opened: 0, updated: 0, resolved: 0 },
    opened_alert_ids: [],
  };
  const types = STATE_RULE_TYPES.filter((t) => !options.only || options.only === t);
  const rules = loadRules(ctx, types);
  ctx.db.tx(() => {
    for (const rule of rules) {
      if (rule.type === 'stale_observation') checkStale(ctx, rule, now, options, result);
      else checkCollectionFailed(ctx, rule, now, options, result);
    }
  });
  if (options.notify !== false) queueAlertNotifications(ctx, result.opened_alert_ids);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------
const registered = new WeakSet<AppContext>();
const lastStateCheck = new WeakMap<AppContext, number>();

/** Subscribes the alert engine to ingestion, collection and scheduler events (once per app instance). */
export function registerAlertEngine(ctx: AppContext): void {
  if (registered.has(ctx)) return;
  registered.add(ctx);
  ctx.hooks.observationsIngested.push((summary) => {
    evaluateIngested(ctx, summary);
  });
  ctx.hooks.collectionJobFinished.push((jobId) => {
    const job = ctx.db.get<{ retailer_id: number }>('SELECT retailer_id FROM collection_jobs WHERE id = ?', [jobId]);
    if (job) runStateChecks(ctx, new Date(), { retailerIds: [job.retailer_id], only: 'collection_failed' });
  });
  ctx.hooks.schedulerTick.push((now) => {
    const last = lastStateCheck.get(ctx) ?? 0;
    if (now.getTime() - last < STATE_CHECK_INTERVAL_MS) return;
    lastStateCheck.set(ctx, now.getTime());
    runStateChecks(ctx, now);
  });
}
