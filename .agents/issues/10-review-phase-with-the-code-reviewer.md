# 10. Review phase with the code reviewer

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

After every task has merged, the run enters the review phase. First the validation gate runs on the integration branch (failures go to the fixer path in issue 12; here, a failure aborts with a clear message). Then the code reviewer runs in its own throwaway detached worktree cut from the integration HEAD, with `setup` executed, receiving the spec (full text from `--spec`), the tasks folder path, the diff against the recorded starting commit, and `REVIEW.md` content if the repo root has one. It writes a JSON report to `.graph-execution/<run-id>/reports/round<N>/code.json`; the tool validates it against the report schema, retries on invalid or missing output (3 attempts), deletes the throwaway worktree, and confirms the integration branch head did not move. Covers PRD §7.5 and §9.

## Context: files to read before implementing

- `PRD.md` §7.5 (reviewers never touch the integration worktree, report format, context rules, severity downgrade rule, optional `REVIEW.md`), §7.7, §9 (`--spec`).
- `src/runner/run.ts`, `src/agents/retry.ts`, `src/config/config.ts`, `src/validate/commands.ts`, `src/git/git.ts` (`addDetachedWorktree`) from earlier issues.

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

### CREATE `src/review/report.ts`

- **IMPLEMENT**: zod `reportSchema = { round: number, reviewer: 'code'|'tester', summary?: string, notes?: string[], findings: Finding[] }`, `Finding = { id, severity: 'blocker'|'major'|'minor', file?, line?, description, failureScenario?, suggestedFix?, status: 'open'|'fixed'|'not_fixed' }`. `normalizeReport()` downgrades any blocker/major finding with an empty or missing `failureScenario` to `minor`. `renderMarkdown(report)` for the TUI later.
- **VALIDATE**: `npm test -- src/review/report`

### CREATE `src/review/context.ts`

- **IMPLEMENT**: `buildReviewerContext({ specPath, tasksDir, repoRoot, startingCommit, integrationWorktree })` returns the spec text, the tasks folder path, the diff (`git diff <startingCommit>..HEAD` in the integration worktree), and `REVIEW.md` text if `repoRoot/REVIEW.md` exists (absence is never an error). Files are read by the tool from the user's repo root, not from the throwaway worktree.

### CREATE `src/agents/reviewer.ts`

- **IMPLEMENT**: `runCodeReviewer({ round, ... })`: create a detached worktree `review-code-r<N>` at the integration HEAD, run `setup`, build the prompt (intent = spec; instructions: review the diff for bugs, security and correctness plus `REVIEW.md` rules; every blocker/major needs a concrete `failureScenario`; from round 2 on verify the previous report's findings first and add only new blocker/major findings; write the JSON report to the absolute path given), run via `withRetries` where the check is `existsSync + reportSchema.safeParse`, remove the worktree in a `finally`, then assert `git rev-parse graph/<run-id>` equals the head recorded before the run, otherwise throw `AbortRunError`.
- **GOTCHA**: the report path is OUTSIDE the throwaway worktree. The prompt must say that code files must not be modified. No provider-specific tool blacklists.

### CREATE `src/review/phase.ts` and MODIFY `src/runner/run.ts`

- **IMPLEMENT**: `runReviewPhase()` called after all tasks are merged: gate (`validate` on the integration worktree) then `runCodeReviewer(round 0)`; print finding counts by severity. (The fix loop arrives in issue 12.) Exit 0 if zero open blockers/majors, otherwise exit 1 for now.

### CREATE tests

- **IMPLEMENT**: fake reviewer script writes a valid report / invalid JSON / nothing; assert retries, severity downgrade, the throwaway worktree is gone afterwards, reviewer edits to files in its worktree do not appear on the integration branch, a moved head aborts with exit 2, and a repo without `REVIEW.md` runs fine.


## Acceptance criteria

- [ ] After all tasks merge, a code review report appears at `.graph-execution/<run-id>/reports/round0/code.json` and validates against the schema
- [ ] The reviewer prompt contains the full spec text, the tasks folder path, the diff against the starting commit, and `REVIEW.md` when present
- [ ] A missing `REVIEW.md` is not an error and produces no abort
- [ ] An invalid or missing report is retried up to 3 times, then aborts with exit 2
- [ ] Blocker/major findings without a failure scenario are stored as minor
- [ ] The reviewer's worktree is removed afterwards, and any edit it made never reaches `graph/<run-id>`; a moved branch head aborts the run

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 05-parallel-scheduler-with-concurrency-cap.md — the review phase starts once the scheduler has merged everything.
- 06-config-file-and-task-validation-gates.md — `setup` and the validation runner are reused.
