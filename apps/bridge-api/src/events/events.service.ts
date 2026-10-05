import { createHash } from 'node:crypto';
import { authenticateAgent } from '../auth/authenticate.js';
import type { BridgeOptions } from '../config.js';
import type { BridgeEvent } from '../domain.js';
import { BridgeError } from '../errors.js';
import { EventValidator } from './validator.js';

export type IngestHeaders = {
  agentId: string | undefined;
  requestId: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
};

function canonicalChannelKey(event: BridgeEvent): string {
  const components = [event.source.platform, event.source.chat_id];
  if (event.source.thread_id !== null) {
    components.push(event.source.thread_id);
  }
  return components.join(':');
}

export class EventsService {
  private readonly validator = new EventValidator();

  constructor(private readonly options: BridgeOptions) {}

  async ingest(
    rawBody: Buffer,
    headers: IngestHeaders,
  ): Promise<{ event_id: string; status: 'accepted' }> {
    if (rawBody.length > this.options.maxBodyBytes) {
      throw new BridgeError(413, 'body_too_large');
    }
    const authenticated = authenticateAgent(
      {
        agentId: headers.agentId,
        signature: headers.signature,
        timestamp: headers.timestamp,
        rawBody,
      },
      this.options,
    );
    const receivedAt = this.options.now();
    const guard = await this.options.store.guardIngress({
      agentId: authenticated.agentId,
      bucketSecond: Math.floor(receivedAt.getTime() / 1000),
      rateLimit: this.options.rateLimitPerSecond,
      now: receivedAt,
    });
    if (guard === 'rate_limited') {
      throw new BridgeError(429, 'rate_limit_exceeded');
    }

    const event = this.validator.parse(rawBody);
    if (event.source.agent_id !== authenticated.agentId) {
      throw new BridgeError(403, 'source_mismatch');
    }
    if (event.source.agent_id === event.target.agent_id) {
      throw new BridgeError(422, 'same_agent');
    }
    if (headers.requestId !== event.event_id) {
      throw new BridgeError(422, 'request_id_mismatch');
    }
    const peerAgentIds = [...this.options.agents.keys()].filter(
      (agentId) => agentId !== authenticated.agentId,
    );
    if (peerAgentIds.length !== 1 || event.target.agent_id !== peerAgentIds[0]) {
      throw new BridgeError(422, 'unknown_target');
    }
    if (event.context.recent_messages.length !== 0) {
      throw new BridgeError(422, 'source_context_forbidden');
    }
    const conversation = event.conversation;
    const expectedChannelKey = canonicalChannelKey(event);
    const validInitialTransition =
      event.delivery_semantics === 'generated' &&
      (conversation.mode === 'observe' || conversation.mode === 'request') &&
      conversation.hop === 0 &&
      conversation.causation_id === null &&
      conversation.root_event_id === event.event_id &&
      conversation.channel_key === expectedChannelKey;
    const validResponseTransition =
      event.delivery_semantics === 'generated' &&
      conversation.mode === 'response' &&
      conversation.hop > 0 &&
      conversation.causation_id !== null &&
      conversation.root_event_id !== event.event_id &&
      conversation.channel_key === expectedChannelKey;
    if (!validInitialTransition && !validResponseTransition) {
      throw new BridgeError(422, 'invalid_conversation_transition');
    }
    if (conversation.mode !== 'observe') {
      throw new BridgeError(422, 'requests_disabled');
    }

    const canonicalEvent: BridgeEvent = {
      ...event,
      delivery_semantics: 'generated',
      source: { ...event.source, agent_id: authenticated.agentId },
      target: { agent_id: peerAgentIds[0] },
      conversation: {
        channel_key: expectedChannelKey,
        mode: 'observe',
        root_event_id: event.event_id,
        causation_id: null,
        hop: 0,
      },
      context: { recent_messages: [] },
    };
    const canonicalBody = Buffer.from(JSON.stringify(canonicalEvent));
    const accepted = await this.options.store.acceptEvent({
      event: canonicalEvent,
      rawBody: canonicalBody,
      payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
      receivedAt,
    });
    if (accepted.conflict) {
      throw new BridgeError(409, 'event_id_payload_conflict');
    }
    return { event_id: event.event_id, status: 'accepted' };
  }
}
