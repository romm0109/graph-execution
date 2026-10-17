# Validation gates and the readme command

## Summary

`config.validate` runs at three points: after each task in its own worktree, once on the integration branch after every task is merged (the gate before review round 0), and after each review fix pass. `config.validateAt` picks the task-phase behavior. `"task"` (default) runs all three. `"end"` skips the per-task gate entirely, ignoring task files' own `validate` lists too.

In both modes a failing gate before round 0 goes to the fixer (`runFixer` with `round: 0`, no reports, and the failing output) for up to `validationRounds` rounds. Then the gate runs again, and the run aborts only if it still fails after those rounds. It used to abort at once, which broke on tasks that pass alone but not merged together.

`graph-execution readme` opens `dist/README.html` in the default browser. `npm run build` renders that file from `README.md` with `marked`, which is a devDependency only, so no renderer ships. If no browser opens, the command prints the file's path. `--print` writes the markdown to stdout.

## Key behavior

- Gate-fixer labels are `fix-r0-v<N>`, and its summaries go to `reports/round0/`. It emits `agent:*` events as the `gateFixer` review agent. The UI shows that node between `validate` and the reviewers only once its status leaves `pending`.
- Resume: in review phase `validate`, `validationRounds` counts the gate-fix rounds already started. A resume drops uncommitted leftovers, keeps the committed fixes, and validates again before the next round.
- The abort message keeps "failed before the review" and adds "after N fix round(s)" when `validationRounds > 0`.

## Code references

- `src/config/config.ts`: `validateAt`.
- `src/runner/run.ts`: `validate()` returns early for `"end"`.
- `src/review/phase.ts`: `gate()`.
- `src/agents/fixer.ts`: `gateFixerPrompt`, `fixerStep`.
- `src/ui/Graph.tsx`, `src/ui/store.ts`: the `gateFixer` node.
- `src/readme/readme.ts`, `scripts/render-readme.mjs`, `package.json` `postbuild`.

## Related

- [Project wiki index](../index.md)
- [Review-phase terminal UI](review-phase-terminal-ui.md)
- [End of run and npm packaging](end-of-run-and-packaging.md)

## Last updated

2026-10-17
