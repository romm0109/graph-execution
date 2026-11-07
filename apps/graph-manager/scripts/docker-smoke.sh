#!/usr/bin/env bash
# Builds the graph-manager image and checks it end to end. Needs Docker; not part of `npm test`.
#   bash apps/graph-manager/scripts/docker-smoke.sh
# IMAGE=<tag> picks the tag; SMOKE_SKIP_BUILD=1 tests an image that is already built.
# SMOKE_CA=<file> passes a proxy CA bundle to the build as the `ca` secret (for TLS-intercepting proxies).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${IMAGE:-graph-manager:dev}"
PORT="${SMOKE_PORT:-17420}"
BASE="http://127.0.0.1:${PORT}"
CID=""

cleanup() {
  if [[ -n "$CID" ]]; then docker rm -f "$CID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

fail() {
  echo "docker smoke FAILED: $*" >&2
  if [[ -n "$CID" ]]; then docker logs "$CID" >&2 || true; fi
  exit 1
}

if [[ "${SMOKE_SKIP_BUILD:-}" != "1" ]]; then
  echo "==> building $IMAGE"
  secret=()
  if [[ -n "${SMOKE_CA:-}" ]]; then secret=(--secret "id=ca,src=$SMOKE_CA"); fi
  docker build "${secret[@]}" -f "$ROOT/apps/graph-manager/Dockerfile" -t "$IMAGE" "$ROOT"
fi

echo "==> starting container"
CID="$(docker run -d -e GM_PASSWORD=pw -p "127.0.0.1:${PORT}:7420" "$IMAGE")"

echo "==> waiting for /healthz"
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "$BASE/healthz" | grep -q '"ok":true' || fail "/healthz did not answer {ok:true} within 60 s"

echo "==> UI"
curl -fsS "$BASE/" | grep -q '<div id="root">' || fail "GET / did not return the UI"

echo "==> auth"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")" == "401" ]] || fail "/api/health is not behind login"
code="$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"password":"pw"}' "$BASE/api/auth/login")"
[[ "$code" == "204" ]] || fail "login answered $code, want 204"

echo "==> tools"
docker exec "$CID" graph-execution --version | grep -Eq '[0-9]+\.[0-9]+\.[0-9]+' || fail "graph-execution --version"
docker exec "$CID" claude --version >/dev/null || fail "claude --version"

echo "==> user and volumes"
[[ "$(docker exec "$CID" id -u)" != "0" ]] || fail "container runs as root"
docker exec "$CID" sh -c 'echo ok > /data/probe && echo ok > /workspaces/probe' || fail "/data or /workspaces is not writable"

echo "docker smoke OK"
