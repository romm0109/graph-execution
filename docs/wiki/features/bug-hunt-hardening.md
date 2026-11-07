# Bug-hunt hardening (GE-01 … GE-13)

## Summary

Fixes for the 13 Linux/macOS bugs reproduced against `main` `dd6f53a` (Jira KAN-62 … KAN-74): interrupts and killed runs no longer leave processes behind, hung agents time out, exit codes are honest, startup checks catch broken environments, and CI guards the release gate. Spec: `docs/prd/bug-hunt-ge-01-13.md`. Tasks: `.agents/tasks/bug-hunt/`. User docs: README sections Requirements, Configuration (`idleTimeoutMinutes`), Exit codes, Resume, Cleaning up runs and Safety.

## Decisions

| Decision | Why | Ticket |
|---|---|---|
| `setup` / `validate` commands run detached in their own process group and are stopped with the shared `killTree` from `packages/graph-execution/src/providers/spawn.ts`, not execa's `cancelSignal`. | `cancelSignal` with `shell: true` killed only the shell; the command was reparented to PID 1. Reusing the agents' tree-kill keeps one way of stopping processes. | KAN-62 |
| `interrupted` in `run.ts` is a hoisted function declaration. | It was a `const` defined after a `try/finally` that always returns, so it was never initialized when setup/validate called it. | KAN-63 |
| Identity is checked by asking git (`git var GIT_AUTHOR_IDENT` and `GIT_COMMITTER_IDENT`), and both are required. | Git's own resolution covers global/local config and the `GIT_*` env vars; setting only `GIT_AUTHOR_*` still leaves the committer unknown. | KAN-64 |
| Leftover task worktrees are **refused** with cleanup commands, not reclaimed. Only registrations whose directory is gone are pruned. | A leftover worktree can be anywhere on disk and may hold the user's uncommitted work; deleting it automatically could lose that. | KAN-70 |
| `--resume` refuses runs whose status is `applied` or `done` (`UsageError`, exit 2). The check lives in `preflightResume`, mirroring the suite's check in `packages/graph-execution/src/suite/orchestrator.ts`. | Preflight covers `--resume`, `--resume --web` and `resume()` in one place; `packages/graph-execution/src/state/resume.ts` only locates the run. | KAN-65 |
| A failed final apply is an `AbortRunError` (exit 2, status `failed`); resume retries only the apply. | Scripts and CI read the exit code; "Not applied" with exit 0 looked like success. | KAN-69 |
| A result deliberately **not** applied because the code review was not performed still exits 0. | Unchanged, documented behaviour that `run-apply.test.ts` asserts; it is a choice, not a failure. Revisit if CI users want it nonzero. | KAN-69 |
| Timeout is an **idle** timeout, `idleTimeoutMinutes`, default 20, `0` = off, fractions allowed; config key only, no CLI flag. The summarizer also has a hard 5-minute cap. | Silence, not total time, signals a hang; long but busy agents must not be killed. Config keys like `attempts` have no flag either. The hard cap stops a hung summarizer from blocking `summaries.drain()` at the end of a run. Ported from `feat/multi-branch` `packages/graph-execution/src/agents/idle.ts`. | KAN-66 |
| An idle stop is a failed attempt of class `idle`, retried through `withRetries` like the tool-call loop detector. | Reuses the existing retry plumbing; the next attempt is told why. | KAN-66 |
| Provider output lines are capped at `MAX_LINE_CHARS` = 1 Mi characters (marker `[truncated N characters]`); the failure-summary log tail reads only the last 64 KiB (`LOG_TAIL_BYTES`). | One line without a newline grew memory without bound, and summaries re-read the whole log every attempt. | KAN-73 |
| Each agent's pid, pgid, start time, command and owner pid/start time are written to `<runDir>/pids/<pid>.json`; `--resume`, `suite --resume` and `clean` kill recorded groups whose owner is dead. The start time is compared before killing; records owned by the current process are never reaped. Windows is best effort. | SIGKILL / OOM gives the CLI no chance to clean up, so the cleanup has to happen on the next start. Comparing start times prevents killing a reused pid; skipping our own records protects in-process Retry. No state-schema change: `reconcile` already resets running tasks. | KAN-67 |
| The suite page sends `offsets=` (positional, per label) on its log stream; the server subscribes from them. Missing or invalid offsets fall back to the current size. | Same approach the run page already used; `LogTail` and the client's `mergeTail` already supported it. | KAN-71 |
| `GRAPH_EXECUTION_*_ARGS` use one shared `splitArgs` (`packages/graph-execution/src/providers/args.ts`) with shell-style quoting, no expansion, and no new dependency. Unterminated quotes fail at startup. | All 4 providers had the same naive `split(/\s+/)`; failing early beats passing a broken argv to a billed CLI. | KAN-72 |
| The run lock is non-reentrant within one process (`LockError`), reserved synchronously before any `await`; each acquisition writes a random token (`<pid>\n<token>\n`) and release only unlinks a matching token. Old `<pid>\n` files are still read. | Embedders could acquire twice and the first release deleted the second holder's lock. Reading only the first line keeps old lock files compatible. | KAN-74 |
| CI is `.github/workflows/qa.yml` (ubuntu + macos, Node 22: `npm ci`, typecheck, lint, test), ported from `feat/multi-branch` **without** the `packages/graph-execution/scripts/qa/smoke.sh` step. `packages/graph-execution/src/ci-workflow.test.ts` fails if a workflow references a missing `packages/graph-execution/scripts/` path. | `smoke.sh` and its helpers don't exist on `main` and check features `main` doesn't have. | KAN-68 |
| The 2 flaky tests were fixed in the tests, not the product: `process.exitCode = 1` instead of `process.exit(1)` in a fixture, and `appendFile` instead of the truncating `writeFile`. | `process.exit` dropped unflushed stdout; truncating a log makes `LogTail` rewind to offset 0, which isn't what a real log does. | KAN-68 |
| Windows-only bugs GE-14 … GE-17 (KAN-75 … KAN-78) are out of scope. | Found by reading the code, not reproduced; no Windows machine to verify fixes. | — |

## Known follow-ups

All three (claude-not-on-PATH test, contradictory `clean` output, logtail second subscriber) and GE-14 … GE-17 are fixed: see [pre-release fixes](pre-release-windows-and-hygiene.md).

## Code references

- `packages/graph-execution/src/validate/commands.ts`, `packages/graph-execution/src/providers/spawn.ts` — process groups, `killTree`, `capLines`.
- `packages/graph-execution/src/runner/run.ts` — `interrupted`, apply abort, idle wiring.
- `packages/graph-execution/src/agents/idle.ts`, `packages/graph-execution/src/agents/retry.ts`, `packages/graph-execution/src/agents/summarizer.ts` — idle timeout, `idle` failure class, summarizer cap and log tail.
- `packages/graph-execution/src/state/processes.ts` — pid records and `reapOrphans`.
- `packages/graph-execution/src/launch/preflight.ts`, `packages/graph-execution/src/git/git.ts` — identity and leftover-worktree checks, finished-run refusal.
- `packages/graph-execution/src/state/state.ts` — run lock.
- `packages/graph-execution/src/providers/args.ts` — `splitArgs`.
- `packages/graph-execution/src/suite/server.ts`, `packages/graph-execution/src/web/assets/suitepage.js` — log offsets.
- `.github/workflows/qa.yml`, `packages/graph-execution/src/ci-workflow.test.ts` — CI.

## Related

- [Project wiki index](../index.md)
- [End of run and npm packaging](end-of-run-and-packaging.md)

## Last updated

2026-11-06
