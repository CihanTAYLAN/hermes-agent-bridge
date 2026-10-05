import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, RecentMessage } from '../src/domain.js';
import {
  type ClaimedDelivery,
  type DeliveryStore,
  type DeliveryTransport,
  DeliveryWorker,
  type FrozenDeliveryRequest,
} from '../src/worker/delivery-worker.js';

const event = (text = 'hello from alpha'): BridgeEvent => ({
  schema_version: 1,
  event_type: 'hermes.agent.message',
  event_id: '4d594ab2-93f8-48a0-8938-c5b8bd507a8b',
  occurred_at: '2026-07-18T00:00:00.000Z',
  delivery_semantics: 'generated',
  source: {
    agent_id: 'alpha',
    instance_id: 'alpha-prod',
    platform: 'telegram',
    chat_id: '-5483781017',
    thread_id: null,
    session_id: 'telegram:-5483781017',
  },
  target: { agent_id: 'beta' },
  conversation: {
    channel_key: 'telegram:-5483781017',
    mode: 'observe',
    root_event_id: '4d594ab2-93f8-48a0-8938-c5b8bd507a8b',
    causation_id: null,
    hop: 0,
  },
  message: { text, trigger_text: '@beta', format: 'telegram-markdown' },
  context: { recent_messages: [] },
});

class FakeStore implements DeliveryStore {
  delivered: Array<{ id: string; statusCode: number }> = [];
  retried: Array<{ id: string; nextAttemptAt: Date; error: string; statusCode?: number }> = [];
  dead: Array<{ id: string; error: string; statusCode?: number }> = [];
  frozen: FrozenDeliveryRequest[] = [];
  renewed: Array<{ id: string; leaseToken: string; leaseSeconds: number }> = [];

  constructor(
    private readonly deliveries: ClaimedDelivery[],
    readonly context: RecentMessage[] = [],
    private readonly renewalSucceeds = true,
  ) {}

  async claim(): Promise<ClaimedDelivery[]> {
    return this.deliveries.splice(0);
  }

  async recentContext(): Promise<RecentMessage[]> {
    return this.context;
  }

  async freezeRequest(
    _id: string,
    _leaseToken: string,
    request: FrozenDeliveryRequest,
  ): Promise<FrozenDeliveryRequest> {
    this.frozen.push(request);
    return request;
  }

  async renewLease(id: string, leaseToken: string, leaseSeconds: number): Promise<boolean> {
    this.renewed.push({ id, leaseToken, leaseSeconds });
    return this.renewalSucceeds;
  }

  async markDelivered(id: string, _leaseToken: string, statusCode: number): Promise<boolean> {
    this.delivered.push({ id, statusCode });
    return true;
  }

  async reschedule(
    id: string,
    _leaseToken: string,
    nextAttemptAt: Date,
    error: string,
    statusCode?: number,
  ): Promise<boolean> {
    this.retried.push({
      id,
      nextAttemptAt,
      error,
      ...(statusCode === undefined ? {} : { statusCode }),
    });
    return true;
  }

  async moveToDeadLetter(
    id: string,
    _leaseToken: string,
    error: string,
    statusCode?: number,
  ): Promise<boolean> {
    this.dead.push({ id, error, ...(statusCode === undefined ? {} : { statusCode }) });
    return true;
  }
}

const claimed = (attempt = 1, frozenRequest?: FrozenDeliveryRequest): ClaimedDelivery => ({
  id: 'delivery-1',
  leaseToken: `lease-${attempt}`,
  attempt,
  event: event(),
  target: {
    url: 'http://beta.test/webhooks/peer-alpha',
    webhookSecret: 'target-secret',
  },
  ...(frozenRequest ? { frozenRequest } : {}),
});

const transport = (status: number): DeliveryTransport => ({
  post: vi.fn().mockResolvedValue({ status }),
});

