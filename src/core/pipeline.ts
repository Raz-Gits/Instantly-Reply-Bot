import { classifyReply } from '../classify/index.js';
import { notifyDiscord, notifyDiscordText } from '../integrations/discord.js';
import { markLeadUnsubscribed, type UnsubscribeResult } from '../integrations/instantly.js';
import type { ClientProfile } from './clients.js';
import { decide } from './decide.js';
import { normalizeEvent } from './normalize.js';
import type { Decision, InstantlyWebhook, ReplyEvent } from './types.js';

/** What actually happened to an opt-out, as opposed to what the decision asked for. */
export type UnsubscribeOutcome = 'not_requested' | UnsubscribeResult['status'];

export interface ProcessResult {
  decision: Decision;
  notified: boolean;
  unsubscribe: UnsubscribeOutcome;
}

/**
 * An opt-out the bot could not apply is the one failure that must not stay
 * quiet: the lead can still be emailed until a person blocks them. So both
 * "failed" and "skipped" post to Discord, and if that post fails too, the
 * error log is the last place it shows up.
 */
async function alertUnappliedOptOut(
  event: ReplyEvent,
  client: ClientProfile,
  result: Exclude<UnsubscribeResult, { status: 'done' }>,
): Promise<void> {
  const who = event.lead.email ? `**${event.lead.email}**` : 'a lead whose email was missing from the payload';
  const verb = result.status === 'failed' ? 'Could not auto-unsubscribe' : 'Did not auto-unsubscribe';
  const where = event.uniboxUrl ? ` Open in Instantly: ${event.uniboxUrl}` : '';
  const posted = await notifyDiscordText(
    `⚠️ ${verb} ${who} in ${client.clientName}'s workspace (${result.why}). They asked to opt out, so please add them to the block list by hand.${where}`,
    client,
  );
  if (!posted) {
    console.error(
      `[pipeline] opt-out alert did not post: ${event.lead.email || '(no email)'} in ${client.slug} is still NOT unsubscribed (${result.status}: ${result.why})`,
    );
  }
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

  let unsubscribe: UnsubscribeOutcome = 'not_requested';
  let unsubscribeWhy: string | null = null;
  if (decision.unsubscribeLead && client) {
    const result = await markLeadUnsubscribed(client, event.lead.email);
    unsubscribe = result.status;
    if (result.status !== 'done') {
      unsubscribeWhy = result.why;
      await alertUnappliedOptOut(event, client, result);
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
      unsubscribeRequested: decision.unsubscribeLead,
      unsubscribe,
      unsubscribeWhy,
      reason: decision.reason,
      notified,
    }),
  );

  return { decision, notified, unsubscribe };
}
