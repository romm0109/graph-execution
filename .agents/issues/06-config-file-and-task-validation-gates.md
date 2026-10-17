# 06. Config file and task validation gates

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Add `graph-execution.config.json` support and the deterministic validation gate. `setup` commands run once in every new task worktree before the agent starts. After a task agent commits, the `validate` commands run directly in the worktree (no AI); on failure the truncated output is fed back to the same agent as a new prompt and the commands run again, for up to 3 rounds, otherwise the run aborts. A task can override with `validate: [...]`, `false` (skip) or `null`/absent (use config). Covers PRD §7.4, §9 configuration and user story 4.

## Context: files to read before implementing

- `PRD.md` §7.1 (per-task `validate`), §7.2, §7.4 (gates, truncation, feedback), §9 (config keys and defaults), §11.
- `src/runner/run.ts`, `src/agents/retry.ts`, `src/graph/task.ts` from issues 01 to 03.

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

### CREATE `src/config/config.ts`

- **IMPLEMENT**: zod schema `{ setup: string[] = [], validate: string[] = [], concurrency?: number, attempts: number = 3, validationRounds: number = 3, fixPasses: number = 3 }`. `loadConfig(repoRoot)` reads `graph-execution.config.json` if present (absent = all defaults, never an error), validates, and returns the result. CLI `--concurrency` overrides the file.
- **GOTCHA**: unknown keys are an error (typos should be caught), invalid JSON is an error with the file path.

### CREATE `src/validate/commands.ts`

- **IMPLEMENT**: `runCommands(commands, cwd)`: run each command with `execa(cmd, {shell: true, cwd, reject: false, all: true})` sequentially; stop at the first failure and return `{ok:false, command, output}` with `output` truncated to the last 200 lines / 8 KB; otherwise `{ok:true}`. Commands come from user config so a shell is used here deliberately.
- **VALIDATE**: `npm test -- src/validate`

### MODIFY the task pipeline in `src/runner/run.ts`

- **IMPLEMENT**: after creating each task worktree run `setup`; after a successful agent attempt resolve the effective validate list (task override, else config); run it; on failure call the provider again in the same worktree with a prompt containing the failed command and truncated output plus an instruction to fix and commit; repeat up to `validationRounds`; then throw `AbortRunError` ("validation failed after 3 rounds"). Task status moves `running -> validating -> merging`.
- **GOTCHA**: validation rounds are separate from agent retry attempts (PRD §7.7); a validation fix round does not consume one of the 3 crash retries. The commit-required check applies to fix rounds too.

### CREATE tests

- **IMPLEMENT**: fake script where round 1 leaves a failing `validate` command (`node -e "process.exit(1)"` style via a flag file) and the fix round removes it; assert two provider calls, the second prompt containing the error output; exhaustion → exit 2; `validate: false` skips; setup commands run once per worktree; config absent works.


## Acceptance criteria

- [ ] Without a config file the run works exactly as before
- [ ] `setup` commands run in each task worktree before the agent starts
- [ ] A failing validate command sends its truncated output back to the same agent, which gets up to 3 fix rounds, then the run aborts with exit 2
- [ ] `validate: false` on a task skips the gates for that task; `null` or absent uses the config
- [ ] Validation fix rounds do not consume agent retry attempts
- [ ] Unknown config keys produce a clear error

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 03-retry-wrapper-and-abort-path.md — retry/abort infrastructure the gate reuses.
