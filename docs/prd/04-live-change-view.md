# PRD: Live change view (KAN-4)

Jira: [KAN-4](https://graph-execution.atlassian.net/browse/KAN-4) (epic) → [KAN-22](https://graph-execution.atlassian.net/browse/KAN-22) (story) → [KAN-6](https://graph-execution.atlassian.net/browse/KAN-6), [KAN-8](https://graph-execution.atlassian.net/browse/KAN-8), [KAN-7](https://graph-execution.atlassian.net/browse/KAN-7) (subtasks, in build order).

## 1. Executive Summary

During a run you can see *that* a node is running, but not *what it is changing*. This feature adds a read-only live view of each agent's changes. The tool diffs every running agent's worktree against the commit it started from, untracked files included. The terminal shows `+120 −8 · 4 files` on each node. In `--web`, clicking a node opens a side panel with its changed files and their diffs, updating while the agent works.

The value: you watch the code take shape, catch a wrong direction early (abort or retry), and trust the result more because you saw how it was built.

**MVP goal:** in a real `--web` run, clicking a running task shows its diff growing as it works, and the terminal shows its counts. Finished nodes keep showing their final diff after their worktree is removed, and after a resume.

## 2. Mission

Make every agent's work visible while it happens, without letting anyone change it mid-run.

**Principles**

1. **Read-only.** No steering. Changes made outside the agent would skip the review and testing loop.
2. **Never slow the run.** Diffing is throttled, never overlaps itself, and uses read-only git commands that cannot race the merge lock or `git worktree` commands.
3. **Small events, lazy text.** File stats go out over the existing event stream. Diff text is fetched only when someone opens a file.
4. **Show what will be merged.** Only the current attempt counts. Finished nodes are diffed from git history, so the view matches what lands.
5. **Stable UI.** No layout jumps in the terminal, and no lost scroll or collapsed files in the web panel.

## 3. Target Users

- **Developer running a graph locally**, watching the terminal UI or `--web`. Comfortable with git and diffs. Needs to know early whether an agent is on the right track, so they can abort or retry before burning attempts and time.
- **Developer reviewing a finished run**, who wants to see what each task contributed before the result is applied to their branch.

Pain today: a node shows `running` for minutes, with nothing to judge it by except the agent log.

## 4. MVP Scope

### Core Functionality
- ✅ Live diff for running **task agents**, the **fixer** and the **gate fixer**
- ✅ Uncommitted changes and **untracked files** included; `.gitignore`d files excluded
- ✅ Final diff for finished nodes, computed from git history
- ✅ Retries show only the **current attempt**
- ✅ Terminal: `+120 −8 · 4 files` on a fixed stats row per node
- ✅ Web: one side panel per node with failure/Retry/Merge (if failed), file list, expandable diffs
- ❌ The **resolver** (its baseline is a half-done merge)
- ❌ An attempt picker to compare earlier attempts
- ❌ Activity line ("editing `src/x.ts`"): moved to its own epic, [KAN-53](https://graph-execution.atlassian.net/browse/KAN-53)
- ❌ Steering the agent mid-run

### Technical
- ✅ 2 s polling per running node; skip a tick while the previous diff runs; emit only on change
- ✅ `baseSha` persisted in run state when a task's worktree is cut
- ✅ Per-file diff cap of 200 KB with a "truncated" marker; binary files are stats only
- ✅ Lockfiles and files with more than 1,000 changed lines start collapsed
- ❌ File watchers (`fs.watch`)
- ❌ Syntax highlighting or side-by-side diffs

### Integration
- ✅ File stats carried by the existing throttled SSE `state` snapshot
- ✅ New `GET /changes/<node-id>[?file=<path>]` route for diff text, behind the existing Host/Origin guard
- ✅ The same data feeds the terminal UI and the web view (one store)

### Deployment
- ✅ Ships in the npm package; no new config, flags or dependencies

## 5. User Stories

1. **As a** developer watching `--web`, **I want to** click a running task and see its changed files, **so that** I can judge its direction before it finishes.
   *Example:* `auth-api` shows `src/api/users.ts +84 −3`, `src/api/users.test.ts +40 new`, and a third file appears 2 s after the agent creates it.
2. **As a** developer, **I want to** expand a file and read its diff, updated as the agent keeps editing, **so that** I can see the actual code.
   *Example:* the expanded `users.ts` diff refreshes in place when its counts go from `+84` to `+97`, without losing the scroll position.
3. **As a** developer watching the terminal, **I want** each node to show `+120 −8 · 4 files`, **so that** I can see progress at a glance.
   *Example:* a node that has written nothing yet keeps an empty stats row and the same height.
4. **As a** developer, **I want** a failed node's panel to show the failure, Retry/Merge and its diff together, **so that** I can decide what to do from one place.
   *Example:* `db-migrate` failed with `no_commit`; the panel shows the error, Retry, and "No changes yet".
5. **As a** developer, **I want** a retried node to show only its current attempt, **so that** I'm not misled by work that was thrown away.
   *Example:* attempt 2 starts; the diff clears and fills again from the fresh worktree.
6. **As a** developer reviewing after the run (or after `resume`), **I want** finished nodes to keep their final diff, **so that** I can see what each task contributed.
   *Example:* after a successful run all worktrees are gone, but `auth-api`'s panel still shows `baseSha..graph/<run>/auth-api`.
7. **As a** developer, **I want** the fixer's changes to show too, **so that** I can see what the review loop changed.
   *Example:* the fixer node shows its diff against the integration HEAD when the fix pass started.
8. **(Technical) As a** maintainer, **I want** diffing to never overlap itself or touch the merge lock, **so that** the run is no slower with concurrency 3.

## 6. Core Architecture & Patterns

```
run.ts ──start/end/retry──► ChangeTracker (per node: worktree, baseSha, timer, busy flag)
                                │ every 2 s while running, + once at end
                                ▼
                          git diff --numstat / ls-files --others (read-only, in the node's worktree)
                                │ only if stats changed
                                ▼
                     RunEmitter "nodeChanges" ──► store (NodeView.changes)
                                                    ├──► Ink terminal (Graph.tsx: stats row)
                                                    └──► web server snapshot ──SSE "state"──► page.html panel
                                                                                              │ open/expand file
                                                         GET /changes/<id>?file=… ◄───────────┘
```

**Diff source per node**

| Node state | Task | Fixer / gate fixer |
|---|---|---|
| Running | worktree vs `baseSha` (+ untracked) | integration worktree vs HEAD at pass start (+ untracked) |
| Finished | `baseSha..<task-branch>` | `<pass-start>..<pass-end>` on the integration branch |
| Pending (incl. after resume reset) | none ("No changes yet") | none |

**Patterns**

- **One tracker per node, not per run.** A timer per running node with a `busy` flag gives "never overlaps itself" for free. Stopping the node stops its timer.
- **Emit on change.** Compare the new stats with the last ones before emitting, so idle agents cause no SSE traffic.
- **Git history for finished nodes.** Worktrees are removed after a retry and at the end of a successful run; branches stay. Task branches are deleted only by `resume`, and only for tasks it resets to pending, which then correctly show no changes.
- **Store as the single source.** File stats live in `NodeView`, so the terminal and web read the same data and the existing snapshot/SSE path needs no new channel.

**Files touched**

```
src/runner/events.ts      nodeChanges event; extend ChangedFile (removed/renamed flags)
src/runner/run.ts         start/stop tracking; record baseSha and fix-pass end commits
src/runner/changes.ts     NEW: ChangeTracker + diff functions
src/git/git.ts            numstat, untracked list, per-file diff with cap
src/state/state.ts        task.baseSha
src/ui/store.ts           NodeView.changes
src/ui/Graph.tsx, layout.ts, model.ts   fixed stats row
src/web/server.ts         GET /changes route
src/web/page.html         node side panel
```

## 7. Features

### 7.1 Change tracking (KAN-6)
- Start tracking when a node's agent starts; record `baseSha` (task) or the pass-start HEAD (fixer).
- Every 2 s: `git diff --numstat <base>` plus `git ls-files --others --exclude-standard` in the node's worktree. Untracked files count all their lines as added.
- Skip a tick if the previous one is still running. Emit `nodeChanges` only when the stats differ.
- On node end: one final snapshot, then stop the timer.
- On retry: clear the node's changes when the new attempt's worktree is cut.
- Binary files: listed, counts 0, no text.

### 7.2 Terminal stats (KAN-8)
- Every node reserves one stats row; empty when there are no changes.
- Format: `+120 −8 · 4 files`, compact above 999 (`+1.2k`).
- Kept in the final printed graph.

### 7.3 Web panel (KAN-7)
- Clicking any node opens one side panel, replacing today's failure-only selection:
  1. failure + Retry/Merge (if the node failed)
  2. file list: path, `+/-`, badges (new / deleted / renamed / binary)
  3. expandable unified diff per file, colored
- Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, …) and files over 1,000 changed lines start collapsed.
- Live updates from the SSE snapshot keep the scroll position and the set of expanded files.
- When an expanded file's counts change, its diff is fetched again in the background and swapped in.
- Empty state: "No changes yet".

## 8. Technology Stack

No new dependencies. Uses what the project already has:

| Area | Tech |
|---|---|
| Runtime | Node ≥ 20, TypeScript 5.9 |
| Git | `git` CLI through `execa` 9 (existing `src/git/git.ts` helpers) |
| Terminal UI | Ink 6 + React 19 |
| Web | Node `http` server, Server-Sent Events, a single static `page.html` (no framework) |
| State | `zod` 4 schema in `src/state/state.ts` |
| Tests | Vitest 3, `ink-testing-library`, fixture repo `src/__fixtures__/repo.ts`, agent-browser for manual checks |

## 9. Security & Configuration

- **No new configuration.** Polling interval (2 s), diff cap (200 KB) and collapse threshold (1,000 lines) are constants.
- **`/changes` route:** same Host/Origin guard as the other routes; the server binds to `127.0.0.1` only.
- **Node ids:** only ids known to the run's graph are accepted (404 otherwise).
- **File paths:** `file` must be one of the paths in that node's current change list. Anything else, including `..` or absolute paths, returns 400. Paths are never joined onto the filesystem unchecked.
- **Read-only git:** only `diff`, `ls-files` and `rev-parse`; never `add`, `stash` or index writes in an agent's worktree.
- **Out of scope:** secret scanning of diff content. The view shows the code the agents wrote, which is on disk in the user's repo anyway.

## 10. API Specification

### Event: `nodeChanges` (RunEmitter → store)

```ts
interface NodeChanges {
  nodeId: string;
  files: ChangedFile[];          // sorted by path
  total: { added: number; deleted: number; files: number };
}

interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
  isNew?: boolean;
  isDeleted?: boolean;
  renamedFrom?: string;
  binary?: boolean;
}
```

The store keeps it as `NodeView.changes`, so it appears in `GET /state` and every SSE `state` event.

### `GET /changes/<node-id>`
Returns the file list (same shape as above). `404` for an unknown node.

### `GET /changes/<node-id>?file=<path>`

```json
{
  "path": "src/api/users.ts",
  "diff": "@@ -1,4 +1,9 @@\n import …\n+export async function listUsers() {\n…",
  "truncated": false,
  "binary": false
}
```

| Status | When |
|---|---|
| 200 | diff returned (possibly `truncated: true` past 200 KB) |
| 400 | `file` not in the node's change list |
| 404 | unknown node id |
| 421 / 403 | Host / Origin guard, as for other routes |

## 11. Success Criteria

**MVP is done when** a real `--web` run shows a running task's diff growing live, the terminal shows its counts, and finished nodes still show their diff after the run, all checked by hand (agent-browser + terminal).

**Functional**
- ✅ A task that edits 2 files and creates 1 shows 3 files with correct counts within ~5 s.
- ✅ Untracked files appear; `.gitignore`d files don't.
- ✅ Polling stops when a node ends; its last snapshot stays.
- ✅ A retried task shows only the current attempt.
- ✅ A finished task's diff opens after its worktree is removed, and after `resume`.
- ✅ Fixer and gate fixer show their changes.
- ✅ Failure + Retry/Merge work from the new panel.
- ✅ `/changes/<unknown>` → 404; bad `file` → 400.
- ✅ Large diffs show "truncated"; lockfiles start collapsed.

**Quality**
- ✅ No measurable slow-down at concurrency 3.
- ✅ Unit tests on the fixture repo for modified, new, deleted and binary files.
- ✅ Layout tests for long counts and narrow terminals; `App.test.tsx` snapshot with stats.
- ✅ Server tests for `/changes`; `web-e2e.test.ts` opens the panel.

**UX**
- ✅ No terminal layout jumps; nodes keep the same height.
- ✅ Web panel keeps scroll position and expanded files across updates.

## 12. Implementation Phases

### Phase 1: Change tracking (KAN-6), ~2 days
- ✅ `task.baseSha` in run state; fix-pass end commit recorded
- ✅ git helpers: numstat, untracked list, per-file diff with cap
- ✅ `ChangeTracker` with 2 s polling, busy flag, final snapshot, retry reset
- ✅ `nodeChanges` event → `NodeView.changes`

*Validation:* fixture-repo unit tests; a fake-provider run logs correct stats per node.

### Phase 2: Terminal stats (KAN-8), ~1 day
- ✅ Fixed stats row in `layout.ts` / `Graph.tsx`
- ✅ Compact number formatting

*Validation:* layout tests, `App.test.tsx` snapshot, manual terminal run with the fake provider.

### Phase 3: Web panel (KAN-7), ~2–3 days
- ✅ `GET /changes` route + server tests
- ✅ Side panel merging the failure box, file list and diffs
- ✅ Live updates preserving scroll/expanded state; refetch on count change
- ✅ README "The web view" updated

*Validation:* server tests, `web-e2e.test.ts`, manual check in agent-browser per `TESTING.md`.

### Phase 4: End-to-end check (KAN-22 done-when), ~0.5 day
- ✅ Real run with `--web` and a real provider; verify all success criteria, including after `resume`

## 13. Future Considerations

- **Activity line** ([KAN-53](https://graph-execution.atlassian.net/browse/KAN-53)): "editing `src/x.ts`", "running `npm test`" in the same panel header.
- **Resolver diffs**, once there's a clear baseline for a half-done merge.
- **Attempt picker** to compare a failed attempt with the current one.
- **Suite web view** ([KAN-48](https://graph-execution.atlassian.net/browse/KAN-48)) reuses this panel for feature nodes.
- Syntax highlighting, side-by-side view, per-file "jump to" from the terminal.

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Git calls slow the run or race merges/worktree commands | Read-only commands only, run in the node's own worktree; one in-flight diff per node; 2 s interval; emit only on change |
| Huge diffs (lockfiles, generated or vendored files) bloat the page | Stats only in snapshots; text on demand; 200 KB per-file cap; auto-collapse of lockfiles and files over 1,000 lines |
| Worktree removed between a poll and its git call | Treat a missing worktree as "node ended": stop polling and fall back to the git-history diff |
| Snapshot size grows with many nodes × files | Stats are a few KB per node; SSE stays throttled at 100 ms. Revisit with "totals only" if a run exceeds ~1 MB snapshots |
| Path traversal through `?file=` | Accept only paths in the node's current change list; never join user input onto the filesystem |

## 15. Appendix

**Decisions log (grill sessions, 2026-10-21)**

| Topic | Decision |
|---|---|
| Scope | Live diff only; activity line moved to KAN-53 |
| Nodes | Tasks, fixer, gate fixer; resolver later |
| Finished nodes | Diff from git history (`baseSha..branch`, pass start..end) |
| Baseline | Persist `task.baseSha` in run state |
| Retries | Current attempt only |
| Refresh | Poll every 2 s, no overlap, emit on change |
| Untracked files | Full addition (`git diff --no-index /dev/null <file>`) with "new" badge |
| Large changes | 200 KB cap + auto-collapse (lockfiles, >1,000 lines) |
| Transport | File stats in the store/SSE snapshot; text via `/changes` |
| Open diffs | Refetch when counts change, keep scroll |
| Web click | One panel per node (failure + changes) |
| Terminal | One fixed stats row per node |
| Deleted branches | Only `resume` deletes them, for nodes reset to pending → "No changes yet" |
| Order | KAN-6 → KAN-8 → KAN-7 |

**Related**
- `PRD.md` (main product PRD), `docs/prd/01-run-skill-and-web-view.md` (web view)
- `TESTING.md` (manual browser checks)
- Code: `src/runner/run.ts`, `src/state/resume.ts`, `src/web/server.ts`, `src/web/page.html`
