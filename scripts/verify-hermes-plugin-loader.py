#!/usr/bin/env python3
"""Verify this plugin with the real Hermes PluginManager in an isolated home."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch

EXPECTED_HERMES_VERSION = "0.18.2"
PLUGIN_NAME = "hermes_bridge_outbound"


def main() -> int:
    installed_version = version("hermes-agent")
    if installed_version != EXPECTED_HERMES_VERSION:
        raise RuntimeError(
            f"expected hermes-agent {EXPECTED_HERMES_VERSION}, got {installed_version}"
        )

    repository = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="hermes-bridge-plugin-") as temporary:
        hermes_home = Path(temporary)
        plugin_dir = hermes_home / "plugins" / PLUGIN_NAME
        shutil.copytree(repository / "hermes-plugin", plugin_dir)
        (hermes_home / "config.yaml").write_text(
            f"plugins:\n  enabled:\n    - {PLUGIN_NAME}\n",
            encoding="utf-8",
        )

        environment = {
            "HERMES_HOME": str(hermes_home),
            "HERMES_BRIDGE_ENABLED": "true",
            "HERMES_BRIDGE_AGENT_ID": "alpha",
            "HERMES_BRIDGE_INSTANCE_ID": "alpha-loader-smoke",
            "HERMES_BRIDGE_API_URL": "https://bridge.invalid/v1/events",
            "HERMES_BRIDGE_INGEST_SECRET": "loader-smoke-ingest-secret-32-bytes",
            "HERMES_BRIDGE_OUTBOX_ENCRYPTION_KEY": "loader-smoke-outbox-key-32-bytes--",
            "HERMES_BRIDGE_PEER_AGENT_ID": "beta",
            "HERMES_BRIDGE_PEER_USERNAMES": "BetaAgentBot",
            "HERMES_BRIDGE_ALLOWED_CHAT_IDS": "-1001234567890",
            "HERMES_BRIDGE_ALLOWED_WEBHOOK_ROUTES": "telegram",
            "HERMES_SESSION_PLATFORM": "telegram",
            "HERMES_SESSION_CHAT_ID": "-1001234567890",
            "HERMES_SESSION_ID": "loader-smoke-session",
            "HERMES_BRIDGE_OUTBOX_PATH": str(hermes_home / "state" / "outbox.sqlite"),
            "HERMES_BRIDGE_POLL_INTERVAL_SECONDS": "60",
            "HERMES_BRIDGE_HEARTBEAT_INTERVAL_SECONDS": "60",
        }

        with patch.dict(os.environ, environment, clear=False):
            from hermes_cli.plugins import PluginManager  # type: ignore[import-not-found]

            manager = PluginManager()
            try:
                manager.discover_and_load(force=True)
                plugin = next(
                    (item for item in manager.list_plugins() if item["name"] == PLUGIN_NAME),
                    None,
                )
                if plugin is None:
                    raise RuntimeError("PluginManager did not discover the bridge plugin")
                if not plugin["enabled"] or plugin["error"] is not None:
                    raise RuntimeError(f"plugin did not load cleanly: {plugin}")
                registered_hooks = manager._hooks.get("post_llm_call", [])
                if plugin["hooks"] != 1 or len(registered_hooks) != 1:
                    raise RuntimeError(
                        "plugin loaded without exactly one post_llm_call hook: "
                        f"plugin={plugin}, manager_hooks={len(registered_hooks)}"
                    )

                manager.invoke_hook(
                    "post_llm_call",
                    assistant_response="[[bridge:to=beta]] loader smoke",
                    conversation_history=[{"role": "user", "content": "Beta'e ilet"}],
                    user_message="Beta'e ilet",
                    session_id="loader-smoke-session",
                    platform="telegram",
                )
                with sqlite3.connect(environment["HERMES_BRIDGE_OUTBOX_PATH"]) as connection:
                    outbox_events = int(
                        connection.execute("SELECT count(*) FROM outbox_events").fetchone()[0]
                    )
                if outbox_events != 1:
                    raise RuntimeError(
                        "real PluginManager hook invocation did not persist "
                        "exactly one outbox event"
                    )
            finally:
                module = sys.modules.get(PLUGIN_NAME)
                cleanup = getattr(module, "shut" + "down", None) if module else None
                if cleanup is not None:
                    cleanup()

    print(
        json.dumps(
            {
                "hermes_agent": installed_version,
                "plugin": PLUGIN_NAME,
                "enabled": True,
                "post_llm_call_hooks": 1,
                "outbox_events": outbox_events,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
