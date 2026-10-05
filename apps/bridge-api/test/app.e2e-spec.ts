import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridgeApp } from '../src/app.js';
import { signHmacV2 } from '../src/auth/hmac.js';
import type { BridgeEvent } from '../src/domain.js';
import type {
  AcceptedEvent,
  BridgeStore,
  HeartbeatInput,
  IngressGuardInput,
  IngressGuardResult,
} from '../src/storage/store.js';

const now = new Date('2026-07-18T12:00:00.000Z');
const timestamp = String(Math.floor(now.getTime() / 1000));
const alphaSecret = 'alpha-active-test-secret';

class RecordingStore implements BridgeStore {
  readonly accepted: AcceptedEvent[] = [];
  readonly heartbeats: HeartbeatInput[] = [];
  ready = true;
  private readonly eventDigests = new Map<string, string>();
  private readonly replayKeys = new Set<string>();
  private readonly rateBuckets = new Map<string, number>();

  async acceptEvent(input: AcceptedEvent): Promise<{ created: boolean; conflict?: boolean }> {
    const existing = this.eventDigests.get(input.event.event_id);
    if (existing) {
      return { created: false, conflict: existing !== input.payloadDigest };
    }
    this.eventDigests.set(input.event.event_id, input.payloadDigest);
    this.accepted.push(input);
    return { created: true };
  }

  async guardIngress(input: IngressGuardInput): Promise<IngressGuardResult> {
    if (input.replayKey) {
      if (this.replayKeys.has(input.replayKey)) {
        return 'replayed';
      }
      this.replayKeys.add(input.replayKey);
    }
    const key = `${input.agentId}:${input.bucketSecond}`;
    const count = this.rateBuckets.get(key) ?? 0;
    if (count >= input.rateLimit) {
      return 'rate_limited';
    }
    this.rateBuckets.set(key, count + 1);
    return 'accepted';
  }

  async recordHeartbeat(input: HeartbeatInput): Promise<void> {
    this.heartbeats.push(input);
  }

  async readiness(): Promise<boolean> {
    return this.ready;
  }
}

function validEvent(): BridgeEvent {
  const eventId = '018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e10';
  return {
    schema_version: 1,
    event_type: 'hermes.agent.message',
    event_id: eventId,
    occurred_at: '2026-07-18T11:59:59.000Z',
    delivery_semantics: 'generated',
    source: {
      agent_id: 'alpha',
      instance_id: 'alpha-test',
      platform: 'telegram',
      chat_id: '-100123',
      thread_id: null,
      session_id: 'session-1',
    },
    target: { agent_id: 'beta' },
    conversation: {
      channel_key: 'telegram:-100123',
      mode: 'observe',
      root_event_id: eventId,
      causation_id: null,
      hop: 0,
    },
    message: {
      text: 'Hello from Alpha',
      trigger_text: 'Hello',
      format: 'telegram-markdown',
    },
    context: { recent_messages: [] },
  };
}

function registry() {
  return new Map([
    [
      'alpha',
      {
        agentId: 'alpha',
        activeSecret: alphaSecret,
        previousSecret: undefined,
        webhookUrl: 'https://alpha.invalid/webhooks/peer-beta',
        webhookSecret: 'to-alpha-secret',
      },
    ],
    [
      'beta',
      {
        agentId: 'beta',
        activeSecret: 'beta-active-test-secret',
        previousSecret: undefined,
        webhookUrl: 'https://beta.invalid/webhooks/peer-alpha',
        webhookSecret: 'to-beta-secret',
      },
    ],
  ]);
}

function signedEventRequest(
  event: BridgeEvent,
  requestTimestamp = timestamp,
  secret = alphaSecret,
) {
  const rawBody = Buffer.from(JSON.stringify(event));
  return {
    method: 'POST' as const,
    url: '/v1/events',
    headers: {
      'content-type': 'application/json',
      'x-bridge-agent': 'alpha',
      'x-request-id': event.event_id,
      'x-webhook-timestamp': requestTimestamp,
      'x-webhook-signature-v2': signHmacV2(secret, requestTimestamp, rawBody),
    },
    payload: rawBody,
  };
}

