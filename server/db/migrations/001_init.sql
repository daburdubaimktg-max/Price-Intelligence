-- Price Intelligence OS — initial schema
-- Conventions
--   * All timestamps are UTC ISO-8601 strings (e.g. 2026-11-17T08:15:00.000Z).
--   * Booleans are INTEGER 0/1.
--   * `is_demo = 1` marks illustrative DEMO records. They are never mixed up with real data and can be purged.
--   * price_observations is the append-only ledger at the heart of the product (see triggers below).

------------------------------------------------------------------------------------------------
-- Access control
------------------------------------------------------------------------------------------------
CREATE TABLE roles (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE CHECK (key IN ('admin', 'analyst', 'viewer')),
  name TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT;

INSERT INTO roles (id, key, name, description) VALUES
  (1, 'admin', 'Administrator', 'Full access: users, sources, credentials, settings, data corrections.'),
  (2, 'analyst', 'Analyst', 'Manage catalogue, listings and mappings; enter and import prices; manage alerts; run collections and reports.'),
  (3, 'viewer', 'Viewer', 'Read-only access to dashboards, history, reports and exports.');

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  uses_default_password INTEGER NOT NULL DEFAULT 0 CHECK (uses_default_password IN (0, 1)),
  notification_prefs TEXT NOT NULL DEFAULT '{"in_app":true,"email":false,"min_severity":"info"}',
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
) STRICT;
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

------------------------------------------------------------------------------------------------
-- Reference data
------------------------------------------------------------------------------------------------
CREATE TABLE currencies (
  code TEXT PRIMARY KEY CHECK (length(code) = 3 AND code = upper(code)),
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 4)
) STRICT;

