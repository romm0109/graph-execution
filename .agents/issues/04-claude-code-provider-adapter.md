# 04. Claude Code provider adapter

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Add the real `claude` provider: it spawns the Claude Code CLI headlessly in full-auto mode with the worktree as its working directory, streams its output as `AgentEvent`s, and reports its exit code. The adapter is built against Claude Code's documented non-interactive flags and verified in automated tests with a fake `claude` executable placed on PATH; the real-login smoke test is done by the user at the end. Adapter shape and tests become the template for the Codex and OpenCode adapters. Covers PRD §6 (provider interface) and §9 (full-auto, no stored credentials).

## Context: files to read before implementing

- `PRD.md` §6 (provider interface and adapter mapping), §9 (provider auth relies on the user's existing CLI login, startup warning, not a sandbox), §7.10 (`--provider`, `--model`).
- `src/providers/types.ts`, `src/providers/fake.ts` from issue 02 — the interface to implement and the registry to extend.
- Run `claude --help` if the CLI is installed in your environment to confirm flag names before coding; the flags below are the intended mapping.

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

### CREATE `src/providers/claude.ts`

- **IMPLEMENT**: `claudeProvider: Provider`. Spawn with execa: `claude -p <prompt> --dangerously-skip-permissions --output-format stream-json --verbose [--model <m>]` with `cwd` set to the worktree, stdin closed, `signal` wired to kill the child. Parse stdout line by line; for each JSON line emit `{type:'output', text}` using the assistant text content when present, otherwise the raw line. Emit `{type:'exit', code}` at the end. A spawn error (e.g. ENOENT) rejects `done` with a clear message.
- **GOTCHA**: build a single args array; never pass the prompt through a shell. Do not set or read any API key; rely on the user's existing login. Extra flags from env `GRAPH_EXECUTION_CLAUDE_ARGS` (space-split) are appended so the user can adjust without code changes.

### CREATE `src/providers/index.ts`

- **IMPLEMENT**: `getProvider(name)` returning claude, fake (hidden), or throwing a clear error for names not yet implemented. Extend the startup check so `--provider claude` fails fast with exit 2 if `claude` is not on the PATH (`which`-style lookup through execa).

### CREATE test helpers and `src/providers/claude.test.ts`

- **IMPLEMENT**: write a tiny executable script `claude` into a temp dir (prints two stream-json lines, accepts and records its argv to a file, exits with a code taken from env) and prepend that dir to `PATH`. Assert the argv, cwd, event stream, exit code, abort (kills the child), and the ENOENT path.


## Acceptance criteria

- [ ] With a fake `claude` on PATH, the provider is invoked with `-p`, `--dangerously-skip-permissions` and the worktree as cwd, and its output arrives as events
- [ ] Non-zero exit codes surface in `done`; aborting the signal kills the child process
- [ ] `--provider claude` without the CLI on PATH exits 2 at startup with a clear message
- [ ] No credentials are read, stored or logged
- [ ] The adapter pattern (args builder, line parser, registry entry) is documented in a short comment block at the top of `claude.ts` for the next two adapters

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 02-run-one-task-end-to-end-with-a-fake-provider.md — provides the provider interface, registry and startup check this slice extends.
