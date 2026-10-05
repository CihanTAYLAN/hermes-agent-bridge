#!/usr/bin/env python3
"""Hermes webhook test double used by local and CI E2E tests.

The receiver intentionally mirrors the Hermes generic webhook guarantees needed by
this project: HMAC-SHA256 V2 verification, a five-minute replay window, request-ID
idempotency, and 202/200 accepted/duplicate response semantics. It never calls an
LLM and exposes deterministic inspect/reset endpoints for tests.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast
from urllib.parse import urlsplit

MAX_BODY_BYTES = 1_048_576


class DeliveryStore:
    """Thread-safe in-memory delivery store for a single mock process."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._deliveries: list[dict[str, Any]] = []
        self._seen: set[str] = set()
        self._duplicate_count = 0
        self._failures_remaining = 0

    def fail_next(self, count: int) -> None:
        with self._lock:
            self._failures_remaining = count

    def consume_failure(self) -> bool:
        with self._lock:
            if self._failures_remaining == 0:
                return False
            self._failures_remaining -= 1
            return True

    def record(self, delivery_id: str, delivery: dict[str, Any]) -> bool:
        """Record a delivery, returning False when its ID was seen already."""
        with self._lock:
            if delivery_id in self._seen:
                self._duplicate_count += 1
                return False
            self._seen.add(delivery_id)
            self._deliveries.append(delivery)
            return True

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            deliveries = [dict(delivery) for delivery in self._deliveries]
            return {
                "accepted_count": len(deliveries),
                "duplicate_count": self._duplicate_count,
                "failures_remaining": self._failures_remaining,
                "deliveries": deliveries,
            }

    def reset(self) -> None:
        with self._lock:
            self._deliveries.clear()
            self._seen.clear()
            self._duplicate_count = 0
            self._failures_remaining = 0


class MockHermesServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        secret: str,
        replay_window_seconds: int,
    ) -> None:
        if not secret:
            raise ValueError("A non-empty mock Hermes webhook secret is required")
        if replay_window_seconds < 0:
            raise ValueError("Replay window must be non-negative")
        self.secret = secret
        self.replay_window_seconds = replay_window_seconds
        self.store = DeliveryStore()
        super().__init__(server_address, MockHermesHandler)


class MockHermesHandler(BaseHTTPRequestHandler):
    server_version = "MockHermes/1.0"

    @property
    def mock_server(self) -> MockHermesServer:
        return cast(MockHermesServer, self.server)

    def _json_response(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes | None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json_response(400, {"error": "Invalid Content-Length"})
            return None
        if content_length < 0 or content_length > MAX_BODY_BYTES:
            self._json_response(413, {"error": "Payload too large"})
            return None
        return self.rfile.read(content_length)

    def _signature_is_valid(self, body: bytes) -> bool:
        signature = self.headers.get("X-Webhook-Signature-V2", "")
        timestamp = self.headers.get("X-Webhook-Timestamp", "")
        if not signature or not timestamp:
            return False
        try:
            timestamp_seconds = int(timestamp)
        except ValueError:
            return False
        if abs(int(time.time()) - timestamp_seconds) > self.mock_server.replay_window_seconds:
            return False
        signed_content = timestamp.encode() + b"." + body
        expected = hmac.new(
            self.mock_server.secret.encode(), signed_content, hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(signature.encode(), expected.encode())

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/healthz":
            self._json_response(200, {"status": "ok"})
            return
        if path == "/inspect":
            self._json_response(200, self.mock_server.store.snapshot())
            return
        self._json_response(404, {"error": "Not found"})

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        body = self._read_body()
        if body is None:
            return

        if path == "/reset":
            self.mock_server.store.reset()
            self._json_response(200, {"status": "reset"})
            return

        if path == "/control/fail-next":
            try:
                payload = json.loads(body)
                count = payload["count"]
            except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError):
                self._json_response(400, {"error": "Invalid failure control"})
                return
            if not isinstance(count, int) or isinstance(count, bool) or not 0 <= count <= 100:
                self._json_response(400, {"error": "Invalid failure control"})
                return
            self.mock_server.store.fail_next(count)
            self._json_response(200, {"failures_remaining": count})
            return

        prefix = "/webhooks/"
        if not path.startswith(prefix) or len(path) == len(prefix):
            self._json_response(404, {"error": "Not found"})
            return
        route = path[len(prefix) :]
        if "/" in route:
            self._json_response(404, {"error": "Not found"})
            return
        if not self._signature_is_valid(body):
            self._json_response(401, {"error": "Invalid signature"})
            return
        if self.mock_server.store.consume_failure():
            self._json_response(503, {"error": "Injected transient failure"})
            return

        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json_response(400, {"error": "Cannot parse body"})
            return
        if not isinstance(payload, dict):
            self._json_response(400, {"error": "Payload must be a JSON object"})
            return

        event_type = (
            self.headers.get("X-GitHub-Event", "")
            or self.headers.get("X-GitLab-Event", "")
            or str(payload.get("event_type", ""))
            or str(payload.get("type", ""))
            or "unknown"
        )
        delivery_id = (
            self.headers.get("X-GitHub-Delivery", "")
            or self.headers.get("svix-id", "")
            or self.headers.get("X-Request-ID", "")
            or str(int(time.time() * 1000))
        )
        delivery = {
            "delivery_id": delivery_id,
            "event": event_type,
            "payload": payload,
            "received_at": int(time.time()),
            "route": route,
        }
        if not self.mock_server.store.record(delivery_id, delivery):
            self._json_response(
                200, {"status": "duplicate", "delivery_id": delivery_id}
            )
            return

        self._json_response(
            202,
            {
                "status": "accepted",
                "route": route,
                "event": event_type,
                "delivery_id": delivery_id,
            },
        )

    def log_message(self, format: str, *args: Any) -> None:
        if os.environ.get("MOCK_HERMES_LOG_REQUESTS", "0") == "1":
            super().log_message(format, *args)


def create_server(
    host: str,
    port: int,
    secret: str,
    *,
    replay_window_seconds: int = 300,
) -> MockHermesServer:
    return MockHermesServer((host, port), secret, replay_window_seconds)


def main() -> None:
    host = os.environ.get("MOCK_HERMES_HOST", "0.0.0.0")
    port = int(os.environ.get("MOCK_HERMES_PORT", "8080"))
    secret = os.environ.get("MOCK_HERMES_WEBHOOK_SECRET", "")
    replay_window_seconds = int(
        os.environ.get("MOCK_HERMES_REPLAY_WINDOW_SECONDS", "300")
    )
    server = create_server(
        host, port, secret, replay_window_seconds=replay_window_seconds
    )
    print(f"mock Hermes listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
