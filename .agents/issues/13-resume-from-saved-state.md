# 13. Resume from saved state

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Implement `graph-execution --resume [--run <id>]` (default: latest run). It loads `state.json`, verifies the config, task-folder and spec hashes against those stored at run start (refusing with a clear message if they changed), takes the PID lock, reconciles state with git (git wins), and continues from the right step: remaining tasks through the scheduler, then the review phase from the saved round and step, without regenerating valid existing reports. Covers PRD §7.8 and user story 8.

## Context: files to read before implementing

- `PRD.md` §6 (git is the source of truth, persisted transitions), §7.8 (resume algorithm), §7.7 (abort keeps everything), §9 (spec hash).
- `src/state/state.ts`, `src/runner/run.ts`, `src/review/phase.ts`, `src/git/git.ts` — all earlier issues; state must now also carry the hashes and the review progress.

## Patterns to follow

**Conventions (set in issue 01, mirror in every issue):**
```
- TypeScript 5, Node 20+, ESM ("type": "module"), strict mode. Imports use the .js extension for local files.
- Source in src/<module>/ exactly as listed in PRD §6; tests next to the module: src/<module>/<name>.test.ts (vitest).
- Schemas (task JSON, state, config, reports) are zod schemas exported from the module that owns them; types come from z.infer.
- Shell/git calls go through execa with an argument array, never a single shell string, and always pass cwd explicitly.
- npm scripts (created in issue 01): "typecheck": "tsc --noEmit", "lint": "eslint .", "test": "vitest run", "build": "tsc -p tsconfig.build.json".
- Errors that should abort the run extend `AbortRunError` (src/state/errors.ts, created in issue 03; until then throw plain Error).
```


## Step-by-step tasks

Execute in order. Each task is atomic.

### MODIFY `src/state/state.ts`

- **IMPLEMENT**: add `hashes: { config, tasks, spec }` (sha256 of the config file content or `''`, of the sorted concatenated task file contents, of the spec file), `review: { phase: 'validate'|'review'|'fix'|'done', round: number, validationRounds: number, reports: {code?: path, tester?: path} }`, and a `lock` helper `acquireLock(runDir)` writing a PID file, treating a lock whose PID is dead as stale, and failing with a clear message if the PID is alive.
- **GOTCHA**: the hashes are written when the run starts (issue 02 startup path) and never updated.

### CREATE `src/state/resume.ts`

- **IMPLEMENT**: `reconcile(state, repo)` per PRD §7.8: `merged` tasks whose `mergeCommit` is not an ancestor of `graph/<run-id>` revert to `pending`; `merging` tasks are checked (is the task branch tip an ancestor of the integration branch? then mark `merged` with the merge commit, else retry the merge); `running`/`validating` tasks get their stale worktree and branch removed, keep their `attempts` counter, and go back to `pending`; `failed` tasks go back to `pending` with `attempts` reset to 0; leftover `review-*` throwaway worktrees are removed (`git worktree prune` first). Returns the repaired state.

### MODIFY `src/cli.ts` and `src/runner/run.ts`

- **IMPLEMENT**: wire `--resume`. Rebuild the ready set from the graph and statuses, run the scheduler for the remaining tasks, then enter the review phase at `state.review` (skip a review whose report file exists and passes `reportSchema`). `--run <id>` selects a run directory; otherwise the latest by name.
- **GOTCHA**: do not recompute the starting commit or recreate the integration branch; they are in the state. The integration worktree may need to be re-added if missing (`git worktree add` for the existing branch).

### CREATE tests `src/state/resume.test.ts`

- **IMPLEMENT**: a kill-at-every-transition harness: run the full diamond+review flow in a child process with the fake provider and an env var `GRAPH_EXECUTION_KILL_AT=<n>` that exits the process hard at the n-th state save; for every n, resume to completion and assert the final branch tree equals the uninterrupted run's tree and no completed task was re-executed. Also: changed spec hash refuses, live PID lock refuses, stale lock is taken over, a failed task gets a fresh 3 attempts.


## Acceptance criteria

- [ ] `graph-execution --resume` after a kill at any state transition finishes the run with the same final tree as an uninterrupted run
- [ ] Completed (`merged`) tasks and valid existing reports are not executed again
- [ ] Attempt counters of killed `running` tasks are kept; failed tasks get a fresh 3 attempts
- [ ] A changed spec, config or task folder refuses to resume with a message naming which one changed
- [ ] A live PID lock refuses a second concurrent resume; a stale lock is taken over
- [ ] Git wins: a state saying `merged` for a task whose merge commit is missing is repaired to `pending`

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 12-fixer-and-fix-pass-loop.md — every state the reconciler must handle exists once the loop does.