CREATE TABLE markets (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  country_code TEXT NOT NULL,
  country_name TEXT NOT NULL,
  region TEXT,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  timezone TEXT NOT NULL,
  default_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (default_frequency IN ('6h', '12h', 'daily', 'weekly', 'manual')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 100,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE brands (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  ownership TEXT NOT NULL CHECK (ownership IN ('own', 'competitor')),
  manufacturer TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Which competitor brands an own brand is benchmarked against (brand-level association).
CREATE TABLE brand_competitors (
  own_brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  competitor_brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  PRIMARY KEY (own_brand_id, competitor_brand_id),
  CHECK (own_brand_id <> competitor_brand_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE,
  parent_id INTEGER REFERENCES categories(id),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX uq_categories_name ON categories(COALESCE(parent_id, 0), name);

------------------------------------------------------------------------------------------------
-- Product catalogue
------------------------------------------------------------------------------------------------
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,                      -- human-facing Product ID, e.g. PRD-00042 (assigned by trigger)
  brand_id INTEGER NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  product_line TEXT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  subcategory_id INTEGER REFERENCES categories(id),
  sku TEXT,
  gtin TEXT,
  pack_size REAL CHECK (pack_size IS NULL OR pack_size > 0),
  pack_unit TEXT CHECK (pack_unit IS NULL OR pack_unit IN ('ml', 'l', 'g', 'kg', 'unit')),
  units_per_pack INTEGER NOT NULL DEFAULT 1 CHECK (units_per_pack >= 1),
  image_url TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX uq_products_sku ON products(sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX uq_products_gtin ON products(gtin) WHERE gtin IS NOT NULL;
CREATE INDEX idx_products_brand ON products(brand_id);
CREATE INDEX idx_products_category ON products(category_id, subcategory_id);
CREATE INDEX idx_products_status ON products(status);

CREATE TRIGGER trg_products_code AFTER INSERT ON products WHEN NEW.code IS NULL
BEGIN
  UPDATE products SET code = 'PRD-' || printf('%05d', NEW.id) WHERE id = NEW.id;
END;

-- Alternative pack configurations of the same product (twin packs, bonus packs, promo sizes).
-- A retailer listing may point at a variant so unit prices use the pack actually being sold.
CREATE TABLE product_variants (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pack_size REAL NOT NULL CHECK (pack_size > 0),
  pack_unit TEXT NOT NULL CHECK (pack_unit IN ('ml', 'l', 'g', 'kg', 'unit')),
  units_per_pack INTEGER NOT NULL DEFAULT 1 CHECK (units_per_pack >= 1),
  gtin TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (product_id, name)
) STRICT;

CREATE TABLE product_markets (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  market_id INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, market_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_product_markets_market ON product_markets(market_id);

-- Equivalent-product mapping between an own product and a competitor product.
--   equivalence = 'equivalent'  : genuinely like-for-like (same need, format and comparable size)
--   equivalence = 'comparable'  : NOT equivalent; shown with an explicit non-equivalent label
CREATE TABLE competitor_mappings (
  id INTEGER PRIMARY KEY,
  own_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  competitor_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  market_id INTEGER REFERENCES markets(id) ON DELETE CASCADE,   -- NULL = applies in every market
  equivalence TEXT NOT NULL DEFAULT 'equivalent' CHECK (equivalence IN ('equivalent', 'comparable')),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'approved', 'rejected')),
  score REAL,
  rationale TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (own_product_id <> competitor_product_id)
) STRICT;
CREATE UNIQUE INDEX uq_competitor_mappings ON competitor_mappings(own_product_id, competitor_product_id, COALESCE(market_id, 0));
CREATE INDEX idx_competitor_mappings_comp ON competitor_mappings(competitor_product_id);
CREATE INDEX idx_competitor_mappings_status ON competitor_mappings(status);

------------------------------------------------------------------------------------------------
-- Retailers (collection sources) and their listings
------------------------------------------------------------------------------------------------
CREATE TABLE retailers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT,
  country_code TEXT NOT NULL,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  collection_method TEXT NOT NULL CHECK (collection_method IN
    ('official_api', 'product_feed', 'web_extraction', 'third_party', 'csv_import', 'manual', 'simulated')),
  collection_frequency TEXT CHECK (collection_frequency IS NULL OR collection_frequency IN ('6h', '12h', 'daily', 'weekly', 'manual')),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),   -- 0 = paused
  connector_config TEXT NOT NULL DEFAULT '{}',                          -- non-secret connector settings (JSON)
  rate_limit_ms INTEGER NOT NULL DEFAULT 3000 CHECK (rate_limit_ms >= 250),
  permission_attested INTEGER NOT NULL DEFAULT 0 CHECK (permission_attested IN (0, 1)),
  permission_attested_by INTEGER REFERENCES users(id),
  permission_attested_at TEXT,
  permission_note TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  next_run_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name, market_id)
) STRICT;
CREATE INDEX idx_retailers_market ON retailers(market_id);
CREATE INDEX idx_retailers_due ON retailers(next_run_at) WHERE is_enabled = 1 AND is_active = 1;

CREATE TABLE retailer_listings (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,                       -- unique listing identifier, e.g. LST-000123 (assigned by trigger)
  retailer_id INTEGER NOT NULL REFERENCES retailers(id),
  product_id INTEGER REFERENCES products(id),
  variant_id INTEGER REFERENCES product_variants(id),
  external_id TEXT,                       -- the retailer's own SKU / item id
  url TEXT,
  title TEXT,                             -- title as shown by the retailer
  gtin TEXT,                              -- barcode as reported by the retailer, if any
  match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('matched', 'unmatched', 'ignored')),
  matched_by INTEGER REFERENCES users(id),
  matched_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  first_seen_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((product_id IS NOT NULL AND match_status = 'matched') OR (product_id IS NULL AND match_status IN ('unmatched', 'ignored')))
) STRICT;
CREATE UNIQUE INDEX uq_listings_external ON retailer_listings(retailer_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX uq_listings_url ON retailer_listings(retailer_id, url) WHERE url IS NOT NULL;
CREATE INDEX idx_listings_product ON retailer_listings(product_id);
CREATE INDEX idx_listings_retailer ON retailer_listings(retailer_id);
CREATE INDEX idx_listings_match ON retailer_listings(match_status);

CREATE TRIGGER trg_listings_code AFTER INSERT ON retailer_listings WHEN NEW.code IS NULL
BEGIN
  UPDATE retailer_listings SET code = 'LST-' || printf('%06d', NEW.id) WHERE id = NEW.id;
END;

-- A listing belongs to exactly one retailer for life, and a retailer to one market: observations
-- denormalise both, so these must never change underneath recorded history.
CREATE TRIGGER trg_listings_retailer_immutable BEFORE UPDATE OF retailer_id ON retailer_listings
WHEN OLD.retailer_id <> NEW.retailer_id
BEGIN
  SELECT RAISE(ABORT, 'A listing cannot be moved to another retailer');
END;

CREATE TRIGGER trg_retailers_market_immutable BEFORE UPDATE OF market_id, currency_code ON retailers
WHEN (OLD.market_id <> NEW.market_id OR OLD.currency_code <> NEW.currency_code)
  AND EXISTS (SELECT 1 FROM price_observations o WHERE o.retailer_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'The market and currency of a retailer cannot change once it has price observations');
END;

CREATE TABLE listing_match_suggestions (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES retailer_listings(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (listing_id, product_id)
) STRICT;
CREATE INDEX idx_match_suggestions_status ON listing_match_suggestions(status);

------------------------------------------------------------------------------------------------
-- Provenance: evidence, imports, collection jobs
------------------------------------------------------------------------------------------------
CREATE TABLE source_evidence (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('csv_file', 'screenshot', 'document', 'url', 'api_response', 'feed_item', 'html_snapshot', 'note', 'simulated')),
  reference TEXT NOT NULL,                -- URL, file name or free-text description
  file_path TEXT,                         -- path inside the data directory when a file was retained
  file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  excerpt TEXT,                           -- short extract that supports the observation (e.g. matched JSON-LD)
  captured_at TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  note TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('observations', 'products')),
  file_name TEXT NOT NULL,
  stored_path TEXT,
  sha256 TEXT,
  size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'validated', 'committed', 'failed', 'voided')),
  mapping TEXT NOT NULL DEFAULT '{}',
  options TEXT NOT NULL DEFAULT '{}',
  row_count INTEGER NOT NULL DEFAULT 0,
  valid_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]',
  evidence_id INTEGER REFERENCES source_evidence(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  void_reason TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))
) STRICT;

