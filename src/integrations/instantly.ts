import { instantlyKeyFor, type ClientProfile } from '../core/clients.js';
import { getConfig } from '../core/config.js';

/**
 * Thin Instantly API v2 client. Each client profile maps to its own Instantly
 * workspace, so every call takes the workspace API key explicitly.
 *
 * The bot runs in draft-only mode for outbound email: `sendReply` exists but
 * is intentionally never called, so no reply reaches a prospect without a
 * human. Calling it is not a one-line change: the README's "Before you turn
 * auto-send back on" lists what has to exist first.
 * The one automated write is `markLeadUnsubscribed`, which is a compliance
 * action, not an email send.
 */

class InstantlyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'InstantlyError';
  }
}

async function request<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const config = getConfig();

  const response = await fetch(`${config.INSTANTLY_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new InstantlyError(
      `Instantly ${init.method ?? 'GET'} ${path} failed: ${response.status} ${detail.slice(0, 500)}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

export type UnsubscribeResult =
  | { status: 'done' }
  | { status: 'skipped'; why: string }
  | { status: 'failed'; why: string };

/**
 * Marks a lead as opted-out in the client's workspace by adding the email to
 * the workspace block list, so no sequence or future campaign emails them
 * again. Returns a result instead of throwing — the pipeline surfaces
 * failures to Discord so a human can unsubscribe manually.
 */
export async function markLeadUnsubscribed(
  client: ClientProfile,
  leadEmail: string,
): Promise<UnsubscribeResult> {
  if (!leadEmail) return { status: 'skipped', why: 'payload had no lead email' };

  const apiKey = instantlyKeyFor(client);
  if (!apiKey) {
    return {
      status: 'skipped',
      why: client.instantlyApiKeyEnv
        ? `env var ${client.instantlyApiKeyEnv} is not set`
        : 'no instantlyApiKeyEnv configured for this client',
    };
  }

  try {
    await request(apiKey, '/block-lists-entries', {
      method: 'POST',
      body: JSON.stringify({ bl_value: leadEmail }),
    });
    return { status: 'done' };
  } catch (error) {
    // Already blocklisted reads as success, not failure.
    if (error instanceof InstantlyError && error.status === 409) return { status: 'done' };
    const why = error instanceof Error ? error.message : String(error);
    return { status: 'failed', why };
  }
}

export interface SendReplyParams {
  campaignId: string;
  leadEmail: string;
  emailAccount: string;
  subject: string;
  body: string;
  /** Instantly thread/message id to reply within, if known. */
  replyToUuid?: string;
}

/**
 * Sends a reply on an existing thread. NOT called by the webhook handler in
 * draft-only mode — see the module comment before wiring this in.
 */
export async function sendReply(
  client: ClientProfile,
  params: SendReplyParams,
): Promise<{ id?: string }> {
  const apiKey = instantlyKeyFor(client);
  if (!apiKey) throw new InstantlyError(`No Instantly API key configured for ${client.slug}`);

  return request<{ id?: string }>(apiKey, '/emails/reply', {
    method: 'POST',
    body: JSON.stringify({
      campaign_id: params.campaignId,
      lead_email: params.leadEmail,
      eaccount: params.emailAccount,
      subject: params.subject,
      body: { text: params.body },
      reply_to_uuid: params.replyToUuid,
    }),
  });
}

export { InstantlyError };
