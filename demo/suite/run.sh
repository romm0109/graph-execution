#!/usr/bin/env bash
# Demo of `graph-execution suite` (graph of graphs) with the fake provider: no login, no cost.
# Usage: demo/suite/run.sh [fail|conflict]
#   (no arg)  both features pass. Both edit router.txt and config.txt, so the second merge conflicts and the
#             integration agent resolves it. Review round 0 finds one issue, so every fixer runs once.
#   fail      export2 fails 3 times and export waits with Retry. Press Retry after:  cp demo/suite/fake.json $REPO/.git/fake.json
#   conflict  the integration agent gives up on the conflict. Press Retry integration after the same cp.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
(cd "$ROOT" && npm run build >/dev/null)

REPO=$(mktemp -d)
git -C "$REPO" init -q -b main
cp -R "$HERE/auth" "$HERE/export" "$HERE/PRD-auth.md" "$HERE/PRD-export.md" "$REPO/"
git -C "$REPO" add -A
git -C "$REPO" -c user.name=demo -c user.email=demo@demo commit -q -m "demo features"
cp "$HERE/fake${1:+-$1}.json" "$REPO/.git/fake.json"

echo "Demo repo: $REPO"
[ -n "${1:-}" ] && echo "To fix it: cp $HERE/fake.json $REPO/.git/fake.json  (then press Retry)"
cd "$REPO"
GRAPH_EXECUTION_FAKE_SCRIPT="$REPO/.git/fake.json" \
  node "$ROOT/dist/cli.js" suite \
  --feature auth:PRD-auth.md --feature export:PRD-export.md \
  --provider fake --concurrency 2 --web
