export type EventMode = 'observe' | 'request' | 'response';

export type RecentMessage = {
  agent_id: string;
  mode: EventMode;
  text: string;
  occurred_at: string;
};

export type BridgeEvent = {
  schema_version: 1;
  event_type: 'hermes.agent.message';
  event_id: string;
  occurred_at: string;
  delivery_semantics: 'generated';
  source: {
    agent_id: string;
    instance_id: string;
    platform: 'telegram' | 'webhook';
    chat_id: string;
    thread_id: string | null;
    session_id: string;
  };
  target: { agent_id: string };
  conversation: {
    channel_key: string;
    mode: EventMode;
    root_event_id: string;
    causation_id: string | null;
    hop: number;
  };
  message: {
    text: string;
    trigger_text: string;
    format: 'telegram-markdown';
  };
  context: { recent_messages: RecentMessage[] };
  [key: string]: unknown;
};
