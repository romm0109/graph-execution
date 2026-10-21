# Human review round

## Summary

With `humanReview` on, the run pauses after the automated review loop instead of applying the result. The web view shows the final diff; the user comments on lines, files or the whole change and chooses Request changes, Apply (or Apply anyway) or Drop. Request changes turns open comments into blocker findings that go through fixer → validate → code reviewer → live tester again with a fresh `fixPasses` budget. There is no round limit. Off by default; a run without it is unchanged. User docs: the "Human review (optional)" section of `README.md`.

## Key behavior

- Enabled by the `humanReview` config key or `--human-review` / `--no-human-review`; the effective value is saved in the run state, and `--resume` rejects both flags.
- The pause is a review step `human` with `humanRound` H (pauses so far) and `budgetBase` (round where the current fix budget started). The exhaustion check is `round - budgetBase >= fixPasses`; rounds keep counting up, so `reports/round<N>/` never collides.
- Comments are `H<round>-<n>` ids, saved write-through to `human/round<H>.json`. Kinds: line (`file`, `line`, `snippet`), file, general. Status is `open`, `resolved` or `reopened`; reopen can add a follow-up text.
- Open comments become blocker findings `human-<id>`; comments with `liveCheck` also become `must` test-plan cases `H<id>` for the live tester.
- The fixer writes `reports/round<N>/fixer-comments.json` (note per id); the code reviewer reports `addressed` / `not_addressed` with evidence per open comment, or the report is retried. The human decides: resolving or reopening overrides the verdict.
- Apply with open blockers needs `force` (web: Apply anyway, confirm). Drop keeps `graph/<run-id>`, applies nothing; exit 0 if the last loop was clean, else 1. Ctrl+C while waiting exits 2 and `--resume` / `open` return to the same pause.
- The web server starts in-process without `--web`; the terminal view only prints `waiting for your review: <url>`. Without a hub (no web), the run logs that and applies without a review.
- `/review` routes return 409 when the run is not waiting for review.

## Code references

- `src/config/config.ts` — `humanReview` key (default `false`).
- `src/cli.ts` — `--human-review` / `--no-human-review`; starts the web server next to the terminal view.
- `src/launch/preflight.ts` — rejects the flags with `--resume`.
- `src/state/state.ts` — `human` step, `humanRound`, `budgetBase`, saved `humanReview`.
- `src/review/phase.ts` — the pause, apply/drop/changes handling, fresh budget, human findings and live-check cases.
- `src/review/human.ts` — comment schema, `human/round<H>.json` storage, comment → finding/case mapping, verdicts, fixer notes, outcomes.
- `src/runner/retry-hub.ts` — `ReviewChoice` and the review wait on the hub.
- `src/runner/run.ts` — wires the pause, applies or drops, picks the exit code.
- `src/web/server.ts` — `/review` routes (state, diff, comments, resolve/reopen, apply, changes, drop).
- `src/web/page.html` — review screen with confirms.
- `src/ui/withWeb.ts` — terminal UI plus in-process web server for runs without `--web`.

## Related

- [Project wiki index](../index.md)
- [Review-phase terminal UI](review-phase-terminal-ui.md)

## Last updated

2026-10-21
