import { beforeAll, describe, expect, it } from 'vitest';
import { setClientsForTesting, type ClientProfile } from '../src/core/clients.js';
import { setConfigForTesting } from '../src/core/config.js';
import { decide, findOptOutLanguage } from '../src/core/decide.js';
import { normalizeEvent } from '../src/core/normalize.js';
import { getClient } from '../src/core/clients.js';
import type { Classification, EscalationFlag, Intent, Sentiment } from '../src/core/types.js';

beforeAll(() => {
  setConfigForTesting({ CONFIDENCE_THRESHOLD: 0.7 });
  setClientsForTesting({
    acme: {
      clientName: 'Acme Corp',
      senderName: 'Jane',
      companyName: 'Acme Corp',
      calendarLink: 'https://calendly.com/jane-acme/intro',
      whatWeDo: 'Acme builds invoicing tools for freight brokers.',
      pricingInfo: 'You only pay per qualified meeting delivered.',
      differentiator: 'Our model is pay-per-meeting with no retainer.',
    },
    // A sparse client: no pricing text, book_call disabled, custom copy for what_we_do.
    sparse: {
      clientName: 'Sparse LLC',
      senderName: 'Sam',
      calendarLink: 'https://cal.com/sam',
      whatWeDo: 'Sparse does things.',
      disabledTemplates: ['book_call'],
      templateOverrides: {
        what_we_do: { body: 'CUSTOM COPY {{calendarLink}} - {{senderName}}' },
      },
    },
  });
});

const acme = () => getClient('acme') as ClientProfile;
const sparse = () => getClient('sparse') as ClientProfile;

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

function classification(intent: Intent, opts: Partial<Classification> = {}): Classification {
  return {
    intent,
    sentiment: (opts.sentiment ?? 'neutral') as Sentiment,
    confidence: opts.confidence ?? 0.95,
    reasoning: opts.reasoning ?? 'test',
    isComplexNegative: opts.isComplexNegative ?? false,
    flags: opts.flags ?? [],
    followUpTimeframe: opts.followUpTimeframe ?? '',
    notes: opts.notes ?? '',
    source: opts.source ?? 'openai',
  };
}

describe('decide — ignore & unsubscribe', () => {
  it('ignores bare unsubscribes and marks the lead for unsubscription', () => {
    const d = decide(event('unsubscribe'), classification('unsubscribe'), acme());
    expect(d.action).toBe('ignore');
    expect(d.unsubscribeLead).toBe(true);
  });

  it('ignores simple declines and also marks them for unsubscription', () => {
    const d = decide(event('not interested'), classification('not_interested'), acme());
    expect(d.action).toBe('ignore');
    expect(d.unsubscribeLead).toBe(true);
  });

  it('ignores OOO/auto-replies without unsubscribing', () => {
    const d = decide(event('OOO until Monday'), classification('out_of_office'), acme());
    expect(d.action).toBe('ignore');
    expect(d.unsubscribeLead).toBe(false);
  });

  it('alerts on a complex negative but still unsubscribes an angry opt-out', () => {
    const d = decide(
      event('Remove me. Third time you people have emailed me. Unacceptable.'),
      classification('unsubscribe', { isComplexNegative: true, sentiment: 'negative' }),
      acme(),
    );
    expect(d.action).toBe('alert');
    expect(d.unsubscribeLead).toBe(true);
  });
});

describe('decide — deterministic playbook guards', () => {
  it('alerts on replies over 150 words even when intent is draftable', () => {
    const long = Array(160).fill('word').join(' ');
    const d = decide(event(long), classification('interested'), acme());
    expect(d.action).toBe('alert');
    expect(d.reason).toMatch(/long/i);
  });

  it('alerts on more than 2 questions', () => {
    const d = decide(
      event('What do you do? How much is it? Who have you worked with?'),
      classification('info_request'),
      acme(),
    );
    expect(d.action).toBe('alert');
    expect(d.reason).toMatch(/questions/i);
  });

  it('counts "??" as one question, not two', () => {
    const d = decide(event('Really?? How does it work?'), classification('info_request'), acme());
    expect(d.action).toBe('draft');
  });
});

