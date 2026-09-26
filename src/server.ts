import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { getClient, loadClients } from './core/clients.js';
import { getConfig } from './core/config.js';
import { makeEventKey, seenBefore } from './core/dedupe.js';
import { processWebhook } from './core/pipeline.js';
import { redactSecrets } from './core/redact.js';
import { InstantlyWebhookSchema } from './core/types.js';
import { notifyDiscordText } from './integrations/discord.js';

/** The only Instantly event this bot acts on. */
const REPLY_EVENT_TYPE = 'reply_received';

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

export interface ServerOptions {
  /** Where log lines go. Defaults to stdout; tests pass a collector. */
  logStream?: { write(line: string): unknown };
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const config = getConfig();
  // Fail fast on malformed client config instead of at first webhook.
  const clients = loadClients();
  const logTarget = options.logStream ?? process.stdout;

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      serializers: {
        // Same fields as Fastify's default, with the URL masked at the source.
        req: (request) => ({
          method: request.method,
          url: redactSecrets(request.url, config.WEBHOOK_SECRET),
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        }),
      },
      // Some lines never pass through the serializer: an unknown route logs
      // "Route POST:<full url> not found" as plain text. So every line is
      // masked once more on its way out.
      stream: {
        write: (line: string) => {
          logTarget.write(redactSecrets(line, config.WEBHOOK_SECRET));
        },
      },
    },
  });

  // Public, so it gives a count, not the client slugs: a slug is half of a
  // webhook URL.
  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    clientCount: clients.size,
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

    // Only replies are handled. A webhook set to "All Events", or a second
    // webhook pointed here, sends opens, clicks and sends too; those are
    // acknowledged (so Instantly doesn't retry) and dropped. Instantly's docs
    // list event_type as always present, but the schema has never required
    // it, so a payload without one is still processed, with a warning.
    const eventType = parsed.data.event_type;
    if (eventType === undefined) {
      request.log.warn({ slug }, 'webhook payload has no event_type; processing it as a reply');
    } else if (eventType !== REPLY_EVENT_TYPE) {
      request.log.info({ slug, eventType }, 'non-reply webhook event ignored');
      return reply.code(202).send({ status: 'ignored' });
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
      // An error message is arbitrary text, so it is masked before it leaves.
      const summary = redactSecrets(
        error instanceof Error ? error.message : String(error),
        config.WEBHOOK_SECRET,
      );
      const lead = parsed.data.lead_email ?? parsed.data.email ?? 'unknown lead';
      await notifyDiscordText(
        `🚨 Reply pipeline failed for **${slug}** (${lead}) — the reply was NOT drafted or triaged; handle it manually in the Unibox. ${summary.slice(0, 400)}`,
        client,
      );
    }
  });

  return app;
}
