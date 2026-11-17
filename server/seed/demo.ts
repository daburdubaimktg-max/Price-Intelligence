/**
 * DEMO dataset loader and purge.
 *
 * `seedDemo` fills an empty workspace with an illustrative catalogue, retailers, listings and ~120 days of
 * FICTIONAL price history so every screen is usable immediately. Everything it creates is flagged
 * is_demo = 1; simulated observations additionally carry source_method = 'simulated'. Nothing is presented
 * as a real market observation, and `purgeDemo` removes all of it without touching real data.
 */
import type { AppContext } from '../context.ts';
import { AppError } from '../lib/errors.ts';
import { addDays, diffDays, localDate, nowIso, zonedTimeToUtc } from '../lib/time.ts';
import { setSetting } from '../services/core.ts';
import { ingestObservations, type ObservationInput } from '../services/ingestion.ts';
import { recordRate } from '../services/fx.ts';
import type { DealTag } from '../../shared/constants.ts';
import {
  DEMO_BRANDS, DEMO_BRAND_COMPETITORS, DEMO_CATEGORIES, DEMO_EXTRA_RATES, DEMO_MAPPINGS, DEMO_MARKET_ECONOMICS, DEMO_PRODUCTS,
  DEMO_RETAILERS, DEMO_UNMATCHED_LISTINGS, PROMO_TYPES_BY_KIND, type DemoProduct, type DemoRetailer,
} from './demo-catalogue.ts';
import {
  demoObservation, hashSeed, keyedRandom, roundToStep, simulateDays, type DemoDayState, type DemoProfile, type SimulatedConnectorConfig,
} from './demo-model.ts';

/** Badges the demo model gives online listings; a shelf label in a store never carries them. */
const ONLINE_ONLY_TAGS: ReadonlySet<DealTag> = new Set<DealTag>(['best_seller', 'retailer_choice']);

/** Fictional third-party sellers on the demo marketplaces. */
const DEMO_SELLERS = ['Gulf Beauty Hub', 'Daily Essentials Trading', 'Family Care Store', 'Oasis Personal Care', 'Metro Health & Beauty'];

const HISTORY_DAYS = 120;
/** Days for which collection jobs are recorded and alert rules are evaluated. */
const RECENT_DAYS = 14;
const FREQUENCY_SLOTS: Record<string, number[]> = { '6h': [0, 6, 12, 18], '12h': [6, 18], daily: [6], weekly: [6], manual: [] };
const FREQUENCY_HOURS: Record<string, number> = { '6h': 6, '12h': 12, daily: 24, weekly: 168 };

