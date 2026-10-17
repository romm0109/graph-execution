# 05. Parallel scheduler with concurrency cap

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Replace the sequential task loop with the DAG scheduler: any task whose dependencies are all `merged` is ready; ready tasks start immediately up to the concurrency cap (default 3, `--concurrency`), each in its own worktree. Merges into the integration branch stay serialized behind a mutex, performed in the single integration worktree. When a task merges, its dependents become ready. In the diamond graph tasks 2 and 3 run at the same time after 1 merges, and 4 starts only after both merged. Covers PRD §6 (single-writer merges), §4 (scheduler) and user stories 1 to 3.

## Context: files to read before implementing

- `PRD.md` §4 (scheduler, default cap 3), §6 (single-writer merges), §7.2, §7.7 (abort stops all running work).
- `src/runner/run.ts`, `src/agents/retry.ts`, `src/state/state.ts`, `src/git/git.ts` from issues 02 and 03.

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

### CREATE `src/scheduler/scheduler.ts`

- **IMPLEMENT**: `runGraph({ tasks, concurrency, runTask, onEvent })`. Maintain `pending`, `running`, `merged`, `failed` sets. Loop: compute ready tasks (all deps merged, not running), start up to `concurrency - running` of them, `await Promise.race` on running ones. `runTask(task)` is the existing per-task pipeline (worktree, agent with retries, merge). If any task rejects with `AbortRunError`: stop launching, abort the shared `AbortController` so the others are killed, wait for them to settle, and rethrow.
- **GOTCHA**: ready tasks must be started in stable id order so tests are deterministic. A graph with no ready task and nothing running but unmerged tasks left is a bug; throw an internal error.

### CREATE `src/git/mutex.ts`

- **IMPLEMENT**: a promise-chain mutex `withMergeLock(fn)`. Use it around `merge` and around every operation on the integration worktree.

### MODIFY `src/runner/run.ts`

- **IMPLEMENT**: call `runGraph` instead of the sequential loop; emit scheduler events (`task:start`, `task:retry`, `task:merged`, `task:failed`) through a typed emitter in `src/runner/events.ts` for the future TUI and logs.
- **GOTCHA**: each task worktree is cut from the integration HEAD at the moment the task starts, so a task started after others merged sees their code (PRD story 3). Do not pre-create worktrees for pending tasks.

### CREATE tests `src/scheduler/scheduler.test.ts`

- **IMPLEMENT**: unit tests with a fake `runTask` that records start/end timestamps: diamond (2 and 3 overlap in time, 4 starts after both), concurrency 1 (never overlaps), cap respected with 5 independent tasks and concurrency 2, failure of one task aborts the others. Plus one integration test in a temp repo asserting task 4's worktree contains the files from tasks 2 and 3.


## Acceptance criteria

- [ ] On the diamond graph with the fake provider, tasks 2 and 3 run concurrently (their windows overlap) and task 4 starts after both merged
- [ ] No more than `--concurrency` tasks ever run at once
- [ ] Merges never interleave (the mutex serializes them), the integration branch history is linear plus merge commits
- [ ] When one task exhausts its retries, running agents are terminated, state is saved and the run exits 2
- [ ] Task 4's worktree contains the code of tasks 2 and 3

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 02-run-one-task-end-to-end-with-a-fake-provider.md — the per-task pipeline being scheduled.
- 03-retry-wrapper-and-abort-path.md — retries and the shared abort path.
