import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/http.ts';
import { audit } from '../services/core.ts';
import { askAssistant, assistantHistory, assistantStatus, testAssistantConnection } from '../services/assistant/index.ts';

export default async function assistantRoutes(app: FastifyInstance) {
  const { ctx } = app;

  app.get('/assistant/status', async () => assistantStatus(ctx));

  app.get('/assistant/history', async (req) => ({ rows: assistantHistory(ctx, req.user!.id) }));

  app.post(
    '/assistant/query',
    { config: { permission: 'assistant.use', rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const body = parse(z.object({ question: z.string().trim().min(3, 'Ask a question of at least a few words').max(600) }), req.body);
      return askAssistant(ctx, req.user!, body.question);
    },
  );

  /** Real connectivity check for the configured Anthropic key and model (no question is sent). */
  app.post('/assistant/test', { config: { permission: 'admin.integrations' } }, async (req) => {
    const result = await testAssistantConnection(ctx);
    audit(ctx, req.user, 'integration.ai_tested', 'integration', 'ai', { ok: result.ok, model: result.model }, req.ip);
    return result;
  });
}
