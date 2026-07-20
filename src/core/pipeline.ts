import { classifyReply } from '../classify/index.js';
import { notifyDiscord } from '../integrations/discord.js';
import { decide } from './decide.js';
import { normalizeEvent } from './normalize.js';
import type { Decision, InstantlyWebhook } from './types.js';

export interface ProcessResult {
  decision: Decision;
  notified: boolean;
}

/**
 * normalize → classify → decide → notify.
 *
 * Kept free of HTTP concerns so it can be driven from tests or a replay script
 * without standing up a server.
 */
export async function processWebhook(payload: InstantlyWebhook): Promise<ProcessResult> {
  const event = normalizeEvent(payload);
  const classification = await classifyReply(event);
  const decision = decide(event, classification);

  const notified =
    decision.action === 'ignore' ? false : await notifyDiscord(event, decision);

  console.log(
    JSON.stringify({
      at: 'pipeline',
      email: event.lead.email,
      campaign: event.campaignName,
      intent: classification.intent,
      confidence: classification.confidence,
      source: classification.source,
      action: decision.action,
      template: decision.templateId ?? null,
      reason: decision.reason,
      notified,
    }),
  );

  return { decision, notified };
}
