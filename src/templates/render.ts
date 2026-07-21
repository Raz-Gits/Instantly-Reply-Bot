import type { ClientProfile } from '../core/clients.js';
import type { Classification, RenderedDraft, ReplyEvent } from '../core/types.js';
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

export function buildVariables(
  event: ReplyEvent,
  client: ClientProfile,
  classification?: Classification,
): Record<string, string> {
  const { lead } = event;

  return {
    // Custom lead vars first, so an explicit mapping below always wins.
    ...lead.custom,
    firstName: lead.firstName,
    lastName: lead.lastName,
    fullName: lead.fullName,
    /** The PROSPECT's company. The client's own company is {{ourCompanyName}}. */
    companyName: lead.companyName,
    email: lead.email,
    phone: lead.phone,
    website: lead.website,
    originalSubject: event.replySubject.replace(/^(re|fwd):\s*/i, '').trim(),
    campaignName: event.campaignName,
    senderName: client.senderName,
    ourCompanyName: client.companyName,
    clientName: client.clientName,
    calendarLink: client.calendarLink,
    whatWeDo: client.whatWeDo,
    pricingInfo: client.pricingInfo,
    differentiator: client.differentiator,
    followUpTimeframe: classification?.followUpTimeframe ?? '',
  };
}

/**
 * Fallbacks for variables that are frequently blank. A draft reading "Hi ,"
 * is worse than one reading "Hi there," so we soften these rather than
 * failing the render.
 */
const SOFT_FALLBACKS: Record<string, string> = {
  firstName: 'there',
  companyName: 'your team',
  originalSubject: 'your note',
  followUpTimeframe: 'a little further down the line',
};

/**
 * Renders a template for a specific client. Throws MissingVariableError if a
 * hard-required placeholder (one with no soft fallback — e.g. calendarLink,
 * whatWeDo, pricingInfo) resolves empty — the caller escalates to Discord
 * rather than sending a draft with a hole in it. This is also what makes blank
 * profile fields safe: a client without pricingInfo simply has pricing replies
 * escalated instead of auto-drafted.
 */
export function renderTemplate(
  template: Template,
  event: ReplyEvent,
  client: ClientProfile,
  classification?: Classification,
): RenderedDraft {
  const variables = buildVariables(event, client, classification);
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
