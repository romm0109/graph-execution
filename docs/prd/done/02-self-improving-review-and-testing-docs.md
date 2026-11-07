# PRD: Self-improving `REVIEW.md` and `TESTING.md` (`improveDocs`)

## 1. Summary

Every run teaches the reviewers something about the project. The live tester finds out how to boot the app, which port it listens on, which seed user to log in with. The code reviewer finds real bugs that the fixer then fixes. Today that knowledge is lost when the run ends, and the next run's tester works it all out again.

With `"improveDocs": true` in the config, the reviewers write down what the docs should have told them. At the end of the run a **curator** agent turns those notes into small, durable edits of `REVIEW.md` and `TESTING.md`. The edits are **never committed and never applied silently**. They land as uncommitted changes next to the run's result, so the user keeps or drops them like any other change.

**Off by default.** With the key missing or `false`, nothing in this PRD happens: no extra prompt text, no curator, no extra cost.

## 2. Goals and non-goals

**Goals**
- Each run makes the next run's tester and reviewer better informed.
- A human approves every change to the docs. Nothing is committed.
- The docs stay short. The curator edits and dedupes, it doesn't append logs.
- Never fails or blocks a run.

**Non-goals**
- Editing `AGENTS.md`, `CLAUDE.md` or other agent instruction files (see §9).
- Learning across runs from history (only the current run's signals are used).
- Edits about this run's feature specifics. The docs describe the project, not one PRD.

## 3. User stories

1. **As a developer, I want the tester's hard-won knowledge of how to boot and exercise my app written into `TESTING.md`, so that the next run's tester starts right away.**
   Example: the tester found that the API needs `docker compose up db` first and listens on 4000, not 3000. `TESTING.md` gets a "Booting" section saying so.
2. **As a developer, I want recurring real bugs turned into review rules, so that the reviewer looks for them every time.**
   Example: two fixed majors were missing `await`s on DB calls. `REVIEW.md` gets "Every repository call returns a promise; flag un-awaited calls."
3. **As a developer, I want to see and decide on these edits before they stick, so that the docs don't drift without my say.**
4. **As a developer who doesn't want any of this, I want it off unless I turn it on.**

## 4. Configuration

```json
{ "improveDocs": true }
```

| Key | Default | Meaning |
|---|---|---|
| `improveDocs` | `false` | Ask the reviewers for doc notes, and run the curator at the end of the review phase to propose edits to `REVIEW.md` and `TESTING.md`. |

Added to `configSchema` (strict object, so the key is validated like the rest). It is part of the config hash, so `--resume` refuses when it was toggled mid-run, as for any config change.

## 5. Behaviour

### 5.1 Collecting signals (only when enabled)

**Report schema.** `reportSchema` gains an optional field:

```ts
/** What REVIEW.md (code reviewer) or TESTING.md (tester) should have said; collected only with improveDocs. */
harnessNotes: z.array(z.string()).optional()
```

`coerceReport` repairs a single string into a one-element array. The field never affects severity, findings or the loop.

**Prompts.** With `improveDocs` on, one extra instruction is added:

- **Live tester**: "In `harnessNotes`, list what you had to work out that `TESTING.md` did not tell you or got wrong: how to install, boot, seed and reach the app; ports and URLs; how to log in; steps that failed and what worked instead. Facts about the project, not about this change. Use env var names for secrets, never their values. Empty if `TESTING.md` was complete."
- **Code reviewer**: "In `harnessNotes`, list project conventions or recurring pitfalls you relied on that `REVIEW.md` does not state, and any `REVIEW.md` rule that is wrong or outdated. Facts about the project, not about this change. Empty if there is nothing to add."

The other signals come from data the run already has:
- blocker or major findings whose final `status` is `fixed` (they were real), from every round;
- report `notes` such as `live test not performed: …`.

### 5.2 The curator step

**When:** once, after the review phase ends with exit code 0 or 1, and before `finish` removes the worktrees and before the result is applied. It doesn't run on an abort (exit 2), or when there are no signals at all: no `harnessNotes`, no fixed blocker or major findings, no notes. In that case the summary says `docs: nothing to improve`.

**Where:** a throwaway detached worktree at the integration head, like the reviewers', so it can look at the code to check a claim. It must not modify that checkout.

**Input (prompt):**
- the current text of `REVIEW.md` and `TESTING.md` exactly as read at startup (`buildReviewerContext`), or "(missing)";
- every report's `harnessNotes`, labelled by reviewer and round;
- the fixed blocker and major findings (id, description, file, failure scenario);
- the report notes;
- rules:
  - Edit, don't append: merge with what is there, remove what is now wrong, and keep the file's structure and voice.
  - Only durable facts about the project. Nothing specific to this run's feature, no finding ids, no dates.
  - At most +40 net lines per file per run. A missing file may be created, up to 60 lines.
  - Never write secret values. Env var names only.
  - Change a file only if there is something worth changing. No edit is a valid outcome.

**Output:** under `.graph-execution/<run-id>/docs/`:
- `REVIEW.md` and/or `TESTING.md`: the full proposed new text, only for files it changes;
- `changes.json`: `{ "files": { "TESTING.md": ["one line per change", …], "REVIEW.md": [...] } }`;
- the tool then writes `<file>.diff` for each changed file (`git diff --no-index` of the old text against the new) for the summary.

**Check (retried with feedback, `attempts` like every agent):**
- `changes.json` parses and matches its schema (same repair-then-strict approach as reports);
- each proposed file listed in `changes.json` exists, and no other file was written;
- the net-growth limit holds;
- the worktree is unchanged (`git status --porcelain` empty).

Each retry is told exactly what was wrong. After the last failed attempt, the step records `docs not improved: <reason>` in the summary and the run continues normally. **The curator can never change the exit code.**

### 5.3 Landing the edits

| Run outcome | What happens to the proposal |
|---|---|
| Exit 0 and the result was applied to the starting branch | The proposed files are written to the repo root in the user's checkout, as uncommitted changes next to the run's result. The previous contents are saved to `docs/before/<file>` (or marked "did not exist"). |
| Exit 0 but not applied (`--no-merge`, code review skipped, apply refused or rolled back, branch switched, detached HEAD) | Nothing is written outside the run dir. The summary points to `docs/` and the `.diff` files. |
| Exit 1 (review exhausted) | Same as "not applied". |

Before writing into the checkout, the tool compares each target file with the text read at startup. If the user changed it during the run, that file is **not** overwritten, and the summary says `REVIEW.md changed during the run; proposed version left in .graph-execution/<id>/docs/REVIEW.md`.

The edits are never staged or committed, and never written to `graph/<run-id>`. The integration branch holds only the run's code.

### 5.4 Summary and drop

The final summary gets a **Docs** section, only when `improveDocs` is on:

```
Docs (improveDocs)
  TESTING.md  +12 −3   · boot needs `docker compose up db` first · API listens on 4000 · seed user via `npm run seed`
  REVIEW.md   +2       · flag un-awaited repository calls
  keep: commit them with the rest   drop: git restore -- TESTING.md REVIEW.md
```

- For a tracked file, the drop command is `git restore -- <file>`. It joins the existing drop command, which already restores the run's files.
- For a file that was untracked or missing before, the drop command is a copy from `docs/before/` or a delete, printed with the same quoting rules the existing drop command uses.
- The run's own file list and line counts stay separate from the docs lines, so the user can tell them apart.

### 5.5 Live view

When enabled, a **docs** node appears between the review loop and **apply**. It shows running, done (`2 files`), skipped (`nothing to improve`) or failed (`not improved`). It is not shown when disabled.

### 5.6 Resume

`state.json` gains an optional `docs: { status: "pending" | "done" | "skipped" | "failed" }`, written before and after the step. On resume, a `done`, `skipped` or `failed` step is not run again, and the proposal in `docs/` is reused when landing (§5.3). An interrupted curator runs again from scratch.

## 6. Code layout

- `src/config/config.ts`: the `improveDocs` key.
- `src/review/report.ts`: `harnessNotes`, plus coercion.
- `src/agents/reviewer.ts`, `src/agents/tester.ts`: the conditional prompt lines.
- `src/agents/curator.ts` (new): prompt, worktree, check, retries, outputs. It follows the shape of `reviewer.ts`.
- `src/review/phase.ts` or `src/runner/run.ts`: calls the curator after the review loop and before `finish`. Landing happens after `mergeResult`.
- `src/runner/events.ts`, `src/ui/*`: the docs node, plus the Docs section in the summary.
- `src/state/state.ts`: the `docs` step.
- `README.md`: the config table row and a short "Self-improving docs" section.

## 7. Edge cases

| Case | Behaviour |
|---|---|
| Neither file exists | The curator may create one or both (≤ 60 lines each), as new untracked files in the user's checkout. |
| A reviewer writes notes with `improveDocs` off | Ignored, since the prompts don't ask for them. If present, they are parsed and never used. |
| A note contains something that looks like a secret | The prompt forbids values. The tool doesn't scan, consistent with "logs are not redacted" in Safety. The README states that the user reviews the diff. |
| The curator proposes a file identical to the current one | Treated as "no change" for that file. |
| The apply step leaves conflicts | Docs are still written if the files themselves are not conflicted. A docs file that is conflicted in the apply is left alone, and the proposal stays in the run dir. |
| Windows line endings | Proposed files keep the original file's line-ending style. |

## 8. Testing

- **Config**: `improveDocs` defaults to false and rejects non-booleans.
- **Prompts**: the reviewer and tester prompts include the notes instruction only when enabled (snapshot tests).
- **Report**: `harnessNotes` as a string is coerced to an array, and a missing field stays valid.
- **Curator (fake provider)**:
  - with signals, it writes proposals, `.diff` files and the summary section;
  - with no signals, the step is skipped and no agent starts;
  - an invalid `changes.json`, an over-limit growth or a modified worktree is retried with the exact message;
  - after exhausting attempts, the note appears and the exit code is unchanged.
- **Landing**:
  - exit 0 + applied: files written, backups saved, drop command restores them;
  - `--no-merge`, exit 1: nothing written outside the run dir;
  - a file changed during the run is not overwritten.
- **Resume**: kill during the curator, resume, the curator reruns once. Kill after `done`, resume, it doesn't rerun.
- **Disabled path**: e2e with `improveDocs` off produces byte-identical prompts and the same summary as today.

## 9. Out of scope / later

- Proposing rules for task agents (`AGENTS.md`/`CLAUDE.md`) from fixed findings. That is the natural next step: prevent the bug, not only catch it.
- Using fixer summaries or validation failures as signals.
- Per-run (task-folder) test plans. Dropped for now.
- In the outer loop (PRD 03), the curator runs **once at the end of the whole loop** over all iterations' signals, not per iteration.

## 10. Acceptance criteria

- [ ] With `improveDocs` absent or false, runs behave exactly as today (same prompts, no curator, no docs section).
- [ ] With it on, reviewer and tester reports may carry `harnessNotes`, and the curator runs once after the review loop when there are signals.
- [ ] Proposals are written to `.graph-execution/<id>/docs/` with diffs, and land as uncommitted changes in the user's checkout only when the run's result was applied.
- [ ] A file the user edited during the run is never overwritten.
- [ ] The summary shows per-file changes and a working drop command.
- [ ] A curator failure never changes the exit code.
- [ ] Resume doesn't repeat a finished curator step.
- [ ] `npm run typecheck && npm run lint && npm test` pass.
