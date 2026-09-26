import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The server's side effects are replaced, so nothing here reaches OpenAI,
// Instantly or Discord.
vi.mock('../src/core/pipeline.js', () => ({
  processWebhook: vi.fn(async () => undefined),
}));
vi.mock('../src/integrations/discord.js', () => ({
  notifyDiscord: vi.fn(async () => true),
  notifyDiscordText: vi.fn(async () => true),
}));

import { setClientsForTesting } from '../src/core/clients.js';
import { setConfigForTesting } from '../src/core/config.js';
import { resetDedupeForTesting } from '../src/core/dedupe.js';
import { processWebhook } from '../src/core/pipeline.js';
import { notifyDiscordText } from '../src/integrations/discord.js';
import { buildServer } from '../src/server.js';

const SECRET = 'test-secret-9f3a1c7e5b2d';
const WRONG_SECRET = 'wrong-secret-4e8d2a6c0f1b';

const replyPayload = {
  event_type: 'reply_received',
  timestamp: '2026-09-26T10:00:00Z',
  lead_email: 'lead@prospect.example',
  reply_text: 'Sounds interesting, tell me more.',
  reply_subject: 'Re: quick question',
  campaign_id: 'cmp_1',
};

let app: FastifyInstance;
let logLines: string[];

beforeAll(() => {
  setConfigForTesting({
    WEBHOOK_SECRET: SECRET,
    LOG_LEVEL: 'info',
    DISCORD_WEBHOOK_URL: 'https://discord.invalid/api/webhooks/global',
    CONFIDENCE_THRESHOLD: 0.7,
  });
  setClientsForTesting({
    acme: {
      clientName: 'Acme Corp',
      senderName: 'Jane',
      calendarLink: 'https://cal.com/jane-acme',
    },
    beta: {
      clientName: 'Beta LLC',
      senderName: 'Sam',
      calendarLink: 'https://cal.com/sam-beta',
    },
  });
});

beforeEach(() => {
  resetDedupeForTesting();
  vi.mocked(processWebhook).mockClear();
  vi.mocked(notifyDiscordText).mockClear();
  logLines = [];
  app = buildServer({ logStream: { write: (line: string) => logLines.push(line) } });
});

afterEach(async () => {
  await app.close();
});

const logs = () => logLines.join('');

describe('webhook secret stays out of the logs', () => {
  it('masks a correct ?secret= value in every log line', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/instantly/acme?secret=${SECRET}`,
      payload: replyPayload,
    });

    expect(res.statusCode).toBe(202);
    // The request line was logged, so the check below is not vacuous.
    expect(logs()).toContain('/webhooks/instantly/acme?secret=[redacted]');
    expect(logs()).not.toContain(SECRET);
  });

  it('masks a wrong ?secret= value too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/instantly/acme?secret=${WRONG_SECRET}`,
      payload: replyPayload,
    });

    expect(res.statusCode).toBe(401);
    expect(logs()).toContain('rejected webhook with bad secret');
    expect(logs()).not.toContain(WRONG_SECRET);
  });

  it('masks the secret in the plain-text line Fastify writes for an unknown route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/instantly?secret=${SECRET}`,
      payload: replyPayload,
    });

    expect(res.statusCode).toBe(404);
    expect(logs()).toContain('not found');
    expect(logs()).not.toContain(SECRET);
  });

  it('does not log a secret sent in the X-Webhook-Secret header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instantly/acme',
      headers: { 'x-webhook-secret': SECRET },
      payload: replyPayload,
    });

    expect(res.statusCode).toBe(202);
    expect(logs()).toContain('incoming request');
    expect(logs()).not.toContain(SECRET);
  });
});

describe('only reply events are processed', () => {
  it.each(['email_opened', 'email_sent', 'link_clicked', 'lead_unsubscribed'])(
    'acknowledges and ignores a %s event',
    async (eventType) => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/instantly/acme',
        headers: { 'x-webhook-secret': SECRET },
        payload: { ...replyPayload, event_type: eventType },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ status: 'ignored' });
      expect(processWebhook).not.toHaveBeenCalled();
    },
  );

  it('still processes a payload with no event_type, and logs a warning', async () => {
    const { event_type: _omitted, ...withoutType } = replyPayload;
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instantly/acme',
      headers: { 'x-webhook-secret': SECRET },
      payload: withoutType,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted' });
    await vi.waitFor(() => expect(processWebhook).toHaveBeenCalledTimes(1));
    expect(logs()).toContain('no event_type');
  });
});

describe('/health', () => {
  it('reports how many clients loaded without naming them', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', clientCount: 2 });
    expect(res.body).not.toContain('acme');
    expect(res.body).not.toContain('beta');
  });
});

