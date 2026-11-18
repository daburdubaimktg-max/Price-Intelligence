/** Deals API: the listings that are on offer right now, with the price context of their own history, and their comparison. */
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors.ts';
import { optBool, optNumber, pagination } from '../lib/http.ts';
import { deals, dealsComparison, type DealsOptions } from '../services/analytics/deals.ts';
import { parseObsFilter, type ObsFilter } from '../services/obs-filter.ts';

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
  const readOptions = (q: Record<string, unknown>): { filter: ObsFilter; options: DealsOptions } => {
    const filter = parseObsFilter(q);
    const minDiscount = optNumber(q.min_discount, 'min_discount');
    if (minDiscount !== undefined && (minDiscount < 0 || minDiscount > 100)) throw badRequest('min_discount must be between 0 and 100');
    return {
      filter,
      options: {
        tags: filter.tags,
        minDiscount,
        lowestOnly: optBool(q.lowest_only),
        includeBadges: optBool(q.include_badges),
        includeStale: optBool(q.include_stale),
        availability: filter.availability,
        sort: typeof q.sort === 'string' ? q.sort : undefined,
      },
    };
  };

  app.get('/deals', async (req) => {
    const q = req.query as Record<string, unknown>;
    const { filter, options } = readOptions(q);
    return deals(ctx, filter, options, pagination(q, 50, 200));
  });

  /**
   * GET /api/deals/compare — the same deals (same scope and deal filters; no sort or paging) as a comparison:
   * share of each range on offer and discount depth by brand, product range, retailer and market, own brands
   * against competitors, brand × retailer, and the last 30 days.
   */
  app.get('/deals/compare', async (req) => {
    const { filter, options } = readOptions(req.query as Record<string, unknown>);
    return dealsComparison(ctx, filter, options);
  });
}
