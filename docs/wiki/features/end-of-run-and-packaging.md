# End of run and npm packaging

## Summary

Every run ends through `finish(outcome)` in the runner, which maps the outcome to one of the three exit codes. On success all worktrees of the run, the integration one included, are removed after `git worktree prune`, leaving only the branch `graph/<run-id>` and `.graph-execution/<run-id>/` (state, logs, reports). An exhausted review loop (exit 1) and an abort (exit 2) remove nothing.

The package ships only `dist/`, `skills/` and `README.md`. The build cleans `dist/` first and marks `dist/cli.js` executable afterwards.

## Key behavior

- Exit codes are `EXIT_SUCCESS` (0), `EXIT_REVIEW_FAILED` (1) and `EXIT_ABORT` (2), typed as `ExitCode` in `src/state/errors.ts`.
- `setExitCode` in `src/cli.ts` is the only place that touches `process.exit`/`process.exitCode`. A test greps the sources to enforce this.
- The success cleanup runs under the merge lock. If it fails, the run takes the abort path, and `--resume` (review phase `done`) finishes the cleanup.
- `prepublishOnly` runs typecheck, lint, tests and build.

## Code references

- `src/runner/run.ts`: `finish`, `Outcome`, and where `execute` calls them.
- `src/state/errors.ts`: exit-code constants and the `ExitCode` type.
- `src/cli.ts`: `setExitCode`.
- `src/e2e.test.ts`: packs the tarball and runs its bin through the clean and never-clean flows, plus the exit-code grep.
- `package.json`: `files`, `bin`, `prebuild`/`postbuild`, `prepublishOnly`.
- `README.md`: user documentation and the manual real-provider smoke checklist.

## Related

- [Project wiki index](../index.md)
- [Review-phase terminal UI](review-phase-terminal-ui.md)

## Last updated

2026-10-17
