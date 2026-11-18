-- Price Intelligence OS — observation signals.
--
-- What a retailer shows next to a price is evidence too: deal tags ("Limited time deal", "Yellow Friday Deal",
-- coupons, best-seller badges), the rating and number of reviews, the sales rank and the seller. From this
-- version on they are stored with every observation, so they are kept historically exactly like the price
-- they were seen with.
--
-- The ledger stays append-only: columns are only ADDED (observations recorded earlier simply carry no
-- signals) and the UPDATE / DELETE triggers of price_observations are not touched.

-- JSON array of tag keys in canonical order, e.g. ["limited_time_deal","best_seller"]. '[]' = no tags.
ALTER TABLE price_observations ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(tags) AND json_type(tags) = 'array');
-- The retailer's own wording of the tag, e.g. "Early Yellow Friday Deal".
ALTER TABLE price_observations ADD COLUMN tag_text TEXT;
-- Average customer rating (0–5) and the number of ratings / reviews behind it.
ALTER TABLE price_observations ADD COLUMN rating REAL
  CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5));
ALTER TABLE price_observations ADD COLUMN review_count INTEGER
  CHECK (review_count IS NULL OR review_count >= 0);
-- Position in the retailer's sales ranking and the list it refers to, e.g. 3 and "#3 in Shampoos".
ALTER TABLE price_observations ADD COLUMN sales_rank INTEGER
  CHECK (sales_rank IS NULL OR sales_rank >= 0);
ALTER TABLE price_observations ADD COLUMN sales_rank_label TEXT;
-- Who sells the item on the listing (the retailer itself or a marketplace seller).
ALTER TABLE price_observations ADD COLUMN seller_name TEXT;

-- The view of non-voided observations selects o.*; it is re-created so that it is guaranteed to expose the
-- new columns.
DROP VIEW IF EXISTS v_observations;
CREATE VIEW v_observations AS
SELECT o.* FROM price_observations o
WHERE NOT EXISTS (SELECT 1 FROM observation_voids v WHERE v.observation_id = o.id);

-- Tagged observations only (most observations carry no tag), newest first per listing: "is this listing
-- tagged now / when was it last tagged" and tag filters read this small index instead of the whole ledger.
-- Queries must state `tags <> '[]'` for the index to be considered.
CREATE INDEX idx_observations_tagged ON price_observations (listing_id, observed_at DESC, id DESC)
  WHERE tags <> '[]';
