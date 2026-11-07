# PRD: graph-manager without terminal statuses

No Jira ticket: the user asked for this in conversation on 2026-11-07, after the design v1 work (`docs/prd/done/graph-manager-design.md`). The id is `GMD-15`.

## Problem

graph-manager labels every terminal `working`, `idle` or `exited`. The label comes from a heuristic: output in the last 3 s means working, otherwise idle. These statuses show up across the UI:

- filter chips "N working · N idle · N other"
- a NEEDS YOU section in the sidebar
- status badges, glyphs and amber "idle · waiting on you" text
- nav status rows and a nav badge
- a "Terminals idle" card on Runs
- `Ctrl Space a` (next idle) and the palette

The user doesn't want any of it.

## Goal

- **GMD-15 Remove terminal statuses from the UI.** Terminals show their title, workspace and foreground process. They show no working, idle or other state.

## What stays

- **The exited bar inside a terminal pane.** It reads "Process exited with code N" with **Restart** and **Close**, because it is the only way to restart a terminal. It is not a status label.
- **The reconnecting bar** when the WebSocket drops.
- **Run statuses** (running, applied, failed, …): only terminal statuses go.
- **The server API.** `GET /api/terminals` still returns `status`, `exitCode`, `lastOutputAt` and `process`. The UI no longer reads `status`, apart from knowing that a terminal has exited, for the pane bar.

## Non-goals

- Changing the engine (`packages/graph-execution/` stays untouched).
- Changing run statuses, the Runs table, or anything else in design v1.

## User stories and acceptance criteria

**US-1 No terminal statuses.** As the owner, I see my terminals without working, idle or other labels.

- **Sidebar.** The Terminals sidebar has no filter chips and no NEEDS YOU section: one section per workspace, then WORKSPACES ROOT.
  - Each item shows its title and a mono sub-line with the foreground process (for example `bash`, or `node` while graph-execution runs). It has no status glyph, no amber styling and no time.
  - Items still show their live-run chips and pane numbers.
- **Tabs and panes.** Terminal tabs and pane headers show no status dot or badge, and panes have no amber "idle" border.
- **Nav.** The nav status block keeps only "runs live" and "runs failed". The Terminals nav badge is the plain number of terminals, with no coloured working·idle pair. The rail shows no terminal dot.
- **Runs page.** It has three cards: Live, Failed, Ready for PR. The "Terminals idle" card is gone.
- **Palette.** It lists terminals without a status.
- **Keyboard.** `Ctrl Space a` (next idle) and its footer hint are gone. `?filter=` on `/terminals` is ignored.
- **Closing.** Closing a terminal asks first only when its foreground process is not a plain shell (`bash`, `sh`, `zsh`, `fish`, `dash`, `ash`, `tcsh`, `csh`, `ksh`, `pwsh`), for example while `claude` or `node` runs. The dialog says: 'Close “<title>”? <process> is running. Closing the tab ends it and its scrollback.' Otherwise, and for an exited terminal, it closes right away.
- **Exited terminals.** An exited terminal still shows the exited bar with Restart in its pane.
- **Docs.** `README`, `TESTING.md` and the wiki no longer describe terminal statuses.
- **Checks.** `npm run typecheck && npm run lint && npm test` pass.
