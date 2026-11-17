/** API contracts of the Alerts Centre (types only). */
import type { AlertType, Severity } from '../constants.ts';

export type AlertStatus = 'open' | 'acknowledged' | 'resolved';
export type NotificationChannel = 'in_app' | 'email' | 'webhook';
export type NotificationStatus = 'delivered' | 'failed' | 'not_configured';

/** A configurable alert rule (GET /alert-rules). */
export interface AlertRuleRow {
  id: number;
  name: string;
  type: AlertType;
  is_enabled: boolean;
  severity: Severity;
  /** % threshold for price / discount / gap rules (NULL for other rule types). */
  threshold_pct: number | null;
  /** Consecutive failed runs for `collection_failed`. */
  threshold_count: number | null;
  /** Maximum observation age for `stale_observation`; NULL = derived from each source's frequency. */
  threshold_hours: number | null;
  market_id: number | null;
  market_name: string | null;
  retailer_id: number | null;
  retailer_name: string | null;
  brand_id: number | null;
  brand_name: string | null;
  category_id: number | null;
  category_name: string | null;
  product_id: number | null;
  product_name: string | null;
  channels: NotificationChannel[];
  cooldown_hours: number;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  /** Alerts ever raised by this rule / still open or acknowledged / most recent trigger. */
  alert_count: number;
  open_count: number;
  last_triggered_at: string | null;
}

/** Body of POST /alert-rules and (all fields optional) PATCH /alert-rules/:id. `type` cannot be changed later. */
export interface AlertRuleInput {
  name: string;
  type: AlertType;
  severity?: Severity;
  is_enabled?: boolean;
  threshold_pct?: number | null;
  threshold_count?: number | null;
  threshold_hours?: number | null;
  market_id?: number | null;
  retailer_id?: number | null;
  brand_id?: number | null;
  category_id?: number | null;
  product_id?: number | null;
  /** `in_app` is always included. */
  channels?: NotificationChannel[];
  cooldown_hours?: number;
}

/** Payload of alerts raised from a price / availability / promotion event of one listing. */
export interface PriceAlertPayload {
  event_kind: 'price_change' | 'availability_change' | 'promo_start';
  currency_code: string;
  old_price: number | null;
  new_price: number | null;
  change_abs: number | null;
  change_pct: number | null;
  direction: 'up' | 'down' | null;
  old_availability: string | null;
  new_availability: string | null;
  /** Promotion details (competitor_promotion only). */
  discount_pct?: number | null;
  promo_type?: string | null;
  promo_description?: string | null;
  promo_price?: number | null;
  regular_price?: number | null;
  /** price_increase only, when the previous price was promotional: the increase against the previous regular price. */
  change_vs_regular_pct?: number | null;
  observed_at: string;
  local_date: string;
  pack: string;
  /** Threshold the rule was configured with when it fired. */
  threshold: number | null;
  listing_title: string | null;
}

export interface ComparedListing {
  listing_id: number;
  product_id: number;
  product_name: string;
  brand_name: string | null;
  pack: string;
  price: number;
  /** Price per 100 ml / 100 g / unit; NULL when the pack content is unknown. */
  unit_price: number | null;
  observed_at: string;
}

/** Payload of `own_more_expensive` alerts. */
export interface OwnMoreExpensivePayload {
  mapping_id: number;
  equivalence: 'equivalent' | 'comparable';
  /** `shelf` = pack price of like-for-like packs; `unit` = price per 100 ml / 100 g / unit. */
  basis: 'shelf' | 'unit';
  unit_basis: string | null;
  currency_code: string;
  own: ComparedListing;
  competitor: ComparedListing;
  /** (own − competitor) / competitor × 100 on the chosen basis, now and before the triggering change. */
  gap_pct: number;
  gap_abs: number;
  previous_gap_pct: number | null;
  trigger: 'own_price_change' | 'competitor_price_change';
  threshold: number;
  local_date: string;
}

