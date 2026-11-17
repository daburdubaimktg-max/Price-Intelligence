/**
 * Retailers (collection sources) and their listings.
 *
 * A retailer is pure configuration: method, schedule, connector settings, an encrypted credential and —
 * for website extraction — an explicit attestation that access is permitted. Running or testing a
 * collection lives in the collection engine (/collection/...), not here.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SqlParam } from '../db/sqlite.ts';
import { placeholders } from '../db/sqlite.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { idList, idParam, likePattern, optBool, orderBy, paged, pagination, parse, requiredId, strList } from '../lib/http.ts';
import { nowIso } from '../lib/time.ts';
import { audit, deleteSecret, retailerSecretName, secretStatus, setSecret } from '../services/core.ts';
import { countListings, fetchListings, getListing, matchListing, normaliseGtin, unmatchListing } from '../services/matching.ts';
import { AUTOMATED_METHODS, COLLECTION_METHODS, FREQUENCIES, roleCan } from '../../shared/constants.ts';
import type { RetailerRow } from '../../shared/api/catalogue.ts';
import { applyUpdate, changedFields, httpUrl, optFlag, optId, optNum, optText } from './reference.ts';

const frequency = () =>
  z
    .union([z.enum(FREQUENCIES), z.literal(''), z.null()])
    .transform((v) => (v === '' ? null : v))
    .optional();

const retailerFields = {
  name: z.string().trim().min(1).max(200),
  website: optText(500),
  market_id: requiredId(),
  country_code: optText(8),
  currency_code: optText(3),
  collection_method: z.enum(COLLECTION_METHODS),
  /** null / '' = inherit the market's default schedule. */
  collection_frequency: frequency(),
  is_enabled: optFlag(),
  connector_config: z.record(z.string(), z.unknown()).optional(),
  rate_limit_ms: optNum(),
  notes: optText(2000),
  is_active: optFlag(),
};

const listingFields = {
  retailer_id: requiredId(),
  url: z.string().trim().min(1).max(2000),
  external_id: optText(200),
  title: optText(500),
  gtin: optText(40),
  product_id: optId(),
  variant_id: optId(),
  is_active: optFlag(),
};

const RETAILER_SELECT = `
  SELECT r.id, r.name, r.website, r.country_code, r.market_id, m.code AS market_code, m.name AS market_name, m.timezone,
    r.currency_code, r.collection_method, r.collection_frequency, m.default_frequency AS market_default_frequency,
    COALESCE(r.collection_frequency, m.default_frequency) AS effective_frequency, r.is_enabled, r.connector_config, r.rate_limit_ms,
    r.permission_attested, r.permission_attested_by, u.name AS permission_attested_by_name, r.permission_attested_at, r.permission_note,
    r.last_attempt_at, r.last_success_at, r.next_run_at, r.consecutive_failures, r.notes, r.is_active, r.is_demo, r.created_at, r.updated_at,
    COALESCE(la.listing_count, 0) AS listing_count, COALESCE(la.active_listing_count, 0) AS active_listing_count,
    COALESCE(la.matched_listing_count, 0) AS matched_listing_count, COALESCE(la.unmatched_listing_count, 0) AS unmatched_listing_count,
    COALESCE(la.observation_count, 0) AS observation_count, la.last_observed_at
  FROM retailers r
  JOIN markets m ON m.id = r.market_id
  LEFT JOIN users u ON u.id = r.permission_attested_by
  LEFT JOIN (
    SELECT l.retailer_id, COUNT(*) AS listing_count, SUM(l.is_active) AS active_listing_count,
      SUM(l.match_status = 'matched') AS matched_listing_count, SUM(l.match_status = 'unmatched') AS unmatched_listing_count,
      SUM(COALESCE(s.obs_count, 0)) AS observation_count, MAX(s.last_observed_at) AS last_observed_at
    FROM retailer_listings l LEFT JOIN listing_state s ON s.listing_id = l.id GROUP BY l.retailer_id
  ) la ON la.retailer_id = r.id`;

const RETAILER_SORTS: Record<string, string> = {
  name: 'r.name COLLATE NOCASE',
  market: 'm.sort_order',
  method: 'r.collection_method',
  listing_count: 'listing_count',
  last_success_at: 'r.last_success_at',
  next_run_at: 'r.next_run_at',
  created_at: 'r.created_at',
};

