/**
 * Deterministic price model behind the DEMO dataset.
 *
 * It produces purely fictional, illustrative prices. The same model generates the seeded history and
 * the observations of the "simulated demo source" connector, so the demo timeline stays continuous
 * while the server runs. Everything it produces is stored with source_method = 'simulated' and
 * is_demo = 1 — it is never presented as a real market observation.
 */
import type { ObservationInput } from '../services/ingestion.ts';
import type { DealTag, PromoType } from '../../shared/constants.ts';
import { addDays } from '../lib/time.ts';

export interface DemoProfile {
  /** PRNG seed (stable per listing). */
  seed: number;
  /** Regular price on day 0, in the retailer's currency. */
  base: number;
  /** Price rounding step (0.25 → …, 12.25, 12.50, …). */
  step: number;
  /** Approximate share of days spent on promotion (0–0.6). */
  promo: number;
  /** Possible discount depths, e.g. [0.1, 0.2, 0.25]. */
  depths: number[];
  /** Promotion mechanics this listing uses (repeat an entry to weight it). */
  types: PromoType[];
  /** Size of occasional regular-price moves (0.05 ≈ −5 % … +7 %). */
  drift: number;
  /** Daily probability of an out-of-stock episode starting. */
  oos: number;
  /** Seller named with the listing: the retailer itself or a fictional marketplace seller. */
  seller?: string;
  /** What the sales rank refers to ("Shampoo" → "#12 in Shampoo"). Listings without it carry no sales rank. */
  rankIn?: string;
}

export interface DemoDayState {
  day: number;
  regular: number;
  current: number;
  promoPrice: number | null;
  discountPct: number | null;
  isPromo: boolean;
  promoType: PromoType | null;
  promoDescription: string | null;
  promoStartDay: number | null;
  promoEndDay: number | null;
  availability: 'in_stock' | 'out_of_stock';
  // ---- fictional signals shown with the price (all DEMO, like the price itself) ----
  tags: DealTag[];
  tagText: string | null;
  rating: number;
  reviewCount: number;
  salesRank: number | null;
  salesRankLabel: string | null;
  sellerName: string | null;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a), used to derive seeds. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function roundToStep(value: number, step: number): number {
  const rounded = Math.round(value / step) * step;
  return Math.max(step, Math.round(rounded * 10000) / 10000);
}

const PROMO_LENGTH_MIN = 4;
const PROMO_LENGTH_RANGE = 9; // 4–12 days

/** Fictional sale events named by the demo deal tags; a new one roughly every month of the demo timeline. */
const DEMO_SALE_EVENTS = ['Mega Sale', 'Payday Sale', 'Summer Sale', 'Anniversary Sale'];
const DEMO_EVENT_LENGTH_DAYS = 30;

/**
 * The signals of one listing that do not change from day to day. They come from their own keyed random
 * numbers, so adding signals left every simulated price exactly as it was.
 */
function listingSignals(profile: DemoProfile) {
  const u = (salt: string) => keyedRandom(`${salt}:${profile.seed}`);
  const bestSeller = u('best-seller') < 0.06;
  return {
    /** Stable between 3.8 and 4.8. */
    rating: Math.round((3.8 + u('rating')) * 10) / 10,
    reviewBase: 20 + Math.floor(u('reviews') ** 2 * 3500),
    /** New reviews per day (0.1 – 2.5): the count only ever grows, slowly. */
    reviewGrowth: 0.1 + u('review-growth') * 2.4,
    bestSeller,
    retailerChoice: !bestSeller && !!profile.rankIn && u('choice') < 0.05,
    /** Best sellers hold rank 1–3; everything else sits further down and drifts a little from week to week. */
    rankBase: profile.rankIn ? (bestSeller ? 1 + Math.floor(u('rank') * 3) : 4 + Math.floor(u('rank') * 140)) : null,
  };
}

