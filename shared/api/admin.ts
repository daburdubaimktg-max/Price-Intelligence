/** API contracts of the Administration section (types only). */
import type { Permission, RoleKey } from '../constants.ts';

// ---- users & roles ------------------------------------------------------------------------------
export interface UserRow {
  id: number;
  email: string;
  name: string;
  role: RoleKey;
  role_name: string;
  is_active: boolean;
  must_change_password: boolean;
  /** Still signs in with the published demo password. */
  uses_default_password: boolean;
  /** Temporarily locked after repeated failed sign-ins. */
  locked: boolean;
  last_login_at: string | null;
  active_sessions: number;
  created_at: string;
  updated_at: string;
}

export interface RoleRow {
  key: RoleKey;
  name: string;
  description: string;
  permissions: Permission[];
  user_count: number;
}

/** POST /users — `generated_password` is returned once, only when no password was supplied. */
export interface CreateUserResponse {
  user: UserRow;
  generated_password: string | null;
}

/** POST /users/:id/reset-password — the temporary password is shown once and must be changed at next sign-in. */
export interface ResetPasswordResponse {
  user: UserRow;
  temporary_password: string;
}

// ---- settings -----------------------------------------------------------------------------------
/** What every signed-in user may read (GET /settings as a non-administrator). */
export interface PublicSettings {
  reporting_currency: string;
  organisation_name: string;
}

/** GET /settings as an administrator. Nothing secret: webhook and provider URLs are masked. */
export interface AdminSettings extends PublicSettings {
  promo_gap_days: number;
  alert_max_age_hours: number;
  collection_max_retries: number;
  demo_epoch: string | null;
  fx_provider: string | null;
  fx_auto_refresh: boolean;
  alert_webhook: { configured: boolean; target: string | null };
  smtp: { host: string; port: number; secure: boolean; user: string; from: string } | null;
  alert_email_recipients: string[];
  ai: { provider: 'builtin' | 'anthropic'; model: string };
}

/** Body of PUT /settings (any subset). */
export interface SettingsUpdate {
  reporting_currency?: string;
  organisation_name?: string;
  promo_gap_days?: number;
  alert_max_age_hours?: number;
  collection_max_retries?: number;
}

// ---- integrations -------------------------------------------------------------------------------
/** Whether a credential is stored, with a short recognition hint. The value itself is never returned. */
export interface SecretStatus {
  configured: boolean;
  hint: string | null;
  updated_at: string | null;
}

export type IntegrationState = 'ready' | 'not_configured' | 'built_in';

export interface AiIntegration {
  provider: 'builtin' | 'anthropic';
  model: string;
  api_key: SecretStatus;
  /** An ANTHROPIC_API_KEY environment variable is present on the server. */
  env_key_present: boolean;
  state: IntegrationState;
  explanation: string;
}

export interface SmtpIntegration {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean | null;
  user: string | null;
  from: string | null;
  password: SecretStatus;
  /** Extra recipients in addition to users who enabled e-mail notifications. */
  recipients: string[];
  /** Active users who opted in to alert e-mails. */
  subscribed_users: number;
  state: IntegrationState;
  explanation: string;
}

export interface WebhookIntegration {
  configured: boolean;
  /** Scheme and host with the path masked — the full URL is never returned. */
  target: string | null;
  state: IntegrationState;
  explanation: string;
}

export interface FxIntegration {
  /** Provider endpoint; masked unless it is the built-in default. */
  provider: string | null;
  uses_default_provider: boolean;
  auto_refresh: boolean;
  api_key: SecretStatus;
  /** Most recent real (non-demo) rate on record. */
  latest_as_of: string | null;
  latest_source: string | null;
  /** Rates exist but all of them are illustrative DEMO rates. */
  only_demo_rates: boolean;
  state: IntegrationState;
  explanation: string;
}

/** GET /integrations */
export interface IntegrationsStatus {
  ai: AiIntegration;
  smtp: SmtpIntegration;
  webhook: WebhookIntegration;
  fx: FxIntegration;
}

/** POST /integrations/smtp/test — the real outcome of sending one message. */
export interface SmtpTestResult {
  ok: boolean;
  message_id: string | null;
  accepted: string[];
  rejected: string[];
  duration_ms: number;
  error: string | null;
}

/** POST /integrations/webhook/test — the real outcome of one HTTP POST. */
export interface WebhookTestResult {
  ok: boolean;
  status: number | null;
  duration_ms: number;
  error: string | null;
}

// ---- exchange rates -----------------------------------------------------------------------------
export interface ExchangeRateRow {
  currency: string;
  currency_name: string;
  /** Units of `currency` per 1 USD. */
  rate: number;
  as_of: string;
  source: string;
  /** Illustrative DEMO rate — replace with a real source before relying on converted comparisons. */
  is_demo: boolean;
  age_hours: number;
}

/** GET /exchange-rates */
export interface ExchangeRatesResponse {
  base: 'USD';
  reporting_currency: string;
  rates: ExchangeRateRow[];
  /** Known currencies without any rate (conversions involving them are unavailable, never guessed). */
  missing: Array<{ code: string; name: string }>;
  contains_demo_rates: boolean;
  auto_refresh: boolean;
}

export interface ExchangeRateHistoryRow {
  id: number;
  currency: string;
  rate: number;
  as_of: string;
  source: string;
  source_ref: string | null;
  fetched_at: string;
  entered_by: number | null;
  entered_by_name: string | null;
  is_demo: boolean;
}

/** POST /exchange-rates/fetch */
export interface FxFetchResult {
  inserted: number;
  unchanged: number;
  as_of: string;
  source: string;
  currencies: string[];
}

// ---- audit log ----------------------------------------------------------------------------------
export interface AuditLogRow {
  id: number;
  at: string;
  user_id: number | null;
  user_email: string | null;
  user_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: unknown;
  ip: string | null;
}

// ---- system -------------------------------------------------------------------------------------
/** GET /admin/system */
export interface SystemInfo {
  version: { node: string; sqlite: string; migration: number; migration_name: string | null };
  environment: string;
  uptime_seconds: number;
  scheduler_enabled: boolean;
  data_dir: string;
  database: { path: string; size_bytes: number; wal_size_bytes: number };
  /** Row counts of the main tables. */
  tables: Record<string, number>;
  /** Rows flagged as DEMO per table. */
  demo_rows: Record<string, number>;
  demo_data_present: boolean;
  /** Observation counts by how the data entered the system; real and demo rows are reported separately. */
  observations_by_class: Array<{ data_class: string; is_demo: boolean; count: number; last_observed_at: string | null }>;
}

/** POST /admin/demo/purge and POST /admin/demo/seed */
export interface DemoActionResult {
  action: 'purge' | 'seed';
  counts: Record<string, number>;
}
