import { signHmacV2 } from '../auth/hmac.js';
import type { BridgeEvent, RecentMessage } from '../domain.js';

export type DeliveryTarget = {
  url: string;
  webhookSecret: string;
};

export type FrozenDeliveryRequest = {
  rawBody: Buffer;
};

export type ClaimedDelivery = {
  id: string;
  leaseToken: string;
  attempt: number;
  event: BridgeEvent;
  target: DeliveryTarget;
  frozenRequest?: FrozenDeliveryRequest;
};

export interface DeliveryStore {
  claim(limit: number, leaseSeconds: number, now: Date): Promise<ClaimedDelivery[]>;
  recentContext(event: BridgeEvent, limit: number): Promise<RecentMessage[]>;
  freezeRequest(
    id: string,
    leaseToken: string,
    request: FrozenDeliveryRequest,
  ): Promise<FrozenDeliveryRequest | null>;
  renewLease(id: string, leaseToken: string, leaseSeconds: number): Promise<boolean>;
  markDelivered(
    id: string,
    leaseToken: string,
    statusCode: number,
    deliveredAt: Date,
  ): Promise<boolean>;
  reschedule(
    id: string,
    leaseToken: string,
    nextAttemptAt: Date,
    error: string,
    statusCode?: number,
  ): Promise<boolean>;
  moveToDeadLetter(
    id: string,
    leaseToken: string,
    error: string,
    statusCode?: number,
  ): Promise<boolean>;
}

export type DeliveryResponse = { status: number };

export interface DeliveryTransport {
  post(
    url: string,
    rawBody: Buffer,
    headers: Readonly<Record<string, string>>,
  ): Promise<DeliveryResponse>;
}

export type DeliveryWorkerOptions = {
  batchSize: number;
  leaseSeconds: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  now: () => Date;
  random: () => number;
};

const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_CONTEXT_MESSAGES = 6;

function trimContext(messages: readonly RecentMessage[]): RecentMessage[] {
  const result = messages.slice(-MAX_CONTEXT_MESSAGES);
  while (result.length > 0 && Buffer.byteLength(JSON.stringify(result)) > MAX_CONTEXT_BYTES) {
    result.shift();
  }
  return result;
}

function backoffMs(attempt: number, options: DeliveryWorkerOptions): number {
  const exponential = options.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const bounded = Math.min(exponential, options.maxDelayMs);
  return Math.floor(bounded * options.random());
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export class DeliveryWorker {
  constructor(
    private readonly store: DeliveryStore,
    private readonly transport: DeliveryTransport,
    private readonly options: DeliveryWorkerOptions,
  ) {}

  async runOnce(): Promise<number> {
    const now = this.options.now();
    const deliveries = await this.store.claim(
      this.options.batchSize,
      this.options.leaseSeconds,
      now,
    );
    const results = await Promise.allSettled(
      deliveries.map(async (delivery) => this.deliver(delivery)),
    );
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('delivery_batch_failed');
    }
    return deliveries.length;
  }

  private async deliver(delivery: ClaimedDelivery): Promise<void> {
    let request = delivery.frozenRequest;
    if (!request) {
      const recent = await this.store.recentContext(delivery.event, MAX_CONTEXT_MESSAGES);
      const outbound: BridgeEvent = {
        ...delivery.event,
        context: { recent_messages: trimContext(recent) },
      };
      const frozen = await this.store.freezeRequest(delivery.id, delivery.leaseToken, {
        rawBody: Buffer.from(JSON.stringify(outbound), 'utf8'),
      });
      if (!frozen) {
        return;
      }
      request = frozen;
    }

    const renewed = await this.store.renewLease(
      delivery.id,
      delivery.leaseToken,
      this.options.leaseSeconds,
    );
    if (!renewed) {
      return;
    }

    const timestamp = Math.floor(this.options.now().getTime() / 1_000).toString();
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-ID': `${delivery.event.event_id}:${delivery.event.target.agent_id}`,
      'X-Webhook-Timestamp': timestamp,
      'X-Webhook-Signature-V2': signHmacV2(
        delivery.target.webhookSecret,
        timestamp,
        request.rawBody,
      ),
    } as const;

    let status: number;
    try {
      ({ status } = await this.transport.post(delivery.target.url, request.rawBody, headers));
    } catch {
      await this.retryOrDeadLetter(delivery, 'network_error');
      return;
    }

    if (status >= 200 && status < 300) {
      await this.store.markDelivered(delivery.id, delivery.leaseToken, status, this.options.now());
      return;
    }
    if (isRetryable(status)) {
      await this.retryOrDeadLetter(delivery, 'retryable_http_error', status);
      return;
    }
    await this.store.moveToDeadLetter(
      delivery.id,
      delivery.leaseToken,
      'permanent_http_error',
      status,
    );
  }

  private async retryOrDeadLetter(
    delivery: ClaimedDelivery,
    error: string,
    statusCode?: number,
  ): Promise<void> {
    if (delivery.attempt >= this.options.maxAttempts) {
      await this.store.moveToDeadLetter(
        delivery.id,
        delivery.leaseToken,
        'retry_exhausted',
        statusCode,
      );
      return;
    }
    const nextAttemptAt = new Date(
      this.options.now().getTime() + backoffMs(delivery.attempt, this.options),
    );
    await this.store.reschedule(delivery.id, delivery.leaseToken, nextAttemptAt, error, statusCode);
  }
}
