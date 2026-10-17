# Review-phase terminal UI

## Summary

The terminal UI presents the task and review lifecycle as an event-sourced view. After task execution, the phase bar tracks validation, review rounds, and bounded fixer passes; reviewer, live tester, and fixer nodes share task-node status, retry, and focused-output behavior.

When the run ends, the live tail is replaced with a summary containing the integration branch, exit status, last-review severity counts, minor findings, tester notes, and exit-specific next steps. Non-TTY mode subscribes to the same phase and agent events and prints the summary as plain lines.

## Key behavior

- Review events identify rounds and fixer passes, while agent labels keep output tails and log files separate across retries and rounds.
- Exit code 0 suggests inspection and merging; exit code 1 calls out remaining blocking findings before merge; exit code 2 includes the saved resume command.
- Full agent output is persisted under the run's `logs` directory even when the TUI only displays a tail.

## Code references

- `src/review/phase.ts` — emits phase, review, fixer, retry, status, and completion events.
- `src/runner/events.ts` — defines the typed event and run-summary contracts.
- `src/ui/store.ts` — folds events into task/review node state and focused log tails.
- `src/ui/PhaseBar.tsx` — renders the current phase and fixer pass.
- `src/ui/Graph.tsx` — renders reviewer, tester, and fixer nodes.
- `src/ui/Summary.tsx` — renders shared terminal and plain-mode end summaries.
- `src/ui/start.tsx` — selects Ink for TTY output and readable event lines otherwise.
- `src/ui/App.test.tsx`, `src/ui/Summary.test.tsx`, `src/ui/start.test.ts` — cover phase rendering, summaries, focus, retries, and plain output.

## Related

- [Project wiki index](../index.md)

## Last updated

2026-10-17
