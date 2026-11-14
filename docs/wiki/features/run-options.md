# Run options in Start run, and one-run config overrides (KAN-89)

## Summary

graph-manager's **Start run** drawer has a control for every run option: human review, merge, model, concurrency, attempts, fix passes, validation rounds, when to validate, parallel validation and the idle timeout. There is also an **Extra arguments** field. The choices are remembered per workspace on the server. The engine gets one flag per config key, so a single run can override `graph-execution.config.json` without touching the file. The overrides are saved in `state.json`, and `--resume` keeps them.

- Spec: `docs/prd/done/run-options.md`.
- Tasks: `.agents/tasks/run-options/`, built in suite `suite-20261107-153515-d7da`.
- User docs: the Configuration section of `packages/graph-execution/README.md`, and the Start run part of `apps/graph-manager/README.md`.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| One engine flag per config key: `--attempts`, `--fix-passes`, `--validation-rounds`, `--validate-at`, `--[no-]validate-parallel` and `--idle-timeout`. There is no generic `--set key=value`. | Same style as `--concurrency`, with typed parsing and `--help` text. | KAN-89 |
| Flags override the config. Only the flags given are saved in `state.overrides`, and resume merges them over the config file. | Writing values into the config file would change its hash, and the hash guards `--resume`. | KAN-89 |
| `--resume` refuses the new flags, exit 2: `cannot change <flag> on --resume`. | A run keeps the options it started with. | KAN-89 |
| An option left at "Repo default" sends no flag. | The repo's config, or the engine default, decides, as before. | KAN-89 |
| The server builds the arguments in a fixed order: tasks folder, `--spec`, `--provider`, the option flags, the extra arguments, then `--web` last. The drawer's preview uses the same order. | The preview shows exactly what runs. | KAN-89 |
| Extra arguments are split with the engine's shell-style `splitArgs`. The flags graph-manager sets itself are refused with 400: `--web`, `--web-serve`, `--resume`, `--run`, `--spec`, `--provider`, `--sandbox`, `--reviewers`, `--help` and `--version`. | An escape hatch that can't break the launch. `--help` and `--version` would exit without starting a run. `--sandbox` and `--reviewers` are added by the other two features of the suite. | KAN-89 |
| The choices are saved per workspace in the store (`runDefaults`; `graph-manager.json` before the database store) after a successful start, and prefill the drawer. The provider falls back to `localStorage` (`gm.provider`). | The user chose per workspace. The server is the source of truth for every browser. | KAN-89 |
| `runDefaults.options` is stored loosely, and the drawer cleans the values when it loads them. | A file written by another version can't stop the server from starting. | KAN-89 |
| Resume and Retry take no options. `setup`, `validate`, `keepRuns`, `loopDetection` and `e2eReview` get no toggle. | They reuse the run's options, or they are repo-specific command lists and cleanup settings. | KAN-89 |

## Known follow-ups

These are minor findings from the feature's review that were left open:

- **F1:** loading the saved defaults can overwrite fields the user has already started editing, when the fetch is slow.
- **F3:** the new flags are root options, and `graph-execution --attempts 1 suite …` silently ignores them. Suites were a non-goal.
- **F4:** for quoted extra arguments, the preview shows the text as typed while the server spawns the split words. The two are equivalent but look different.
- **T1:** the "starts a fake run with human review" test in `apps/graph-manager/src/server/routes/runs.test.ts` can time out when it runs after the other tests in that file. It passes on its own.
- **T2:** a 400 for the extra arguments shows at the drawer's general error spot, which can be scrolled out of view.

## Code references

- `packages/graph-execution/src/cli.ts`: the new flags.
- `packages/graph-execution/src/config/config.ts`: merging overrides over the config.
- `packages/graph-execution/src/launch/preflight.ts`: the resume refusal.
- `packages/graph-execution/src/state/state.ts`: `overrides` in the run state.
- `apps/graph-manager/src/server/runoptions.ts`, `apps/graph-manager/src/server/splitargs.ts`, `apps/graph-manager/src/server/routes/runs.ts`: the start body, the arguments, the reserved flags, and `GET /api/workspaces/:id/run-defaults`.
- `apps/graph-manager/src/server/store.ts`: `runDefaults`.
- `apps/graph-manager/src/web/runOptions.ts`, `apps/graph-manager/src/web/pages/StartRunDrawer.tsx`: the Options section and the command preview.

## Related

- [Reviewers from the UI (KAN-87)](ui-reviewers.md)
- [Sandboxed runs (KAN-88)](sandboxes.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-07