/** Payload of `stale_observation` alerts (one alert per rule and retailer, updated in place). */
export interface StaleAlertPayload {
  stale_count: number;
  total_listings: number;
  never_observed: number;
  oldest_observed_at: string | null;
  oldest_age_hours: number | null;
  /** Freshness window applied to this source, in hours. */
  window_hours: number;
  frequency: string | null;
  sample: Array<{ listing_id: number; listing_code: string | null; product_name: string | null; last_observed_at: string | null }>;
  checked_at: string;
}

/** Payload of `collection_failed` alerts (one alert per rule and retailer, updated in place). */
export interface CollectionFailedPayload {
  consecutive_failures: number;
  threshold: number;
  method: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  checked_at: string;
}

export interface AlertRow {
  id: number;
  rule_id: number | null;
  rule_name: string | null;
  type: AlertType;
  severity: Severity;
  title: string;
  message: string;
  status: AlertStatus;
  listing_id: number | null;
  listing_code: string | null;
  product_id: number | null;
  product_code: string | null;
  product_name: string | null;
  brand_id: number | null;
  brand_name: string | null;
  ownership: 'own' | 'competitor' | null;
  retailer_id: number | null;
  retailer_name: string | null;
  market_id: number | null;
  market_code: string | null;
  market_name: string | null;
  timezone: string | null;
  observation_id: number | null;
  job_id: number | null;
  payload: PriceAlertPayload | OwnMoreExpensivePayload | StaleAlertPayload | CollectionFailedPayload | Record<string, unknown>;
  triggered_at: string;
  acknowledged_by: number | null;
  acknowledged_by_name: string | null;
  acknowledged_at: string | null;
  resolved_by: number | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  /** Raised from DEMO (simulated / illustrative) data. */
  is_demo: boolean;
}

export interface AlertNotificationRow {
  id: number;
  alert_id: number;
  channel: NotificationChannel;
  recipient: string | null;
  status: NotificationStatus;
  error: string | null;
  created_at: string;
}

export interface AlertDetail extends AlertRow {
  notifications: AlertNotificationRow[];
}

/** GET /alerts/summary?days=14 */
export interface AlertSummary {
  days: number;
  open: number;
  acknowledged: number;
  resolved: number;
  /** Open + acknowledged alerts raised from DEMO data. */
  demo_active: number;
  /** Open + acknowledged alerts by severity. */
  active_by_severity: Record<Severity, number>;
  /** Alerts triggered within the period, by type (and how many of those are still open/acknowledged). */
  by_type: Array<{ type: AlertType; label: string; total: number; active: number }>;
  /** One row per UTC day of the period, oldest first. */
  trend: Array<{ date: string; total: number; info: number; warning: number; critical: number }>;
  triggered_in_period: number;
}

/** GET /alerts/unread-count — open alerts visible under the caller's notification preferences. */
export interface AlertUnreadCount {
  open: number;
  critical: number;
  /** All open alerts regardless of preferences. */
  total_open: number;
}

/** GET / PUT /me/notification-prefs */
export interface NotificationPrefs {
  in_app: boolean;
  email: boolean;
  min_severity: Severity;
}

/** GET /me/notification-channels — which delivery channels are set up on this installation (readiness only). */
export interface NotificationChannels {
  in_app: boolean;
  email: boolean;
  webhook: boolean;
}

/** POST /alerts/bulk */
export interface AlertBulkRequest {
  ids: number[];
  action: 'acknowledge' | 'resolve' | 'reopen';
  note?: string | null;
}
export interface AlertBulkResult {
  updated: number;
  skipped: number;
}

export interface StateCheckCounts {
  opened: number;
  updated: number;
  resolved: number;
}

/** POST /alerts/evaluate — result of running the state-based checks now. */
export interface StateCheckResult {
  checked_at: string;
  stale_observation: StateCheckCounts;
  collection_failed: StateCheckCounts;
  /** Ids of alerts opened by this run. */
  opened_alert_ids: number[];
}
