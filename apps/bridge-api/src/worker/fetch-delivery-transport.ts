import type { DeliveryResponse, DeliveryTransport } from './delivery-worker.js';

export class FetchDeliveryTransport implements DeliveryTransport {
  constructor(private readonly timeoutMs: number) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('delivery timeout must be a positive integer');
    }
  }

  async post(
    url: string,
    rawBody: Buffer,
    headers: Readonly<Record<string, string>>,
  ): Promise<DeliveryResponse> {
    const response = await fetch(url, {
      method: 'POST',
      body: new Uint8Array(rawBody),
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { status: response.status };
  }
}
