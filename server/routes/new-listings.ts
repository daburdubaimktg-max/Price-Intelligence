/** New Products API: listings that appeared at a retailer recently, after that retailer's baseline. */
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors.ts';
import { idList, optBool, optNumber, pagination } from '../lib/http.ts';
import { newListings } from '../services/analytics/new-listings.ts';
import { OWNERSHIP, type Ownership } from '../../shared/constants.ts';
import { NEW_LISTING_KINDS, NEW_LISTING_PERIODS, type NewListingKind, type NewListingPeriod } from '../../shared/api/new-listings.ts';

export default async function newListingRoutes(app: FastifyInstance) {
  const { ctx } = app;

  /**
   * GET /api/new-listings
   *   period     days=7|30|90 (default 30)
   *   scope      market_id, retailer_id, brand_id (each "1,2,3"; brand also matches the brand recognised in the
   *              title of an unmatched listing), ownership=own|competitor, q
   *   kind       kind=new_product|new_at_retailer; include_ignored=true also lists ignored listings
   *   order      sort=first_seen|brand|retailer ("-" prefix = descending; default -first_seen)
   *   paging     page, page_size (default 50, at most 200)
   */
  app.get('/new-listings', async (req) => {
    const q = req.query as Record<string, unknown>;
    const days = optNumber(q.days, 'days') ?? 30;
    if (!NEW_LISTING_PERIODS.includes(days as NewListingPeriod)) throw badRequest(`days must be one of ${NEW_LISTING_PERIODS.join(', ')}`);
    const ownership = q.ownership === undefined || q.ownership === '' || q.ownership === 'all' ? undefined : q.ownership;
    if (ownership !== undefined && !OWNERSHIP.includes(ownership as Ownership)) throw badRequest('ownership must be "own" or "competitor"');
    const kind = q.kind === undefined || q.kind === '' || q.kind === 'all' ? undefined : q.kind;
    if (kind !== undefined && !NEW_LISTING_KINDS.includes(kind as NewListingKind)) throw badRequest(`kind must be one of ${NEW_LISTING_KINDS.join(', ')}`);
    const search = typeof q.q === 'string' ? q.q.trim().slice(0, 100) : '';
    return newListings(
      ctx,
      {
        days: days as NewListingPeriod,
        marketIds: idList(q.market_id),
        retailerIds: idList(q.retailer_id),
        brandIds: idList(q.brand_id),
        ownership: ownership as Ownership | undefined,
        kind: kind as NewListingKind | undefined,
        q: search || undefined,
        includeIgnored: optBool(q.include_ignored),
        sort: typeof q.sort === 'string' ? q.sort : undefined,
      },
      pagination(q, 50, 200),
    );
  });
}
