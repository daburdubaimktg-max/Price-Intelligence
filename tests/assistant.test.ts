/**
 * Intelligence assistant: answers must come from stored observations, state plainly when data is unavailable and
 * never invent figures — whichever engine interprets the question.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, createTestApp, ingestKnownPrices, type Fixture, type KnownPrices, type TestApp } from './helpers.ts';
import { askAssistant, type Planner } from '../server/services/assistant/index.ts';
import { AssistantModelError } from '../server/services/assistant/claude.ts';
import { setSetting } from '../server/services/core.ts';
import type { AssistantAnswer, QueryPlan } from '../shared/api/assistant.ts';

let t: TestApp;
let fx: Fixture;
let known: KnownPrices;

const PRODUCT = 'Sunrise Amla Hair Oil 200ml';
const RIVAL = 'Rivalo Coconut Hair Oil 300ml';

before(async () => {
  t = await createTestApp();
  fx = createFixture(t.ctx);
  t.ctx.db.run('UPDATE products SET name = ? WHERE id = ?', [PRODUCT, fx.ownProductId]);
  t.ctx.db.run('UPDATE products SET name = ? WHERE id = ?', [RIVAL, fx.compProductId]);
  t.ctx.db.run(`UPDATE brands SET name = 'Sunrise' WHERE id = ?`, [fx.ownBrandId]);
  t.ctx.db.run(`UPDATE brands SET name = 'Rivalo' WHERE id = ?`, [fx.compBrandId]);
  known = await ingestKnownPrices(t.ctx, fx);
});
after(async () => {
  await t.close();
});

async function ask(question: string, as: 'admin' | 'analyst' | 'viewer' = 'analyst'): Promise<AssistantAnswer> {
  const res = await t.api('POST', '/assistant/query', { body: { question }, as });
  assert.equal(res.status, 200, res.raw.slice(0, 300));
  return res.body as AssistantAnswer;
}
const plan = (overrides: Partial<QueryPlan>): QueryPlan => ({
  intent: 'price_history',
  products: [],
  brands: [],
  retailers: [],
  markets: [],
  categories: [],
  ownership: 'any',
  period: { preset: 'last_30_days', from: null, to: null },
  direction: 'any',
  limit: null,
  reason: null,
  ...overrides,
});
/** No price may appear in an answer that has no data behind it. */
const assertNoFigures = (answer: AssistantAnswer) => {
  assert.doesNotMatch(answer.answer, /\b(AED|SAR|USD|KES)\s?\d/);
  assert.equal(answer.evidence, null);
  assert.deepEqual(answer.highlights, []);
  assert.deepEqual(answer.tables, []);
  assert.equal(answer.chart, null);
};

describe('assistant status', () => {
  it('uses the built-in engine when no Anthropic key is configured and says so', async () => {
    const res = await t.api('GET', '/assistant/status', { as: 'viewer' });
    assert.equal(res.status, 200);
    assert.equal(res.body.engine, 'builtin');
    assert.equal(res.body.api_key_configured, false);
    assert.equal(res.body.model, null);
    assert.match(res.body.explanation, /stored records/);
  });

  it('suggests example questions about what is actually monitored', async () => {
    const { example_questions: examples } = (await t.api('GET', '/assistant/status')).body;
    assert.ok(examples.length >= 5);
    assert.ok(examples.some((q: string) => q.includes(PRODUCT) && q.includes('Test Mart')));
    assert.ok(examples.some((q: string) => q.includes("Sunrise's price positioning")));
    assert.ok(!examples.some((q: string) => /Dabur|Vatika|Carrefour|Pantene/.test(q)), 'no names that are not in this catalogue');
    for (const question of examples) {
      const answer = await ask(question);
      assert.notEqual(answer.status, 'unsupported', `"${question}" should be understood`);
    }
  });

  it('does not pretend Claude is active when it is selected without a key, and the connection test reports the truth', async () => {
    setSetting(t.ctx, 'ai', { provider: 'anthropic', model: 'claude-opus-5-5' }, 1);
    try {
      const status = (await t.api('GET', '/assistant/status')).body;
      assert.equal(status.engine, 'builtin');
      assert.equal(status.provider_setting, 'anthropic');
      assert.match(status.explanation, /no Anthropic API key/i);
      const test = await t.api('POST', '/assistant/test');
      assert.equal(test.status, 200);
      assert.equal(test.body.ok, false);
      assert.match(test.body.error, /No Anthropic API key/);
      const answer = await ask(`price history of ${PRODUCT}`);
      assert.equal(answer.engine, 'builtin');
    } finally {
      setSetting(t.ctx, 'ai', { provider: 'builtin', model: 'claude-opus-5-5' }, 1);
    }
  });
});

