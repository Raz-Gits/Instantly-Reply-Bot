import type OpenAI from 'openai';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Every outside call the pipeline can make is replaced here, and fetch is
// stubbed to throw, so a missed mock fails loudly instead of reaching a
// real service.
vi.mock('../src/integrations/instantly.js', () => ({
  markLeadUnsubscribed: vi.fn(),
  sendReply: vi.fn(),
}));
vi.mock('../src/integrations/discord.js', () => ({
  notifyDiscord: vi.fn(async () => true),
  notifyDiscordText: vi.fn(async () => true),
}));

import { setOpenAIClientForTesting } from '../src/classify/openai.js';
import { getClient, setClientsForTesting, type ClientProfile } from '../src/core/clients.js';
import { setConfigForTesting } from '../src/core/config.js';
import { processWebhook } from '../src/core/pipeline.js';
import { notifyDiscord, notifyDiscordText } from '../src/integrations/discord.js';
import { markLeadUnsubscribed, sendReply } from '../src/integrations/instantly.js';

const LEAD_EMAIL = 'lead@prospect.example';
const SECRET = 'pipeline-secret-7c1e9a4b';

function payload(replyText: string, extra: Record<string, string> = {}) {
  return {
    event_type: 'reply_received',
    lead_email: LEAD_EMAIL,
    firstName: 'Lee',
    reply_text: replyText,
    reply_subject: 'Re: quick question',
    campaign_name: 'Q3 Outbound',
    unibox_url: 'https://app.instantly.ai/unibox/thread-1',
    ...extra,
  };
}

/** Makes the model return this classification, without any network. */
function stubModel(intent: string, confidence = 0.95) {
  const create = vi.fn(async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            intent,
            sentiment: 'positive',
            confidence,
            reasoning: 'stubbed',
            is_complex_negative: false,
            flags: [],
            follow_up_timeframe: '',
            notes: '',
          }),
        },
      },
    ],
  }));
  setOpenAIClientForTesting({ chat: { completions: { create } } } as unknown as OpenAI);
  return create;
}

/** The one JSON summary line the pipeline logs per reply. */
function summaryLine(): Record<string, unknown> {
  const calls = vi.mocked(console.log).mock.calls;
  for (const [first] of calls) {
    if (typeof first !== 'string') continue;
    try {
      const parsed = JSON.parse(first) as Record<string, unknown>;
      if (parsed.at === 'pipeline') return parsed;
    } catch {
      // not the summary line
    }
  }
  throw new Error('pipeline summary line was not logged');
}

const acme = () => getClient('acme') as ClientProfile;

