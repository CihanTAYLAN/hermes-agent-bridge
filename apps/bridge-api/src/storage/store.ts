import type { BridgeEvent } from '../domain.js';

export type AcceptedEvent = {
  event: BridgeEvent;
  rawBody: Buffer;
  payloadDigest: string;
  receivedAt: Date;
};

export type HeartbeatInput = {
  agentId: string;
  instanceId: string;
  pluginVersion: string;
  pendingCount: number;
  oldestEventAgeSeconds: number | null;
  receivedAt: Date;
};

export type IngressGuardInput = {
  agentId: string;
  bucketSecond: number;
  rateLimit: number;
  replayKey?: string;
  replayExpiresAt?: Date;
  now: Date;
};

export type IngressGuardResult = 'accepted' | 'rate_limited' | 'replayed';

export interface BridgeStore {
  acceptEvent(input: AcceptedEvent): Promise<{ created: boolean; conflict?: boolean }>;
  guardIngress(input: IngressGuardInput): Promise<IngressGuardResult>;
  recordHeartbeat(input: HeartbeatInput): Promise<void>;
  readiness(): Promise<boolean>;
}
