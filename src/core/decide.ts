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
  'out_of_office',
  'auto_reply',
]);

/**
 * Routes a classified reply to exactly one of: ignore, draft, alert.
 *
 * The ordering matters. Confidence is checked before template lookup so a
 * shaky "meeting_request" reaches a human rather than auto-drafting; but
 * opt-outs are checked before confidence, because a false-positive alert on an
 * unsubscribe is noise a human can't act on anyway.
 */
export function decide(event: ReplyEvent, classification: Classification): Decision {
  const { CONFIDENCE_THRESHOLD } = getConfig();
  const base = { classification };

  // 1. Bare opt-outs and automated mail — drop.
  if (IGNORED_INTENTS.has(classification.intent) && !classification.isComplexNegative) {
    return {
      ...base,
      action: 'ignore',
      reason: `Intent "${classification.intent}" needs no response.`,
    };
  }

  // 2. A simple decline is also a drop; a *complex* negative is worth reading.
  if (classification.intent === 'not_interested' && !classification.isComplexNegative) {
    return { ...base, action: 'ignore', reason: 'Simple decline with no reason given.' };
  }

  // 3. Negative replies carrying real content always reach a human.
  if (classification.isComplexNegative) {
    return {
      ...base,
      action: 'alert',
      reason: 'Negative reply with substance — a human should read and respond.',
    };
  }

  // 4. Objections are negative-but-engaged: never auto-answered.
  if (classification.intent === 'objection') {
    return { ...base, action: 'alert', reason: 'Objection raised — needs a tailored response.' };
  }

  // 5. Anything the model was unsure about goes to a human.
  if (classification.confidence < CONFIDENCE_THRESHOLD) {
    return {
      ...base,
      action: 'alert',
      reason: `Low classifier confidence (${classification.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}).`,
    };
  }

  if (classification.intent === 'unclear') {
    return { ...base, action: 'alert', reason: 'Reply could not be classified.' };
  }

  // 6. Template lookup. No template means a human handles it — this is the
  //    "positive but not a template" case from the spec.
  const template = findTemplate(classification.intent);
  if (!template) {
    return {
      ...base,
      action: 'alert',
      reason: `No reply template covers intent "${classification.intent}".`,
    };
  }

  try {
    const draft = renderTemplate(template, event);
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
        reason: `${error.message} — escalating instead of sending an incomplete draft.`,
        templateId: template.id,
      };
    }
    throw error;
  }
}
