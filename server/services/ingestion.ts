/**
 * Ingestion: the single entry point through which every price observation enters the ledger —
 * scheduled collection, CSV imports, manual entry and the demo generator alike.
 *
 * Guarantees
 *   * append-only: observations are only ever INSERTed (the database rejects UPDATE/DELETE as well)
 *   * idempotent: re-ingesting an identical fact (same listing, instant and values) is skipped
 *   * corrections never overwrite: a different value for the same listing and instant supersedes the
 *     older record by *voiding* it — the original row stays in the ledger
 */
import type { AppContext, PriceEvent } from '../context.ts';
import { fireHook } from '../context.ts';
import { placeholders, SqliteError } from '../db/sqlite.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { isIsoDate, localDate, nowIso } from '../lib/time.ts';
import type { Availability, CollectionMethod, PromoType } from '../../shared/constants.ts';
import { AVAILABILITY, PROMO_TYPES } from '../../shared/constants.ts';
import { getSetting } from './core.ts';
import { refreshListingDerived, type ObsRow } from './derived.ts';

export interface ObservationInput {
  listing_id: number;
  /** When the price was true, as a UTC ISO-8601 instant. */
  observed_at: string;
  observed_basis?: 'exact' | 'date_only' | 'import_time';
  currency_code?: string | null;
  regular_price?: number | null;
  current_price?: number | null;
  promo_price?: number | null;
  discount_pct?: number | null;
  is_promo?: boolean | null;
  promo_type?: PromoType | null;
  promo_description?: string | null;
  promo_starts_on?: string | null;
  promo_ends_on?: string | null;
  availability?: Availability | null;
  product_url?: string | null;
  source_timestamp?: string | null;
  evidence_id?: number | null;
  confidence?: number | null;
  collection_status?: 'complete' | 'partial';
  note?: string | null;
  /** When this particular row was captured (overrides IngestOptions.collectedAt). */
  collected_at?: string | null;
}

export interface IngestOptions {
  sourceMethod: CollectionMethod;
  jobId?: number | null;
  importBatchId?: number | null;
  userId?: number | null;
  /** When this system captured the data. Defaults to now. */
  collectedAt?: string;
  /** Marks rows as DEMO even when the listing itself is not flagged (used by the demo seeder only). */
  forceDemo?: boolean;
  /** Skip alert evaluation entirely (bulk history loads). */
  suppressAlerts?: boolean;
  /** Override of the "recent enough to alert on" window. */
  alertMaxAgeHours?: number;
}

export interface RejectedObservation {
  index: number;
  listing_id: number;
  reason: string;
}

export interface IngestResult {
  inserted: number;
  duplicates: number;
  superseded: number;
  rejected: RejectedObservation[];
  observationIds: number[];
  /** Index (in the input array) → new observation id, for callers that need to link rows. */
  idByIndex: Map<number, number>;
  affectedListingIds: number[];
  events: PriceEvent[];
}

interface ListingContext {
  id: number;
  retailer_id: number;
  market_id: number;
  currency_code: string;
  timezone: string;
  is_demo: number;
}

export interface NormalisedObservation {
  listing_id: number;
  retailer_id: number;
  market_id: number;
  currency_code: string;
  regular_price: number | null;
  current_price: number | null;
  promo_price: number | null;
  discount_pct: number | null;
  is_promo: number;
  promo_type: PromoType | null;
  promo_description: string | null;
  promo_starts_on: string | null;
  promo_ends_on: string | null;
  availability: Availability;
  product_url: string | null;
  observed_at: string;
  observed_basis: 'exact' | 'date_only' | 'import_time';
  observed_local_date: string;
  source_timestamp: string | null;
  collection_status: 'complete' | 'partial';
  confidence: number | null;
  evidence_id: number | null;
  note: string | null;
  dedupe_key: string;
}

const MAX_PRICE = 1_000_000_000;
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

const round = (value: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
};

