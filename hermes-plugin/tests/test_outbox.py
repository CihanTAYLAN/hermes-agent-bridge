from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from hermes_bridge_outbound.outbox import Outbox, OutboxItem, OutboxStateError

KEY = b"outbox-encryption-key-that-is-at-least-32-bytes"
EVENT_ID = "018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e10"
SECOND_ID = "018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e11"
CAUSATION_ID = "018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e12"


def event(
    event_id: str = EVENT_ID,
    *,
    text: str = "PLAINTEXT-MUST-NOT-APPEAR-7b893",
    channel: str = "telegram:chat:42",
    causation_id: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": 1,
        "event_type": "hermes.agent.message",
        "event_id": event_id,
        "occurred_at": "2026-07-18T12:00:00.000Z",
        "delivery_semantics": "generated",
        "source": {
            "agent_id": "alpha",
            "instance_id": "alpha-prod-01",
            "platform": "telegram",
            "chat_id": "chat",
            "thread_id": "42",
            "session_id": "session",
        },
        "target": {"agent_id": "beta"},
        "conversation": {
            "channel_key": channel,
            "mode": "response" if causation_id else "observe",
            "root_event_id": event_id,
            "causation_id": causation_id,
            "hop": 1 if causation_id else 0,
        },
        "message": {"text": text, "trigger_text": "trigger", "format": "telegram-markdown"},
        "context": {"recent_messages": []},
    }


def test_sqlite_outbox_uses_wal_0600_and_never_stores_plaintext(tmp_path: Path) -> None:
    path = tmp_path / "private" / "outbox.sqlite"
    outbox = Outbox(path, KEY)

    assert outbox.enqueue(event(), now=100.0)

    with closing(sqlite3.connect(path)) as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        columns = {row[1] for row in conn.execute("PRAGMA table_info(outbox_events)")}
        ciphertext = conn.execute(
            "SELECT payload_ciphertext FROM outbox_events WHERE event_id = ?", (EVENT_ID,)
        ).fetchone()[0]
    assert mode == "wal"
    assert "payload_plaintext" not in columns
    assert b"PLAINTEXT-MUST-NOT-APPEAR-7b893" not in ciphertext
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o077 == 0
    for suffix in ("-wal", "-shm"):
        sidecar = Path(f"{path}{suffix}")
        if sidecar.exists():
            assert sidecar.stat().st_mode & 0o777 == 0o600
            assert b"PLAINTEXT-MUST-NOT-APPEAR-7b893" not in sidecar.read_bytes()
    assert b"PLAINTEXT-MUST-NOT-APPEAR-7b893" not in path.read_bytes()


def test_claim_decrypts_exact_canonical_body_and_advances_state(tmp_path: Path) -> None:
    outbox = Outbox(tmp_path / "outbox.sqlite", KEY)
    outbox.enqueue(event(), now=100.0)

    claimed = outbox.claim_due(now=100.0)

    assert isinstance(claimed, OutboxItem)
    assert claimed.event_id == EVENT_ID
    assert claimed.attempts == 1
    assert b"PLAINTEXT-MUST-NOT-APPEAR-7b893" in claimed.raw_body
    assert outbox.get_state(EVENT_ID) == "sending"
    assert outbox.mark_sent(EVENT_ID, now=101.0)
    assert outbox.get_state(EVENT_ID) == "sent"


def test_response_deduplicates_by_causation_and_target(tmp_path: Path) -> None:
    outbox = Outbox(tmp_path / "outbox.sqlite", KEY)

    assert outbox.enqueue(event(causation_id=CAUSATION_ID), now=100.0)
    assert not outbox.enqueue(
        event(SECOND_ID, text="different generated response", causation_id=CAUSATION_ID), now=101.0
    )
    assert outbox.count() == 1


def test_duplicate_event_id_is_idempotent(tmp_path: Path) -> None:
    outbox = Outbox(tmp_path / "outbox.sqlite", KEY)
    assert outbox.enqueue(event(), now=100.0)
    assert not outbox.enqueue(event(), now=100.0)


def test_startup_recovers_crashed_sending_records(tmp_path: Path) -> None:
    path = tmp_path / "outbox.sqlite"
    first = Outbox(path, KEY)
    first.enqueue(event(), now=100.0)
    assert first.claim_due(now=100.0) is not None
    assert first.get_state(EVENT_ID) == "sending"

    recovered = Outbox(path, KEY)

    assert recovered.get_state(EVENT_ID) == "pending"
    claimed = recovered.claim_due(now=100.0)
    assert claimed is not None
    assert claimed.attempts == 2


def test_two_outbox_instances_cannot_claim_the_same_event(tmp_path: Path) -> None:
    path = tmp_path / "outbox.sqlite"
    first = Outbox(path, KEY)
    second = Outbox(path, KEY)
    first.enqueue(event(), now=100.0)

    claims = [first.claim_due(now=100.0), second.claim_due(now=100.0)]

    assert sum(item is not None for item in claims) == 1


def test_channel_order_blocks_later_event_until_first_is_terminal(tmp_path: Path) -> None:
    outbox = Outbox(tmp_path / "outbox.sqlite", KEY)
    outbox.enqueue(event(EVENT_ID, channel="same"), now=100.0)
    outbox.enqueue(event(SECOND_ID, channel="same"), now=100.0)
    first = outbox.claim_due(now=100.0)
    assert first is not None and first.event_id == EVENT_ID
    outbox.reschedule(EVENT_ID, next_attempt_at=200.0, error_code="http_503", now=101.0)

    assert outbox.claim_due(now=150.0) is None
    retry = outbox.claim_due(now=200.0)
    assert retry is not None and retry.event_id == EVENT_ID
    outbox.mark_dead(EVENT_ID, error_code="attempts_exhausted", now=201.0)
    second = outbox.claim_due(now=201.0)
    assert second is not None and second.event_id == SECOND_ID


def test_invalid_state_transition_fails_closed(tmp_path: Path) -> None:
    outbox = Outbox(tmp_path / "outbox.sqlite", KEY)
    outbox.enqueue(event(), now=100.0)

    with pytest.raises(OutboxStateError):
        outbox.mark_sent(EVENT_ID, now=101.0)


def test_stats_do_not_decrypt_or_return_message_text(tmp_path: Path) -> None:
    outbox = Outbox(tmp_path / "outbox.sqlite", KEY)
    outbox.enqueue(event(), now=100.0)

    stats = outbox.stats(now=105.0)

    assert stats == {"pending_count": 1, "oldest_event_age_seconds": 5.0}
    assert "PLAINTEXT" not in repr(stats)


def test_database_file_is_owner_only_even_with_permissive_umask(tmp_path: Path) -> None:
    old = os.umask(0)
    try:
        path = tmp_path / "outbox.sqlite"
        outbox = Outbox(path, KEY)
        outbox.enqueue(event(), now=100.0)
    finally:
        os.umask(old)

    assert path.stat().st_mode & 0o777 == 0o600
