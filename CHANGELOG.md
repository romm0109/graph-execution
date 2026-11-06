# Changelog

## 1.2.0 (2026-11-06)

### Fixed

- Ctrl-C during setup or validation stops their whole process tree, exits 2 and prints the resume hint (GE-01, GE-02).
- Agents left running by a CLI that was killed (`kill -9`, the OOM killer) are stopped by `--resume`, `suite --resume` and `clean` (GE-06).
- A hung provider or summarizer times out (`idleTimeoutMinutes`, default 20) and counts as a failed attempt; provider output lines are capped (GE-05, GE-12).
- A failed final apply exits 2, and `--resume` on a finished run refuses instead of applying again (GE-04, GE-08).
- Startup fails fast without a git identity or with leftover task worktrees (GE-03, GE-09).
- The suite page and a second browser tab on the run page no longer lose log text (GE-10).
- `GRAPH_EXECUTION_*_ARGS` respect shell-style quoting (GE-11).
- The run lock can't be taken twice in one process, and release is owner-safe (GE-13).
- Windows: leftover processes are killed after an agent exits, the provider CLI is found the way it is spawned, `--web` and `readme` work with spaces in paths, and setup/validate run through a POSIX `sh` (GE-14 … GE-17).
- `clean` no longer reports a run as skipped and then deletes it.

### Added

- `--version` / `-v` (GE-18).
- Config key `idleTimeoutMinutes`.
- `GRAPH_EXECUTION_SHELL` (Windows) to choose the shell for setup/validate.
- MIT `LICENSE`, and links from the npm page to GitHub.

### Changed

- A run whose final apply fails exits 2 instead of 0.
- `--resume` on a finished run exits 2.
- Windows: setup/validate commands run through `sh`, not `cmd.exe`. Set `GRAPH_EXECUTION_SHELL=cmd` for the old behaviour.

## 1.1.0

Published to npm from `dd6f53a`.
