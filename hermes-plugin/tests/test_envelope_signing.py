from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from hermes_bridge_outbound.envelope import EnvelopeConfig, build_event, canonical_json
from hermes_bridge_outbound.policy import SessionSource, TurnDecision, TurnMode
from hermes_bridge_outbound.signing import hmac_sha256_v2, signed_headers

REPO_ROOT = Path(__file__).resolve().parents[2]
EVENT_ID = "018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e10"
ROOT_ID = "018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e11"
NOW = datetime(2026, 7, 18, 12, 0, tzinfo=UTC)


def test_generated_envelope_validates_against_event_v1_schema() -> None:
    decision = TurnDecision(
        mode=TurnMode.REQUEST,
        target_agent_id="beta",
        message_text="Please inspect the outbox.",
        trigger_text="Can you ask Beta?",
        root_event_id=None,
        causation_id=None,
        hop=0,
        channel_key=None,
    )
    source = SessionSource("telegram", "-100123", "42", "session-1")
    history = [
        {"role": "user", "content": "old question"},
        {"role": "assistant", "content": "old answer"},
    ]

    event = build_event(
        decision=decision,
        source=source,
        config=EnvelopeConfig("alpha", "alpha-prod-01"),
        event_id=EVENT_ID,
        occurred_at=NOW,
        conversation_history=history,
    )

    schema = json.loads((REPO_ROOT / "contracts/event.v1.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(event)
    assert event["schema_version"] == 1
    assert event["event_type"] == "hermes.agent.message"
    assert event["delivery_semantics"] == "generated"
    assert event["conversation"] == {
        "channel_key": "telegram:-100123:42",
        "mode": "request",
        "root_event_id": EVENT_ID,
        "causation_id": None,
        "hop": 0,
    }
    assert event["message"]["format"] == "telegram-markdown"
    assert event["context"]["recent_messages"] == []


def test_response_preserves_root_channel_and_sets_causation() -> None:
    decision = TurnDecision(
        TurnMode.RESPONSE,
        "beta",
        "response text",
        "wrapped inbound prompt",
        ROOT_ID,
        EVENT_ID,
        1,
        "telegram:-100123:42",
    )

    event = build_event(
        decision,
        SessionSource("webhook", "webhook:route:id", None, "session-2", "route"),
        EnvelopeConfig("alpha", "alpha-prod-01"),
        event_id="018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e12",
        occurred_at=NOW,
        conversation_history=[],
    )

    assert event["source"]["platform"] == "webhook"
    assert event["conversation"]["root_event_id"] == ROOT_ID
    assert event["conversation"]["causation_id"] == EVENT_ID
    assert event["conversation"]["channel_key"] == "telegram:-100123:42"
    assert event["conversation"]["mode"] == "response"


def test_envelope_caps_message_sizes_and_omits_source_context() -> None:
    decision = TurnDecision(
        TurnMode.OBSERVE,
        "beta",
        "x" * 20_000,
        "y" * 10_000,
        None,
        None,
        0,
        None,
    )
    history = [{"role": "user", "content": str(index) * 20_000} for index in range(10)]

    event = build_event(
        decision,
        SessionSource("telegram", "chat", None, "session"),
        EnvelopeConfig("alpha", "alpha-prod-01"),
        event_id=EVENT_ID,
        occurred_at=NOW,
        conversation_history=history,
    )

    assert len(event["message"]["text"]) == 16_384
    assert len(event["message"]["trigger_text"]) == 8_192
    # Rolling context is Bridge-owned. The source plugin must not populate it.
    assert event["context"]["recent_messages"] == []


def test_canonical_json_is_stable_utf8_without_spacing() -> None:
    body = canonical_json({"z": "Türkçe", "a": 1})
    assert body == b'{"a":1,"z":"T\xc3\xbcrk\xc3\xa7e"}'


def test_hmac_v2_matches_committed_raw_body_vector() -> None:
    vectors = json.loads((REPO_ROOT / "contracts/hmac-v2.test-vectors.json").read_text())
    vector = vectors["vectors"][0]

    actual = hmac_sha256_v2(
        vector["secret"].encode(),
        vector["timestamp"],
        vector["raw_body"].encode(),
    )

    assert actual == vector["expected_signature_v2"]


def test_signed_headers_cover_exact_raw_body_and_identify_agent() -> None:
    body = b'{"a":1}'
    headers = signed_headers(
        secret=b"a-secret-long-enough-for-tests",
        timestamp="1760702400",
        raw_body=body,
        agent_id="alpha",
        request_id=EVENT_ID,
    )

    assert headers == {
        "Content-Type": "application/json",
        "X-Bridge-Agent": "alpha",
        "X-Request-ID": EVENT_ID,
        "X-Webhook-Timestamp": "1760702400",
        "X-Webhook-Signature-V2": hmac_sha256_v2(
            b"a-secret-long-enough-for-tests", "1760702400", body
        ),
    }
    assert headers["X-Webhook-Signature-V2"] != hmac_sha256_v2(
        b"a-secret-long-enough-for-tests", "1760702400", b'{"a": 1}'
    )
