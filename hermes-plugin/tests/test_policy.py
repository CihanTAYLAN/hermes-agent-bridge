from __future__ import annotations

from dataclasses import replace

import pytest

from hermes_bridge_outbound.policy import (
    BridgeMetadata,
    PolicyConfig,
    SessionSource,
    TurnMode,
    classify_turn,
    format_bridge_marker,
    parse_bridge_marker,
)

EVENT_ID = "018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e10"
ROOT_ID = "018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e11"


@pytest.fixture
def config() -> PolicyConfig:
    return PolicyConfig(
        agent_id="alpha",
        peer_agent_id="beta",
        peer_telegram_username="BetaAgentBot",
        peer_aliases=("beta", "bt"),
        allowed_chat_ids=frozenset({"-100123"}),
        allowed_thread_ids=frozenset({"42"}),
        allowed_webhook_routes=frozenset({"bridge-beta"}),
        requests_enabled=True,
        max_hops=2,
    )


@pytest.fixture
def telegram() -> SessionSource:
    return SessionSource(
        platform="telegram",
        chat_id="-100123",
        thread_id="42",
        session_id="telegram:-100123:42",
    )


def test_target_marker_classifies_telegram_turn_as_request(
    config: PolicyConfig, telegram: SessionSource
) -> None:
    decision = classify_turn(
        user_message="Please review this.",
        assistant_response="[[bridge:to=beta]] I found two issues.",
        source=telegram,
        config=config,
    )

    assert decision is not None
    assert decision.mode is TurnMode.REQUEST
    assert decision.message_text == "I found two issues."
    assert decision.target_agent_id == "beta"


@pytest.mark.parametrize(
    "response",
    [
        "Can @BetaAgentBot check this?",
        "Beta: please check this.",
        "First sentence. Bt, please verify the second.",
    ],
)
def test_username_or_sentence_start_alias_classifies_request(
    config: PolicyConfig, telegram: SessionSource, response: str
) -> None:
    decision = classify_turn("question", response, telegram, config)

    assert decision is not None
    assert decision.mode is TurnMode.REQUEST


def test_alias_inside_word_or_mid_sentence_does_not_request(
    config: PolicyConfig, telegram: SessionSource
) -> None:
    for response in ("The beta result is ready.", "Ask bt, if needed.", "betaium"):
        decision = classify_turn("question", response, telegram, config)
        assert decision is not None
        assert decision.mode is TurnMode.OBSERVE


def test_requests_disabled_downgrades_explicit_target_to_observe(
    config: PolicyConfig, telegram: SessionSource
) -> None:
    decision = classify_turn(
        "question",
        "[[bridge:to=beta]] please inspect",
        telegram,
        replace(config, requests_enabled=False),
    )

    assert decision is not None
    assert decision.mode is TurnMode.OBSERVE


def test_requests_disabled_rejects_inbound_webhook_request(
    config: PolicyConfig,
) -> None:
    incoming = BridgeMetadata(
        event_id=EVENT_ID,
        root_event_id=ROOT_ID,
        causation_id=None,
        mode=TurnMode.REQUEST,
        hop=0,
        source_agent_id="beta",
        target_agent_id="alpha",
        channel_key="telegram:-100123:42",
    )
    source = SessionSource(
        platform="webhook",
        chat_id="webhook:bridge-beta:delivery-1",
        thread_id=None,
        session_id="webhook:bridge-beta:delivery-1",
        route="bridge-beta",
    )

    assert (
        classify_turn(
            f"{format_bridge_marker(incoming)}\nPlease answer.",
            "This must not leave the local agent.",
            source,
            replace(config, requests_enabled=False),
        )
        is None
    )


def test_platform_chat_and_thread_allowlists_fail_closed(
    config: PolicyConfig, telegram: SessionSource
) -> None:
    assert classify_turn("q", "answer", replace(telegram, platform="discord"), config) is None
    assert classify_turn("q", "answer", replace(telegram, chat_id="other"), config) is None
    assert classify_turn("q", "answer", replace(telegram, thread_id="99"), config) is None


