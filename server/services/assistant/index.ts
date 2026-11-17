/** Intelligence assistant: interpret the question (built-in rules or Claude), run the plan, record the exchange. */
import type { AppContext, AuthUser } from '../../context.ts';
import type { AssistantAnswer, AssistantHistoryItem, AssistantStatus, QueryPlan } from '../../../shared/api/assistant.ts';
import { nowIso } from '../../lib/time.ts';
import { marketToday } from '../analytics/common.ts';
import { getSecret, getSetting } from '../core.ts';
import { AssistantModelError, interpretWithClaude, testClaudeConnection } from './claude.ts';
import { executePlan } from './execute.ts';
import { interpretBuiltin, loadCatalogue, PlanSchema, type Catalogue } from './interpret.ts';

export const AI_KEY_SECRET = 'integration:anthropic:api_key';
const BUILTIN_LABEL = 'Built-in query engine (no language model)';

/**
 * Example questions built from what is actually being monitored, so every suggestion can be answered from stored
 * records. Empty when nothing has been observed yet.
 */
export function exampleQuestions(ctx: AppContext): string[] {
  const { db } = ctx;
  const own = db.get<{ product_name: string; retailer_name: string; market_name: string; brand_name: string }>(
    `SELECT li.product_name, li.retailer_name, li.market_name, li.brand_name
       FROM listing_state s JOIN v_listing_info li ON li.listing_id = s.listing_id
      WHERE li.product_id IS NOT NULL AND s.obs_count > 0
      ORDER BY (li.ownership = 'own') DESC, s.obs_count DESC, li.listing_id LIMIT 1`,
  );
  if (!own) return [];
  const promoBrand = db.get<{ brand_name: string }>(
    `SELECT li.brand_name FROM promotions p JOIN v_listing_info li ON li.listing_id = p.listing_id
      WHERE li.brand_name IS NOT NULL GROUP BY li.brand_id ORDER BY (li.ownership = 'competitor') DESC, COUNT(*) DESC LIMIT 1`,
  );
  const ownBrand = db.get<{ name: string }>(
    `SELECT b.name FROM brands b WHERE b.ownership = 'own' AND b.is_active = 1
        AND EXISTS (SELECT 1 FROM competitor_mappings m JOIN products p ON p.id = m.own_product_id WHERE p.brand_id = b.id AND m.status = 'approved')
      ORDER BY b.name LIMIT 1`,
  );
  const hasCompetitors = !!db.get(`SELECT 1 FROM v_listing_info li JOIN listing_state s ON s.listing_id = li.listing_id WHERE li.ownership = 'competitor' AND s.obs_count > 0 LIMIT 1`);
  return [
    `What was the price of ${own.product_name} at ${own.retailer_name} over the last 30 days?`,
    hasCompetitors ? 'Which competitor discounted their products the most this month?' : 'Which brand offered the highest discount this month?',
    ownBrand ? `How has ${ownBrand.name}'s price positioning changed against competitors?` : null,
    `Which retailer currently has the lowest price for ${own.product_name}?`,
    `Show all price increases across ${own.market_name} this week.`,
    'Which products have experienced the highest price volatility?',
    promoBrand ? `How frequently does ${promoBrand.brand_name} run promotions?` : null,
  ].filter((q): q is string => !!q);
}

function apiKey(ctx: AppContext): string | null {
  return getSecret(ctx, AI_KEY_SECRET) ?? ctx.config.anthropicApiKey;
}

export function assistantStatus(ctx: AppContext): AssistantStatus {
  const ai = getSetting(ctx, 'ai');
  const key = apiKey(ctx);
  const useClaude = ai.provider === 'anthropic' && !!key;
  return {
    engine: useClaude ? 'claude' : 'builtin',
    engine_label: useClaude ? `Claude (${ai.model})` : BUILTIN_LABEL,
    provider_setting: ai.provider,
    model: useClaude ? ai.model : null,
    api_key_configured: !!key,
    explanation: useClaude
      ? 'Claude interprets the question into a structured query; the answer and every figure in it are then computed from the stored records. No prices are sent to the model.'
      : ai.provider === 'anthropic'
        ? 'Claude is selected but no Anthropic API key is configured, so the built-in engine interprets questions. Add a key in Administration → Integrations.'
        : 'Questions are interpreted by built-in rules (no external service) and answered from the stored records. An administrator can enable Claude for freer phrasing in Administration → Integrations.',
    example_questions: exampleQuestions(ctx),
  };
}

