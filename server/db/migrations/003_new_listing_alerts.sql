-- Price Intelligence OS — alert when a collection run finds products that were not at a retailer before.
--
-- alert_rules restricts `type` with a CHECK constraint, and SQLite cannot change a constraint in place, so the
-- table is rebuilt with the extended list ('new_listing' added). Dropping the old table sets alerts.rule_id to
-- NULL (ON DELETE SET NULL): the links are remembered first and put back afterwards. Rule ids are kept.
--
-- Nothing else changes. The price ledger (price_observations) and its triggers are not touched.

CREATE TEMP TABLE _alert_rule_links AS SELECT id AS alert_id, rule_id FROM alerts WHERE rule_id IS NOT NULL;

CREATE TABLE alert_rules_v3 (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'competitor_price_drop', 'own_more_expensive', 'competitor_promotion', 'product_unavailable',
    'price_change', 'price_increase', 'collection_failed', 'stale_observation', 'new_listing')),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  threshold_pct REAL,                     -- % threshold for price / discount / gap rules
  threshold_count INTEGER,                -- consecutive failures (collection_failed) / new listings in one run (new_listing)
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

INSERT INTO alert_rules_v3 (id, name, type, is_enabled, severity, threshold_pct, threshold_count, threshold_hours, market_id, retailer_id,
  brand_id, category_id, product_id, channels, cooldown_hours, created_by, is_demo, created_at, updated_at)
SELECT id, name, type, is_enabled, severity, threshold_pct, threshold_count, threshold_hours, market_id, retailer_id,
  brand_id, category_id, product_id, channels, cooldown_hours, created_by, is_demo, created_at, updated_at
FROM alert_rules;

DROP TABLE alert_rules;
ALTER TABLE alert_rules_v3 RENAME TO alert_rules;

UPDATE alerts SET rule_id = (SELECT l.rule_id FROM _alert_rule_links l WHERE l.alert_id = alerts.id)
WHERE id IN (SELECT alert_id FROM _alert_rule_links);
DROP TABLE _alert_rule_links;

-- Installations that already have their rule set get the standard rule for the new type (in-app, informational).
-- An empty installation receives it with the other default rules when the application starts.
INSERT INTO alert_rules (name, type, is_enabled, severity, threshold_pct, threshold_count, threshold_hours, channels, cooldown_hours, is_demo, created_at, updated_at)
SELECT 'New products found at a retailer', 'new_listing', 1, 'info', NULL, 1, NULL, '["in_app"]', 0, 0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM alert_rules)
  AND NOT EXISTS (SELECT 1 FROM alert_rules WHERE type = 'new_listing');
