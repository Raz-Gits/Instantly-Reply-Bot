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
