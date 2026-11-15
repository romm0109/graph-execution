#!/usr/bin/env bash
# Phone layout check of graph-manager: drives the app at phone viewports with agent-browser and curl, and stops at
# the first unexpected result. Run it from anywhere: bash apps/graph-manager/scripts/ui-mobile.sh
#
#   fake forge + graph-manager on free ports, temp dirs → log in at 390 x 844 → data through the API (GitHub, a clone,
#   a project, a finished fake run, a live fake run that hangs) → at 390 x 844 and 360 x 740 no page scrolls sideways
#   and the phone top bar shows → the nav drawer opens and closes (scrim, Escape, a link) → on Terminals a tap focuses
#   the shell, the extra-keys row shows, and its keys edit the shell's line → at 1440 x 900 the desktop nav is back.
#
# Touch is faked with an init script that makes matchMedia("(pointer: coarse)") true for JavaScript. CSS
# `@media (pointer: coarse)` rules don't apply in headless Chrome; see docs/wiki/features/mobile-web.md for the manual
# checklist on real phones.
#
# Needs node, git, curl, bash and agent-browser on the PATH. Not part of `npm test`.
# SKIP_BUILD=1 reuses the existing builds; KEEP=1 keeps the temp dir (its path is printed) and screenshots in it.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"

DIR=$(mktemp -d)
SESSION="gm-ui-mobile-$$"
PIDS=()
WS=github~octo~hello
CLONE="$DIR/ws/github/octo/hello"
GM=""
COOKIE="$DIR/cookie"
RUN2=""

ab() { agent-browser --session "$SESSION" "$@"; }

cleanup() {
  # The live run hangs on purpose: abort it, wait until it is no longer running, then close its page.
  if [ -n "$RUN2" ] && [ -n "$GM" ]; then
    curl -s -b "$COOKIE" -X POST "$GM/runs/$WS/$RUN2/view/abort" >/dev/null 2>&1 || true
    local end=$((SECONDS + 20))
    while [ $SECONDS -lt $end ]; do
      st=$(curl -s -b "$COOKIE" "$GM/api/runs" 2>/dev/null | json_get "(j.runs.find((r) => r.id === '$RUN2') || {}).status" 2>/dev/null || true)
      [ "$st" = running ] || break
      sleep 0.5
    done
    curl -s -b "$COOKIE" -X POST "$GM/runs/$WS/$RUN2/view/close" >/dev/null 2>&1 || true
  fi
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

# is_true <js expression>: the expression evaluates to true in the page.
is_true() { ab eval "$1" 2>/dev/null | grep -qx true; }

# The page does not scroll sideways; on failure, name the elements that stick out.
no_hscroll() { is_true 'document.documentElement.scrollWidth <= window.innerWidth'; }
widest() { ab eval '(() => { const w = innerWidth; const bad = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > w + 1).slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : "") + " right=" + Math.round(e.getBoundingClientRect().right)); return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, innerWidth: w, bad }); })()'; }
check_fits() { no_hscroll || fail "$1 scrolls sideways at ${VW}x${VH}: $(widest)"; }

# The desktop nav (.gm-nav) is not on screen: hidden, or off to the left (the closed drawer).
NAV_OFF='(() => { const n = document.querySelector(".gm-nav"); if (!n) return true; const r = n.getBoundingClientRect(); return getComputedStyle(n).display === "none" || r.right <= 0 || r.width === 0; })()'
DRAWER_OPEN='(() => { const n = document.querySelector(".gm-nav.drawer"); if (!n) return false; const r = n.getBoundingClientRect(); return getComputedStyle(n).display !== "none" && r.right > 0 && r.width > 0; })()'
drawer_closed() { ! is_true "$DRAWER_OPEN"; }
drawer_open() { is_true "$DRAWER_OPEN" && visible '[data-testid=nav-scrim]'; }

shot() { [ -z "${KEEP:-}" ] || ab screenshot "$DIR/$1.png" >/dev/null 2>&1 || true; }

command -v agent-browser >/dev/null || fail "agent-browser is not on the PATH"
BASH_BIN=$(command -v bash)

if [ -z "${SKIP_BUILD:-}" ]; then
  step "build"
  npm run build -w graph-execution >/dev/null 2>&1 || fail "graph-execution build"
  npm run build -w graph-manager >/dev/null 2>&1 || fail "graph-manager build"
fi

FORGE_PORT=$(free_port)
GM_PORT=$(free_port)
FORGE="http://127.0.0.1:$FORGE_PORT"
GM="http://127.0.0.1:$GM_PORT"
echo '{}' >"$DIR/fake.json"

step "start the fake forge on $FORGE_PORT and graph-manager on $GM_PORT (dir $DIR)"
node apps/graph-manager/scripts/fake-forge.mjs "$FORGE_PORT" "$DIR/forge" >"$DIR/forge.log" 2>&1 &
PIDS+=($!)
# GM_GRAPH_EXECUTION_BIN pins the runs to this checkout's engine build: a graph-manager that started this shell may have
# exported its own (an installed graph-execution), and the live run page under test must be the one built here.
GM_PASSWORD=pw GM_PORT=$GM_PORT GM_DATA_DIR="$DIR/data" GM_WORKSPACES_DIR="$DIR/ws" GM_GITHUB_API_URL="$FORGE/github" \
  GRAPH_EXECUTION_FAKE_SCRIPT="$DIR/fake.json" SHELL="$BASH_BIN" BASH_SILENCE_DEPRECATION_WARNING=1 GM_GRAPH_EXECUTION_BIN="$ROOT/packages/graph-execution/dist/cli.js" \
  node apps/graph-manager/dist/server/main.js >"$DIR/gm.log" 2>&1 &
PIDS+=($!)
wait_for 20 "the fake forge" curl -sf "$FORGE/__fake/pulls"
wait_for 20 "graph-manager /healthz" curl -sf "$GM/healthz"
curl -sf -c "$COOKIE" -X POST -H 'content-type: application/json' -d '{"password":"pw"}' "$GM/api/auth/login" >/dev/null || fail "API login"

api() { curl -s -b "$COOKIE" -H 'content-type: application/json' "$@"; }

step "log in at 390x844 with touch (pointer: coarse) faked"
cat >"$DIR/coarse.js" <<'EOF'
(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => /\(\s*pointer\s*:\s*coarse\s*\)/.test(q)
    ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }
    : real(q);
  Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
})();
EOF
VW=390
VH=844
ab --init-script "$DIR/coarse.js" open about:blank >/dev/null
ab set viewport $VW $VH >/dev/null
ab open "$GM/login" >/dev/null
wait_for 10 "the login page" visible '[data-testid=page-login]'
is_true 'matchMedia("(pointer: coarse)").matches' || fail "the init script did not fake pointer: coarse"
check_fits /login
! visible '[data-testid=gm-topbar]' || fail "gm-topbar shows on the login page"
ab fill 'input[type=password]' pw >/dev/null
ab press Enter >/dev/null
wait_for 10 "the Runs page after login" page_has "Start run"