/** Simulates day 0 … `untilDay` (inclusive) and returns one state per day. */
export function simulateDays(profile: DemoProfile, untilDay: number): DemoDayState[] {
  const rng = mulberry32(profile.seed);
  const avgLength = PROMO_LENGTH_MIN + (PROMO_LENGTH_RANGE - 1) / 2;
  const share = Math.min(0.6, Math.max(0, profile.promo));
  const gap = share > 0 ? (avgLength * (1 - share)) / share : Number.POSITIVE_INFINITY;

  let regular = roundToStep(profile.base, profile.step);
  let nextShiftDay = 20 + Math.floor(rng() * 45);
  let promoActive = false;
  let promoStart = 0;
  let promoEnd = 0;
  let promoDepth = 0;
  let promoType: PromoType = 'price_cut';
  let nextPromoDay = Number.isFinite(gap) ? Math.floor(rng() * gap * 1.2) : Number.POSITIVE_INFINITY;
  let oosEnd = -1;
  const signals = listingSignals(profile);

  const out: DemoDayState[] = [];
  for (let day = 0; day <= untilDay; day++) {
    // A fixed number of draws per day keeps the sequence stable regardless of which branches run.
    const r = [rng(), rng(), rng(), rng(), rng(), rng()] as [number, number, number, number, number, number];

    if (day >= nextShiftDay) {
      regular = roundToStep(regular * (1 + (r[0] * 2.4 - 1) * profile.drift), profile.step);
      nextShiftDay = day + 30 + Math.floor(r[5] * 45);
    }
    if (promoActive && day >= promoEnd) {
      promoActive = false;
      nextPromoDay = day + Math.max(2, Math.round(gap * (0.5 + r[5])));
    }
    if (!promoActive && day >= nextPromoDay && profile.depths.length > 0 && profile.types.length > 0) {
      promoActive = true;
      promoStart = day;
      promoEnd = day + PROMO_LENGTH_MIN + Math.floor(r[1] * PROMO_LENGTH_RANGE);
      promoDepth = profile.depths[Math.floor(r[2] * profile.depths.length)]!;
      promoType = profile.types[Math.floor(r[3] * profile.types.length)]!;
    }
    if (day > oosEnd && r[4] < profile.oos) oosEnd = day + Math.floor(r[0] * 3);

    let current = regular;
    let promoPrice: number | null = null;
    let discountPct: number | null = null;
    let description: string | null = null;
    if (promoActive) {
      const pct = Math.round(promoDepth * 100);
      if (promoType === 'price_cut') {
        current = roundToStep(regular * (1 - promoDepth), profile.step);
        if (current >= regular) current = roundToStep(regular - profile.step, profile.step);
        promoPrice = current;
        description = `Save ${pct}%`;
      } else if (promoType === 'multi_buy') {
        promoPrice = Math.round(regular * (1 - promoDepth) * 1000) / 1000;
        discountPct = pct;
        description = `Buy 2, save ${pct}%`;
      } else if (promoType === 'coupon') {
        const couponPct = pct >= 20 ? 15 : 10;
        promoPrice = Math.round(regular * (1 - couponPct / 100) * 1000) / 1000;
        discountPct = couponPct;
        description = `Extra ${couponPct}% off with coupon`;
      } else {
        description = 'Bundle offer: free travel size with purchase';
      }
    }

    // Tags follow the offer: the mechanic names its own tag, deeper price cuts are sometimes badged as a
    // limited-time or sale-event deal. One draw per promotion, so the badge stays for the whole offer.
    const tags: DealTag[] = [];
    let tagText: string | null = null;
    if (promoActive) {
      const roll = keyedRandom(`tag:${profile.seed}:${promoStart}`);
      if (promoType === 'multi_buy' || promoType === 'coupon') {
        tags.push(promoType);
        tagText = description;
      } else if (promoType === 'price_cut' && promoDepth >= 0.25) {
        if (roll < 0.45) {
          tags.push('limited_time_deal');
          tagText = 'Limited time deal';
        } else if (roll < 0.8) {
          tags.push('event_deal');
          tagText = `${DEMO_SALE_EVENTS[Math.floor(promoStart / DEMO_EVENT_LENGTH_DAYS) % DEMO_SALE_EVENTS.length]} Deal`;
        }
      } else if (promoType === 'price_cut' && roll < 0.3) {
        tags.push('deal');
        tagText = 'Deal';
      }
    }
    if (signals.bestSeller) tags.push('best_seller');
    if (signals.retailerChoice) tags.push('retailer_choice');
    let salesRank = signals.rankBase;
    if (salesRank !== null && !signals.bestSeller) {
      const drift = (keyedRandom(`rank-week:${profile.seed}:${Math.floor(day / 7)}`) - 0.5) * salesRank * 0.25;
      salesRank = Math.max(4, salesRank + Math.round(drift));
    }

    out.push({
      day,
      regular,
      current,
      promoPrice,
      discountPct,
      isPromo: promoActive,
      promoType: promoActive ? promoType : null,
      promoDescription: description,
      promoStartDay: promoActive ? promoStart : null,
      promoEndDay: promoActive ? promoEnd - 1 : null,
      availability: day <= oosEnd ? 'out_of_stock' : 'in_stock',
      tags,
      tagText,
      rating: signals.rating,
      reviewCount: signals.reviewBase + Math.floor(day * signals.reviewGrowth),
      salesRank,
      salesRankLabel: salesRank === null ? null : `#${salesRank} in ${profile.rankIn}`,
      sellerName: profile.seller ?? null,
    });
  }
  return out;
}

export function stateOnDay(profile: DemoProfile, day: number): DemoDayState {
  const states = simulateDays(profile, Math.max(0, day));
  return states[states.length - 1]!;
}

/** Turns a simulated day into an observation ready for ingestion. */
export function demoObservation(listingId: number, state: DemoDayState, observedAt: string, epochDate: string): ObservationInput {
  return {
    listing_id: listingId,
    observed_at: observedAt,
    observed_basis: 'exact',
    regular_price: state.regular,
    current_price: state.current,
    promo_price: state.promoPrice,
    discount_pct: state.discountPct,
    is_promo: state.isPromo,
    promo_type: state.promoType,
    promo_description: state.promoDescription,
    promo_starts_on: state.promoStartDay === null ? null : addDays(epochDate, state.promoStartDay),
    promo_ends_on: state.promoEndDay === null ? null : addDays(epochDate, state.promoEndDay),
    availability: state.availability,
    confidence: 1,
    collection_status: 'complete',
    tags: state.tags,
    tag_text: state.tagText,
    rating: state.rating,
    review_count: state.reviewCount,
    sales_rank: state.salesRank,
    sales_rank_label: state.salesRankLabel,
    seller_name: state.sellerName,
  };
}

/** Deterministic pseudo-random number in [0, 1) for an arbitrary key (used for simulated run outcomes). */
export function keyedRandom(key: string): number {
  return mulberry32(hashSeed(key))();
}

/** Shape stored in `retailers.connector_config` for simulated demo sources. */
export interface SimulatedConnectorConfig {
  simulated: {
    /** Probability that a scheduled run fails (demonstrates failure handling and retries). */
    failure_rate: number;
    /** Demo price profile per listing id. Listings without a profile are reported as missing. */
    profiles: Record<string, DemoProfile>;
  };
}
