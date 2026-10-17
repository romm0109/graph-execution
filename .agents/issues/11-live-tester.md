# 11. Live tester

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Add the second reviewer: the live tester. It runs in parallel with the code reviewer, each in its own throwaway worktree, and actually exercises the result: it follows `TESTING.md` if the repo root has one (how to boot the app, URLs/endpoints, credentials, checks), otherwise makes a best-effort attempt from the README and package scripts, and uses an available browser automation tool for UIs. It receives the spec, the tasks folder path and the list of changed files (not the diff). If it cannot run the app it records an informational note in its report and the run continues. Covers PRD §7.5.

## Context: files to read before implementing

- `PRD.md` §7.5 (tester behavior, optional `TESTING.md`, informational note when the app cannot run, context rules), §7.7.
- `src/agents/reviewer.ts`, `src/review/report.ts`, `src/review/context.ts`, `src/review/phase.ts` from issue 10 — the tester mirrors the code reviewer.

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

### CREATE `src/agents/tester.ts`

- **IMPLEMENT**: `runLiveTester({ round, ... })` with the same structure as `runCodeReviewer` (detached worktree `review-tester-r<N>`, `setup`, `withRetries`, report validation, finally-remove, head-unchanged check) but with a tester prompt: read `TESTING.md` text if provided; otherwise inspect README and package scripts; boot the app from the worktree, call the API or drive the UI, record findings with a concrete `failureScenario`; if the app cannot be run, add an entry to `notes` ("live test not performed: <reason>") and return zero findings; write `code`-style JSON to `reports/round<N>/tester.json` with `reviewer: 'tester'`. Context: spec, tasks folder path, `TESTING.md` if present, list of changed files (`git diff --name-only <startingCommit>..HEAD`); no diff.
- **GOTCHA**: the app may leave processes running; the prompt must tell the agent to stop anything it started, and the tool kills the process group of the agent on completion. A missing `TESTING.md` is never an error.

### MODIFY `src/review/context.ts` and `src/review/phase.ts`

- **IMPLEMENT**: add `TESTING.md` and changed-files to the context; run code reviewer and tester with `Promise.allSettled`-style handling in parallel (each with its own 3 attempts; only the failing reviewer reruns); check the integration head once after both finish. Combine both reports for the printed summary and carry `notes` into the final summary data.

### CREATE tests

- **IMPLEMENT**: parallel execution (both worktrees exist at the same time), tester note path produces exit 0, `TESTING.md` content reaches the prompt, tester failure retries only the tester, reports for both reviewers exist.


## Acceptance criteria

- [ ] Both reviewers run in parallel in separate throwaway worktrees and both reports exist under `reports/round<N>/`
- [ ] The tester prompt contains the spec, tasks folder path, changed-file list and `TESTING.md` when present, and not the diff
- [ ] Without `TESTING.md` the tester still runs; if it cannot run the app, its report carries an informational note and the run continues
- [ ] Only the failing reviewer is retried when the other succeeded
- [ ] Processes started by the tester are cleaned up when it finishes

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 10-review-phase-with-the-code-reviewer.md
