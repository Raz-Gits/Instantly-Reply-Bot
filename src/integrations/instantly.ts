import { getConfig } from '../core/config.js';

/**
 * Thin Instantly API v2 client.
 *
 * The bot runs in draft-only mode: nothing here is called on the webhook path.
 * `sendReply` exists so flipping to auto-send later is a one-line change in the
 * handler rather than a new integration — but it is intentionally not wired up,
 * because no reply should reach a prospect without a human approving it.
 */

export interface SendReplyParams {
  campaignId: string;
  leadEmail: string;
  emailAccount: string;
  subject: string;
  body: string;
  /** Instantly thread/message id to reply within, if known. */
  replyToUuid?: string;
}

class InstantlyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'InstantlyError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = getConfig();
  if (!config.INSTANTLY_API_KEY) {
    throw new InstantlyError('INSTANTLY_API_KEY is not configured');
  }

  const response = await fetch(`${config.INSTANTLY_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.INSTANTLY_API_KEY}`,
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

/** Fetches a lead record — useful for filling template variables the webhook omits. */
export async function getLead(email: string): Promise<Record<string, unknown> | null> {
  const result = await request<{ items?: Array<Record<string, unknown>> }>('/leads/list', {
    method: 'POST',
    body: JSON.stringify({ search: email, limit: 1 }),
  });
  return result.items?.[0] ?? null;
}

/**
 * Sends a reply on an existing thread. NOT called by the webhook handler in
 * draft-only mode — see the module comment before wiring this in.
 */
export async function sendReply(params: SendReplyParams): Promise<{ id?: string }> {
  return request<{ id?: string }>('/emails/reply', {
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