CREATE TABLE collection_jobs (
  id INTEGER PRIMARY KEY,
  retailer_id INTEGER NOT NULL REFERENCES retailers(id),
  method TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('schedule', 'manual', 'retry')),
  -- 'real' = an actual attempt against a configured source; 'simulated' = demo generator. Never conflated.
  data_class TEXT NOT NULL CHECK (data_class IN ('real', 'simulated')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'not_configured', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 1,
  parent_job_id INTEGER REFERENCES collection_jobs(id),
  scheduled_for TEXT,
  started_at TEXT,
  finished_at TEXT,
  listings_total INTEGER NOT NULL DEFAULT 0,
  listings_succeeded INTEGER NOT NULL DEFAULT 0,
  listings_failed INTEGER NOT NULL DEFAULT 0,
  listings_missing INTEGER NOT NULL DEFAULT 0,
  observations_created INTEGER NOT NULL DEFAULT 0,
  duplicates_skipped INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  requested_by INTEGER REFERENCES users(id),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_jobs_retailer ON collection_jobs(retailer_id, created_at DESC);
CREATE INDEX idx_jobs_status ON collection_jobs(status, created_at DESC);
CREATE INDEX idx_jobs_created ON collection_jobs(created_at DESC);

CREATE TABLE collection_logs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES collection_jobs(id) ON DELETE CASCADE,
  retailer_id INTEGER NOT NULL REFERENCES retailers(id),
  listing_id INTEGER REFERENCES retailer_listings(id) ON DELETE SET NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_logs_job ON collection_logs(job_id);
CREATE INDEX idx_logs_level ON collection_logs(level, created_at DESC);
CREATE INDEX idx_logs_retailer ON collection_logs(retailer_id, created_at DESC);

------------------------------------------------------------------------------------------------
-- THE HISTORICAL PRICE LEDGER (append-only)
------------------------------------------------------------------------------------------------
CREATE TABLE price_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES retailer_listings(id),
  retailer_id INTEGER NOT NULL REFERENCES retailers(id),
  market_id INTEGER NOT NULL REFERENCES markets(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),

  regular_price REAL CHECK (regular_price IS NULL OR regular_price >= 0),   -- regular listed price
  current_price REAL CHECK (current_price IS NULL OR current_price >= 0),   -- price a shopper pays now
  promo_price REAL CHECK (promo_price IS NULL OR promo_price >= 0),         -- promotional price, when on offer
  discount_pct REAL CHECK (discount_pct IS NULL OR (discount_pct >= 0 AND discount_pct <= 100)),
  is_promo INTEGER NOT NULL DEFAULT 0 CHECK (is_promo IN (0, 1)),
  promo_type TEXT CHECK (promo_type IS NULL OR promo_type IN ('price_cut', 'multi_buy', 'bundle', 'coupon', 'other')),
  promo_description TEXT,
  promo_starts_on TEXT,
  promo_ends_on TEXT,

  availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('in_stock', 'limited', 'out_of_stock', 'unknown')),
  product_url TEXT,

  observed_at TEXT NOT NULL,              -- when the price was true (UTC)
  observed_basis TEXT NOT NULL DEFAULT 'exact' CHECK (observed_basis IN ('exact', 'date_only', 'import_time')),
  observed_local_date TEXT NOT NULL,      -- calendar date in the market's time zone
  collected_at TEXT NOT NULL,             -- when this system captured it (UTC)
  source_timestamp TEXT,                  -- timestamp reported by the source itself, if any

  source_method TEXT NOT NULL CHECK (source_method IN
    ('official_api', 'product_feed', 'web_extraction', 'third_party', 'csv_import', 'manual', 'simulated')),
  data_class TEXT GENERATED ALWAYS AS (CASE source_method
      WHEN 'csv_import' THEN 'imported'
      WHEN 'manual' THEN 'manual'
      WHEN 'simulated' THEN 'simulated'
      ELSE 'collected' END) VIRTUAL,
  collection_status TEXT NOT NULL DEFAULT 'complete' CHECK (collection_status IN ('complete', 'partial')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence_id INTEGER REFERENCES source_evidence(id),
  job_id INTEGER REFERENCES collection_jobs(id),
  import_batch_id INTEGER REFERENCES import_batches(id),
  entered_by INTEGER REFERENCES users(id),
  note TEXT,

  dedupe_key TEXT NOT NULL,               -- identical re-ingestion of the same fact is rejected
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,

  CHECK (current_price IS NOT NULL OR availability IN ('out_of_stock', 'unknown')),
  -- simulated observations are always flagged as DEMO data
  CHECK (source_method <> 'simulated' OR is_demo = 1)
) STRICT;

