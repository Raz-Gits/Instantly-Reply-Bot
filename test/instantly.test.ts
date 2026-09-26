import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClient, setClientsForTesting, type ClientProfile } from '../src/core/clients.js';
import { setConfigForTesting } from '../src/core/config.js';
import { markLeadUnsubscribed } from '../src/integrations/instantly.js';

// The real module, with fetch stubbed: this checks the request it builds and
// how it reads each response, without reaching Instantly.
const API_BASE = 'https://api.instantly.invalid/api/v2';

const fetchMock = vi.fn();

beforeAll(() => {
  setConfigForTesting({ INSTANTLY_API_BASE: API_BASE });
  setClientsForTesting({
    keyed: {
      clientName: 'Keyed',
      senderName: 'K',
      calendarLink: 'https://cal.com/k',
      instantlyApiKeyEnv: 'INSTANTLY_API_KEY_TEST',
    },
    keyless: {
      clientName: 'Keyless',
      senderName: 'L',
      calendarLink: 'https://cal.com/l',
    },
  });
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('INSTANTLY_API_KEY_TEST', 'test-api-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const keyed = () => getClient('keyed') as ClientProfile;
const keyless = () => getClient('keyless') as ClientProfile;

describe('markLeadUnsubscribed', () => {
  it('skips, without a request, when the payload had no lead email', async () => {
    const result = await markLeadUnsubscribed(keyed(), '');
    expect(result).toEqual({ status: 'skipped', why: 'payload had no lead email' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips, without a request, when the client has no API key configured', async () => {
    const result = await markLeadUnsubscribed(keyless(), 'lead@prospect.example');
    expect(result.status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when the named env var is empty', async () => {
    vi.stubEnv('INSTANTLY_API_KEY_TEST', '');
    const result = await markLeadUnsubscribed(keyed(), 'lead@prospect.example');
    expect(result).toEqual({ status: 'skipped', why: 'env var INSTANTLY_API_KEY_TEST is not set' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds the email to the block list and reports done', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await markLeadUnsubscribed(keyed(), 'lead@prospect.example');

    expect(result).toEqual({ status: 'done' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/block-lists-entries`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ bl_value: 'lead@prospect.example' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-api-key');
  });

  it('reads 409 (already blocked) as done', async () => {
    fetchMock.mockResolvedValue(new Response('already exists', { status: 409 }));
    const result = await markLeadUnsubscribed(keyed(), 'lead@prospect.example');
    expect(result).toEqual({ status: 'done' });
  });

  it('reports failed, with the status, on a server error', async () => {
    fetchMock.mockResolvedValue(new Response('upstream broke', { status: 500 }));
    const result = await markLeadUnsubscribed(keyed(), 'lead@prospect.example');
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.why).toContain('500');
  });

  it('reports failed when the request never completes', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const result = await markLeadUnsubscribed(keyed(), 'lead@prospect.example');
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.why).toContain('network down');
  });
});
