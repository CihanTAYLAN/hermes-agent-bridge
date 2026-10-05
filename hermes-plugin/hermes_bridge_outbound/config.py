"""Environment-only configuration with fail-closed validation."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

_AGENT_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_INSTANCE_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
_ROUTE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off", ""})


class ConfigError(ValueError):
    """Raised when bridge configuration cannot be used safely."""


def _boolean(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = env.get(key, str(default)).strip().casefold()
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    raise ConfigError(f"{key} must be a boolean")


def _csv(env: Mapping[str, str], key: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in env.get(key, "").split(",") if item.strip())


def _required(env: Mapping[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise ConfigError(f"{key} is required")
    return value


def _positive_float(env: Mapping[str, str], key: str, default: float) -> float:
    try:
        value = float(env.get(key, str(default)))
    except ValueError as exc:
        raise ConfigError(f"{key} must be a number") from exc
    if value <= 0:
        raise ConfigError(f"{key} must be greater than zero")
    return value


def _positive_int(env: Mapping[str, str], key: str, default: int) -> int:
    try:
        value = int(env.get(key, str(default)))
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer") from exc
    if value <= 0:
        raise ConfigError(f"{key} must be greater than zero")
    return value


def _derive_heartbeat_url(api_url: str) -> str:
    parsed = urlsplit(api_url)
    path = parsed.path.rstrip("/")
    if path.endswith("/v1/events"):
        path = f"{path[: -len('/v1/events')]}/v1/agents/heartbeat"
    else:
        path = f"{path}/v1/agents/heartbeat"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


@dataclass(frozen=True, slots=True)
class BridgeConfig:
    """Validated runtime configuration."""

    enabled: bool
    agent_id: str = "disabled"
    instance_id: str = "disabled"
    api_url: str = ""
    heartbeat_url: str = ""
    shared_secret: bytes = field(default=b"", repr=False)
    encryption_key: bytes = field(default=b"", repr=False)
    peer_agent_id: str = "disabled-peer"
    peer_telegram_username: str = ""
    peer_aliases: tuple[str, ...] = ()
    allowed_chat_ids: frozenset[str] = frozenset()
    allowed_thread_ids: frozenset[str] = frozenset()
    allowed_webhook_routes: frozenset[str] = frozenset()
    requests_enabled: bool = False
    max_hops: int = 2
    outbox_path: Path = Path("~/.hermes/state/bridge-outbox.sqlite")
    http_timeout_seconds: float = 5.0
    poll_interval_seconds: float = 0.25
    heartbeat_interval_seconds: float = 30.0
    retry_base_seconds: float = 1.0
    retry_max_seconds: float = 60.0
    retry_jitter_ratio: float = 0.2
    max_attempts: int = 6

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> BridgeConfig:
        """Parse configuration without reading or mutating process globals."""

        enabled = _boolean(env, "HERMES_BRIDGE_ENABLED", False)
        outbox_path = Path(
            env.get("HERMES_BRIDGE_OUTBOX_PATH", "~/.hermes/state/bridge-outbox.sqlite")
        ).expanduser()
        if not enabled:
            return cls(enabled=False, outbox_path=outbox_path)

        agent_id = _required(env, "HERMES_BRIDGE_AGENT_ID")
        instance_id = _required(env, "HERMES_BRIDGE_INSTANCE_ID")
        api_url = _required(env, "HERMES_BRIDGE_API_URL")
        shared_secret_text = _required(env, "HERMES_BRIDGE_INGEST_SECRET")
        encryption_key_text = _required(env, "HERMES_BRIDGE_OUTBOX_ENCRYPTION_KEY")
        peer_agent_id = _required(env, "HERMES_BRIDGE_PEER_AGENT_ID")
        usernames = _csv(env, "HERMES_BRIDGE_PEER_USERNAMES")
        if len(usernames) != 1:
            raise ConfigError("HERMES_BRIDGE_PEER_USERNAMES must contain exactly one username")
        username = usernames[0].lstrip("@")
        aliases = tuple(value.casefold() for value in _csv(env, "HERMES_BRIDGE_PEER_ALIASES"))
        chat_ids = frozenset(_csv(env, "HERMES_BRIDGE_ALLOWED_CHAT_IDS"))
        thread_ids = frozenset(_csv(env, "HERMES_BRIDGE_ALLOWED_THREAD_IDS"))
        webhook_routes = frozenset(_csv(env, "HERMES_BRIDGE_ALLOWED_WEBHOOK_ROUTES"))

        if not _AGENT_RE.fullmatch(agent_id):
            raise ConfigError("HERMES_BRIDGE_AGENT_ID has an invalid agent identifier")
        if not _INSTANCE_RE.fullmatch(instance_id):
            raise ConfigError("HERMES_BRIDGE_INSTANCE_ID has an invalid instance identifier")
        if not _AGENT_RE.fullmatch(peer_agent_id):
            raise ConfigError("HERMES_BRIDGE_PEER_AGENT_ID has an invalid agent identifier")
        if agent_id == peer_agent_id:
            raise ConfigError(
                "HERMES_BRIDGE_AGENT_ID and HERMES_BRIDGE_PEER_AGENT_ID must differ"
            )
        parsed_url = urlsplit(api_url)
        if parsed_url.scheme != "https" or not parsed_url.netloc or parsed_url.username:
            raise ConfigError("HERMES_BRIDGE_API_URL must be an HTTPS URL without userinfo")
        if len(shared_secret_text.encode()) < 32:
            raise ConfigError("HERMES_BRIDGE_INGEST_SECRET must contain at least 32 bytes")
        if len(encryption_key_text.encode()) < 32:
            raise ConfigError("HERMES_BRIDGE_OUTBOX_ENCRYPTION_KEY must contain at least 32 bytes")
        if not chat_ids:
            raise ConfigError("HERMES_BRIDGE_ALLOWED_CHAT_IDS must not be empty")
        if not webhook_routes or any(not _ROUTE_RE.fullmatch(item) for item in webhook_routes):
            raise ConfigError("HERMES_BRIDGE_ALLOWED_WEBHOOK_ROUTES must contain valid routes")

        try:
            max_hops = int(env.get("HERMES_BRIDGE_MAX_HOPS", "2"))
        except ValueError as exc:
            raise ConfigError("HERMES_BRIDGE_MAX_HOPS must be an integer") from exc
        if max_hops not in {1, 2}:
            raise ConfigError("HERMES_BRIDGE_MAX_HOPS must be 1 or 2")

        jitter = float(env.get("HERMES_BRIDGE_RETRY_JITTER_RATIO", "0.2"))
        if not 0 <= jitter <= 1:
            raise ConfigError("HERMES_BRIDGE_RETRY_JITTER_RATIO must be between 0 and 1")
        retry_base = _positive_float(env, "HERMES_BRIDGE_RETRY_BASE_SECONDS", 1.0)
        retry_max = _positive_float(env, "HERMES_BRIDGE_RETRY_MAX_SECONDS", 60.0)
        if retry_max < retry_base:
            raise ConfigError(
                "HERMES_BRIDGE_RETRY_MAX_SECONDS must be at least HERMES_BRIDGE_RETRY_BASE_SECONDS"
            )

        heartbeat_url = env.get("HERMES_BRIDGE_HEARTBEAT_URL", "").strip() or _derive_heartbeat_url(
            api_url
        )
        requests_enabled = _boolean(env, "HERMES_BRIDGE_REQUESTS_ENABLED", False)
        if requests_enabled:
            raise ConfigError(
                "request/response mode requires durable completion receipts; "
                "this bridge release supports observe-only delivery"
            )

        return cls(
            enabled=True,
            agent_id=agent_id,
            instance_id=instance_id,
            api_url=api_url,
            heartbeat_url=heartbeat_url,
            shared_secret=shared_secret_text.encode(),
            encryption_key=encryption_key_text.encode(),
            peer_agent_id=peer_agent_id,
            peer_telegram_username=username,
            peer_aliases=aliases,
            allowed_chat_ids=chat_ids,
            allowed_thread_ids=thread_ids,
            allowed_webhook_routes=webhook_routes,
            requests_enabled=requests_enabled,
            max_hops=max_hops,
            outbox_path=outbox_path,
            http_timeout_seconds=_positive_float(env, "HERMES_BRIDGE_HTTP_TIMEOUT_SECONDS", 5.0),
            poll_interval_seconds=_positive_float(env, "HERMES_BRIDGE_POLL_INTERVAL_SECONDS", 0.25),
            heartbeat_interval_seconds=_positive_float(
                env, "HERMES_BRIDGE_HEARTBEAT_INTERVAL_SECONDS", 30.0
            ),
            retry_base_seconds=retry_base,
            retry_max_seconds=retry_max,
            retry_jitter_ratio=jitter,
            max_attempts=_positive_int(env, "HERMES_BRIDGE_MAX_ATTEMPTS", 6),
        )
