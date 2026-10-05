import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayloadCipher, PayloadCipherKeyring } from '../src/crypto/payload-cipher.js';
import type { BridgeEvent } from '../src/domain.js';
import { PostgresBridgeStore } from '../src/storage/postgres-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function event(eventId: string, text: string, occurredAt: string): BridgeEvent {
  return {
    schema_version: 1,
    event_type: 'hermes.agent.message',
    event_id: eventId,
    occurred_at: occurredAt,
    delivery_semantics: 'generated',
    source: {
      agent_id: 'alpha',
      instance_id: 'alpha-test',
      platform: 'telegram',
      chat_id: '-5483781017',
      thread_id: null,
      session_id: 'session-1',
    },
    target: { agent_id: 'beta' },
    conversation: {
      channel_key: 'telegram:-5483781017',
      mode: 'observe',
      root_event_id: eventId,
      causation_id: null,
      hop: 0,
    },
    message: { text, trigger_text: text, format: 'telegram-markdown' },
    context: { recent_messages: [] },
  };
}

function acceptedInput(input: BridgeEvent, receivedAt = new Date(input.occurred_at)) {
  const rawBody = Buffer.from(JSON.stringify(input));
  return {
    event: input,
    rawBody,
    payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
    receivedAt,
  };
}

describePostgres('PostgresBridgeStore', () => {
  let pool: Pool;
  let store: PostgresBridgeStore;
  const targets = new Map([
    [
      'beta',
      {
        url: 'http://beta.test/webhooks/peer-alpha',
        webhookSecret: 'beta-webhook-secret',
      },
    ],
  ]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const keyring = new PayloadCipherKeyring(new PayloadCipher(randomBytes(32), 'test-current'));
    store = new PostgresBridgeStore(pool, keyring, targets);
    await store.migrate();
    await store.migrate();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE bridge_dead_letters, bridge_deliveries, bridge_events, bridge_agents, bridge_ingress_replays, bridge_rate_limits RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('atomically deduplicates event and logical delivery while encrypting plaintext', async () => {
    const input = event(
      '4d594ab2-93f8-48a0-8938-c5b8bd507a8b',
      'classified payload text',
      '2026-07-18T00:00:00.000Z',
    );
    await expect(store.acceptEvent(acceptedInput(input))).resolves.toEqual({ created: true });
    await expect(store.acceptEvent(acceptedInput(input))).resolves.toEqual({ created: false });

    const counts = await pool.query<{ events: string; deliveries: string }>(
      `SELECT
         (SELECT count(*) FROM bridge_events)::text AS events,
         (SELECT count(*) FROM bridge_deliveries)::text AS deliveries`,
    );
    expect(counts.rows[0]).toEqual({ events: '1', deliveries: '1' });
    const stored = await pool.query<{ has_plaintext: boolean; metadata: Record<string, unknown> }>(
      `SELECT
         position(convert_to('classified payload text', 'UTF8') in payload_ciphertext) > 0 AS has_plaintext,
         metadata
       FROM bridge_events`,
    );
    expect(stored.rows[0]?.has_plaintext).toBe(false);
    expect(JSON.stringify(stored.rows[0]?.metadata)).not.toContain('classified payload text');
  });

  it('rejects the same event id when the raw payload digest changes', async () => {
    const eventId = 'e350a30f-d42a-4f35-a430-0d8fbd86f09a';
    const original = event(eventId, 'original', '2026-07-18T00:00:00.000Z');
    const conflicting = event(eventId, 'conflicting', '2026-07-18T00:00:00.000Z');

    await expect(store.acceptEvent(acceptedInput(original))).resolves.toEqual({ created: true });
    await expect(store.acceptEvent(acceptedInput(conflicting))).resolves.toEqual({
      created: false,
      conflict: true,
    });
  });

  it('uses a lease with SKIP LOCKED so concurrent workers claim one delivery once', async () => {
    const input = event(
      'c01dd6e7-2069-438d-bc28-8c3e50c41860',
      'claim me once',
      '2026-07-18T00:00:00.000Z',
    );
    await store.acceptEvent(acceptedInput(input));
    const now = new Date('2026-07-18T00:00:10.000Z');

    const [left, right] = await Promise.all([store.claim(1, 30, now), store.claim(1, 30, now)]);

    expect([...left, ...right]).toHaveLength(1);
    expect([...left, ...right][0]?.attempt).toBe(1);
    const third = await store.claim(1, 30, now);
    expect(third).toEqual([]);
  });

  it('claims only the oldest pending delivery per channel across workers', async () => {
    const oldest = event(
      'd9b47514-173b-454d-aee6-d9426fa86a39',
      'oldest channel message',
      '2026-07-18T00:00:00.000Z',
    );
    const next = event(
      '5b91216b-4746-4ffc-aed4-8ace700ac1a7',
      'next channel message',
      '2026-07-18T00:00:01.000Z',
    );
    for (const input of [oldest, next]) {
      await store.acceptEvent(acceptedInput(input));
    }

    const otherWorker = new PostgresBridgeStore(pool, store.keyring, targets);
    const now = new Date('2026-07-18T00:00:10.000Z');
    const [left, right] = await Promise.all([
      store.claim(1, 30, now),
      otherWorker.claim(1, 30, now),
    ]);
    const claimed = [...left, ...right];
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.event.event_id).toBe(oldest.event_id);

    await store.markDelivered(claimed[0]?.id ?? '', claimed[0]?.leaseToken ?? '', 202, now);
    const [following] = await otherWorker.claim(1, 30, new Date('2026-07-18T00:00:11.000Z'));
    expect(following?.event.event_id).toBe(next.event_id);
  });

  it('does not bypass channel single-flight when a late event claims an older occurred_at', async () => {
    const inFlight = event(
      '018b4456-31ad-4bc7-896e-83d6cb8c46a3',
      'already in flight',
      '2026-07-18T00:10:00.000Z',
    );
    await store.acceptEvent(acceptedInput(inFlight, new Date('2026-07-18T00:00:00.000Z')));
    const [claimedInFlight] = await store.claim(1, 300, new Date('2026-07-18T00:00:01.000Z'));

    const late = event(
      'a5d7100c-969a-42f3-adf6-c89b4f929235',
      'late but older event time',
      '2026-07-17T23:59:00.000Z',
    );
    await store.acceptEvent(acceptedInput(late, new Date('2026-07-18T00:00:02.000Z')));

    await expect(store.claim(1, 300, new Date('2026-07-18T00:00:03.000Z'))).resolves.toEqual([]);
    await store.markDelivered(
      claimedInFlight?.id ?? '',
      claimedInFlight?.leaseToken ?? '',
      202,
      new Date('2026-07-18T00:00:04.000Z'),
    );
    const [following] = await store.claim(1, 300, new Date('2026-07-18T00:00:05.000Z'));
    expect(following?.event.event_id).toBe(late.event_id);
  });

  it('reclaims an expired lease after restart and persists retry/DLQ state transitions', async () => {
    const input = event(
      'bc61b5bc-c80a-49f7-91b9-f0cc53b818cc',
      'retry safely',
      '2026-07-18T00:00:00.000Z',
    );
    const baseMs = Date.now();
    const at = (offsetMs: number): Date => new Date(baseMs + offsetMs);
    await store.acceptEvent(acceptedInput(input, at(0)));
    const original = await store.claim(1, 1, at(0));

    const restarted = new PostgresBridgeStore(pool, store.keyring, targets);
    const reclaimed = await restarted.claim(1, 30, at(2_000));
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.attempt).toBe(2);
    expect(reclaimed[0]?.leaseToken).not.toBe(original[0]?.leaseToken);
    expect(
      await restarted.reschedule(
        reclaimed[0]?.id ?? '',
        original[0]?.leaseToken ?? '',
        at(3_000),
        'stale_worker',
      ),
    ).toBe(false);

    const frozen = await restarted.freezeRequest(
      reclaimed[0]?.id ?? '',
      reclaimed[0]?.leaseToken ?? '',
      { rawBody: Buffer.from('{"frozen":true}') },
    );
    expect(frozen?.rawBody.toString('utf8')).toBe('{"frozen":true}');

    await restarted.reschedule(
      reclaimed[0]?.id ?? '',
      reclaimed[0]?.leaseToken ?? '',
      at(60_000),
      'network_error',
    );
    expect(await restarted.claim(1, 30, at(30_000))).toEqual([]);
    const retried = await restarted.claim(1, 30, at(61_000));
    expect(retried[0]?.frozenRequest?.rawBody.toString('utf8')).toBe('{"frozen":true}');
    await restarted.moveToDeadLetter(
      retried[0]?.id ?? '',
      retried[0]?.leaseToken ?? '',
      'retry_exhausted',
      503,
    );

    const state = await pool.query<{
      delivery_status: string;
      event_status: string;
      dead_count: string;
    }>(
      `SELECT d.status AS delivery_status, e.status AS event_status,
         (SELECT count(*) FROM bridge_dead_letters)::text AS dead_count
       FROM bridge_deliveries d JOIN bridge_events e USING (event_id)`,
    );
    expect(state.rows[0]).toEqual({
      delivery_status: 'dead',
      event_status: 'dead',
      dead_count: '1',
    });
  });

  it('atomically renews only a live current lease immediately before transport', async () => {
    const input = event(
      'ac217351-e0ef-48bc-a120-7eec1f6faf47',
      'renew before transport',
      '2026-07-18T00:00:00.000Z',
    );
    await store.acceptEvent(acceptedInput(input, new Date()));
    const [original] = await store.claim(1, 30, new Date());
    expect(original).toBeDefined();

    await pool.query(
      `UPDATE bridge_deliveries
       SET lease_until = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [original?.id],
    );
    await expect(
      store.renewLease(original?.id ?? '', original?.leaseToken ?? '', 60),
    ).resolves.toBe(false);

    const [reclaimed] = await store.claim(1, 30, new Date());
    expect(reclaimed?.leaseToken).not.toBe(original?.leaseToken);
    await expect(
      store.renewLease(reclaimed?.id ?? '', reclaimed?.leaseToken ?? '', 60),
    ).resolves.toBe(true);
    await expect(
      store.renewLease(reclaimed?.id ?? '', original?.leaseToken ?? '', 60),
    ).resolves.toBe(false);

    const lease = await pool.query<{ remaining_seconds: number }>(
      `SELECT extract(epoch FROM (lease_until - clock_timestamp()))::float8 AS remaining_seconds
       FROM bridge_deliveries WHERE id = $1`,
      [reclaimed?.id],
    );
    expect(lease.rows[0]?.remaining_seconds).toBeGreaterThan(55);
  });

  it('persists replay decisions and a shared per-agent rate bucket across store instances', async () => {
    const replica = new PostgresBridgeStore(pool, store.keyring, targets);
    const base = {
      agentId: 'alpha',
      bucketSecond: 1_784_332_800,
      rateLimit: 2,
      now: new Date('2026-07-18T00:00:00.000Z'),
    };

    expect(
      await store.guardIngress({
        ...base,
        replayKey: 'heartbeat-one',
        replayExpiresAt: new Date('2026-07-18T00:05:00.000Z'),
      }),
    ).toBe('accepted');
    expect(
      await replica.guardIngress({
        ...base,
        replayKey: 'heartbeat-one',
        replayExpiresAt: new Date('2026-07-18T00:05:00.000Z'),
      }),
    ).toBe('replayed');
    expect(await replica.guardIngress(base)).toBe('accepted');
    expect(
      await store.guardIngress({
        ...base,
        replayKey: 'heartbeat-two',
        replayExpiresAt: new Date('2026-07-18T00:05:00.000Z'),
      }),
    ).toBe('rate_limited');
  });

  it('enforces one response per causation and direction in PostgreSQL', async () => {
    const parent = event(
      'd06d21f2-96fd-4c70-9788-42ca40a7ae13',
      'request root',
      '2026-07-18T00:00:00.000Z',
    );
    await store.acceptEvent(acceptedInput(parent));

    const response = (eventId: string): BridgeEvent => ({
      ...event(eventId, 'response', '2026-07-18T00:00:01.000Z'),
      source: {
        ...parent.source,
        agent_id: 'beta',
        instance_id: 'beta-01',
      },
      target: { agent_id: 'alpha' },
      conversation: {
        channel_key: parent.conversation.channel_key,
        root_event_id: parent.event_id,
        causation_id: parent.event_id,
        hop: 1,
        mode: 'response',
      },
    });
    await store.acceptEvent(acceptedInput(response('464081cc-9eb4-4269-94ca-bab3700d88e9')));
    await expect(
      store.acceptEvent(acceptedInput(response('35797741-f9f1-4408-b49f-691bb03f8918'))),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('returns only earlier delivered messages as chronological rolling context', async () => {
    const first = event(
      '14981728-50d6-4cec-8fe2-08651092346b',
      'first delivered message',
      '2026-07-18T00:00:00.000Z',
    );
    await store.acceptEvent(acceptedInput(first));
    const [claimed] = await store.claim(1, 30, new Date('2026-07-18T00:00:01.000Z'));
    await store.markDelivered(
      claimed?.id ?? '',
      claimed?.leaseToken ?? '',
      202,
      new Date('2026-07-18T00:00:02.000Z'),
    );

    const current = event(
      'ff351276-abdb-46bf-892a-b94e27ba5d34',
      'current pending message',
      '2026-07-18T00:01:00.000Z',
    );
    await store.acceptEvent(acceptedInput(current));

    await expect(store.recentContext(current, 6)).resolves.toEqual([
      {
        agent_id: 'alpha',
        mode: 'observe',
        text: 'first delivered message',
        occurred_at: '2026-07-18T00:00:00.000Z',
      },
    ]);
  });
});

describePostgres('legacy migration upgrade', () => {
  it('backfills legacy semantics and enforces the fresh-schema constraints idempotently', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = 'legacy_upgrade_test';
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const legacyPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    try {
      await legacyPool.query(`
        CREATE TABLE bridge_events (
          event_id uuid PRIMARY KEY,
          event_type text NOT NULL,
          source_agent text NOT NULL,
          target_agent text NOT NULL,
          channel_key text NOT NULL,
          occurred_at timestamptz NOT NULL,
          received_at timestamptz NOT NULL,
          hop integer NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          payload_key_id text NOT NULL,
          payload_nonce bytea NOT NULL,
          payload_ciphertext bytea NOT NULL,
          payload_tag bytea NOT NULL,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE TABLE bridge_agents (
          agent_id text PRIMARY KEY,
          instance_id text NOT NULL,
          version text,
          capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
          last_seen_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      const eventId = '55c81c4c-cf5d-4fd2-b878-fd5609cd0f11';
      const rootEventId = '14e46c59-ec18-4c79-b22b-d086e8cbd8e2';
      const causationId = '34d49c5e-aa47-4ea6-a558-1ed8a059dc05';
      await legacyPool.query(
        `INSERT INTO bridge_events (
           event_id, event_type, source_agent, target_agent, channel_key,
           occurred_at, received_at, hop, payload_key_id, payload_nonce,
           payload_ciphertext, payload_tag, metadata
         ) VALUES ($1, 'hermes.agent.message', 'beta', 'alpha', 'telegram:-100123',
           now(), now(), 1, 'v1', '\\x00', '\\x00', '\\x00', $2::jsonb)`,
        [
          eventId,
          JSON.stringify({
            delivery_semantics: 'generated',
            mode: 'response',
            root_event_id: rootEventId,
            causation_id: causationId,
            payload_digest: 'a'.repeat(64),
          }),
        ],
      );
      await legacyPool.query(
        `INSERT INTO bridge_agents (agent_id, instance_id, last_seen_at)
         VALUES ('alpha', 'alpha-legacy', now())`,
      );

      const keyring = new PayloadCipherKeyring(new PayloadCipher(randomBytes(32), 'test-current'));
      const legacyStore = new PostgresBridgeStore(legacyPool, keyring, new Map());
      await legacyStore.migrate();
      await legacyStore.migrate();

      const upgraded = await legacyPool.query<{
        delivery_semantics: string;
        mode: string;
        root_event_id: string;
        causation_id: string;
      }>(
        `SELECT delivery_semantics, mode, root_event_id::text, causation_id::text
         FROM bridge_events WHERE event_id = $1`,
        [eventId],
      );
      expect(upgraded.rows[0]).toEqual({
        delivery_semantics: 'generated',
        mode: 'response',
        root_event_id: rootEventId,
        causation_id: causationId,
      });
      await expect(
        legacyPool.query(`UPDATE bridge_events SET delivery_semantics = 'bogus'`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        legacyPool.query(`UPDATE bridge_events SET mode = 'bogus'`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        legacyPool.query(`UPDATE bridge_events SET status = 'bogus'`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(legacyPool.query(`UPDATE bridge_events SET hop = 3`)).rejects.toMatchObject({
        code: '23514',
      });
      await expect(
        legacyPool.query(`UPDATE bridge_agents SET pending_count = -1`),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await legacyPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
