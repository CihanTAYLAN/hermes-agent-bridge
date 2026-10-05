import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../src/runtime-config.js';

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORT: '8080',
    DATABASE_URL: 'postgresql://localhost/bridge',
    BRIDGE_PAYLOAD_KEY_VERSION: 'v1',
    BRIDGE_PAYLOAD_KEY_V1_BASE64: Buffer.alloc(32, 1).toString('base64'),
    BRIDGE_AGENT_ALPHA_ACTIVE_SECRET: 'alpha-ingest-secret',
    BRIDGE_AGENT_ALPHA_PREVIOUS_SECRET: '',
    BRIDGE_AGENT_BETA_ACTIVE_SECRET: 'beta-ingest-secret',
    BRIDGE_TO_ALPHA_WEBHOOK_URL: 'http://alpha.test/webhooks/peer-beta',
    BRIDGE_TO_ALPHA_WEBHOOK_ACTIVE_SECRET: 'alpha-delivery-secret',
    BRIDGE_TO_BETA_WEBHOOK_URL: 'http://beta.test/webhooks/peer-alpha',
    BRIDGE_TO_BETA_WEBHOOK_ACTIVE_SECRET: 'beta-delivery-secret',
    BRIDGE_REQUESTS_ENABLED: 'false',
    BRIDGE_MAX_BODY_BYTES: '65536',
    BRIDGE_REPLAY_WINDOW_SECONDS: '300',
    BRIDGE_RATE_LIMIT_PER_SECOND: '24',
    BRIDGE_METRICS_TOKEN: 'metrics-secret',
  };
}

describe('loadRuntimeConfig', () => {
  it('builds the fixed agent registry, delivery targets, and safe worker defaults', () => {
    const config = loadRuntimeConfig(validEnv());

    expect(config.port).toBe(8080);
    expect(config.databaseUrl).toBe('postgresql://localhost/bridge');
    expect(config.agents.get('alpha')).toEqual({
      agentId: 'alpha',
      activeSecret: 'alpha-ingest-secret',
      previousSecret: undefined,
      webhookUrl: 'http://alpha.test/webhooks/peer-beta',
      webhookSecret: 'alpha-delivery-secret',
    });
    expect(config.targets.get('beta')).toEqual({
      url: 'http://beta.test/webhooks/peer-alpha',
      webhookSecret: 'beta-delivery-secret',
    });
    expect(config.requestsEnabled).toBe(false);
    expect(config.rateLimitPerSecond).toBe(24);
    expect(config.worker).toEqual({
      pollIntervalMs: 250,
      deliveryTimeoutMs: 10_000,
      batchSize: 10,
      leaseSeconds: 30,
      maxAttempts: 4,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
    });
  });

  it('loads the previous payload key for decrypt-only rotation', () => {
    const env = validEnv();
    env.BRIDGE_PAYLOAD_PREVIOUS_KEY_VERSION = 'v0';
    env.BRIDGE_PAYLOAD_KEY_V0_BASE64 = Buffer.alloc(32, 2).toString('base64');
    const config = loadRuntimeConfig(env);
    const encrypted = config.keyring.encrypt(Buffer.from('current'), 'event-current');

    expect(encrypted.keyId).toBe('v1');
  });

  it.each([
    ['PORT', '0'],
    ['BRIDGE_MAX_BODY_BYTES', '12.5'],
    ['BRIDGE_REPLAY_WINDOW_SECONDS', '-1'],
    ['BRIDGE_RATE_LIMIT_PER_SECOND', '0'],
  ])('rejects invalid positive integer %s', (name, value) => {
    const env = validEnv();
    env[name] = value;

    expect(() => loadRuntimeConfig(env)).toThrow(name);
  });

  it('rejects a malformed or non-32-byte payload key without echoing the value', () => {
    const env = validEnv();
    env.BRIDGE_PAYLOAD_KEY_V1_BASE64 = 'not-a-secret-key';

    expect(() => loadRuntimeConfig(env)).toThrow('BRIDGE_PAYLOAD_KEY_V1_BASE64');
    try {
      loadRuntimeConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain('not-a-secret-key');
    }
  });

  it('requires paired previous payload key variables', () => {
    const env = validEnv();
    env.BRIDGE_PAYLOAD_PREVIOUS_KEY_VERSION = 'v0';

    expect(() => loadRuntimeConfig(env)).toThrow('BRIDGE_PAYLOAD_KEY_V0_BASE64');
  });

  it('rejects receiptless interactive mode even when explicitly requested', () => {
    const env = validEnv();
    env.BRIDGE_REQUESTS_ENABLED = 'true';

    expect(() => loadRuntimeConfig(env)).toThrow('durable completion receipts');
  });

  it('requires HTTPS delivery targets outside test and development', () => {
    const env = validEnv();
    env.NODE_ENV = 'production';

    expect(() => loadRuntimeConfig(env)).toThrow('HTTPS');

    env.BRIDGE_TO_ALPHA_WEBHOOK_URL = 'https://alpha.test/webhooks/peer-beta';
    env.BRIDGE_TO_BETA_WEBHOOK_URL = 'https://beta.test/webhooks/peer-alpha';
    expect(() => loadRuntimeConfig(env)).not.toThrow();
  });

  it('fails closed on unsupported booleans and delivery URL schemes', () => {
    const booleanEnv = validEnv();
    booleanEnv.BRIDGE_REQUESTS_ENABLED = 'yes';
    expect(() => loadRuntimeConfig(booleanEnv)).toThrow('BRIDGE_REQUESTS_ENABLED');

    const urlEnv = validEnv();
    urlEnv.BRIDGE_TO_ALPHA_WEBHOOK_URL = 'file:///tmp/capture';
    expect(() => loadRuntimeConfig(urlEnv)).toThrow('BRIDGE_TO_ALPHA_WEBHOOK_URL');
  });

  it('requires the delivery lease to outlive the transport timeout with safety margin', () => {
    const env = validEnv();
    env.BRIDGE_DELIVERY_TIMEOUT_MS = '10000';
    env.BRIDGE_WORKER_LEASE_SECONDS = '10';

    expect(() => loadRuntimeConfig(env)).toThrow('BRIDGE_WORKER_LEASE_SECONDS');
  });
});