function cleanPrice(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} is not a number`);
  if (value < 0) throw new Error(`${label} cannot be negative`);
  if (value > MAX_PRICE) throw new Error(`${label} is implausibly large`);
  return round(value, 4);
}

const text = (value: string | null | undefined, max: number): string | null => {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t ? t.slice(0, max) : null;
};

const fmt = (value: number | null) => (value === null ? '' : value.toFixed(4));

/**
 * Validates one observation and applies the pricing rules. Pure: throws an Error with a
 * human-readable reason when the observation cannot be accepted.
 */
export function normaliseObservation(input: ObservationInput, listing: ListingContext, now = Date.now()): NormalisedObservation {
  const observed = new Date(input.observed_at);
  if (!input.observed_at || Number.isNaN(observed.getTime())) throw new Error('Observation timestamp is missing or invalid');
  if (observed.getTime() > now + FUTURE_TOLERANCE_MS) throw new Error('Observation timestamp is in the future');
  if (observed.getUTCFullYear() < 2000) throw new Error('Observation timestamp is implausibly old');
  const observedAt = observed.toISOString();

  const currency = (input.currency_code ?? listing.currency_code).toUpperCase();
  if (currency !== listing.currency_code) {
    throw new Error(`Currency ${currency} does not match the retailer currency ${listing.currency_code}`);
  }

  let regular = cleanPrice(input.regular_price, 'Regular price');
  let current = cleanPrice(input.current_price, 'Current price');
  let promo = cleanPrice(input.promo_price, 'Promotional price');
  if (regular === 0) regular = null;
  if (promo === 0) promo = null;
  if (current === 0) throw new Error('Current price must be greater than zero');

  const availability: Availability = input.availability ?? 'unknown';
  if (!AVAILABILITY.includes(availability)) throw new Error(`Unknown availability "${String(input.availability)}"`);

  let promoType = input.promo_type ?? null;
  if (promoType && !PROMO_TYPES.includes(promoType)) throw new Error(`Unknown promotion type "${String(input.promo_type)}"`);
  const description = text(input.promo_description, 500);

  // Selling price: fall back to the promotional price, then to the regular price.
  if (current === null && promo !== null) current = promo;
  if (current === null && regular !== null && availability !== 'out_of_stock') current = regular;
  if (current === null && availability !== 'out_of_stock') {
    throw new Error('A selling price is required unless the product is out of stock');
  }

  // A plain price cut reported separately from the shelf price: the shopper pays the promo price.
  const priceLed = promoType === null || promoType === 'price_cut';
  if (priceLed && promo !== null && current !== null && promo < current) {
    if (regular === null) regular = current;
    current = promo;
  }

  const cutVsRegular = regular !== null && current !== null && current < regular * 0.995;
  const promoBelowRegular = promo !== null && (regular === null || promo < regular);
  let isPromo = input.is_promo === true || cutVsRegular || promoBelowRegular || promoType !== null || description !== null;
  if (input.is_promo === false && !cutVsRegular && promoType === null) isPromo = false;

  let discount: number | null = null;
  if (isPromo) {
    if (promo === null && cutVsRegular) promo = current;
    if (promoType === null) promoType = cutVsRegular || promoBelowRegular ? 'price_cut' : 'other';
    const effective = promo ?? current;
    if (input.discount_pct !== null && input.discount_pct !== undefined) {
      if (!Number.isFinite(input.discount_pct) || input.discount_pct < 0 || input.discount_pct > 100) {
        throw new Error('Discount percentage must be between 0 and 100');
      }
      discount = round(input.discount_pct, 2);
    } else if (regular !== null && regular > 0 && effective !== null && effective < regular) {
      discount = round(((regular - effective) / regular) * 100, 2);
    }
  } else {
    promo = null;
    promoType = null;
  }

  const startsOn = text(input.promo_starts_on, 10);
  const endsOn = text(input.promo_ends_on, 10);
  if (startsOn && !isIsoDate(startsOn)) throw new Error('Promotion start date must be YYYY-MM-DD');
  if (endsOn && !isIsoDate(endsOn)) throw new Error('Promotion end date must be YYYY-MM-DD');
  if (startsOn && endsOn && endsOn < startsOn) throw new Error('Promotion end date is before its start date');

  let confidence: number | null = null;
  if (input.confidence !== null && input.confidence !== undefined) {
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error('Confidence must be between 0 and 1');
    }
    confidence = round(input.confidence, 3);
  }

  let sourceTimestamp: string | null = null;
  if (input.source_timestamp) {
    const st = new Date(input.source_timestamp);
    sourceTimestamp = Number.isNaN(st.getTime()) ? null : st.toISOString();
  }

  // Identity of the fact: listing + instant + values. The channel it arrived through is irrelevant.
  const dedupeKey = sha256Hex(
    [listing.id, observedAt, fmt(current), fmt(regular), fmt(promo), availability, currency, isPromo ? promoType : ''].join('|'),
  );

  return {
    listing_id: listing.id,
    retailer_id: listing.retailer_id,
    market_id: listing.market_id,
    currency_code: currency,
    regular_price: regular,
    current_price: current,
    promo_price: isPromo ? promo : null,
    discount_pct: discount,
    is_promo: isPromo ? 1 : 0,
    promo_type: isPromo ? promoType : null,
    promo_description: isPromo ? description : null,
    promo_starts_on: isPromo ? startsOn : null,
    promo_ends_on: isPromo ? endsOn : null,
    availability,
    product_url: text(input.product_url, 2000),
    observed_at: observedAt,
    observed_basis: input.observed_basis ?? 'exact',
    observed_local_date: localDate(observed, listing.timezone),
    source_timestamp: sourceTimestamp,
    collection_status: input.collection_status ?? 'complete',
    confidence,
    evidence_id: input.evidence_id ?? null,
    note: text(input.note, 1000),
    dedupe_key: dedupeKey,
  };
}

const INSERT_COLUMNS = [
  'listing_id', 'retailer_id', 'market_id', 'currency_code', 'regular_price', 'current_price', 'promo_price', 'discount_pct',
  'is_promo', 'promo_type', 'promo_description', 'promo_starts_on', 'promo_ends_on', 'availability', 'product_url',
  'observed_at', 'observed_basis', 'observed_local_date', 'collected_at', 'source_timestamp', 'source_method',
  'collection_status', 'confidence', 'evidence_id', 'job_id', 'import_batch_id', 'entered_by', 'note', 'dedupe_key',
  'is_demo', 'created_at',
] as const;
const INSERT_SQL = `INSERT INTO price_observations (${INSERT_COLUMNS.join(', ')}) VALUES (${placeholders(INSERT_COLUMNS.length)})`;

export function loadListingContexts(ctx: AppContext, listingIds: number[]): Map<number, ListingContext> {
  const out = new Map<number, ListingContext>();
  const unique = [...new Set(listingIds)];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = ctx.db.all<ListingContext>(
      `SELECT l.id, l.retailer_id, r.market_id, r.currency_code, m.timezone, l.is_demo
       FROM retailer_listings l JOIN retailers r ON r.id = l.retailer_id JOIN markets m ON m.id = r.market_id
       WHERE l.id IN (${placeholders(chunk.length)})`,
      chunk,
    );
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

/** Validates without writing (used by import previews). */
export function validateObservations(
  ctx: AppContext,
  inputs: ObservationInput[],
): { valid: Array<{ index: number; row: NormalisedObservation }>; rejected: RejectedObservation[] } {
  const listings = loadListingContexts(ctx, inputs.map((i) => i.listing_id));
  const valid: Array<{ index: number; row: NormalisedObservation }> = [];
  const rejected: RejectedObservation[] = [];
  const now = Date.now();
  inputs.forEach((input, index) => {
    const listing = listings.get(input.listing_id);
    if (!listing) {
      rejected.push({ index, listing_id: input.listing_id, reason: 'Listing does not exist' });
      return;
    }
    try {
      valid.push({ index, row: normaliseObservation(input, listing, now) });
    } catch (err) {
      rejected.push({ index, listing_id: input.listing_id, reason: (err as Error).message });
    }
  });
  return { valid, rejected };
}

/** Writes observations to the ledger and brings derived state, promotions and alerts up to date. */
export function ingestObservations(ctx: AppContext, inputs: ObservationInput[], options: IngestOptions): IngestResult {
  const result: IngestResult = {
    inserted: 0,
    duplicates: 0,
    superseded: 0,
    rejected: [],
    observationIds: [],
    idByIndex: new Map(),
    affectedListingIds: [],
    events: [],
  };
  if (inputs.length === 0) return result;

  const listings = loadListingContexts(ctx, inputs.map((i) => i.listing_id));
  const collectedAt = options.collectedAt ?? nowIso();
  const now = Date.now();
  const insertedByListing = new Map<number, ObsRow[]>();
  const supersededListings = new Set<number>();

  ctx.db.tx(() => {
    inputs.forEach((input, index) => {
      const listing = listings.get(input.listing_id);
      if (!listing) {
        result.rejected.push({ index, listing_id: input.listing_id, reason: 'Listing does not exist' });
        return;
      }
      if (options.sourceMethod === 'simulated' && !listing.is_demo) {
        result.rejected.push({ index, listing_id: listing.id, reason: 'Simulated observations are only allowed on demo listings' });
        return;
      }
      let row: NormalisedObservation;
      try {
        row = normaliseObservation(input, listing, now);
      } catch (err) {
        result.rejected.push({ index, listing_id: listing.id, reason: (err as Error).message });
        return;
      }
      const isDemo = listing.is_demo || options.forceDemo ? 1 : 0;
      const createdAt = nowIso();
      const record: Record<(typeof INSERT_COLUMNS)[number], unknown> = {
        ...row,
        collected_at: input.collected_at ?? collectedAt,
        source_method: options.sourceMethod,
        job_id: options.jobId ?? null,
        import_batch_id: options.importBatchId ?? null,
        entered_by: options.userId ?? null,
        is_demo: isDemo,
        created_at: createdAt,
      };
      let id: number;
      try {
        id = ctx.db.run(INSERT_SQL, INSERT_COLUMNS.map((c) => record[c]) as never).lastInsertRowid;
      } catch (err) {
        if (err instanceof SqliteError && err.code === 'UNIQUE') {
          result.duplicates++;
          return;
        }
        throw err;
      }

      // Same listing and instant but different values → the newer record supersedes the older one.
      const clashes = ctx.db.all<{ id: number }>(
        `SELECT o.id FROM price_observations o
         WHERE o.listing_id = ? AND o.observed_at = ? AND o.id <> ?
           AND NOT EXISTS (SELECT 1 FROM observation_voids v WHERE v.observation_id = o.id)`,
        [row.listing_id, row.observed_at, id],
      );
      for (const clash of clashes) {
        ctx.db.run(
          `INSERT INTO observation_voids (observation_id, reason, voided_by, voided_at, import_batch_id) VALUES (?, ?, ?, ?, ?)`,
          [clash.id, `Superseded by observation #${id} recorded for the same timestamp`, options.userId ?? null, createdAt, options.importBatchId ?? null],
        );
        result.superseded++;
        supersededListings.add(row.listing_id);
      }

      result.inserted++;
      result.observationIds.push(id);
      result.idByIndex.set(index, id);
      const obs: ObsRow = {
        id,
        listing_id: row.listing_id,
        retailer_id: row.retailer_id,
        market_id: row.market_id,
        currency_code: row.currency_code,
        regular_price: row.regular_price,
        current_price: row.current_price,
        promo_price: row.promo_price,
        discount_pct: row.discount_pct,
        is_promo: row.is_promo,
        promo_type: row.promo_type,
        promo_description: row.promo_description,
        promo_starts_on: row.promo_starts_on,
        promo_ends_on: row.promo_ends_on,
        availability: row.availability,
        observed_at: row.observed_at,
        observed_local_date: row.observed_local_date,
        is_demo: isDemo,
      };
      const list = insertedByListing.get(row.listing_id);
      if (list) list.push(obs);
      else insertedByListing.set(row.listing_id, [obs]);
    });

    for (const [listingId, rows] of insertedByListing) {
      result.events.push(...refreshListingDerived(ctx, listingId, rows, supersededListings.has(listingId)));
      ctx.db.run(
        `UPDATE retailer_listings SET first_seen_at = COALESCE(first_seen_at, ?), last_seen_at = ? WHERE id = ?`,
        [collectedAt, collectedAt, listingId],
      );
    }
  });

  result.affectedListingIds = [...insertedByListing.keys()];
  if (result.inserted > 0 && !options.suppressAlerts) {
    fireHook(ctx, ctx.hooks.observationsIngested, {
      sourceMethod: options.sourceMethod,
      isDemo: options.forceDemo === true || [...insertedByListing.keys()].every((id) => listings.get(id)?.is_demo === 1),
      listingIds: result.affectedListingIds,
      events: result.events,
      alertMaxAgeHours: options.alertMaxAgeHours ?? getSetting(ctx, 'alert_max_age_hours'),
    });
  }
  return result;
}

/** Marks an observation as void (kept in the ledger, excluded from analytics) and refreshes derived state. */
export function voidObservation(ctx: AppContext, observationId: number, reason: string, userId: number | null): void {
  const obs = ctx.db.get<{ id: number; listing_id: number }>('SELECT id, listing_id FROM price_observations WHERE id = ?', [observationId]);
  if (!obs) throw new Error('Observation not found');
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO observation_voids (observation_id, reason, voided_by, voided_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(observation_id) DO NOTHING`,
      [observationId, reason, userId, nowIso()],
    );
    refreshListingDerived(ctx, obs.listing_id, [], true);
  });
}

export function restoreObservation(ctx: AppContext, observationId: number): void {
  const obs = ctx.db.get<{ id: number; listing_id: number }>('SELECT id, listing_id FROM price_observations WHERE id = ?', [observationId]);
  if (!obs) throw new Error('Observation not found');
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM observation_voids WHERE observation_id = ?', [observationId]);
    refreshListingDerived(ctx, obs.listing_id, [], true);
  });
}
