# 08. Codex provider adapter

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Add the `codex` provider by following the adapter pattern from the Claude adapter: spawn the `codex` CLI headlessly with the worktree as cwd in its unattended/full-auto mode, stream output as events, report exit code, honor the abort signal, and fail fast at startup when the CLI is missing. Verified with a fake `codex` executable on PATH; the real-login test is done by the user at the end. Covers PRD §6 and §9.

## Context: files to read before implementing

- `PRD.md` §6 (adapter mapping), §9 (existing CLI login, no stored credentials, not a sandbox).
- `src/providers/claude.ts`, `src/providers/claude.test.ts`, `src/providers/index.ts` from issue 04 — copy the structure.
- If `codex --help` / `codex exec --help` / `codex run --help` is available locally, confirm the flag names; the intended mapping is: `codex exec <prompt>` in its full-auto/bypass-approvals mode, with `--model` passed through when given.

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

### CREATE `src/providers/codex.ts`

- **IMPLEMENT**: `codexProvider: Provider` mirroring `claudeProvider`: single args array, cwd = worktree, stdin closed, kill on abort, line-by-line stdout to `output` events (raw text lines are fine if the CLI has no JSON stream), `exit` event with the code, ENOENT turned into a clear message. Env `GRAPH_EXECUTION_CODEX_ARGS` appends extra flags.
- **GOTCHA**: never route the prompt through a shell, never read or store credentials.

### MODIFY `src/providers/index.ts` and the startup provider check

- **IMPLEMENT**: register `codex`; `--provider codex` fails fast with exit 2 if the binary is not on PATH.

### CREATE `src/providers/codex.test.ts`

- **IMPLEMENT**: same fake-executable-on-PATH approach as `claude.test.ts`: assert argv, cwd, events, exit code, abort and ENOENT.


## Acceptance criteria

- [ ] With a fake `codex` on PATH the provider is invoked in unattended mode with the worktree as cwd and output arrives as events
- [ ] Exit codes surface; abort kills the child
- [ ] `--provider codex` without the CLI exits 2 at startup with a clear message
- [ ] The diamond graph runs end to end through this adapter with the fake executable

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 04-claude-code-provider-adapter.md — provides the adapter pattern and registry.