describe('decide — escalation flags & always-alert intents', () => {
  it.each<EscalationFlag>([
    'named_competitor',
    'referral_mention',
    'existing_relationship',
    'legal_or_contract',
    'negotiation_terms',
    'technical_deep_dive',
    'press_media',
    'sensitive_info',
  ])('flag %s forces an alert even on a positive intent', (flag) => {
    const d = decide(event('sounds good'), classification('interested', { flags: [flag] }), acme());
    expect(d.action).toBe('alert');
    expect(d.reason).toContain(flag);
  });

  it('alerts on referrals in both directions (no auto-draft)', () => {
    const d = decide(
      event('Talk to our CMO, jane@corp.com'),
      classification('referral', { notes: 'CMO jane@corp.com' }),
      acme(),
    );
    expect(d.action).toBe('alert');
  });

  it('alerts on objections', () => {
    const d = decide(
      event('No budget this year.'),
      classification('objection', { sentiment: 'negative' }),
      acme(),
    );
    expect(d.action).toBe('alert');
  });

  it('alerts when confidence is below threshold', () => {
    const d = decide(event('maybe?'), classification('interested', { confidence: 0.4 }), acme());
    expect(d.action).toBe('alert');
    expect(d.reason).toMatch(/confidence/i);
  });
});

describe('decide — drafting', () => {
  it('drafts book_call for interested and meeting_request', () => {
    for (const intent of ['interested', 'meeting_request'] as const) {
      const d = decide(event('Sure, sounds good'), classification(intent), acme());
      expect(d.action).toBe('draft');
      expect(d.templateId).toBe('book_call');
      expect(d.draft?.body).toContain('https://calendly.com/jane-acme/intro');
      expect(d.draft?.body).toContain('Jane');
      expect(d.draft?.body).not.toMatch(/\{\{/);
    }
  });

  it('drafts what_we_do with the client pitch for info requests', () => {
    const d = decide(event('What exactly do you do?'), classification('info_request'), acme());
    expect(d.action).toBe('draft');
    expect(d.draft?.body).toContain('Acme builds invoicing tools');
  });

  it('drafts pricing with the client pricing text', () => {
    const d = decide(event('How much does it cost?'), classification('pricing_request'), acme());
    expect(d.action).toBe('draft');
    expect(d.draft?.body).toContain('pay per qualified meeting');
  });

  it('drafts existing_provider with the differentiator when no competitor is named', () => {
    const d = decide(
      event('We already have an agency for this.'),
      classification('existing_provider'),
      acme(),
    );
    expect(d.action).toBe('draft');
    expect(d.draft?.body).toContain('pay-per-meeting');
  });

  it('alerts instead when a competitor is named on existing_provider', () => {
    const d = decide(
      event('We already use Belkins.'),
      classification('existing_provider', { flags: ['named_competitor'] }),
      acme(),
    );
    expect(d.action).toBe('alert');
  });

  it('alerts on follow-up-later, since nothing schedules the follow-up it promises', () => {
    const d = decide(
      event('Try me again in Q4.'),
      classification('not_now_follow_up_later', { followUpTimeframe: 'in Q4' }),
      acme(),
    );
    expect(d.action).toBe('alert');
    expect(d.draft).toBeUndefined();
    expect(d.reason).toMatch(/set a reminder/i);
    expect(d.reason).toContain('in Q4');
    expect(d.templateId).toBe('follow_up_later');
  });

  it('puts the follow-up timeframe into the suggested reply', () => {
    const d = decide(
      event('Try me again in Q4.'),
      classification('not_now_follow_up_later', { followUpTimeframe: 'in Q4' }),
      acme(),
    );
    expect(d.suggestedReply?.body).toContain('follow up with you in Q4');
    expect(d.suggestedReply?.body).not.toMatch(/\{\{/);
  });

  it('falls back to a soft phrase when no timeframe was given', () => {
    const d = decide(
      event('Not right now, busy.'),
      classification('not_now_follow_up_later'),
      acme(),
    );
    expect(d.action).toBe('alert');
    expect(d.suggestedReply?.body).toContain('a little further down the line');
  });

  it('still lets a flag on a follow-up-later reply win, with its own reason', () => {
    const d = decide(
      event('Ask me again in Q4, we just signed with Belkins.'),
      classification('not_now_follow_up_later', { flags: ['named_competitor'] }),
      acme(),
    );
    expect(d.action).toBe('alert');
    expect(d.reason).toContain('named_competitor');
  });

  it('falls back to "Hi there" style greeting when firstName is missing', () => {
    const d = decide(
      normalizeEvent({ lead_email: 'x@y.com', reply_text: 'what do you guys do', reply_subject: 'Hi' }),
      classification('info_request'),
      acme(),
    );
    expect(d.action).toBe('draft');
  });
});

describe('decide — per-client config', () => {
  it('alerts when the client left a needed profile field blank', () => {
    const d = decide(event('How much?'), classification('pricing_request'), sparse());
    expect(d.action).toBe('alert');
    expect(d.reason).toMatch(/pricingInfo/);
  });

  it('alerts when the client disabled the matching template', () => {
    const d = decide(event('sure!'), classification('interested'), sparse());
    expect(d.action).toBe('alert');
    expect(d.reason).toMatch(/No reply template/);
  });

  it('uses per-client template override copy', () => {
    const d = decide(event('what do you do?'), classification('info_request'), sparse());
    expect(d.action).toBe('draft');
    expect(d.draft?.body).toBe('CUSTOM COPY https://cal.com/sam - Sam');
  });

  it('alerts on intents with no template (proof stays covered, unclear does not)', () => {
    const d = decide(event('hmm'), classification('unclear'), acme());
    expect(d.action).toBe('alert');
  });
});

describe('decide: opt-out wording never depends on the model', () => {
  it('alerts on "Please stop contacting our company" even when the model says interested at 0.99', () => {
    const d = decide(
      event('Please stop contacting our company.'),
      classification('interested', { confidence: 0.99, sentiment: 'positive' }),
      acme(),
    );
    expect(d.action).toBe('alert');
    expect(d.reason).toMatch(/opt-out language detected/i);
    expect(d.draft).toBeUndefined();
    // A pattern alone never unsubscribes; a person decides.
    expect(d.unsubscribeLead).toBe(false);
  });

  it.each([
    'Remove us from your list please.',
    'How do I unsubscribe from these?',
    'Do not contact me again.',
    'Don’t email me about this.',
    'Take me off this sequence, thanks.',
    'Please opt me out.',
    'I would like to opt-out.',
    'STOP EMAILING ME',
  ])('never drafts %j, whatever the classification', (text) => {
    const d = decide(event(text), classification('interested', { confidence: 0.99 }), acme());
    expect(d.action).toBe('alert');
    expect(d.unsubscribeLead).toBe(false);
  });

  it('does not let an out-of-office reading silently drop an opt-out', () => {
    const d = decide(
      event('I am out of the office until Monday. Also, please stop emailing me.'),
      classification('out_of_office'),
      acme(),
    );
    expect(d.action).toBe('alert');
  });

  it('leaves the opt-out path unchanged when the model also reads it as an opt-out', () => {
    const d = decide(
      event('Please stop contacting our company.'),
      classification('unsubscribe', { sentiment: 'negative' }),
      acme(),
    );
    expect(d.action).toBe('ignore');
    expect(d.unsubscribeLead).toBe(true);
  });

  it('still drafts a normal positive reply', () => {
    const d = decide(
      event('Sounds good, happy to chat next week.'),
      classification('interested', { sentiment: 'positive' }),
      acme(),
    );
    expect(d.action).toBe('draft');
  });

  it('does not match look-alike words', () => {
    expect(findOptOutLanguage('We adopted a new CRM, but sure, send the link.')).toBeNull();
    expect(findOptOutLanguage('Could not stop thinking about your email. Let us talk.')).toBeNull();
  });
});

describe('decide: negated "stop" wording is not an opt-out', () => {
  it.each([
    "Please don't stop emailing me, this is useful.",
    'Do not stop sending updates.',
    'Please don’t stop emailing me.',
    'Dont stop sending these, sounds good.',
    'Never stop writing like this. Sounds good.',
  ])('drafts %j as before', (text) => {
    expect(findOptOutLanguage(text)).toBeNull();
    const d = decide(event(text), classification('interested', { sentiment: 'positive' }), acme());
    expect(d.action).toBe('draft');
  });

  it.each([
    'Please stop emailing me.',
    'Stop sending these.',
    // A negation elsewhere doesn't cancel a plain "stop" later on.
    "Don't stop emailing me. Just kidding, stop emailing me.",
    // Not right before "stop", so it stays ambiguous and alerts.
    "Please don't ever stop emailing me.",
  ])('still alerts on %j', (text) => {
    const d = decide(event(text), classification('interested', { confidence: 0.99 }), acme());
    expect(d.action).toBe('alert');
    expect(d.reason).toMatch(/opt-out language detected/i);
  });
});
