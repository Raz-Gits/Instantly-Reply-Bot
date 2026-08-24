import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { getClient, loadClients } from './core/clients.js';
import { getConfig } from './core/config.js';
import { makeEventKey, seenBefore } from './core/dedupe.js';
import { processWebhook } from './core/pipeline.js';
import { InstantlyWebhookSchema } from './core/types.js';
import { notifyDiscordText } from './integrations/discord.js';

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
  // Fail fast on malformed client config instead of at first webhook.
  const clients = loadClients();

  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    clients: [...clients.keys()],
  }));

  // One webhook URL per Instantly workspace/campaign: /webhooks/instantly/<slug>.
  // The slug picks the client profile (calendar, pitch, Discord channel, API key).
  app.post('/webhooks/instantly/:slug', async (request, reply) => {
    if (!isAuthorized(request)) {
      request.log.warn({ ip: request.ip }, 'rejected webhook with bad secret');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const { slug } = request.params as { slug: string };
    const client = getClient(slug) ?? null;

    const parsed = InstantlyWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues }, 'malformed webhook payload');
      // 400, not 500: the payload is wrong, so redelivering it won't help.
      return reply.code(400).send({ error: 'invalid payload' });
    }

    // Redeliveries and double-fires get acked and dropped, not re-processed —
    // running the same reply twice double-posts to Discord and re-unsubscribes.
    const eventKey = makeEventKey(parsed.data, slug);
    if (seenBefore(eventKey)) {
      request.log.info({ eventKey }, 'duplicate webhook delivery ignored');
      return reply.code(202).send({ status: 'duplicate' });
    }

    // Instantly retries on non-2xx. Ack immediately and process out of band so a
    // slow OpenAI call can't cause a duplicate delivery. Unknown slugs are still
    // accepted — they classify and alert as "unconfigured" rather than vanish.
    reply.code(202).send({ status: 'accepted' });

    try {
      await processWebhook(parsed.data, client, slug);
    } catch (error) {
      request.log.error({ err: error }, 'pipeline failed');
      // We already acked, so Instantly will never retry this delivery — a
      // failure here is invisible unless a human is told. notifyDiscordText
      // never throws, so a Discord outage can't cascade.
      const summary = error instanceof Error ? error.message : String(error);
      const lead = parsed.data.lead_email ?? parsed.data.email ?? 'unknown lead';
      await notifyDiscordText(
        `🚨 Reply pipeline failed for **${slug}** (${lead}) — the reply was NOT drafted or triaged; handle it manually in the Unibox. ${summary.slice(0, 400)}`,
        client,
      );
    }
  });

  return app;
}
