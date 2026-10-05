import type { BridgeStore } from './storage/store.js';

export type AgentConfig = {
  agentId: string;
  activeSecret: string;
  previousSecret: string | undefined;
  webhookUrl: string;
  webhookSecret: string;
};

export type BridgeOptions = {
  agents: Map<string, AgentConfig>;
  store: BridgeStore;
  now: () => Date;
  requestsEnabled: boolean;
  replayWindowSeconds: number;
  maxBodyBytes: number;
  rateLimitPerSecond: number;
  metricsToken: string;
  runtimeReadiness: () => boolean;
};

export const BRIDGE_OPTIONS = Symbol('BRIDGE_OPTIONS');