const slug = (text: string) => text.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Fictional barcode in the GS1 "restricted circulation" range (prefix 2), so it can never collide with a real product. */
function demoGtin(n: number): string {
  const body = `299${String(n).padStart(9, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

interface MarketRow {
  id: number;
  code: string;
  currency_code: string;
  timezone: string;
}

interface ListingPlan {
  listingId: number;
  profile: DemoProfile;
  states: DemoDayState[];
}

interface RetailerPlan {
  def: DemoRetailer;
  id: number;
  market: MarketRow;
  listings: ListingPlan[];
  minuteOffset: number;
}

export function demoDataPresent(ctx: AppContext): boolean {
  const { db } = ctx;
  return (
    (db.scalar<number>('SELECT COUNT(*) FROM products WHERE is_demo = 1') ?? 0) > 0 ||
    (db.scalar<number>('SELECT COUNT(*) FROM retailers WHERE is_demo = 1') ?? 0) > 0 ||
    (db.scalar<number>('SELECT COUNT(*) FROM price_observations WHERE is_demo = 1') ?? 0) > 0
  );
}

/** Loads the clearly-labelled DEMO dataset. Returns row counts per entity. */
export async function seedDemo(ctx: AppContext): Promise<Record<string, number>> {
  if (demoDataPresent(ctx)) throw new AppError(409, 'conflict', 'Demo data is already loaded');
  const { db } = ctx;
  const now = new Date();
  const nowMs = now.getTime();
  const stamp = now.toISOString();
  const todayUtc = stamp.slice(0, 10);
  const epoch = addDays(todayUtc, -(HISTORY_DAYS + 1));
  const recentFrom = addDays(todayUtc, -RECENT_DAYS);

  const markets = new Map<string, MarketRow>();
  for (const m of db.all<MarketRow>('SELECT id, code, currency_code, timezone FROM markets')) markets.set(m.code, m);
  const missingMarkets = Object.keys(DEMO_MARKET_ECONOMICS).filter((code) => !markets.has(code));
  if (missingMarkets.length) {
    throw new AppError(409, 'conflict', `The demo dataset needs these markets to exist: ${missingMarkets.join(', ')}`);
  }
  const analyst =
    db.get<{ id: number }>(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key IN ('analyst', 'admin') AND u.is_active = 1 ORDER BY r.key = 'analyst' DESC, u.id LIMIT 1`)?.id ?? null;

  const counts: Record<string, number> = {};

  db.tx(() => {
    setSetting(ctx, 'demo_epoch', epoch);

    // ---- categories, brands, products ---------------------------------------------------------
    const categoryIds = new Map<string, number>();
    const ensureCategory = (name: string, parentId: number | null): number => {
      const existing = db.get<{ id: number }>(
        'SELECT id FROM categories WHERE name = ? AND COALESCE(parent_id, 0) = ?',
        [name, parentId ?? 0],
      );
      if (existing) return existing.id;
      return db.run('INSERT INTO categories (name, parent_id, is_demo, created_at) VALUES (?, ?, 1, ?)', [name, parentId, stamp]).lastInsertRowid;
    };
    for (const [category, subs] of Object.entries(DEMO_CATEGORIES)) {
      const id = ensureCategory(category, null);
      categoryIds.set(category, id);
      for (const sub of subs) categoryIds.set(`${category}/${sub}`, ensureCategory(sub, id));
    }

    const brandIds = new Map<string, number>();
    for (const brand of DEMO_BRANDS) {
      const existing = db.get<{ id: number }>('SELECT id FROM brands WHERE name = ?', [brand.name]);
      const id =
        existing?.id ??
        db.run('INSERT INTO brands (name, ownership, manufacturer, is_demo, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', [
          brand.name, brand.ownership, brand.manufacturer, stamp, stamp,
        ]).lastInsertRowid;
      brandIds.set(brand.name, id);
    }
    for (const [own, competitors] of Object.entries(DEMO_BRAND_COMPETITORS)) {
      for (const competitor of competitors) {
        db.run('INSERT OR IGNORE INTO brand_competitors (own_brand_id, competitor_brand_id) VALUES (?, ?)', [brandIds.get(own)!, brandIds.get(competitor)!]);
      }
    }

    const productIds = new Map<string, number>();
    const productByKey = new Map<string, DemoProduct>();
    let productsReused = 0;
    DEMO_PRODUCTS.forEach((p, index) => {
      // A demo product that real data came to depend on was kept as a real product when demo data was removed.
      // Loading the demo dataset again attaches to that product instead of colliding with it.
      const kept = db.get<{ id: number }>('SELECT id FROM products WHERE sku = ? OR gtin = ?', [`DEMO-${p.key.toUpperCase()}`, demoGtin(index + 1)]);
      if (kept) productsReused++;
      const id = kept?.id ?? db.run(
        `INSERT INTO products (brand_id, name, product_line, category_id, subcategory_id, sku, gtin, pack_size, pack_unit, units_per_pack,
           description, status, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', 1, ?, ?)`,
        [
          brandIds.get(p.brand)!, p.name, p.line, categoryIds.get(p.category)!, categoryIds.get(`${p.category}/${p.subcategory}`)!,
          `DEMO-${p.key.toUpperCase()}`, demoGtin(index + 1), p.size, p.unit, 'DEMO product — illustrative catalogue entry.', stamp, stamp,
        ],
      ).lastInsertRowid;
      productIds.set(p.key, id);
      productByKey.set(p.key, p);
      const codes = p.markets === 'ALL' ? [...markets.keys()].filter((c) => c in DEMO_MARKET_ECONOMICS) : p.markets;
      for (const code of codes) {
        db.run('INSERT OR IGNORE INTO product_markets (product_id, market_id) VALUES (?, ?)', [id, markets.get(code)!.id]);
      }
    });
    counts.products = productIds.size - productsReused;
    if (productsReused) counts.products_reused = productsReused;

    let mappingCount = 0;
    for (const m of DEMO_MAPPINGS) {
      mappingCount += db.run(
        `INSERT OR IGNORE INTO competitor_mappings (own_product_id, competitor_product_id, equivalence, status, score, rationale, decided_by, decided_at, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          productIds.get(m.own)!, productIds.get(m.competitor)!, m.equivalence, m.status, m.status === 'suggested' ? 0.8 : null, m.rationale,
          m.status === 'approved' ? analyst : null, m.status === 'approved' ? stamp : null, stamp, stamp,
        ],
      ).changes;
    }
    counts.competitor_mappings = mappingCount;

    const ensureVariant = (productId: number, name: string, size: number, units: number, notes: string): number =>
      db.get<{ id: number }>('SELECT id FROM product_variants WHERE product_id = ? AND name = ?', [productId, name])?.id ??
      db.run(`INSERT INTO product_variants (product_id, name, pack_size, pack_unit, units_per_pack, notes, created_at) VALUES (?, ?, ?, 'ml', ?, ?, ?)`, [
        productId, name, size, units, notes, stamp,
      ]).lastInsertRowid;
    const twinPackVariant = ensureVariant(productIds.get('amla200')!, 'Twin pack 2 × 200ml', 200, 2, 'DEMO variant: unit price is calculated on 400ml.');
    const bonusPackVariant = ensureVariant(productIds.get('vatbs400')!, 'Bonus pack 400ml + 100ml free', 500, 1, 'DEMO variant: unit price is calculated on 500ml.');

    // ---- exchange rates (illustrative, flagged DEMO) -------------------------------------------
    let rateCount = 0;
    const rateSource = 'DEMO illustrative rate';
    for (let week = 12; week >= 0; week--) {
      const asOf = new Date(nowMs - week * 7 * 86_400_000 - 3 * 3_600_000).toISOString();
      for (const [code, eco] of Object.entries(DEMO_MARKET_ECONOMICS)) {
        const wobble = eco.pegged ? 1 : 1 + (keyedRandom(`fx:${code}:${week}`) - 0.5) * 0.02;
        if (recordRate(ctx, { quote: markets.get(code)!.currency_code, rate: eco.perUsd * wobble, as_of: asOf, source: rateSource, source_ref: 'Illustrative value for the demo dataset — not a market rate', isDemo: true })) rateCount++;
      }
      for (const [code, perUsd] of Object.entries(DEMO_EXTRA_RATES)) {
        const wobble = 1 + (keyedRandom(`fx:${code}:${week}`) - 0.5) * 0.02;
        if (recordRate(ctx, { quote: code, rate: perUsd * wobble, as_of: asOf, source: rateSource, source_ref: 'Illustrative value for the demo dataset — not a market rate', isDemo: true })) rateCount++;
      }
    }
    counts.exchange_rates = rateCount;

    // ---- retailers and listings ----------------------------------------------------------------
    const maxDay = diffDays(epoch, todayUtc) + 2;
    const plans: RetailerPlan[] = [];
    const retailerIdByName = new Map<string, number>();
    const brandByName = new Map(DEMO_BRANDS.map((b) => [b.name, b]));
    const CORE = new Set(['amla200', 'para200', 'vatbs400', 'pant400', 'herbclove150', 'colherb125']);

    const buildProfile = (retailer: DemoRetailer, product: DemoProduct, key: string, baseMultiplier = 1): DemoProfile => {
      const eco = DEMO_MARKET_ECONOMICS[retailer.market]!;
      const brand = brandByName.get(product.brand)!;
      const kindFactor = retailer.kind === 'hypermarket' ? 1.1 : retailer.kind === 'marketplace' ? 1.0 : 0.7;
      const local = product.baseAed * baseMultiplier * eco.level * retailer.priceFactor * (eco.perUsd / DEMO_MARKET_ECONOMICS.AE!.perUsd);
      const jitter = 1 + (keyedRandom(`base:${key}`) - 0.5) * 0.04;
      return {
        seed: hashSeed(`demo:${key}`),
        base: roundToStep(local * jitter, eco.step),
        step: eco.step,
        promo: Math.min(0.5, brand.promo * kindFactor),
        depths: brand.promo >= 0.28 ? [0.1, 0.15, 0.2, 0.25, 0.3, 0.33] : [0.1, 0.15, 0.2, 0.25],
        types: PROMO_TYPES_BY_KIND[retailer.kind],
        drift: 0.05,
        oos: 0.006,
        // Marketplaces name a seller (often a third party) and show a sales rank; stores sell everything themselves.
        seller:
          retailer.kind === 'marketplace' && keyedRandom(`seller:${key}`) >= 0.6
            ? DEMO_SELLERS[Math.floor(keyedRandom(`seller-name:${key}`) * DEMO_SELLERS.length)]!
            : retailer.name,
        ...(retailer.kind === 'marketplace' ? { rankIn: product.subcategory } : {}),
      };
    };

    const insertListing = (retailerId: number, values: { productId: number | null; variantId?: number | null; externalId: string; title: string; gtin?: string | null; path: string }) =>
      db.run(
        `INSERT INTO retailer_listings (retailer_id, product_id, variant_id, external_id, url, title, gtin, match_status, matched_by, matched_at, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          retailerId, values.productId, values.variantId ?? null, values.externalId, `https://demo.invalid/${values.path}`, values.title, values.gtin ?? null,
          values.productId ? 'matched' : 'unmatched', values.productId ? analyst : null, values.productId ? stamp : null, stamp, stamp,
        ],
      ).lastInsertRowid;

    let listingCount = 0;
    let retailersSkipped = 0;
    for (const def of DEMO_RETAILERS) {
      const market = markets.get(def.market)!;
      // A demo retailer that was handed over as a real source (it had real listings when demo data was removed)
      // is left alone: nothing simulated is attached to a real source.
      if (db.get('SELECT 1 FROM retailers WHERE name = ? AND market_id = ?', [def.name, market.id])) {
        retailersSkipped++;
        continue;
      }
      const retailerId = db.run(
        `INSERT INTO retailers (name, website, country_code, market_id, currency_code, collection_method, collection_frequency, is_enabled,
           connector_config, notes, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, ?)`,
        [
          def.name, def.website, def.market, market.id, market.currency_code, def.method, def.frequency, def.paused ? 0 : 1,
          'DEMO source — prices are simulated/illustrative. This is not a connection to the retailer.', stamp, stamp,
        ],
      ).lastInsertRowid;
      retailerIdByName.set(def.name, retailerId);
      const plan: RetailerPlan = { def, id: retailerId, market, listings: [], minuteOffset: 5 + Math.floor(keyedRandom(`minute:${def.name}`) * 40) };
      const retailerSlug = slug(def.name);
      for (const product of DEMO_PRODUCTS) {
        const inMarket = product.markets === 'ALL' || product.markets.includes(def.market);
        if (!inMarket) continue;
        const listed = CORE.has(product.key) || keyedRandom(`assort:${def.name}:${product.key}`) < def.assortment;
        if (!listed) continue;
        const key = `${def.name}:${product.key}`;
        const listingId = insertListing(retailerId, {
          productId: productIds.get(product.key)!,
          externalId: `${retailerSlug}-${product.key}`.toUpperCase(),
          title: product.name,
          path: `${retailerSlug}/${slug(product.name)}`,
        });
        const profile = buildProfile(def, product, key);
        plan.listings.push({ listingId, profile, states: simulateDays(profile, maxDay) });
        listingCount++;
      }
      // pack variants sold as separate listings
      if (def.name === 'Lulu Hypermarket UAE') {
        const product = productByKey.get('amla200')!;
        const listingId = insertListing(retailerId, {
          productId: productIds.get('amla200')!, variantId: twinPackVariant, externalId: `${retailerSlug}-AMLA200-TWIN`.toUpperCase(),
          title: 'Dabur Amla Hair Oil 200ml Twin Pack (2 × 200ml)', path: `${retailerSlug}/dabur-amla-hair-oil-200ml-twin-pack`,
        });
        const profile = buildProfile(def, product, `${def.name}:amla200-twin`, 1.9);
        plan.listings.push({ listingId, profile, states: simulateDays(profile, maxDay) });
        listingCount++;
      }
      if (def.name === 'Carrefour UAE') {
        const product = productByKey.get('vatbs400')!;
        const listingId = insertListing(retailerId, {
          productId: productIds.get('vatbs400')!, variantId: bonusPackVariant, externalId: `${retailerSlug}-VATBS400-BONUS`.toUpperCase(),
          title: 'Vatika Black Seed Shampoo 400ml + 100ml Free', path: `${retailerSlug}/vatika-black-seed-shampoo-bonus-pack`,
        });
        const profile = buildProfile(def, product, `${def.name}:vatbs400-bonus`, 1.02);
        plan.listings.push({ listingId, profile, states: simulateDays(profile, maxDay) });
        listingCount++;
      }
      for (const unmatched of DEMO_UNMATCHED_LISTINGS.filter((u) => u.retailer === def.name)) {
        const gtin = unmatched.gtinOf ? demoGtin(DEMO_PRODUCTS.findIndex((p) => p.key === unmatched.gtinOf) + 1) : null;
        const listingId = insertListing(retailerId, {
          productId: null, externalId: unmatched.externalId, title: unmatched.title, gtin, path: `${retailerSlug}/${slug(unmatched.title)}`,
        });
        listingCount++;
        if (unmatched.profileOf) {
          const profile = buildProfile(def, productByKey.get(unmatched.profileOf)!, `${def.name}:unmatched:${unmatched.externalId}`, 1.01);
          plan.listings.push({ listingId, profile, states: simulateDays(profile, maxDay) });
        }
      }
      if (def.method === 'simulated') {
        const config: SimulatedConnectorConfig = {
          simulated: { failure_rate: def.failureRate, profiles: Object.fromEntries(plan.listings.map((l) => [String(l.listingId), l.profile])) },
        };
        db.run('UPDATE retailers SET connector_config = ? WHERE id = ?', [JSON.stringify(config), retailerId]);
      }
      plans.push(plan);
    }
    counts.retailers = plans.length;
    if (retailersSkipped) counts.retailers_skipped = retailersSkipped;
    counts.listings = listingCount;

    // ---- price history -------------------------------------------------------------------------
    const slotTime = (plan: RetailerPlan, date: string, hour: number, minute = plan.minuteOffset): Date => {
      const [y, m, d] = date.split('-').map(Number) as [number, number, number];
      return zonedTimeToUtc(y, m, d, hour, minute, 0, plan.market.timezone);
    };
    const observationFor = (plan: RetailerPlan, listing: ListingPlan, date: string, at: Date, extra: Partial<ObservationInput> = {}): ObservationInput | null => {
      const day = diffDays(epoch, date);
      const state = listing.states[day];
      if (!state) return null;
      const observation = { ...demoObservation(listing.listingId, state, at.toISOString(), epoch), ...extra };
      // A shelf check (store visit, imported shelf prices) sees the offer on the shelf label, but no online
      // rating, sales rank, seller or badge.
      if (plan.def.method === 'manual' || plan.def.method === 'csv_import') {
        return {
          ...observation,
          tags: (observation.tags ?? []).filter((tag) => !ONLINE_ONLY_TAGS.has(tag)),
          rating: null, review_count: null, sales_rank: null, sales_rank_label: null, seller_name: null,
        };
      }
      return observation;
    };

    interface Slot {
      plan: RetailerPlan;
      date: string;
      slotIndex: number;
      at: Date;
    }
    const recentSlots: Slot[] = [];
    let observationCount = 0;
    let jobCount = 0;

    for (const plan of plans) {
      const { def } = plan;
      const localToday = localDate(now, plan.market.timezone);
      const lastDate = def.paused ? addDays(localToday, -9) : localToday;
      const firstDate = addDays(todayUtc, -HISTORY_DAYS);

      if (def.method === 'csv_import') {
        // Illustrative imported history: weekly shelf checks delivered as two CSV files.
        const dates: string[] = [];
        for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
          if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) dates.push(date);
        }
        const half = Math.ceil(dates.length / 2);
        const groups = [dates.slice(0, half), dates.slice(half)].filter((g) => g.length);
        groups.forEach((group, index) => {
          const fileName = `${slug(def.name)}-shelf-prices-${group[0]}-to-${group[group.length - 1]}.csv`;
          const importedAt = new Date(Math.min(nowMs - 3_600_000, Date.parse(`${group[group.length - 1]}T00:00:00Z`) + 3 * 86_400_000)).toISOString();
          const evidenceId = db.run(
            `INSERT INTO source_evidence (kind, reference, file_name, note, captured_at, uploaded_by, is_demo, created_at)
             VALUES ('csv_file', ?, ?, ?, ?, ?, 1, ?)`,
            [fileName, fileName, 'DEMO: illustrative imported price history (no real file is stored).', importedAt, analyst, importedAt],
          ).lastInsertRowid;
          const batchId = db.run(
            `INSERT INTO import_batches (kind, file_name, status, options, evidence_id, created_by, created_at, committed_at, is_demo)
             VALUES ('observations', ?, 'committed', ?, ?, ?, ?, ?, 1)`,
            [fileName, JSON.stringify({ default_confidence: 0.7, evidence_kind: 'csv_file', note: `DEMO import ${index + 1}` }), evidenceId, analyst, importedAt, importedAt],
          ).lastInsertRowid;
          const inputs: ObservationInput[] = [];
          for (const date of group) {
            const noon = slotTime(plan, date, 12, 0);
            if (noon.getTime() > nowMs) continue;
            for (const listing of plan.listings) {
              const obs = observationFor(plan, listing, date, noon, {
                observed_basis: 'date_only', confidence: 0.7, evidence_id: evidenceId, collected_at: importedAt,
              });
              if (obs) inputs.push(obs);
            }
          }
          const res = ingestObservations(ctx, inputs, { sourceMethod: 'csv_import', importBatchId: batchId, userId: analyst, suppressAlerts: true, collectedAt: importedAt });
          db.run('UPDATE import_batches SET row_count = ?, valid_count = ?, inserted_count = ?, duplicate_count = ?, error_count = ? WHERE id = ?', [
            inputs.length, inputs.length - res.rejected.length, res.inserted, res.duplicates, res.rejected.length, batchId,
          ]);
          observationCount += res.inserted;
        });
        counts.import_batches = (counts.import_batches ?? 0) + groups.length;
        continue;
      }

      if (def.method === 'manual') {
        // Illustrative manual store checks on Mondays and Thursdays.
        const evidenceId = db.run(
          `INSERT INTO source_evidence (kind, reference, note, uploaded_by, is_demo, created_at) VALUES ('note', ?, ?, ?, 1, ?)`,
          ['Store visit notes (DEMO)', 'DEMO: illustrative manual entries — no real store visit took place.', analyst, stamp],
        ).lastInsertRowid;
        const inputs: ObservationInput[] = [];
        for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
          const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
          if (weekday !== 1 && weekday !== 4) continue;
          const at = slotTime(plan, date, 10, 30);
          if (at.getTime() > nowMs) continue;
          for (const listing of plan.listings) {
            const obs = observationFor(plan, listing, date, at, {
              confidence: 0.95, evidence_id: evidenceId, note: 'DEMO manual entry',
              collected_at: new Date(Math.min(nowMs, at.getTime() + 20 * 60_000)).toISOString(),
            });
            if (obs) inputs.push(obs);
          }
        }
        const res = ingestObservations(ctx, inputs, { sourceMethod: 'manual', userId: analyst, suppressAlerts: true });
        observationCount += res.inserted;
        continue;
      }

      // Simulated demo feed.
      const hours = FREQUENCY_SLOTS[def.frequency] ?? [6];
      const older: ObservationInput[] = [];
      for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
        if (def.frequency === 'weekly' && new Date(`${date}T00:00:00Z`).getUTCDay() !== 1) continue;
        const recent = date >= recentFrom;
        const daySlots = recent ? hours : hours.slice(0, 1);
        daySlots.forEach((hour, slotIndex) => {
          const at = slotTime(plan, date, hour);
          if (at.getTime() > nowMs) return;
          if (recent) {
            recentSlots.push({ plan, date, slotIndex, at });
            return;
          }
          if (keyedRandom(`run:${def.name}:${date}:${slotIndex}`) < def.failureRate) return; // simulated outage: nothing captured
          for (const listing of plan.listings) {
            if (keyedRandom(`miss:${listing.listingId}:${date}`) < 0.012) continue;
            const obs = observationFor(plan, listing, date, at, { collected_at: new Date(at.getTime() + 45_000).toISOString() });
            if (obs) older.push(obs);
          }
        });
      }
      const res = ingestObservations(ctx, older, { sourceMethod: 'simulated', suppressAlerts: true });
      observationCount += res.inserted;
    }

    // Recent period: replay run by run in chronological order so jobs, logs and alerts form a realistic trail.
    recentSlots.sort((a, b) => a.at.getTime() - b.at.getTime());
    const lastRun = new Map<number, { at: string; ok: boolean; failures: number; lastSuccess: string | null }>();
    for (const slot of recentSlots) {
      const { plan, date, slotIndex, at } = slot;
      const startedAt = at.toISOString();
      const durationMs = 15_000 + Math.floor(keyedRandom(`dur:${plan.id}:${startedAt}`) * 70_000);
      const finishedAt = new Date(Math.min(nowMs, at.getTime() + durationMs)).toISOString();
      const failed = keyedRandom(`run:${plan.def.name}:${date}:${slotIndex}`) < plan.def.failureRate;
      const jobId = db.run(
        `INSERT INTO collection_jobs (retailer_id, method, trigger_type, data_class, status, attempt, scheduled_for, started_at, finished_at,
           listings_total, is_demo, created_at)
         VALUES (?, 'simulated', 'schedule', 'simulated', 'running', 1, ?, ?, ?, ?, 1, ?)`,
        [plan.id, startedAt, startedAt, finishedAt, plan.listings.length, startedAt],
      ).lastInsertRowid;
      jobCount++;
      const state = lastRun.get(plan.id) ?? { at: startedAt, ok: true, failures: 0, lastSuccess: null };
      if (failed) {
        db.run(
          `UPDATE collection_jobs SET status = 'failed', listings_failed = ?, error_code = 'simulated_failure', error_message = ? WHERE id = ?`,
          [plan.listings.length, 'Simulated failure (demo): the simulated source did not respond. No data was captured for this run.', jobId],
        );
        db.run(
          `INSERT INTO collection_logs (job_id, retailer_id, level, code, message, created_at) VALUES (?, ?, 'error', 'simulated_failure', ?, ?)`,
          [jobId, plan.id, 'Simulated failure (demo): the simulated source did not respond.', finishedAt],
        );
        lastRun.set(plan.id, { at: startedAt, ok: false, failures: state.failures + 1, lastSuccess: state.lastSuccess });
        continue;
      }
      const inputs: ObservationInput[] = [];
      const missing: number[] = [];
      for (const listing of plan.listings) {
        if (keyedRandom(`miss:${listing.listingId}:${date}:${slotIndex}`) < 0.012) {
          missing.push(listing.listingId);
          continue;
        }
        const obs = observationFor(plan, listing, date, at, { collected_at: finishedAt });
        if (obs) inputs.push(obs);
      }
      const res = ingestObservations(ctx, inputs, { sourceMethod: 'simulated', jobId, alertMaxAgeHours: (RECENT_DAYS + 2) * 24, collectedAt: finishedAt });
      observationCount += res.inserted;
      for (const listingId of missing) {
        db.run(
          `INSERT INTO collection_logs (job_id, retailer_id, listing_id, level, code, message, created_at) VALUES (?, ?, ?, 'warn', 'listing_missing', ?, ?)`,
          [jobId, plan.id, listingId, 'Simulated gap (demo): the listing was not present in this simulated run.', finishedAt],
        );
      }
      db.run(
        `UPDATE collection_jobs SET status = ?, listings_succeeded = ?, listings_failed = 0, listings_missing = ?, observations_created = ?, duplicates_skipped = ? WHERE id = ?`,
        [missing.length ? 'partial' : 'succeeded', inputs.length, missing.length, res.inserted, res.duplicates, jobId],
      );
      lastRun.set(plan.id, { at: startedAt, ok: true, failures: 0, lastSuccess: finishedAt });
    }
    counts.observations = observationCount;
    counts.collection_jobs = jobCount;

    // Scheduling state so the always-on scheduler simply continues from here.
    for (const plan of plans) {
      if (plan.def.method !== 'simulated') continue;
      const state = lastRun.get(plan.id);
      const hoursBetween = FREQUENCY_HOURS[plan.def.frequency] ?? 24;
      const nextRun = state ? new Date(Date.parse(state.at) + hoursBetween * 3_600_000).toISOString() : stamp;
      db.run('UPDATE retailers SET last_attempt_at = ?, last_success_at = ?, consecutive_failures = ?, next_run_at = ? WHERE id = ?', [
        state?.at ?? null, state?.lastSuccess ?? null, state?.failures ?? 0, plan.def.paused ? null : nextRun, plan.id,
      ]);
    }
  });

  // Stale-listing and failing-source alerts are derived from the seeded state now rather than at the first scheduler tick.
  try {
    const { runStateChecks } = await import('../services/alerts.ts');
    runStateChecks(ctx);
  } catch (err) {
    ctx.log.warn({ err }, 'could not evaluate state alerts after seeding demo data');
  }

  counts.alerts = db.scalar<number>('SELECT COUNT(*) FROM alerts WHERE is_demo = 1') ?? 0;
  counts.promotions = db.scalar<number>('SELECT COUNT(*) FROM promotions WHERE is_demo = 1') ?? 0;
  counts.price_events = db.scalar<number>('SELECT COUNT(*) FROM price_events WHERE is_demo = 1') ?? 0;
  return counts;
}

