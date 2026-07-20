import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { getConfig } from './core/config.js';
import { processWebhook } from './core/pipeline.js';
import { InstantlyWebhookSchema } from './core/types.js';

/** Constant-time compare so the secret can't be recovered by timing the endpoint. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthorized(request: FastifyRequest): boolean {
  const { WEBHOOK_SECRET } = getConfig();
  const header = request.headers['x-webhook-secret'];
  const query = (request.query as Record<string, unknown> | undefined)?.secret;

  const provided =
    (typeof header === 'string' && header) || (typeof query === 'string' && query) || '';

  return Boolean(provided) && secretMatches(provided, WEBHOOK_SECRET);
}

export function buildServer(): FastifyInstance {
  const config = getConfig();
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.post('/webhooks/instantly', async (request, reply) => {
    if (!isAuthorized(request)) {
      request.log.warn({ ip: request.ip }, 'rejected webhook with bad secret');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = InstantlyWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues }, 'malformed webhook payload');
      // 400, not 500: the payload is wrong, so redelivering it won't help.
      return reply.code(400).send({ error: 'invalid payload' });
    }

    // Instantly retries on non-2xx. Ack immediately and process out of band so a
    // slow OpenAI call can't cause a duplicate delivery.
    reply.code(202).send({ status: 'accepted' });

    try {
      await processWebhook(parsed.data);
    } catch (error) {
      request.log.error({ err: error }, 'pipeline failed');
    }
  });

  return app;
}
