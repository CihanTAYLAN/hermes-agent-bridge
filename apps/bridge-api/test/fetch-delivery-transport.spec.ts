import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchDeliveryTransport } from '../src/worker/fetch-delivery-transport.js';

describe('FetchDeliveryTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the exact raw body without following redirects or reading response content', async () => {
    const json = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ status: 202, json });
    vi.stubGlobal('fetch', fetchMock);
    const body = Buffer.from('{"event_id":"fixed"}');
    const headers = { 'X-Request-ID': 'fixed:beta' };

    await expect(
      new FetchDeliveryTransport(5_000).post('https://peer.test/webhooks/bridge', body, headers),
    ).resolves.toEqual({ status: 202 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://peer.test/webhooks/bridge',
      expect.objectContaining({
        method: 'POST',
        headers,
        redirect: 'error',
      }),
    );
    expect(Buffer.from(fetchMock.mock.calls[0]?.[1]?.body as Uint8Array)).toEqual(body);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(json).not.toHaveBeenCalled();
  });

  it('requires a positive integer timeout', () => {
    expect(() => new FetchDeliveryTransport(0)).toThrow('timeout');
  });
});
