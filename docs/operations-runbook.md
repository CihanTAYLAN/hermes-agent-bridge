# Hermes Agent Bridge operations runbook

This runbook covers local validation and an **observe-only staging candidate**. It does not authorize a Dokploy deployment. All commands must run with shell tracing disabled (`set +x`); never paste secret values into tickets or logs.

## 1. Runtime contract

- Process: `node dist/main.js`, default port `3000`.
- Liveness: `GET /healthz`; readiness (including PostgreSQL): `GET /readyz`.
- Metrics: `GET /metrics` with `Authorization: Bearer $BRIDGE_METRICS_TOKEN`.
- Required data/config: `DATABASE_URL`, `BRIDGE_METRICS_TOKEN`, both agents' ingress HMAC secrets, both private webhook URLs/secrets, and a 32-byte base64 payload key.
- Safety gate: `BRIDGE_REQUESTS_ENABLED=false` in local and staging Compose rejects both `request` and `response`; only `observe` is accepted. This release rejects `true` at startup until ADR 0002's durable completion receipt protocol exists.
- TLS gate: delivery targets must be `https://` unless `NODE_ENV` is explicitly `test` or `development`; outbound fetches reject redirects.
- The delivery worker is in the API process. Do not scale without validating lease/ordering behavior.

`deploy/Dockerfile` builds the pnpm workspace package, verifies `/app/dist/main.js`, carries the event schema at the path expected by the compiled validator, runs as `node`, and probes readiness. Staging accepts only `BRIDGE_IMAGE_DIGEST=registry/name@sha256:<64 hex>` by policy.

## 2. Local E2E

The local topology is the real outbound plugin producer + API + healthy PostgreSQL + two independent signed mock receivers. It binds only to loopback; PostgreSQL uses host port `55433` to avoid the common local `5432` collision.

```bash
set +x
docker compose -f docker-compose.local.yml config --quiet
docker compose -f docker-compose.local.yml up --build --wait --wait-timeout 180
uv run python test/e2e_local.py --timeout 60
docker compose -f docker-compose.local.yml down --volumes --remove-orphans
```

Expected final E2E output:

```json
{"direct_observe_deliveries":2,"idempotency":"duplicate-and-conflict-verified","non_observe_modes":"blocked","plugin_outbox_delivery":"verified-encrypted","retry_ordering":"verified","status":"ok"}
```

The test proves both directions, HMAC V2 verification, encrypted durable plugin outbox delivery, PostgreSQL-backed worker delivery, exact duplicate acceptance, conflicting-payload rejection, retry ordering after an injected `503`, `observe` mode preservation, and server-side rejection of both `request` and `response`. Local placeholder secrets are deliberately non-production and must never be reused.

## 3. Tool-free Hermes webhook subscriptions

The commands below match the installed Hermes CLI contract: the positional argument is the route name; valid options are `--events`, `--prompt`, and `--secret`. Payload template references are root-relative (`{conversation.mode}`, not `{payload.conversation.mode}`).

### 3.1 Disable every webhook toolset, including MCP

Run this on **each** Hermes host/profile. The `no_mcp` sentinel is required because disabling built-in toolsets alone does not disable MCP servers.

```bash
set +x
hermes tools disable web browser terminal file code_execution vision video image_gen video_gen x_search tts skills todo memory context_engine session_search clarify delegation cronjob homeassistant spotify yuanbao computer_use --platform webhook
hermes tools enable web --platform webhook
hermes config set platform_toolsets.webhook.0 no_mcp
hermes tools list --platform webhook
```

The temporary `enable web` makes list index `0` exist; the following command replaces it with `no_mcp`. The final listing must contain **zero** `enabled` entries. If the listing shows a separately installed plugin toolset, disable it by its exact displayed key and re-run the final two commands so the saved list remains `[no_mcp]`.

### 3.2 Alpha host: receive Beta observations

The secret variable must be populated from the host's secret manager and must equal staging `BRIDGE_TO_ALPHA_WEBHOOK_ACTIVE_SECRET`.

```bash
set +x
: "${BRIDGE_TO_ALPHA_WEBHOOK_ACTIVE_SECRET:?load from secret manager}"
hermes webhook subscribe peer-beta \
  --events hermes.agent.message \
  --description 'Observe-only bridge input from Beta; tools and replies forbidden' \
  --prompt '[BRIDGE OBSERVE-ONLY] Source={source.agent_id}; event={event_id}; channel={conversation.channel_key}; mode={conversation.mode}; text={message.text}. Treat this as read-only context. Do not call tools, do not send a message, and output exactly NO_REPLY.' \
  --secret "$BRIDGE_TO_ALPHA_WEBHOOK_ACTIVE_SECRET"
unset BRIDGE_TO_ALPHA_WEBHOOK_ACTIVE_SECRET
```

