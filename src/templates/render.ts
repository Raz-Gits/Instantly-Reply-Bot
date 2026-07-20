import { getConfig } from '../core/config.js';
import type { RenderedDraft, ReplyEvent } from '../core/types.js';
import type { Template } from './registry.js';

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

export class MissingVariableError extends Error {
  constructor(
    readonly templateId: string,
    readonly variables: string[],
  ) {
    super(`Template "${templateId}" is missing values for: ${variables.join(', ')}`);
    this.name = 'MissingVariableError';
  }
}

export function buildVariables(event: ReplyEvent): Record<string, string> {
  const config = getConfig();
  const { lead } = event;

  return {
    // Custom lead vars first, so an explicit mapping below always wins.
    ...lead.custom,
    firstName: lead.firstName,
    lastName: lead.lastName,
    fullName: lead.fullName,
    companyName: lead.companyName,
    email: lead.email,
    phone: lead.phone,
    website: lead.website,
    originalSubject: event.replySubject.replace(/^(re|fwd):\s*/i, '').trim(),
    campaignName: event.campaignName,
    senderName: config.SENDER_NAME,
    senderCompany: config.SENDER_COMPANY,
    calendarLink: config.CALENDAR_LINK,
  };
}

/**
 * Fallbacks for variables that are frequently blank in Instantly payloads.
 * A draft reading "Hi ," is worse than one reading "Hi there," so we soften
 * these rather than failing the render.
 */
const SOFT_FALLBACKS: Record<string, string> = {
  firstName: 'there',
  companyName: 'your team',
  originalSubject: 'your note',
};

/**
 * Renders a template. Throws MissingVariableError if a hard-required
 * placeholder (one with no soft fallback, e.g. calendarLink) is empty — the
 * caller escalates to Discord rather than sending a draft with a literal
 * "{{calendarLink}}" in it.
 */
export function renderTemplate(template: Template, event: ReplyEvent): RenderedDraft {
  const variables = buildVariables(event);
  const missing = new Set<string>();

  const substitute = (text: string): string =>
    text.replace(PLACEHOLDER, (_match, rawName: string) => {
      const name = rawName.trim();
      const value = variables[name];
      if (value && value.trim()) return value.trim();

      const fallback = SOFT_FALLBACKS[name];
      if (fallback) return fallback;

      missing.add(name);
      return '';
    });

  const subject = substitute(template.subject);
  const body = substitute(template.body);

  if (missing.size > 0) {
    throw new MissingVariableError(template.id, [...missing]);
  }

  return { templateId: template.id, subject, body };
}