describe('answers from stored observations', () => {
  it('reports a price history with figures that match the ledger and cites its evidence', async () => {
    const answer = await ask(`What was the price of ${PRODUCT} at Test Mart last week?`);
    assert.equal(answer.status, 'answered');
    assert.equal(answer.interpretation.intent, 'price_history');
    // last 7 days: 22.00 (T-6), 22.00 (T-4), 17.60 (T-2), 22.00 (T-1)  →  average 20.90
    assert.match(answer.answer, /ranged from AED 17\.60 to AED 22\.00/);
    assert.match(answer.answer, /averaging AED 20\.90/);
    assert.match(answer.answer, /Based on 4 stored observations/);
    assert.equal(answer.evidence!.observations, 4);
    assert.deepEqual(answer.evidence!.sources, [{ data_class: 'manual', observations: 4 }]);
    assert.deepEqual(answer.evidence!.retailers, ['Test Mart']);
    const stored = t.ctx.db.all<{ id: number }>('SELECT id FROM price_observations WHERE listing_id = ? AND observed_at >= ?', [fx.ownListingId, known.at(6)]).map((r) => r.id).sort((a, b) => a - b);
    assert.deepEqual([...answer.evidence!.observation_ids].sort((a, b) => a - b), stored);
    assert.ok(answer.evidence!.links[0]!.href.startsWith(`/history?product_id=${fx.ownProductId}`));
    assert.equal(answer.chart!.series.length, 1);
    assert.equal(answer.demo?.any_demo ?? false, false);
    assert.doesNotMatch(answer.answer, /DEMO/);
  });

  it('answers which competitor reduced prices, naming the brand and the change', async () => {
    const answer = await ask('Which competitor reduced prices in the last 14 days?');
    assert.equal(answer.status, 'answered');
    assert.equal(answer.interpretation.intent, 'price_changes');
    assert.match(answer.answer, /1 price decrease among competitor products/);
    assert.match(answer.answer, /Rivalo Coconut Hair Oil 300ml at Test Mart \(UAE\) moved from AED 30\.00 to AED 27\.00 \(−10\.0%\)/);
    assert.match(answer.answer, /By brand: Rivalo \(1\)\./);
    assert.doesNotMatch(answer.answer, / {2}/, 'no doubled spaces');
  });

  it('answers positioning questions from mapped same-retailer pairs', async () => {
    for (const question of ['Is Sunrise priced above competitors?', "How has Sunrise's price positioning changed against competitors?", 'Is Sunrise more expensive than Rivalo?']) {
      const answer = await ask(question);
      assert.equal(answer.interpretation.intent, 'positioning', question);
      assert.equal(answer.status, 'answered', question);
      assert.match(answer.answer, /22\.2% above mapped competitors/);
      assert.match(answer.answer, /price index of 122\.2/);
    }
  });

  it('answers discount, promotion-frequency, lowest-price and volatility questions', async () => {
    const discount = await ask('Which brand offered the highest discount this month?');
    assert.equal(discount.interpretation.intent, 'discount_ranking');
    assert.match(discount.answer, /Sunrise discounted the deepest/);
    assert.match(discount.answer, /20\.0%/);

    const frequency = await ask('How frequently does Sunrise run promotions?');
    assert.equal(frequency.interpretation.intent, 'promotion_frequency');
    assert.equal(frequency.status, 'answered');
    assert.match(frequency.answer, /1 promotion/);

    const lowest = await ask(`Which retailer currently has the lowest price for ${PRODUCT}?`);
    assert.equal(lowest.interpretation.intent, 'lowest_price');
    assert.match(lowest.answer, /Test Mart/);
    assert.match(lowest.answer, /AED 22\.00/);

    const volatility = await ask('Which products have experienced the highest price volatility?');
    assert.equal(volatility.interpretation.intent, 'volatility');
    assert.match(volatility.answer, new RegExp(PRODUCT));
  });
});

describe('unavailable data', () => {
  it('says the data is unavailable for a retailer that is not monitored', async () => {
    const answer = await ask(`What was the price of ${PRODUCT} at Tesco last week?`);
    assert.equal(answer.status, 'no_data');
    assert.match(answer.answer, /No monitored retailer matches "Tesco"/);
    assert.match(answer.answer, /The data is unavailable/);
    assert.deepEqual(answer.interpretation.unresolved, ['Tesco']);
    assertNoFigures(answer);
  });

  it('says the data is unavailable where a known product was never observed', async () => {
    const answer = await ask(`Show the price history of ${RIVAL} in Kenya`);
    assert.equal(answer.status, 'no_data');
    assert.match(answer.answer, /No stored price observations/);
    assert.match(answer.answer, /The data is unavailable/);
    assertNoFigures(answer);
  });

  it('answers for the monitored retailer and flags the unknown one when both are named', async () => {
    const answer = await ask(`What was the price of ${PRODUCT} at Test Mart and Walmart last week?`);
    assert.equal(answer.status, 'answered');
    assert.match(answer.answer, /Walmart/);
    assert.match(answer.answer, /AED 20\.90/);
    assert.ok(answer.interpretation.unresolved.includes('Walmart'));
  });

  it('does not forecast or answer unrelated questions', async () => {
    const forecast = await ask(`What will the price of ${PRODUCT} be next month?`);
    assert.equal(forecast.status, 'unsupported');
    assert.match(forecast.answer, /Forecasts are not available/);
    assert.match(forecast.answer, /Nothing has been assumed or estimated/);
    assertNoFigures(forecast);
    const unrelated = await ask('Who won the football last night?');
    assert.equal(unrelated.status, 'unsupported');
    assertNoFigures(unrelated);
  });
});

