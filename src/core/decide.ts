import type { ClientProfile } from './clients.js';
import { getConfig } from './config.js';
import { findTemplate } from '../templates/registry.js';
import { MissingVariableError, renderTemplate } from '../templates/render.js';
import type { Classification, Decision, Intent, ReplyEvent } from './types.js';

/**
 * Intents we deliberately drop on the floor: nothing for a human to do and
 * nothing to reply to. Everything not listed here either gets a template draft
 * or escalates — there is no silent third path.
 */
const IGNORED_INTENTS: ReadonlySet<Intent> = new Set([
  'unsubscribe',
  'not_interested',
  'out_of_office',
  'auto_reply',
]);

/** Intents that mark the lead unsubscribed in Instantly (playbook Scenario 4). */
const UNSUBSCRIBE_INTENTS: ReadonlySet<Intent> = new Set(['unsubscribe', 'not_interested']);

/** Intents that always go to a human even though they carry no flag. */
const ALWAYS_ALERT_INTENTS: ReadonlySet<Intent> = new Set(['referral', 'objection', 'unclear']);

/** Playbook trigger #1: long replies always get human eyes. */
const MAX_AUTO_WORDS = 150;
const MAX_AUTO_CHARS = 900;
/** Playbook trigger #8: more than 2 distinct questions. */
const MAX_AUTO_QUESTIONS = 2;

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Counts question clusters, so "??" reads as one question, not two. */
function countQuestions(text: string): number {
  return (text.match(/\?+/g) ?? []).length;
}

/**
 * Routes a classified reply to exactly one of: ignore, draft, alert.
 *
 * The ordering matters. Ignores come first so a long OOO doesn't trip the
 * length guard; the deterministic guards come before any drafting so no reply
 * over the playbook limits is ever auto-answered; flags and confidence come
 * before template lookup so a shaky match reaches a human.
 */
export function decide(
  event: ReplyEvent,
  classification: Classification,
  client: ClientProfile,
): Decision {
  const { CONFIDENCE_THRESHOLD } = getConfig();
  const unsubscribeLead = UNSUBSCRIBE_INTENTS.has(classification.intent);
  const base = { classification, unsubscribeLead };

  // 1. Bare opt-outs, simple declines, and automated mail — drop the reply.
  //    (unsubscribeLead still marks the lead in Instantly where applicable.)
  if (IGNORED_INTENTS.has(classification.intent) && !classification.isComplexNegative) {
    return {
      ...base,
      action: 'ignore',
      reason: `Intent "${classification.intent}" needs no reply.`,
    };
  }

  // 2. Negative replies carrying real content always reach a human.
  if (classification.isComplexNegative) {
    return {
      ...base,
      action: 'alert',
      reason: 'Negative reply with substance — a human should read and respond.',
    };
  }

  // 3. Deterministic playbook guards: length and question count.
  const words = countWords(event.replyText);
  if (words > MAX_AUTO_WORDS || event.replyText.length > MAX_AUTO_CHARS) {
    return {
      ...base,
      action: 'alert',
      reason: `Reply is long (${words} words, ${event.replyText.length} chars) — human review per playbook.`,
    };
  }
  const questions = countQuestions(event.replyText);
  if (questions > MAX_AUTO_QUESTIONS) {
    return {
      ...base,
      action: 'alert',
      reason: `Reply asks ${questions} questions — more than ${MAX_AUTO_QUESTIONS}, human review per playbook.`,
    };
  }

  // 4. Any escalation flag forces human handling regardless of intent.
  if (classification.flags.length > 0) {
    return {
      ...base,
      action: 'alert',
      reason: `Escalation flag(s): ${classification.flags.join(', ')}.`,
    };
  }

  // 5. Intents that are never auto-answered.
  if (ALWAYS_ALERT_INTENTS.has(classification.intent)) {
    const reasons: Partial<Record<Intent, string>> = {
      referral: 'Referral — handle personally rather than with a canned reply.',
      objection: 'Objection raised — needs a tailored response.',
      unclear: 'Reply could not be classified.',
    };
    return { ...base, action: 'alert', reason: reasons[classification.intent] ?? 'Needs a human.' };
  }

  // 6. Anything the model was unsure about goes to a human.
  if (classification.confidence < CONFIDENCE_THRESHOLD) {
    return {
      ...base,
      action: 'alert',
      reason: `Low classifier confidence (${classification.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}).`,
    };
  }

  // 7. Template lookup under this client's config (overrides + disabled list).
  //    No template means a human handles it — the "positive but not a
  //    template" case, and the designed fallback for new intents.
  const template = findTemplate(classification.intent, client);
  if (!template) {
    return {
      ...base,
      action: 'alert',
      reason: `No reply template covers intent "${classification.intent}" for ${client.clientName}.`,
    };
  }

  try {
    const draft = renderTemplate(template, event, client, classification);
    return {
      ...base,
      action: 'draft',
      reason: `Matched template "${template.id}".`,
      templateId: template.id,
      draft,
    };
  } catch (error) {
    if (error instanceof MissingVariableError) {
      return {
        ...base,
        action: 'alert',
        reason: `${error.message} — fill it in clients.json or handle manually.`,
        templateId: template.id,
      };
    }
    throw error;
  }
}