step "data through the API: GitHub, clone octo/hello, a second workspace, a project"
api -sf -X PUT -d '{"token":"gh-good"}' "$GM/api/forges/github" >/dev/null || fail "connect GitHub"
api -sf -X POST -d '{"forge":"github","fullPath":"octo/hello"}' "$GM/api/workspaces" >/dev/null || fail "clone octo/hello"
wait_for 30 "the clone of octo/hello" test -d "$CLONE/.git"
wait_for 30 "the clone job to finish" sh -c "curl -s -b '$COOKIE' '$GM/api/workspaces/clones' | grep -vq '\"running\"'"
cp -r packages/graph-execution/src/__fixtures__/diamond "$CLONE/"
printf '# Diamond mobile\n\nThe ui-mobile runs.\n' >"$CLONE/spec.md"
git -C "$CLONE" add -A
git -C "$CLONE" -c user.name=smoke -c user.email=smoke@example.com commit -qm "diamond fixture" || fail "git commit in the clone"
# A project needs two workspaces of one forge, and the fake forge has one GitHub repo: copy the clone as a second one.
git clone -q "$CLONE" "$DIR/ws/github/octo/world" || fail "git clone of the second workspace"
PROJ=$(api -X POST -d '{"name":"mobile","workspaces":["github~octo~hello","github~octo~world"]}' "$GM/api/projects")
echo "$PROJ" | grep -q '"mobile"' || fail "create project answered: $PROJ"

run_field() { curl -sf -b "$COOKIE" "$GM/api/runs" | json_get "(j.runs.find((r) => r.id === '$1') || {}).$2"; }