describe('Claude interpretation (stand-in planner)', () => {
  const user = { id: 1 };

  it('lets the model choose the query but computes every figure from the database', async () => {
    const planner: Planner = async () => ({
      plan: plan({ intent: 'price_history', products: [PRODUCT], retailers: ['Test Mart'], period: { preset: 'last_7_days', from: null, to: null } }),
      model: 'claude-opus-5-5',
    });
    const answer = await askAssistant(t.ctx, user, 'how did the amla oil do at test mart recently', { planner });
    assert.equal(answer.engine, 'claude');
    assert.equal(answer.model, 'claude-opus-5-5');
    assert.equal(answer.fallback_reason, null);
    assert.equal(answer.status, 'answered');
    assert.match(answer.answer, /averaging AED 20\.90/);
    assert.equal(answer.evidence!.observations, 4);
  });

  it('cannot be made to report on records that do not exist', async () => {
    const invented: Planner = async () => ({ plan: plan({ products: ['Unicorn Elixir 500ml'], retailers: ['Harrods'] }), model: 'claude-opus-5-5' });
    const answer = await askAssistant(t.ctx, user, 'price of unicorn elixir at harrods', { planner: invented });
    assert.equal(answer.engine, 'claude');
    assert.equal(answer.status, 'needs_clarification');
    assert.match(answer.answer, /could not find a product matching "Unicorn Elixir 500ml".*no price to report/);
    assert.deepEqual(answer.interpretation.unresolved, ['Unicorn Elixir 500ml', 'Harrods']);
    assertNoFigures(answer);

    const wrongRetailer: Planner = async () => ({ plan: plan({ products: [PRODUCT], retailers: ['Harrods'] }), model: 'claude-opus-5-5' });
    const second = await askAssistant(t.ctx, user, 'price of the amla oil at harrods', { planner: wrongRetailer });
    assert.equal(second.status, 'no_data');
    assert.match(second.answer, /No monitored retailer matches "Harrods".*The data is unavailable/);
    assertNoFigures(second);
  });

  it('falls back to the built-in engine with the real reason when the model call fails', async () => {
    const planner: Planner = async () => {
      throw new AssistantModelError('auth', 'The Anthropic API key was rejected.');
    };
    const answer = await askAssistant(t.ctx, user, `What was the price of ${PRODUCT} at Test Mart last week?`, { planner });
    assert.equal(answer.engine, 'builtin');
    assert.equal(answer.fallback_reason, 'The Anthropic API key was rejected. The built-in engine answered instead.');
    assert.equal(answer.status, 'answered');
    assert.match(answer.answer, /averaging AED 20\.90/);
  });

  it('rejects a malformed plan from the model instead of executing it', async () => {
    const planner = (async () => ({ plan: { intent: 'drop_tables', products: 'everything' }, model: 'claude-opus-5-5' })) as unknown as Planner;
    const answer = await askAssistant(t.ctx, user, `price history of ${PRODUCT}`, { planner });
    assert.equal(answer.engine, 'builtin');
    assert.match(answer.fallback_reason!, /built-in engine answered instead/);
    assert.equal(answer.status, 'answered');
  });
});

describe('access and history', () => {
  it('keeps a private history per user', async () => {
    await ask('Which products have experienced the highest price volatility?', 'viewer');
    const viewer = await t.api('GET', '/assistant/history', { as: 'viewer' });
    assert.equal(viewer.status, 200);
    assert.equal(viewer.body.rows[0].question, 'Which products have experienced the highest price volatility?');
    assert.equal(viewer.body.rows[0].status, 'answered');
    assert.ok(viewer.body.rows.every((r: any) => !/Tesco/.test(r.question)), "another user's questions are not visible");
    const analyst = await t.api('GET', '/assistant/history', { as: 'analyst' });
    assert.ok(analyst.body.rows.some((r: any) => /Tesco/.test(r.question)));
  });

  it('requires a signed-in user and a real question', async () => {
    assert.equal((await t.api('POST', '/assistant/query', { body: { question: 'price of amla' }, as: null })).status, 401);
    assert.equal((await t.api('POST', '/assistant/query', { body: { question: '  ' } })).status, 422);
    assert.equal((await t.api('POST', '/assistant/query', { body: {} })).status, 422);
    assert.equal((await t.api('POST', '/assistant/test', { as: 'analyst' })).status, 403);
  });
});

describe('assistant on an empty database', () => {
  it('offers no example questions and reports that nothing is stored', async () => {
    const empty = await createTestApp();
    try {
      const status = (await empty.api('GET', '/assistant/status')).body;
      assert.deepEqual(status.example_questions, []);
      const res = await empty.api('POST', '/assistant/query', { body: { question: 'Show all price increases across Kenya this week.' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'no_data');
      assert.match(res.body.answer, /unavailable/i);
      assert.equal(res.body.evidence, null);
    } finally {
      await empty.close();
    }
  });
});
