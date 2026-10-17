# 15. Terminal UI for the review phase

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Extend the TUI to the review phase: a phase bar (tasks, validate, review, fixer, with `fix pass N/3`), nodes for the code reviewer, the live tester and the fixer with the same status/retry rendering and log focus as task nodes, and a final summary screen (branch name, exit status, counts by severity, minors, tester notes, next steps incl. how to merge or resume). Covers PRD §7.9 and §7.11 end-of-run summary.

## Context: files to read before implementing

- `PRD.md` §7.9 (phase bar, final summary), §7.11 (end of run: branch, minors, next steps, exit codes), §7.5/§7.6 (what reviewers and fixer produce).
- `src/ui/*` from issue 14, `src/review/phase.ts` from issue 12, `src/review/report.ts` (`renderMarkdown`).

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

### MODIFY `src/review/phase.ts` and `src/runner/events.ts`

- **IMPLEMENT**: emit `phase:change`, `review:start/end` (round), `fix:start/end` (pass N), and agent output/retry events for `reviewer`, `tester` and `fixer` labels.

### CREATE/MODIFY `src/ui/PhaseBar.tsx`, `src/ui/Graph.tsx`, `src/ui/Summary.tsx`

- **IMPLEMENT**: phase bar highlighting the current phase with `fix pass N/3` when relevant; a row of review nodes (code reviewer, live tester) and a fixer node under the graph, using the same node component and focus mechanism; `Summary` shown after the run with branch `graph/<run-id>`, exit status text, findings table by severity (from the last reports), minors list, tester notes, and the next-step hints (`git log graph/<run-id>`, merge suggestion, or `graph-execution --resume --run <id>` after an abort/exit 1).
- **GOTCHA**: the plain (non-TTY) logger needs the same phase events.

### CREATE tests

- **IMPLEMENT**: render tests for each phase, `fix pass 2/3`, summary content for exit 0, 1 and 2 scenarios.


## Acceptance criteria

- [ ] The phase bar reflects tasks → validate → review → fixer and the current fix pass
- [ ] Reviewer and fixer nodes show state and retry counts and their output can be focused
- [ ] The final summary shows the branch, severity counts, minors, tester notes and correct next steps for exit codes 0, 1 and 2
- [ ] Non-TTY mode prints the same phase changes as plain lines

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 12-fixer-and-fix-pass-loop.md
- 14-terminal-ui-for-the-task-phase.md
