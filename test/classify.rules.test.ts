import { describe, expect, it } from 'vitest';
import { classifyByRules } from '../src/classify/rules.js';
import { normalizeEvent, stripQuotedReply } from '../src/core/normalize.js';

describe('classifyByRules', () => {
  it.each([
    'unsubscribe',
    'STOP',
    'Remove me.',
    'take me off your list',
    'Not interested',
    'no thanks',
    'no thanks, John',
  ])('catches the trivial opt-out %j', (text) => {
    const result = classifyByRules(text);
    expect(result).not.toBeNull();
    expect(result?.sentiment).toBe('negative');
    expect(result?.isComplexNegative).toBe(false);
  });

  it.each([
    'Not interested — we signed with a competitor last month, but try us in Q4.',
    'Remove me, and stop buying lists. This is my third complaint.',
    'No, but can you send pricing anyway?',
  ])('defers substantive negatives to the model: %j', (text) => {
    expect(classifyByRules(text)).toBeNull();
  });

  it('defers anything positive to the model', () => {
    expect(classifyByRules('Sounds interesting, can we chat Thursday?')).toBeNull();
  });

  it('classifies an empty body as unclear without calling the model', () => {
    expect(classifyByRules('   ')?.intent).toBe('unclear');
  });
});

describe('stripQuotedReply', () => {
  it('drops Gmail attribution and quoted history', () => {
    const text = [
      'Not for us right now, thanks.',
      '',
      'On Mon, Jan 5, 2026 at 4:02 PM Raz <raz@acme.com> wrote:',
      '> Hi Jane, wanted to check in...',
      '> Unsubscribe here',
    ].join('\n');
    expect(stripQuotedReply(text)).toBe('Not for us right now, thanks.');
  });

  it('drops a wrapped attribution line', () => {
    const text = ['Sure.', '', 'On Mon, Jan 5, 2026 at 4:02 PM', 'Raz <raz@acme.com> wrote:', '> hi'].join('\n');
    expect(stripQuotedReply(text)).toBe('Sure.');
  });

  it('keeps a reply that merely starts with the word "On"', () => {
    const text = 'On Tuesday we could do 3pm if that works for you.';
    expect(stripQuotedReply(text)).toBe(text);
  });

  it('drops Outlook-style headers', () => {
    const text = 'Interested.\n\nFrom: Raz <raz@acme.com>\nSent: Monday';
    expect(stripQuotedReply(text)).toBe('Interested.');
  });
});

describe('normalizeEvent', () => {
  it('maps both snake_case and camelCase lead fields', () => {
    const e = normalizeEvent({
      lead_email: 'j@corp.com',
      first_name: 'Jane',
      lastName: 'Doe',
      company_name: 'Corp',
      reply_text: 'hi',
    });
    expect(e.lead.fullName).toBe('Jane Doe');
    expect(e.lead.companyName).toBe('Corp');
    expect(e.lead.email).toBe('j@corp.com');
  });

  it('exposes unknown payload keys as custom template variables', () => {
    const e = normalizeEvent({ lead_email: 'j@corp.com', reply_text: 'hi', jobTitle: 'CTO' });
    expect(e.lead.custom.jobTitle).toBe('CTO');
  });

  it('falls back to reply_html when reply_text is absent', () => {
    const e = normalizeEvent({
      lead_email: 'j@corp.com',
      reply_html: '<div>Sounds good<br>Lets talk</div>',
    });
    expect(e.replyText).toBe('Sounds good\nLets talk');
  });
});

describe('stripQuotedReply strips recognized quoted history only', () => {
  it('keeps an ordinary signature, as the README says', () => {
    const text = ['Sounds good, send the link.', '', 'Best,', 'Jane Doe', 'VP Sales, Corp', '555 0100'].join('\n');
    expect(stripQuotedReply(text)).toBe(text);
  });

  it('cuts at a "Sent from my" line and everything after it', () => {
    const text = ['Sure, Thursday works.', '', 'Sent from my iPhone', 'Jane'].join('\n');
    expect(stripQuotedReply(text)).toBe('Sure, Thursday works.');
  });
});
