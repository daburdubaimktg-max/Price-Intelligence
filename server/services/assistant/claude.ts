/**
 * Optional Claude interpreter: turns a free-form question into a QueryPlan (structured output).
 *
 * Claude never sees prices and never writes figures — it only chooses the query and names the catalogue
 * entities involved. The plan is executed against the database by the same executor as the built-in engine.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { QueryPlan } from '../../../shared/api/assistant.ts';
import { PlanSchema, type Catalogue } from './interpret.ts';

export class AssistantModelError extends Error {
  code: 'auth' | 'rate_limit' | 'connection' | 'refusal' | 'api' | 'invalid_output';
  constructor(code: AssistantModelError['code'], message: string) {
    super(message);
    this.name = 'AssistantModelError';
    this.code = code;
  }
}

/** Stable instructions + catalogue snapshot (cached); the question itself goes in the user turn. */
function systemPrompt(catalogue: Catalogue): string {
  const marketName = new Map(catalogue.markets.map((m) => [m.id, m.name]));
  const vocabulary = {
    markets: catalogue.markets.map((m) => m.name),
    retailers: catalogue.retailers.map((r) => `${r.name} [${marketName.get(r.market_id) ?? r.market_code}]`),
    own_brands: catalogue.brands.filter((b) => b.ownership === 'own').map((b) => b.name),
    competitor_brands: catalogue.brands.filter((b) => b.ownership === 'competitor').map((b) => b.name),
    categories: catalogue.categories.map((c) => c.name),
    products: catalogue.products.slice(0, 1500).map((p) => p.name),
  };
  return `You translate questions about retail prices into a query plan for a pricing-intelligence database. A separate program runs the plan and writes the answer from stored records, so you never state prices or other figures yourself — you only decide which query to run and which catalogue entities it concerns.

The database holds price observations (regular price, selling price, promotions, availability) for retailer listings of own-brand and competitor products across markets, with their history.

Choose one intent:
- price_history: how the price of specific product(s) moved over a period
- current_prices: the latest prices of product(s), a brand or a category
- lowest_price: which retailer currently sells a specific product cheapest
- price_changes: price increases and/or decreases detected in a period (optionally for a market, retailer, brand or product)
- discount_ranking: which brands or products were discounted the most in a period
- promotion_frequency: how often and how long a brand or product is on promotion
- positioning: own brands' price level relative to mapped competitors, now and over time
- volatility: which products' prices fluctuated most
- cross_market: one product compared across markets
- unsupported: anything the stored price records cannot answer (forecasts, sales volumes, market share, reasons for a change, advice, anything unrelated). Put a one-sentence explanation in "reason".

Filling the plan:
- Copy entity names exactly as they appear in the catalogue below. Retailers are listed with their market in brackets; return only the retailer name. If the question names something that is not in the catalogue, pass the wording through unchanged so the program can report that it is unknown — do not substitute a different entity.
- A retailer chain named without a market (for example "Carrefour") means every retailer of that chain: return the chain name as written.
- ownership: "competitor" when the question is about competitors as a group, "own" for the company's own brands, otherwise "any".
- period: use a preset when the wording matches one; use "custom" with from/to dates (YYYY-MM-DD) for anything else, computing dates from the current date given with the question; use "default" when no period is mentioned.
- direction: "up" for increases only, "down" for decreases only, otherwise "any".
- limit: a number only when the question asks for a top-N; otherwise null.
- reason: null unless the intent is unsupported.
- Leave a list empty when the question does not constrain that dimension. When the question depends on a product but names none (for example "this product"), keep products empty — the program will ask the user.

Catalogue:
${JSON.stringify(vocabulary)}`;
}

export interface ClaudePlanResult {
  plan: QueryPlan;
  model: string;
}

/** One request, structured output. Throws AssistantModelError with the real reason when it cannot produce a plan. */
export async function interpretWithClaude(options: { apiKey: string; model: string; question: string; catalogue: Catalogue; today: string }): Promise<ClaudePlanResult> {
  const client = new Anthropic({ apiKey: options.apiKey, timeout: 60_000, maxRetries: 1 });
  try {
    const response = await client.beta.messages.parse({
      model: options.model,
      max_tokens: 16000,
      // If the primary model declines a request, the API re-runs it on its default fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(PlanSchema) },
      system: [{ type: 'text', text: systemPrompt(options.catalogue), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Current date: ${options.today}\n\nQuestion: ${options.question}` }],
    });
    if (response.stop_reason === 'refusal') throw new AssistantModelError('refusal', 'The model declined to interpret this question.');
    if (response.stop_reason === 'max_tokens') throw new AssistantModelError('invalid_output', 'The model response was cut off before a complete query plan was produced.');
    const parsed = response.parsed_output;
    if (!parsed) throw new AssistantModelError('invalid_output', 'The model did not return a valid query plan.');
    return { plan: PlanSchema.parse(parsed) as QueryPlan, model: response.model };
  } catch (err) {
    if (err instanceof AssistantModelError) throw err;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new AssistantModelError('auth', 'The Anthropic API key was rejected. Check it in Administration → Integrations.');
    }
    if (err instanceof Anthropic.RateLimitError) throw new AssistantModelError('rate_limit', 'The Anthropic API rate limit was reached. Try again shortly.');
    if (err instanceof Anthropic.APIConnectionError) throw new AssistantModelError('connection', 'The Anthropic API could not be reached from this server.');
    if (err instanceof Anthropic.APIError) throw new AssistantModelError('api', `The Anthropic API returned an error (${err.status ?? 'unknown status'}): ${err.message}`);
    throw new AssistantModelError('invalid_output', err instanceof Error ? err.message : 'The model response could not be used.');
  }
}

/** Real connectivity check used by the "Test connection" button: verifies the key and that the model exists. */
export async function testClaudeConnection(apiKey: string, model: string): Promise<{ ok: boolean; model: string; display_name: string | null; error: string | null; duration_ms: number }> {
  const started = Date.now();
  const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 0 });
  try {
    const info = await client.models.retrieve(model);
    return { ok: true, model: info.id, display_name: info.display_name ?? null, error: null, duration_ms: Date.now() - started };
  } catch (err) {
    let error = err instanceof Error ? err.message : 'Unknown error';
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) error = 'The API key was rejected.';
    else if (err instanceof Anthropic.NotFoundError) error = `The model "${model}" is not available to this API key.`;
    else if (err instanceof Anthropic.RateLimitError) error = 'Rate limit reached — the key works but is currently throttled.';
    else if (err instanceof Anthropic.APIConnectionError) error = 'The Anthropic API could not be reached from this server (network or proxy).';
    return { ok: false, model, display_name: null, error, duration_ms: Date.now() - started };
  }
}
