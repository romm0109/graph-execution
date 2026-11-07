# PRD: Bug-hunt fixes GE-01 … GE-13 (Linux/macOS)

## Problem

A bug hunt against `main` (`dd6f53a`, npm `1.1.0`) reproduced 13 bugs that make graph-execution
unreliable on new machines and unsafe to release: interrupts that leave processes behind, hung
providers that wait forever, exit codes that report success after a failure, and a red release
gate (no CI, 2 failing tests). Jira: KAN-62 … KAN-74.

## Goals

- The release gate is green: `npm test` passes on main and CI runs on push and PR (KAN-68 / GE-07).
- Interrupting a run never leaves child processes behind, and it reports a clean, resumable
  interruption (KAN-62 / GE-01, KAN-63 / GE-02).
- A CLI killed by SIGKILL or the OOM killer leaves nothing that `--resume` or `clean` can't reap
  (KAN-67 / GE-06).
- A hung provider or summarizer times out and counts as a failed attempt; provider output is
  memory-bounded (KAN-66 / GE-05, KAN-73 / GE-12).
- Exit codes are honest: a failed final apply exits nonzero, and `--resume` on a finished run
  refuses instead of applying again (KAN-69 / GE-08, KAN-65 / GE-04).
- Startup fails fast without a git identity, and leftover task worktrees don't break a later run
  (KAN-64 / GE-03, KAN-70 / GE-09).
- The suite web page never loses log bytes (KAN-71 / GE-10).
- `GRAPH_EXECUTION_*_ARGS` respects shell-style quoting (KAN-72 / GE-11).
- The run lock rejects a second acquisition in the same process and release is owner-safe
  (KAN-74 / GE-13).

## Non-goals

- Windows-only bugs GE-14 … GE-17 (KAN-75 … KAN-78): not reproducible here.
- New features (activity line), docs/presence work.

## User stories

1. As a user who presses Ctrl-C during setup or validation, I get exit code 2 and a resume hint,
   and no setup/validate processes keep running.
2. As a user whose machine killed the CLI, `graph-execution --resume` or `clean` stops leftover
   agent processes and I can continue.
3. As a user with a provider that hangs, the attempt times out and is retried, then fails clearly.
4. As a CI script, a run that did not apply its result exits nonzero.
5. As a user resuming a run that already finished, I'm told it finished; nothing is applied twice.
6. As a new user without `git config user.name/email`, I'm told to set it before any task starts.
7. As a user with a leftover task worktree, the next run still works or tells me how to clean up.
8. As a user watching a suite, the web page shows every log byte.
9. As a user passing quoted args via `GRAPH_EXECUTION_CLAUDE_ARGS`, quoted words stay together.
10. As an embedder of the API, acquiring the run lock twice fails instead of silently sharing it.

## Acceptance

Every fix ships with a regression test. `npx tsc --noEmit`, `npx eslint .` and `npm test` pass.
