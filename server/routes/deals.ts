/** Deals API: the listings that are on offer right now, with the price context of their own history. */
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors.ts';
import { optBool, optNumber, pagination } from '../lib/http.ts';
import { deals } from '../services/analytics/deals.ts';
import { parseObsFilter } from '../services/obs-filter.ts';

export default async function dealRoutes(app: FastifyInstance) {
  const { ctx } = app;

  /**
   * GET /api/deals
   *   scope      market_id, retailer_id, brand_id, category_id, product_id (each "1,2,3"), ownership=own|competitor, q
   *   deals      tag=<key,key>, min_discount=<%>, lowest_only=true, include_badges=true, include_stale=true,
   *              availability=<in_stock,…>
   *   order      sort=discount|drop|price|observed|rating|rank ("-" prefix = descending; default -discount)
   *   paging     page, page_size (default 50, at most 200)
   */
  app.get('/deals', async (req) => {
    const q = req.query as Record<string, unknown>;
    const filter = parseObsFilter(q);
    const minDiscount = optNumber(q.min_discount, 'min_discount');
    if (minDiscount !== undefined && (minDiscount < 0 || minDiscount > 100)) throw badRequest('min_discount must be between 0 and 100');
    return deals(
      ctx,
      filter,
      {
        tags: filter.tags,
        minDiscount,
        lowestOnly: optBool(q.lowest_only),
        includeBadges: optBool(q.include_badges),
        includeStale: optBool(q.include_stale),
        availability: filter.availability,
        sort: typeof q.sort === 'string' ? q.sort : undefined,
      },
      pagination(q, 50, 200),
    );
  });
}
