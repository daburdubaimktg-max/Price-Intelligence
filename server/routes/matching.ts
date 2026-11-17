/**
 * Product matching:
 *   /matching/*  — linking retailer listings to canonical products (suggestions are approved or rejected by a person)
 *   /mappings/*  — equivalent-product mapping between own and competitor products
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SqlParam } from '../db/sqlite.ts';
import { placeholders } from '../db/sqlite.ts';
import { conflict, notFound, unprocessable } from '../lib/errors.ts';
import { idList, idParam, likePattern, optBool, paged, pagination, parse, requiredId, strList } from '../lib/http.ts';
import { nowIso } from '../lib/time.ts';
import { audit } from '../services/core.ts';
import {
  comparability,
  countListings,
  fetchListings,
  fetchMappings,
  fetchSuggestions,
  getListing,
  getMapping,
  MAPPING_FROM_COUNT,
  mappingProduct,
  matchListing,
  refreshListingSuggestions,
  suggestCompetitorMappings,
  unmatchListing,
} from '../services/matching.ts';
import type { MappingSuggestResponse, MatchingListing, MatchingListResponse } from '../../shared/api/catalogue.ts';
import { optId, optText } from './reference.ts';

const equivalence = z.enum(['equivalent', 'comparable']);

export default async function matchingRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;

  // =============================================================================================
  // Listing ↔ product matching
  // =============================================================================================
  function withSuggestions(listingIds: number[]): MatchingListing[] {
    if (listingIds.length === 0) return [];
    const rows = fetchListings(ctx, { where: [`li.listing_id IN (${placeholders(listingIds.length)})`], params: listingIds });
    const suggestions = fetchSuggestions(ctx, listingIds, ['pending']);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return listingIds.filter((id) => byId.has(id)).map((id) => ({ ...byId.get(id)!, suggestions: suggestions.get(id) ?? [] }));
  }

  app.get('/matching/listings', async (req): Promise<MatchingListResponse> => {
    const query = req.query as Record<string, unknown>;
    const status = query.status === 'ignored' ? 'ignored' : 'unmatched';
    const where = ['li.match_status = ?'];
    const params: SqlParam[] = [status];
    for (const [column, value] of [['li.retailer_id', query.retailer_id], ['li.market_id', query.market_id]] as const) {
      const ids = idList(value);
      if (ids) {
        where.push(`${column} IN (${placeholders(ids.length)})`);
        params.push(...ids);
      }
    }
    if (typeof query.q === 'string' && query.q.trim()) {
      const p = likePattern(query.q.trim());
      where.push(`(li.listing_title LIKE ? ESCAPE '\\' OR li.listing_url LIKE ? ESCAPE '\\' OR li.external_id LIKE ? ESCAPE '\\' OR li.listing_code LIKE ? ESCAPE '\\' OR li.retailer_name LIKE ? ESCAPE '\\')`);
      params.push(p, p, p, p, p);
    }
    const page = pagination(query, 50, 200);
    const total = countListings(ctx, where, params);
    const pageRows = fetchListings(ctx, { where, params, order: 'l.created_at DESC, li.listing_id DESC', limit: page.pageSize, offset: page.offset });
    const ids = pageRows.map((r) => r.id);
    if (status === 'unmatched' && ids.length) {
      // Listings nobody has looked at yet get their suggestions computed on first view.
      const seen = new Set(
        db.all<{ listing_id: number }>(`SELECT DISTINCT listing_id FROM listing_match_suggestions WHERE listing_id IN (${placeholders(ids.length)})`, ids).map((r) => r.listing_id),
      );
      const fresh = ids.filter((id) => !seen.has(id));
      if (fresh.length) refreshListingSuggestions(ctx, fresh);
    }
    return {
      ...paged(withSuggestions(ids), total, page),
      counts: {
        unmatched: db.scalar<number>(`SELECT COUNT(*) FROM retailer_listings WHERE match_status = 'unmatched'`) ?? 0,
        ignored: db.scalar<number>(`SELECT COUNT(*) FROM retailer_listings WHERE match_status = 'ignored'`) ?? 0,
        pending_suggestions:
          db.scalar<number>(
            `SELECT COUNT(*) FROM listing_match_suggestions s JOIN retailer_listings l ON l.id = s.listing_id
             WHERE s.status = 'pending' AND l.match_status = 'unmatched'`,
          ) ?? 0,
      },
    };
  });

  app.post('/matching/refresh', { config: { permission: 'catalogue.write' } }, async (req) => {
    const body = parse(z.object({ listing_ids: z.array(requiredId()).max(5000).optional() }), req.body);
    const listings = body.listing_ids
      ? body.listing_ids.length
      : (db.scalar<number>(`SELECT COUNT(*) FROM retailer_listings WHERE match_status = 'unmatched'`) ?? 0);
    const pending = refreshListingSuggestions(ctx, body.listing_ids);
    audit(ctx, req.user, 'matching.refreshed', 'listing', null, { listings, pending_suggestions: pending }, req.ip);
    return { listings, pending_suggestions: pending };
  });

  function suggestion(id: number) {
    const row = db.get<{ id: number; listing_id: number; product_id: number; status: string; match_status: string }>(
      `SELECT s.id, s.listing_id, s.product_id, s.status, l.match_status
       FROM listing_match_suggestions s JOIN retailer_listings l ON l.id = s.listing_id WHERE s.id = ?`,
      [id],
    );
    if (!row) throw notFound('Suggestion');
    if (row.status !== 'pending') throw conflict(`This suggestion was already ${row.status}`);
    return row;
  }

  app.post('/matching/suggestions/:id/approve', { config: { permission: 'catalogue.write' } }, async (req) => {
    const s = suggestion(idParam((req.params as { id: string }).id));
    if (s.match_status === 'matched') throw conflict('This listing is already matched to a product');
    matchListing(ctx, { listingId: s.listing_id, productId: s.product_id, user: req.user, via: 'suggestion', ip: req.ip });
    return { listing: getListing(ctx, s.listing_id) };
  });

  app.post('/matching/suggestions/:id/reject', { config: { permission: 'catalogue.write' } }, async (req) => {
    const s = suggestion(idParam((req.params as { id: string }).id));
    db.run(`UPDATE listing_match_suggestions SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?`, [req.user!.id, nowIso(), s.id]);
    audit(ctx, req.user, 'match_suggestion.rejected', 'listing', s.listing_id, { suggestion_id: s.id, product_id: s.product_id }, req.ip);
    return { listing: withSuggestions([s.listing_id])[0] };
  });

  app.post('/matching/listings/:id/match', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const body = parse(z.object({ product_id: requiredId(), variant_id: optId() }), req.body);
    matchListing(ctx, { listingId: id, productId: body.product_id, variantId: body.variant_id ?? null, user: req.user, via: 'manual', ip: req.ip });
    return { listing: getListing(ctx, id) };
  });

  /** Returns a matched or ignored listing to the review queue. */
  app.post('/matching/listings/:id/unmatch', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    unmatchListing(ctx, id, req.user, req.ip);
    refreshListingSuggestions(ctx, [id]);
    return { listing: withSuggestions([id])[0] };
  });

  /** "Not a product we track": keeps the listing (and its prices) but takes it out of the review queue. */
  app.post('/matching/listings/:id/ignore', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const listing = db.get<{ match_status: string }>('SELECT match_status FROM retailer_listings WHERE id = ?', [id]);
    if (!listing) throw notFound('Listing');
    if (listing.match_status === 'matched') throw conflict('This listing is matched to a product. Unmatch it first if it should be ignored.');
    if (listing.match_status !== 'ignored') {
      db.tx(() => {
        db.run(`UPDATE retailer_listings SET match_status = 'ignored', updated_at = ? WHERE id = ?`, [nowIso(), id]);
        db.run(`DELETE FROM listing_match_suggestions WHERE listing_id = ? AND status = 'pending'`, [id]);
        audit(ctx, req.user, 'listing.ignored', 'listing', id, null, req.ip);
      });
    }
    return { listing: getListing(ctx, id) };
  });

  // =============================================================================================
  // Competitor equivalence mappings
  // =============================================================================================
  function mappingFilters(query: Record<string, unknown>, includeStatus = true): { where: string[]; params: SqlParam[] } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    const inIds = (column: string, value: unknown) => {
      const ids = idList(value);
      if (!ids) return;
      where.push(`${column} IN (${placeholders(ids.length)})`);
      params.push(...ids);
    };
    inIds('m.own_product_id', query.own_product_id);
    inIds('m.competitor_product_id', query.competitor_product_id);
    inIds('op.brand_id', query.brand_id);
    inIds('cp.brand_id', query.competitor_brand_id);
    const either = idList(query.product_id);
    if (either) {
      const ph = placeholders(either.length);
      where.push(`(m.own_product_id IN (${ph}) OR m.competitor_product_id IN (${ph}))`);
      params.push(...either, ...either);
    }
    const markets = idList(query.market_id);
    if (markets) {
      // Mappings without a market apply everywhere, so they are part of every market's view.
      where.push(`(m.market_id IN (${placeholders(markets.length)})${optBool(query.exact_market) ? '' : ' OR m.market_id IS NULL'})`);
      params.push(...markets);
    }
    if (query.equivalence === 'equivalent' || query.equivalence === 'comparable') {
      where.push('m.equivalence = ?');
      params.push(query.equivalence);
    }
    const demo = optBool(query.demo);
    if (demo !== undefined) {
      where.push('m.is_demo = ?');
      params.push(demo);
    }
    if (typeof query.q === 'string' && query.q.trim()) {
      const p = likePattern(query.q.trim());
      where.push(`(op.name LIKE ? ESCAPE '\\' OR cp.name LIKE ? ESCAPE '\\' OR ob.name LIKE ? ESCAPE '\\' OR cb.name LIKE ? ESCAPE '\\' OR op.code LIKE ? ESCAPE '\\' OR cp.code LIKE ? ESCAPE '\\')`);
      params.push(p, p, p, p, p, p);
    }
    if (includeStatus) {
      const statuses = strList(query.status)?.filter((s) => ['suggested', 'approved', 'rejected'].includes(s));
      if (statuses?.length) {
        where.push(`m.status IN (${placeholders(statuses.length)})`);
        params.push(...statuses);
      }
    }
    return { where, params };
  }

  app.get('/mappings', async (req) => {
    const query = req.query as Record<string, unknown>;
    const { where, params } = mappingFilters(query);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = pagination(query, 100, 500);
    const total = db.scalar<number>(`SELECT COUNT(*) ${MAPPING_FROM_COUNT} ${whereSql}`, params) ?? 0;
    const rows = fetchMappings(ctx, { where, params, limit: page.pageSize, offset: page.offset });
    const base = mappingFilters(query, false);
    const counts = { suggested: 0, approved: 0, rejected: 0 };
    for (const row of db.all<{ status: keyof typeof counts; n: number }>(
      `SELECT m.status, COUNT(*) AS n ${MAPPING_FROM_COUNT} ${base.where.length ? `WHERE ${base.where.join(' AND ')}` : ''} GROUP BY m.status`,
      base.params,
    )) {
      counts[row.status] = row.n;
    }
    return { ...paged(rows, total, page), counts };
  });

  app.get('/mappings/:id', async (req) => getMapping(ctx, idParam((req.params as { id: string }).id)));

  function mappingProducts(ownId: number, competitorId: number) {
    if (ownId === competitorId) throw unprocessable('A product cannot be mapped to itself');
    const own = mappingProduct(ctx, ownId);
    const competitor = mappingProduct(ctx, competitorId);
    if (!own) throw unprocessable('The own product does not exist');
    if (!competitor) throw unprocessable('The competitor product does not exist');
    if (own.ownership !== 'own') throw unprocessable(`"${own.name}" belongs to a competitor brand. The first product of a mapping must be one of your own.`);
    if (competitor.ownership !== 'competitor') throw unprocessable(`"${competitor.name}" belongs to one of your own brands. The second product of a mapping must be a competitor's.`);
    return { own, competitor };
  }

  /** "Equivalent" is a claim of like-for-like. Packs measured in different units can never be that. */
  function assertEquivalenceAllowed(value: 'equivalent' | 'comparable', own: Parameters<typeof comparability>[0], competitor: Parameters<typeof comparability>[1]) {
    if (value !== 'equivalent') return;
    const cmp = comparability(own, competitor);
    if (cmp.same_dimension === false) {
      throw unprocessable(`These products cannot be marked equivalent: ${cmp.note}. Map them as "comparable" (non-equivalent) instead.`);
    }
  }

  function assertMarket(marketId: number | null): void {
    if (marketId && !db.get('SELECT id FROM markets WHERE id = ?', [marketId])) throw unprocessable('The selected market does not exist');
  }

  app.post('/mappings', { config: { permission: 'catalogue.write' } }, async (req, reply) => {
    const body = parse(
      z.object({
        own_product_id: requiredId(),
        competitor_product_id: requiredId(),
        equivalence: equivalence.optional(),
        market_id: optId(),
        rationale: optText(500),
      }),
      req.body,
    );
    const { own, competitor } = mappingProducts(body.own_product_id, body.competitor_product_id);
    if (own.status === 'archived' || competitor.status === 'archived') throw unprocessable('Archived products cannot be mapped. Restore the product first.');
    const marketId = body.market_id ?? null;
    assertMarket(marketId);
    const cmp = comparability(own, competitor);
    const value = body.equivalence ?? (cmp.same_dimension === true && cmp.within_tolerance ? 'equivalent' : 'comparable');
    assertEquivalenceAllowed(value, own, competitor);
    const existing = db.get<{ id: number; status: string }>(
      'SELECT id, status FROM competitor_mappings WHERE own_product_id = ? AND competitor_product_id = ? AND COALESCE(market_id, 0) = ?',
      [own.id, competitor.id, marketId ?? 0],
    );
    if (existing?.status === 'approved') throw conflict('These two products are already mapped for this market scope');
    const now = nowIso();
    let id: number;
    if (existing) {
      // A suggestion (or an earlier rejection) for the same pair becomes the approved mapping.
      id = existing.id;
      db.run(
        `UPDATE competitor_mappings SET equivalence = ?, status = 'approved', rationale = COALESCE(?, rationale), decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
        [value, body.rationale ?? null, req.user!.id, now, now, id],
      );
    } else {
      id = db.run(
        `INSERT INTO competitor_mappings (own_product_id, competitor_product_id, market_id, equivalence, status, rationale, decided_by, decided_at, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?)`,
        [own.id, competitor.id, marketId, value, body.rationale ?? null, req.user!.id, now, own.is_demo || competitor.is_demo ? 1 : 0, now, now],
      ).lastInsertRowid;
    }
    audit(ctx, req.user, 'mapping.created', 'mapping', id, { own_product_id: own.id, competitor_product_id: competitor.id, market_id: marketId, equivalence: value }, req.ip);
    return reply.code(201).send(getMapping(ctx, id));
  });

  app.patch('/mappings/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = getMapping(ctx, id);
    const body = parse(
      z.object({
        equivalence: equivalence.optional(),
        status: z.enum(['suggested', 'approved', 'rejected']).optional(),
        market_id: optId(),
        rationale: optText(500),
      }),
      req.body,
    );
    const value = body.equivalence ?? before.equivalence;
    const status = body.status ?? before.status;
    const marketId = body.market_id === undefined ? before.market_id : body.market_id;
    if (status !== 'rejected') assertEquivalenceAllowed(value, before.own, before.competitor);
    if (marketId !== before.market_id) {
      assertMarket(marketId);
      const clash = db.get(
        'SELECT id FROM competitor_mappings WHERE own_product_id = ? AND competitor_product_id = ? AND COALESCE(market_id, 0) = ? AND id <> ?',
        [before.own.product_id, before.competitor.product_id, marketId ?? 0, id],
      );
      if (clash) throw conflict('A mapping for these two products already exists for that market scope');
    }
    const now = nowIso();
    const decided = status !== before.status;
    db.run(
      `UPDATE competitor_mappings SET equivalence = ?, status = ?, market_id = ?, rationale = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
      [
        value, status, marketId, body.rationale === undefined ? before.rationale : body.rationale,
        decided ? (status === 'suggested' ? null : req.user!.id) : before.decided_by,
        decided ? (status === 'suggested' ? null : now) : before.decided_at,
        now, id,
      ],
    );
    audit(ctx, req.user, 'mapping.updated', 'mapping', id, {
      equivalence: value !== before.equivalence ? { from: before.equivalence, to: value } : undefined,
      status: decided ? { from: before.status, to: status } : undefined,
      market_id: marketId !== before.market_id ? { from: before.market_id, to: marketId } : undefined,
    }, req.ip);
    return getMapping(ctx, id);
  });

  app.delete('/mappings/:id', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = getMapping(ctx, id);
    db.run('DELETE FROM competitor_mappings WHERE id = ?', [id]);
    audit(ctx, req.user, 'mapping.deleted', 'mapping', id, { own_product_id: before.own.product_id, competitor_product_id: before.competitor.product_id, status: before.status }, req.ip);
    return { ok: true };
  });

  app.post('/mappings/:id/approve', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = getMapping(ctx, id);
    const body = parse(z.object({ equivalence: equivalence.optional() }), req.body);
    const value = body.equivalence ?? before.equivalence;
    assertEquivalenceAllowed(value, before.own, before.competitor);
    const now = nowIso();
    db.run(`UPDATE competitor_mappings SET status = 'approved', equivalence = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`, [
      value, req.user!.id, now, now, id,
    ]);
    audit(ctx, req.user, 'mapping.approved', 'mapping', id, { equivalence: value, previous_status: before.status }, req.ip);
    return getMapping(ctx, id);
  });

  app.post('/mappings/:id/reject', { config: { permission: 'catalogue.write' } }, async (req) => {
    const id = idParam((req.params as { id: string }).id);
    const before = getMapping(ctx, id);
    const now = nowIso();
    db.run(`UPDATE competitor_mappings SET status = 'rejected', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`, [req.user!.id, now, now, id]);
    audit(ctx, req.user, 'mapping.rejected', 'mapping', id, { previous_status: before.status }, req.ip);
    return getMapping(ctx, id);
  });

  /** Proposes mappings (status "suggested") for one own product or for all of them. */
  app.post('/mappings/suggest', { config: { permission: 'catalogue.write' } }, async (req): Promise<MappingSuggestResponse> => {
    const body = parse(z.object({ own_product_id: optId() }), req.body);
    if (body.own_product_id) {
      const own = mappingProduct(ctx, body.own_product_id);
      if (!own) throw notFound('Product');
      if (own.ownership !== 'own') throw unprocessable('Suggestions are generated for own products. Choose one of your own products.');
    }
    const result = suggestCompetitorMappings(ctx, body.own_product_id ?? undefined);
    audit(ctx, req.user, 'mapping.suggested', 'mapping', null, { own_product_id: body.own_product_id ?? null, created: result.createdIds.length }, req.ip);
    const suggestions = result.createdIds.length
      ? fetchMappings(ctx, { where: [`m.id IN (${placeholders(result.createdIds.length)})`], params: result.createdIds })
      : [];
    return { created: result.createdIds.length, own_products_considered: result.considered, suggestions };
  });
}
