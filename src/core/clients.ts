import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Multi-client support. Each Instantly workspace/campaign posts to its own
 * webhook URL — /webhooks/instantly/<slug> — and the slug selects a profile
 * from clients.json. The profile carries everything client-specific: whose
 * calendar drafts point at, the pitch/pricing copy, which Discord sub-channel
 * gets the posts, and which env var holds that workspace's Instantly API key.
 *
 * Config sources, in order:
 *   1. CLIENTS_JSON env var (raw JSON string — handy on hosts without a disk)
 *   2. config/clients.json
 *
 * The business-facing text fields (whatWeDo, pricingInfo, differentiator) are
 * optional on purpose: leaving one blank doesn't break the client, it just
 * routes the replies that would need it to Discord instead of auto-drafting.
 */

const TemplateOverrideSchema = z.object({
  subject: z.string().optional(),
  body: z.string().optional(),
});

export const ClientProfileSchema = z.object({
  /** Display name used in Discord embeds and logs. */
  clientName: z.string().min(1),
  /** Name that signs the drafted replies. */
  senderName: z.string().min(1),
  /** The client's own company name (NOT the prospect's). */
  companyName: z.string().default(''),
  /** Booking link — the core CTA of most templates. */
  calendarLink: z.string().url(),
  /** 1-3 sentence description of what the client does, used verbatim in drafts. */
  whatWeDo: z.string().default(''),
  /** Full pricing explanation sentence(s), used verbatim in drafts. */
  pricingInfo: z.string().default(''),
  /** The "here's how we're different" sentence(s) for already-have-a-provider replies. */
  differentiator: z.string().default(''),
  /** Discord sub-channel webhook for this workspace. Falls back to the global one. */
  discordWebhookUrl: z.string().url().optional(),
  /** Name of the env var holding this workspace's Instantly API key. */
  instantlyApiKeyEnv: z.string().optional(),
  /** Template ids this client never auto-drafts (they alert instead). */
  disabledTemplates: z.array(z.string()).default([]),
  /** Per-client copy overrides, keyed by template id. */
  templateOverrides: z.record(z.string(), TemplateOverrideSchema).default({}),
});

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ClientsFileSchema = z.record(
  z.string().regex(SLUG_PATTERN, 'client slugs must be lowercase alphanumeric/hyphen'),
  ClientProfileSchema,
);

export interface ClientProfile extends z.infer<typeof ClientProfileSchema> {
  slug: string;
}

let cached: Map<string, ClientProfile> | undefined;

function loadRaw(): unknown {
  const fromEnv = process.env.CLIENTS_JSON;
  if (fromEnv && fromEnv.trim()) {
    try {
      return JSON.parse(fromEnv);
    } catch (error) {
      throw new Error(`CLIENTS_JSON is not valid JSON: ${(error as Error).message}`);
    }
  }

  const path = resolve(process.cwd(), 'config/clients.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `No client config found. Create config/clients.json (see config/clients.example.json) or set CLIENTS_JSON.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`config/clients.json is not valid JSON: ${(error as Error).message}`);
  }
}

export function loadClients(): Map<string, ClientProfile> {
  if (cached) return cached;

  const parsed = ClientsFileSchema.safeParse(loadRaw());
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid client config:\n${issues}`);
  }

  cached = new Map(
    Object.entries(parsed.data).map(([slug, profile]) => [slug, { ...profile, slug }]),
  );
  return cached;
}

export function getClient(slug: string): ClientProfile | undefined {
  return loadClients().get(slug);
}

/** Test helper — inject profiles without touching the filesystem or env. */
export function setClientsForTesting(
  clients: Record<string, z.input<typeof ClientProfileSchema>> | undefined,
): void {
  if (!clients) {
    cached = undefined;
    return;
  }
  const parsed = ClientsFileSchema.parse(clients);
  cached = new Map(
    Object.entries(parsed).map(([slug, profile]) => [slug, { ...profile, slug }]),
  );
}

/** Resolves the workspace's Instantly API key, if configured. */
export function instantlyKeyFor(client: ClientProfile): string | undefined {
  if (!client.instantlyApiKeyEnv) return undefined;
  const key = process.env[client.instantlyApiKeyEnv];
  return key && key.trim() ? key : undefined;
}
