"""Hermes v0.18.2 hook integration and plugin lifecycle."""

from __future__ import annotations

import atexit
import importlib
import logging
import os
import secrets
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol, cast
from uuid import UUID

from .config import BridgeConfig
from .envelope import EnvelopeConfig, build_event
from .outbox import Outbox
from .policy import PolicyConfig, SessionSource, classify_turn
from .worker import DeliveryWorker

logger = logging.getLogger(__name__)

SessionEnvReader = Callable[[str, str], str]


class EventWorker(Protocol):
    """Worker surface used by the latency-sensitive hook."""

    def enqueue(self, event: dict[str, Any], *, now: float | None = None) -> bool:
        """Queue an event without waiting for disk or network I/O."""

        ...

    def start(self) -> None:
        """Start background persistence and delivery."""

        ...

    def stop(self, *, timeout: float = 5.0) -> None:
        """Stop background work and flush the in-memory queue when possible."""

        ...


def _get_session_env(name: str, default: str = "") -> str:
    """Read Hermes' task-local session context, with CLI-only compatibility."""

    try:
        module = importlib.import_module("gateway.session_context")
    except ModuleNotFoundError:
        # Unit tests and standalone diagnostics do not necessarily install the
        # Hermes package. In Hermes v0.18.2 this import is present and is the
        # concurrency-safe path; the fallback is only for those isolated uses.
        return os.getenv(name, default)
    get_session_env = cast(SessionEnvReader, module.get_session_env)
    return get_session_env(name, default)


def _uuid7(now: float) -> str:
    """Generate an RFC 9562 UUIDv7 from wall-clock milliseconds and CSPRNG bits."""

    unix_ms = max(0, int(now * 1000)) & ((1 << 48) - 1)
    random_a = secrets.randbits(12)
    random_b = secrets.randbits(62)
    value = (
        (unix_ms << 80)
        | (0x7 << 76)
        | (random_a << 64)
        | (0b10 << 62)
        | random_b
    )
    return str(UUID(int=value))


class BridgeRuntime:
    """Fail-closed adapter from one Hermes hook call to the local worker queue."""

    def __init__(
        self,
        config: BridgeConfig,
        worker: EventWorker,
        *,
        session_env: SessionEnvReader = _get_session_env,
        clock: Callable[[], float] = time.time,
        uuid_factory: Callable[[], str] | None = None,
    ) -> None:
        self.config = config
        self.worker = worker
        self._session_env = session_env
        self._clock = clock
        self._uuid_factory = uuid_factory
        self._policy_config = PolicyConfig(
            agent_id=config.agent_id,
            peer_agent_id=config.peer_agent_id,
            peer_telegram_username=config.peer_telegram_username,
            peer_aliases=config.peer_aliases,
            allowed_chat_ids=config.allowed_chat_ids,
            allowed_thread_ids=config.allowed_thread_ids,
            allowed_webhook_routes=config.allowed_webhook_routes,
            requests_enabled=config.requests_enabled,
            max_hops=config.max_hops,
        )
        self._envelope_config = EnvelopeConfig(
            agent_id=config.agent_id,
            instance_id=config.instance_id,
        )

    def start(self) -> None:
        """Start the background worker."""

        self.worker.start()

    def stop(self, *, timeout: float = 5.0) -> None:
        """Stop the background worker without an unbounded gateway shutdown wait."""

        self.worker.stop(timeout=timeout)

    def _read(self, name: str) -> str:
        value = self._session_env(name, "")
        return value if isinstance(value, str) else ""

    def _source(self, *, platform: str, session_id: str) -> SessionSource | None:
        task_platform = self._read("HERMES_SESSION_PLATFORM")
        effective_platform = (task_platform or platform).casefold()
        chat_id = self._read("HERMES_SESSION_CHAT_ID")
        if effective_platform not in {"telegram", "webhook"} or not chat_id:
            return None
        thread_id = self._read("HERMES_SESSION_THREAD_ID") or None
        effective_session_id = session_id or self._read("HERMES_SESSION_ID")
        if not effective_session_id:
            return None
        route = None
        if effective_platform == "webhook":
            # v0.18.2 exposes the webhook route as user_name. SOURCE is checked
            # first for forward compatibility with a dedicated route binding.
            route = self._read("HERMES_SESSION_SOURCE") or self._read(
                "HERMES_SESSION_USER_NAME"
            )
        return SessionSource(
            platform=effective_platform,
            chat_id=chat_id,
            thread_id=thread_id,
            session_id=effective_session_id,
            route=route,
        )

    def _handle(
        self,
        *,
        assistant_response: str,
        conversation_history: list[dict[str, Any]],
        user_message: str,
        session_id: str,
        platform: str,
    ) -> None:
        source = self._source(platform=platform, session_id=session_id)
        if source is None:
            return
        decision = classify_turn(
            user_message=user_message,
            assistant_response=assistant_response,
            source=source,
            config=self._policy_config,
        )
        if decision is None:
            return
        now = self._clock()
        event_id = self._uuid_factory() if self._uuid_factory is not None else _uuid7(now)
        event = build_event(
            decision,
            source,
            self._envelope_config,
            event_id=event_id,
            occurred_at=datetime.fromtimestamp(now, UTC),
            conversation_history=conversation_history,
        )
        self.worker.enqueue(event, now=now)

    def post_llm_call(
        self,
        *,
        assistant_response: str,
        conversation_history: list[dict[str, Any]],
        user_message: str,
        session_id: str,
        platform: str,
        **_future_kwargs: Any,
    ) -> None:
        """Observe one real Hermes v0.18.2 ``post_llm_call`` invocation.

        This synchronous callback validates, serializes, and commits to the local
        encrypted outbox before returning. HTTP stays on the delivery worker
        thread. Return values are intentionally unused because this is an observer
        hook.
        """

        if not all(
            isinstance(value, str)
            for value in (assistant_response, user_message, session_id, platform)
        ) or not isinstance(conversation_history, list):
            return
        try:
            self._handle(
                assistant_response=assistant_response,
                conversation_history=conversation_history,
                user_message=user_message,
                session_id=session_id,
                platform=platform,
            )
        except Exception as exc:  # never break the user's Hermes turn
            logger.error("Hermes Bridge hook failed closed: %s", type(exc).__name__)


_runtime: BridgeRuntime | None = None
_runtime_lock = threading.Lock()
_atexit_registered = False


def shutdown() -> None:
    """Stop and forget the currently registered runtime, if any."""

    global _runtime
    with _runtime_lock:
        runtime = _runtime
        _runtime = None
    if runtime is not None:
        runtime.stop()


def register(ctx: Any) -> None:
    """Hermes directory-plugin entrypoint."""

    global _atexit_registered, _runtime
    # A plugin reload (including disabling or misconfiguring it) must not leave
    # an old delivery thread running under stale policy or credentials.
    shutdown()
    config = BridgeConfig.from_env(os.environ)
    if not config.enabled:
        logger.info("Hermes Bridge outbound plugin is disabled")
        return

    outbox = Outbox(config.outbox_path, config.encryption_key)
    worker = DeliveryWorker(config, outbox)
    runtime = BridgeRuntime(config, worker)

    runtime.start()
    try:
        ctx.register_hook("post_llm_call", runtime.post_llm_call)
    except Exception:
        runtime.stop()
        raise
    with _runtime_lock:
        _runtime = runtime
        if not _atexit_registered:
            atexit.register(shutdown)
            _atexit_registered = True
