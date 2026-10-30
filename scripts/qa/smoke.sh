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
  git -C "$repo" init -q -b main
  if [ -n "${QA_CONFIG:-}" ]; then echo "$QA_CONFIG" >"$repo/graph-execution.config.json"; git -C "$repo" add graph-execution.config.json; fi
  git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
  local start=$SECONDS got
  ( cd "$repo" && env PATH="$BIN:$PATH" QA_OPENCODE_MODE=$mode QA_STATE_DIR="$repo/.git" GRAPH_EXECUTION_HANDOFF=detached "$@" \
      node "$ROOT/scripts/qa/timeout.mjs" "$limit" node "$CLI" "$FIX/diamond" --spec "$FIX/spec.md" --provider opencode --model qwen/qwen3-27b \
      --no-human-review --concurrency 2 >"$repo/out.log" 2>&1 ); got=$?
  local took=$((SECONDS - start))
  if [ "$got" = "$want" ] && [ -n "${EXPECT:-}" ] && ! grep -q "$EXPECT" "$repo/out.log"; then
    echo "FAIL $name: exit ok but log lacks '$EXPECT'; log: $repo/out.log"; FAIL=1
  elif [ "$got" = "$want" ]; then echo "PASS $name (exit $got, ${took}s)"; else
    echo "FAIL $name: exit $got, expected $want (${took}s); log: $repo/out.log"; tail -5 "$repo/out.log"; FAIL=1; fi
}
scenario ok        ok       0   180
scenario slow      slow     0   300 QA_OPENCODE_DELAY_MS=5000
scenario flaky     flaky    0   240
scenario nocommit  nocommit 2   240
scenario loop      loop     2   240
# Weak-model reviewer/tester reports. A fenced JSON report is accepted; prose/truncated/missing reports exhaust 3 attempts,
# and the run exits 4 (unreviewed) while NOT applying the result.
EXPECT="applied to main"     scenario report-fenced    ok 0 180 QA_REPORT_MODE=fenced
EXPECT="UNREVIEWED" scenario report-prose     ok 4 240 QA_REPORT_MODE=prose
EXPECT="UNREVIEWED" scenario report-truncated ok 4 240 QA_REPORT_MODE=truncated
EXPECT="UNREVIEWED" scenario report-none      ok 4 240 QA_REPORT_MODE=none
# A model that never answers: stopped after idleTimeoutMinutes of silence, retried, and the run fails normally (exit 2).
EXPECT="no output" QA_CONFIG='{"idleTimeoutMinutes":0.05,"attempts":2}' scenario hang hang 2 90
exit $FAIL
