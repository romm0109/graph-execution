# 16. End of run and npm packaging

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Finish the run lifecycle and make the package publishable. On success (exit 0) all remaining worktrees are removed and only branch `graph/<run-id>` plus `.graph-execution/<run-id>/` (state, logs, reports) remain; on exit 1 and exit 2 everything is kept. Exit codes are 0/1/2 everywhere. Package for npm: `bin`, `files`, a build that produces a runnable `dist/cli.js`, and a README documenting usage, task file format, config, `REVIEW.md`/`TESTING.md`, `--spec`, exit codes, resume, `graph-execution install skills` and the bundled `to-issues` skill, and a real-provider smoke-test checklist for the user. Covers PRD §7.11, §8 packaging and §12 phase 4.

## Context: files to read before implementing

- `PRD.md` §7.11 (end of run), §8 (packaging), §9 (config), §11 (success criteria), §12 phase 4.
- `src/cli.ts`, `src/runner/run.ts`, `src/review/phase.ts`, `package.json` from earlier issues.

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

### MODIFY `src/runner/run.ts`

- **IMPLEMENT**: central `finish(outcome)` returning the exit code: `success` removes all worktrees (including the integration worktree, after `git worktree prune`) and keeps the branch; `exhausted` (exit 1) and `aborted` (exit 2) remove nothing. Make sure the process exit codes are those three values only in every code path (add a test that greps `process.exit(` usage to be centralized).

### MODIFY `package.json`, CREATE `.npmignore` or use `files`

- **IMPLEMENT**: `"files": ["dist", "skills", "README.md"]`, `"bin"`, `"prepublishOnly": "npm run typecheck && npm run lint && npm test && npm run build"`, shebang preserved in `dist/cli.js` with executable bit set by a small postbuild script. `npm pack --dry-run` must list only dist, skills and README.

### CREATE `README.md`

- **IMPLEMENT**: usage (`npx graph-execution ./tasks --spec PRD.md --provider claude`), task file format and example, `graph-execution.config.json` keys and defaults, optional `REVIEW.md`/`TESTING.md`, the review loop (3 fix passes), exit codes, resume, safety notes (full-auto agents, not a sandbox, tool never pushes), and a "Manual smoke test with real providers" checklist for claude, codex and opencode.

### CREATE an end-to-end test `src/e2e.test.ts`

- **IMPLEMENT**: build, then run the packed CLI against a temp repo with the fake provider through the whole flow (tasks → review with a seeded blocker → fix → clean), asserting exit 0, worktrees removed, branch present; then a never-clean scenario asserting exit 1 and everything kept.


## Acceptance criteria

- [ ] After a successful run, no worktrees remain and `graph/<run-id>` exists; the user's branch is untouched
- [ ] Exit codes are exactly 0 (success), 1 (review loop exhausted), 2 (abort/startup failure)
- [ ] `npm pack --dry-run` shows only `dist/`, `skills/` and `README.md`; `npx` of the packed tarball runs `--help`
- [ ] README documents everything listed above, including the manual real-provider smoke checklist
- [ ] The e2e test passes for both the clean and never-clean scenarios

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
npm run build && npm pack --dry-run
```

## Blocked by

- 12-fixer-and-fix-pass-loop.md
- 13-resume-from-saved-state.md
- 17-install-skills-command-and-to-issues-skill.md — the README documents it and the package must ship `skills/`.
