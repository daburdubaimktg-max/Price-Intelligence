/**
 * Derived state maintained from the observation ledger:
 *   listing_state  – pointer to the latest / previous observation of each listing
 *   price_events   – changes between consecutive observations (price, availability, promo start/end)
 *   promotions     – promotion episodes (runs of consecutive promotional observations)
 *
 * None of this is a source of truth. Everything here can be rebuilt from price_observations at any time
 * (`rebuildAllDerived`). The incremental path and the rebuild path share the same pure reducers, so they
 * always agree.
 */
import type { AppContext, PriceEvent } from '../context.ts';
import { placeholders } from '../db/sqlite.ts';
import { diffDays, nowIso } from '../lib/time.ts';
import { getSetting } from './core.ts';

export interface ObsRow {
  id: number;
  listing_id: number;
  retailer_id: number;
  market_id: number;
  currency_code: string;
  regular_price: number | null;
  current_price: number | null;
  promo_price: number | null;
  discount_pct: number | null;
  is_promo: number;
  promo_type: string | null;
  promo_description: string | null;
  promo_starts_on: string | null;
  promo_ends_on: string | null;
  availability: string;
  observed_at: string;
  observed_local_date: string;
  is_demo: number;
}

const OBS_COLUMNS = `id, listing_id, retailer_id, market_id, currency_code, regular_price, current_price, promo_price,
  discount_pct, is_promo, promo_type, promo_description, promo_starts_on, promo_ends_on, availability,
  observed_at, observed_local_date, is_demo`;

interface Episode {
  id?: number;
  dirty: boolean;
  listing_id: number;
  retailer_id: number;
  market_id: number;
  first_observation_id: number;
  last_observation_id: number;
  promo_type: string;
  description: string | null;
  status: 'active' | 'ended';
  end_reason: 'price_restored' | 'observation_gap' | null;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  start_local_date: string;
  end_local_date: string;
  duration_days: number;
  promo_days_observed: number;
  observation_count: number;
  currency_code: string;
  regular_price: number | null;
  min_promo_price: number | null;
  max_discount_pct: number | null;
  avg_discount_pct: number | null;
  discount_obs_count: number;
  stated_start: string | null;
  stated_end: string | null;
  is_demo: number;
}

const round = (value: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
};

const available = (a: string) => (a === 'in_stock' || a === 'limited' ? true : a === 'out_of_stock' ? false : null);

type NewEvent = Omit<PriceEvent, 'id'>;

/** Pure: changes between two consecutive observations of one listing. */
export function deriveEvents(prev: ObsRow, cur: ObsRow): NewEvent[] {
  const base = {
    listing_id: cur.listing_id,
    retailer_id: cur.retailer_id,
    market_id: cur.market_id,
    observation_id: cur.id,
    prev_observation_id: prev.id,
    occurred_at: cur.observed_at,
    occurred_local_date: cur.observed_local_date,
    is_demo: cur.is_demo,
  };
  const events: NewEvent[] = [];
  const priceInfo = {
    old_price: prev.current_price,
    new_price: cur.current_price,
    old_availability: prev.availability,
    new_availability: cur.availability,
  };
  if (prev.current_price !== null && cur.current_price !== null && round(prev.current_price, 4) !== round(cur.current_price, 4)) {
    const diff = cur.current_price - prev.current_price;
    events.push({
      ...base,
      ...priceInfo,
      kind: 'price_change',
      direction: diff > 0 ? 'up' : 'down',
      change_abs: round(diff, 4),
      change_pct: prev.current_price > 0 ? round((diff / prev.current_price) * 100, 2) : null,
    });
  }
  const was = available(prev.availability);
  const is = available(cur.availability);
  if (was !== null && is !== null && was !== is) {
    events.push({ ...base, ...priceInfo, kind: 'availability_change', direction: null, change_abs: null, change_pct: null });
  }
  if (!prev.is_promo && cur.is_promo) {
    events.push({
      ...base,
      ...priceInfo,
      kind: 'promo_start',
      direction: null,
      change_abs: null,
      change_pct: cur.discount_pct,
    });
  } else if (prev.is_promo && !cur.is_promo) {
    events.push({ ...base, ...priceInfo, kind: 'promo_end', direction: null, change_abs: null, change_pct: null });
  }
  return events;
}

