import type { ClientProfile } from '../core/clients.js';
import type { Intent } from '../core/types.js';

export interface Template {
  id: string;
  /** Intents this template answers. One template may cover several. */
  intents: Intent[];
  /** `{{var}}` placeholders are filled from the lead + client profile. */
  subject: string;
  body: string;
  description: string;
}

/**
 * Default template set, copy taken from the reply playbook. Client-specific
 * substance (whatWeDo, pricingInfo, differentiator, calendarLink, senderName)
 * comes in through per-client variables, so the copy itself stays shared.
 * Clients can override subject/body per template id, or disable a template
 * entirely, via clients.json.
 *
 * Any intent with no template here escalates to Discord instead — that
 * fallback is the whole point, so removing a template is a safe operation.
 */
export const TEMPLATES: Template[] = [
  {
    id: 'book_call',
    intents: ['interested', 'meeting_request'],
    description: 'Prospect is interested or wants to talk — send the booking link.',
    subject: 'Re: {{originalSubject}}',
    body: `Great, really glad this resonated.

Here is a link to grab a time that works for you: {{calendarLink}}

Looking forward to it.

Best,
{{senderName}}`,
  },
  {
    id: 'what_we_do',
    intents: ['info_request'],
    description: 'Prospect asked what the company does — explain and steer to a call.',
    subject: 'Re: {{originalSubject}}',
    body: `Of course, happy to explain.

{{whatWeDo}}

The easiest way to see if there is a fit is a quick call. Here is my calendar if you want to grab a time: {{calendarLink}}

No commitment, just a conversation.

Best,
{{senderName}}`,
  },
  {
    id: 'pricing',
    intents: ['pricing_request'],
    description: 'Prospect asked about pricing — share the model and offer a call.',
    subject: 'Re: {{originalSubject}}',
    body: `Good question, happy to share.

{{pricingInfo}}

Happy to walk you through the full structure on a call if that helps. Here is my calendar: {{calendarLink}}

Best,
{{senderName}}`,
  },
  {
    id: 'proof',
    intents: ['proof_request'],
    description: 'Prospect asked for case studies or evidence — offer to walk through examples.',
    subject: 'Re: {{originalSubject}}',
    body: `Absolutely, happy to share.

The best way to do that is on a quick call where I can walk you through some specific examples relevant to your industry.

Here is my calendar: {{calendarLink}}

Alternatively I can send over a brief overview by email if you would prefer. Just let me know which works better.

Best,
{{senderName}}`,
  },
  {
    id: 'how_found_you',
    intents: ['how_did_you_find_us'],
    description: 'Prospect asked how we got their details — explain sourcing.',
    subject: 'Re: {{originalSubject}}',
    body: `Your details are publicly available through professional business directories and LinkedIn. We research companies that match the profile of businesses we typically work with and reach out directly.

Happy to answer any other questions — or if you would prefer not to hear from us, just let me know and I will remove you straight away.

Best,
{{senderName}}`,
  },
  {
    id: 'existing_provider',
    intents: ['existing_provider'],
    description: 'Already have an agency / handle it internally — differentiate softly.',
    subject: 'Re: {{originalSubject}}',
    body: `That is completely fair and actually pretty common.

{{differentiator}}

If you ever feel like your current setup is not hitting the numbers you need, happy to show you how we approach it differently. Here is my calendar if that conversation ever makes sense: {{calendarLink}}

No pressure either way.

Best,
{{senderName}}`,
  },
  {
    id: 'follow_up_later',
    intents: ['not_now_follow_up_later'],
    description: 'Open but wants contact deferred — confirm the timeframe and back off.',
    subject: 'Re: {{originalSubject}}',
    body: `Completely understand, timing is everything.

I will make a note to follow up with you {{followUpTimeframe}}. In the meantime feel free to reach out if anything changes sooner.

Best,
{{senderName}}`,
  },
  {
    id: 'wrong_person',
    intents: ['wrong_person'],
    description: 'Not the right contact and no alternative named — ask who is.',
    subject: 'Re: {{originalSubject}}',
    body: `Apologies for the misfire, and thanks for letting me know.

Is there someone at {{companyName}} who would be the right person for this? Happy to reach out to them directly so this stops landing in your inbox.

Best,
{{senderName}}`,
  },
];

const BY_INTENT: Map<Intent, Template> = new Map();
for (const template of TEMPLATES) {
  for (const intent of template.intents) {
    if (!BY_INTENT.has(intent)) BY_INTENT.set(intent, template);
  }
}

/**
 * Resolves the template for an intent under a client's config: undefined when
 * no template exists or the client disabled it; otherwise the default copy
 * with the client's overrides applied.
 */
export function findTemplate(intent: Intent, client: ClientProfile): Template | undefined {
  const base = BY_INTENT.get(intent);
  if (!base) return undefined;
  if (client.disabledTemplates.includes(base.id)) return undefined;

  const override = client.templateOverrides[base.id];
  if (!override) return base;

  return {
    ...base,
    subject: override.subject ?? base.subject,
    body: override.body ?? base.body,
  };
}
