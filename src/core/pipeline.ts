import { classifyReply } from '../classify/index.js';
import { notifyDiscord, notifyDiscordText } from '../integrations/discord.js';
import { markLeadUnsubscribed } from '../integrations/instantly.js';
import type { ClientProfile } from './clients.js';
import { decide } from './decide.js';
import { normalizeEvent } from './normalize.js';
import type { Decision, InstantlyWebhook } from './types.js';

export interface ProcessResult {
  decision: Decision;
  notified: boolean;
}

/**
 * normalize → classify → decide → notify (+ unsubscribe side-effect).
 *
 * `client` is resolved from the webhook URL slug by the server. A null client
 * (unknown slug) still classifies but never drafts — replies must not go out
 * with some other client's calendar link — and alerts to the global channel.
 *
 * Kept free of HTTP concerns so it can be driven from tests or the replay
 * script without standing up a server.
 */
export async function processWebhook(
  payload: InstantlyWebhook,
  client: ClientProfile | null,
  slug?: string,
): Promise<ProcessResult> {
  const event = normalizeEvent(payload);
  const classification = await classifyReply(event);

  const decision: Decision = client
    ? decide(event, classification, client)
    : {
        action: 'alert',
        reason: `Webhook slug "${slug ?? '(none)'}" has no client configured — add it to clients.json.`,
        classification,
        unsubscribeLead: false,
      };

  if (decision.unsubscribeLead && client) {
    const result = await markLeadUnsubscribed(client, event.lead.email);
    if (result.status === 'failed') {
      await notifyDiscordText(
        `⚠️ Could not auto-unsubscribe **${event.lead.email}** in ${client.clientName}'s workspace — please mark them manually. (${result.why})`,
        client,
      );
    } else if (result.status === 'skipped') {
      console.warn(`[instantly] unsubscribe skipped for ${event.lead.email}: ${result.why}`);
    }
  }

  const notified =
    decision.action === 'ignore' ? false : await notifyDiscord(event, decision, client);

  console.log(
    JSON.stringify({
      at: 'pipeline',
      client: client?.slug ?? slug ?? null,
      email: event.lead.email,
      campaign: event.campaignName,
      intent: classification.intent,
      confidence: classification.confidence,
      flags: classification.flags,
      source: classification.source,
      action: decision.action,
      template: decision.templateId ?? null,
      unsubscribed: decision.unsubscribeLead,
      reason: decision.reason,
      notified,
    }),
  );

  return { decision, notified };
}
