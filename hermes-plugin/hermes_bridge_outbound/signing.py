"""Raw-body HMAC-SHA256 V2 signing."""

from __future__ import annotations

import hashlib
import hmac


def hmac_sha256_v2(secret: bytes, timestamp: str, raw_body: bytes) -> str:
    """Sign ``<timestamp>.<raw-body>`` without parsing or re-serialization."""

    message = timestamp.encode("ascii") + b"." + raw_body
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def verify_hmac_sha256_v2(
    secret: bytes,
    timestamp: str,
    raw_body: bytes,
    signature: str,
) -> bool:
    """Constant-time verifier used by vector/interoperability tests."""

    expected = hmac_sha256_v2(secret, timestamp, raw_body)
    return hmac.compare_digest(expected, signature)


def signed_headers(
    *,
    secret: bytes,
    timestamp: str,
    raw_body: bytes,
    agent_id: str,
    request_id: str,
) -> dict[str, str]:
    """Return required V2 request headers for the exact supplied body."""

    return {
        "Content-Type": "application/json",
        "X-Bridge-Agent": agent_id,
        "X-Request-ID": request_id,
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Signature-V2": hmac_sha256_v2(secret, timestamp, raw_body),
    }
