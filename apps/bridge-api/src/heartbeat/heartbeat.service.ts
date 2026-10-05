import { createHash } from 'node:crypto';
import { authenticateAgent } from '../auth/authenticate.js';
import type { BridgeOptions } from '../config.js';
import { BridgeError } from '../errors.js';

const INSTANCE_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

type HeartbeatPayload = {
  instance_id: string;
  plugin_version: string;
  pending_count: number;
  oldest_event_age_seconds: number | null;
};

function parseHeartbeat(rawBody: Buffer): HeartbeatPayload {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new BridgeError(400, 'invalid_json');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BridgeError(422, 'invalid_heartbeat');
  }
  const record = value as Record<string, unknown>;
  const expected = new Set([
    'instance_id',
    'plugin_version',
    'pending_count',
    'oldest_event_age_seconds',
  ]);
  if (
    Object.keys(record).length !== expected.size ||
    Object.keys(record).some((key) => !expected.has(key))
  ) {
    throw new BridgeError(422, 'invalid_heartbeat');
  }
  const oldestAge = record.oldest_event_age_seconds;
  if (
    typeof record.instance_id !== 'string' ||
    !INSTANCE_PATTERN.test(record.instance_id) ||
    typeof record.plugin_version !== 'string' ||
    !VERSION_PATTERN.test(record.plugin_version) ||
    typeof record.pending_count !== 'number' ||
    !Number.isSafeInteger(record.pending_count) ||
    record.pending_count < 0 ||
    !(
      oldestAge === null ||
      (typeof oldestAge === 'number' && Number.isFinite(oldestAge) && oldestAge >= 0)
    )
  ) {
    throw new BridgeError(422, 'invalid_heartbeat');
  }
  return {
    instance_id: record.instance_id,
    plugin_version: record.plugin_version,
    pending_count: record.pending_count,
    oldest_event_age_seconds: oldestAge,
  };
}

export class HeartbeatService {
  constructor(private readonly options: BridgeOptions) {}

  async handle(
    agentId: string | undefined,
    timestamp: string | undefined,
    signature: string | undefined,
    rawBody: Buffer,
  ): Promise<void> {
    if (rawBody.length > this.options.maxBodyBytes) {
      throw new BridgeError(413, 'body_too_large');
    }
    const authenticated = authenticateAgent(
      { agentId, timestamp, signature, rawBody },
      this.options,
    );
    const receivedAt = this.options.now();
    const replayKey = createHash('sha256')
      .update(authenticated.agentId)
      .update('\0')
      .update(timestamp ?? '')
      .update('\0')
      .update(rawBody)
      .digest('hex');
    const guard = await this.options.store.guardIngress({
      agentId: authenticated.agentId,
      bucketSecond: Math.floor(receivedAt.getTime() / 1000),
      rateLimit: this.options.rateLimitPerSecond,
      replayKey,
      replayExpiresAt: new Date(receivedAt.getTime() + this.options.replayWindowSeconds * 1000),
      now: receivedAt,
    });
    if (guard === 'replayed') {
      throw new BridgeError(409, 'replay_detected');
    }
    if (guard === 'rate_limited') {
      throw new BridgeError(429, 'rate_limit_exceeded');
    }

    const payload = parseHeartbeat(rawBody);
    await this.options.store.recordHeartbeat({
      agentId: authenticated.agentId,
      instanceId: payload.instance_id,
      pluginVersion: payload.plugin_version,
      pendingCount: payload.pending_count,
      oldestEventAgeSeconds: payload.oldest_event_age_seconds,
      receivedAt,
    });
  }
}
