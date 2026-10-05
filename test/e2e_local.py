#!/usr/bin/env python3
"""Black-box local E2E for plugin -> API -> PostgreSQL worker -> mock receivers."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import tempfile
import time
import uuid
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from hermes_bridge_outbound.config import BridgeConfig
from hermes_bridge_outbound.outbox import Outbox
from hermes_bridge_outbound.worker import DeliveryWorker

AGENTS = {
    "alpha": {
        "secret": "local-alpha-api-hmac-secret-change-me",
        "target": "beta",
        "mock": "http://127.0.0.1:18082",
    },
    "beta": {
        "secret": "local-beta-api-hmac-secret-change-me",
        "target": "alpha",
        "mock": "http://127.0.0.1:18081",
    },
}


def request_json(
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any]:
    request = Request(
        url,
        data=data,
        headers=headers or {},
        method="POST" if data is not None else "GET",
    )
    try:
        with urlopen(request, timeout=5) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except HTTPError as error:
        body = error.read()
        return error.code, json.loads(body) if body else None


def wait_ready(url: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status, _ = request_json(url)
            if status == 200:
                return
        except (URLError, TimeoutError, json.JSONDecodeError):
            pass
        time.sleep(0.5)
    raise AssertionError(f"timed out waiting for {url}")


def make_event(agent: str, mode: str = "observe") -> dict[str, Any]:
    event_id = str(uuid.uuid4())
    now = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    target = str(AGENTS[agent]["target"])
    return {
        "schema_version": 1,
        "event_type": "hermes.agent.message",
        "event_id": event_id,
        "occurred_at": now,
        "delivery_semantics": "generated",
        "source": {
            "agent_id": agent,
            "instance_id": f"{agent}-local-e2e",
            "platform": "telegram",
            "chat_id": "-1000000000001",
            "thread_id": None,
            "session_id": f"local-e2e-{agent}",
        },
        "target": {"agent_id": target},
        "conversation": {
            "channel_key": "telegram:-1000000000001",
            "mode": mode,
            "root_event_id": event_id,
            "causation_id": None,
            "hop": 0,
        },
        "message": {
            "text": f"local E2E {mode} from {agent} {event_id}",
            "trigger_text": f"local E2E {mode} from {agent}",
            "format": "telegram-markdown",
        },
        "context": {"recent_messages": []},
    }


def post_event(api_url: str, agent: str, event: dict[str, Any]) -> tuple[int, Any]:
    raw = json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode()
    timestamp = str(int(time.time()))
    signature = hmac.new(
        str(AGENTS[agent]["secret"]).encode(),
        timestamp.encode() + b"." + raw,
        hashlib.sha256,
    ).hexdigest()
    return request_json(
        f"{api_url}/v1/events",
        data=raw,
        headers={
            "Content-Type": "application/json",
            "X-Bridge-Agent": agent,
            "X-Request-ID": str(event["event_id"]),
            "X-Webhook-Timestamp": timestamp,
            "X-Webhook-Signature-V2": signature,
        },
    )


def reset_mock(mock_url: str) -> None:
    status, payload = request_json(f"{mock_url}/reset", data=b"")
    assert status == 200 and payload == {"status": "reset"}, (status, payload)


def fail_next(mock_url: str, count: int) -> None:
    raw = json.dumps({"count": count}, separators=(",", ":")).encode()
    status, payload = request_json(
        f"{mock_url}/control/fail-next",
        data=raw,
        headers={"Content-Type": "application/json"},
    )
    assert status == 200 and payload == {"failures_remaining": count}, (status, payload)


def inspect_mock(mock_url: str) -> dict[str, Any]:
    status, payload = request_json(f"{mock_url}/inspect")
    assert status == 200 and isinstance(payload, dict), (status, payload)
    return payload


def wait_for_delivery(mock_url: str, event_id: str, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        payload = inspect_mock(mock_url)
        for delivery in payload["deliveries"]:
            if delivery.get("payload", {}).get("event_id") == event_id:
                return delivery
        time.sleep(0.25)
    raise AssertionError(f"delivery {event_id} not observed at {mock_url}")


def wait_for_order(mock_url: str, event_ids: list[str], timeout: float) -> list[str]:
    expected = set(event_ids)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        payload = inspect_mock(mock_url)
        observed = [
            str(delivery.get("payload", {}).get("event_id"))
            for delivery in payload["deliveries"]
            if delivery.get("payload", {}).get("event_id") in expected
        ]
        if len(observed) == len(event_ids):
            return observed
        time.sleep(0.25)
    raise AssertionError(f"deliveries {event_ids} not completed at {mock_url}")


def assert_duplicate_and_conflict(api_url: str, event: dict[str, Any]) -> None:
    duplicate_status, duplicate = post_event(api_url, str(event["source"]["agent_id"]), event)
    assert duplicate_status == 202, (duplicate_status, duplicate)
    assert duplicate == {"event_id": event["event_id"], "status": "accepted"}, duplicate

    conflict = deepcopy(event)
    conflict["message"]["text"] = "same event ID with a different authenticated payload"
    conflict_status, conflict_response = post_event(
        api_url,
        str(event["source"]["agent_id"]),
        conflict,
    )
    assert conflict_status == 409, (conflict_status, conflict_response)
    assert conflict_response.get("reason") == "event_id_payload_conflict", conflict_response


def assert_non_observe_modes_blocked(api_url: str) -> None:
    request_event = make_event("alpha", mode="request")
    status, response = post_event(api_url, "alpha", request_event)
    assert status == 422 and response.get("reason") == "requests_disabled", (status, response)

    response_event = make_event("alpha", mode="response")
    response_event["conversation"].update(
        {
            "root_event_id": str(uuid.uuid4()),
            "causation_id": str(uuid.uuid4()),
            "hop": 1,
        }
    )
    status, response = post_event(api_url, "alpha", response_event)
    assert status == 422 and response.get("reason") == "requests_disabled", (status, response)


def assert_retry_preserves_channel_order(api_url: str, timeout: float) -> None:
    receiver = str(AGENTS["beta"]["mock"])
    reset_mock(receiver)
    fail_next(receiver, 1)
    first = make_event("beta")
    second = make_event("beta")

    for event in (first, second):
        status, response = post_event(api_url, "beta", event)
        assert status == 202, (status, response)

    expected = [str(first["event_id"]), str(second["event_id"])]
    observed = wait_for_order(receiver, expected, timeout)
    assert observed == expected, {"expected": expected, "observed": observed}
    assert inspect_mock(receiver)["failures_remaining"] == 0


def assert_plugin_producer_delivery(api_url: str, timeout: float) -> None:
    receiver = str(AGENTS["alpha"]["mock"])
    reset_mock(receiver)
    event = make_event("alpha")
    message_plaintext = str(event["message"]["text"]).encode()

    with tempfile.TemporaryDirectory(prefix="hermes-bridge-e2e-") as temporary:
        outbox_path = Path(temporary) / "outbox.sqlite"
        outbox = Outbox(outbox_path, hashlib.sha256(b"plugin-local-e2e-key").digest())
        config = BridgeConfig(
            enabled=True,
            agent_id="alpha",
            instance_id="alpha-local-e2e",
            api_url=f"{api_url}/v1/events",
            heartbeat_url=f"{api_url}/v1/agents/heartbeat",
            shared_secret=str(AGENTS["alpha"]["secret"]).encode(),
            encryption_key=hashlib.sha256(b"plugin-local-e2e-key").digest(),
            peer_agent_id="beta",
            poll_interval_seconds=0.05,
            retry_base_seconds=0.1,
            retry_max_seconds=1.0,
            retry_jitter_ratio=0.0,
        )
        worker = DeliveryWorker(config, outbox, random_value=lambda: 0.5)
        assert worker.enqueue(event)

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and outbox.get_state(str(event["event_id"])) != "sent":
            worker.process_one()
            time.sleep(0.05)
        assert outbox.get_state(str(event["event_id"])) == "sent"
        assert outbox.count() == 1
        wait_for_delivery(receiver, str(event["event_id"]), timeout)

        for candidate in (outbox_path, Path(f"{outbox_path}-wal"), Path(f"{outbox_path}-shm")):
            if candidate.exists():
                assert message_plaintext not in candidate.read_bytes(), candidate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", default="http://127.0.0.1:18080")
    parser.add_argument("--timeout", type=float, default=45.0)
    args = parser.parse_args()

    wait_ready(f"{args.api_url}/healthz", args.timeout)
    wait_ready(f"{args.api_url}/readyz", args.timeout)
    for config in AGENTS.values():
        wait_ready(f"{config['mock']}/healthz", args.timeout)
        reset_mock(str(config["mock"]))

    direct_event_ids: list[str] = []
    first_event: dict[str, Any] | None = None
    for agent, config in AGENTS.items():
        event = make_event(agent)
        status, response = post_event(args.api_url, agent, event)
        assert status == 202, (status, response)
        assert response == {"event_id": event["event_id"], "status": "accepted"}, response
        delivery = wait_for_delivery(str(config["mock"]), str(event["event_id"]), args.timeout)
        assert delivery["payload"]["conversation"]["mode"] == "observe", delivery
        assert delivery["route"] == f"peer-{agent}", delivery
        direct_event_ids.append(str(event["event_id"]))
        if first_event is None:
            first_event = event

    assert first_event is not None
    assert_duplicate_and_conflict(args.api_url, first_event)
    assert_non_observe_modes_blocked(args.api_url)
    assert_retry_preserves_channel_order(args.api_url, args.timeout)
    assert_plugin_producer_delivery(args.api_url, args.timeout)

    print(
        json.dumps(
            {
                "status": "ok",
                "direct_observe_deliveries": len(direct_event_ids),
                "idempotency": "duplicate-and-conflict-verified",
                "non_observe_modes": "blocked",
                "retry_ordering": "verified",
                "plugin_outbox_delivery": "verified-encrypted",
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
