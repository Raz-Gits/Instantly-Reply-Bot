import type { Classification } from '../core/types.js';

/**
 * Cheap deterministic pre-filter. Only fires on replies that are *unambiguous*
 * opt-outs — a bare "stop", "unsubscribe", "remove me". Anything with real
 * content falls through to the model, because per the product spec most
 * inbound here is genuine human replies (OOO is filtered upstream by Instantly).
 */

const OPT_OUT_PHRASES = [
  'unsubscribe',
  'unsubscribe me',
  'stop',
  'stop emailing me',
  'stop emailing',
  'remove me',
  'remove me from your list',
  'remove me from this list',
  'remove',
  'take me off your list',
  'take me off this list',
  'opt out',
  'opt me out',
  'no thanks',
  'not interested',
  'no',
  'nope',
  'delete my info',
  'do not contact me',
  "don't contact me",
  'do not email me',
];

/** Longest opt-out phrase is ~30 chars; anything much longer carries content. */
const MAX_TRIVIAL_LENGTH = 60;

function canonicalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ') // strip punctuation & symbols
    .replace(/\s+/g, ' ')
    .trim();
}

const SIGN_OFF_WORDS =
  /[\s,.!-]*\b(thanks|thank you|thx|regards|best regards|best|cheers|sincerely|kind regards)\b[\s,.!-]*$/i;

/** A trailing signature name: "…, John" / "…- Jane Doe". Case-sensitive on purpose. */
const TRAILING_NAME = /[\s,.!-]+[A-Z][a-z]+(\s+[A-Z][a-z]+)?[\s.!]*$/;

/**
 * Peels trailing sign-offs and signature names so "no thanks, John" and
 * "Not interested. Thanks - Jane" still read as trivial opt-outs. Runs on the
 * original casing (so the name heuristic works) and never strips the whole
 * string — if a pass would empty it, we keep what we had.
 */
function stripSignOff(text: string): string {
  let current = text.trim();

  for (let i = 0; i < 3; i++) {
    const next = current.replace(SIGN_OFF_WORDS, '').replace(TRAILING_NAME, '').trim();
    if (!next || next === current) break;
    current = next;
  }

  return current;
}

/**
 * Returns a Classification when the reply is a clear opt-out, otherwise null
 * to defer to the model.
 */
export function classifyByRules(replyText: string): Classification | null {
  const trimmed = replyText.trim();
  if (!trimmed) {
    return {
      intent: 'unclear',
      sentiment: 'neutral',
      confidence: 1,
      reasoning: 'Empty reply body — nothing to classify.',
      isComplexNegative: false,
      flags: [],
      followUpTimeframe: '',
      notes: '',
      source: 'rules',
    };
  }

  if (trimmed.length > MAX_TRIVIAL_LENGTH) return null;

  // Take the first line only; trailing signatures are common even on one-worders.
  const firstLine = trimmed.split('\n')[0] ?? '';
  // stripSignOff before canonicalize — it relies on original casing to spot names.
  const canonical = canonicalize(stripSignOff(firstLine));
  if (!canonical) return null;

  if (OPT_OUT_PHRASES.includes(canonical)) {
    const isBareNo = canonical === 'no' || canonical === 'nope';
    return {
      intent: canonical.includes('interested') || isBareNo ? 'not_interested' : 'unsubscribe',
      sentiment: 'negative',
      confidence: 0.99,
      reasoning: `Reply is exactly the opt-out phrase "${canonical}".`,
      isComplexNegative: false,
      flags: [],
      followUpTimeframe: '',
      notes: '',
      source: 'rules',
    };
  }

  return null;
}
