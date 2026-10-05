import { Counter, Registry } from 'prom-client';

export class BridgeMetrics {
  private readonly registry = new Registry();
  private readonly received = new Counter({
    name: 'bridge_events_received_total',
    help: 'Accepted bridge event requests',
    registers: [this.registry],
  });
  private readonly rejected = new Counter({
    name: 'bridge_events_rejected_total',
    help: 'Rejected bridge event requests',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  readonly contentType = this.registry.contentType;

  eventReceived(): void {
    this.received.inc();
  }

  eventRejected(reason: string): void {
    this.rejected.inc({ reason });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
