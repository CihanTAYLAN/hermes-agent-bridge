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

-- `outbound_timestamp` is retained only for rolling-upgrade compatibility with older
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
