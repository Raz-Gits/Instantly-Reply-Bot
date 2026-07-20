import { beforeAll, describe, expect, it } from 'vitest';
import { setConfigForTesting } from '../src/core/config.js';
import { decide } from '../src/core/decide.js';
import { normalizeEvent } from '../src/core/normalize.js';
import type { Classification, Intent, Sentiment } from '../src/core/types.js';

beforeAll(() => {
  setConfigForTesting({
    CONFIDENCE_THRESHOLD: 0.7,
    SENDER_NAME: 'Raz',
    SENDER_COMPANY: 'Acme',
    CALENDAR_LINK: 'https://cal.com/raz',
  });
});

function event(replyText: string, overrides: Record<string, string> = {}) {
  return normalizeEvent({
    lead_email: 'jane@corp.com',
    firstName: 'Jane',
    lastName: 'Doe',
    companyName: 'Corp',
    reply_text: replyText,
    reply_subject: 'Re: quick question',
    campaign_name: 'Q3 Outbound',
    ...overrides,
  });
}

function classification(
  intent: Intent,
  opts: Partial<Classification> = {},
): Classification {
  return {
    intent,
    sentiment: (opts.sentiment ?? 'neutral') as Sentiment,
    confidence: opts.confidence ?? 0.95,
    reasoning: opts.reasoning ?? 'test',
    isComplexNegative: opts.isComplexNegative ?? false,
    notes: opts.notes ?? '',
    source: opts.source ?? 'openai',
  };
}

describe('decide', () => {
  it('ignores bare unsubscribes', () => {
    const d = decide(event('unsubscribe'), classification('unsubscribe'));
    expect(d.action).toBe('ignore');
  });

  it('ignores out-of-office and auto-replies', () => {
    expect(decide(event('OOO until Monday'), classification('out_of_office')).action).toBe('ignore');
    expect(decide(event('Ticket #4 created'), classification('auto_reply')).action).toBe('ignore');
  });

  it('ignores a simple decline', () => {
    const d = decide(event('not interested'), classification('not_interested'));
    expect(d.action).toBe('ignore');
  });

  it('alerts on a complex negative even when the intent is an opt-out', () => {
    const d = decide(
      event('Remove me. Also this is the third time you people have emailed me and it is unacceptable.'),
      classification('unsubscribe', { isComplexNegative: true, sentiment: 'negative' }),
    );
    expect(d.action).toBe('alert');
  });

  it('alerts on objections rather than auto-answering', () => {
    const d = decide(
      event('We already use a competitor and are locked in for a year.'),
      classification('objection', { sentiment: 'negative' }),
    );
    expect(d.action).toBe('alert');
  });

  it('drafts from a template on a meeting request', () => {
    const d = decide(event('Sure, can we do Thursday?'), classification('meeting_request'));
    expect(d.action).toBe('draft');
    expect(d.templateId).toBe('meeting_request');
    expect(d.draft?.body).toContain('Hi Jane,');
    expect(d.draft?.body).toContain('https://cal.com/raz');
    expect(d.draft?.body).not.toMatch(/\{\{/);
  });

  it('alerts when a positive intent has no matching template', () => {
    const d = decide(
      event('How does your onboarding handle SOC2?'),
      classification('info_request', { sentiment: 'positive' }),
    );
    expect(d.action).toBe('alert');
    expect(d.reason).toMatch(/No reply template/);
  });

  it('alerts when confidence is below threshold', () => {
    const d = decide(event('maybe?'), classification('interested', { confidence: 0.4 }));
    expect(d.action).toBe('alert');
    expect(d.reason).toMatch(/confidence/i);
  });

  it('falls back to a friendly greeting when firstName is missing', () => {
    const d = decide(
      normalizeEvent({ lead_email: 'x@y.com', reply_text: 'yes please', reply_subject: 'Hi' }),
      classification('interested'),
    );
    expect(d.action).toBe('draft');
    expect(d.draft?.body).toContain('Hi there,');
  });

  it('alerts instead of drafting when a hard variable is unset', () => {
    setConfigForTesting({ CALENDAR_LINK: '' });
    const d = decide(event('Can we book a call?'), classification('meeting_request'));
    expect(d.action).toBe('alert');
    expect(d.reason).toMatch(/calendarLink/);
    setConfigForTesting({ CALENDAR_LINK: 'https://cal.com/raz' });
  });
});
