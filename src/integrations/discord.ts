import type { ClientProfile } from '../core/clients.js';
import { getConfig } from '../core/config.js';
import { log } from '../core/log.js';
import type { Decision, ReplyEvent } from '../core/types.js';

const COLORS = {
  draft: 0x2ecc71, // green — ready to send
  alert: 0xe67e22, // orange — needs a human
} as const;

/** Discord rejects embeds over 4096 chars in a description / 1024 in a field. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function codeBlock(text: string, max: number): string {
  return `\`\`\`\n${truncate(text.replace(/```/g, "'''"), max - 10)}\n\`\`\``;
}

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

function buildEmbed(event: ReplyEvent, decision: Decision, client: ClientProfile | null) {
  const { classification, draft } = decision;
  const isDraft = decision.action === 'draft';

  const fields: EmbedField[] = [
    {
      name: 'Client',
      value: truncate(client ? client.clientName : '⚠️ UNCONFIGURED WEBHOOK', 1024),
      inline: true,
    },
    { name: 'From', value: truncate(`${event.lead.fullName || '—'}\n${event.lead.email}`, 1024), inline: true },
    { name: 'Company', value: truncate(event.lead.companyName || '—', 1024), inline: true },
    {
      name: 'Classification',
      value: `\`${classification.intent}\` · ${classification.sentiment} · ${(classification.confidence * 100).toFixed(0)}% · via ${classification.source}`,
    },
    { name: 'Why', value: truncate(classification.reasoning || decision.reason, 1024) },
    { name: 'Their reply', value: codeBlock(event.replyText || '(empty)', 1024) },
  ];

  if (classification.flags.length > 0) {
    fields.push({ name: 'Flags', value: classification.flags.map((f) => `\`${f}\``).join(' ') });
  }

  if (classification.notes) {
    fields.push({ name: 'Notes', value: truncate(classification.notes, 1024) });
  }

  if (!isDraft) {
    fields.push({ name: 'Action needed', value: truncate(decision.reason, 1024) });
  }

  // A draft, or on an alert the text to send once the action above is done.
  const suggested = isDraft ? draft : decision.suggestedReply;
  if (suggested) {
    fields.push({
      name: `Suggested reply (template \`${suggested.templateId}\`)`,
      value: codeBlock(suggested.body, 1024),
    });
  }

  if (event.uniboxUrl) {
    fields.push({ name: 'Open in Instantly', value: event.uniboxUrl });
  }

  return {
    title: isDraft ? '✍️ Draft ready to send' : '🔔 Reply needs your attention',
    color: isDraft ? COLORS.draft : COLORS.alert,
    fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: `Instantly Reply Bot · ${event.campaignName || 'unknown campaign'} · ${event.replySubject || 'no subject'}`,
    },
  };
}

async function post(webhookUrl: string, payload: unknown): Promise<boolean> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log.error(`[discord] webhook returned ${response.status}: ${truncate(detail, 500)}`);
      return false;
    }
    return true;
  } catch (error) {
    log.error('[discord] failed to post notification:', error);
    return false;
  }
}

/**
 * Posts to the client's sub-channel webhook, falling back to the global
 * channel. Never throws — a Discord outage must not cause us to 500 back to
 * Instantly and trigger a redelivery loop. Returns whether the post succeeded
 * so the caller can log it.
 */
export async function notifyDiscord(
  event: ReplyEvent,
  decision: Decision,
  client: ClientProfile | null,
): Promise<boolean> {
  const url = client?.discordWebhookUrl ?? getConfig().DISCORD_WEBHOOK_URL;
  return post(url, { embeds: [buildEmbed(event, decision, client)] });
}

/** Plain-text operational warning (e.g. "auto-unsubscribe failed, do it manually"). */
export async function notifyDiscordText(
  message: string,
  client: ClientProfile | null,
): Promise<boolean> {
  const url = client?.discordWebhookUrl ?? getConfig().DISCORD_WEBHOOK_URL;
  return post(url, { content: truncate(message, 1900) });
}
