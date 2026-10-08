import { describe, expect, it, vi } from 'vitest';
import { DeliveryWorkerRunner } from '../src/worker/delivery-worker-runner.js';

function deferred(): { promise: Promise<number>; resolve: (value: number) => void } {
  let resolve: (value: number) => void = () => undefined;
  const promise = new Promise<number>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('DeliveryWorkerRunner', () => {
  it('never overlaps polls and waits for the active poll during graceful stop', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const runOnce = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(0);
    const runner = new DeliveryWorkerRunner({ runOnce }, { pollIntervalMs: 250 });

    runner.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runOnce).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    first.resolve(1);
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runOnce).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('reports a category-only poll failure and continues on the next interval', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const runOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('sensitive payload'))
      .mockResolvedValue(0);
    const runner = new DeliveryWorkerRunner({ runOnce }, { pollIntervalMs: 100, onError });

    runner.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(onError).toHaveBeenCalledWith('delivery_worker_poll_failed');
    expect(runOnce).toHaveBeenCalledTimes(2);

    await runner.stop();
    vi.useRealTimers();
  });

  it('keeps readiness true for a healthy in-flight poll up to the configured poll deadline', async () => {
    vi.useFakeTimers();
    let now = 0;
    const second = deferred();
    const runOnce = vi.fn().mockResolvedValueOnce(0).mockReturnValue(second.promise);
    const runner = new DeliveryWorkerRunner(
      { runOnce },
      {
        pollIntervalMs: 100,
        healthTimeoutMs: 300,
        maxPollDurationMs: 5_000,
        now: () => now,
      },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.isReady()).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(runOnce).toHaveBeenCalledTimes(2);
    now = 401;
    expect(runner.isReady()).toBe(true);

    now = 5_101;
    expect(runner.isReady()).toBe(false);
    second.resolve(0);
    await runner.stop();
    vi.useRealTimers();
  });

  it('stays unready until a successful poll and becomes stale without recovery polls', async () => {
    vi.useFakeTimers();
    let now = 0;
    const first = deferred();
    const runner = new DeliveryWorkerRunner(
      { runOnce: vi.fn().mockReturnValue(first.promise) },
      { pollIntervalMs: 100, healthTimeoutMs: 300, now: () => now },
    );

    runner.start();
    expect(runner.isReady()).toBe(false);
    first.resolve(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.isReady()).toBe(true);

    now = 301;
    expect(runner.isReady()).toBe(false);
    await runner.stop();
    expect(runner.isReady()).toBe(false);
    vi.useRealTimers();
  });

  it('requires a fresh successful poll after a stopped runner starts again', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const runOnce = vi.fn().mockResolvedValueOnce(0).mockReturnValueOnce(pending.promise);
    const runner = new DeliveryWorkerRunner(
      { runOnce },
      { pollIntervalMs: 100, healthTimeoutMs: 300 },
    );

    try {
      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.isReady()).toBe(true);
      await runner.stop();
      runner.start();
      expect(runner.isReady()).toBe(false);
      pending.resolve(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.isReady()).toBe(true);
    } finally {
      pending.resolve(0);
      await runner.stop();
      vi.useRealTimers();
    }
  });
});
