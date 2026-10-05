from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from hermes_bridge_outbound.config import BridgeConfig, ConfigError

BASE_ENV = {
    "HERMES_BRIDGE_ENABLED": "true",
    "HERMES_BRIDGE_AGENT_ID": "alpha",
    "HERMES_BRIDGE_INSTANCE_ID": "alpha-prod-01",
    "HERMES_BRIDGE_API_URL": "https://bridge.example/v1/events",
    "HERMES_BRIDGE_INGEST_SECRET": "s" * 32,
    "HERMES_BRIDGE_OUTBOX_ENCRYPTION_KEY": "e" * 32,
    "HERMES_BRIDGE_PEER_AGENT_ID": "beta",
    "HERMES_BRIDGE_PEER_USERNAMES": "@BetaAgentBot",
    "HERMES_BRIDGE_PEER_ALIASES": "Beta, bt",
    "HERMES_BRIDGE_ALLOWED_CHAT_IDS": "-100123, -100456",
    "HERMES_BRIDGE_ALLOWED_THREAD_IDS": "42, 43",
    "HERMES_BRIDGE_ALLOWED_WEBHOOK_ROUTES": "bridge-beta",
    "HERMES_BRIDGE_REQUESTS_ENABLED": "false",
    "HERMES_BRIDGE_MAX_HOPS": "2",
}


def test_disabled_config_needs_no_secrets(tmp_path: Path) -> None:
    config = BridgeConfig.from_env(
        {"HERMES_BRIDGE_ENABLED": "false", "HERMES_BRIDGE_OUTBOX_PATH": str(tmp_path / "o.sqlite")}
    )
    assert not config.enabled


def test_enabled_config_parses_allowlists_and_defaults(tmp_path: Path) -> None:
    env = BASE_ENV | {"HERMES_BRIDGE_OUTBOX_PATH": str(tmp_path / "outbox.sqlite")}

    config = BridgeConfig.from_env(env)

    assert config.enabled
    assert config.peer_telegram_username == "BetaAgentBot"
    assert config.peer_aliases == ("beta", "bt")
    assert config.allowed_chat_ids == frozenset({"-100123", "-100456"})
    assert config.allowed_thread_ids == frozenset({"42", "43"})
    assert config.allowed_webhook_routes == frozenset({"bridge-beta"})
    assert config.outbox_path == tmp_path / "outbox.sqlite"
    assert config.heartbeat_url == "https://bridge.example/v1/agents/heartbeat"
    assert config.heartbeat_interval_seconds == 30.0


def test_request_response_mode_cannot_be_enabled_without_completion_receipts(
    tmp_path: Path,
) -> None:
    env = BASE_ENV | {
        "HERMES_BRIDGE_OUTBOX_PATH": str(tmp_path / "outbox.sqlite"),
        "HERMES_BRIDGE_REQUESTS_ENABLED": "true",
    }

    with pytest.raises(ConfigError, match="durable completion receipts"):
        BridgeConfig.from_env(env)


def test_request_response_mode_is_fail_closed_by_default(tmp_path: Path) -> None:
    env = (BASE_ENV | {"HERMES_BRIDGE_OUTBOX_PATH": str(tmp_path / "outbox.sqlite")}).copy()
    env.pop("HERMES_BRIDGE_REQUESTS_ENABLED")

    assert BridgeConfig.from_env(env).requests_enabled is False


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("HERMES_BRIDGE_AGENT_ID", "Alpha"),
        ("HERMES_BRIDGE_INSTANCE_ID", "bad instance"),
        ("HERMES_BRIDGE_API_URL", "http://bridge.example/v1/events"),
        ("HERMES_BRIDGE_INGEST_SECRET", "short"),
        ("HERMES_BRIDGE_OUTBOX_ENCRYPTION_KEY", "short"),
        ("HERMES_BRIDGE_MAX_HOPS", "3"),
        ("HERMES_BRIDGE_ALLOWED_CHAT_IDS", ""),
        ("HERMES_BRIDGE_ALLOWED_WEBHOOK_ROUTES", ""),
    ],
)
def test_enabled_config_rejects_unsafe_values(key: str, value: str) -> None:
    with pytest.raises(ConfigError, match=key):
        BridgeConfig.from_env(BASE_ENV | {key: value})


def test_config_rejects_self_target() -> None:
    with pytest.raises(ConfigError, match="must differ"):
        BridgeConfig.from_env(BASE_ENV | {"HERMES_BRIDGE_PEER_AGENT_ID": "alpha"})


def test_plugin_manifest_and_root_entrypoint_are_present() -> None:
    plugin_root = Path(__file__).resolve().parents[1]
    manifest = yaml.safe_load((plugin_root / "plugin.yaml").read_text())

    assert manifest["name"] == "hermes_bridge_outbound"
    assert manifest["kind"] == "standalone"
    assert manifest["provides_hooks"] == ["post_llm_call"]
    assert "hooks" not in manifest
    assert (plugin_root / "__init__.py").is_file()
