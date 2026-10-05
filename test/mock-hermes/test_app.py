# ruff: noqa: I001 - local test double is imported after its path is injected
from __future__ import annotations

import hashlib
import hmac
import json
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import create_server


SECRET = "test-only-mock-hermes-secret"


class MockHermesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = create_server("127.0.0.1", 0, SECRET, replay_window_seconds=300)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address
        cls.base_url = f"http://{host}:{port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        status, body = self.request("POST", "/reset", b"")
        self.assertEqual(200, status)
        self.assertEqual({"status": "reset"}, body)

    @staticmethod
    def signed_headers(
        body: bytes,
        *,
        request_id: str = "request-1",
        timestamp: int | None = None,
        secret: str = SECRET,
    ) -> dict[str, str]:
        timestamp_value = str(timestamp if timestamp is not None else int(time.time()))
        signed_content = timestamp_value.encode() + b"." + body
        signature = hmac.new(secret.encode(), signed_content, hashlib.sha256).hexdigest()
        return {
            "Content-Type": "application/json",
            "X-Request-ID": request_id,
            "X-Webhook-Timestamp": timestamp_value,
            "X-Webhook-Signature-V2": signature,
        }

    @classmethod
    def request(
        cls,
        method: str,
        path: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict]:
        request = urllib.request.Request(
            f"{cls.base_url}{path}",
            data=body,
            method=method,
            headers=headers or {},
        )
        try:
            response = urllib.request.urlopen(request, timeout=2)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            payload = response.read()
            return response.status, json.loads(payload.decode())

    def test_healthz_reports_ready_without_exposing_state(self) -> None:
        status, body = self.request("GET", "/healthz")

        self.assertEqual(200, status)
        self.assertEqual({"status": "ok"}, body)

    def test_accepts_valid_hmac_v2_and_records_delivery_for_inspection(self) -> None:
        payload = {"event_type": "bridge.generated", "event_id": "event-1"}
        raw_body = json.dumps(payload, separators=(",", ":")).encode()

        status, response = self.request(
            "POST",
            "/webhooks/bridge-generated",
            raw_body,
            self.signed_headers(raw_body, request_id="delivery-1"),
        )

        self.assertEqual(202, status)
        self.assertEqual(
            {
                "status": "accepted",
                "route": "bridge-generated",
                "event": "bridge.generated",
                "delivery_id": "delivery-1",
            },
            response,
        )
        inspect_status, inspect = self.request("GET", "/inspect")
        self.assertEqual(200, inspect_status)
        self.assertEqual(1, inspect["accepted_count"])
        self.assertEqual(0, inspect["duplicate_count"])
        self.assertEqual(1, len(inspect["deliveries"]))
        self.assertEqual("bridge-generated", inspect["deliveries"][0]["route"])
        self.assertEqual("delivery-1", inspect["deliveries"][0]["delivery_id"])
        self.assertEqual(payload, inspect["deliveries"][0]["payload"])

    def test_controlled_transient_failure_does_not_record_until_retry(self) -> None:
        control_raw = b'{"count":1}'
        control_status, control = self.request("POST", "/control/fail-next", control_raw)
        self.assertEqual(200, control_status)
        self.assertEqual({"failures_remaining": 1}, control)

        raw_body = b'{"event_type":"bridge.generated","event_id":"retry-event"}'
        headers = self.signed_headers(raw_body, request_id="retry-delivery")
        first_status, first = self.request(
            "POST", "/webhooks/bridge-generated", raw_body, headers
        )
        second_status, _ = self.request(
            "POST", "/webhooks/bridge-generated", raw_body, headers
        )

        self.assertEqual(503, first_status)
        self.assertEqual({"error": "Injected transient failure"}, first)
        self.assertEqual(202, second_status)
        _, inspect = self.request("GET", "/inspect")
        self.assertEqual(1, inspect["accepted_count"])
        self.assertEqual(0, inspect["failures_remaining"])

    def test_duplicate_request_id_returns_success_without_recording_twice(self) -> None:
        raw_body = b'{"event_type":"bridge.delivered","event_id":"event-2"}'
        headers = self.signed_headers(raw_body, request_id="delivery-2")

        first_status, _ = self.request(
            "POST", "/webhooks/bridge-delivered", raw_body, headers
        )
        second_status, second = self.request(
            "POST", "/webhooks/bridge-delivered", raw_body, headers
        )

        self.assertEqual(202, first_status)
        self.assertEqual(200, second_status)
        self.assertEqual(
            {"status": "duplicate", "delivery_id": "delivery-2"}, second
        )
        _, inspect = self.request("GET", "/inspect")
        self.assertEqual(1, inspect["accepted_count"])
        self.assertEqual(1, inspect["duplicate_count"])
        self.assertEqual(1, len(inspect["deliveries"]))

    def test_rejects_invalid_signature_without_recording_delivery(self) -> None:
        raw_body = b'{"event_type":"bridge.generated"}'
        headers = self.signed_headers(raw_body, secret="wrong-secret")

        status, response = self.request(
            "POST", "/webhooks/bridge-generated", raw_body, headers
        )

        self.assertEqual(401, status)
        self.assertEqual({"error": "Invalid signature"}, response)
        _, inspect = self.request("GET", "/inspect")
        self.assertEqual([], inspect["deliveries"])

    def test_rejects_stale_timestamp_without_recording_delivery(self) -> None:
        raw_body = b'{"event_type":"bridge.generated"}'
        headers = self.signed_headers(raw_body, timestamp=int(time.time()) - 301)

        status, response = self.request(
            "POST", "/webhooks/bridge-generated", raw_body, headers
        )

        self.assertEqual(401, status)
        self.assertEqual({"error": "Invalid signature"}, response)
        _, inspect = self.request("GET", "/inspect")
        self.assertEqual([], inspect["deliveries"])

    def test_rejects_malformed_json_after_signature_validation(self) -> None:
        raw_body = b"not-json"

        status, response = self.request(
            "POST",
            "/webhooks/bridge-generated",
            raw_body,
            self.signed_headers(raw_body),
        )

        self.assertEqual(400, status)
        self.assertEqual({"error": "Cannot parse body"}, response)

    def test_reset_clears_deliveries_and_idempotency_keys(self) -> None:
        raw_body = b'{"event_type":"bridge.generated"}'
        headers = self.signed_headers(raw_body, request_id="reusable-id")
        self.assertEqual(
            202,
            self.request("POST", "/webhooks/bridge-generated", raw_body, headers)[0],
        )

        self.assertEqual(200, self.request("POST", "/reset", b"")[0])
        replay_status, _ = self.request(
            "POST", "/webhooks/bridge-generated", raw_body, headers
        )

        self.assertEqual(202, replay_status)
        _, inspect = self.request("GET", "/inspect")
        self.assertEqual(1, inspect["accepted_count"])
        self.assertEqual(0, inspect["duplicate_count"])


if __name__ == "__main__":
    unittest.main()
