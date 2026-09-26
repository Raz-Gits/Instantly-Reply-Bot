import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClient, setClientsForTesting, type ClientProfile } from '../src/core/clients.js';
import { setConfigForTesting } from '../src/core/config.js';
import { decide } from '../src/core/decide.js';
import { normalizeEvent } from '../src/core/normalize.js';
import type { Classification, Intent } from '../src/core/types.js';
import { notifyDiscord } from '../src/integrations/discord.js';

// fetch is stubbed, so this reads the embed that would be posted without
// reaching Discord.
const fetchMock = vi.fn();

beforeAll(() => {
  setConfigForTesting({
    CONFIDENCE_THRESHOLD: 0.7,
    WEBHOOK_SECRET: 'discord-test-secret-51f0',
    DISCORD_WEBHOOK_URL: 'https://discord.invalid/api/webhooks/global',
  });
  setClientsForTesting({
    acme: {
      clientName: 'Acme Corp',
      senderName: 'Jane',
      calendarLink: 'https://cal.com/jane-acme',
      discordWebhookUrl: 'https://discord.invalid/api/webhooks/acme',
    },
  });
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const acme = () => getClient('acme') as ClientProfile;

function classification(intent: Intent, followUpTimeframe = ''): Classification {
  return {
    intent,
    sentiment: 'positive',
    confidence: 0.95,
    reasoning: 'test',
    isComplexNegative: false,
    flags: [],
    followUpTimeframe,
    notes: '',
    source: 'openai',
  };
}

type Field = { name: string; value: string };

async function postedFields(replyText: string, c: Classification): Promise<Field[]> {
  const event = normalizeEvent({ lead_email: 'lead@prospect.example', reply_text: replyText });
  const decision = decide(event, c, acme());
  await notifyDiscord(event, decision, acme());
  const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
  expect(url).toBe('https://discord.invalid/api/webhooks/acme');
  const body = JSON.parse(init.body as string) as { embeds: Array<{ fields: Field[] }> };
  return body.embeds[0]!.fields;
}

describe('Discord embed', () => {
  it('shows a follow-up alert with what to do and the text to send', async () => {
    const fields = await postedFields(
      'Try me again in Q4.',
      classification('not_now_follow_up_later', 'in Q4'),
    );

    const action = fields.find((f) => f.name === 'Action needed');
    const suggested = fields.find((f) => f.name.startsWith('Suggested reply'));
    expect(action?.value).toMatch(/set a reminder/i);
    expect(suggested?.name).toContain('follow_up_later');
    expect(suggested?.value).toContain('follow up with you in Q4');
  });

  it('shows a draft with its text and no action field', async () => {
    const fields = await postedFields('Sounds good, let us talk.', classification('interested'));

    expect(fields.find((f) => f.name === 'Action needed')).toBeUndefined();
    expect(fields.find((f) => f.name.startsWith('Suggested reply'))?.value).toContain(
      'https://cal.com/jane-acme',
    );
  });

  it('reports false, without throwing, when Discord answers with an error', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));
    const event = normalizeEvent({ lead_email: 'lead@prospect.example', reply_text: 'hi' });
    const decision = decide(event, classification('unclear'), acme());

    await expect(notifyDiscord(event, decision, acme())).resolves.toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it('reports false, without throwing, when Discord cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const event = normalizeEvent({ lead_email: 'lead@prospect.example', reply_text: 'hi' });
    const decision = decide(event, classification('unclear'), acme());

    await expect(notifyDiscord(event, decision, acme())).resolves.toBe(false);
  });
});

describe('Discord error logging', () => {
  it('masks the configured secret in a logged error', async () => {
    fetchMock.mockRejectedValue(new Error('proxy refused discord-test-secret-51f0'));
    const event = normalizeEvent({ lead_email: 'lead@prospect.example', reply_text: 'hi' });
    const decision = decide(event, classification('unclear'), acme());

    await notifyDiscord(event, decision, acme());

    const logged = vi.mocked(console.error).mock.calls.map((call) => call.join(' ')).join(' ');
    expect(logged).toContain('proxy refused [redacted]');
    expect(logged).not.toContain('discord-test-secret-51f0');
  });
});
