import type { Config } from './config.ts';
import type { Db } from './db/sqlite.ts';
import type { SecretBox } from './lib/crypto.ts';
import type { RoleKey } from '../shared/constants.ts';

/** A change detected between two consecutive observations of the same listing. */
export interface PriceEvent {
  id: number;
  listing_id: number;
  retailer_id: number;
  market_id: number;
  observation_id: number;
  prev_observation_id: number;
  kind: 'price_change' | 'availability_change' | 'promo_start' | 'promo_end';
  direction: 'up' | 'down' | null;
  old_price: number | null;
  new_price: number | null;
  change_abs: number | null;
  change_pct: number | null;
  old_availability: string | null;
  new_availability: string | null;
  occurred_at: string;
  occurred_local_date: string;
  is_demo: number;
}

export interface IngestedSummary {
  sourceMethod: string;
  isDemo: boolean;
  /** Listings that received at least one new observation. */
  listingIds: number[];
  /** Events derived from newly inserted observations. */
  events: PriceEvent[];
  /** Only react to events newer than this many hours (history back-fills must not raise alerts). */
  alertMaxAgeHours: number;
}

/** Listings a collection run found at its source that were not known before (stored as unmatched, for review). */
export interface DiscoveredSummary {
  jobId: number;
  retailerId: number;
  listingIds: number[];
  sourceMethod: string;
  isDemo: boolean;
}

/** Extension points so services stay decoupled (the alert engine subscribes to ingestion, etc.). */
export interface AppHooks {
  observationsIngested: Array<(summary: IngestedSummary) => void>;
  /** Fired after a run stored newly found listings and their first observations. */
  listingsDiscovered: Array<(summary: DiscoveredSummary) => void>;
  collectionJobFinished: Array<(jobId: number) => void>;
  /** Fired by the scheduler roughly once a minute; subscribers throttle their own periodic work. */
  schedulerTick: Array<(now: Date) => void>;
}

export interface AppContext {
  config: Config;
  db: Db;
  secrets: SecretBox;
  hooks: AppHooks;
  /** Structured logger (Fastify's pino instance once the app is built). */
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: RoleKey;
  must_change_password: boolean;
  uses_default_password: boolean;
}

export function createHooks(): AppHooks {
  return { observationsIngested: [], listingsDiscovered: [], collectionJobFinished: [], schedulerTick: [] };
}

/** Runs every subscriber; one failing subscriber never breaks the caller or the others. */
export function fireHook<T>(ctx: AppContext, handlers: Array<(payload: T) => void>, payload: T): void {
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (err) {
      ctx.log.error({ err }, 'hook handler failed');
    }
  }
}