step "a finished run"
START=$(api -X POST -d '{"tasksDir":"diamond","spec":"spec.md","provider":"fake"}' "$GM/api/runs/$WS")
RUN1=$(echo "$START" | json_get 'j.runId')
[ -n "$RUN1" ] || fail "start run 1 answered: $START"
echo "   run $RUN1"
is_applied() { [ "$(run_field "$RUN1" status)" = applied ]; }
wait_for 90 "run $RUN1 to be applied (last status: $(run_field "$RUN1" status))" is_applied
curl -sf -b "$COOKIE" -X POST "$GM/runs/$WS/$RUN1/view/close" >/dev/null || true
is_closed() { [ "$(run_field "$RUN1" live)" = false ]; }
wait_for 20 "the run 1 page to close" is_closed
git -C "$CLONE" add -A # .graph-execution is gitignored in the clone
git -C "$CLONE" -c user.name=smoke -c user.email=smoke@example.com commit -qm "run 1" || true

step "a live run (task 3 hangs)"
cat >"$DIR/fake.json" <<'EOF'
{"task:1":{"attempts":[{"write":{"live/1.txt":"1\n"}}]},"task:2":{"attempts":[{"write":{"live/2.txt":"2\n"}}]},"task:3":{"attempts":[{"hang":true}]}}
EOF
START=$(api -X POST -d '{"tasksDir":"diamond","spec":"spec.md","provider":"fake"}' "$GM/api/runs/$WS")
RUN2=$(echo "$START" | json_get 'j.runId')
[ -n "$RUN2" ] || fail "start run 2 answered: $START"
echo "   run $RUN2"
is_live() { [ "$(run_field "$RUN2" live)" = true ] && [ "$(run_field "$RUN2" status)" = running ]; }
wait_for 60 "run $RUN2 to be live and running (last status: $(run_field "$RUN2" status))" is_live

# The live run's page in the iframe: no sideways scroll, and the Abort button is shown and on screen.
IFRAME_READY='(() => { const f = document.querySelector("[data-testid=run-live-view]"); return !!(f && f.contentDocument && f.contentDocument.querySelector("#topbar")); })()'
ABORT_SHOWN='(() => { const f = document.querySelector("[data-testid=run-live-view]"); const a = f.contentDocument.querySelector("#action"); return !!a && !a.hidden && a.getBoundingClientRect().width > 0; })()'
IFRAME_FITS='(() => { const f = document.querySelector("[data-testid=run-live-view]"); const d = f.contentDocument, w = f.contentWindow.innerWidth; const a = d.querySelector("#action"); return d.documentElement.scrollWidth <= w && a.getBoundingClientRect().right <= w; })()'
IFRAME_WIDEST='(() => { const f = document.querySelector("[data-testid=run-live-view]"); const d = f.contentDocument, w = f.contentWindow.innerWidth; const bad = [...d.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > w + 1).slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + " right=" + Math.round(e.getBoundingClientRect().right)); return JSON.stringify({ scrollWidth: d.documentElement.scrollWidth, innerWidth: w, action: Math.round(d.querySelector("#action").getBoundingClientRect().right), bad }); })()'

for size in "390 844" "360 740"; do
  read -r VW VH <<<"$size"
  step "pages at ${VW}x${VH}"
  ab set viewport $VW $VH >/dev/null
  for pair in "/runs page-runs" "/runs/$WS/$RUN1 run-static-graph" "/runs/$WS/$RUN2 run-live-view" "/terminals page-terminals" \
    "/workspaces page-workspaces" "/projects page-projects" "/reviewers page-reviewers" "/settings page-settings"; do
    read -r route testid <<<"$pair"
    ab open "$GM$route" >/dev/null
    wait_for 15 "[data-testid=$testid] on $route" visible "[data-testid=$testid]"
    check_fits "$route"
    wait_for 5 "gm-topbar on $route" visible '[data-testid=gm-topbar]'
    is_true "$NAV_OFF" || fail ".gm-nav is on screen on $route at ${VW}x${VH}"
    if [ "$testid" = run-live-view ]; then
      wait_for 15 "the live run page in the iframe" is_true "$IFRAME_READY"
      wait_for 15 "the Abort button on the live run page" is_true "$ABORT_SHOWN"
      is_true "$IFRAME_FITS" || fail "the live run page scrolls sideways or hides Abort at ${VW}x${VH}: $(ab eval "$IFRAME_WIDEST")"
      check_fits "$route (with the live page loaded)"
      shot "live-$VW"
    fi
    case "$route" in /runs) shot "runs-$VW" ;; /terminals) shot "terminals-$VW" ;; esac
  done
done