CREATE UNIQUE INDEX uq_observations_dedupe ON price_observations(dedupe_key);
CREATE INDEX idx_observations_listing_time ON price_observations(listing_id, observed_at DESC, id DESC);
CREATE INDEX idx_observations_market_date ON price_observations(market_id, observed_local_date);
CREATE INDEX idx_observations_retailer_date ON price_observations(retailer_id, observed_local_date);
CREATE INDEX idx_observations_date ON price_observations(observed_local_date);
CREATE INDEX idx_observations_observed_at ON price_observations(observed_at);
CREATE INDEX idx_observations_job ON price_observations(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_observations_batch ON price_observations(import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX idx_observations_promo ON price_observations(observed_local_date, listing_id) WHERE is_promo = 1;

-- Append-only guarantees. An observation is a historical fact: it is never rewritten.
CREATE TRIGGER trg_observations_no_update BEFORE UPDATE ON price_observations
BEGIN
  SELECT RAISE(ABORT, 'price_observations is append-only: an observation can never be modified');
END;

-- Real observations can never be deleted. Only rows of the illustrative DEMO dataset may be purged.
CREATE TRIGGER trg_observations_no_delete BEFORE DELETE ON price_observations
WHEN OLD.is_demo = 0
BEGIN
  SELECT RAISE(ABORT, 'price_observations is append-only: a real observation can never be deleted');
END;

-- Corrections never touch the ledger. A wrong observation is "voided" by adding a row here; it then
-- drops out of analytics (v_observations) while the original record stays intact and auditable.
CREATE TABLE observation_voids (
  observation_id INTEGER PRIMARY KEY REFERENCES price_observations(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT NOT NULL,
  import_batch_id INTEGER REFERENCES import_batches(id)
) STRICT;

CREATE VIEW v_observations AS
SELECT o.* FROM price_observations o
WHERE NOT EXISTS (SELECT 1 FROM observation_voids v WHERE v.observation_id = o.id);

------------------------------------------------------------------------------------------------
-- Derived, rebuildable state (never the source of truth)
------------------------------------------------------------------------------------------------
CREATE TABLE listing_state (
  listing_id INTEGER PRIMARY KEY REFERENCES retailer_listings(id) ON DELETE CASCADE,
  latest_obs_id INTEGER REFERENCES price_observations(id) ON DELETE SET NULL,
  prev_obs_id INTEGER REFERENCES price_observations(id) ON DELETE SET NULL,
  first_observed_at TEXT,
  last_observed_at TEXT,
  obs_count INTEGER NOT NULL DEFAULT 0,
  last_price_change_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE price_events (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES retailer_listings(id) ON DELETE CASCADE,
  retailer_id INTEGER NOT NULL,
  market_id INTEGER NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES price_observations(id) ON DELETE CASCADE,
  prev_observation_id INTEGER NOT NULL REFERENCES price_observations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('price_change', 'availability_change', 'promo_start', 'promo_end')),
  direction TEXT CHECK (direction IS NULL OR direction IN ('up', 'down')),
  old_price REAL,
  new_price REAL,
  change_abs REAL,
  change_pct REAL,
  old_availability TEXT,
  new_availability TEXT,
  occurred_at TEXT NOT NULL,
  occurred_local_date TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE (observation_id, kind)
) STRICT;
CREATE INDEX idx_events_time ON price_events(occurred_at DESC);
CREATE INDEX idx_events_listing ON price_events(listing_id, occurred_at DESC);
CREATE INDEX idx_events_kind_date ON price_events(kind, occurred_local_date);
CREATE INDEX idx_events_market ON price_events(market_id, occurred_at DESC);

CREATE TABLE promotions (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES retailer_listings(id) ON DELETE CASCADE,
  retailer_id INTEGER NOT NULL,
  market_id INTEGER NOT NULL,
  first_observation_id INTEGER NOT NULL REFERENCES price_observations(id) ON DELETE CASCADE,
  last_observation_id INTEGER NOT NULL REFERENCES price_observations(id) ON DELETE CASCADE,
  promo_type TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('price_restored', 'observation_gap')),
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  start_local_date TEXT NOT NULL,
  end_local_date TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  promo_days_observed INTEGER NOT NULL,
  observation_count INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  regular_price REAL,
  min_promo_price REAL,
  max_discount_pct REAL,
  avg_discount_pct REAL,
  discount_obs_count INTEGER NOT NULL DEFAULT 0,
  stated_start TEXT,
  stated_end TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE (listing_id, first_observation_id)
) STRICT;
CREATE INDEX idx_promotions_listing ON promotions(listing_id, started_at DESC);
CREATE INDEX idx_promotions_status ON promotions(status, started_at DESC);
CREATE INDEX idx_promotions_dates ON promotions(start_local_date, end_local_date);
CREATE INDEX idx_promotions_market ON promotions(market_id, start_local_date);

------------------------------------------------------------------------------------------------
-- Exchange rates (append-only history; each rate keeps its source and timestamp)
------------------------------------------------------------------------------------------------
CREATE TABLE exchange_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_currency TEXT NOT NULL REFERENCES currencies(code),
  quote_currency TEXT NOT NULL REFERENCES currencies(code),
  rate REAL NOT NULL CHECK (rate > 0),       -- 1 unit of base = `rate` units of quote
  as_of TEXT NOT NULL,                       -- timestamp the rate refers to (UTC)
  source TEXT NOT NULL,                      -- e.g. 'manual', 'open.er-api.com', 'DEMO illustrative'
  source_ref TEXT,
  fetched_at TEXT NOT NULL,
  entered_by INTEGER REFERENCES users(id),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  UNIQUE (base_currency, quote_currency, as_of, source)
) STRICT;
CREATE INDEX idx_rates_lookup ON exchange_rates(quote_currency, as_of DESC);

CREATE TRIGGER trg_rates_no_update BEFORE UPDATE ON exchange_rates
BEGIN
  SELECT RAISE(ABORT, 'exchange_rates is append-only: record a new rate instead of changing one');
END;
CREATE TRIGGER trg_rates_no_delete BEFORE DELETE ON exchange_rates WHEN OLD.is_demo = 0
BEGIN
  SELECT RAISE(ABORT, 'exchange_rates is append-only: a recorded rate cannot be deleted');
END;

------------------------------------------------------------------------------------------------
-- Alerts
------------------------------------------------------------------------------------------------
CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'competitor_price_drop', 'own_more_expensive', 'competitor_promotion', 'product_unavailable',
    'price_change', 'price_increase', 'collection_failed', 'stale_observation')),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  threshold_pct REAL,                     -- % threshold for price / discount / gap rules
  threshold_count INTEGER,                -- consecutive failures for collection_failed
  threshold_hours REAL,                   -- maximum age for stale_observation (NULL = derive from frequency)
  market_id INTEGER REFERENCES markets(id) ON DELETE CASCADE,
  retailer_id INTEGER REFERENCES retailers(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  channels TEXT NOT NULL DEFAULT '["in_app"]',
  cooldown_hours REAL NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  rule_id INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  listing_id INTEGER REFERENCES retailer_listings(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  retailer_id INTEGER REFERENCES retailers(id) ON DELETE SET NULL,
  market_id INTEGER REFERENCES markets(id) ON DELETE SET NULL,
  observation_id INTEGER REFERENCES price_observations(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES collection_jobs(id) ON DELETE SET NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  triggered_at TEXT NOT NULL,
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolution_note TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))
) STRICT;
CREATE INDEX idx_alerts_status ON alerts(status, triggered_at DESC);
CREATE INDEX idx_alerts_time ON alerts(triggered_at DESC);
CREATE INDEX idx_alerts_rule ON alerts(rule_id, triggered_at DESC);