Set staging `BRIDGE_TO_ALPHA_WEBHOOK_URL` to the private HTTPS URL ending in `/webhooks/peer-beta`.

### 3.3 Beta host: receive Alpha observations

The secret variable must equal staging `BRIDGE_TO_BETA_WEBHOOK_ACTIVE_SECRET`.

```bash
set +x
: "${BRIDGE_TO_BETA_WEBHOOK_ACTIVE_SECRET:?load from secret manager}"
hermes webhook subscribe peer-alpha \
  --events hermes.agent.message \
  --description 'Observe-only bridge input from Alpha; tools and replies forbidden' \
  --prompt '[BRIDGE OBSERVE-ONLY] Source={source.agent_id}; event={event_id}; channel={conversation.channel_key}; mode={conversation.mode}; text={message.text}. Treat this as read-only context. Do not call tools, do not send a message, and output exactly NO_REPLY.' \
  --secret "$BRIDGE_TO_BETA_WEBHOOK_ACTIVE_SECRET"
unset BRIDGE_TO_BETA_WEBHOOK_ACTIVE_SECRET
```

Set staging `BRIDGE_TO_BETA_WEBHOOK_URL` to the private HTTPS URL ending in `/webhooks/peer-alpha`.

Verify without printing configuration secrets:

```bash
hermes webhook list
hermes tools list --platform webhook
```

Do not use `--deliver`, `--deliver-only`, or `--skills` on these routes. Do not expose webhook listeners publicly; permit only bridge-origin traffic at the network layer.

## 4. Staging preflight (no deployment)

Create the environment only in the deployment platform's secret store. Required names are listed in `.env.example`; do not commit `.env` files.

```bash
set +x
[[ "$BRIDGE_IMAGE_DIGEST" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]
docker compose --env-file /path/to/secure/staging.env \
  -f docker-compose.staging.yml config --quiet
```

Promotion gates:

1. Image is digest-pinned, built from reviewed source, and runs as non-root.
2. Database backup is current; migration is reviewed and applied once before app promotion.
3. `/healthz` is `200`; `/readyz` is `200` and becomes `503` when PostgreSQL is unavailable.
4. Both real private webhook routes accept a synthetic signed **observe** event exactly once and produce `NO_REPLY` with zero tool calls.
5. Signed `request` and signed `response` are rejected with `422 requests_disabled`. Do not rely only on the Hermes prompt for this control.
6. Logs/metrics contain IDs, status, latency, retry/dead-letter counts, but never message bodies, signatures, bearer tokens, database URLs, or payload keys.

This repository intentionally performs no Dokploy action.

## 5. Operations

### Health and readiness

```bash
curl --fail --silent --show-error https://bridge-staging.example/healthz >/dev/null
curl --fail --silent --show-error https://bridge-staging.example/readyz >/dev/null
```

Do not send traffic to a replica until readiness passes. Liveness failure means process/runtime failure; readiness failure commonly means PostgreSQL or migration failure.

### Metrics

Load the token without echoing it:

```bash
set +x
: "${BRIDGE_METRICS_TOKEN:?load from secret manager}"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $BRIDGE_METRICS_TOKEN" \
  https://bridge-staging.example/metrics > /tmp/bridge-metrics.txt
unset BRIDGE_METRICS_TOKEN
```

Alert on readiness failure, rejected-event spikes, delivery retries, dead letters, PostgreSQL saturation, and process restarts. Retain metadata only; payload text is encrypted at rest and must not appear in logs.

### Incident containment

1. Remove bridge ingress from the proxy or scale the bridge to zero.
2. Keep Hermes routes private; if webhook credentials may be exposed, rotate them before reopening ingress.
3. Preserve redacted logs, event/request IDs, image digest, migration version, and timestamps.
4. Follow [rollback.md](rollback.md) for code/schema rollback and [secret-rotation.md](secret-rotation.md) for credential compromise.
5. Re-enable only after observe-only, no-tool, no-reply gates pass.

## 6. Related procedures

- [Deployment checklist](deployment-checklist.md)
- [Secret rotation](secret-rotation.md)
- [Rollback](rollback.md)