describe('webhook endpoint', () => {
  const post = (url: string, payload: unknown, secret: string | null = SECRET) =>
    app.inject({
      method: 'POST',
      url,
      headers: secret === null ? {} : { 'x-webhook-secret': secret },
      payload: payload as Record<string, unknown>,
    });

  it('rejects a request with no secret with 401 and does not process it', async () => {
    const res = await post('/webhooks/instantly/acme', replyPayload, null);
    expect(res.statusCode).toBe(401);
    expect(processWebhook).not.toHaveBeenCalled();
  });

  it('rejects a wrong header secret with 401 and does not process it', async () => {
    const res = await post('/webhooks/instantly/acme', replyPayload, WRONG_SECRET);
    expect(res.statusCode).toBe(401);
    expect(processWebhook).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload with 400 and does not process it', async () => {
    const res = await post('/webhooks/instantly/acme', { ...replyPayload, lead_email: 42 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid payload' });
    expect(processWebhook).not.toHaveBeenCalled();
  });

  it('acknowledges a reply with 202 and hands it to the pipeline with its client', async () => {
    const res = await post('/webhooks/instantly/acme', replyPayload);

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted' });
    await vi.waitFor(() => expect(processWebhook).toHaveBeenCalledTimes(1));
    const [payload, client, slug] = vi.mocked(processWebhook).mock.calls[0]!;
    expect(payload).toMatchObject(replyPayload);
    expect(client?.slug).toBe('acme');
    expect(slug).toBe('acme');
  });

  it('acknowledges a repeat delivery as a duplicate and processes it only once', async () => {
    const first = await post('/webhooks/instantly/acme', replyPayload);
    const second = await post('/webhooks/instantly/acme', replyPayload);

    expect(first.json()).toEqual({ status: 'accepted' });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ status: 'duplicate' });
    await vi.waitFor(() => expect(processWebhook).toHaveBeenCalledTimes(1));
    // Give a wrongly processed duplicate the chance to show up.
    await new Promise((resolve) => setImmediate(resolve));
    expect(processWebhook).toHaveBeenCalledTimes(1);
  });

  it('accepts an unknown slug but passes no client, so it can only alert', async () => {
    const res = await post('/webhooks/instantly/nobody', replyPayload);

    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => expect(processWebhook).toHaveBeenCalledTimes(1));
    const [, client, slug] = vi.mocked(processWebhook).mock.calls[0]!;
    expect(client).toBeNull();
    expect(slug).toBe('nobody');
  });

  it('posts a Discord alert when the pipeline throws after the 202', async () => {
    vi.mocked(processWebhook).mockRejectedValueOnce(new Error('boom'));

    const res = await post('/webhooks/instantly/acme', replyPayload);

    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => expect(notifyDiscordText).toHaveBeenCalledTimes(1));
    const [message, client] = vi.mocked(notifyDiscordText).mock.calls[0]!;
    expect(message).toContain('Reply pipeline failed');
    expect(message).toContain('lead@prospect.example');
    expect(message).toContain('boom');
    expect(client?.slug).toBe('acme');
  });
});

describe('secret masking covers encoded parameters and error text', () => {
  // A secret with a reserved character, so its URL form differs from its value.
  const SLASH_SECRET = 'slash/secret/2468';
  const ENCODED_VALUE = 'slash%2Fsecret%2F2468';

  /** Rebuilds the server with a different configured secret for one test. */
  async function withSecret(secret: string, run: () => Promise<void>) {
    await app.close();
    setConfigForTesting({ WEBHOOK_SECRET: secret });
    app = buildServer({ logStream: { write: (line: string) => logLines.push(line) } });
    try {
      await run();
    } finally {
      setConfigForTesting({ WEBHOOK_SECRET: SECRET });
    }
  }

  it('masks an encoded key and value that authenticate', async () => {
    await withSecret(SLASH_SECRET, async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/webhooks/instantly/acme?se%63ret=${ENCODED_VALUE}`,
        payload: replyPayload,
      });

      // Fastify decodes the key and value, so this really is the secret.
      expect(res.statusCode).toBe(202);
      expect(logs()).toContain('/webhooks/instantly/acme?se%63ret=[redacted]');
      expect(logs()).not.toContain(ENCODED_VALUE);
      expect(logs()).not.toContain(SLASH_SECRET);
    });
  });

  it('masks an encoded key and value on an unknown route', async () => {
    await withSecret(SLASH_SECRET, async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/webhooks/instantly?se%63ret=${ENCODED_VALUE}`,
        payload: replyPayload,
      });

      expect(res.statusCode).toBe(404);
      expect(logs()).toContain('not found');
      expect(logs()).not.toContain(ENCODED_VALUE);
    });
  });

  it('masks the secret inside a pipeline error, in the log and in the Discord alert', async () => {
    vi.mocked(processWebhook).mockRejectedValueOnce(new Error(`upstream said ${SECRET}`));

    await app.inject({
      method: 'POST',
      url: '/webhooks/instantly/acme',
      headers: { 'x-webhook-secret': SECRET },
      payload: replyPayload,
    });

    await vi.waitFor(() => expect(notifyDiscordText).toHaveBeenCalledTimes(1));
    expect(logs()).toContain('pipeline failed');
    expect(logs()).toContain('upstream said [redacted]');
    expect(logs()).not.toContain(SECRET);
    const [message] = vi.mocked(notifyDiscordText).mock.calls[0]!;
    expect(message).toContain('upstream said [redacted]');
    expect(message).not.toContain(SECRET);
  });
});
