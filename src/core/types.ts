import { z } from 'zod';

/**
 * Instantly fires `reply_received` with a fairly loose payload — field names have
 * drifted between campaign versions, and custom lead variables arrive as arbitrary
 * top-level keys. So: validate the handful of fields we actually depend on, keep
 * everything else via passthrough, and normalise downstream.
 */
export const InstantlyWebhookSchema = z
  .object({
    event_type: z.string().optional(),
    timestamp: z.string().optional(),

    // Lead identity
    lead_email: z.string().optional(),
    email: z.string().optional(),
    firstName: z.string().optional(),
    first_name: z.string().optional(),
    lastName: z.string().optional(),
    last_name: z.string().optional(),
    companyName: z.string().optional(),
    company_name: z.string().optional(),
    personalization: z.string().optional(),
    phone: z.string().optional(),
    website: z.string().optional(),

    // Reply content
    reply_text: z.string().optional(),
    reply_text_snippet: z.string().optional(),
    reply_html: z.string().optional(),
    reply_subject: z.string().optional(),

    // Campaign / threading
    campaign_name: z.string().optional(),
    campaign_id: z.string().optional(),
    unibox_url: z.string().optional(),
    email_account: z.string().optional(),
  })
  .passthrough();

export type InstantlyWebhook = z.infer<typeof InstantlyWebhookSchema>;

/** Normalised shape the rest of the app works with. */
export interface Lead {
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  companyName: string;
  phone: string;
  website: string;
  /** Any non-standard keys from the payload, usable as template variables. */
  custom: Record<string, string>;
}

export interface ReplyEvent {
  lead: Lead;
  replyText: string;
  replySubject: string;
  campaignName: string;
  campaignId: string;
  emailAccount: string;
  uniboxUrl: string;
  receivedAt: string;
  raw: InstantlyWebhook;
}

/**
 * Intents are the contract between the classifier and the template registry.
 * Adding a value here means adding a template or an explicit routing rule in
 * decide() — there is no silent third path.
 */
export const INTENTS = [
  'interested',
  'meeting_request',
  'pricing_request',
  'info_request',
  'proof_request',
  'how_did_you_find_us',
  'existing_provider',
  'referral',
  'wrong_person',
  'not_now_follow_up_later',
  'objection',
  'not_interested',
  'unsubscribe',
  'out_of_office',
  'auto_reply',
  'unclear',
] as const;

export type Intent = (typeof INTENTS)[number];

export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

/**
 * Signals that force human handling regardless of intent. These map 1:1 to the
 * playbook's human-intervention triggers that the model can detect (length and
 * question-count are counted deterministically in decide() instead).
 */
export const ESCALATION_FLAGS = [
  'named_competitor',
  'referral_mention',
  'existing_relationship',
  'legal_or_contract',
  'negotiation_terms',
  'technical_deep_dive',
  'press_media',
  'sensitive_info',
] as const;

export type EscalationFlag = (typeof ESCALATION_FLAGS)[number];

export interface Classification {
  intent: Intent;
  sentiment: Sentiment;
  /** 0..1 — below CONFIDENCE_THRESHOLD we escalate rather than auto-draft. */
  confidence: number;
  /** One-line justification, surfaced in Discord so a human can sanity-check. */
  reasoning: string;
  /** True when a negative reply carries more than a bare "no"/"stop". */
  isComplexNegative: boolean;
  /** Any of these present ⇒ the reply always goes to a human. */
  flags: EscalationFlag[];
  /**
   * For not_now_follow_up_later: the timing phrase with preposition, ready to
   * drop into a sentence — "in Q4", "in January", "in a few weeks". Empty
   * when the prospect gave none.
   */
  followUpTimeframe: string;
  /** Free-text detail worth carrying into a template or alert. */
  notes: string;
  source: 'rules' | 'openai';
}

export type ActionKind = 'ignore' | 'draft' | 'alert';

export interface Decision {
  action: ActionKind;
  reason: string;
  classification: Classification;
  /** True when the lead should be marked unsubscribed in Instantly. */
  unsubscribeLead: boolean;
  templateId?: string;
  /** Set only when action is "draft". */
  draft?: RenderedDraft;
  /**
   * On an alert: text a person can send after doing what the alert asks.
   * Kept apart from `draft` so nothing that acts on drafts can pick it up.
   */
  suggestedReply?: RenderedDraft;
}

export interface RenderedDraft {
  templateId: string;
  subject: string;
  body: string;
}
