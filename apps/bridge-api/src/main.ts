import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createBridgeApp } from './app.js';
import { loadRuntimeConfig, type RuntimeConfig } from './runtime-config.js';
import { PostgresBridgeStore } from './storage/postgres-store.js';
import { DeliveryWorker } from './worker/delivery-worker.js';
import { DeliveryWorkerRunner } from './worker/delivery-worker-runner.js';
import { FetchDeliveryTransport } from './worker/fetch-delivery-transport.js';

export type BridgeRuntime = {
  close(): Promise<void>;
};

export async function startBridgeRuntime(config: RuntimeConfig): Promise<BridgeRuntime> {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const store = new PostgresBridgeStore(pool, config.keyring, config.targets);
  let app: Awaited<ReturnType<typeof createBridgeApp>> | undefined;
  let runner: DeliveryWorkerRunner | undefined;

  try {
    await store.migrate();
    const worker = new DeliveryWorker(
      store,
      new FetchDeliveryTransport(config.worker.deliveryTimeoutMs),
      {
        batchSize: config.worker.batchSize,
        leaseSeconds: config.worker.leaseSeconds,
        maxAttempts: config.worker.maxAttempts,
        baseDelayMs: config.worker.baseDelayMs,
        maxDelayMs: config.worker.maxDelayMs,
        now: () => new Date(),
        random: Math.random,
      },
    );
    runner = new DeliveryWorkerRunner(worker, {
      pollIntervalMs: config.worker.pollIntervalMs,
      maxPollDurationMs: config.worker.leaseSeconds * 1_000 + config.worker.pollIntervalMs * 2,
      onError: (category) => process.stderr.write(`${category}\n`),
    });
    const createdApp = await createBridgeApp({
      agents: config.agents,
      store,
      requestsEnabled: config.requestsEnabled,
      replayWindowSeconds: config.replayWindowSeconds,
      maxBodyBytes: config.maxBodyBytes,
      rateLimitPerSecond: config.rateLimitPerSecond,
      metricsToken: config.metricsToken,
      runtimeReadiness: () => runner?.isReady() ?? false,
      now: () => new Date(),
    });

    app = createdApp;
    await createdApp.listen({ host: '0.0.0.0', port: config.port });
    runner.start();
  } catch (error) {
    await runner?.stop();
    await app?.close();
    await pool.end();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    close(): Promise<void> {
      if (!closing) {
        closing = (async () => {
          await runner?.stop();
          await app?.close();
          await pool.end();
        })();
      }
      return closing;
    },
  };
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.env);
  const runtime = await startBridgeRuntime(config);
  process.stdout.write(`bridge_api_listening port=${config.port}\n`);

  const shutdown = (): void => {
    void runtime.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch(() => {
    process.stderr.write('bridge_api_startup_failed\n');
    process.exitCode = 1;
  });
}
