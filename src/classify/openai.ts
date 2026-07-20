import OpenAI from 'openai';
import { z } from 'zod';
import { getConfig } from '../core/config.js';
import { INTENTS, SENTIMENTS, type Classification, type ReplyEvent } from '../core/types.js';

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: getConfig().OPENAI_API_KEY });
  return client;
}

/** Test seam — inject a stub so suites never hit the network. */
export function setOpenAIClientForTesting(stub: OpenAI | undefined): void {
  client = stub;
}

const ResponseSchema = z.object({
  intent: z.enum(INTENTS),
  sentiment: z.enum(SENTIMENTS),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  is_complex_negative: z.boolean(),
  notes: z.string(),
});

const SYSTEM_PROMPT = `You classify replies to cold sales emails. You are the routing layer for an automated reply bot, so precision matters more than charity: a wrong "interested" wastes a human's time, a wrong "unsubscribe" loses a deal.

Return exactly one intent:

- interested — expresses genuine interest, wants to learn more, positive but no specific ask.
- meeting_request — wants a call/demo/meeting, or proposes times.
- pricing_request — asks about cost, pricing, plans, or budget.
- info_request — asks a substantive question about the product, process, or company that is not pricing.
- referral — points to a different person or team as the right contact.
- wrong_person — says they are not the right contact, without naming an alternative.
- not_now_follow_up_later — open in principle but wants contact deferred (busy, next quarter, after a launch).
- objection — engaged but pushing back (already have a vendor, no budget, bad timing framed as a reason, skepticism). Use this when there is a stated reason worth a human response.
- not_interested — declines without a reason worth responding to.
- unsubscribe — asks to be removed from the list, or threatens spam reporting / legal action.
- out_of_office — automated absence notice.
- auto_reply — other automated mail (bounce, ticket ack, delivery notice).
- unclear — cannot be determined, or the message is empty/garbled.

Also set:
- sentiment: positive | neutral | negative — the person's disposition toward us.
- confidence: 0..1. Be honest. Below 0.7 routes to a human instead of an automated draft.
- is_complex_negative: true when the reply is negative AND contains more than a bare refusal — a reason, a question, a complaint, an accusation, or anything a human should read. A bare "no", "not interested", "stop", or "remove me" is NOT complex.
- reasoning: one sentence, under 200 characters.
- notes: any concrete detail worth carrying forward (referred name/email, requested timing, named competitor, specific question). Empty string if none.

Judge only the person's own words. Ignore quoted history and signatures.`;

function buildUserPrompt(event: ReplyEvent): string {
  const { lead, replyText, replySubject, campaignName } = event;
  return [
    `Campaign: ${campaignName || '(unknown)'}`,
    `From: ${lead.fullName || '(unknown)'} <${lead.email || 'unknown'}>`,
    `Company: ${lead.companyName || '(unknown)'}`,
    `Subject: ${replySubject || '(none)'}`,
    '',
    'Reply body:',
    '"""',
    replyText || '(empty)',
    '"""',
  ].join('\n');
}

/**
 * Classifies a reply with the model. Throws on API/parse failure — the caller
 * decides the fallback, since silently guessing an intent here would be worse
 * than escalating to a human.
 */
export async function classifyWithOpenAI(event: ReplyEvent): Promise<Classification> {
  const config = getConfig();

  const completion = await getClient().chat.completions.create({
    model: config.OPENAI_MODEL,
    temperature: 0,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'reply_classification',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'intent',
            'sentiment',
            'confidence',
            'reasoning',
            'is_complex_negative',
            'notes',
          ],
          properties: {
            intent: { type: 'string', enum: [...INTENTS] },
            sentiment: { type: 'string', enum: [...SENTIMENTS] },
            confidence: { type: 'number' },
            reasoning: { type: 'string' },
            is_complex_negative: { type: 'boolean' },
            notes: { type: 'string' },
          },
        },
      },
    },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(event) },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty classification response');

  const parsed = ResponseSchema.parse(JSON.parse(content));

  return {
    intent: parsed.intent,
    sentiment: parsed.sentiment,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    isComplexNegative: parsed.is_complex_negative,
    notes: parsed.notes,
    source: 'openai',
  };
}
