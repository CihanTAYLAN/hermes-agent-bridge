"""Event v1 envelope construction."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .policy import SessionSource, TurnDecision


@dataclass(frozen=True, slots=True)
class EnvelopeConfig:
    """Stable identity fields attached to every generated event."""

    agent_id: str
    instance_id: str


def canonical_json(value: object) -> bytes:
    """Serialize once to the exact UTF-8 bytes that are persisted and signed."""

    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _timestamp(value: datetime) -> str:
    normalized = value.astimezone(UTC)
    return normalized.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _channel_key(source: SessionSource) -> str:
    components = [source.platform, source.chat_id]
    if source.thread_id is not None:
        components.append(source.thread_id)
    return ":".join(components)


def build_event(
    decision: TurnDecision,
    source: SessionSource,
    config: EnvelopeConfig,
    *,
    event_id: str,
    occurred_at: datetime,
    conversation_history: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build one generated Hermes message event conforming to event.v1."""

    # Source plugins must leave rolling context empty. The authenticated Bridge
    # adds bounded cross-session context immediately before target delivery.
    del conversation_history
    timestamp = _timestamp(occurred_at)
    root_event_id = decision.root_event_id or event_id
    return {
        "schema_version": 1,
        "event_type": "hermes.agent.message",
        "event_id": event_id,
        "occurred_at": timestamp,
        "delivery_semantics": "generated",
        "source": {
            "agent_id": config.agent_id,
            "instance_id": config.instance_id,
            "platform": source.platform,
            "chat_id": source.chat_id[:64],
            "thread_id": source.thread_id[:64] if source.thread_id is not None else None,
            "session_id": source.session_id[:256],
        },
        "target": {"agent_id": decision.target_agent_id},
        "conversation": {
            "channel_key": (decision.channel_key or _channel_key(source))[:256],
            "mode": decision.mode.value,
            "root_event_id": root_event_id,
            "causation_id": decision.causation_id,
            "hop": decision.hop,
        },
        "message": {
            "text": decision.message_text[:16_384],
            "trigger_text": decision.trigger_text[:8_192],
            "format": "telegram-markdown",
        },
        "context": {"recent_messages": []},
    }
