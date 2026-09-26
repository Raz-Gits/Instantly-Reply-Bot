/**
 * Keeps the webhook secret out of every log line. It can reach a log two
 * ways: inside a request URL (Instantly may pass it as ?secret=), or inside
 * any text that happens to contain the configured value.
 */

const MASK = '[redacted]';

/** A query string inside a larger text: from "?" to whitespace, quote or "#". */
const QUERY_STRING = /\?[^\s"#]*/g;

/**
 * Decodes a query key the way Fastify's parser does ("+" is a space, then
 * percent-decoding), so "se%63ret" is recognized as "secret".
 */
function decodeKey(raw: string): string {
  const spaced = raw.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced).toLowerCase();
  } catch {
    return spaced.toLowerCase();
  }
}

/** Masks the value of every parameter whose decoded key is "secret". */
function maskQueryString(query: string): string {
  const params = query
    .slice(1)
    .split('&')
    .map((param) => {
      const eq = param.indexOf('=');
      const rawKey = eq === -1 ? param : param.slice(0, eq);
      return decodeKey(rawKey) === 'secret' ? `${rawKey}=${MASK}` : param;
    });
  return `?${params.join('&')}`;
}

/** The spellings of a secret that can show up in a log line. */
function secretForms(secret: string): string[] {
  if (!secret) return [];
  const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  return [...new Set(forms)].filter(Boolean);
}

/**
 * Masks secret query parameters, however their key and value are encoded,
 * and the configured secret itself, raw, percent-encoded or JSON-escaped.
 */
export function redactSecrets(text: string, secret: string): string {
  let masked = text.replace(QUERY_STRING, maskQueryString);
  for (const form of secretForms(secret)) {
    masked = masked.split(form).join(MASK);
  }
  return masked;
}
