"""Conversation policy and loop-prevention metadata for the outbound bridge."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from urllib.parse import quote, unquote
from uuid import UUID

_MACHINE_TARGET_RE_TEMPLATE = r"\[\[bridge:to={target}\]\]"
_BRIDGE_MARKER_RE = re.compile(r"\[\[hermes-bridge:v1 (?P<body>[^\]\r\n]+)\]\]")
_SILENCE_EDGE_CHARS = " \t\r\n.*_`~[](){}<>:;,-"
_STATUS_PREFIXES = (
    "⚠️ Processing stopped:",
    "Operation interrupted:",
    "[ERROR]",
    "Error:",
)


class TurnMode(StrEnum):
    """Allowed event-chain modes."""

    OBSERVE = "observe"
    REQUEST = "request"
    RESPONSE = "response"


@dataclass(frozen=True, slots=True)
class PolicyConfig:
    """Inputs used by the fail-closed routing policy."""

    agent_id: str
    peer_agent_id: str
    peer_telegram_username: str
    peer_aliases: tuple[str, ...]
    allowed_chat_ids: frozenset[str]
    allowed_thread_ids: frozenset[str]
    allowed_webhook_routes: frozenset[str]
    requests_enabled: bool
    max_hops: int


@dataclass(frozen=True, slots=True)
class SessionSource:
    """PII-minimal subset of Hermes gateway session context."""

    platform: str
    chat_id: str
    thread_id: str | None
    session_id: str
    route: str | None = None


@dataclass(frozen=True, slots=True)
class BridgeMetadata:
    """Machine-readable metadata prepended by the inbound Bridge webhook route."""

    event_id: str
    root_event_id: str
    causation_id: str | None
    mode: TurnMode
    hop: int
    source_agent_id: str
    target_agent_id: str
    channel_key: str


@dataclass(frozen=True, slots=True)
class TurnDecision:
    """A generated event decision, or no decision when policy rejects the turn."""

    mode: TurnMode
    target_agent_id: str
    message_text: str
    trigger_text: str
    root_event_id: str | None
    causation_id: str | None
    hop: int
    channel_key: str | None


def _valid_uuid(value: str) -> bool:
    try:
        UUID(value)
    except (ValueError, AttributeError):
        return False
    return True


def format_bridge_marker(metadata: BridgeMetadata) -> str:
    """Return the canonical, single-line inbound routing marker."""

    causation = metadata.causation_id or "-"
    channel = quote(metadata.channel_key, safe="")
    return (
        "[[hermes-bridge:v1 "
        f"event_id={metadata.event_id} root_event_id={metadata.root_event_id} "
        f"causation_id={causation} mode={metadata.mode.value} hop={metadata.hop} "
        f"source={metadata.source_agent_id} target={metadata.target_agent_id} "
        f"channel_key={channel}]]"
    )


def parse_bridge_marker(text: str) -> BridgeMetadata | None:
    """Parse and validate one canonical inbound marker; malformed markers fail closed."""

    matches = list(_BRIDGE_MARKER_RE.finditer(text))
    if len(matches) != 1:
        return None
    fields: dict[str, str] = {}
    for token in matches[0].group("body").split(" "):
        if token.count("=") != 1:
            return None
        key, value = token.split("=", 1)
        if not key or not value or key in fields:
            return None
        fields[key] = value
    expected = {
        "event_id",
        "root_event_id",
        "causation_id",
        "mode",
        "hop",
        "source",
        "target",
        "channel_key",
    }
    if fields.keys() != expected:
        return None
    causation = None if fields["causation_id"] == "-" else fields["causation_id"]
    try:
        mode = TurnMode(fields["mode"])
        hop = int(fields["hop"])
    except (ValueError, TypeError):
        return None
    if (
        not _valid_uuid(fields["event_id"])
        or not _valid_uuid(fields["root_event_id"])
        or (causation is not None and not _valid_uuid(causation))
        or hop < 0
        or not fields["source"]
        or not fields["target"]
    ):
        return None
    channel_key = unquote(fields["channel_key"])
    if not channel_key or len(channel_key) > 256:
        return None
    return BridgeMetadata(
        event_id=fields["event_id"],
        root_event_id=fields["root_event_id"],
        causation_id=causation,
        mode=mode,
        hop=hop,
        source_agent_id=fields["source"],
        target_agent_id=fields["target"],
        channel_key=channel_key,
    )


def _is_silence_or_status(response: str) -> bool:
    stripped = response.strip()
    if not stripped:
        return True
    normalized = stripped.strip(_SILENCE_EDGE_CHARS).casefold().replace("_", " ")
    if normalized in {"silent", "no reply"}:
        return True
    return stripped.startswith(_STATUS_PREFIXES)


def _has_explicit_target(response: str, config: PolicyConfig) -> bool:
    marker = re.compile(
        _MACHINE_TARGET_RE_TEMPLATE.format(target=re.escape(config.peer_agent_id)),
        re.IGNORECASE,
    )
    if marker.search(response):
        return True
    username = config.peer_telegram_username.lstrip("@")
    if username and re.search(rf"(?<![\w])@{re.escape(username)}(?![\w])", response, re.I):
        return True
    for alias in config.peer_aliases:
        if not alias:
            continue
        # Aliases are commands only at the start of text or a new sentence and
        # must be followed by punctuation, preventing ordinary prose matches.
        if re.search(
            rf"(?:^|(?<=[.!?])\s+){re.escape(alias)}\s*[:,]",
            response,
            re.IGNORECASE,
        ):
            return True
    return False


def _clean_message(response: str, config: PolicyConfig) -> str:
    marker = re.compile(
        _MACHINE_TARGET_RE_TEMPLATE.format(target=re.escape(config.peer_agent_id)),
        re.IGNORECASE,
    )
    return marker.sub("", response, count=1).strip()


def _telegram_allowed(source: SessionSource, config: PolicyConfig) -> bool:
    if source.chat_id not in config.allowed_chat_ids:
        return False
    return not config.allowed_thread_ids or source.thread_id in config.allowed_thread_ids


def _webhook_decision(
    user_message: str,
    response: str,
    source: SessionSource,
    config: PolicyConfig,
) -> TurnDecision | None:
    if not config.requests_enabled or source.route not in config.allowed_webhook_routes:
        return None
    incoming = parse_bridge_marker(user_message)
    if (
        incoming is None
        or incoming.mode is not TurnMode.REQUEST
        or incoming.source_agent_id != config.peer_agent_id
        or incoming.target_agent_id != config.agent_id
        or incoming.hop >= config.max_hops
    ):
        return None
    return TurnDecision(
        mode=TurnMode.RESPONSE,
        target_agent_id=incoming.source_agent_id,
        message_text=_clean_message(response, config),
        trigger_text=user_message,
        root_event_id=incoming.root_event_id,
        causation_id=incoming.event_id,
        hop=incoming.hop + 1,
        channel_key=incoming.channel_key,
    )


def classify_turn(
    user_message: str,
    assistant_response: str,
    source: SessionSource,
    config: PolicyConfig,
) -> TurnDecision | None:
    """Classify one actual ``post_llm_call`` turn, rejecting anything unsafe."""

    if _is_silence_or_status(assistant_response):
        return None
    if config.agent_id == config.peer_agent_id or not (0 <= config.max_hops <= 2):
        return None
    platform = source.platform.casefold()
    if platform == "webhook":
        return _webhook_decision(user_message, assistant_response, source, config)
    if platform != "telegram" or not _telegram_allowed(source, config):
        return None
    requested = config.requests_enabled and _has_explicit_target(assistant_response, config)
    return TurnDecision(
        mode=TurnMode.REQUEST if requested else TurnMode.OBSERVE,
        target_agent_id=config.peer_agent_id,
        message_text=_clean_message(assistant_response, config),
        trigger_text=user_message,
        root_event_id=None,
        causation_id=None,
        hop=0,
        channel_key=None,
    )