const worker = (
  store: DeliveryStore,
  client: DeliveryTransport,
  overrides: Partial<ConstructorParameters<typeof DeliveryWorker>[2]> = {},
) =>
  new DeliveryWorker(store, client, {
    batchSize: 10,
    leaseSeconds: 30,
    maxAttempts: 4,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    now: () => new Date('2026-07-18T00:00:10.000Z'),
    random: () => 0.5,
    ...overrides,
  });

describe('DeliveryWorker', () => {
  it('signs the exact raw body, keeps a stable request id, and marks 2xx delivered', async () => {
    const context = Array.from({ length: 8 }, (_, index) => ({
      agent_id: index % 2 === 0 ? 'alpha' : 'beta',
      mode: 'observe' as const,
      text: `message-${index}`,
      occurred_at: `2026-07-17T23:5${index}:00.000Z`,
    }));
    const store = new FakeStore([claimed()], context);
    const client = transport(202);

    await worker(store, client).runOnce();

    expect(store.delivered).toEqual([{ id: 'delivery-1', statusCode: 202 }]);
    expect(store.retried).toEqual([]);
    expect(store.dead).toEqual([]);
    expect(client.post).toHaveBeenCalledOnce();
    const [url, rawBody, headers] = vi.mocked(client.post).mock.calls[0] ?? [];
    expect(url).toBe('http://beta.test/webhooks/peer-alpha');
    expect(headers?.['X-Request-ID']).toBe(`${event().event_id}:beta`);
    expect(headers?.['X-Webhook-Timestamp']).toBe('1784332810');
    const expected = createHmac('sha256', 'target-secret')
      .update(`${headers?.['X-Webhook-Timestamp']}.`)
      .update(rawBody ?? Buffer.alloc(0))
      .digest('hex');
    expect(headers?.['X-Webhook-Signature-V2']).toBe(expected);
    const sent = JSON.parse((rawBody ?? Buffer.alloc(0)).toString('utf8')) as BridgeEvent;
    expect(sent.context.recent_messages).toEqual(context.slice(-6));
  });

  it.each([429, 500, 503])('reschedules retryable HTTP %i with bounded backoff', async (status) => {
    const store = new FakeStore([claimed(2)]);

    await worker(store, transport(status)).runOnce();

    expect(store.retried).toHaveLength(1);
    expect(store.retried[0]?.statusCode).toBe(status);
    expect(store.retried[0]?.nextAttemptAt.toISOString()).toBe('2026-07-18T00:00:11.000Z');
    expect(store.dead).toEqual([]);
  });

  it('reschedules network failures without leaking the response body', async () => {
    const store = new FakeStore([claimed()]);
    const client: DeliveryTransport = {
      post: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED secret=do-not-log')),
    };

    await worker(store, client).runOnce();

    expect(store.retried).toHaveLength(1);
    expect(store.retried[0]?.error).toBe('network_error');
  });

  it('moves permanent 4xx and exhausted retryable responses to DLQ', async () => {
    const permanent = new FakeStore([claimed()]);
    const exhausted = new FakeStore([claimed(4)]);

    await worker(permanent, transport(400)).runOnce();
    await worker(exhausted, transport(503)).runOnce();

    expect(permanent.dead).toEqual([
      { id: 'delivery-1', error: 'permanent_http_error', statusCode: 400 },
    ]);
    expect(exhausted.dead).toEqual([
      { id: 'delivery-1', error: 'retry_exhausted', statusCode: 503 },
    ]);
  });

  it('reuses the exact frozen body and request id but refreshes timestamp and signature on retry', async () => {
    const firstStore = new FakeStore(
      [claimed()],
      [
        {
          agent_id: 'alpha',
          mode: 'observe',
          text: 'first-context',
          occurred_at: '2026-07-17T23:59:00.000Z',
        },
      ],
    );
    const firstTransport = transport(503);
    await worker(firstStore, firstTransport).runOnce();

    const frozen = firstStore.frozen[0];
    expect(frozen).toBeDefined();
    const retryStore = new FakeStore(
      [claimed(2, frozen)],
      [
        {
          agent_id: 'beta',
          mode: 'observe',
          text: 'changed-context-must-not-be-used',
          occurred_at: '2026-07-18T00:00:30.000Z',
        },
      ],
    );
    const retryTransport = transport(202);
    await worker(retryStore, retryTransport, {
      now: () => new Date('2026-07-18T00:01:10.000Z'),
    }).runOnce();

    const firstCall = vi.mocked(firstTransport.post).mock.calls[0];
    const retryCall = vi.mocked(retryTransport.post).mock.calls[0];
    expect(retryCall?.[1].equals(firstCall?.[1] ?? Buffer.alloc(0))).toBe(true);
    expect(retryCall?.[2]['X-Request-ID']).toBe(firstCall?.[2]['X-Request-ID']);
    expect(retryCall?.[2]['X-Webhook-Timestamp']).toBe('1784332870');
    expect(retryCall?.[2]['X-Webhook-Timestamp']).not.toBe(firstCall?.[2]['X-Webhook-Timestamp']);
    expect(retryCall?.[2]['X-Webhook-Signature-V2']).not.toBe(
      firstCall?.[2]['X-Webhook-Signature-V2'],
    );
    const retrySignature = createHmac('sha256', 'target-secret')
      .update(`${retryCall?.[2]['X-Webhook-Timestamp']}.`)
      .update(retryCall?.[1] ?? Buffer.alloc(0))
      .digest('hex');
    expect(retryCall?.[2]['X-Webhook-Signature-V2']).toBe(retrySignature);
    expect(retryStore.frozen).toEqual([]);
  });

  it.each([
    ['new request', undefined],
    ['frozen retry', { rawBody: Buffer.from('{"frozen":true}') }],
  ])('does not POST a %s when the pre-transport lease renewal is fenced out', async (_, frozen) => {
    const store = new FakeStore([claimed(2, frozen)], [], false);
    const client = transport(202);

    await worker(store, client).runOnce();

    expect(store.renewed).toEqual([{ id: 'delivery-1', leaseToken: 'lease-2', leaseSeconds: 30 }]);
    expect(client.post).not.toHaveBeenCalled();
    expect(store.delivered).toEqual([]);
    expect(store.retried).toEqual([]);
    expect(store.dead).toEqual([]);
  });

  it('processes a claimed multi-channel batch concurrently before any lease can idle', async () => {
    const second = claimed();
    second.id = 'delivery-2';
    second.leaseToken = 'lease-2';
    second.event = {
      ...second.event,
      event_id: 'd06d21f2-96fd-4c70-9788-42ca40a7ae13',
      conversation: {
        ...second.event.conversation,
        channel_key: 'telegram:-5483781018',
        root_event_id: 'd06d21f2-96fd-4c70-9788-42ca40a7ae13',
      },
    };
    const store = new FakeStore([claimed(), second]);
    let active = 0;
    let maxActive = 0;
    const client: DeliveryTransport = {
      post: vi.fn().mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return { status: 202 };
      }),
    };

    await worker(store, client).runOnce();

    expect(maxActive).toBe(2);
    expect(store.delivered).toHaveLength(2);
  });

  it('trims recent context to the newest messages under the 16 KiB encoded limit', async () => {
    const context = Array.from({ length: 6 }, (_, index) => ({
      agent_id: 'alpha',
      mode: 'observe' as const,
      text: `${index}:${'x'.repeat(4_000)}`,
      occurred_at: `2026-07-17T23:5${index}:00.000Z`,
    }));
    const store = new FakeStore([claimed()], context);
    const client = transport(200);

    await worker(store, client).runOnce();

    const rawBody = vi.mocked(client.post).mock.calls[0]?.[1] ?? Buffer.alloc(0);
    const sent = JSON.parse(rawBody.toString('utf8')) as BridgeEvent;
    expect(Buffer.byteLength(JSON.stringify(sent.context.recent_messages))).toBeLessThanOrEqual(
      16 * 1024,
    );
    expect(sent.context.recent_messages.at(-1)?.text).toBe(context.at(-1)?.text);
  });
});
