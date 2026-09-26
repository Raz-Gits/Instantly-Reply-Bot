import { format } from 'node:util';
import { getConfig } from './config.js';
import { redactSecrets } from './redact.js';

/**
 * Application logging outside Fastify's request logger. It writes the same
 * text console would, through the same secret masking as the request logs.
 */

function configuredSecret(): string {
  try {
    return getConfig().WEBHOOK_SECRET ?? '';
  } catch {
    // Config didn't load (a startup error, say): still mask query secrets.
    return '';
  }
}

function masked(args: unknown[]): string {
  return redactSecrets(format(...args), configuredSecret());
}

export const log = {
  info: (...args: unknown[]): void => console.log(masked(args)),
  warn: (...args: unknown[]): void => console.warn(masked(args)),
  error: (...args: unknown[]): void => console.error(masked(args)),
};