beforeAll(() => {
  setConfigForTesting({
    CONFIDENCE_THRESHOLD: 0.7,
    WEBHOOK_SECRET: SECRET,
    OPENAI_MODEL: 'gpt-4o-mini',
    DISCORD_WEBHOOK_URL: 'https://discord.invalid/api/webhooks/global',
  });
  setClientsForTesting({
    acme: {
      clientName: 'Acme Corp',
      senderName: 'Jane',
      calendarLink: 'https://cal.com/jane-acme',
      instantlyApiKeyEnv: 'INSTANTLY_API_KEY_ACME',
    },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(notifyDiscord).mockResolvedValue(true);
  vi.mocked(notifyDiscordText).mockResolvedValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network is off in tests');
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // A test that needs the model stubs it; any other model call fails.
  setOpenAIClientForTesting({
    chat: {
      completions: {
        create: vi.fn(async () => {
          throw new Error('model not expected in this test');
        }),
      },
    },
  } as unknown as OpenAI);
});

afterEach(() => {
  // The public version never sends email. Every test in this file checks it.
  expect(sendReply).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('opt-out outcomes are reported truthfully and loudly', () => {
  it('logs "done" and posts nothing extra when the unsubscribe works', async () => {
    vi.mocked(markLeadUnsubscribed).mockResolvedValue({ status: 'done' });

    const result = await processWebhook(payload('unsubscribe'), acme(), 'acme');

    expect(markLeadUnsubscribed).toHaveBeenCalledWith(acme(), LEAD_EMAIL);
    expect(result.unsubscribe).toBe('done');
    expect(notifyDiscordText).not.toHaveBeenCalled();
    expect(summaryLine()).toMatchObject({ unsubscribeRequested: true, unsubscribe: 'done' });
  });

  it('posts a Discord alert and logs "failed" when the Instantly call fails', async () => {
    vi.mocked(markLeadUnsubscribed).mockResolvedValue({
      status: 'failed',
      why: 'Instantly POST /block-lists-entries failed: 500',
    });

    const result = await processWebhook(payload('unsubscribe'), acme(), 'acme');

    expect(result.unsubscribe).toBe('failed');
    expect(notifyDiscordText).toHaveBeenCalledTimes(1);
    const [message] = vi.mocked(notifyDiscordText).mock.calls[0]!;
    expect(message).toContain(LEAD_EMAIL);
    expect(message).toContain('Could not auto-unsubscribe');
    expect(message).toContain('by hand');
    const line = summaryLine();
    expect(line).toMatchObject({ unsubscribe: 'failed' });
    // The old line said "unsubscribed": true even when the call failed.
    expect(line).not.toHaveProperty('unsubscribed');
  });

  it('posts a Discord alert and logs "skipped" when no API key is configured', async () => {
    vi.mocked(markLeadUnsubscribed).mockResolvedValue({
      status: 'skipped',
      why: 'env var INSTANTLY_API_KEY_ACME is not set',
    });

    const result = await processWebhook(payload('unsubscribe'), acme(), 'acme');

    expect(result.unsubscribe).toBe('skipped');
    expect(notifyDiscordText).toHaveBeenCalledTimes(1);
    const [message] = vi.mocked(notifyDiscordText).mock.calls[0]!;
    expect(message).toContain('Did not auto-unsubscribe');
    expect(message).toContain('INSTANTLY_API_KEY_ACME is not set');
    expect(message).toContain('https://app.instantly.ai/unibox/thread-1');
    expect(summaryLine()).toMatchObject({ unsubscribe: 'skipped' });
  });

  it('posts a Discord alert when the payload had no lead email', async () => {
    vi.mocked(markLeadUnsubscribed).mockResolvedValue({
      status: 'skipped',
      why: 'payload had no lead email',
    });

    const result = await processWebhook(
      payload('unsubscribe', { lead_email: '' }),
      acme(),
      'acme',
    );

    expect(result.unsubscribe).toBe('skipped');
    const [message] = vi.mocked(notifyDiscordText).mock.calls[0]!;
    expect(message).toContain('email was missing');
    expect(message).toContain('https://app.instantly.ai/unibox/thread-1');
  });

  it('logs an error when the opt-out alert itself cannot be posted', async () => {
    vi.mocked(markLeadUnsubscribed).mockResolvedValue({ status: 'failed', why: 'timeout' });
    vi.mocked(notifyDiscordText).mockResolvedValue(false);

    await processWebhook(payload('unsubscribe'), acme(), 'acme');

    expect(console.error).toHaveBeenCalledTimes(1);
    const [logged] = vi.mocked(console.error).mock.calls[0]!;
    expect(logged).toContain(LEAD_EMAIL);
    expect(logged).toContain('NOT unsubscribed');
  });
});

describe('opt-out wording through the whole pipeline', () => {
  it('alerts, and does not unsubscribe, when the model calls an opt-out "interested"', async () => {
    const model = stubModel('interested', 0.99);

    const result = await processWebhook(
      payload('Please stop contacting our company'),
      acme(),
      'acme',
    );

    expect(model).toHaveBeenCalledTimes(1);
    expect(result.decision.action).toBe('alert');
    expect(result.decision.reason).toMatch(/opt-out language detected/i);
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyDiscord).mock.calls[0]![1].action).toBe('alert');
    expect(markLeadUnsubscribed).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });
});

describe('side effects on each path', () => {
  it('posts a draft to Discord and never sends it', async () => {
    stubModel('meeting_request');

    const result = await processWebhook(
      payload('Sounds good, can we talk Thursday?'),
      acme(),
      'acme',
    );

    expect(result.decision.action).toBe('draft');
    expect(result.decision.draft?.body).toContain('https://cal.com/jane-acme');
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyDiscord).mock.calls[0]![1].action).toBe('draft');
    expect(sendReply).not.toHaveBeenCalled();
    expect(markLeadUnsubscribed).not.toHaveBeenCalled();
    expect(result.unsubscribe).toBe('not_requested');
    expect(summaryLine()).toMatchObject({ action: 'draft', unsubscribe: 'not_requested' });
  });

  it('posts nothing for an ignored out-of-office reply', async () => {
    stubModel('out_of_office');

    const result = await processWebhook(payload('Out of office until Monday.'), acme(), 'acme');

    expect(result.decision.action).toBe('ignore');
    expect(result.notified).toBe(false);
    expect(notifyDiscord).not.toHaveBeenCalled();
    expect(notifyDiscordText).not.toHaveBeenCalled();
    expect(markLeadUnsubscribed).not.toHaveBeenCalled();
  });

  it('alerts for an unknown slug and never calls Instantly, even for an opt-out', async () => {
    const result = await processWebhook(payload('unsubscribe'), null, 'nobody');

    expect(result.decision.action).toBe('alert');
    expect(result.decision.reason).toContain('"nobody"');
    expect(markLeadUnsubscribed).not.toHaveBeenCalled();
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyDiscord).mock.calls[0]![2]).toBeNull();
  });

  it('alerts when the model call fails, instead of losing the reply', async () => {
    // The default stub in beforeEach throws, like an OpenAI outage.
    const result = await processWebhook(payload('Tell me more about this.'), acme(), 'acme');

    expect(result.decision.action).toBe('alert');
    expect(result.decision.classification.intent).toBe('unclear');
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
  });
});

describe('pipeline log lines are masked too', () => {
  it('masks the configured secret in the error and summary lines', async () => {
    vi.mocked(markLeadUnsubscribed).mockResolvedValue({
      status: 'failed',
      why: `Instantly echoed ?secret=${SECRET} back`,
    });
    vi.mocked(notifyDiscordText).mockResolvedValue(false);

    await processWebhook(payload('unsubscribe'), acme(), 'acme');

    const [errorLine] = vi.mocked(console.error).mock.calls[0]!;
    expect(errorLine).toContain('NOT unsubscribed');
    expect(errorLine).toContain('[redacted]');
    expect(errorLine).not.toContain(SECRET);
    expect(summaryLine().unsubscribeWhy).toBe('Instantly echoed ?secret=[redacted] back');
    const everything = [
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ].join(' ');
    expect(everything).not.toContain(SECRET);
  });
});
