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
