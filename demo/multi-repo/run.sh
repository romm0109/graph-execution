#!/usr/bin/env bash
# Demo of a multi-repo `graph-execution suite` with the fake provider: no login, no cost.
# It makes two repos, shop-api (backend) and shop-web (frontend), each with one feature, and runs the suite from
# their parent folder, which is not a repo. Each repo is integrated on its own suite/<id> branch, the e2e phase
# runs on <suite folder>/e2e/workspace/{shop-api,shop-web}/, and the result is applied to both repos or to none.
# Usage: demo/multi-repo/run.sh [suite flags...]
#   --human-review  pauses before the apply. Comment on shop-web/button.txt and press Request changes: the e2e fixer
#                   commits a fix to shop-web's suite branch only. Then press Apply.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
(cd "$ROOT" && npm run build >/dev/null)

BASE=$(mktemp -d)
for repo in shop-api shop-web; do
  git -C "$BASE" init -q -b main "$repo"
  cp -R "$HERE/$repo/." "$BASE/$repo/"
  git -C "$BASE/$repo" add -A
  git -C "$BASE/$repo" -c user.name=demo -c user.email=demo@demo commit -q -m "demo feature"
done
cp "$HERE/fake.json" "$BASE/fake.json"

echo "Launch folder: $BASE"
echo "Repos:         $BASE/shop-api  $BASE/shop-web"
echo "Afterwards:    git -C $BASE/shop-api status; git -C $BASE/shop-web status"
cd "$BASE"
GRAPH_EXECUTION_FAKE_SCRIPT="$BASE/fake.json" \
  node "$ROOT/dist/cli.js" suite \
  --feature "$BASE/shop-api/export-api:$BASE/shop-api/PRD-export-api.md" \
  --feature "$BASE/shop-web/export-ui:$BASE/shop-web/PRD-export-ui.md" \
  --provider fake --concurrency 2 --web "$@"