describe('POST /v1/events', () => {
  let app: INestApplication;
  let server: FastifyInstance;
  let store: RecordingStore;
  let runtimeReady: boolean;

  beforeEach(async () => {
    store = new RecordingStore();
    runtimeReady = true;
    app = await createBridgeApp({
      agents: registry(),
      store,
      now: () => now,
      requestsEnabled: false,
      replayWindowSeconds: 300,
      maxBodyBytes: 65_536,
      rateLimitPerSecond: 2,
      metricsToken: 'metrics-test-token',
      runtimeReadiness: () => runtimeReady,
    });
    server = app.getHttpAdapter().getInstance() as FastifyInstance;
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a valid raw-body signed event', async () => {
    const event = validEvent();
    const response = await server.inject(signedEventRequest(event));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ event_id: event.event_id, status: 'accepted' });
    expect(store.accepted).toHaveLength(1);
  });

  it('rejects a signature made for a different raw body', async () => {
    const request = signedEventRequest(validEvent());
    request.payload = Buffer.from(`${request.payload.toString('utf8')} `);

    const response = await server.inject(request);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: 'invalid_signature' });
    expect(store.accepted).toHaveLength(0);
  });

  it('rejects a timestamp outside the replay window', async () => {
    const expiredTimestamp = String(Number(timestamp) - 301);
    const response = await server.inject(signedEventRequest(validEvent(), expiredTimestamp));

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: 'replay_window_exceeded' });
    expect(store.accepted).toHaveLength(0);
  });

  it('returns the same deterministic acceptance without creating duplicate work', async () => {
    const request = signedEventRequest(validEvent());

    const first = await server.inject(request);
    const duplicate = await server.inject(request);

    expect(first.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual(first.json());
    expect(store.accepted).toHaveLength(1);
  });

  it('rejects reuse of an event id with a different raw body', async () => {
    const original = validEvent();
    const conflicting = validEvent();
    conflicting.message.text = 'Different payload with the same event id';

    const first = await server.inject(signedEventRequest(original));
    const conflict = await server.inject(signedEventRequest(conflicting));

    expect(first.statusCode).toBe(202);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ reason: 'event_id_payload_conflict' });
    expect(store.accepted).toHaveLength(1);
  });

  it('rejects a same-agent loop', async () => {
    const event = validEvent();
    event.target.agent_id = 'alpha';

    const response = await server.inject(signedEventRequest(event));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ reason: 'same_agent' });
  });

  it('rejects an event above the hard hop limit', async () => {
    const event = validEvent();
    event.conversation.hop = 3;

    const response = await server.inject(signedEventRequest(event));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ reason: 'invalid_event' });
  });

  it('rejects delimiters in channel-key components so canonical keys cannot collide', async () => {
    const event = validEvent();
    event.source.chat_id = 'chat:thread';
    event.conversation.channel_key = 'telegram:chat:thread';

    const response = await server.inject(signedEventRequest(event));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ reason: 'invalid_event' });
  });

  it('rejects request mode while the feature flag is disabled', async () => {
    const event = validEvent();
    event.conversation.mode = 'request';

    const response = await server.inject(signedEventRequest(event));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ reason: 'requests_disabled' });
  });

  it('rejects a valid response transition while the feature flag is disabled', async () => {
    const event = validEvent();
    event.conversation.mode = 'response';
    event.conversation.hop = 1;
    event.conversation.causation_id = '50de2e3d-45d1-49dc-965b-03bc38303111';
    event.conversation.root_event_id = 'b3220c33-5397-46a8-a343-a6ac3d4e9562';

    const response = await server.inject(signedEventRequest(event));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ reason: 'requests_disabled' });
  });

  it('rejects a response without request causation metadata', async () => {
    const event = validEvent();
    event.conversation.mode = 'response';
    event.conversation.hop = 1;

    const response = await server.inject(signedEventRequest(event));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ reason: 'invalid_conversation_transition' });
  });

  it('rejects source-supplied rolling context', async () => {
    const event = validEvent();
    event.context.recent_messages.push({
      agent_id: 'alpha',
      mode: 'observe',
      text: 'untrusted context',
      occurred_at: event.occurred_at,
    });

    const response = await server.inject(signedEventRequest(event));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ reason: 'source_context_forbidden' });
  });

  it('rejects an unknown schema version', async () => {
    const event = validEvent();
    const unknownVersion = { ...event, schema_version: 2 };
    const rawBody = Buffer.from(JSON.stringify(unknownVersion));
    const request = signedEventRequest(event);
    request.payload = rawBody;
    request.headers['x-webhook-signature-v2'] = signHmacV2(alphaSecret, timestamp, rawBody);

    const response = await server.inject(request);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ reason: 'invalid_event' });
  });

  it('rate limits each authenticated agent independently', async () => {
    const first = validEvent();
    const second = validEvent();
    second.event_id = 'b3220c33-5397-46a8-a343-a6ac3d4e9562';
    second.conversation.root_event_id = second.event_id;
    const third = validEvent();
    third.event_id = 'e5e93ec1-bbed-45c8-b77c-22f00d787c64';
    third.conversation.root_event_id = third.event_id;
    const events = [first, second, third];

    const responses = [];
    for (const event of events) {
      responses.push(await server.inject(signedEventRequest(event)));
    }

    expect(responses.map((response) => response.statusCode)).toEqual([202, 202, 429]);
    expect(responses[2]?.json()).toMatchObject({ reason: 'rate_limit_exceeded' });
  });

  it('records an authenticated agent heartbeat without content', async () => {
    const heartbeat = {
      instance_id: 'alpha-test',
      plugin_version: '1.2.3',
      pending_count: 4,
      oldest_event_age_seconds: 12,
    };
    const rawBody = Buffer.from(JSON.stringify(heartbeat));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/agents/heartbeat',
      headers: {
        'content-type': 'application/json',
        'x-bridge-agent': 'alpha',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature-v2': signHmacV2(alphaSecret, timestamp, rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(204);
    expect(store.heartbeats).toEqual([
      {
        agentId: 'alpha',
        instanceId: 'alpha-test',
        pluginVersion: '1.2.3',
        pendingCount: 4,
        oldestEventAgeSeconds: 12,
        receivedAt: now,
      },
    ]);
  });

  it('accepts the exact heartbeat shape emitted by an empty plugin outbox', async () => {
    const heartbeat = {
      instance_id: 'alpha-test',
      plugin_version: '1.2.3',
      pending_count: 0,
      oldest_event_age_seconds: null,
    };
    const rawBody = Buffer.from(JSON.stringify(heartbeat));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/agents/heartbeat',
      headers: {
        'content-type': 'application/json',
        'x-bridge-agent': 'alpha',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature-v2': signHmacV2(alphaSecret, timestamp, rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(204);
    expect(store.heartbeats.at(-1)).toMatchObject({
      agentId: 'alpha',
      pendingCount: 0,
      oldestEventAgeSeconds: null,
    });
  });

  it('rejects replay of the same signed heartbeat', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        instance_id: 'alpha-test',
        plugin_version: '1.2.3',
        pending_count: 0,
        oldest_event_age_seconds: null,
      }),
    );
    const request = {
      method: 'POST' as const,
      url: '/v1/agents/heartbeat',
      headers: {
        'content-type': 'application/json',
        'x-bridge-agent': 'alpha',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature-v2': signHmacV2(alphaSecret, timestamp, rawBody),
      },
      payload: rawBody,
    };

    expect((await server.inject(request)).statusCode).toBe(204);
    const replay = await server.inject(request);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ reason: 'replay_detected' });
    expect(store.heartbeats).toHaveLength(1);
  });

  it('reports liveness and database-backed readiness separately', async () => {
    const health = await server.inject({ method: 'GET', url: '/healthz' });
    store.ready = false;
    const notReady = await server.inject({ method: 'GET', url: '/readyz' });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toEqual({ status: 'not_ready' });

    store.ready = true;
    runtimeReady = false;
    const workerNotReady = await server.inject({ method: 'GET', url: '/readyz' });
    expect(workerNotReady.statusCode).toBe(503);
    expect(workerNotReady.json()).toEqual({ status: 'not_ready' });
  });

  it('protects metrics with the configured bearer token', async () => {
    await server.inject(signedEventRequest(validEvent()));

    const unauthorized = await server.inject({ method: 'GET', url: '/metrics' });
    const authorized = await server.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-test-token' },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.body).toContain('bridge_events_received_total 1');
  });
});
