"""Encrypted, durable SQLite WAL outbox."""

from __future__ import annotations

import hashlib
import os
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .envelope import canonical_json

_SCHEMA = """
CREATE TABLE IF NOT EXISTS outbox_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    channel_key TEXT NOT NULL,
    causation_id TEXT,
    target_agent_id TEXT NOT NULL,
    payload_nonce BLOB NOT NULL,
    payload_ciphertext BLOB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at REAL NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    last_error_code TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_one_response_per_request
    ON outbox_events(causation_id, target_agent_id)
    WHERE causation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbox_delivery_order
    ON outbox_events(status, next_attempt_at, sequence);
"""


class OutboxStateError(RuntimeError):
    """Raised when a state transition does not match the durable current state."""


class OutboxEncryptionError(RuntimeError):
    """Raised when an encrypted payload cannot be authenticated."""


@dataclass(frozen=True, slots=True)
class OutboxItem:
    """One atomically claimed delivery, decrypted only in worker memory."""

    event_id: str
    channel_key: str
    attempts: int
    raw_body: bytes


class Outbox:
    """SQLite outbox with authenticated encryption and atomic claims."""

    def __init__(self, path: Path, encryption_key: bytes) -> None:
        self.path = path.expanduser().resolve()
        self._cipher = AESGCM(
            hashlib.sha256(b"hermes-bridge-outbox-v1\0" + encryption_key).digest()
        )
        self._prepare_path()
        with closing(self._connect()) as connection:
            connection.executescript(_SCHEMA)
            # A process restart may leave records claimed but not delivered. No
            # network call occurs before a durable terminal transition, so they
            # are safe to retry under at-least-once delivery semantics.
            connection.execute(
                "UPDATE outbox_events SET status = 'pending' WHERE status = 'sending'"
            )
        self._secure_files()

    def _prepare_path(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        try:
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            os.chmod(self.path, 0o600)
        else:
            os.close(descriptor)

    def _connect(self, *, timeout_seconds: float = 5.0) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.path,
            timeout=timeout_seconds,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute(f"PRAGMA busy_timeout = {int(timeout_seconds * 1000)}")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        self._secure_files()
        return connection

    def _secure_files(self) -> None:
        if self.path.exists():
            os.chmod(self.path, 0o600)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{self.path}{suffix}")
            if sidecar.exists():
                os.chmod(sidecar, 0o600)

    def _encrypt(self, event_id: str, raw_body: bytes) -> tuple[bytes, bytes]:
        nonce = os.urandom(12)
        return nonce, self._cipher.encrypt(nonce, raw_body, event_id.encode("ascii"))

    def _decrypt(self, event_id: str, nonce: bytes, ciphertext: bytes) -> bytes:
        try:
            return self._cipher.decrypt(nonce, ciphertext, event_id.encode("ascii"))
        except InvalidTag as exc:
            raise OutboxEncryptionError("outbox payload authentication failed") from exc

    def enqueue(self, event: dict[str, Any], *, now: float) -> bool:
        """Encrypt and persist one event; duplicate IDs/response causes are idempotent."""

        event_id = str(event["event_id"])
        conversation = event["conversation"]
        target = event["target"]
        if not isinstance(conversation, dict) or not isinstance(target, dict):
            raise ValueError("event conversation and target must be objects")
        channel_key = str(conversation["channel_key"])
        causation_value = conversation.get("causation_id")
        causation_id = str(causation_value) if causation_value is not None else None
        target_agent_id = str(target["agent_id"])
        raw_body = canonical_json(event)
        nonce, ciphertext = self._encrypt(event_id, raw_body)
        connection = self._connect(timeout_seconds=0.05)
        try:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """
                    INSERT INTO outbox_events (
                        event_id, channel_key, causation_id, target_agent_id,
                        payload_nonce, payload_ciphertext, status, attempt_count,
                        next_attempt_at, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
                    """,
                    (
                        event_id,
                        channel_key,
                        causation_id,
                        target_agent_id,
                        nonce,
                        ciphertext,
                        now,
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError:
                connection.execute("ROLLBACK")
                return False
            connection.execute("COMMIT")
            return True
        finally:
            connection.close()
            self._secure_files()

    def claim_due(self, *, now: float) -> OutboxItem | None:
        """Atomically claim the oldest due head-of-line event across channels."""

        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT current.*
                FROM outbox_events AS current
                WHERE current.status = 'pending'
                  AND current.next_attempt_at <= ?
                  AND NOT EXISTS (
                      SELECT 1 FROM outbox_events AS earlier
                      WHERE earlier.channel_key = current.channel_key
                        AND earlier.sequence < current.sequence
                        AND earlier.status IN ('pending', 'sending')
                  )
                ORDER BY current.next_attempt_at, current.sequence
                LIMIT 1
                """,
                (now,),
            ).fetchone()
            if row is None:
                connection.execute("COMMIT")
                return None
            changed = connection.execute(
                """
                UPDATE outbox_events
                SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ?
                WHERE event_id = ? AND status = 'pending'
                """,
                (now, row["event_id"]),
            ).rowcount
            if changed != 1:
                connection.execute("ROLLBACK")
                return None
            connection.execute("COMMIT")
            raw_body = self._decrypt(
                row["event_id"],
                bytes(row["payload_nonce"]),
                bytes(row["payload_ciphertext"]),
            )
            return OutboxItem(
                event_id=row["event_id"],
                channel_key=row["channel_key"],
                attempts=int(row["attempt_count"]) + 1,
                raw_body=raw_body,
            )
        finally:
            connection.close()
            self._secure_files()

    def _transition(
        self,
        event_id: str,
        *,
        status: str,
        now: float,
        error_code: str | None,
        next_attempt_at: float | None = None,
    ) -> bool:
        connection = self._connect()
        try:
            if next_attempt_at is None:
                result = connection.execute(
                    """
                    UPDATE outbox_events
                    SET status = ?, updated_at = ?, last_error_code = ?
                    WHERE event_id = ? AND status = 'sending'
                    """,
                    (status, now, error_code, event_id),
                )
            else:
                result = connection.execute(
                    """
                    UPDATE outbox_events
                    SET status = ?, next_attempt_at = ?, updated_at = ?, last_error_code = ?
                    WHERE event_id = ? AND status = 'sending'
                    """,
                    (status, next_attempt_at, now, error_code, event_id),
                )
            if result.rowcount != 1:
                raise OutboxStateError(
                    f"event {event_id} cannot transition from its current state to {status}"
                )
            return True
        finally:
            connection.close()
            self._secure_files()

    def mark_sent(self, event_id: str, *, now: float) -> bool:
        """Transition one claimed event from sending to sent."""

        return self._transition(event_id, status="sent", now=now, error_code=None)

    def reschedule(
        self,
        event_id: str,
        *,
        next_attempt_at: float,
        error_code: str,
        now: float,
    ) -> bool:
        """Return a transiently failed claim to pending with a bounded due time."""

        return self._transition(
            event_id,
            status="pending",
            now=now,
            error_code=error_code,
            next_attempt_at=next_attempt_at,
        )

    def mark_dead(self, event_id: str, *, error_code: str, now: float) -> bool:
        """Terminally reject one claimed event without storing remote response text."""

        return self._transition(event_id, status="dead", now=now, error_code=error_code)

    def get_state(self, event_id: str) -> str | None:
        """Return one event state for diagnostics and tests."""

        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT status FROM outbox_events WHERE event_id = ?", (event_id,)
            ).fetchone()
        self._secure_files()
        return None if row is None else str(row["status"])

    def count(self) -> int:
        """Return total durable records without decrypting payloads."""

        with closing(self._connect()) as connection:
            value = connection.execute("SELECT COUNT(*) FROM outbox_events").fetchone()[0]
        self._secure_files()
        return int(value)

    def stats(self, *, now: float) -> dict[str, int | float | None]:
        """Return PII-free health fields for signed heartbeat payloads."""

        with closing(self._connect()) as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS pending_count, MIN(created_at) AS oldest
                FROM outbox_events WHERE status IN ('pending', 'sending')
                """
            ).fetchone()
        self._secure_files()
        oldest = row["oldest"]
        age = None if oldest is None else max(0.0, now - float(oldest))
        return {"pending_count": int(row["pending_count"]), "oldest_event_age_seconds": age}
