import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/core/redact.js';

describe('redactSecrets', () => {
  it('masks a plain secret parameter and keeps the others', () => {
    expect(redactSecrets('/hook?page=2&secret=abc123&x=1', '')).toBe(
      '/hook?page=2&secret=[redacted]&x=1',
    );
  });

  it('masks a parameter whose key is percent-encoded', () => {
    // Fastify decodes "se%63ret" to "secret", so this value authenticates.
    const line = '/hook?se%63ret=abc%2Fdefg';
    expect(redactSecrets(line, '')).toBe('/hook?se%63ret=[redacted]');
  });

  it('masks keys encoded other ways, or in another case', () => {
    expect(redactSecrets('/hook?%73%65%63%72%65%74=v1', '')).not.toContain('v1');
    expect(redactSecrets('/hook?SECRET=v2', '')).not.toContain('v2');
  });

  it('masks a query string inside a longer log line', () => {
    const line = '{"msg":"Route POST:/webhooks/instantly?se%63ret=abc%2Fdefg not found"}';
    expect(redactSecrets(line, '')).toBe(
      '{"msg":"Route POST:/webhooks/instantly?se%63ret=[redacted] not found"}',
    );
  });

  it('masks the configured secret raw, percent-encoded or JSON-escaped', () => {
    const secret = 'a/b"c+d';
    expect(redactSecrets(`raw ${secret} end`, secret)).toBe('raw [redacted] end');
    expect(redactSecrets(`url ${encodeURIComponent(secret)} end`, secret)).toBe(
      'url [redacted] end',
    );
    expect(redactSecrets(JSON.stringify({ msg: `x ${secret} y` }), secret)).toBe(
      '{"msg":"x [redacted] y"}',
    );
  });

  it('leaves text with no secret alone', () => {
    const line = '{"msg":"Reply asks 3 questions? More than 2.","page":"?page=2"}';
    expect(redactSecrets(line, 'not-in-this-line')).toBe(line);
  });
});
