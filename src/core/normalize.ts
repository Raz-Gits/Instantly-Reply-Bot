import type { InstantlyWebhook, Lead, ReplyEvent } from './types.js';

/** Keys we map explicitly; anything else becomes a custom template variable. */
const KNOWN_KEYS = new Set([
  'event_type',
  'timestamp',
  'lead_email',
  'email',
  'firstName',
  'first_name',
  'lastName',
  'last_name',
  'companyName',
  'company_name',
  'personalization',
  'phone',
  'website',
  'reply_text',
  'reply_text_snippet',
  'reply_html',
  'reply_subject',
  'campaign_name',
  'campaign_id',
  'unibox_url',
  'email_account',
]);

function pick(...values: Array<unknown>): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Strips quoted history so the classifier sees only what the person actually
 * wrote. Without this, an "unsubscribe" in our own footer quoted back at us
 * would classify the whole reply as an opt-out.
 */
export function stripQuotedReply(text: string): string {
  if (!text) return '';

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cutoffPatterns: RegExp[] = [
    /^\s*-{2,}\s*Original Message\s*-{2,}/i,
    /^\s*_{5,}\s*$/,
    // Gmail/Outlook attribution lines. Anchored on "wrote:" or a trailing
    // <address> so a reply that merely *starts* with "On Tuesday..." survives.
    /^\s*On\s+.{4,200}\bwrote:\s*$/i,
    /^\s*On\s+.{4,200}<[^>]+@[^>]+>\s*$/i,
    /^\s*From:\s*.+$/i,
    /^\s*Sent from my (iPhone|iPad|Android|Samsung)/i,
    /^\s*>{1,}/,
  ];

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (cutoffPatterns.some((re) => re.test(line))) break;
    // Attribution lines often wrap: "On Mon, Jan 5, 2026 at 4:02 PM\nJohn <j@x.com> wrote:"
    if (/^\s*On\s+\w/i.test(line) && /\bwrote:\s*$/i.test(lines[i + 1] ?? '')) break;
    kept.push(line);
  }

  return kept.join('\n').trim();
}

/** Very small HTML → text fallback for payloads that only carry reply_html. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeLead(payload: InstantlyWebhook): Lead {
  const firstName = pick(payload.firstName, payload.first_name);
  const lastName = pick(payload.lastName, payload.last_name);

  const custom: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (KNOWN_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number') {
      custom[key] = String(value);
    }
  }

  return {
    email: pick(payload.lead_email, payload.email),
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    companyName: pick(payload.companyName, payload.company_name),
    phone: pick(payload.phone),
    website: pick(payload.website),
    custom,
  };
}

export function normalizeEvent(payload: InstantlyWebhook): ReplyEvent {
  const rawBody =
    pick(payload.reply_text, payload.reply_text_snippet) ||
    (payload.reply_html ? htmlToText(payload.reply_html) : '');

  return {
    lead: normalizeLead(payload),
    replyText: stripQuotedReply(rawBody),
    replySubject: pick(payload.reply_subject),
    campaignName: pick(payload.campaign_name),
    campaignId: pick(payload.campaign_id),
    emailAccount: pick(payload.email_account),
    uniboxUrl: pick(payload.unibox_url),
    receivedAt: pick(payload.timestamp) || new Date().toISOString(),
    raw: payload,
  };
}
