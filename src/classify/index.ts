import type { Classification, ReplyEvent } from '../core/types.js';
import { classifyWithOpenAI } from './openai.js';
import { classifyByRules } from './rules.js';

/**
 * Rules first (free, instant, only fires on unambiguous opt-outs), model second.
 *
 * If the model call fails we return a low-confidence `unclear` rather than
 * throwing: the decision engine routes that to a Discord alert, so an OpenAI
 * outage degrades to "a human reads it" instead of "the reply is lost".
 */
export async function classifyReply(event: ReplyEvent): Promise<Classification> {
  const ruled = classifyByRules(event.replyText);
  if (ruled) return ruled;

  try {
    return await classifyWithOpenAI(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      intent: 'unclear',
      sentiment: 'neutral',
      confidence: 0,
      reasoning: `Classification failed, escalating to a human: ${message}`,
      isComplexNegative: false,
      notes: '',
      source: 'openai',
    };
  }
}

export { classifyByRules, classifyWithOpenAI };
