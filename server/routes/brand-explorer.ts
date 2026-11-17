/**
 * Brand Explorer API — brand-wise views of the price ledger. Read-only; any signed-in user.
 *
 * GET /api/brand-explorer
 *   One row per brand that has listed products in scope, plus a summary of the scope.
 *     market_id     comma-separated market ids            — listings of these markets only
 *     retailer_id   comma-separated retailer ids          — listings of these retailers only
 *     category_id   comma-separated category ids          — products in these categories or subcategories
 *     ownership     own | competitor                      — own brands or competitor brands only
 *     q             text                                  — brand name or manufacturer contains the text
 *     sort          name | products | listings | retailers | markets | promo_share | moves | trend | index |
 *                   last_observation; prefix with "-" for descending. Default: own brands first, then by name.
 *                   Brands without a value for the sorted figure are always listed last.
 *     currency      native (default) | reporting | ISO code — a comparison currency converts the price ranges; the
 *                   rates used (rate, timestamp, source) are returned in `conversions`. Native keeps one range per
 *                   currency: prices in different currencies are never blended.
 *
 *   Rows also carry the deal tags and badges of the brand's fresh listings (`tags`, `tag_counts`, `tagged_listings`)
 *   when the ledger stores them; the fields are absent when nothing is tagged.
 *
 * GET /api/brand-explorer/:id
 *   One brand in depth: header figures, product range, price matrix of one market, trend, competing brands and the
 *   number of unmatched listings whose title contains the brand name. 404 for an unknown brand.
 *     market_id         comma-separated market ids    — scope of every section. With a single market the price
 *                                                       matrix shows that market.
 *     retailer_id       comma-separated retailer ids  — scope of every section
 *     category_id       comma-separated category ids  — scope of every section
 *     matrix_market_id  one market id                 — market of the price matrix when the scope holds several.
 *                                                       Default: the market with most listings of the brand.
 *     days              7–365 (default 30)            — period of the trend charts
 *     currency          as above                      — converts the range figures and the category trend; the
 *                                                       price matrix always stays in the market's own currency.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { badRequest } from '../lib/errors.ts';
import { idList, idParam } from '../lib/http.ts';
import { getSetting } from '../services/core.ts';
import { brandDetail, brandExplorer, type BrandScope } from '../services/analytics/brands.ts';

type Query = Record<string, unknown>;

/** 'native' | 'reporting' | ISO code → resolved currency mode. */
function currencyParam(ctx: AppContext, value: unknown): 'native' | string {
  const raw = typeof value === 'string' && value ? value : 'native';
  if (raw === 'native') return 'native';
  if (raw === 'reporting') return getSetting(ctx, 'reporting_currency');
  const code = raw.toUpperCase();
  if (!ctx.db.get('SELECT 1 FROM currencies WHERE code = ?', [code])) throw badRequest(`Unknown currency "${raw}"`);
  return code;
}

function daysParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export default async function brandExplorerRoutes(app: FastifyInstance) {
  const { ctx } = app;

  app.get('/brand-explorer', async (req) => {
    const q = req.query as Query;
    const scope: BrandScope = {
      market_ids: idList(q.market_id),
      retailer_ids: idList(q.retailer_id),
      category_ids: idList(q.category_id),
    };
    if (q.ownership === 'own' || q.ownership === 'competitor') scope.ownership = q.ownership;
    if (typeof q.q === 'string' && q.q.trim()) scope.q = q.q.trim();
    return brandExplorer(ctx, scope, { sort: typeof q.sort === 'string' ? q.sort : undefined, currency: currencyParam(ctx, q.currency) });
  });

  app.get('/brand-explorer/:id', async (req) => {
    const q = req.query as Query;
    const id = idParam((req.params as { id: string }).id, 'brand id');
    const matrixMarket = idList(q.matrix_market_id);
    return brandDetail(ctx, id, {
      market_ids: idList(q.market_id),
      retailer_ids: idList(q.retailer_id),
      category_ids: idList(q.category_id),
      matrix_market_id: matrixMarket?.[0],
      days: daysParam(q.days, 30, 7, 365),
      currency: currencyParam(ctx, q.currency),
    });
  });
}
