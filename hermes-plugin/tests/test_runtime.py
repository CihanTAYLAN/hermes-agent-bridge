from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import sys
import time
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any
from uuid import UUID

import pytest

from hermes_bridge_outbound.config import BridgeConfig
from hermes_bridge_outbound.outbox import Outbox
from hermes_bridge_outbound.runtime import BridgeRuntime, register, shutdown
from hermes_bridge_outbound.worker import DeliveryWorker


class FakeContext:
    def __init__(self) -> None:
        self.hooks: dict[str, Any] = {}

    def register_hook(self, name: str, callback: Any) -> None:
        self.hooks[name] = callback


class FakeWorker:
    def __init__(self, *, accept: bool = True) -> None:
        self.accept = accept
        self.events: list[dict[str, Any]] = []
        self.started = False
        self.stopped = False

    def enqueue(self, event: dict[str, Any], *, now: float | None = None) -> bool:
        del now
        if self.accept:
            self.events.append(event)
        return self.accept

    def start(self) -> None:
        self.started = True

    def stop(self, *, timeout: float = 5.0) -> None:
        del timeout
        self.stopped = True


class RecordingTransport:
    def __init__(self, status: int = 202) -> None:
        self.status = status
        self.calls: list[tuple[str, bytes, dict[str, str], float]] = []

    def post(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        self.calls.append((url, body, headers, timeout))
        return self.status


def enabled_env(tmp_path: Path) -> dict[str, str]:
    return {
        "HERMES_BRIDGE_ENABLED": "true",
        "HERMES_BRIDGE_AGENT_ID": "alpha",
        "HERMES_BRIDGE_INSTANCE_ID": "alpha-prod",
        "HERMES_BRIDGE_API_URL": "https://bridge.example/v1/events",
        "HERMES_BRIDGE_INGEST_SECRET": "s" * 32,
        "HERMES_BRIDGE_OUTBOX_ENCRYPTION_KEY": "e" * 32,
        "HERMES_BRIDGE_PEER_AGENT_ID": "beta",
        "HERMES_BRIDGE_PEER_USERNAMES": "@BetaAgentBot",
        "HERMES_BRIDGE_PEER_ALIASES": "Beta",
        "HERMES_BRIDGE_ALLOWED_CHAT_IDS": "-100123",
        "HERMES_BRIDGE_ALLOWED_WEBHOOK_ROUTES": "peer-beta",
        "HERMES_BRIDGE_REQUESTS_ENABLED": "false",
        "HERMES_BRIDGE_OUTBOX_PATH": str(tmp_path / "outbox.sqlite"),
    }


def session_reader(values: Mapping[str, str]):
    def read(name: str, default: str = "") -> str:
        return values.get(name, default)

    return read


def runtime_for(
    tmp_path: Path,
    *,
    worker: FakeWorker | None = None,
    session_values: Mapping[str, str] | None = None,
    interactive: bool = False,
) -> tuple[BridgeRuntime, FakeWorker]:
    config = BridgeConfig.from_env(enabled_env(tmp_path))
    if interactive:
        config = replace(config, requests_enabled=True)
    fake_worker = worker or FakeWorker()
    runtime = BridgeRuntime(
        config,
        fake_worker,  # type: ignore[arg-type]
        session_env=session_reader(
            session_values
            or {
                "HERMES_SESSION_PLATFORM": "telegram",
                "HERMES_SESSION_CHAT_ID": "-100123",
                "HERMES_SESSION_THREAD_ID": "",
                "HERMES_SESSION_ID": "context-session",
            }
        ),
        clock=lambda: 1_752_835_200.0,
        uuid_factory=lambda: "0198a8e0-9b80-7000-8000-000000000001",
    )
    return runtime, fake_worker


def test_post_llm_call_accepts_real_hermes_v0182_kwargs(tmp_path: Path) -> None:
    runtime, worker = runtime_for(tmp_path)

    result = runtime.post_llm_call(
        assistant_response="[[bridge:to=beta]] Merhaba",
        conversation_history=[{"role": "user", "content": "Beta'e selam ver"}],
        user_message="Beta'e selam ver",
        session_id="callback-session",
        platform="telegram",
    )

    assert result is None
    assert len(worker.events) == 1
    event = worker.events[0]
    assert event["source"]["session_id"] == "callback-session"
    assert event["conversation"]["mode"] == "observe"
    assert event["delivery_semantics"] == "generated"
    assert event["message"]["text"] == "Merhaba"
    assert event["context"]["recent_messages"] == []
    assert UUID(event["event_id"]).version == 7


def test_post_llm_call_reads_task_local_context_and_rejects_other_chat(tmp_path: Path) -> None:
    runtime, worker = runtime_for(
        tmp_path,
        session_values={
            "HERMES_SESSION_PLATFORM": "telegram",
            "HERMES_SESSION_CHAT_ID": "-100999",
            "HERMES_SESSION_THREAD_ID": "",
        },
    )

    runtime.post_llm_call(
        assistant_response="ordinary answer",
        conversation_history=[],
        user_message="hello",
        session_id="session-1",
        platform="telegram",
    )

    assert worker.events == []


def test_webhook_request_emits_one_deterministic_response(tmp_path: Path) -> None:
    request_id = "0198a8e0-9b80-7000-8000-000000000011"
    root_id = "0198a8e0-9b80-7000-8000-000000000010"
    marker = (
        "[[hermes-bridge:v1 "
        f"event_id={request_id} root_event_id={root_id} causation_id=- "
        "mode=request hop=0 source=beta target=alpha "
        "channel_key=telegram%3A-100123]]"
    )
    runtime, worker = runtime_for(
        tmp_path,
        interactive=True,
        session_values={
            "HERMES_SESSION_PLATFORM": "webhook",
            "HERMES_SESSION_CHAT_ID": "delivery-1",
            "HERMES_SESSION_USER_NAME": "peer-beta",
            "HERMES_SESSION_THREAD_ID": "",
        },
    )

    runtime.post_llm_call(
        assistant_response="peer response",
        conversation_history=[],
        user_message=f"{marker}\nrequest body",
        session_id="ephemeral-session",
        platform="webhook",
    )
    runtime.post_llm_call(
        assistant_response="peer response again",
        conversation_history=[],
        user_message=f"{marker}\nrequest body",
        session_id="ephemeral-session",
        platform="webhook",
    )

    assert len(worker.events) == 2
    first, second = worker.events
    assert first["conversation"]["mode"] == "response"
    assert first["conversation"]["causation_id"] == request_id
    assert first["conversation"]["hop"] == 1
    # The durable outbox enforces one response per request even if Hermes invokes twice.
    outbox = Outbox(tmp_path / "dedupe.sqlite", b"e" * 32)
    assert outbox.enqueue(first, now=1.0) is True
    assert outbox.enqueue(second, now=2.0) is False


def test_hook_path_is_non_blocking_and_never_calls_transport(tmp_path: Path) -> None:
    runtime, worker = runtime_for(tmp_path)
    durations: list[float] = []

    for index in range(200):
        start = time.perf_counter()
        runtime.post_llm_call(
            assistant_response=f"answer {index}",
            conversation_history=[],
            user_message="hello",
            session_id="session-1",
            platform="telegram",
        )
        durations.append(time.perf_counter() - start)

    p95 = sorted(durations)[int(len(durations) * 0.95) - 1]
    assert len(worker.events) == 200
    assert p95 < 0.05


def test_full_hook_queue_fails_closed_without_raising(tmp_path: Path) -> None:
    runtime, worker = runtime_for(tmp_path, worker=FakeWorker(accept=False))

    assert (
        runtime.post_llm_call(
            assistant_response="ordinary answer",
            conversation_history=[],
            user_message="hello",
            session_id="session-1",
            platform="telegram",
        )
        is None
    )
    assert worker.events == []


def test_worker_persists_encrypted_event_then_delivers_signed_raw_body(tmp_path: Path) -> None:
    config = BridgeConfig.from_env(enabled_env(tmp_path))
    outbox = Outbox(config.outbox_path, config.encryption_key)
    transport = RecordingTransport()
    worker = DeliveryWorker(config, outbox, transport=transport, clock=lambda: 100.0)
    runtime = BridgeRuntime(
        config,
        worker,
        session_env=session_reader(
            {
                "HERMES_SESSION_PLATFORM": "telegram",
                "HERMES_SESSION_CHAT_ID": "-100123",
                "HERMES_SESSION_THREAD_ID": "",
            }
        ),
        clock=lambda: 100.0,
        uuid_factory=lambda: "0198a8e0-9b80-7000-8000-000000000020",
    )

    runtime.post_llm_call(
        assistant_response="sensitive plaintext",
        conversation_history=[],
        user_message="trigger",
        session_id="session-1",
        platform="telegram",
    )
    assert outbox.count() == 1
    assert outbox.get_state("0198a8e0-9b80-7000-8000-000000000020") == "pending"
    assert worker.process_one(now=100.0) is True

    assert outbox.count() == 1
    assert outbox.get_state("0198a8e0-9b80-7000-8000-000000000020") == "sent"
    database_bytes = config.outbox_path.read_bytes()
    wal_path = Path(f"{config.outbox_path}-wal")
    if wal_path.exists():
        database_bytes += wal_path.read_bytes()
    assert b"sensitive plaintext" not in database_bytes
    _, raw_body, headers, _ = transport.calls[0]
    assert json.loads(raw_body)["message"]["text"] == "sensitive plaintext"
    assert headers["X-Request-ID"] == "0198a8e0-9b80-7000-8000-000000000020"
    assert len(headers["X-Webhook-Signature-V2"]) == 64


def test_locked_outbox_fails_closed_with_bounded_hook_latency(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    config = BridgeConfig.from_env(enabled_env(tmp_path))
    outbox = Outbox(config.outbox_path, config.encryption_key)
    worker = DeliveryWorker(config, outbox, transport=RecordingTransport())
    runtime = BridgeRuntime(
        config,
        worker,
        session_env=session_reader(
            {
                "HERMES_SESSION_PLATFORM": "telegram",
                "HERMES_SESSION_CHAT_ID": "-100123",
                "HERMES_SESSION_THREAD_ID": "",
            }
        ),
        clock=lambda: 100.0,
        uuid_factory=lambda: "0198a8e0-9b80-7000-8000-000000000021",
    )
    lock = sqlite3.connect(config.outbox_path, isolation_level=None)
    lock.execute("PRAGMA journal_mode = WAL")
    lock.execute("BEGIN IMMEDIATE")
    try:
        started = time.perf_counter()
        runtime.post_llm_call(
            assistant_response="durable or rejected",
            conversation_history=[],
            user_message="trigger",
            session_id="session-1",
            platform="telegram",
        )
        elapsed = time.perf_counter() - started
    finally:
        lock.execute("ROLLBACK")
        lock.close()

    assert elapsed < 0.3
    assert outbox.count() == 0
    assert "hook failed closed: OperationalError" in caplog.text


def test_register_disabled_does_not_install_hook(monkeypatch: pytest.MonkeyPatch) -> None:
    shutdown()
    monkeypatch.setenv("HERMES_BRIDGE_ENABLED", "false")
    context = FakeContext()

    assert register(context) is None
    assert context.hooks == {}


def test_register_enabled_starts_runtime_and_installs_exact_hook(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    shutdown()
    env = enabled_env(tmp_path)
    for name in tuple(os.environ):
        if name.startswith("HERMES_BRIDGE_"):
            monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    context = FakeContext()

    assert register(context) is None
    assert set(context.hooks) == {"post_llm_call"}
    callback = context.hooks["post_llm_call"]
    assert callback(
        assistant_response="ignored outside a gateway context",
        conversation_history=[],
        user_message="hello",
        session_id="session",
        platform="telegram",
    ) is None
    shutdown()


def test_root_plugin_entrypoint_delegates_to_runtime_register(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plugin_path = Path(__file__).parents[1] / "__init__.py"
    parent = ModuleType("hermes_plugins")
    parent.__path__ = []  # type: ignore[attr-defined]
    parent.__package__ = "hermes_plugins"
    monkeypatch.setitem(sys.modules, "hermes_plugins", parent)
    module_name = "hermes_plugins.hermes_bridge_outbound"
    spec = importlib.util.spec_from_file_location(
        module_name,
        plugin_path,
        submodule_search_locations=[str(plugin_path.parent)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    module.__package__ = module_name
    module.__path__ = [str(plugin_path.parent)]  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, module_name, module)
    spec.loader.exec_module(module)

    assert isinstance(module, ModuleType)
    assert callable(module.register)
    assert module.register.__module__.startswith(f"{module_name}.")


def test_callback_timestamp_is_utc(tmp_path: Path) -> None:
    runtime, worker = runtime_for(tmp_path)
    runtime.post_llm_call(
        assistant_response="answer",
        conversation_history=[],
        user_message="hello",
        session_id="session",
        platform="telegram",
    )
    occurred_at = datetime.fromisoformat(worker.events[0]["occurred_at"].replace("Z", "+00:00"))
    assert occurred_at.tzinfo == UTC
