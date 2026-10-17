# 14. Terminal UI for the task phase

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Render the run live in the terminal with Ink: the task DAG as layers/boxes with per-node state (pending, running with a spinner, retry N/3, validating, merging, merged, failed), a header with run id, provider and elapsed time, and a log tail pane showing the last lines of the focused agent's output, switchable with the arrow keys. Agent output is also always written to `.graph-execution/<run-id>/logs/<label>.log`. The UI subscribes to the scheduler events emitted since issue 05. When stdout is not a TTY, fall back to plain one-line-per-event logging. Covers PRD §7.9 and user story 9.

## Context: files to read before implementing

- `PRD.md` §7.9 (node states, live tail, arrow-key focus), §2 principle 4 (observable), §11 UX goals (no frozen-looking state).
- `src/runner/events.ts`, `src/runner/run.ts`, `src/scheduler/scheduler.ts`, `src/state/state.ts` from issues 02 to 05.

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

### CREATE `src/ui/store.ts`

- **IMPLEMENT**: a small event-sourced view model: subscribes to the runner event emitter and keeps `nodes: Record<id,{status, attempt, label}>`, `phase`, `focus`, and a ring buffer (last 200 lines) per agent label fed by `output` events. Also appends every output line to `logs/<label>.log` (create the folder).

### CREATE Ink components under `src/ui/`

- **IMPLEMENT**: `App.tsx` (header, `<Graph/>`, `<LogTail/>`, footer with key hints), `Graph.tsx` (render `executionLayers` as columns; each node a bordered box colored by status; spinner via `ink-spinner` for running/validating/merging; text `retry 2/3` when attempt > 1), `LogTail.tsx` (last N lines of the focused agent). Arrow keys (`useInput`) move focus between running/finished nodes. Add dependencies `ink`, `react`, `ink-spinner` and `ink-testing-library` (dev); enable JSX in tsconfig.
- **GOTCHA**: ink must be started only when `process.stdout.isTTY`; otherwise register a plain-text subscriber that prints `[time] task 2 running`, `task 2 retry 2/3`, `task 2 merged`. Unmount cleanly on abort so the shell is usable and the abort message is printed after unmount.

### MODIFY `src/runner/run.ts` and `src/cli.ts`

- **IMPLEMENT**: start the UI (or plain logger) before the scheduler; pass the event emitter in.

### CREATE tests

- **IMPLEMENT**: `ink-testing-library` render tests: nodes show the right state text for each status, `retry 2/3` appears, focus changes the log tail content; store test for the ring buffer and log files; plain-mode test with a non-TTY.


## Acceptance criteria

- [ ] During a diamond run the terminal shows all four nodes and their live states, with two running at once and spinners
- [ ] A retrying task shows `retry N/3`
- [ ] The log tail shows the focused agent's latest output and changes with the arrow keys
- [ ] Every agent's full output is in `.graph-execution/<run-id>/logs/`
- [ ] Piped output (non-TTY) prints readable one-line-per-event logs and no escape codes
- [ ] Ctrl+C restores the terminal before the abort message is printed

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Blocked by

- 05-parallel-scheduler-with-concurrency-cap.md — provides the event stream the UI renders.
