"""Hermes plugin entrypoint for durable outbound Bridge events."""

from __future__ import annotations

if __package__:
    from .hermes_bridge_outbound.runtime import register
else:  # pragma: no cover - pytest may collect this hyphenated plugin root directly
    from hermes_bridge_outbound.runtime import register

__all__ = ["register"]
