# PRD: Show when an agent was stopped for a loop

## Problem

Since `9a9d475`, `watchLoops` (`src/agents/loop.ts`) stops an agent that keeps repeating the same tool call, or the same cycle of 2–3 calls, `loopDetection.repeats` times in a row (default 5). The attempt then fails with class `"loop"` and is retried. The only trace today is one log line, `[<label>] stopped: <why>; retrying`. The web page shows a plain `retry 2/3`, the same as for a crash, and the end-of-run summary says nothing. Someone watching a run can't tell that a model got stuck, or how often.

## What the tool already emits

- `task:retry` `{ taskId, attempt, attempts, reason }` and `agent:retry` `{ agent, label, attempt, attempts, reason }` (`src/runner/events.ts`). `reason` is an `AttemptFailure`, `{ class, message }` (`src/agents/retry.ts`). For a loop stop `class` is `"loop"`, and `message` reads `the agent was stopped because it made the same tool call 5 times in a row: Bash {"command":"npm test"}`.
- `watchLoops(provider, settings, onLoop)` calls `onLoop(label, why)` once per stop. `src/runner/run.ts` uses it to log.

## Requirements

1. **Store.** `NodeView` (`src/ui/store.ts`) gains `loops?: number` (how many attempts of this node were stopped for a loop) and `lastLoop?: string` (the latest reason's `message`). `task:retry` and `agent:retry` with `reason.class === "loop"` add one and set `lastLoop`. Other retries leave them alone. The web state and the terminal read them from there.
2. **Run page.** A node whose `loops` is set shows a badge `loop ×N` on its card, unless the node is retryable (the existing `retry` badge wins). The side panel's Overview gets a `Loop stops` row: `N — <lastLoop>`.
3. **End-of-run summary.** `RunEnd` (`src/runner/events.ts`) gains `loopStops?: { label: string; why: string }[]`, filled in `src/runner/run.ts` from `onLoop`. `summaryContent` (`src/ui/Summary.tsx`) adds a `Loop stops` section with one line per stop, `<label>: <why>`, only when there are any.

## Out of scope

The suite page, the terminal graph cards, and detection itself.

## Acceptance

- With the fake provider and `{"task:2":{"attempts":[{"loop":8}]}}`, the run still exits 0. Task 2's card shows `loop ×1` and its Overview shows the reason, and the final summary has a `Loop stops` section with `2: it made the same tool call 5 times in a row: …`.
- A run with no loop shows no badge, no row and no section.
- `npx tsc --noEmit`, `npx eslint .`, `npx vitest run` pass.
