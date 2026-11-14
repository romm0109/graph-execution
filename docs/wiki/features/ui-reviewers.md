# Reviewers from the UI (KAN-87)

## Summary

The review loop no longer runs a fixed pair of agents. The engine loads a list of reviewers from a file, given with `--reviewers <file>` or `GRAPH_EXECUTION_REVIEWERS`. Each reviewer has:

- general **instructions**;
- its own **repo file** at the repo root with that repo's rules;
- optional `files` globs;
- a `blockAt` level;
- an optional provider and model.

graph-manager has a **Reviewers** page to add, edit, disable, reset and delete reviewers. It writes the enabled ones to `<dataDir>/reviewers.json` and sets `GRAPH_EXECUTION_REVIEWERS` for **Start run** and for terminals, so every run started from graph-manager uses them, in any repo. Without a reviewers file, the engine runs today's code reviewer and live tester exactly as before.

- Spec: `docs/prd/done/ui-reviewers.md`.
- Tasks: `.agents/tasks/ui-reviewers/`, built in suite `suite-20261107-153515-d7da`.
- User docs: the review sections of `packages/graph-execution/README.md`, and the Reviewers part of `apps/graph-manager/README.md`.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| Reviewers are one global set, with no per-workspace on/off. | The user asked for it: whatever repo runs, it uses the reviewers from the UI. | KAN-87 |
| Every reviewer has two layers: instructions in the UI, plus a `repoFile` at the repo root. `code` uses `REVIEW.md` and `tester` uses `TESTING.md`. A new reviewer names its own file, prefilled as `<ID>_REVIEW.md`. Each reviewer gets only its own file. A missing file only logs `no <file> at the repo root`. | The user asked for the same behaviour the code reviewer and the tester already had. The prefill avoids names like `SECURITY.md`, which GitHub already uses. | KAN-87 |
| graph-manager passes the file with `GRAPH_EXECUTION_REVIEWERS`. The env var is set for Start run and in the terminal env. | The launcher already forwards every `GRAPH_EXECUTION_*` variable to the detached run, so runs typed in a terminal get it too. | KAN-87 |
| The file is copied into the run dir at start, and its hash joins the run's input hashes. `--resume` ignores the env var and reads the copy. | Editing reviewers in the UI must not change a run that is going, or break its resume. | KAN-87 |
| There are two reviewer types. A `diff` reviewer gets the diff. The built-in `tester` boots the app and checks the test plan; it can be edited and disabled but not deleted. `code` is a `diff` reviewer that can be edited, disabled or deleted. | Only the tester has special behaviour. | KAN-87 |
| The UI edits only the instructions. The engine keeps the fixed frame: the report path, the JSON shape, the finding rules, previous-round verification and comment verdicts. | A user's prompt can't break the report contract that the fixer and the summary parse. | KAN-87 |
| `blockAt` can be `major` (the default, as before), `blocker` (only blockers start a fix pass) or `never` (every finding is reported as minor). | "The lowest severity that blocks", from the discussion. | KAN-87 |
| Finding ids of reviewers other than `code` and `tester` are prefixed with the reviewer id (`security-F1`). | Ids weren't namespaced, so two reviewers could both report `F1`. | KAN-87 |
| Each reviewer can have its own provider and model, falling back to the run's. Every provider in use is checked on `PATH` at startup. | A missing CLI must fail at startup, not mid-review. | KAN-87 |
| Human review comments go to `code` if it is enabled, otherwise to the first enabled `diff` reviewer. | Exactly one reviewer must answer each comment. | KAN-87 |
| The ids `code` and `tester` keep today's node ids, titles, log strings and "not performed" texts. These ids are reserved: `reviewer`, `fixer`, `gate`, `gate-fixer`, `merge`, `human` and `validate`. | The default path must stay unchanged, and reviewer node ids must not clash with existing nodes. | KAN-87 |
| graph-manager writes only the enabled reviewers to `reviewers.json`, and validates them with the engine's own schema (exported from `graph-execution/api`). | The UI and the engine accept the same reviewers, and a run's copy equals the UI's enabled list. | KAN-87 |
| Suite feature runs get `GRAPH_EXECUTION_REVIEWERS=""` and keep the built-in reviewers. | Suites were a non-goal. | KAN-87 |
| A new test hook, `GRAPH_EXECUTION_FAKE_PROMPTS=<dir>`, makes the fake provider write every prompt to a file. | Lets tests and the live tester check which repo file each reviewer received. | KAN-87 |

## Known follow-ups

These are minor findings from the feature's review that were left open:

- **F1:** with `blockAt: "blocker"`, a reviewer's major findings are in neither the open list nor the minor list of the summary. They show only as a count.
- **F2:** `commentOutcomes` looks for the comment verdicts in the first report, in file order, that has a `comments` array. That isn't the same rule `reviewRound` uses to pick the reviewer that answers comments.
- Reviewers for suites, and for the suite's end-to-end phase.
- Per-reviewer statistics: how often its findings get fixed or dismissed.

## Code references

- `packages/graph-execution/src/review/reviewers.ts`: the schema, `BUILTIN_REVIEWERS` and the glob matcher.
- `packages/graph-execution/src/review/phase.ts`: the review round driven by the list.
- `packages/graph-execution/src/review/report.ts`: `blockAt` and id prefixes.
- `packages/graph-execution/src/review/context.ts`: each reviewer's `repoFile`.
- `packages/graph-execution/src/agents/reviewer.ts`, `packages/graph-execution/src/agents/tester.ts`, `packages/graph-execution/src/agents/fixer.ts`: the prompts and reviewer names.
- `packages/graph-execution/src/runner/nodes.ts`, `packages/graph-execution/src/runner/run.ts`, `packages/graph-execution/src/ui/store.ts`, `packages/graph-execution/src/web/logtail.ts`, `packages/graph-execution/src/web/assets/logs.js`: one node per reviewer, retry and log labels.
- `packages/graph-execution/src/providers/fake.ts`: `GRAPH_EXECUTION_FAKE_PROMPTS`.
- `apps/graph-manager/src/server/reviewers.ts`, `apps/graph-manager/src/server/routes/reviewers.ts`: storage, `/api/reviewers` and `reviewers.json`.
- `apps/graph-manager/src/server/routes/runs.ts`, `apps/graph-manager/src/server/terminals.ts`: the env var.
- `apps/graph-manager/src/web/pages/Reviewers.tsx`, `apps/graph-manager/src/web/reviewers.ts`: the Reviewers page (`g v`).
- `apps/graph-manager/src/server/viewcache.ts`, `apps/graph-manager/src/web/pages/PhaseCards.tsx`: every reviewer on the run detail page.

## Related

- [Run options in Start run (KAN-89)](run-options.md)
- [Sandboxed runs (KAN-88)](sandboxes.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-07
