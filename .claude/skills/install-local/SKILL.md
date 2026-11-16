---
name: install-local
description: Build this repo and install it on this computer — the global `graph-execution` CLI (with `graph-execution manager`) and the graph-manager desktop app in /Applications on macOS. Use when the user pulled a new version and wants it installed, asks to "build and install locally", "install it globally", "update the app", "do it again" after a pull, or reinstall the desktop app.
---

# Install the local build

Build the checked-out code and install it on this computer with `install.sh`, next to this file. It always builds what is checked out: it doesn't pull, switch branches, commit or publish.

## 1. Pick what to install

| Argument | Installs |
| --- | --- |
| `all` (default) | both of the below |
| `cli` | the global `graph-execution` command: builds the monorepo, `npm pack`s `packages/graph-execution` into a temp folder and runs `npm install -g` on the tarball. A copy, not a link: later builds don't change it. |
| `app` | the desktop app (macOS only): `npm run dist -w graph-manager-desktop`, then copies `release/mac-arm64/graph-manager.app` (or `release/mac/` on Intel) to `/Applications/graph-manager.app`. |

Use what the user asked for. "Install it globally" or "the lib" means `cli`; "the app" or "desktop" means `app`; "do it again" means the same as last time.

## 2. Check before running

- `git branch --show-current` and `git log --oneline -1`. Tell the user which branch and commit you build, and say so if it isn't the branch they built last time: features from the other branch disappear from the install.
- For `app`: the script quits a running graph-manager app (⌘Q, which stops its local server). Say so before you run it if the app may be in use.

## 3. Run it

```bash
bash .claude/skills/install-local/install.sh [cli|app|all]
```

Run it from anywhere in the repo, with a timeout of 10 minutes: `npm run dist` takes a few minutes. Don't run the steps by hand: the script handles the cases that broke before:

- The tarball goes to a temp folder, so no `.tgz` is left in the repo.
- The app is quit and its copy replaced, never copied into the old one.
- Spotlight shows one app per bundle id: the script ejects mounted `graph-manager` disk images and unregisters the copies in `release/` with `lsregister -u`, so only `/Applications/graph-manager.app` is registered. Without this the app doesn't appear in Spotlight.

## 4. Report

- The installed CLI version (`graph-execution --version`) and the app version the script prints.
- The version number comes from `packages/graph-execution/package.json` (CLI) and `apps/graph-manager-desktop/package.json` (app). If it didn't change since the last install, say the code is new even though the number is the same.
- If the build fails, show the failing lines; don't install anything else.

## Notes

- The app is ad-hoc signed (`identity: "-"` in `apps/graph-manager-desktop/electron-builder.yml`), so it opens without the right-click → **Open** step. An unsigned build (`identity: null`) is hidden from Spotlight on Apple silicon.
- The app keeps its settings in `~/Library/Application Support/graph-manager-desktop/desktop.json` and its data in `~/.graph-manager`: reinstalling keeps both.
- To have the global command follow every build instead of a copy: `cd packages/graph-execution && npm link`. Only do this if the user asks.
