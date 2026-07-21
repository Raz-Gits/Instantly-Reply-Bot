import { afterEach, describe, expect, it } from 'vitest';
import { setClientsForTesting, ClientProfileSchema } from '../src/core/clients.js';

afterEach(() => setClientsForTesting(undefined));

describe('client config schema', () => {
  it('accepts a minimal profile and fills defaults', () => {
    const parsed = ClientProfileSchema.parse({
      clientName: 'Acme',
      senderName: 'Jane',
      calendarLink: 'https://cal.com/jane',
    });
    expect(parsed.whatWeDo).toBe('');
    expect(parsed.disabledTemplates).toEqual([]);
    expect(parsed.templateOverrides).toEqual({});
  });

  it('rejects a profile without a calendar link', () => {
    expect(() =>
      ClientProfileSchema.parse({ clientName: 'Acme', senderName: 'Jane' }),
    ).toThrow();
  });

  it('rejects a non-URL calendar link', () => {
    expect(() =>
      ClientProfileSchema.parse({
        clientName: 'Acme',
        senderName: 'Jane',
        calendarLink: 'calendly dot com',
      }),
    ).toThrow();
  });

  it('rejects invalid slugs at the file level', () => {
    expect(() =>
      setClientsForTesting({
        'Bad Slug!': {
          clientName: 'X',
          senderName: 'Y',
          calendarLink: 'https://cal.com/x',
        },
      }),
    ).toThrow(/slug/i);
  });
});
