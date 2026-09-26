import { createHash } from 'node:crypto';
import type { InstantlyWebhook } from './types.js';

/**
 * We ack webhooks with a 202 before processing, so Instantly retries are rare —
 * but redeliveries and double-fires (two webhook rows pointed at one endpoint)
 * do happen, and processing the same reply twice double-posts to Discord and
 * re-runs the unsubscribe call. This module keeps a small in-memory ledger of
 * recently seen events so duplicates inside the window are dropped.
 *
 * In-memory is a deliberate trade-off: a restart forgets history, but the
 * realistic redelivery window is minutes, and the cost of a false negative is
 * one repeated Discord post, not a lost reply. That holds only while nothing
 * sends email: with auto-send on, a false negative is a second email, and this
 * ledger is not enough (see README, "Before you turn auto-send back on").
 */

const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_ENTRIES = 2000;

/** key -> expiry (epoch ms). Map preserves insertion order for eviction. */
const seen = new Map<string, number>();

/**
 * Identity of one delivery: client slug + lead + Instantly's timestamp, plus a
 * digest of campaign/subject/body so two genuinely different replies from the
 * same lead in the same second never collide.
 */
export function makeEventKey(payload: InstantlyWebhook, slug: string): string {
  const email = (payload.lead_email ?? payload.email ?? '').toLowerCase();
  const body = payload.reply_text ?? payload.reply_text_snippet ?? payload.reply_html ?? '';
  const digest = createHash('sha256')
    .update(`${payload.campaign_id ?? ''}\n${payload.reply_subject ?? ''}\n${body}`)
    .digest('hex')
    .slice(0, 16);
  return `${slug}|${email}|${payload.timestamp ?? ''}|${digest}`;
}

/** Records the key and reports whether it was already seen inside the TTL. */
export function seenBefore(key: string, now: number = Date.now()): boolean {
  const expiry = seen.get(key);
  if (expiry !== undefined && expiry > now) return true;
  if (expiry !== undefined) seen.delete(key); // expired — treat as fresh

  while (seen.size >= MAX_ENTRIES) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }

  seen.set(key, now + TTL_MS);
  return false;
}

/** Test helper — clears the ledger between cases. */
export function resetDedupeForTesting(): void {
  seen.clear();
}
