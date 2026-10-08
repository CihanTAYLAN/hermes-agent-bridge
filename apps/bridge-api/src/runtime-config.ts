import { isIP } from 'node:net';
import type { AgentConfig } from './config.js';
import { PayloadCipher, PayloadCipherKeyring } from './crypto/payload-cipher.js';
import type { DeliveryTarget } from './worker/delivery-worker.js';

export type WorkerRuntimeConfig = {
  pollIntervalMs: number;
  deliveryTimeoutMs: number;
  batchSize: number;
  leaseSeconds: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type RuntimeConfig = {
  port: number;
  databaseUrl: string;
  agents: Map<string, AgentConfig>;
  targets: Map<string, DeliveryTarget>;
  keyring: PayloadCipherKeyring;
  requestsEnabled: boolean;
  replayWindowSeconds: number;
  maxBodyBytes: number;
  rateLimitPerSecond: number;
  metricsToken: string;
  worker: WorkerRuntimeConfig;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name] || undefined;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid positive integer environment variable: ${name}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid positive integer environment variable: ${name}`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`Invalid boolean environment variable: ${name}`);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    (isIP(normalized) === 4 && normalized.startsWith('127.')) ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1'
  );
}

function httpUrl(env: NodeJS.ProcessEnv, name: string): string {
  const raw = required(env, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid HTTP URL environment variable: ${name}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`Invalid HTTP URL environment variable: ${name}`);
  }
  if (parsed.protocol === 'http:') {
    const devOnly = env.NODE_ENV === 'development';
    const loopbackAllowed =
      boolean(env, 'BRIDGE_ALLOW_INSECURE_LOOPBACK_HTTP', false) &&
      isLoopbackHostname(parsed.hostname);
    const localComposeAllowed =
      boolean(env, 'BRIDGE_ALLOW_INSECURE_LOCAL_COMPOSE_HTTP', false) &&
      ((name === 'BRIDGE_TO_ALPHA_WEBHOOK_URL' &&
        parsed.hostname === 'mock-alpha' &&
        parsed.port === '8080') ||
        (name === 'BRIDGE_TO_BETA_WEBHOOK_URL' &&
          parsed.hostname === 'mock-beta' &&
          parsed.port === '8080'));
    if (!devOnly || (!loopbackAllowed && !localComposeAllowed)) {
      throw new Error(`HTTPS URL required for environment variable: ${name}`);
    }
  }
  return parsed.toString();
}

function payloadCipher(env: NodeJS.ProcessEnv, version: string): PayloadCipher {
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new Error('Invalid payload key version');
  }
  const name = `BRIDGE_PAYLOAD_KEY_${version.toUpperCase()}_BASE64`;
  const encoded = required(env, name);
  if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(encoded)) {
    throw new Error(`Invalid 32-byte base64 environment variable: ${name}`);
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error(`Invalid 32-byte base64 environment variable: ${name}`);
  }
  return new PayloadCipher(key, version);
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const alphaWebhookUrl = httpUrl(env, 'BRIDGE_TO_ALPHA_WEBHOOK_URL');
  const alphaWebhookSecret = required(env, 'BRIDGE_TO_ALPHA_WEBHOOK_ACTIVE_SECRET');
  const betaWebhookUrl = httpUrl(env, 'BRIDGE_TO_BETA_WEBHOOK_URL');
  const betaWebhookSecret = required(env, 'BRIDGE_TO_BETA_WEBHOOK_ACTIVE_SECRET');
  const currentVersion = required(env, 'BRIDGE_PAYLOAD_KEY_VERSION');
  const current = payloadCipher(env, currentVersion);
  const previousVersion = optional(env, 'BRIDGE_PAYLOAD_PREVIOUS_KEY_VERSION');
  const previous = previousVersion ? [payloadCipher(env, previousVersion)] : [];
  const requestsEnabled = boolean(env, 'BRIDGE_REQUESTS_ENABLED', false);
  if (requestsEnabled) {
    throw new Error(
      'BRIDGE_REQUESTS_ENABLED: request/response mode requires durable completion receipts and is not implemented',
    );
  }

  const agents = new Map<string, AgentConfig>([
    [
      'alpha',
      {
        agentId: 'alpha',
        activeSecret: required(env, 'BRIDGE_AGENT_ALPHA_ACTIVE_SECRET'),
        previousSecret: optional(env, 'BRIDGE_AGENT_ALPHA_PREVIOUS_SECRET'),
        webhookUrl: alphaWebhookUrl,
        webhookSecret: alphaWebhookSecret,
      },
    ],
    [
      'beta',
      {
        agentId: 'beta',
        activeSecret: required(env, 'BRIDGE_AGENT_BETA_ACTIVE_SECRET'),
        previousSecret: optional(env, 'BRIDGE_AGENT_BETA_PREVIOUS_SECRET'),
        webhookUrl: betaWebhookUrl,
        webhookSecret: betaWebhookSecret,
      },
    ],
  ]);

  const worker: WorkerRuntimeConfig = {
    pollIntervalMs: positiveInteger(env, 'BRIDGE_WORKER_POLL_INTERVAL_MS', 250),
    deliveryTimeoutMs: positiveInteger(env, 'BRIDGE_DELIVERY_TIMEOUT_MS', 10_000),
    batchSize: positiveInteger(env, 'BRIDGE_WORKER_BATCH_SIZE', 10),
    leaseSeconds: positiveInteger(env, 'BRIDGE_WORKER_LEASE_SECONDS', 30),
    maxAttempts: positiveInteger(env, 'BRIDGE_WORKER_MAX_ATTEMPTS', 4),
    baseDelayMs: positiveInteger(env, 'BRIDGE_WORKER_BASE_DELAY_MS', 1_000),
    maxDelayMs: positiveInteger(env, 'BRIDGE_WORKER_MAX_DELAY_MS', 60_000),
  };
  const leaseSafetyMarginMs = Math.max(1_000, worker.pollIntervalMs * 2);
  if (worker.leaseSeconds * 1_000 <= worker.deliveryTimeoutMs + leaseSafetyMarginMs) {
    throw new Error(
      'BRIDGE_WORKER_LEASE_SECONDS must outlive BRIDGE_DELIVERY_TIMEOUT_MS plus safety margin',
    );
  }

  return {
    port: positiveInteger(env, 'PORT', 8080),
    databaseUrl: required(env, 'DATABASE_URL'),
    agents,
    targets: new Map<string, DeliveryTarget>([
      ['alpha', { url: alphaWebhookUrl, webhookSecret: alphaWebhookSecret }],
      ['beta', { url: betaWebhookUrl, webhookSecret: betaWebhookSecret }],
    ]),
    keyring: new PayloadCipherKeyring(current, previous),
    requestsEnabled,
    replayWindowSeconds: positiveInteger(env, 'BRIDGE_REPLAY_WINDOW_SECONDS', 300),
    maxBodyBytes: positiveInteger(env, 'BRIDGE_MAX_BODY_BYTES', 65_536),
    rateLimitPerSecond: positiveInteger(env, 'BRIDGE_RATE_LIMIT_PER_SECOND', 30),
    metricsToken: required(env, 'BRIDGE_METRICS_TOKEN'),
    worker,
  };
}
