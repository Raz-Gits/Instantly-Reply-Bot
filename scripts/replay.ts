/**
 * Replays a reply through the full pipeline from the command line.
 *
 *   npx tsx scripts/replay.ts --client raz "Sounds interesting - can we talk Thursday?"
 *   npx tsx scripts/replay.ts --client acme --dry "unsubscribe"   # skip Discord/Instantly
 *
 * Requires a populated .env (OPENAI_API_KEY at minimum) and config/clients.json.
 */
import { classifyReply } from '../src/classify/index.js';
import { getClient, loadClients } from '../src/core/clients.js';
import { decide } from '../src/core/decide.js';
import { normalizeEvent } from '../src/core/normalize.js';
import { notifyDiscord } from '../src/integrations/discord.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');

const clientFlagIndex = args.indexOf('--client');
const clientSlug = clientFlagIndex >= 0 ? (args[clientFlagIndex + 1] ?? '') : '';
const replyText = args
  .filter((a, i) => a !== '--dry' && a !== '--client' && i !== clientFlagIndex + 1)
  .join(' ');

if (!replyText || !clientSlug) {
  console.error('usage: npx tsx scripts/replay.ts --client <slug> [--dry] "<reply text>"');
  console.error(`configured clients: ${[...loadClients().keys()].join(', ') || '(none)'}`);
  process.exit(1);
}

const client = getClient(clientSlug);
if (!client) {
  console.error(`unknown client "${clientSlug}" — configured: ${[...loadClients().keys()].join(', ')}`);
  process.exit(1);
}

const event = normalizeEvent({
  event_type: 'reply_received',
  lead_email: 'jane.doe@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  companyName: 'Example Corp',
  reply_text: replyText,
  reply_subject: 'Re: quick question about Example Corp',
  campaign_name: 'Replay Test',
  email_account: 'you@yourdomain.com',
});

const classification = await classifyReply(event);
const decision = decide(event, classification, client);

console.log('\n--- classification ---');
console.log(`intent      ${classification.intent}`);
console.log(`sentiment   ${classification.sentiment}`);
console.log(`confidence  ${classification.confidence}`);
console.log(`complex neg ${classification.isComplexNegative}`);
console.log(`flags       ${classification.flags.join(', ') || '(none)'}`);
console.log(`source      ${classification.source}`);
console.log(`reasoning   ${classification.reasoning}`);
if (classification.followUpTimeframe) console.log(`follow-up   ${classification.followUpTimeframe}`);
if (classification.notes) console.log(`notes       ${classification.notes}`);

console.log('\n--- decision ---');
console.log(`client      ${client.clientName}`);
console.log(`action      ${decision.action}`);
console.log(`unsubscribe ${decision.unsubscribeLead}`);
console.log(`reason      ${decision.reason}`);

if (decision.draft) {
  console.log(`\n--- draft (${decision.draft.templateId}) ---`);
  console.log(`Subject: ${decision.draft.subject}\n`);
  console.log(decision.draft.body);
}

if (!dryRun && decision.action !== 'ignore') {
  const ok = await notifyDiscord(event, decision, client);
  console.log(`\ndiscord: ${ok ? 'posted' : 'FAILED (see log above)'}`);
} else if (decision.action !== 'ignore') {
  console.log('\ndiscord: skipped (--dry)');
}
if (decision.unsubscribeLead) {
  console.log('instantly unsubscribe: skipped in replay (webhook pipeline only)');
}
