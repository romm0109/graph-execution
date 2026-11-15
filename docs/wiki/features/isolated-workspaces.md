# Isolated runs and terminals, and a Create PR that can recover

## Summary

graph-manager no longer has a shared workspace folder that runs and terminals all work in:

- **Runs** started from graph-manager get `--base <branch> --no-merge`. A run starts from the committed state of the branch picked under **Start from**, works only in its own worktree, and ends on its own `graph/<run-id>` branch. It never reads or changes the checkout or a terminal's folder, so two runs on one workspace never mix.
- **Terminals** opened on a workspace each get their own git worktree, `<workspace>/.gm-worktrees/<id>`, on a branch `gm-term/<id>`. Closing one with work asks **Delete / Keep / Create PR**. Kept worktrees are listed under their workspace until you delete them.
- **Create PR** pushes `graph/<run-id>` and opens a PR into the branch picked under **Merge into**. It checks push access first, never touches the checkout, and offers **Retry** after any failure. This fixes the bug where a push rejected with HTTP 403 left a run stuck, with "no changes to open a PR" and no way to retry.
- The **spec pane** belongs to the terminal whose worktree the spec is in. It opens by itself only when a spec is created.
- The run page marks each task and review report **reused** or **ran again** after a resume, and validation shows **fixing N/M** then **checking fix N/M**.
- Sandboxes work on Docker 20.10 and newer.

References:

- Spec: `docs/prd/done/isolated-workspaces.md`.
- Tasks: `.agents/tasks/isolated-workspaces/`. They were implemented by hand, because the cloud session where this was built had no signed-in `claude` for graph-execution's agents.
- User docs: `README.md` ("How it works"), `apps/graph-manager/README.md` (Terminals, Run detail, Sandboxed runs, `open_start_run`), and `packages/graph-execution/README.md` (`--base`).

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| Runs and terminals use git worktrees, not clones or containers of their own. | The user chose worktrees: they are fast and cheap. A sandboxed run is still a container, and its worktrees are inside the mounted workspace. | KAN-98, KAN-100 |
| The engine gets `--base <ref>`, and graph-manager always passes `--base <branch> --no-merge`. | The engine already makes `graph/<run-id>` and an integration worktree from the starting commit. With `--base` it never needs the checkout's HEAD, and with `--no-merge` it never applies to the checkout. No second worktree per run. | KAN-98 |
| **Start from** defaults to the workspace's current branch, or to the terminal's branch when an agent's `open_start_run` opened the form. | That is the branch the user is looking at. Any local or `origin/…` branch can be picked. | KAN-104 |
| A run reads only committed code. Uncommitted changes in the terminal show a warning in Start run. | Full separation between runs and terminals. graph-manager does not make commits on the user's behalf. | KAN-104 |
| `open_start_run` keeps working from any terminal, and its paths are read in the terminal's worktree. | The user wants the separation to happen when the run starts, not by taking tools away from agents. | KAN-104 |
| The run's PR always comes from `graph/<run-id>`, into the **Merge into** branch, which defaults to the run's start branch. | This replaces the editable `gm/<run-id>` branch. The run's branch already holds exactly the result. | KAN-103 |
| Create PR steps: `access` (`git push --dry-run`), `commit` (spec move, in a throwaway worktree), `push`, `create`. | The 403 surfaced only after the commit. A dry run checks the real thing and changes nothing. | push bug |
| Retry is a new job that runs every step again. The spec-move commit is skipped when `done/<name>.md` is already on the branch, and an "already exists" answer from the forge looks up the open PR. | Every step is idempotent, so Retry needs no saved progress and survives a restart. | push bug |
| A 401/403/"permission denied" push error becomes `the <Forge> token can't push to <repo>: give it write access … then Retry`. | The raw git line did not say what to fix. | push bug |
| Terminal worktree ids are random (`w` + 8 hex digits), not terminal ids. | Terminal ids restart at `t1` with the server, and kept worktrees outlive it. | KAN-100 |
| Kept worktrees are stored in `graph-manager.json` (`terminalWorktrees`). A worktree whose terminal is gone after a restart counts as kept. | Terminals live in memory. The work must not get lost. | KAN-100 |
| Qwen Code's `.qwen/settings.json` is still committed once in the checkout, before the worktree is cut. A reopened kept worktree gets it in the worktree, with its base moved past that commit. | This keeps the existing, documented behaviour, and graph-manager's own commit never counts as the user's work. | KAN-100 |
| The spec pane opens only for a spec path it has not seen before, per terminal. | The pane kept reopening on every save, and showed in every terminal of the workspace. | KAN-99 |
| Resume markers are saved in `state.json`: `tasks[id].resumed` and a run-level `reportsResumed` (not under `review`, which the review phase rewrites at each step). | A finished or reloaded run shows them too. A fresh run has none. | KAN-97 |
| The run page shows a node's state text on the card's second line, in place of the provider. | The title and `revalidate N/M` overlapped. | KAN-102 |
| Docker API version: `min(1.45, daemon)`, with 1.41 (Docker 20.10) as the floor. A `Subpath` volume mount on an older daemon fails with a message that names `GM_SANDBOX_WORKSPACES_SOURCE`. | Only `VolumeOptions.Subpath` needs 1.45, and only when graph-manager itself runs in a container on a named volume. | KAN-101 |

## Follow-ups

- Project (multi-repo) runs still apply to each repo's checkout. Their Create PR is unchanged.
- A run started by typing `graph-execution` in a terminal runs in that terminal's worktree with the engine's defaults.
- A run that reads its spec from a terminal worktree cannot be resumed once that worktree is deleted, because the spec path is gone.
- Kept worktrees are never cleaned up automatically.
- The Runs list's `PR failed: retry` lasts only while the server runs (the job registry is in memory). After a restart the run shows **Create PR** again, which does the same thing.

## Code

- Engine: `packages/graph-execution/src/launch/preflight.ts` (`checkEnvironment` with `base`), `runner/startup.ts`, `cli.ts` (`--base`), `state/resume.ts` and `runner/run.ts` (resume markers), `web/assets/runpage.js` and `graph.js` (labels, markers).
- Worktrees: `apps/graph-manager/src/server/worktrees.ts`, `routes/terminals.ts` (create, close, kept list, worktree PRs), `worktree-pr.ts`.
- Runs: `routes/runs.ts` (`base`, `terminalId`, `run-defaults` branches), `runoptions.ts` (`startArgs`).
- Create PR: `pr.ts` (`access` / `commit` / `push` / `create`, retry), `forges.ts` (`findPullRequest`).
- Docker: `docker.ts` (`negotiate`), `sandbox.ts`.
- Web: `pages/Terminals.tsx`, `TerminalSidebar.tsx`, `WorktreeClose.tsx`, `WorktreePr.tsx`, `StartRunDrawer.tsx`, `PrPanel.tsx`, `Runs.tsx`, `specPane.ts`, `SpecFloat.tsx`, `ResumeMarker.tsx`.
