import type OpenAI from 'openai';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyReply } from '../src/classify/index.js';
import { classifyWithOpenAI, setOpenAIClientForTesting } from '../src/classify/openai.js';
import { setConfigForTesting } from '../src/core/config.js';
import { normalizeEvent } from '../src/core/normalize.js';

// A lead whose details appear nowhere in the system prompt, so a match in
// the messages can only mean the details were sent.
const lead = {
  lead_email: 'priya.raman@northwind-freight.example',
  firstName: 'Priya',
  lastName: 'Raman',
  companyName: 'Northwind Freight',
  campaign_name: 'Q3 Freight Outbound',
  phone: '+1 555 0100',
};

const reply = 'Sounds interesting. What does it cost per month?';
const subject = 'Re: invoicing for brokers';

const modelAnswer = {
  intent: 'pricing_request',
  sentiment: 'positive',
  confidence: 0.91,
  reasoning: 'Asks about cost.',
  is_complex_negative: false,
  flags: [],
  follow_up_timeframe: '',
  notes: 'asked monthly price',
};

/** Stubs the OpenAI client and returns the mock that records each request. */
function stubCreate(content: string) {
  const create = vi.fn(async (_params: { messages: Array<{ role: string; content: string }> }) => ({
    choices: [{ message: { content } }],
  }));
  setOpenAIClientForTesting({ chat: { completions: { create } } } as unknown as OpenAI);
  return create;
}

beforeAll(() => {
  setConfigForTesting({ OPENAI_MODEL: 'gpt-4o-mini' });
});

afterEach(() => {
  setOpenAIClientForTesting(undefined);
});

describe('what the classifier sends to OpenAI', () => {
  it('sends the subject and the reply, and not the lead name, email, company or campaign', async () => {
    const create = stubCreate(JSON.stringify(modelAnswer));

    await classifyWithOpenAI(
      normalizeEvent({ ...lead, reply_text: reply, reply_subject: subject }),
    );

    expect(create).toHaveBeenCalledTimes(1);
    const { messages } = create.mock.calls[0]![0];
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain(subject);
    expect(user).toContain(reply);

    const everything = JSON.stringify(messages);
    for (const detail of [
      'priya.raman@northwind-freight.example',
      'northwind-freight',
      'Priya',
      'Raman',
      'Northwind',
      'Q3 Freight Outbound',
      '555 0100',
    ]) {
      expect(everything).not.toContain(detail);
    }
  });
});

describe('reading the model response', () => {
  it('maps the structured response onto a classification', async () => {
    stubCreate(JSON.stringify({ ...modelAnswer, intent: 'not_now_follow_up_later', follow_up_timeframe: 'in Q4' }));

    const result = await classifyWithOpenAI(normalizeEvent({ ...lead, reply_text: 'Try me in Q4.' }));

    expect(result).toEqual({
      intent: 'not_now_follow_up_later',
      sentiment: 'positive',
      confidence: 0.91,
      reasoning: 'Asks about cost.',
      isComplexNegative: false,
      flags: [],
      followUpTimeframe: 'in Q4',
      notes: 'asked monthly price',
      source: 'openai',
    });
  });

  it('rejects an answer outside the schema, and classifyReply turns that into "unclear"', async () => {
    stubCreate(JSON.stringify({ ...modelAnswer, intent: 'definitely_buying' }));
    const event = normalizeEvent({ ...lead, reply_text: reply });

    await expect(classifyWithOpenAI(event)).rejects.toThrow();

    const fallback = await classifyReply(event);
    expect(fallback.intent).toBe('unclear');
    expect(fallback.confidence).toBe(0);
  });
});
