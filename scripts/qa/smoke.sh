#!/usr/bin/env bash
# End-to-end QA: runs the built CLI against a stub `opencode` in several model-misbehaviour modes.
# Usage: scripts/qa/smoke.sh [--skip-build]   (exit 0 = all scenarios behaved as expected)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$ROOT/dist/cli.js"; FIX="$ROOT/src/__fixtures__"
[ "${1:-}" = "--skip-build" ] || (cd "$ROOT" && npm run build >/dev/null) || { echo "build failed"; exit 1; }
BIN="$(mktemp -d)"; cp "$ROOT/scripts/qa/fake-opencode.mjs" "$BIN/opencode"; chmod +x "$BIN/opencode"
FAIL=0
# scenario <name> <mode> <expected-exit> <timeout-s> [extra env...]
scenario() {
  local name=$1 mode=$2 want=$3 limit=$4; shift 4
  local repo; repo=$(mktemp -d)
  git -C "$repo" init -q -b main && git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
  local start=$SECONDS got
  ( cd "$repo" && env PATH="$BIN:$PATH" QA_OPENCODE_MODE=$mode QA_STATE_DIR="$repo/.git" GRAPH_EXECUTION_HANDOFF=detached "$@" \
      node "$ROOT/scripts/qa/timeout.mjs" "$limit" node "$CLI" "$FIX/diamond" --spec "$FIX/spec.md" --provider opencode --model qwen/qwen3-27b \
      --no-human-review --concurrency 2 >"$repo/out.log" 2>&1 ); got=$?
  local took=$((SECONDS - start))
  if [ "$got" = "$want" ]; then echo "PASS $name (exit $got, ${took}s)"; else
    echo "FAIL $name: exit $got, expected $want (${took}s); log: $repo/out.log"; tail -5 "$repo/out.log"; FAIL=1; fi
}
scenario ok        ok       0   180
scenario slow      slow     0   300 QA_OPENCODE_DELAY_MS=5000
scenario flaky     flaky    0   240
scenario nocommit  nocommit 2   240
scenario loop      loop     2   240
# A model that never answers: nothing stops it on a clock, so this is EXPECTED to hit the harness timeout (124).
scenario hang      hang     124 45
exit $FAIL
