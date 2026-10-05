#!/usr/bin/env bash
set -Eeuo pipefail

readonly POSTGRES_IMAGE='postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
readonly POSTGRES_USER='bridge'
readonly POSTGRES_PASSWORD='bridge_test'
readonly POSTGRES_DB='bridge_test'
container_name="hermes-bridge-verify-$$"

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach --rm \
  --name "${container_name}" \
  --env "POSTGRES_USER=${POSTGRES_USER}" \
  --env "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
  --env "POSTGRES_DB=${POSTGRES_DB}" \
  --publish '127.0.0.1::5432' \
  "${POSTGRES_IMAGE}" >/dev/null

for _ in {1..30}; do
  if docker exec "${container_name}" pg_isready \
    --host 127.0.0.1 \
    --username "${POSTGRES_USER}" \
    --dbname "${POSTGRES_DB}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "${container_name}" pg_isready \
  --host 127.0.0.1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" >/dev/null

postgres_port="$(docker inspect \
  --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' \
  "${container_name}")"
export PGPASSWORD="${POSTGRES_PASSWORD}"
export TEST_DATABASE_URL="postgresql://${POSTGRES_USER}@127.0.0.1:${postgres_port}/${POSTGRES_DB}"

pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm --filter @hermes-bridge/api test:db
pnpm test:e2e
pnpm build
