import { beforeEach, describe, expect, it } from 'vitest';
import { makeEventKey, resetDedupeForTesting, seenBefore } from '../src/core/dedupe.js';
import type { InstantlyWebhook } from '../src/core/types.js';

const basePayload: InstantlyWebhook = {
  event_type: 'reply_received',
  timestamp: '2026-08-24T15:00:00Z',
  lead_email: 'Jane@Example.com',
  campaign_id: 'cmp_1',
  reply_subject: 'Re: quick question',
  reply_text: 'Sounds interesting, tell me more.',
};

describe('makeEventKey', () => {
  it('is stable for the same delivery and case-insensitive on email', () => {
    const a = makeEventKey(basePayload, 'raz');
    const b = makeEventKey({ ...basePayload, lead_email: 'jane@example.com' }, 'raz');
    expect(a).toBe(b);
  });

  it('differs across clients, leads, times, and reply content', () => {
    const key = makeEventKey(basePayload, 'raz');
    expect(makeEventKey(basePayload, 'acme')).not.toBe(key);
    expect(makeEventKey({ ...basePayload, lead_email: 'other@example.com' }, 'raz')).not.toBe(key);
    expect(makeEventKey({ ...basePayload, timestamp: '2026-08-24T15:00:01Z' }, 'raz')).not.toBe(key);
    expect(makeEventKey({ ...basePayload, reply_text: 'Actually, unsubscribe me.' }, 'raz')).not.toBe(key);
  });

  it('falls back to the reply snippet when reply_text is absent', () => {
    const snippetOnly = { ...basePayload, reply_text: undefined, reply_text_snippet: 'Sounds interesting' };
    expect(makeEventKey(snippetOnly, 'raz')).not.toBe(makeEventKey(basePayload, 'raz'));
  });
});

describe('seenBefore', () => {
  beforeEach(() => {
    resetDedupeForTesting();
  });

  it('reports false the first time and true on redelivery', () => {
    const key = makeEventKey(basePayload, 'raz');
    expect(seenBefore(key)).toBe(false);
    expect(seenBefore(key)).toBe(true);
  });

  it('forgets a key once the TTL has passed', () => {
    const key = makeEventKey(basePayload, 'raz');
    const t0 = 1_000_000;
    expect(seenBefore(key, t0)).toBe(false);
    expect(seenBefore(key, t0 + 60_000)).toBe(true);
    const afterTtl = t0 + 6 * 60 * 60 * 1000 + 1;
    expect(seenBefore(key, afterTtl)).toBe(false);
  });

  it('evicts the oldest entries instead of growing without bound', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 2000; i += 1) {
      seenBefore(`filler-${i}`, t0);
    }
    seenBefore('newest', t0); // pushes the ledger over the cap, evicting filler-0
    expect(seenBefore('filler-0', t0 + 1)).toBe(false); // evicted -> fresh again
    expect(seenBefore('newest', t0 + 1)).toBe(true); // recent entries survive
  });
});
