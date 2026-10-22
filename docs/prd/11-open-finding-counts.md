# PRD: Count only open findings in review summaries

## Problem

After each review round the run logs one line per reviewer, for example:

```
live test round 2: 8 blocker, 3 major, 0 minor
```

`countBySeverity` (`src/review/report.ts:209`) counts every finding in the report, whatever its `status`. A re-review marks a previous finding `"fixed"` but keeps it in the report, so a clean round can read like a disaster. In a real suite last night, every one of those 11 findings was fixed. The decision to run another fix pass already counts only open findings (`openBlocking`, `src/review/report.ts:229`), so the line contradicts what the tool does next.

The same counts appear in the report markdown (`renderMarkdown`, `src/review/report.ts:288`) and in the end-of-run findings table (`findingsTable`, `src/ui/Summary.tsx:25`).

## Goal

Every severity count shows **open** findings: status `"open"` or `"not_fixed"`. Fixed findings are mentioned separately when there are any.

## Requirements

1. `countBySeverity` counts only findings whose status is not `"fixed"`. A new exported helper, `countFixed(findings)`, returns how many have status `"fixed"`.
2. The round log line in `src/review/phase.ts:467` keeps its format and appends ` (N fixed)` when N > 0:
   `code review round 1: 0 blocker, 0 major, 0 minor (1 fixed)`. With no fixed findings the line is unchanged, for example `code review round 0: 0 blocker, 0 major, 0 minor`.
3. `renderMarkdown` uses the open counts and appends ` (N fixed)` to its counts line in the same way. It still lists every finding with its status.
4. The end-of-run findings table in `src/ui/Summary.tsx` shows open counts per severity.

## Out of scope

Report files on disk, the fix-pass decision, and the web pages.

## Acceptance

- The existing test that expected a fixed finding to be counted (`src/review/phase-fix-pass.test.ts:303`) expects `code review round 1: 0 blocker, 0 major, 0 minor (1 fixed)`.
- `npx tsc --noEmit`, `npx eslint .` and `npx vitest run src/review src/ui` pass.
