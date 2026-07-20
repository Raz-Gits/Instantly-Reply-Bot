import type { Intent } from '../core/types.js';

export interface Template {
  id: string;
  /** Intents this template answers. One template may cover several. */
  intents: Intent[];
  /** `{{var}}` placeholders are filled from the lead + sender context. */
  subject: string;
  body: string;
  description: string;
}

/**
 * The set of replies we can answer automatically. Anything classified into an
 * intent with no template here escalates to Discord instead — that fallback is
 * the whole point, so removing a template is a safe operation.
 *
 * Placeholders available: firstName, lastName, fullName, companyName, email,
 * website, phone, senderName, senderCompany, calendarLink, plus any custom
 * lead variable from the Instantly payload.
 */
export const TEMPLATES: Template[] = [
  {
    id: 'meeting_request',
    intents: ['meeting_request'],
    description: 'Prospect wants a call or demo — offer the calendar link.',
    subject: 'Re: {{originalSubject}}',
    body: `Hi {{firstName}},

Great to hear from you — happy to set something up.

You can grab whatever time works best for you here: {{calendarLink}}

If none of those slots work, just send over a couple of times that suit you and I'll make one work.

Best,
{{senderName}}`,
  },
  {
    id: 'pricing_request',
    intents: ['pricing_request'],
    description: 'Prospect asked about cost — steer to a short scoping call.',
    subject: 'Re: {{originalSubject}}',
    body: `Hi {{firstName}},

Happy to walk you through pricing. It depends on scope, so rather than guess I'd rather give you real numbers for {{companyName}}.

Do you have 15 minutes this week? Here's my calendar: {{calendarLink}}

If you'd prefer, reply with a rough sense of what you're looking for and I'll send an estimate over email instead.

Best,
{{senderName}}`,
  },
  {
    id: 'interested_generic',
    intents: ['interested'],
    description: 'General positive interest with no specific ask.',
    subject: 'Re: {{originalSubject}}',
    body: `Hi {{firstName}},

Glad this landed at a good time.

The easiest next step is a quick 15-minute call so I can understand what {{companyName}} is working on and show you whether we're actually a fit. You can pick a time here: {{calendarLink}}

Happy to answer anything over email first if you'd rather.

Best,
{{senderName}}`,
  },
  {
    id: 'referral',
    intents: ['referral'],
    description: 'Prospect pointed to someone else — thank and ask for the intro.',
    subject: 'Re: {{originalSubject}}',
    body: `Hi {{firstName}},

Thanks for pointing me in the right direction, I appreciate it.

Would you mind copying them in on this thread, or sending over their email? I'll take it from there and keep you out of it.

Best,
{{senderName}}`,
  },
  {
    id: 'wrong_person',
    intents: ['wrong_person'],
    description: 'Not the right contact and no alternative named — ask who is.',
    subject: 'Re: {{originalSubject}}',
    body: `Hi {{firstName}},

Apologies for the misfire, and thanks for letting me know.

Is there someone at {{companyName}} who'd be the right person for this? Happy to reach out to them directly so this stops landing in your inbox.

Best,
{{senderName}}`,
  },
  {
    id: 'follow_up_later',
    intents: ['not_now_follow_up_later'],
    description: 'Open but wants contact deferred — confirm and back off.',
    subject: 'Re: {{originalSubject}}',
    body: `Hi {{firstName}},

Completely understood, thanks for the straight answer.

I'll follow up further down the line rather than keep pestering you in the meantime. If anything changes on your side before then, just reply here.

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

export function findTemplate(intent: Intent): Template | undefined {
  return BY_INTENT.get(intent);
}
