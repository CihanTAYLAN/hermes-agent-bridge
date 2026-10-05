"""Durable hook ingestion, background delivery, and signed heartbeat."""

from __future__ import annotations

import logging
import random
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable
from typing import Any, Protocol

from .config import BridgeConfig
from .envelope import canonical_json
from .outbox import Outbox, OutboxEncryptionError, OutboxItem
from .signing import signed_headers

PLUGIN_VERSION = "0.1.0"
logger = logging.getLogger(__name__)


class TransportError(RuntimeError):
    """Sanitized transport failure without response-body contents."""


class HttpTransport(Protocol):
    """Minimal synchronous transport used only on the worker thread."""

    def post(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        """POST bytes and return only the HTTP status code."""


class UrllibTransport:
    """Stdlib raw-body HTTP transport."""

    def post(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return int(response.status)
        except urllib.error.HTTPError as exc:
            # HTTPError is also a response. Never read its body: it may echo payloads.
            return int(exc.code)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise TransportError(type(exc).__name__) from exc


class DeliveryWorker:
    """Single background worker that drains the durable outbox."""

    def __init__(
        self,
        config: BridgeConfig,
        outbox: Outbox,
        *,
        transport: HttpTransport | None = None,
        clock: Callable[[], float] = time.time,
        random_value: Callable[[], float] = random.random,
        uuid_factory: Callable[[], str] = lambda: str(uuid.uuid4()),
    ) -> None:
        self.config = config
        self.outbox = outbox
        self.transport = transport or UrllibTransport()
        self._clock = clock
        self._random_value = random_value
        self._uuid_factory = uuid_factory
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._lifecycle_lock = threading.Lock()
        self._next_heartbeat_at = self._clock() + config.heartbeat_interval_seconds

    def enqueue(self, event: dict[str, Any], *, now: float | None = None) -> bool:
        """Durably accept an event before the Hermes hook returns."""

        return self.outbox.enqueue(event, now=self._clock() if now is None else now)

    def _headers(self, raw_body: bytes, request_id: str, now: float) -> dict[str, str]:
        timestamp = str(int(now))
        return signed_headers(
            secret=self.config.shared_secret,
            timestamp=timestamp,
            raw_body=raw_body,
            agent_id=self.config.agent_id,
            request_id=request_id,
        )

    def _post(self, url: str, raw_body: bytes, request_id: str, now: float) -> int:
        return self.transport.post(
            url,
            raw_body,
            self._headers(raw_body, request_id, now),
            self.config.http_timeout_seconds,
        )

    def _retry_delay(self, attempts: int) -> float:
        exponential = self.config.retry_base_seconds * (2 ** max(0, attempts - 1))
        bounded = min(self.config.retry_max_seconds, exponential)
        centered = (2.0 * min(1.0, max(0.0, self._random_value()))) - 1.0
        jittered = bounded * (1.0 + self.config.retry_jitter_ratio * centered)
        return float(min(self.config.retry_max_seconds, max(0.0, jittered)))

    @staticmethod
    def _is_transient(status: int) -> bool:
        return status in {408, 425, 429} or 500 <= status <= 599

    def _retry_or_dead(self, item: OutboxItem, *, now: float, error_code: str) -> None:
        if item.attempts >= self.config.max_attempts:
            self.outbox.mark_dead(item.event_id, error_code="attempts_exhausted", now=now)
            return
        self.outbox.reschedule(
            item.event_id,
            next_attempt_at=now + self._retry_delay(item.attempts),
            error_code=error_code,
            now=now,
        )

    def process_one(self, *, now: float | None = None) -> bool:
        """Claim and deliver at most one due durable event."""

        current = self._clock() if now is None else now
        try:
            item = self.outbox.claim_due(now=current)
        except OutboxEncryptionError:
            logger.error("Bridge outbox payload authentication failed; delivery halted")
            return False
        if item is None:
            return False
        try:
            status = self._post(self.config.api_url, item.raw_body, item.event_id, current)
        except TransportError as exc:
            self._retry_or_dead(item, now=current, error_code=f"network_{type(exc).__name__}")
            return True
        if 200 <= status <= 299:
            self.outbox.mark_sent(item.event_id, now=current)
        elif self._is_transient(status):
            self._retry_or_dead(item, now=current, error_code=f"http_{status}")
        else:
            self.outbox.mark_dead(item.event_id, error_code=f"http_{status}", now=current)
        return True

    def process_heartbeat(self, *, now: float | None = None) -> bool:
        """Send one signed PII-free heartbeat when its 30-second interval is due."""

        current = self._clock() if now is None else now
        if current < self._next_heartbeat_at:
            return False
        # Advance before I/O so an outage cannot create a busy retry loop.
        self._next_heartbeat_at = current + self.config.heartbeat_interval_seconds
        payload = {
            "instance_id": self.config.instance_id,
            **self.outbox.stats(now=current),
            "plugin_version": PLUGIN_VERSION,
        }
        raw_body = canonical_json(payload)
        request_id = self._uuid_factory()
        try:
            status = self._post(self.config.heartbeat_url, raw_body, request_id, current)
            if not 200 <= status <= 299:
                logger.warning("Hermes Bridge heartbeat rejected with status %d", status)
        except TransportError:
            logger.warning("Hermes Bridge heartbeat transport failed")
        return True

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.process_one()
                self.process_heartbeat()
            except Exception as exc:  # worker must survive isolated DB/transport faults
                logger.error("Hermes Bridge worker cycle failed: %s", type(exc).__name__)
            self._stop_event.wait(self.config.poll_interval_seconds)


    def start(self) -> None:
        """Start one daemon thread; repeated calls are idempotent."""

        with self._lifecycle_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="hermes-bridge-outbound",
                daemon=True,
            )
            self._thread.start()

    def stop(self, *, timeout: float = 5.0) -> None:
        """Signal clean shutdown and wait a bounded time for in-flight I/O."""

        with self._lifecycle_lock:
            thread = self._thread
            self._stop_event.set()
        if thread is not None:
            thread.join(timeout=timeout)
            if thread.is_alive():
                logger.warning("Hermes Bridge worker did not stop before timeout")
            else:
                with self._lifecycle_lock:
                    if self._thread is thread:
                        self._thread = None

    def is_alive(self) -> bool:
        """Return whether the worker thread is currently alive."""

        return self._thread is not None and self._thread.is_alive()