function newEpisode(obs: ObsRow): Episode {
  const promoPrice = obs.promo_price ?? obs.current_price;
  return {
    dirty: true,
    listing_id: obs.listing_id,
    retailer_id: obs.retailer_id,
    market_id: obs.market_id,
    first_observation_id: obs.id,
    last_observation_id: obs.id,
    promo_type: obs.promo_type ?? 'other',
    description: obs.promo_description,
    status: 'active',
    end_reason: null,
    started_at: obs.observed_at,
    last_seen_at: obs.observed_at,
    ended_at: null,
    start_local_date: obs.observed_local_date,
    end_local_date: obs.observed_local_date,
    duration_days: 1,
    promo_days_observed: 1,
    observation_count: 1,
    currency_code: obs.currency_code,
    regular_price: obs.regular_price,
    min_promo_price: promoPrice,
    max_discount_pct: obs.discount_pct,
    avg_discount_pct: obs.discount_pct,
    discount_obs_count: obs.discount_pct === null ? 0 : 1,
    stated_start: obs.promo_starts_on,
    stated_end: obs.promo_ends_on,
    is_demo: obs.is_demo,
  };
}

function extendEpisode(ep: Episode, obs: ObsRow): void {
  const promoPrice = obs.promo_price ?? obs.current_price;
  ep.dirty = true;
  if (obs.observed_local_date !== ep.end_local_date) ep.promo_days_observed += 1;
  ep.last_observation_id = obs.id;
  ep.last_seen_at = obs.observed_at;
  ep.end_local_date = obs.observed_local_date;
  ep.duration_days = diffDays(ep.start_local_date, ep.end_local_date) + 1;
  ep.observation_count += 1;
  if (obs.promo_description) ep.description = obs.promo_description;
  if (obs.regular_price !== null && (ep.regular_price === null || obs.regular_price > ep.regular_price)) {
    ep.regular_price = obs.regular_price;
  }
  if (promoPrice !== null && (ep.min_promo_price === null || promoPrice < ep.min_promo_price)) ep.min_promo_price = promoPrice;
  if (obs.discount_pct !== null) {
    ep.max_discount_pct = ep.max_discount_pct === null ? obs.discount_pct : Math.max(ep.max_discount_pct, obs.discount_pct);
    const sum = (ep.avg_discount_pct ?? 0) * ep.discount_obs_count + obs.discount_pct;
    ep.discount_obs_count += 1;
    ep.avg_discount_pct = round(sum / ep.discount_obs_count, 4);
  }
  if (obs.promo_starts_on && !ep.stated_start) ep.stated_start = obs.promo_starts_on;
  if (obs.promo_ends_on) ep.stated_end = obs.promo_ends_on;
}

function closeEpisode(ep: Episode, reason: 'price_restored' | 'observation_gap', endedAt: string): void {
  ep.dirty = true;
  ep.status = 'ended';
  ep.end_reason = reason;
  ep.ended_at = endedAt;
}

/**
 * Pure promotion reducer. Feeds one observation into the currently open episode (if any) and returns
 * the episode that is open afterwards plus any episode that this observation closed.
 */
export function stepPromotion(
  open: Episode | null,
  prev: ObsRow | null,
  cur: ObsRow,
  gapDays: number,
): { open: Episode | null; closed: Episode | null } {
  if (cur.is_promo) {
    if (open && prev && prev.is_promo && diffDays(prev.observed_local_date, cur.observed_local_date) <= gapDays) {
      extendEpisode(open, cur);
      return { open, closed: null };
    }
    let closed: Episode | null = null;
    if (open) {
      closeEpisode(open, 'observation_gap', open.last_seen_at);
      closed = open;
    }
    return { open: newEpisode(cur), closed };
  }
  if (open) {
    closeEpisode(open, 'price_restored', cur.observed_at);
    return { open: null, closed: open };
  }
  return { open: null, closed: null };
}

