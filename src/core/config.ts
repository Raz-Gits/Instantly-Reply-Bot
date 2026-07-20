import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  /** Shared secret Instantly must send as `X-Webhook-Secret` (or `?secret=`). */
  WEBHOOK_SECRET: z.string().min(8, 'WEBHOOK_SECRET must be at least 8 chars'),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  DISCORD_WEBHOOK_URL: z.string().url(),

  /** Optional until you wire up sending/lead-enrichment. */
  INSTANTLY_API_KEY: z.string().optional(),
  INSTANTLY_API_BASE: z.string().url().default('https://api.instantly.ai/api/v2'),

  /** Below this classifier confidence we alert a human instead of drafting. */
  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),

  /** Your name/company, injected into template variables. */
  SENDER_NAME: z.string().default('the team'),
  SENDER_COMPANY: z.string().default(''),
  CALENDAR_LINK: z.string().default(''),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — lets suites inject a config without touching process.env. */
export function setConfigForTesting(config: Partial<Config>): void {
  cached = { ...(cached ?? ({} as Config)), ...config } as Config;
}