const LISTING_SORTS: Record<string, string> = {
  code: 'li.listing_id',
  retailer: 'li.retailer_name',
  market: 'li.market_name',
  product: 'li.product_name',
  brand: 'li.brand_name',
  match_status: 'li.match_status',
  current_price: 'o.current_price',
  last_observed_at: 's.last_observed_at',
  obs_count: 'obs_count',
  created_at: 'l.created_at',
};

// Credentials never belong in connector settings: those are readable by administrators and exported with
// the configuration. They go through PUT /retailers/:id/credential, which encrypts them at rest.
const SECRET_KEY = /^(api[-_]?key|x[-_]api[-_]key|token|access[-_]?token|auth[-_]?token|password|passwd|secret|client[-_]?secret|private[-_]?key|authorization)$/i;

function assertSafeConfig(config: Record<string, unknown>): void {
  if (JSON.stringify(config).length > 64 * 1024) throw unprocessable('Connector settings are too large (maximum 64 KB)');
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const here = path ? `${path}.${key}` : key;
        if (SECRET_KEY.test(key)) {
          throw unprocessable(
            `Connector settings must not contain credentials ("${here}"). Save the credential with the retailer's credential setting instead — it is stored encrypted and never shown again.`,
          );
        }
        walk(child, here);
      }
    }
  };
  walk(config, '');
}

const schedulable = (method: string, effectiveFrequency: string, isEnabled: boolean, isActive: boolean) =>
  (AUTOMATED_METHODS as readonly string[]).includes(method) && isEnabled && isActive && effectiveFrequency !== 'manual';