@pytest.mark.parametrize(
    "response",
    ["", "  ", "NO_REPLY", "[SILENT]", "⚠️ Processing stopped: timeout"],
)
def test_empty_silent_status_and_error_responses_are_skipped(
    config: PolicyConfig, telegram: SessionSource, response: str
) -> None:
    assert classify_turn("q", response, telegram, config) is None


def test_bridge_marker_round_trip_is_deterministic() -> None:
    metadata = BridgeMetadata(
        event_id=EVENT_ID,
        root_event_id=ROOT_ID,
        causation_id=None,
        mode=TurnMode.REQUEST,
        hop=0,
        source_agent_id="beta",
        target_agent_id="alpha",
        channel_key="telegram:-100123:42",
    )

    marker = format_bridge_marker(metadata)

    assert marker == (
        "[[hermes-bridge:v1 event_id=018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e10 "
        "root_event_id=018f6b52-4d3a-4f6e-8a12-6d9f4c7b2e11 causation_id=- "
        "mode=request hop=0 source=beta target=alpha "
        "channel_key=telegram%3A-100123%3A42]]"
    )
    assert parse_bridge_marker(f"system wrapper\n{marker}\nmessage") == metadata


def test_allowlisted_webhook_request_forces_single_response_mode(config: PolicyConfig) -> None:
    incoming = BridgeMetadata(
        event_id=EVENT_ID,
        root_event_id=ROOT_ID,
        causation_id=None,
        mode=TurnMode.REQUEST,
        hop=0,
        source_agent_id="beta",
        target_agent_id="alpha",
        channel_key="telegram:-100123:42",
    )
    source = SessionSource(
        platform="webhook",
        chat_id="webhook:bridge-beta:delivery-1",
        thread_id=None,
        session_id="webhook:bridge-beta:delivery-1",
        route="bridge-beta",
    )

    decision = classify_turn(
        f"{format_bridge_marker(incoming)}\nPlease answer.",
        "Here is the answer.",
        source,
        config,
    )

    assert decision is not None
    assert decision.mode is TurnMode.RESPONSE
    assert decision.target_agent_id == "beta"
    assert decision.root_event_id == ROOT_ID
    assert decision.causation_id == EVENT_ID
    assert decision.hop == 1
    assert decision.channel_key == "telegram:-100123:42"


@pytest.mark.parametrize("mode", [TurnMode.OBSERVE, TurnMode.RESPONSE])
def test_webhook_observe_and_response_end_the_chain(config: PolicyConfig, mode: TurnMode) -> None:
    incoming = BridgeMetadata(
        event_id=EVENT_ID,
        root_event_id=ROOT_ID,
        causation_id=None,
        mode=mode,
        hop=1,
        source_agent_id="beta",
        target_agent_id="alpha",
        channel_key="telegram:-100123:42",
    )
    source = SessionSource(
        platform="webhook",
        chat_id="webhook:bridge-beta:delivery-1",
        thread_id=None,
        session_id="session",
        route="bridge-beta",
    )

    assert classify_turn(format_bridge_marker(incoming), "must not escape", source, config) is None


def test_webhook_rejects_unallowlisted_route_wrong_target_and_hop_limit(
    config: PolicyConfig,
) -> None:
    source = SessionSource("webhook", "id", None, "session", route="not-allowed")
    valid = BridgeMetadata(
        EVENT_ID,
        ROOT_ID,
        None,
        TurnMode.REQUEST,
        0,
        "beta",
        "alpha",
        "telegram:-100123:42",
    )
    assert classify_turn(format_bridge_marker(valid), "answer", source, config) is None

    source = replace(source, route="bridge-beta")
    wrong_target = replace(valid, target_agent_id="other")
    assert classify_turn(format_bridge_marker(wrong_target), "answer", source, config) is None

    exhausted = replace(valid, hop=2)
    assert classify_turn(format_bridge_marker(exhausted), "answer", source, config) is None
