export type WorkerPoller = {
  runOnce(): Promise<number>;
};

export type DeliveryWorkerRunnerOptions = {
  pollIntervalMs: number;
  healthTimeoutMs?: number;
  maxPollDurationMs?: number;
  now?: () => number;
  onError?: (category: 'delivery_worker_poll_failed') => void;
};

export class DeliveryWorkerRunner {
  private running = false;
  private activePoll: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSuccessfulPollAt: number | undefined;
  private pollStartedAt: number | undefined;
  private pollFailed = false;
  private readonly healthTimeoutMs: number;
  private readonly maxPollDurationMs: number;
  private readonly now: () => number;

  constructor(
    private readonly worker: WorkerPoller,
    private readonly options: DeliveryWorkerRunnerOptions,
  ) {
    if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
      throw new Error('worker poll interval must be a positive integer');
    }
    this.healthTimeoutMs = options.healthTimeoutMs ?? options.pollIntervalMs * 4;
    if (!Number.isInteger(this.healthTimeoutMs) || this.healthTimeoutMs <= options.pollIntervalMs) {
      throw new Error('worker health timeout must exceed the poll interval');
    }
    this.maxPollDurationMs = options.maxPollDurationMs ?? this.healthTimeoutMs;
    if (
      !Number.isInteger(this.maxPollDurationMs) ||
      this.maxPollDurationMs <= options.pollIntervalMs
    ) {
      throw new Error('worker max poll duration must exceed the poll interval');
    }
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.pollFailed = false;
    this.lastSuccessfulPollAt = undefined;
    this.activePoll = this.poll();
  }

  isReady(): boolean {
    if (!this.running || this.pollFailed || this.lastSuccessfulPollAt === undefined) {
      return false;
    }
    if (this.pollStartedAt !== undefined) {
      return this.now() - this.pollStartedAt <= this.maxPollDurationMs;
    }
    return this.now() - this.lastSuccessfulPollAt <= this.healthTimeoutMs;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.activePoll;
  }

  private async poll(): Promise<void> {
    this.pollStartedAt = this.now();
    try {
      await this.worker.runOnce();
      this.lastSuccessfulPollAt = this.now();
      this.pollFailed = false;
    } catch {
      this.pollFailed = true;
      this.options.onError?.('delivery_worker_poll_failed');
    } finally {
      this.pollStartedAt = undefined;
      if (this.running) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.activePoll = this.poll();
        }, this.options.pollIntervalMs);
      }
    }
  }
}
