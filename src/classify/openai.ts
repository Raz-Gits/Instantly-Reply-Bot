import OpenAI from 'openai';
import { z } from 'zod';
import { getConfig } from '../core/config.js';
import {
  ESCALATION_FLAGS,
  INTENTS,
  SENTIMENTS,
  type Classification,
  type ReplyEvent,
} from '../core/types.js';

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
  flags: z.array(z.enum(ESCALATION_FLAGS)),
  follow_up_timeframe: z.string(),
  notes: z.string(),
});

const SYSTEM_PROMPT = `You classify replies to cold sales emails. You are the routing layer for an automated reply bot, so precision matters more than charity: a wrong "interested" wastes a human's time, a wrong "unsubscribe" loses a deal.

Return exactly one intent:

- interested — expresses genuine interest or openness ("sure", "sounds interesting", "tell me more", "send me some info") without a specific question.
- meeting_request — wants a call/demo/meeting, asks about availability, or proposes times.
- pricing_request — asks about cost, rates, fees, payment structure, or commitment terms.
- info_request — asks a SIMPLE question about what the company does or offers ("what exactly do you do?", "how does this work?", "what is this about?"). If the question digs into methodology, technology, data, or process details, keep this intent but add the technical_deep_dive flag.
- proof_request — asks for case studies, results, references, client names, or evidence it works.
- how_did_you_find_us — asks how you got their email/contact details, including a simple "is this GDPR compliant?". Do NOT add legal_or_contract for that simple question alone.
- existing_provider — says they already have an agency/vendor for this, handle it internally, or tried something similar before. Use this instead of objection for that specific pushback.
- referral — hands you a DIFFERENT person or team as the better contact ("talk to our CMO, jane@…").
- wrong_person — says they are not the right contact, without naming an alternative.
- not_now_follow_up_later — open in principle but wants contact deferred (busy, next quarter, after a launch).
- objection — engaged but pushing back for a stated reason other than having an existing provider (no budget, skepticism, bad timing framed as a reason).
- not_interested — declines without a reason worth responding to.
- unsubscribe — asks to be removed from the list, or threatens spam reporting.
- out_of_office — automated absence notice.
- auto_reply — other automated mail (bounce, ticket ack, delivery notice).
- unclear — cannot be determined, or the message is empty/garbled.

Escalation flags — include EVERY one that applies; any flag routes the reply to a human instead of an automated draft:

- named_competitor — a specific competitor/vendor is named ("we use Belkins").
- referral_mention — someone referred THEM to us, or they mention a mutual contact ("John at Acme mentioned you"). Direction matters: them pointing us to a colleague is the referral INTENT, not this flag.
- existing_relationship — indicates they know us or we have spoken before.
- legal_or_contract — contracts, lawyers, legal threats, formal compliance demands, or detailed data-protection questions beyond a simple "is this GDPR compliant?".
- negotiation_terms — mentions specific numbers, prices, contract lengths, or terms of their own.
- technical_deep_dive — detailed questions about methodology, technology, tooling, or process.
- press_media — journalism, articles, podcasts, or public coverage.
- sensitive_info — the reply shares confidential business or personal information.

Also set:
- sentiment: positive | neutral | negative — the person's disposition toward us.
- confidence: 0..1. Be honest. Below 0.7 routes to a human instead of an automated draft.
- is_complex_negative: true when the reply is negative AND contains more than a bare refusal — a reason, a question, a complaint, anger, an accusation, or anything a human should read. A bare "no", "not interested", "stop", or "remove me" is NOT complex.
- follow_up_timeframe: ONLY for not_now_follow_up_later — the timing phrase with its preposition, ready to complete the sentence "I'll follow up with you ___" (e.g. "in Q4", "in January", "in a few weeks"). Empty string otherwise or if no timing was given.
- reasoning: one sentence, under 200 characters.
- notes: any concrete detail worth carrying forward (referred name/email, named competitor, specific question asked). Empty string if none.

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
            'flags',
            'follow_up_timeframe',
            'notes',
          ],
          properties: {
            intent: { type: 'string', enum: [...INTENTS] },
            sentiment: { type: 'string', enum: [...SENTIMENTS] },
            confidence: { type: 'number' },
            reasoning: { type: 'string' },
            is_complex_negative: { type: 'boolean' },
            flags: { type: 'array', items: { type: 'string', enum: [...ESCALATION_FLAGS] } },
            follow_up_timeframe: { type: 'string' },
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
    flags: parsed.flags,
    followUpTimeframe: parsed.follow_up_timeframe,
    notes: parsed.notes,
    source: 'openai',
  };
}