/** Injection point for tests: a function that returns a plan the way the Claude interpreter would. */
export type Planner = (input: { question: string; catalogue: Catalogue; today: string }) => Promise<{ plan: QueryPlan; model: string }>;

export async function askAssistant(ctx: AppContext, user: Pick<AuthUser, 'id'> | null, rawQuestion: string, options: { planner?: Planner } = {}): Promise<AssistantAnswer> {
  const question = rawQuestion.trim().replace(/\s+/g, ' ').slice(0, 600);
  const catalogue = loadCatalogue(ctx);
  const today = marketToday(ctx);
  const status = assistantStatus(ctx);
  const ai = getSetting(ctx, 'ai');

  let engine: AssistantAnswer['engine'] = 'builtin';
  let model: string | null = null;
  let fallbackReason: string | null = null;
  let plan: QueryPlan | null = null;
  let clarification: string | null = null;

  const planner: Planner | null =
    options.planner ??
    (status.engine === 'claude'
      ? (input) => interpretWithClaude({ apiKey: apiKey(ctx)!, model: ai.model, question: input.question, catalogue: input.catalogue, today: input.today })
      : null);
  if (planner) {
    try {
      const result = await planner({ question, catalogue, today });
      plan = PlanSchema.parse(result.plan) as QueryPlan;
      engine = 'claude';
      model = result.model;
    } catch (err) {
      fallbackReason = err instanceof AssistantModelError ? err.message : `Claude could not be used (${err instanceof Error ? err.message : 'unknown error'}).`;
      ctx.log.warn({ err }, 'assistant: Claude interpretation failed; using the built-in engine');
    }
  }
  if (!plan) {
    const interpreted = interpretBuiltin(question, catalogue, today);
    plan = interpreted.plan;
    clarification = interpreted.clarification;
  }

  const core = executePlan(ctx, plan, catalogue, today, clarification);
  const askedAt = nowIso();
  const answer: AssistantAnswer = {
    id: null,
    question,
    asked_at: askedAt,
    engine,
    engine_label: engine === 'claude' ? `Claude (${model ?? ai.model})` : BUILTIN_LABEL,
    model,
    fallback_reason: fallbackReason ? `${fallbackReason} The built-in engine answered instead.` : null,
    ...core,
  };
  if (user) {
    answer.id = ctx.db.run(
      `INSERT INTO assistant_queries (user_id, question, engine, answer, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [user.id, question, engine, answer.answer, JSON.stringify({ status: answer.status, intent: plan.intent, summary: core.interpretation.summary, observations: core.evidence?.observations ?? 0 }), askedAt],
    ).lastInsertRowid;
    // keep the per-user history short
    ctx.db.run(
      `DELETE FROM assistant_queries WHERE user_id = ? AND id NOT IN (SELECT id FROM assistant_queries WHERE user_id = ? ORDER BY id DESC LIMIT 50)`,
      [user.id, user.id],
    );
  }
  return answer;
}

export function assistantHistory(ctx: AppContext, userId: number, limit = 20): AssistantHistoryItem[] {
  return ctx.db
    .all<{ id: number; question: string; engine: string; answer: string; payload: string; created_at: string }>(
      'SELECT id, question, engine, answer, payload, created_at FROM assistant_queries WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      [userId, limit],
    )
    .map((r) => {
      let status = 'answered';
      try {
        status = (JSON.parse(r.payload) as { status?: string }).status ?? status;
      } catch {
        /* keep default */
      }
      return { id: r.id, question: r.question, engine: r.engine, status, answer: r.answer, created_at: r.created_at };
    });
}

export async function testAssistantConnection(ctx: AppContext) {
  const key = apiKey(ctx);
  const ai = getSetting(ctx, 'ai');
  if (!key) return { ok: false, model: ai.model, display_name: null, error: 'No Anthropic API key is configured.', duration_ms: 0 };
  return testClaudeConnection(key, ai.model);
}
