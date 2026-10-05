from __future__ import annotations

import json
import threading
from dataclasses import replace
from pathlib import Path

from hermes_bridge_outbound.config import BridgeConfig
from hermes_bridge_outbound.outbox import Outbox
from hermes_bridge_outbound.signing import hmac_sha256_v2
from hermes_bridge_outbound.worker import DeliveryWorker, TransportError

KEY = b"worker-outbox-encryption-key-at-least-32-bytes"
EVENT_ID = "018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e10"


class RecordingTransport:
    def __init__(self, results: list[int | Exception]) -> None:
        self.results = results
        self.calls: list[tuple[str, bytes, dict[str, str], float]] = []

    def post(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        self.calls.append((url, body, headers, timeout))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def config(path: Path) -> BridgeConfig:
    return BridgeConfig(
        enabled=True,
        agent_id="alpha",
        instance_id="alpha-prod-01",
        api_url="https://bridge.example/v1/events",
        heartbeat_url="https://bridge.example/v1/agents/heartbeat",
        shared_secret=b"shared-signing-secret-at-least-32-bytes",
        encryption_key=KEY,
        peer_agent_id="beta",
        outbox_path=path,
        http_timeout_seconds=3.0,
        poll_interval_seconds=0.01,
        heartbeat_interval_seconds=30.0,
        retry_base_seconds=2.0,
        retry_max_seconds=10.0,
        retry_jitter_ratio=0.25,
        max_attempts=3,
    )


def event() -> dict[str, object]:
    return {
        "schema_version": 1,
        "event_type": "hermes.agent.message",
        "event_id": EVENT_ID,
        "occurred_at": "2026-07-18T12:00:00.000Z",
        "delivery_semantics": "generated",
        "source": {
            "agent_id": "alpha",
            "instance_id": "alpha-prod-01",
            "platform": "telegram",
            "chat_id": "chat",
            "thread_id": None,
            "session_id": "session",
        },
        "target": {"agent_id": "beta"},
        "conversation": {
            "channel_key": "telegram:chat",
            "mode": "observe",
            "root_event_id": EVENT_ID,
            "causation_id": None,
            "hop": 0,
        },
        "message": {"text": "exact raw body", "trigger_text": "q", "format": "telegram-markdown"},
        "context": {"recent_messages": []},
    }


def test_enqueue_is_durable_before_worker_thread_starts(tmp_path: Path) -> None:
    cfg = config(tmp_path / "outbox.sqlite")
    outbox = Outbox(cfg.outbox_path, KEY)
    worker = DeliveryWorker(cfg, outbox, transport=RecordingTransport([]), clock=lambda: 100.0)

    assert worker.enqueue(event(), now=100.0)

    reopened = Outbox(cfg.outbox_path, KEY)
    assert reopened.count() == 1
    assert reopened.get_state(EVENT_ID) == "pending"


def test_success_posts_exact_decrypted_raw_body_with_v2_signature(tmp_path: Path) -> None:
    cfg = config(tmp_path / "outbox.sqlite")
    outbox = Outbox(cfg.outbox_path, KEY)
    outbox.enqueue(event(), now=100.0)
    transport = RecordingTransport([202])
    worker = DeliveryWorker(cfg, outbox, transport=transport, clock=lambda: 100.0)

    assert worker.process_one(now=100.0)

    url, raw_body, headers, timeout = transport.calls[0]
    assert url == cfg.api_url
    assert json.loads(raw_body) == event()
    assert headers["X-Request-ID"] == EVENT_ID
    assert headers["X-Webhook-Timestamp"] == "100"
    assert headers["X-Webhook-Signature-V2"] == hmac_sha256_v2(
        cfg.shared_secret, "100", raw_body
    )
    assert timeout == 3.0
    assert outbox.get_state(EVENT_ID) == "sent"


def test_transient_status_reschedules_with_bounded_exponential_jitter(tmp_path: Path) -> None:
    cfg = config(tmp_path / "outbox.sqlite")
    outbox = Outbox(cfg.outbox_path, KEY)
    outbox.enqueue(event(), now=100.0)
    worker = DeliveryWorker(
        cfg,
        outbox,
        transport=RecordingTransport([503]),
        clock=lambda: 100.0,
        random_value=lambda: 1.0,
    )

    worker.process_one(now=100.0)

    assert outbox.get_state(EVENT_ID) == "pending"
    assert outbox.claim_due(now=102.49) is None
    claimed = outbox.claim_due(now=102.5)
    assert claimed is not None
    assert claimed.attempts == 2


def test_network_errors_retry_but_permanent_4xx_is_dead(tmp_path: Path) -> None:
    cfg = config(tmp_path / "outbox.sqlite")
    outbox = Outbox(cfg.outbox_path, KEY)
    outbox.enqueue(event(), now=100.0)
    worker = DeliveryWorker(
        cfg,
        outbox,
        transport=RecordingTransport([TransportError("offline"), 401]),
        clock=lambda: 100.0,
        random_value=lambda: 0.5,
    )

    worker.process_one(now=100.0)
    assert outbox.get_state(EVENT_ID) == "pending"
    worker.process_one(now=102.0)
    assert outbox.get_state(EVENT_ID) == "dead"


def test_attempt_limit_is_terminal_even_for_transient_status(tmp_path: Path) -> None:
    cfg = replace(config(tmp_path / "outbox.sqlite"), max_attempts=1)
    outbox = Outbox(cfg.outbox_path, KEY)
    outbox.enqueue(event(), now=100.0)
    worker = DeliveryWorker(cfg, outbox, transport=RecordingTransport([429]), clock=lambda: 100.0)

    worker.process_one(now=100.0)

    assert outbox.get_state(EVENT_ID) == "dead"


def test_heartbeat_is_signed_every_30_seconds_with_only_health_metadata(tmp_path: Path) -> None:
    cfg = config(tmp_path / "outbox.sqlite")
    outbox = Outbox(cfg.outbox_path, KEY)
    outbox.enqueue(event(), now=100.0)
    transport = RecordingTransport([204])
    worker = DeliveryWorker(
        cfg,
        outbox,
        transport=transport,
        clock=lambda: 100.0,
        uuid_factory=lambda: "018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e99",
    )

    assert not worker.process_heartbeat(now=129.9)
    assert worker.process_heartbeat(now=130.0)

    url, body, headers, _ = transport.calls[0]
    payload = json.loads(body)
    assert url == cfg.heartbeat_url
    assert payload == {
        "instance_id": "alpha-prod-01",
        "oldest_event_age_seconds": 30.0,
        "pending_count": 1,
        "plugin_version": "0.1.0",
    }
    assert headers["X-Request-ID"] == "018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e99"
    assert headers["X-Webhook-Signature-V2"] == hmac_sha256_v2(
        cfg.shared_secret, "130", body
    )


def test_heartbeat_failure_is_non_fatal_and_next_interval_is_bounded(tmp_path: Path) -> None:
    cfg = config(tmp_path / "outbox.sqlite")
    outbox = Outbox(cfg.outbox_path, KEY)
    transport = RecordingTransport([TransportError("offline"), 204])
    worker = DeliveryWorker(cfg, outbox, transport=transport, clock=lambda: 0.0)

    assert worker.process_heartbeat(now=30.0)
    assert not worker.process_heartbeat(now=59.9)
    assert worker.process_heartbeat(now=60.0)


def test_background_worker_stops_cleanly(tmp_path: Path) -> None:
    cfg = config(tmp_path / "outbox.sqlite")
    outbox = Outbox(cfg.outbox_path, KEY)
    worker = DeliveryWorker(cfg, outbox, transport=RecordingTransport([]))

    worker.start()
    assert worker.is_alive()
    worker.stop(timeout=1.0)

    assert not worker.is_alive()
    assert not any(
        thread.name == "hermes-bridge-outbound" and thread.is_alive()
        for thread in threading.enumerate()
    )
