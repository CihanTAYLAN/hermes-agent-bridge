import type { AgentConfig, BridgeOptions } from '../config.js';
import { BridgeError } from '../errors.js';
import { verifyHmacV2 } from './hmac.js';

export type AuthenticationInput = {
  agentId: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer;
};

export function authenticateAgent(
  input: AuthenticationInput,
  options: Pick<BridgeOptions, 'agents' | 'now' | 'replayWindowSeconds'>,
): AgentConfig {
  if (!input.agentId || !input.signature || !input.timestamp) {
    throw new BridgeError(401, 'missing_authentication');
  }
  const agent = options.agents.get(input.agentId);
  if (!agent) {
    throw new BridgeError(403, 'unknown_source');
  }
  if (!/^\d+$/.test(input.timestamp)) {
    throw new BridgeError(401, 'invalid_timestamp');
  }
  const timestampSeconds = Number(input.timestamp);
  const nowSeconds = Math.floor(options.now().getTime() / 1000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > options.replayWindowSeconds
  ) {
    throw new BridgeError(401, 'replay_window_exceeded');
  }
  if (
    !verifyHmacV2({
      activeSecret: agent.activeSecret,
      previousSecret: agent.previousSecret,
      rawBody: input.rawBody,
      signature: input.signature,
      timestamp: input.timestamp,
    })
  ) {
    throw new BridgeError(401, 'invalid_signature');
  }
  return agent;
}