const EPISODE_COLUMNS = [
  'listing_id', 'retailer_id', 'market_id', 'first_observation_id', 'last_observation_id', 'promo_type', 'description',
  'status', 'end_reason', 'started_at', 'last_seen_at', 'ended_at', 'start_local_date', 'end_local_date', 'duration_days',
  'promo_days_observed', 'observation_count', 'currency_code', 'regular_price', 'min_promo_price', 'max_discount_pct',
  'avg_discount_pct', 'discount_obs_count', 'stated_start', 'stated_end', 'is_demo',
] as const;

function saveEpisode(ctx: AppContext, ep: Episode): void {
  if (!ep.dirty) return;
  const values = EPISODE_COLUMNS.map((c) => ep[c]);
  if (ep.id) {
    ctx.db.run(`UPDATE promotions SET ${EPISODE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...values, ep.id]);
  } else {
    const res = ctx.db.run(
      `INSERT INTO promotions (${EPISODE_COLUMNS.join(', ')}) VALUES (${placeholders(EPISODE_COLUMNS.length)})`,
      values,
    );
    ep.id = res.lastInsertRowid;
  }
  ep.dirty = false;
}

const EVENT_COLUMNS = [
  'listing_id', 'retailer_id', 'market_id', 'observation_id', 'prev_observation_id', 'kind', 'direction', 'old_price',
  'new_price', 'change_abs', 'change_pct', 'old_availability', 'new_availability', 'occurred_at', 'occurred_local_date', 'is_demo',
] as const;

function insertEvent(ctx: AppContext, ev: NewEvent): PriceEvent {
  const res = ctx.db.run(
    `INSERT INTO price_events (${EVENT_COLUMNS.join(', ')}) VALUES (${placeholders(EVENT_COLUMNS.length)})`,
    EVENT_COLUMNS.map((c) => ev[c]),
  );
  return { ...ev, id: res.lastInsertRowid };
}

interface StateRow {
  listing_id: number;
  latest_obs_id: number | null;
  prev_obs_id: number | null;
  first_observed_at: string | null;
  last_observed_at: string | null;
  obs_count: number;
  last_price_change_at: string | null;
}

function writeState(ctx: AppContext, s: StateRow): void {
  ctx.db.run(
    `INSERT INTO listing_state (listing_id, latest_obs_id, prev_obs_id, first_observed_at, last_observed_at, obs_count, last_price_change_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET latest_obs_id = excluded.latest_obs_id, prev_obs_id = excluded.prev_obs_id,
       first_observed_at = excluded.first_observed_at, last_observed_at = excluded.last_observed_at,
       obs_count = excluded.obs_count, last_price_change_at = excluded.last_price_change_at, updated_at = excluded.updated_at`,
    [s.listing_id, s.latest_obs_id, s.prev_obs_id, s.first_observed_at, s.last_observed_at, s.obs_count, s.last_price_change_at, nowIso()],
  );
}

/** Recomputes all derived state of one listing from its (non-voided) observations. */
export function rebuildListingDerived(ctx: AppContext, listingId: number): void {
  const gapDays = getSetting(ctx, 'promo_gap_days');
  const rows = ctx.db.all<ObsRow>(
    `SELECT ${OBS_COLUMNS} FROM v_observations WHERE listing_id = ? ORDER BY observed_at ASC, id ASC`,
    [listingId],
  );
  ctx.db.run('DELETE FROM price_events WHERE listing_id = ?', [listingId]);
  ctx.db.run('DELETE FROM promotions WHERE listing_id = ?', [listingId]);
  if (rows.length === 0) {
    ctx.db.run('DELETE FROM listing_state WHERE listing_id = ?', [listingId]);
    return;
  }
  let prev: ObsRow | null = null;
  let open: Episode | null = null;
  let lastChange: string | null = null;
  for (const cur of rows) {
    if (prev) {
      for (const ev of deriveEvents(prev, cur)) {
        insertEvent(ctx, ev);
        if (ev.kind === 'price_change') lastChange = ev.occurred_at;
      }
    }
    const step = stepPromotion(open, prev, cur, gapDays);
    if (step.closed) saveEpisode(ctx, step.closed);
    open = step.open;
    prev = cur;
  }
  if (open) saveEpisode(ctx, open);
  writeState(ctx, {
    listing_id: listingId,
    latest_obs_id: rows[rows.length - 1]!.id,
    prev_obs_id: rows.length > 1 ? rows[rows.length - 2]!.id : null,
    first_observed_at: rows[0]!.observed_at,
    last_observed_at: rows[rows.length - 1]!.observed_at,
    obs_count: rows.length,
    last_price_change_at: lastChange,
  });
}

/**
 * Brings derived state up to date after `newRows` were inserted for a listing.
 * Appends incrementally when the new observations are the newest for the listing; otherwise
 * (back-filled history, many rows, superseded rows) rebuilds the listing.
 * Returns the events that involve the new observations.
 */
export function refreshListingDerived(
  ctx: AppContext,
  listingId: number,
  newRows: ObsRow[],
  forceRebuild = false,
): PriceEvent[] {
  const state = ctx.db.get<StateRow>('SELECT * FROM listing_state WHERE listing_id = ?', [listingId]);
  const sorted = [...newRows].sort((a, b) => (a.observed_at === b.observed_at ? a.id - b.id : a.observed_at < b.observed_at ? -1 : 1));
  const canAppend =
    !forceRebuild &&
    !!state &&
    state.latest_obs_id !== null &&
    state.last_observed_at !== null &&
    sorted.length > 0 &&
    sorted.length <= 8 &&
    sorted[0]!.observed_at >= state.last_observed_at;

  if (!canAppend) {
    rebuildListingDerived(ctx, listingId);
    if (newRows.length === 0) return [];
    const ids = newRows.map((r) => r.id);
    const events: PriceEvent[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      events.push(
        ...ctx.db.all<PriceEvent>(`SELECT * FROM price_events WHERE observation_id IN (${placeholders(chunk.length)})`, chunk),
      );
    }
    return events;
  }

  const gapDays = getSetting(ctx, 'promo_gap_days');
  let prev = ctx.db.get<ObsRow>(`SELECT ${OBS_COLUMNS} FROM price_observations WHERE id = ?`, [state!.latest_obs_id])!;
  const openRow = ctx.db.get<Episode>(`SELECT * FROM promotions WHERE listing_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [
    listingId,
  ]);
  let open: Episode | null = openRow ? { ...openRow, dirty: false } : null;
  let lastChange = state!.last_price_change_at;
  let prevId = state!.prev_obs_id;
  const events: PriceEvent[] = [];
  for (const cur of sorted) {
    for (const ev of deriveEvents(prev, cur)) {
      events.push(insertEvent(ctx, ev));
      if (ev.kind === 'price_change') lastChange = ev.occurred_at;
    }
    const step = stepPromotion(open, prev, cur, gapDays);
    if (step.closed) saveEpisode(ctx, step.closed);
    open = step.open;
    prevId = prev.id;
    prev = cur;
  }
  if (open) saveEpisode(ctx, open);
  writeState(ctx, {
    listing_id: listingId,
    latest_obs_id: prev.id,
    prev_obs_id: prevId,
    first_observed_at: state!.first_observed_at,
    last_observed_at: prev.observed_at,
    obs_count: state!.obs_count + sorted.length,
    last_price_change_at: lastChange,
  });
  return events;
}

/** Rebuilds derived state for every listing that has observations (maintenance / after bulk loads). */
export function rebuildAllDerived(ctx: AppContext): number {
  const ids = ctx.db
    .all<{ listing_id: number }>(
      `SELECT listing_id FROM price_observations GROUP BY listing_id
       UNION SELECT listing_id FROM listing_state`,
    )
    .map((r) => r.listing_id);
  ctx.db.tx(() => {
    for (const id of ids) rebuildListingDerived(ctx, id);
  });
  return ids.length;
}