VW=390
VH=844
step "nav drawer at ${VW}x${VH}"
ab set viewport $VW $VH >/dev/null
ab open "$GM/runs" >/dev/null
wait_for 15 "the Runs page" visible '[data-testid=page-runs]'
ab click '[data-testid=nav-menu]' >/dev/null
wait_for 5 "the nav drawer to open" drawer_open
[ "$(ab get attr '[data-testid=nav-menu]' aria-expanded | tail -1 | tr -d '"')" = true ] || fail "nav-menu is not aria-expanded=true with the drawer open"
shot "drawer-$VW"
# The drawer covers the middle of the scrim at this width: tap the scrim at the right edge.
ab mouse move $((VW - 20)) 400 >/dev/null
ab mouse down >/dev/null
ab mouse up >/dev/null
wait_for 5 "a scrim tap to close the drawer" drawer_closed
ab click '[data-testid=nav-menu]' >/dev/null
wait_for 5 "the nav drawer to open again" drawer_open
ab press Escape >/dev/null
wait_for 5 "Escape to close the drawer" drawer_closed
ab click '[data-testid=nav-menu]' >/dev/null
wait_for 5 "the nav drawer to open a third time" drawer_open
ab click '.gm-nav.drawer a[href="/terminals"]' >/dev/null
at_terminals() { ab get url | tail -1 | tr -d '"' | grep -q '/terminals$'; }
wait_for 5 "the nav link to go to /terminals" at_terminals
wait_for 5 "the nav link to close the drawer" drawer_closed

step "terminal: tap to focus, extra keys reach the shell"
TID=$(api -X POST -d '{"workspaceId":"'"$WS"'"}' "$GM/api/terminals" | json_get 'j.id')
[ -n "$TID" ] || fail "POST /api/terminals gave no id"
ab open "$GM/terminals?focus=$TID" >/dev/null
wait_for 15 "the terminal screen" visible "[data-testid=terminal-view-$TID] .xterm-screen"
sleep 1 # let the shell print its prompt
ab eval 'document.activeElement && document.activeElement.blur(), true' >/dev/null
TEXTAREA_FOCUSED='document.activeElement?.classList.contains("xterm-helper-textarea") === true'
! is_true "$TEXTAREA_FOCUSED" || fail "the terminal still has focus after blur()"
ab eval '(() => { const h = document.querySelector("[data-testid=terminal-view-'"$TID"'] .xterm-screen"); const r = h.getBoundingClientRect(); const o = { pointerType: "touch", pointerId: 9, isPrimary: true, bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 40 }; h.dispatchEvent(new PointerEvent("pointerdown", o)); h.dispatchEvent(new PointerEvent("pointerup", o)); return true; })()' >/dev/null
is_true "$TEXTAREA_FOCUSED" || fail "a touch tap on the terminal did not focus xterm's textarea"
wait_for 5 "the extra-keys row" visible '[data-testid=extra-keys]'
for k in xk-esc xk-tab xk-ctrl xk-up xk-down xk-left xk-right xk-prefix; do
  visible "[data-testid=$k]" || fail "extra key $k is not visible"
done
check_fits /terminals-with-keys
shot "terminal-keys-$VW"
ab keyboard type "echo ab" >/dev/null
ab click '[data-testid=xk-left]' >/dev/null
ab keyboard type "Z" >/dev/null
ab click '[data-testid=xk-right]' >/dev/null
ab keyboard type " > $DIR/xk.txt" >/dev/null
ab press Enter >/dev/null
wait_for 10 "the extra keys to edit the line (xk.txt holds: $(cat "$DIR/xk.txt" 2>/dev/null || echo nothing))" grep -qx aZb "$DIR/xk.txt"
ab click '[data-testid=xk-esc]' >/dev/null
is_true "$TEXTAREA_FOCUSED" || fail "xk-esc took the focus away from the terminal"
ab click '[data-testid=xk-ctrl]' >/dev/null
[ "$(ab get attr '[data-testid=xk-ctrl]' aria-pressed | tail -1 | tr -d '"')" = true ] || fail "xk-ctrl is not aria-pressed=true after one tap"
ab click '[data-testid=xk-ctrl]' >/dev/null
[ "$(ab get attr '[data-testid=xk-ctrl]' aria-pressed | tail -1 | tr -d '"')" = false ] || fail "xk-ctrl is not aria-pressed=false after a second tap"
api -X DELETE "$GM/api/terminals/$TID" >/dev/null || true

VW=1440
VH=900
step "desktop at ${VW}x${VH} is unchanged"
ab set viewport $VW $VH >/dev/null
ab open "$GM/runs" >/dev/null
wait_for 15 "the Runs page" visible '[data-testid=page-runs]'
! visible '[data-testid=gm-topbar]' || fail "gm-topbar shows at ${VW}x${VH}"
visible '.gm-nav' || fail ".gm-nav is not visible at ${VW}x${VH}"
check_fits /runs

echo "OK: phone layout checks passed (390x844, 360x740)"