export default async function retailerRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  type RawRetailer = Omit<RetailerRow, 'connector_config' | 'credential'> & { connector_config: string };

  function present(raw: RawRetailer, req: FastifyRequest): RetailerRow {
    const canManage = roleCan(req.user?.role, 'sources.manage');
    const status = secretStatus(ctx, retailerSecretName(raw.id));
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(raw.connector_config) as Record<string, unknown>;
    } catch {
      config = {};
    }
    return {
      ...raw,
      connector_config: canManage ? config : null,
      credential: canManage ? status : { configured: status.configured, hint: null, updated_at: null },
    };
  }

  function retailerRow(id: number, req: FastifyRequest): RetailerRow {
    const raw = db.get<RawRetailer>(`${RETAILER_SELECT} WHERE r.id = ?`, [id]);
    if (!raw) throw notFound('Retailer');
    return present(raw, req);
  }

  function marketDefaults(marketId: number): { id: number; country_code: string; currency_code: string; default_frequency: string } {
    const market = db.get<{ id: number; country_code: string; currency_code: string; default_frequency: string }>(
      'SELECT id, country_code, currency_code, default_frequency FROM markets WHERE id = ?',
      [marketId],
    );
    if (!market) throw unprocessable('The selected market does not exist');
    return market;
  }

  function assertCurrency(code: string): void {
    if (!/^[A-Z]{3}$/.test(code) || !db.get('SELECT code FROM currencies WHERE code = ?', [code])) {
      throw unprocessable(`Currency ${code} is not set up. Add it under currencies first.`);
    }
  }

  // ---- retailers -------------------------------------------------------------------------------
  app.get('/retailers', async (req) => {
    const query = req.query as Record<string, unknown>;
    const where: string[] = [];
    const params: SqlParam[] = [];
    const marketIds = idList(query.market_id);
    if (marketIds) {
      where.push(`r.market_id IN (${placeholders(marketIds.length)})`);
      params.push(...marketIds);
    }
    const methods = strList(query.method)?.filter((m) => (COLLECTION_METHODS as readonly string[]).includes(m));
    if (methods?.length) {
      where.push(`r.collection_method IN (${placeholders(methods.length)})`);
      params.push(...methods);
    }
    if (typeof query.q === 'string' && query.q.trim()) {
      const p = likePattern(query.q.trim());
      where.push(`(r.name LIKE ? ESCAPE '\\' OR r.website LIKE ? ESCAPE '\\')`);
      params.push(p, p);
    }
    const active = optBool(query.active);
    if (active !== undefined) {
      where.push('r.is_active = ?');
      params.push(active);
    }
    const demo = optBool(query.demo);
    if (demo !== undefined) {
      where.push('r.is_demo = ?');
      params.push(demo);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = pagination(query, 200, 500);
    const total = db.scalar<number>(`SELECT COUNT(*) FROM retailers r JOIN markets m ON m.id = r.market_id ${whereSql}`, params) ?? 0;
    const rows = db.all<RawRetailer>(
      `${RETAILER_SELECT} ${whereSql} ORDER BY ${orderBy(query.sort, RETAILER_SORTS, 'm.sort_order, r.name COLLATE NOCASE')}, r.id LIMIT ? OFFSET ?`,
      [...params, page.pageSize, page.offset],
    );
    return paged(rows.map((r) => present(r, req)), total, page);
  });

  app.get('/retailers/:id', async (req) => retailerRow(idParam((req.params as { id: string }).id), req));

  app.post('/retailers', { config: { permission: 'sources.manage' } }, async (req, reply) => {
    const body = parse(z.object(retailerFields), req.body);
    if (body.collection_method === 'simulated') {
      throw unprocessable('The simulated source is reserved for the demo dataset. Choose a real collection method.');
    }
    const market = marketDefaults(body.market_id);
    const currency = (body.currency_code ?? market.currency_code).toUpperCase();
    assertCurrency(currency);
    const website = httpUrl(body.website, 'Website');
    const config = body.connector_config ?? {};
    assertSafeConfig(config);
    const rateLimit = Math.round(body.rate_limit_ms ?? 3000);
    if (rateLimit < 250 || rateLimit > 600_000) throw unprocessable('The delay between requests must be between 250 ms and 10 minutes');
    if (db.get('SELECT id FROM retailers WHERE name = ? COLLATE NOCASE AND market_id = ?', [body.name, market.id])) {
      throw conflict(`A retailer named "${body.name}" already exists in this market`);
    }
    const isEnabled = body.is_enabled ?? true;
    const isActive = body.is_active ?? true;
    const freq = body.collection_frequency ?? null;
    const now = nowIso();
    const id = db.run(
      `INSERT INTO retailers (name, website, country_code, market_id, currency_code, collection_method, collection_frequency, is_enabled,
         connector_config, rate_limit_ms, next_run_at, notes, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.name, website, (body.country_code ?? market.country_code).toUpperCase(), market.id, currency, body.collection_method, freq, isEnabled,
        JSON.stringify(config), rateLimit,
        schedulable(body.collection_method, freq ?? market.default_frequency, isEnabled, isActive) ? now : null,
        body.notes ?? null, isActive, now, now,
      ],
    ).lastInsertRowid;
    audit(ctx, req.user, 'retailer.created', 'retailer', id, { name: body.name, market_id: market.id, collection_method: body.collection_method, collection_frequency: freq }, req.ip);
    return reply.code(201).send(retailerRow(id, req));
  });

  app.patch('/retailers/:id', { config: { permission: 'sources.manage' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = db.get<Record<string, unknown> & {
      name: string; market_id: number; currency_code: string; collection_method: string; collection_frequency: string | null;
      is_enabled: number; is_active: number; is_demo: number; connector_config: string;
    }>('SELECT * FROM retailers WHERE id = ?', [id]);
    if (!before) throw notFound('Retailer');
    const body = parse(z.object(retailerFields).partial(), req.body);

    const method = body.collection_method ?? before.collection_method;
    if (method !== before.collection_method) {
      if (before.is_demo) {
        throw conflict('Demo retailers only carry simulated data and cannot be switched to a real collection method. Create a new retailer for real collection.');
      }
      if (method === 'simulated') throw unprocessable('The simulated source is reserved for the demo dataset. Choose a real collection method.');
    }
    const marketId = body.market_id ?? before.market_id;
    const market = marketDefaults(marketId);
    const currency = body.currency_code === undefined ? before.currency_code : (body.currency_code ?? market.currency_code).toUpperCase();
    if (currency !== before.currency_code) assertCurrency(currency);
    if (marketId !== before.market_id || currency !== before.currency_code) {
      if (before.is_demo) throw conflict('The market and currency of a demo retailer cannot be changed');
      if ((db.scalar<number>('SELECT COUNT(*) FROM price_observations WHERE retailer_id = ?', [id]) ?? 0) > 0) {
        throw conflict('The market and currency of a retailer cannot change once it has price observations. Create a new retailer instead.');
      }
    }
    const name = body.name ?? before.name;
    if ((name !== before.name || marketId !== before.market_id) && db.get('SELECT id FROM retailers WHERE name = ? COLLATE NOCASE AND market_id = ? AND id <> ?', [name, marketId, id])) {
      throw conflict(`A retailer named "${name}" already exists in this market`);
    }
    if (body.connector_config !== undefined) assertSafeConfig(body.connector_config);
    let rateLimit: number | undefined;
    if (body.rate_limit_ms !== undefined) {
      rateLimit = Math.round(body.rate_limit_ms ?? 3000);
      if (rateLimit < 250 || rateLimit > 600_000) throw unprocessable('The delay between requests must be between 250 ms and 10 minutes');
    }

    const changes: Record<string, SqlParam> = {
      name: body.name,
      website: body.website === undefined ? undefined : httpUrl(body.website, 'Website'),
      country_code: body.country_code === undefined ? undefined : (body.country_code ?? market.country_code).toUpperCase(),
      market_id: body.market_id,
      currency_code: body.currency_code === undefined ? undefined : currency,
      collection_method: body.collection_method,
      collection_frequency: body.collection_frequency,
      is_enabled: body.is_enabled,
      connector_config: body.connector_config === undefined ? undefined : JSON.stringify(body.connector_config),
      rate_limit_ms: rateLimit,
      notes: body.notes,
      is_active: body.is_active,
    };
    // Compare connector settings by content, not by formatting.
    let storedConfig = before.connector_config;
    try {
      storedConfig = JSON.stringify(JSON.parse(before.connector_config));
    } catch {
      /* keep the raw text */
    }
    const diff = changedFields({ ...before, connector_config: storedConfig }, changes);
    if (Object.keys(diff).length === 0) return retailerRow(id, req);

    // Re-plan the next run only when something that drives the schedule changed.
    const freq = body.collection_frequency === undefined ? before.collection_frequency : body.collection_frequency;
    const isEnabled = body.is_enabled ?? before.is_enabled === 1;
    const isActive = body.is_active ?? before.is_active === 1;
    if (diff.collection_method || diff.collection_frequency || diff.is_enabled || diff.is_active || diff.market_id) {
      changes.next_run_at = schedulable(method, freq ?? market.default_frequency, isEnabled, isActive) ? nowIso() : null;
    }
    db.tx(() => {
      applyUpdate(ctx, 'retailers', id, changes);
      // Connector settings can be large and hold internal URLs: log that they changed, not their content.
      const logged = { ...diff };
      if (logged.connector_config) logged.connector_config = { from: '(previous settings)', to: '(updated settings)' };
      audit(ctx, req.user, 'retailer.updated', 'retailer', id, logged, req.ip);
    });
    return retailerRow(id, req);
  });

  app.delete('/retailers/:id', { config: { permission: 'sources.manage' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const retailer = db.get<{ name: string }>('SELECT name FROM retailers WHERE id = ?', [id]);
    if (!retailer) throw notFound('Retailer');
    const listings = db.scalar<number>('SELECT COUNT(*) FROM retailer_listings WHERE retailer_id = ?', [id]) ?? 0;
    if (listings > 0) {
      throw conflict(
        `${retailer.name} has ${listings} listing${listings === 1 ? '' : 's'}. Deactivate the retailer instead so its price history is preserved.`,
        { listings },
      );
    }
    db.tx(() => {
      db.run('DELETE FROM collection_jobs WHERE retailer_id = ?', [id]); // run history of a source that never had listings
      deleteSecret(ctx, retailerSecretName(id));
      db.run('DELETE FROM retailers WHERE id = ?', [id]);
      audit(ctx, req.user, 'retailer.deleted', 'retailer', id, { name: retailer.name }, req.ip);
    });
    return { ok: true };
  });

  // ---- credential (encrypted at rest, write-only) ------------------------------------------------
  app.put('/retailers/:id/credential', { config: { permission: 'sources.manage' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    if (!db.get('SELECT id FROM retailers WHERE id = ?', [id])) throw notFound('Retailer');
    const body = parse(z.object({ value: z.string().min(1).max(10_000) }), req.body);
    const value = body.value.trim();
    if (!value) throw unprocessable('The credential cannot be empty');
    setSecret(ctx, retailerSecretName(id), value, req.user!.id);
    audit(ctx, req.user, 'retailer.credential_set', 'retailer', id, null, req.ip);
    return { credential: secretStatus(ctx, retailerSecretName(id)) };
  });

  app.delete('/retailers/:id/credential', { config: { permission: 'sources.manage' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    if (!db.get('SELECT id FROM retailers WHERE id = ?', [id])) throw notFound('Retailer');
    deleteSecret(ctx, retailerSecretName(id));
    audit(ctx, req.user, 'retailer.credential_removed', 'retailer', id, null, req.ip);
    return { credential: secretStatus(ctx, retailerSecretName(id)) };
  });

  // ---- permission attestation (required before website extraction may run) -----------------------
  app.post('/retailers/:id/attest-permission', { config: { permission: 'sources.manage' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    if (!db.get('SELECT id FROM retailers WHERE id = ?', [id])) throw notFound('Retailer');
    const body = parse(z.object({ attested: z.boolean(), note: optText(1000) }), req.body);
    const note = body.note ?? null;
    if (body.attested && (!note || note.length < 10)) {
      throw unprocessable('Describe the basis for permitted access (for example the agreement, API terms or robots policy you checked) in at least 10 characters');
    }
    const now = nowIso();
    db.run(
      `UPDATE retailers SET permission_attested = ?, permission_attested_by = ?, permission_attested_at = ?, permission_note = ?, updated_at = ? WHERE id = ?`,
      [body.attested, body.attested ? req.user!.id : null, body.attested ? now : null, body.attested ? note : null, now, id],
    );
    audit(ctx, req.user, body.attested ? 'retailer.permission_attested' : 'retailer.permission_withdrawn', 'retailer', id, { note }, req.ip);
    return retailerRow(id, req);
  });

  // ---- listings --------------------------------------------------------------------------------
  function listingFilters(query: Record<string, unknown>): { where: string[]; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    const inIds = (column: string, value: unknown) => {
      const ids = idList(value);
      if (!ids) return;
      where.push(`${column} IN (${placeholders(ids.length)})`);
      params.push(...ids);
    };
    inIds('li.retailer_id', query.retailer_id);
    inIds('li.product_id', query.product_id);
    inIds('li.market_id', query.market_id);
    inIds('li.brand_id', query.brand_id);
    const statuses = strList(query.match_status)?.filter((s) => ['matched', 'unmatched', 'ignored'].includes(s));
    if (statuses?.length) {
      where.push(`li.match_status IN (${placeholders(statuses.length)})`);
      params.push(...statuses);
    }
    const active = optBool(query.active);
    if (active !== undefined) {
      where.push('li.listing_active = ?');
      params.push(active);
    }
    const demo = optBool(query.demo);
    if (demo !== undefined) {
      where.push('li.listing_is_demo = ?');
      params.push(demo);
    }
    const hasObservations = optBool(query.has_observations);
    if (hasObservations !== undefined) where.push(hasObservations ? 'COALESCE(s.obs_count, 0) > 0' : 'COALESCE(s.obs_count, 0) = 0');
    if (typeof query.q === 'string' && query.q.trim()) {
      const p = likePattern(query.q.trim());
      where.push(
        `(li.listing_title LIKE ? ESCAPE '\\' OR li.listing_url LIKE ? ESCAPE '\\' OR li.external_id LIKE ? ESCAPE '\\' OR li.listing_code LIKE ? ESCAPE '\\'
          OR li.product_name LIKE ? ESCAPE '\\' OR li.retailer_name LIKE ? ESCAPE '\\' OR li.sku LIKE ? ESCAPE '\\' OR li.brand_name LIKE ? ESCAPE '\\')`,
      );
      params.push(p, p, p, p, p, p, p, p);
    }
    return { where, params };
  }

  app.get('/listings', async (req) => {
    const query = req.query as Record<string, unknown>;
    const { where, params } = listingFilters(query);
    const page = pagination(query, 50, 500);
    const total = countListings(ctx, where, params);
    const rows = fetchListings(ctx, {
      where,
      params,
      order: `${orderBy(query.sort, LISTING_SORTS, 'li.retailer_name, li.product_name')}, li.listing_id`,
      limit: page.pageSize,
      offset: page.offset,
    });
    return paged(rows, total, page);
  });

  app.get('/listings/:id', async (req) => getListing(ctx, idParam((req.params as { id: string }).id)));

  function assertListingUnique(retailerId: number, url: string | null, externalId: string | null, selfId = 0): void {
    if (url && db.get('SELECT id FROM retailer_listings WHERE retailer_id = ? AND url = ? AND id <> ?', [retailerId, url, selfId])) {
      throw conflict('This retailer already has a listing with the same URL');
    }
    if (externalId && db.get('SELECT id FROM retailer_listings WHERE retailer_id = ? AND external_id = ? AND id <> ?', [retailerId, externalId, selfId])) {
      throw conflict(`This retailer already has a listing with the item id "${externalId}"`);
    }
  }

  function listingGtin(value: string | null | undefined): string | null {
    const gtin = normaliseGtin(value);
    if (value && (!gtin || !/^\d{8,14}$/.test(gtin))) throw unprocessable('Barcode / GTIN must contain 8 to 14 digits');
    return gtin;
  }

  app.post('/listings', { config: { permission: 'catalogue.write' } }, async (req, reply) => {
    const body = parse(z.object(listingFields), req.body);
    const retailer = db.get<{ id: number; is_demo: number }>('SELECT id, is_demo FROM retailers WHERE id = ?', [body.retailer_id]);
    if (!retailer) throw unprocessable('The selected retailer does not exist');
    const url = httpUrl(body.url, 'Listing URL')!;
    const externalId = body.external_id ?? null;
    const gtin = listingGtin(body.gtin);
    if (body.variant_id && !body.product_id) throw unprocessable('Choose a product before choosing one of its pack variants');
    assertListingUnique(retailer.id, url, externalId);
    const now = nowIso();
    const id = db.tx(() => {
      const newId = db.run(
        `INSERT INTO retailer_listings (retailer_id, external_id, url, title, gtin, match_status, is_active, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'unmatched', ?, ?, ?, ?)`,
        [retailer.id, externalId, url, body.title ?? null, gtin, body.is_active ?? true, retailer.is_demo, now, now],
      ).lastInsertRowid;
      audit(ctx, req.user, 'listing.created', 'listing', newId, { retailer_id: retailer.id, url, external_id: externalId }, req.ip);
      if (body.product_id) {
        matchListing(ctx, { listingId: newId, productId: body.product_id, variantId: body.variant_id ?? null, user: req.user, via: 'create', ip: req.ip });
      }
      return newId;
    });
    return reply.code(201).send(getListing(ctx, id));
  });

  app.patch('/listings/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = db.get<Record<string, unknown> & {
      retailer_id: number; product_id: number | null; variant_id: number | null; url: string | null; external_id: string | null;
    }>('SELECT * FROM retailer_listings WHERE id = ?', [id]);
    if (!before) throw notFound('Listing');
    const body = parse(z.object(listingFields).partial(), req.body);
    if (body.retailer_id !== undefined && body.retailer_id !== before.retailer_id) {
      throw unprocessable('A listing cannot be moved to another retailer. Create a new listing at the other retailer instead.');
    }
    const changes: Record<string, SqlParam> = {
      url: body.url === undefined ? undefined : httpUrl(body.url, 'Listing URL'),
      external_id: body.external_id,
      title: body.title,
      gtin: body.gtin === undefined ? undefined : listingGtin(body.gtin),
      is_active: body.is_active,
    };
    assertListingUnique(
      before.retailer_id,
      changes.url === undefined ? null : (changes.url as string | null),
      changes.external_id === undefined ? null : (changes.external_id as string | null),
      id,
    );
    const diff = changedFields(before, changes);
    db.tx(() => {
      if (Object.keys(diff).length) {
        applyUpdate(ctx, 'retailer_listings', id, changes);
        audit(ctx, req.user, 'listing.updated', 'listing', id, diff, req.ip);
      }
      // Product mapping (audited separately as listing.matched / listing.unmatched).
      if (body.product_id !== undefined || body.variant_id !== undefined) {
        const productId = body.product_id === undefined ? before.product_id : body.product_id;
        const variantId = body.variant_id === undefined ? (productId === before.product_id ? before.variant_id : null) : body.variant_id;
        if (productId === null) {
          if (variantId) throw unprocessable('Choose a product before choosing one of its pack variants');
          if (before.product_id !== null) unmatchListing(ctx, id, req.user, req.ip);
        } else if (productId !== before.product_id || variantId !== before.variant_id) {
          matchListing(ctx, { listingId: id, productId, variantId, user: req.user, via: 'edit', ip: req.ip });
        }
      }
    });
    return getListing(ctx, id);
  });

  app.delete('/listings/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const listing = db.get<{ code: string; retailer_id: number; url: string | null }>('SELECT code, retailer_id, url FROM retailer_listings WHERE id = ?', [id]);
    if (!listing) throw notFound('Listing');
    const observations = db.scalar<number>('SELECT COUNT(*) FROM price_observations WHERE listing_id = ?', [id]) ?? 0;
    if (observations > 0) {
      throw conflict(
        `${listing.code} has ${observations} price observation${observations === 1 ? '' : 's'} and cannot be deleted. Deactivate the listing instead; its history is kept.`,
        { observations },
      );
    }
    db.run('DELETE FROM retailer_listings WHERE id = ?', [id]);
    audit(ctx, req.user, 'listing.deleted', 'listing', id, listing, req.ip);
    return { ok: true };
  });
}
