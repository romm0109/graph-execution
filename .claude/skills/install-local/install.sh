#!/usr/bin/env bash
# Builds this repo and installs it on this computer:
#   cli  the global `graph-execution` command, from an npm-packed tarball of packages/graph-execution
#   app  the desktop app (macOS only), copied to /Applications/graph-manager.app
# Usage: bash .claude/skills/install-local/install.sh [cli|app|all]   (default: all)
set -euo pipefail

what="${1:-all}"
case "$what" in cli|app|all) ;; *) echo "usage: install.sh [cli|app|all]" >&2; exit 2 ;; esac

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root"
echo "== $(git branch --show-current) @ $(git log --oneline -1)"

echo "== npm ci"
npm ci --no-audit --no-fund >/dev/null

if [[ "$what" == cli || "$what" == all ]]; then
  echo "== build"
  npm run build >/dev/null
  pack="$(mktemp -d)"
  tgz="$(cd packages/graph-execution && npm pack --ignore-scripts --pack-destination "$pack" 2>/dev/null | tail -1)"
  [[ -f "$pack/$tgz" ]] || { echo "npm pack failed" >&2; exit 1; }
  echo "== install $tgz globally"
  npm rm -g graph-execution >/dev/null 2>&1 || true
  npm install -g "$pack/$tgz" --no-audit --no-fund >/dev/null
  rm -rf "$pack"
  echo "graph-execution $(graph-execution --version) at $(command -v graph-execution)"
fi

if [[ "$what" == app || "$what" == all ]]; then
  if [[ "$(uname)" != Darwin ]]; then
    echo "== skip app: the desktop app install is macOS only"
    exit 0
  fi
  echo "== build the desktop app (npm run dist)"
  npm run dist -w graph-manager-desktop >/dev/null
  arch_dir=mac; [[ "$(uname -m)" == arm64 ]] && arch_dir=mac-arm64
  release="$root/apps/graph-manager-desktop/release"
  built="$release/$arch_dir/graph-manager.app"
  [[ -d "$built" ]] || { echo "not found: $built" >&2; exit 1; }
  codesign --verify --deep --strict "$built"

  if pgrep -f "/Applications/graph-manager.app/Contents/MacOS/graph-manager" >/dev/null; then
    echo "== quit the running app"
    osascript -e 'quit app "graph-manager"' >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do pgrep -f "/Applications/graph-manager.app/Contents/MacOS/graph-manager" >/dev/null || break; sleep 1; done
    if pgrep -f "/Applications/graph-manager.app/Contents/MacOS/graph-manager" >/dev/null; then
      echo "graph-manager is still running; quit it and run again" >&2; exit 1
    fi
  fi

  echo "== install /Applications/graph-manager.app"
  rm -rf /Applications/graph-manager.app
  ditto "$built" /Applications/graph-manager.app
  xattr -dr com.apple.quarantine /Applications/graph-manager.app 2>/dev/null || true

  # Spotlight shows one app per bundle id: keep only the installed copy registered, or it can hide the app.
  ls_bin=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  for v in /Volumes/graph-manager*; do [[ -d "$v" ]] && hdiutil detach "$v" -quiet || true; done
  for a in "$release"/mac*/graph-manager.app; do [[ -d "$a" ]] && "$ls_bin" -u "$a" 2>/dev/null || true; done
  "$ls_bin" -f -R /Applications/graph-manager.app
  touch /Applications/graph-manager.app
  echo "graph-manager $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/graph-manager.app/Contents/Info.plist) installed"
fi
