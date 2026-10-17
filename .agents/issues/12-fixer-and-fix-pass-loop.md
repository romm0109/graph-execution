# 12. Fixer and fix-pass loop

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Close the review loop. After the reviews, if any open blocker or major finding exists, the fixer agent (in the integration worktree, same provider) receives both reports and the spec and commits fixes; the validation gate then runs (up to 3 validation rounds that do not consume a fix pass); then both reviewers run again. The loop is: review, then up to 3 fix passes each followed by a re-review (at most 4 reviews). It ends clean as soon as a review has zero open blockers/majors (exit 0). If the final re-review still has any, exit with code 1, keeping branch, worktrees and reports. Minors never trigger another pass and go to the final report. From round 1, reviewers first verify the previous round's findings. Covers PRD §7.6 and user story 6.

## Context: files to read before implementing

- `PRD.md` §7.5 (rounds 2+ rules), §7.6 (fixer, loop definition, exit code 1), §7.7 (retries), §7.4 (validation gate), §11.
- `src/review/phase.ts`, `src/agents/reviewer.ts`, `src/agents/tester.ts`, `src/review/report.ts`, `src/validate/commands.ts` from issues 06, 10, 11.

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

### CREATE `src/agents/fixer.ts`

- **IMPLEMENT**: `runFixer({ round, reports, specText, integrationWorktree })`: prompt contains the spec, both reports (open blocker/major findings first, minors listed as lower priority), and the instruction to fix them consistently with the spec, run the project's checks, and commit. It cannot decline a finding. Runs in the integration worktree via `withRetries` (check: a new commit exists). Persist the commit summary (`git log -1 --format=%B`) for the next round's reviewers.
- **GOTCHA**: the fixer works in the integration worktree itself; no other agent may be running then (reviewers are finished). Hold the integration lock.

### MODIFY `src/review/phase.ts`

- **IMPLEMENT**: implement the loop exactly as described. Inside each fix pass: fixer, then validation gate (on failure, feed the output back to the fixer, up to `validationRounds`, then abort exit 2). Count open blocker/major across both reports (`status === 'open'`). Pass `previousReport` and `fixerSummary` into the reviewer context for rounds 1 to 3 (update `buildReviewerContext`). Exit codes: 0 clean, 1 after the 3rd fix pass still not clean.
- **GOTCHA**: the number of fix passes comes from `config.fixPasses` (default 3); validation fix rounds from `config.validationRounds`. Minors alone must end the loop clean. A reviewer marking a previous finding `fixed` must not count it as open.

### CREATE `src/review/phase.test.ts`

- **IMPLEMENT**: scripted fake reviewers/fixer: (a) clean first review → no fixer call, exit 0; (b) blocker, fixer fixes, clean re-review → exit 0 after one pass; (c) never-clean → 3 fixer calls, 4 reviews, exit 1; (d) only minors → exit 0; (e) validation fails after fixer, fixed in a validation round, no fix pass consumed; (f) round 2 prompts contain the previous report and fixer summary.


## Acceptance criteria

- [ ] A clean first review ends the run with exit 0 and no fixer call
- [ ] A blocker triggers the fixer, the validation gate, then a re-review; clean → exit 0
- [ ] Never-clean runs perform exactly 3 fix passes and 4 reviews, then exit 1 with branch, reports and worktrees kept
- [ ] Minor-only findings never trigger a fix pass and are present in the final report data
- [ ] Validation rounds after a fix do not consume a fix pass; exhausting them exits 2
- [ ] The fixer prompt includes the spec and both reports; rounds 2+ reviewer prompts include the previous report and fixer commit summary

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 10-review-phase-with-the-code-reviewer.md
- 11-live-tester.md
