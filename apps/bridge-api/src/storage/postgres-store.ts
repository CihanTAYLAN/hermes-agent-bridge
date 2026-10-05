import type { Pool, PoolClient } from 'pg';
import type { PayloadCipherKeyring } from '../crypto/payload-cipher.js';
import type { BridgeEvent, RecentMessage } from '../domain.js';
import type {
  ClaimedDelivery,
  DeliveryStore,
  DeliveryTarget,
  FrozenDeliveryRequest,
} from '../worker/delivery-worker.js';
import type {
  AcceptedEvent,
  BridgeStore,
  HeartbeatInput,
  IngressGuardInput,
  IngressGuardResult,
} from './store.js';

export const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bridge_events (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  source_agent text NOT NULL,
  target_agent text NOT NULL,
  channel_key text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  delivery_semantics text NOT NULL DEFAULT 'generated' CHECK (delivery_semantics = 'generated'),
  mode text NOT NULL DEFAULT 'observe' CHECK (mode IN ('observe', 'request', 'response')),
  root_event_id uuid NOT NULL,
  causation_id uuid,
  hop integer NOT NULL CHECK (hop >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  payload_key_id text NOT NULL,
  payload_nonce bytea NOT NULL,
  payload_ciphertext bytea NOT NULL,
  payload_tag bytea NOT NULL,
  payload_sha256 text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE bridge_events
  ADD COLUMN IF NOT EXISTS payload_sha256 text;
ALTER TABLE bridge_events
  ADD COLUMN IF NOT EXISTS delivery_semantics text NOT NULL DEFAULT 'generated';
ALTER TABLE bridge_events
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'observe';
ALTER TABLE bridge_events
  ADD COLUMN IF NOT EXISTS root_event_id uuid;
ALTER TABLE bridge_events
  ADD COLUMN IF NOT EXISTS causation_id uuid;
UPDATE bridge_events SET root_event_id = event_id WHERE root_event_id IS NULL;
ALTER TABLE bridge_events ALTER COLUMN root_event_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bridge_events_single_response_idx
  ON bridge_events (causation_id, source_agent, target_agent)
  WHERE mode = 'response';

CREATE TABLE IF NOT EXISTS bridge_deliveries (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES bridge_events(event_id) ON DELETE CASCADE,
  target_agent text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  outbound_timestamp text,
  outbound_key_id text,
  outbound_nonce bytea,
  outbound_ciphertext bytea,
  outbound_tag bytea,
  delivered_at timestamptz,
  last_status_code integer,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, target_agent)
);

ALTER TABLE bridge_deliveries ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE bridge_deliveries ADD COLUMN IF NOT EXISTS outbound_timestamp text;
ALTER TABLE bridge_deliveries ADD COLUMN IF NOT EXISTS outbound_key_id text;
ALTER TABLE bridge_deliveries ADD COLUMN IF NOT EXISTS outbound_nonce bytea;
ALTER TABLE bridge_deliveries ADD COLUMN IF NOT EXISTS outbound_ciphertext bytea;
ALTER TABLE bridge_deliveries ADD COLUMN IF NOT EXISTS outbound_tag bytea;

CREATE INDEX IF NOT EXISTS bridge_deliveries_claim_idx
  ON bridge_deliveries (available_at, id)
  WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS bridge_events_context_idx
  ON bridge_events (channel_key, occurred_at DESC)
  WHERE status = 'delivered';

CREATE TABLE IF NOT EXISTS bridge_dead_letters (
  delivery_id bigint PRIMARY KEY REFERENCES bridge_deliveries(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES bridge_events(event_id) ON DELETE CASCADE,
  reason text NOT NULL,
  status_code integer,
  failed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bridge_agents (
  agent_id text PRIMARY KEY,
  instance_id text NOT NULL,
  version text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_count integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  oldest_event_age_seconds double precision CHECK (
    oldest_event_age_seconds IS NULL OR oldest_event_age_seconds >= 0
  ),
  last_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bridge_agents
  ADD COLUMN IF NOT EXISTS pending_count integer NOT NULL DEFAULT 0;
ALTER TABLE bridge_agents
  ADD COLUMN IF NOT EXISTS oldest_event_age_seconds double precision;

CREATE TABLE IF NOT EXISTS bridge_ingress_replays (
  replay_key text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS bridge_ingress_replays_expiry_idx
  ON bridge_ingress_replays (expires_at);

CREATE TABLE IF NOT EXISTS bridge_rate_limits (
  agent_id text NOT NULL,
  bucket_second bigint NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (agent_id, bucket_second)
);
CREATE INDEX IF NOT EXISTS bridge_rate_limits_bucket_idx
  ON bridge_rate_limits (bucket_second);
`;

export const HARDEN_LEGACY_SCHEMA_SQL = `
-- Harden legacy installations so replayed migrations match a fresh schema.
-- This migration is intentionally idempotent: Hermes runs all migrations at startup.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM bridge_events
    WHERE metadata ? 'mode'
      AND metadata->>'mode' NOT IN ('observe', 'request', 'response')
  ) THEN
    RAISE EXCEPTION 'bridge_events metadata contains an invalid mode';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM bridge_events
    WHERE metadata ? 'delivery_semantics'
      AND metadata->>'delivery_semantics' <> 'generated'
  ) THEN
    RAISE EXCEPTION 'bridge_events metadata contains invalid delivery_semantics';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM bridge_events
    WHERE metadata ? 'root_event_id'
      AND (
        metadata->>'root_event_id' IS NULL
        OR metadata->>'root_event_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
  ) THEN
    RAISE EXCEPTION 'bridge_events metadata contains an invalid root_event_id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM bridge_events
    WHERE metadata ? 'causation_id'
      AND metadata->>'causation_id' IS NOT NULL
      AND metadata->>'causation_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'bridge_events metadata contains an invalid causation_id';
  END IF;
END $$;

UPDATE bridge_events
SET delivery_semantics = COALESCE(metadata->>'delivery_semantics', delivery_semantics),
    mode = COALESCE(metadata->>'mode', mode),
    root_event_id = CASE
      WHEN metadata ? 'root_event_id' THEN (metadata->>'root_event_id')::uuid
      ELSE COALESCE(root_event_id, event_id)
    END,
    causation_id = CASE
      WHEN metadata ? 'causation_id' THEN NULLIF(metadata->>'causation_id', '')::uuid
      ELSE causation_id
    END;

UPDATE bridge_events
SET payload_sha256 = lower(metadata->>'payload_digest')
WHERE payload_sha256 IS NULL
  AND metadata->>'payload_digest' ~* '^[0-9a-f]{64}$';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM bridge_events
    WHERE payload_sha256 IS NULL OR payload_sha256 !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'legacy bridge_events require a valid metadata.payload_digest before upgrade';
  END IF;
END $$;

ALTER TABLE bridge_events
  ALTER COLUMN delivery_semantics SET DEFAULT 'generated',
  ALTER COLUMN delivery_semantics SET NOT NULL,
  ALTER COLUMN mode SET DEFAULT 'observe',
  ALTER COLUMN mode SET NOT NULL,
  ALTER COLUMN root_event_id SET NOT NULL,
  ALTER COLUMN payload_sha256 SET NOT NULL;

-- \`outbound_timestamp\` is retained only for rolling-upgrade compatibility with older
-- workers. New workers ignore it and generate fresh attempt-scoped authentication.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bridge_events'::regclass
      AND conname = 'bridge_events_delivery_semantics_valid_v2'
  ) THEN
    ALTER TABLE bridge_events
      ADD CONSTRAINT bridge_events_delivery_semantics_valid_v2
      CHECK (delivery_semantics = 'generated') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bridge_events'::regclass
      AND conname = 'bridge_events_mode_valid_v2'
  ) THEN
    ALTER TABLE bridge_events
      ADD CONSTRAINT bridge_events_mode_valid_v2
      CHECK (mode IN ('observe', 'request', 'response')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bridge_events'::regclass
      AND conname = 'bridge_events_hop_bounds_v2'
  ) THEN
    ALTER TABLE bridge_events
      ADD CONSTRAINT bridge_events_hop_bounds_v2
      CHECK (hop BETWEEN 0 AND 2) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bridge_events'::regclass
      AND conname = 'bridge_events_payload_sha256_valid_v2'
  ) THEN
    ALTER TABLE bridge_events
      ADD CONSTRAINT bridge_events_payload_sha256_valid_v2
      CHECK (payload_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bridge_events'::regclass
      AND conname = 'bridge_events_status_valid_v2'
  ) THEN
    ALTER TABLE bridge_events
      ADD CONSTRAINT bridge_events_status_valid_v2
      CHECK (status IN ('pending', 'delivered', 'dead')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bridge_agents'::regclass
      AND conname = 'bridge_agents_pending_count_valid_v2'
  ) THEN
    ALTER TABLE bridge_agents
      ADD CONSTRAINT bridge_agents_pending_count_valid_v2
      CHECK (pending_count >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bridge_agents'::regclass
      AND conname = 'bridge_agents_oldest_age_valid_v2'
  ) THEN
    ALTER TABLE bridge_agents
      ADD CONSTRAINT bridge_agents_oldest_age_valid_v2
      CHECK (oldest_event_age_seconds IS NULL OR oldest_event_age_seconds >= 0) NOT VALID;
  END IF;
END $$;

ALTER TABLE bridge_events
  VALIDATE CONSTRAINT bridge_events_delivery_semantics_valid_v2,
  VALIDATE CONSTRAINT bridge_events_mode_valid_v2,
  VALIDATE CONSTRAINT bridge_events_hop_bounds_v2,
  VALIDATE CONSTRAINT bridge_events_payload_sha256_valid_v2,
  VALIDATE CONSTRAINT bridge_events_status_valid_v2;

ALTER TABLE bridge_agents
  VALIDATE CONSTRAINT bridge_agents_pending_count_valid_v2,
  VALIDATE CONSTRAINT bridge_agents_oldest_age_valid_v2;
`;

export const SCHEMA_SQL = `${CORE_SCHEMA_SQL}\n${HARDEN_LEGACY_SCHEMA_SQL}`;

type ClaimRow = {
  id: string;
  lease_token: string;
  attempt_count: number;
  event_id: string;
  target_agent: string;
  payload_key_id: string;
  payload_nonce: Buffer;
  payload_ciphertext: Buffer;
  payload_tag: Buffer;
  outbound_key_id: string | null;
  outbound_nonce: Buffer | null;
  outbound_ciphertext: Buffer | null;
  outbound_tag: Buffer | null;
};

type FrozenRequestRow = Pick<
  ClaimRow,
  'outbound_key_id' | 'outbound_nonce' | 'outbound_ciphertext' | 'outbound_tag'
>;

type ContextRow = {
  event_id: string;
  payload_key_id: string;
  payload_nonce: Buffer;
  payload_ciphertext: Buffer;
  payload_tag: Buffer;
};

export class PostgresBridgeStore implements BridgeStore, DeliveryStore {
  constructor(
    private readonly pool: Pool,
    readonly keyring: PayloadCipherKeyring,
    private readonly targets: ReadonlyMap<string, DeliveryTarget>,
  ) {}

  async migrate(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('hermes-bridge-schema'))`);
      await client.query(SCHEMA_SQL);
    });
  }

  async acceptEvent(input: AcceptedEvent): Promise<{ created: boolean; conflict?: boolean }> {
    const encrypted = this.keyring.encrypt(input.rawBody, input.event.event_id);
    const payloadSha256 = input.payloadDigest;
    return this.transaction(async (client) => {
      const inserted = await client.query<{ event_id: string }>(
        `INSERT INTO bridge_events (
           event_id, event_type, source_agent, target_agent, channel_key,
           occurred_at, received_at, delivery_semantics, mode, root_event_id,
           causation_id, hop, payload_key_id, payload_nonce, payload_ciphertext,
           payload_tag, payload_sha256, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18::jsonb
         )
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [
          input.event.event_id,
          input.event.event_type,
          input.event.source.agent_id,
          input.event.target.agent_id,
          input.event.conversation.channel_key,
          input.event.occurred_at,
          input.receivedAt,
          input.event.delivery_semantics,
          input.event.conversation.mode,
          input.event.conversation.root_event_id,
          input.event.conversation.causation_id,
          input.event.conversation.hop,
          encrypted.keyId,
          encrypted.iv,
          encrypted.ciphertext,
          encrypted.tag,
          payloadSha256,
          JSON.stringify({
            delivery_semantics: input.event.delivery_semantics,
            mode: input.event.conversation.mode,
            source_instance: input.event.source.instance_id,
          }),
        ],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{ payload_sha256: string | null }>(
          'SELECT payload_sha256 FROM bridge_events WHERE event_id = $1',
          [input.event.event_id],
        );
        const storedDigest = existing.rows[0]?.payload_sha256;
        return storedDigest === payloadSha256
          ? { created: false }
          : { created: false, conflict: true };
      }
      await client.query(
        `INSERT INTO bridge_deliveries (event_id, target_agent, available_at)
         VALUES ($1, $2, $3)`,
        [input.event.event_id, input.event.target.agent_id, input.receivedAt],
      );
      return { created: true };
    });
  }

  async guardIngress(input: IngressGuardInput): Promise<IngressGuardResult> {
    return this.transaction(async (client) => {
      if (input.replayKey) {
        if (!input.replayExpiresAt) {
          throw new Error('replayExpiresAt is required with replayKey');
        }
        await client.query('DELETE FROM bridge_ingress_replays WHERE expires_at <= $1', [
          input.now,
        ]);
        const replay = await client.query(
          `INSERT INTO bridge_ingress_replays (replay_key, expires_at)
           VALUES ($1, $2)
           ON CONFLICT (replay_key) DO NOTHING
           RETURNING replay_key`,
          [input.replayKey, input.replayExpiresAt],
        );
        if (replay.rowCount === 0) {
          return 'replayed';
        }
      }

      const rate = await client.query(
        `INSERT INTO bridge_rate_limits (agent_id, bucket_second, request_count)
         VALUES ($1, $2, 1)
         ON CONFLICT (agent_id, bucket_second) DO UPDATE SET
           request_count = bridge_rate_limits.request_count + 1
         WHERE bridge_rate_limits.request_count < $3
         RETURNING request_count`,
        [input.agentId, input.bucketSecond, input.rateLimit],
      );
      await client.query('DELETE FROM bridge_rate_limits WHERE bucket_second < $1', [
        input.bucketSecond - 2,
      ]);
      return rate.rowCount === 0 ? 'rate_limited' : 'accepted';
    });
  }

  async recordHeartbeat(input: HeartbeatInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO bridge_agents (
         agent_id, instance_id, version, capabilities, pending_count,
         oldest_event_age_seconds, last_seen_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (agent_id) DO UPDATE SET
         instance_id = EXCLUDED.instance_id,
         version = EXCLUDED.version,
         capabilities = EXCLUDED.capabilities,
         pending_count = EXCLUDED.pending_count,
         oldest_event_age_seconds = EXCLUDED.oldest_event_age_seconds,
         last_seen_at = EXCLUDED.last_seen_at,
         updated_at = now()`,
      [
        input.agentId,
        input.instanceId,
        input.pluginVersion,
        JSON.stringify([]),
        input.pendingCount,
        input.oldestEventAgeSeconds,
        input.receivedAt,
      ],
    );
  }

  async readiness(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async claim(limit: number, leaseSeconds: number, now: Date): Promise<ClaimedDelivery[]> {
    const result = await this.pool.query<ClaimRow>(
      `WITH candidates AS (
         SELECT delivery.id
         FROM bridge_deliveries AS delivery
         JOIN bridge_events AS event ON event.event_id = delivery.event_id
         WHERE (
           (delivery.status = 'pending' AND delivery.available_at <= $1)
           OR (delivery.status = 'sending' AND delivery.lease_until <= $1)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM bridge_deliveries AS active_delivery
           JOIN bridge_events AS active_event
             ON active_event.event_id = active_delivery.event_id
           WHERE active_event.channel_key = event.channel_key
             AND active_delivery.id <> delivery.id
             AND active_delivery.status = 'sending'
             AND active_delivery.lease_until > $1
         )
         AND NOT EXISTS (
           SELECT 1
           FROM bridge_deliveries AS earlier_delivery
           JOIN bridge_events AS earlier_event
             ON earlier_event.event_id = earlier_delivery.event_id
           WHERE earlier_event.channel_key = event.channel_key
             AND (
               earlier_delivery.status = 'pending'
               OR (
                 earlier_delivery.status = 'sending'
                 AND (earlier_delivery.lease_until IS NULL OR earlier_delivery.lease_until <= $1)
               )
             )
             AND (earlier_event.received_at, earlier_delivery.id)
               < (event.received_at, delivery.id)
         )
         ORDER BY event.received_at, delivery.id
         FOR UPDATE OF delivery SKIP LOCKED
         LIMIT $2
       ), claimed AS (
         UPDATE bridge_deliveries AS delivery
         SET status = 'sending',
             attempt_count = delivery.attempt_count + 1,
             lease_until = $1 + ($3 * interval '1 second'),
             lease_token = gen_random_uuid(),
             updated_at = $1
         FROM candidates
         WHERE delivery.id = candidates.id
         RETURNING delivery.*
       )
       SELECT claimed.id::text, claimed.lease_token::text, claimed.attempt_count,
              claimed.event_id::text, claimed.target_agent, event.payload_key_id,
              event.payload_nonce, event.payload_ciphertext, event.payload_tag,
              claimed.outbound_key_id,
              claimed.outbound_nonce, claimed.outbound_ciphertext, claimed.outbound_tag
       FROM claimed
       JOIN bridge_events AS event ON event.event_id = claimed.event_id
       ORDER BY claimed.id`,
      [now, limit, leaseSeconds],
    );

    return result.rows.map((row) => {
      const target = this.targets.get(row.target_agent);
      if (!target) {
        throw new Error(`Missing delivery target for agent ${row.target_agent}`);
      }
      const rawBody = this.keyring.decrypt(
        {
          keyId: row.payload_key_id,
          iv: row.payload_nonce,
          ciphertext: row.payload_ciphertext,
          tag: row.payload_tag,
        },
        row.event_id,
      );
      const frozenFields = [
        row.outbound_key_id,
        row.outbound_nonce,
        row.outbound_ciphertext,
        row.outbound_tag,
      ];
      const hasFrozenField = frozenFields.some((value) => value !== null);
      const hasCompleteFrozenRequest = frozenFields.every((value) => value !== null);
      if (hasFrozenField && !hasCompleteFrozenRequest) {
        throw new Error(`Incomplete frozen delivery request for ${row.id}`);
      }
      const frozenRequest = hasCompleteFrozenRequest
        ? {
            rawBody: this.keyring.decrypt(
              {
                keyId: row.outbound_key_id as string,
                iv: row.outbound_nonce as Buffer,
                ciphertext: row.outbound_ciphertext as Buffer,
                tag: row.outbound_tag as Buffer,
              },
              `delivery:${row.id}`,
            ),
          }
        : undefined;
      return {
        id: row.id,
        leaseToken: row.lease_token,
        event: JSON.parse(rawBody.toString('utf8')) as BridgeEvent,
        target,
        attempt: row.attempt_count,
        ...(frozenRequest ? { frozenRequest } : {}),
      };
    });
  }

  async recentContext(event: BridgeEvent, limit: number): Promise<RecentMessage[]> {
    const result = await this.pool.query<ContextRow>(
      `SELECT event_id::text, payload_key_id, payload_nonce,
              payload_ciphertext, payload_tag
       FROM bridge_events
       WHERE channel_key = $1
         AND status = 'delivered'
         AND event_id <> $2
         AND occurred_at <= $3
       ORDER BY occurred_at DESC, event_id DESC
       LIMIT $4`,
      [event.conversation.channel_key, event.event_id, event.occurred_at, limit],
    );
    return result.rows
      .map((row) => {
        const raw = this.keyring.decrypt(
          {
            keyId: row.payload_key_id,
            iv: row.payload_nonce,
            ciphertext: row.payload_ciphertext,
            tag: row.payload_tag,
          },
          row.event_id,
        );
        const stored = JSON.parse(raw.toString('utf8')) as BridgeEvent;
        return {
          agent_id: stored.source.agent_id,
          mode: stored.conversation.mode,
          text: stored.message.text,
          occurred_at: stored.occurred_at,
        } satisfies RecentMessage;
      })
      .reverse();
  }

  async freezeRequest(
    id: string,
    leaseToken: string,
    request: FrozenDeliveryRequest,
  ): Promise<FrozenDeliveryRequest | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<FrozenRequestRow>(
        `SELECT outbound_key_id, outbound_nonce, outbound_ciphertext, outbound_tag
         FROM bridge_deliveries
         WHERE id = $1 AND status = 'sending' AND lease_token = $2
           AND lease_until > clock_timestamp()
         FOR UPDATE`,
        [id, leaseToken],
      );
      const row = selected.rows[0];
      if (!row) {
        return null;
      }
      const fields = [
        row.outbound_key_id,
        row.outbound_nonce,
        row.outbound_ciphertext,
        row.outbound_tag,
      ];
      const hasAny = fields.some((value) => value !== null);
      const complete = fields.every((value) => value !== null);
      if (hasAny && !complete) {
        throw new Error(`Incomplete frozen delivery request for ${id}`);
      }
      if (complete) {
        return {
          rawBody: this.keyring.decrypt(
            {
              keyId: row.outbound_key_id as string,
              iv: row.outbound_nonce as Buffer,
              ciphertext: row.outbound_ciphertext as Buffer,
              tag: row.outbound_tag as Buffer,
            },
            `delivery:${id}`,
          ),
        };
      }

      const encrypted = this.keyring.encrypt(request.rawBody, `delivery:${id}`);
      await client.query(
        `UPDATE bridge_deliveries
         SET outbound_key_id = $3, outbound_nonce = $4,
             outbound_ciphertext = $5, outbound_tag = $6, updated_at = clock_timestamp()
         WHERE id = $1 AND lease_token = $2 AND status = 'sending'`,
        [id, leaseToken, encrypted.keyId, encrypted.iv, encrypted.ciphertext, encrypted.tag],
      );
      return request;
    });
  }

  async renewLease(id: string, leaseToken: string, leaseSeconds: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bridge_deliveries
       SET lease_until = clock_timestamp() + ($3 * interval '1 second'),
           updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'sending' AND lease_token = $2
         AND lease_until > clock_timestamp()`,
      [id, leaseToken, leaseSeconds],
    );
    return result.rowCount === 1;
  }

  async markDelivered(
    id: string,
    leaseToken: string,
    statusCode: number,
    deliveredAt: Date,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const delivery = await client.query<{ event_id: string }>(
        `UPDATE bridge_deliveries
         SET status = 'delivered', delivered_at = $3, lease_until = NULL,
             lease_token = NULL, last_status_code = $4, last_error = NULL, updated_at = $3
         WHERE id = $1 AND status = 'sending' AND lease_token = $2
         RETURNING event_id::text`,
        [id, leaseToken, deliveredAt, statusCode],
      );
      const eventId = delivery.rows[0]?.event_id;
      if (!eventId) {
        return false;
      }
      await client.query(`UPDATE bridge_events SET status = 'delivered' WHERE event_id = $1`, [
        eventId,
      ]);
      return true;
    });
  }

  async reschedule(
    id: string,
    leaseToken: string,
    availableAt: Date,
    error: string,
    statusCode?: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bridge_deliveries
       SET status = 'pending', available_at = $3, lease_until = NULL, lease_token = NULL,
           last_error = $4, last_status_code = $5, updated_at = now()
       WHERE id = $1 AND status = 'sending' AND lease_token = $2`,
      [id, leaseToken, availableAt, error.slice(0, 512), statusCode ?? null],
    );
    return result.rowCount === 1;
  }

  async moveToDeadLetter(
    id: string,
    leaseToken: string,
    reason: string,
    statusCode?: number,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const delivery = await client.query<{ event_id: string }>(
        `UPDATE bridge_deliveries
         SET status = 'dead', lease_until = NULL, lease_token = NULL, last_error = $3,
             last_status_code = $4, updated_at = now()
         WHERE id = $1 AND status = 'sending' AND lease_token = $2
         RETURNING event_id::text`,
        [id, leaseToken, reason.slice(0, 512), statusCode ?? null],
      );
      const eventId = delivery.rows[0]?.event_id;
      if (!eventId) {
        return false;
      }
      await client.query(`UPDATE bridge_events SET status = 'dead' WHERE event_id = $1`, [eventId]);
      await client.query(
        `INSERT INTO bridge_dead_letters (delivery_id, event_id, reason, status_code)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (delivery_id) DO NOTHING`,
        [id, eventId, reason.slice(0, 512), statusCode ?? null],
      );
      return true;
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