/** Removes every DEMO record (is_demo = 1). Real data is never touched. Returns deleted row counts per entity. */
export function purgeDemo(ctx: AppContext): Record<string, number> {
  const { db } = ctx;
  const counts: Record<string, number> = {};
  const now = nowIso();
  db.tx(() => {
    counts.alerts = db.run('DELETE FROM alerts WHERE is_demo = 1').changes;

    // Derived rows of demo listings go first (they reference observations).
    db.run('DELETE FROM price_events WHERE listing_id IN (SELECT id FROM retailer_listings WHERE is_demo = 1)');
    db.run('DELETE FROM promotions WHERE listing_id IN (SELECT id FROM retailer_listings WHERE is_demo = 1)');
    db.run('DELETE FROM listing_state WHERE listing_id IN (SELECT id FROM retailer_listings WHERE is_demo = 1)');
    counts.observations = db.run('DELETE FROM price_observations WHERE is_demo = 1').changes;
    counts.collection_jobs = db.run('DELETE FROM collection_jobs WHERE is_demo = 1').changes;
    counts.import_batches = db.run('DELETE FROM import_batches WHERE is_demo = 1').changes;
    counts.source_evidence = db.run(
      `DELETE FROM source_evidence WHERE is_demo = 1
         AND id NOT IN (SELECT evidence_id FROM price_observations WHERE evidence_id IS NOT NULL)
         AND id NOT IN (SELECT evidence_id FROM import_batches WHERE evidence_id IS NOT NULL)`,
    ).changes;

    // Demo retailers that a user has since added real listings to are kept and handed over as real, manual sources.
    counts.retailers_kept = db.run(
      `UPDATE retailers SET is_demo = 0, collection_method = 'manual', collection_frequency = 'manual', connector_config = '{}',
         notes = 'Converted from a demo source when demo data was removed.', next_run_at = NULL, updated_at = ?
       WHERE is_demo = 1 AND id IN (SELECT retailer_id FROM retailer_listings WHERE is_demo = 0)`,
      [now],
    ).changes;
    counts.listings = db.run('DELETE FROM retailer_listings WHERE is_demo = 1').changes;
    counts.retailers = db.run('DELETE FROM retailers WHERE is_demo = 1').changes;

    // Real listings that were matched to a demo product become unmatched again.
    counts.listings_unmatched = db.run(
      `UPDATE retailer_listings SET product_id = NULL, variant_id = NULL, match_status = 'unmatched', matched_by = NULL, matched_at = NULL, updated_at = ?
       WHERE is_demo = 0 AND product_id IN (SELECT id FROM products WHERE is_demo = 1)`,
      [now],
    ).changes;
    counts.competitor_mappings = db.run(
      `DELETE FROM competitor_mappings WHERE is_demo = 1
         OR own_product_id IN (SELECT id FROM products WHERE is_demo = 1)
         OR competitor_product_id IN (SELECT id FROM products WHERE is_demo = 1)`,
    ).changes;
    counts.products = db.run('DELETE FROM products WHERE is_demo = 1').changes;

    // Brands and categories still used by real products are kept and simply un-flagged.
    db.run('UPDATE brands SET is_demo = 0, updated_at = ? WHERE is_demo = 1 AND id IN (SELECT brand_id FROM products)', [now]);
    counts.brands = db.run('DELETE FROM brands WHERE is_demo = 1').changes;
    db.run(
      `UPDATE categories SET is_demo = 0 WHERE is_demo = 1 AND (
         id IN (SELECT category_id FROM products) OR id IN (SELECT subcategory_id FROM products WHERE subcategory_id IS NOT NULL)
         OR id IN (SELECT parent_id FROM categories WHERE is_demo = 0 AND parent_id IS NOT NULL))`,
    );
    db.run(
      `UPDATE categories SET is_demo = 0 WHERE is_demo = 1 AND id IN (
         SELECT parent_id FROM categories WHERE parent_id IS NOT NULL AND is_demo = 0)`,
    );
    counts.categories =
      db.run('DELETE FROM categories WHERE is_demo = 1 AND parent_id IS NOT NULL').changes +
      db.run('DELETE FROM categories WHERE is_demo = 1 AND id NOT IN (SELECT parent_id FROM categories WHERE parent_id IS NOT NULL)').changes;

    counts.exchange_rates = db.run('DELETE FROM exchange_rates WHERE is_demo = 1').changes;
    counts.alert_rules = db.run('DELETE FROM alert_rules WHERE is_demo = 1').changes;
    db.run(`DELETE FROM settings WHERE key = 'demo_epoch'`);
  });
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
  } catch (err) {
    ctx.log.warn({ err }, 'could not compact the database after removing demo data');
  }
  return counts;
}
