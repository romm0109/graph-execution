# 07. AI merge conflict resolver

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

When merging a finished task branch into the integration branch produces conflicts, a resolver agent (same provider) is invoked in the integration worktree with the list of conflicted files and the instruction to resolve them and complete the merge commit. Up to 3 attempts. Success requires: no conflict markers left, no unmerged paths, and the merge commit created. After 3 failures the run aborts with exit code 2. Covers PRD §4, §7.3 and §7.7.

## Context: files to read before implementing

- `PRD.md` §7.3 (resolver invoked only on conflicts), §7.7 (3 attempts, conflict markers left counts as a failure).
- `src/git/git.ts` (`merge` returns the conflicted file list), `src/git/mutex.ts`, `src/scheduler/scheduler.ts`, `src/agents/retry.ts` from issues 02, 03, 05.

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

### CREATE `src/agents/resolver.ts`

- **IMPLEMENT**: `resolveConflicts({ provider, integrationWorktree, branch, files })`. Prompt: names the branch being merged, lists the conflicted files, and instructs the agent to resolve every conflict, `git add` the files and run `git commit --no-edit` to finish the merge. Success check: `git diff --name-only --diff-filter=U` is empty, no file in the list contains `<<<<<<<`/`>>>>>>>` markers, and `HEAD` is a merge commit whose second parent is the task branch tip. On a failed attempt run `git merge --abort` and re-run the merge so each attempt starts from the same conflicted state.
- **GOTCHA**: runs under `withMergeLock`; the whole resolve-or-abort sequence is one critical section. Use the `'conflict_markers'` failure class from `src/agents/retry.ts`.

### MODIFY the merge step in `src/runner/run.ts`

- **IMPLEMENT**: on `{ok:false, conflicted}` from `merge`, call the resolver; record `mergeCommit` in state afterwards.

### CREATE tests

- **IMPLEMENT**: in a temp repo make tasks 2 and 3 (both depending on 1) edit the same line of the same file via fake scripts; the resolver script writes a merged file and commits. Assert the final branch has the merged content, a resolver script that leaves markers is retried, and three failures exit 2 with the conflicted worktree kept.


## Acceptance criteria

- [ ] Two parallel tasks that edit the same line merge successfully through the resolver
- [ ] A resolver that leaves conflict markers or unmerged paths is retried, up to 3 attempts
- [ ] After 3 failed attempts the run exits 2, state and worktrees are kept
- [ ] Without conflicts the resolver is never invoked (assert zero resolver calls on the diamond graph)
- [ ] The merge lock is held for the entire resolution

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 03-retry-wrapper-and-abort-path.md
- 05-parallel-scheduler-with-concurrency-cap.md — parallel tasks are what produce conflicts.
