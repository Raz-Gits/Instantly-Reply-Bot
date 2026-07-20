import { getConfig } from '../core/config.js';
import type { Decision, ReplyEvent } from '../core/types.js';

const COLORS = {
  draft: 0x2ecc71, // green — ready to send
  alert: 0xe67e22, // orange — needs a human
  error: 0xe74c3c,
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

function buildEmbed(event: ReplyEvent, decision: Decision) {
  const { classification, draft } = decision;
  const isDraft = decision.action === 'draft';

  const fields: EmbedField[] = [
    { name: 'From', value: truncate(`${event.lead.fullName || '—'}\n${event.lead.email}`, 1024), inline: true },
    { name: 'Company', value: truncate(event.lead.companyName || '—', 1024), inline: true },
    { name: 'Campaign', value: truncate(event.campaignName || '—', 1024), inline: true },
    {
      name: 'Classification',
      value: `\`${classification.intent}\` · ${classification.sentiment} · ${(classification.confidence * 100).toFixed(0)}% · via ${classification.source}`,
    },
    { name: 'Why', value: truncate(classification.reasoning || decision.reason, 1024) },
    { name: 'Their reply', value: codeBlock(event.replyText || '(empty)', 1024) },
  ];

  if (classification.notes) {
    fields.push({ name: 'Notes', value: truncate(classification.notes, 1024) });
  }

  if (isDraft && draft) {
    fields.push({
      name: `Suggested reply — template \`${draft.templateId}\``,
      value: codeBlock(draft.body, 1024),
    });
  } else {
    fields.push({ name: 'Action needed', value: truncate(decision.reason, 1024) });
  }

  if (event.uniboxUrl) {
    fields.push({ name: 'Open in Instantly', value: event.uniboxUrl });
  }

  return {
    title: isDraft ? '✍️ Draft ready to send' : '🔔 Reply needs your attention',
    color: isDraft ? COLORS.draft : COLORS.alert,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: `Instantly Reply Bot · ${event.replySubject || 'no subject'}` },
  };
}

/**
 * Posts to the Discord webhook. Never throws — a Discord outage must not cause
 * us to 500 back to Instantly and trigger a redelivery loop. Returns whether
 * the post succeeded so the caller can log it.
 */
export async function notifyDiscord(event: ReplyEvent, decision: Decision): Promise<boolean> {
  const { DISCORD_WEBHOOK_URL } = getConfig();

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [buildEmbed(event, decision)] }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(
        `[discord] webhook returned ${response.status}: ${truncate(detail, 500)}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error('[discord] failed to post notification:', error);
    return false;
  }
}
