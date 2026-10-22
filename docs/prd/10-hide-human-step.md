# PRD: Hide the human review step when human review is off

## Problem

The web pages draw a phase stepper in the top bar. Both always list a **human** step, even in runs started without `--human-review`, where that step never happens:

- Run page (`src/web/assets/runpage.js`): `tasks · validate · review · fix · human · done`
- Suite page (`src/suite/page.html` via `src/web/assets/suitepage.js`): `features · integration · e2e · human · apply`

The terminal phase bar (`src/ui/PhaseBar.tsx`) already hides the step when the run does not pause for a human review (its `humanReview` prop). The graph on both pages already draws the `@human` node only when `humanReview` is on. Only the steppers are wrong.

## Goal

The stepper shows the human step only when the run or suite pauses for a human review. Everything else about the stepper stays as it is: labels, the current step's text (`review round 1`, `fix pass 1/3 (human round 1)`), done marks, and the red mark of a failed or aborted suite.

## Data available on the pages

- Run page: the `/state` JSON has `humanReview: boolean` (set in `src/web/server.ts:153`).
- Suite page: the suite JSON has `suite.humanReview: boolean` (schema `src/suite/state.ts:48`, default `false`).

## Requirements

1. A pure helper in `src/web/assets/shell.js`, `visiblePhases(phases, humanReview)`, returns the phase keys to show: all of them when `humanReview` is true, otherwise the same list without `"human"`. It has unit tests in `src/web/assets/shell.test.ts`.
2. The run page builds its stepper from `visiblePhases(PHASES, s.humanReview)` and finds the current step by key in that list.
3. The suite page works by phase key instead of the fixed indexes 3 (human) and 4 (apply) it uses today, and uses the same helper. The last step keeps its label logic (`apply`, `applied`, `done`, or the failed or aborted status).

## Out of scope

The terminal UI, the graph nodes, and any server change.

## Acceptance

- A run with `--web` and no `--human-review` shows no "human" pill. With `--human-review`, the pill shows between fix and done and is the current step while the run waits for the review.
- The same holds for a suite with `--web`.
- `npx tsc --noEmit`, `npx eslint .` and `npx vitest run src/web src/suite` pass.
