/**
 * Replays a reply through the full pipeline from the command line.
 *
 *   npx tsx scripts/replay.ts "Sounds interesting - can we talk Thursday?"
 *   npx tsx scripts/replay.ts --dry "unsubscribe"     # skip the Discord post
 *
 * Requires a populated .env (OPENAI_API_KEY at minimum).
 */
import { classifyReply } from '../src/classify/index.js';
import { decide } from '../src/core/decide.js';
import { normalizeEvent } from '../src/core/normalize.js';
import { notifyDiscord } from '../src/integrations/discord.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const replyText = args.filter((a) => a !== '--dry').join(' ');

if (!replyText) {
  console.error('usage: npx tsx scripts/replay.ts [--dry] "<reply text>"');
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
const decision = decide(event, classification);

console.log('\n--- classification ---');
console.log(`intent      ${classification.intent}`);
console.log(`sentiment   ${classification.sentiment}`);
console.log(`confidence  ${classification.confidence}`);
console.log(`complex neg ${classification.isComplexNegative}`);
console.log(`source      ${classification.source}`);
console.log(`reasoning   ${classification.reasoning}`);
if (classification.notes) console.log(`notes       ${classification.notes}`);

console.log('\n--- decision ---');
console.log(`action      ${decision.action}`);
console.log(`reason      ${decision.reason}`);

if (decision.draft) {
  console.log(`\n--- draft (${decision.draft.templateId}) ---`);
  console.log(`Subject: ${decision.draft.subject}\n`);
  console.log(decision.draft.body);
}

if (!dryRun && decision.action !== 'ignore') {
  const ok = await notifyDiscord(event, decision);
  console.log(`\ndiscord: ${ok ? 'posted' : 'FAILED (see log above)'}`);
} else if (decision.action !== 'ignore') {
  console.log('\ndiscord: skipped (--dry)');
}
