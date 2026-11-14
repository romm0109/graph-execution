#!/usr/bin/env bash
# UI smoke test of graph-manager: drives the main loop in a real browser with agent-browser and curl, and stops at
# the first unexpected result. Run it from anywhere: bash apps/graph-manager/scripts/ui-smoke.sh
#
#   fake forge + graph-manager on free ports, temp dirs → log in → connect GitHub → clone octo/hello → commit the
#   diamond fixture → start a fake run (POST /api/runs/<ws>) → wait for "applied" → run detail says "passed" →
#   Create PR in the UI → the PR link shows and /__fake/pulls lists it.
#
# Needs node, git, curl and agent-browser on the PATH. Not part of `npm test`.
# SKIP_BUILD=1 reuses the existing builds; KEEP=1 keeps the temp dir (its path is printed).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"

DIR=$(mktemp -d)
SESSION="gm-ui-smoke-$$"
PIDS=()
WS=github~octo~hello
CLONE="$DIR/ws/github/octo/hello"

ab() { agent-browser --session "$SESSION" "$@"; }

cleanup() {
  # The run page outlives the run (it waits for Close): stop it by the PID in its web.json.
  for f in "$CLONE"/.graph-execution/*/web.json; do
    [ -f "$f" ] || continue
    pid=$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pid ?? "") } catch {}' "$f")
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  ab close >/dev/null 2>&1 || true
  if [ -n "${KEEP:-}" ]; then echo "kept $DIR"; else rm -rf "$DIR"; fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  for log in gm forge; do
    [ -f "$DIR/$log.log" ] && { echo "--- $log.log (last 20 lines)" >&2; tail -20 "$DIR/$log.log" >&2; }
  done
  exit 1
}
step() { echo "== $*"; }

free_port() { node -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'; }

# wait_for <seconds> <description> <command…>: retries the command every 0.5 s until it succeeds.
wait_for() {
  local secs=$1 what=$2
  shift 2
  local end=$((SECONDS + secs))
  until "$@" >/dev/null 2>&1; do
    [ $SECONDS -lt $end ] || fail "timed out after ${secs}s waiting for: $what"
    sleep 0.5
  done
}

# visible <selector>: the element exists and is visible.
visible() { ab is visible "$1" 2>/dev/null | grep -q true; }

# page_has <text>: the visible page text contains <text>.
page_has() { ab eval "document.body.innerText.includes($(node -e 'console.log(JSON.stringify(process.argv[1]))' "$1"))" | grep -q true; }

json_get() { node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const v = new Function("j", "return " + process.argv[1])(JSON.parse(s)); console.log(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)); })' "$1"; }

command -v agent-browser >/dev/null || fail "agent-browser is not on the PATH"

if [ -z "${SKIP_BUILD:-}" ]; then
  step "build"
  npm run build -w graph-execution >/dev/null 2>&1 || fail "graph-execution build"
  npm run build -w graph-manager >/dev/null 2>&1 || fail "graph-manager build"
fi

FORGE_PORT=$(free_port)
GM_PORT=$(free_port)
FORGE="http://127.0.0.1:$FORGE_PORT"
GM="http://127.0.0.1:$GM_PORT"
COOKIE="$DIR/cookie"

step "start the fake forge on $FORGE_PORT and graph-manager on $GM_PORT (dir $DIR)"
node apps/graph-manager/scripts/fake-forge.mjs "$FORGE_PORT" "$DIR/forge" >"$DIR/forge.log" 2>&1 &
PIDS+=($!)
GM_PASSWORD=pw GM_PORT=$GM_PORT GM_DATA_DIR="$DIR/data" GM_WORKSPACES_DIR="$DIR/ws" GM_GITHUB_API_URL="$FORGE/github" \
  node apps/graph-manager/dist/server/main.js >"$DIR/gm.log" 2>&1 &
PIDS+=($!)
wait_for 20 "the fake forge" curl -sf "$FORGE/__fake/pulls"
wait_for 20 "graph-manager /healthz" curl -sf "$GM/healthz"
curl -sf -c "$COOKIE" -X POST -H 'content-type: application/json' -d '{"password":"pw"}' "$GM/api/auth/login" >/dev/null || fail "API login"

step "log in"
ab set viewport 1440 900 >/dev/null
ab open "$GM/" >/dev/null
wait_for 10 "the login page" visible 'input[type=password]'
ab fill 'input[type=password]' pw >/dev/null
ab press Enter >/dev/null
wait_for 10 "the Runs page after login" page_has "Start run"

step "connect GitHub (gh-good)"
ab open "$GM/settings" >/dev/null
wait_for 10 "the GitHub card" visible '[data-testid=forge-github] [data-testid=token-input]'
ab fill '[data-testid=forge-github] [data-testid=token-input]' gh-good >/dev/null
ab click '[data-testid=forge-github] [data-testid=connect]' >/dev/null
wait_for 10 "GitHub connected as octo" page_has "Connected as octo"
[ "$(curl -sf -b "$COOKIE" "$GM/api/forges" | json_get 'j.github.login')" = octo ] || fail "/api/forges does not say github login octo"

step "open a session on octo/hello from New terminal (it clones the repository)"
ab open "$GM/terminals?new=1" >/dev/null
wait_for 10 "the repository search" visible '[data-testid=new-terminal-search]'
ab fill '[data-testid=new-terminal-search]' octo/hello >/dev/null
wait_for 10 "octo/hello in the results" visible '[data-testid="new-terminal-repo-github-octo/hello"]'
ab click '[data-testid="new-terminal-repo-github-octo/hello"]' >/dev/null
ab click '[data-testid=new-terminal-create]' >/dev/null
wait_for 30 "the clone" test -d "$CLONE/.git"

step "commit the diamond fixture into the clone"
cp -r packages/graph-execution/src/__fixtures__/diamond "$CLONE/"
printf '# Diamond smoke\n\nThe ui-smoke run.\n' >"$CLONE/spec.md"
git -C "$CLONE" add -A
git -C "$CLONE" -c user.name=smoke -c user.email=smoke@example.com commit -qm "diamond fixture" || fail "git commit in the clone"

step "start a fake run through POST /api/runs/$WS"
START=$(curl -s -b "$COOKIE" -X POST -H 'content-type: application/json' \
  -d '{"tasksDir":"diamond","spec":"spec.md","provider":"fake"}' "$GM/api/runs/$WS")
RUN=$(echo "$START" | json_get 'j.runId')
[ -n "$RUN" ] || fail "start run answered: $START"
echo "   run $RUN"

step "wait for applied"
run_status() { curl -sf -b "$COOKIE" "$GM/api/runs" | json_get "(j.runs.find((r) => r.id === '$RUN') || {}).status"; }
is_applied() { [ "$(run_status)" = applied ]; }
wait_for 90 "run $RUN to be applied (last status: $(run_status))" is_applied

step "close the run page, then the run detail shows the static view with 'passed'"
curl -sf -b "$COOKIE" -X POST "$GM/runs/$WS/$RUN/view/close" >/dev/null || true
is_closed() { [ "$(curl -sf -b "$COOKIE" "$GM/api/runs" | json_get "(j.runs.find((r) => r.id === '$RUN') || {}).live")" = false ]; }
wait_for 20 "the run page to close" is_closed
ab open "$GM/runs/$WS/$RUN" >/dev/null
wait_for 15 "the phase cards" visible '[data-testid=run-static-graph]'
wait_for 10 "'passed' on the run detail" page_has "passed"

step "create the PR from the Pull request panel"
wait_for 15 "the Create PR form" visible '[data-testid=pr-submit]'
enabled() { ab is enabled "$1" 2>/dev/null | grep -q true; }
wait_for 15 "the Create PR button to be enabled" enabled '[data-testid=pr-submit]'
ab click '[data-testid=pr-submit]' >/dev/null
wait_for 60 "the PR link" visible '[data-testid=pr-link]'
PR_URL=$(ab get attr '[data-testid=pr-link]' href | tail -1)
[ -n "$PR_URL" ] || fail "the PR link has no href"

step "check /__fake/pulls"
PULLS=$(curl -sf "$FORGE/__fake/pulls")
[ "$(echo "$PULLS" | json_get "j.filter((p) => p.head === 'gm/$RUN' && p.fullPath === 'octo/hello').length")" = 1 ] ||
  fail "/__fake/pulls does not list gm/$RUN: $PULLS"

echo "OK: PR $PR_URL"