CREATE TABLE alert_notifications (
  id INTEGER PRIMARY KEY,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email', 'webhook')),
  recipient TEXT,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'not_configured')),
  error TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_alert_notifications_alert ON alert_notifications(alert_id);

------------------------------------------------------------------------------------------------
-- Settings, credentials, audit trail, saved activity
------------------------------------------------------------------------------------------------
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                    -- JSON
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
) STRICT;

-- Integration credentials, encrypted at rest (AES-256-GCM). Values are never returned by the API.
CREATE TABLE secrets (
  name TEXT PRIMARY KEY,                  -- e.g. 'retailer:12:credential', 'integration:anthropic:api_key'
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  hint TEXT,                              -- last characters, for recognition only
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  user_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT
) STRICT;
CREATE INDEX idx_audit_at ON audit_log(at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE report_runs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  row_count INTEGER NOT NULL DEFAULT 0,
  generated_by INTEGER REFERENCES users(id),
  generated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_report_runs_at ON report_runs(generated_at DESC);

CREATE TABLE assistant_queries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  engine TEXT NOT NULL,
  answer TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_assistant_user ON assistant_queries(user_id, created_at DESC);

------------------------------------------------------------------------------------------------
-- Convenience view: everything a query needs to know about a listing
------------------------------------------------------------------------------------------------
CREATE VIEW v_listing_info AS
SELECT
  l.id AS listing_id,
  l.code AS listing_code,
  l.retailer_id,
  l.product_id,
  l.variant_id,
  l.external_id,
  l.url AS listing_url,
  l.title AS listing_title,
  l.match_status,
  l.is_active AS listing_active,
  l.is_demo AS listing_is_demo,
  r.name AS retailer_name,
  r.market_id,
  r.country_code,
  r.currency_code,
  r.collection_method,
  COALESCE(r.collection_frequency, m.default_frequency) AS collection_frequency,
  r.is_enabled AS retailer_enabled,
  r.is_active AS retailer_active,
  m.code AS market_code,
  m.name AS market_name,
  m.timezone,
  p.code AS product_code,
  p.name AS product_name,
  p.product_line,
  p.sku,
  p.gtin,
  p.status AS product_status,
  p.image_url,
  p.brand_id,
  b.name AS brand_name,
  b.ownership,
  p.category_id,
  c.name AS category_name,
  p.subcategory_id,
  sc.name AS subcategory_name,
  v.name AS variant_name,
  CASE WHEN v.id IS NOT NULL THEN v.pack_size ELSE p.pack_size END AS pack_size,
  CASE WHEN v.id IS NOT NULL THEN v.pack_unit ELSE p.pack_unit END AS pack_unit,
  CASE WHEN v.id IS NOT NULL THEN v.units_per_pack ELSE COALESCE(p.units_per_pack, 1) END AS units_per_pack,
  -- total content in base units (ml, g or units) and the dimension it belongs to
  CASE CASE WHEN v.id IS NOT NULL THEN v.pack_unit ELSE p.pack_unit END
    WHEN 'ml' THEN 1.0 WHEN 'l' THEN 1000.0 WHEN 'g' THEN 1.0 WHEN 'kg' THEN 1000.0 WHEN 'unit' THEN 1.0 END
    * (CASE WHEN v.id IS NOT NULL THEN v.pack_size ELSE p.pack_size END)
    * (CASE WHEN v.id IS NOT NULL THEN v.units_per_pack ELSE COALESCE(p.units_per_pack, 1) END) AS content_amount,
  CASE CASE WHEN v.id IS NOT NULL THEN v.pack_unit ELSE p.pack_unit END
    WHEN 'ml' THEN 'volume' WHEN 'l' THEN 'volume' WHEN 'g' THEN 'mass' WHEN 'kg' THEN 'mass' WHEN 'unit' THEN 'count' END AS content_dimension,
  -- multiply price by unit_factor / content_amount to get price per 100 ml, per 100 g or per unit
  CASE CASE WHEN v.id IS NOT NULL THEN v.pack_unit ELSE p.pack_unit END
    WHEN 'unit' THEN 1.0 WHEN 'ml' THEN 100.0 WHEN 'l' THEN 100.0 WHEN 'g' THEN 100.0 WHEN 'kg' THEN 100.0 END AS unit_factor
FROM retailer_listings l
JOIN retailers r ON r.id = l.retailer_id
JOIN markets m ON m.id = r.market_id
LEFT JOIN products p ON p.id = l.product_id
LEFT JOIN product_variants v ON v.id = l.variant_id
LEFT JOIN brands b ON b.id = p.brand_id
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN categories sc ON sc.id = p.subcategory_id;
