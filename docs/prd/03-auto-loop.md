# PRD: The loop above the graph (`graph-execution auto`)

## 1. Summary

Today a run executes one task graph that someone already wrote, and stops. `graph-execution auto` adds a bounded outer loop around it. A PRD goes in, a finished feature comes out:

```
plan ──► run graph (tasks → validate → review → fix) ──► audit against the spec
  ▲                                                          │
  └──────────── gaps become the next, smaller graph ◄────────┘
```

1. **Plan.** A planner agent turns the spec into a task graph. On later iterations it plans only the gaps the auditor found. Alternatively, the user passes a task folder for the first iteration.
2. **Run.** It's a normal run, with tasks, validation and the review loop. Nothing in the run changes.
3. **Audit.** A spec auditor compares the whole result with the spec and lists what is still missing.
4. **Stop or repeat.** Stop when nothing is missing, when the iteration cap is reached, or when an iteration made no progress. Otherwise the gaps become the next iteration's plan.

The result is applied to the user's branch **once, at the very end**, as uncommitted changes, exactly like a normal run.

The loop is **always bounded**. `maxIterations` is a hard cap, and every step inside an iteration is already bounded (`attempts`, `validationRounds`, `fixPasses`). The worst case is known before it starts.

## 2. Goals and non-goals

**Goals**
- Spec in, done feature out, unattended.
- Bounded: a hard iteration cap plus an early stop when nothing changes.
- Reuse the existing run unchanged. Each iteration is an ordinary run with its own state, logs, reports and resume.
- Resumable at any step.
- A plain `graph-execution <tasks-dir> …` run behaves exactly as today.

**Non-goals**
- Changing a graph while it runs. Each iteration plans a fresh graph before it starts.
- Interactive questions during planning. The planner decides granularity itself.
- Cost budgets (still out of scope, see the main PRD §4).

## 3. User stories

1. **As a developer, I want to hand over a PRD and get a reviewed, complete implementation, so that I don't break it into tasks or rerun for what was missed.**
   Example: `graph-execution auto --spec PRD.md --provider claude` plans 6 tasks and runs them. The auditor finds that the CSV export from §7 is missing. Iteration 2 plans and runs 1 task, the auditor finds nothing missing, and the result is applied.
2. **As a developer who already has tasks from `to-tasks`, I want to start the loop from them, so that iteration 1 uses my reviewed breakdown.**
   Example: `graph-execution auto .agents/tasks --spec PRD.md --provider claude`.
3. **As a developer, I want a hard limit on iterations, so that a spec that can't be met doesn't burn agents forever.**
4. **As a developer, I want the loop to stop as soon as an iteration doesn't close any gap, so that it doesn't spend iterations going in circles.**
5. **As a developer, I want to resume an interrupted loop where it stopped.**

## 4. CLI

```
graph-execution auto [<tasks-dir>] --spec <file> --provider <name> [--concurrency n] [--model m] [--no-merge] [--new-terminal]
graph-execution auto --resume [--run <auto-id>] [--no-merge] [--new-terminal]
```

| Option | Meaning |
|---|---|
| `<tasks-dir>` | Optional. The graph for iteration 1. Without it, iteration 1 starts with the planner. |
| `--spec`, `--provider`, `--concurrency`, `--model`, `--no-merge` | As for a normal run, applied to every iteration. |
| `--resume [--run <id>]` | Resume the latest (or the given) auto run. |
| `--new-terminal` | From PRD 01: preflight, then open the loop in a new window. |

## 5. Configuration

```json
{ "maxIterations": 3 }
```

| Key | Default | Meaning |
|---|---|---|
| `maxIterations` | `3` | Maximum number of iterations (plan → run → audit) of `graph-execution auto`, at least 1. Ignored by a plain run. |

The planner and the auditor use `attempts` like every agent. All other keys apply to each iteration's run as usual.

**Worst case.** `maxIterations` × (planner + one bounded run + auditor). The README states it like that.

## 6. Behaviour

### 6.1 Layout and state

```
.graph-execution/auto-<id>/
  auto.json                           # loop state (below)
  lock
  iter<N>/tasks/*.json                # the graph the planner wrote for iteration N (absent if user-supplied)
  iter<N>/audit.json                  # the auditor's report for iteration N
  logs/planner-<N>.log  logs/auditor-<N>.log
.graph-execution/<run-id>/            # each iteration's ordinary run, unchanged
```

`auto.json`:

```ts
{
  autoId, provider, model?, concurrency?, specPath, hashes: { config, spec, tasks? },
  startingCommit,              // the user's HEAD when the loop started
  targetBranch?,               // where the final result is applied
  maxIterations,
  step: { iteration: number, phase: "plan" | "run" | "audit" | "done" },
  iterations: [{ tasksDir, runId?, runExit?, auditFile?, gaps?: string[] /* ids */ }],
  outcome?: "complete" | "capped" | "no_progress" | "review_failed"
}
```

It is saved atomically before and after every step, like `state.json`.

### 6.2 Chaining iterations

- Iteration 1's run starts from `startingCommit`, as today.
- Iteration N > 1 starts from the **head of iteration N−1's integration branch**. In code, `RunContext.startingCommit` is that head. Its reviewers therefore review only this iteration's change, and its own diff, validation and fix loop work unchanged.
- No iteration's run applies its result to the user's branch. Inner runs always behave as `--no-merge`.
- At the end, the **last** iteration's integration branch, which contains every iteration, is applied to `targetBranch` with the existing `applyToCheckout`. Same rules, same summary, same drop command as a normal run. `--no-merge` or a detached HEAD skip it, as today.
- Each iteration's worktrees are removed on success by the existing `finish`, so only the branches `graph/<run-id>` stay, one per iteration.

### 6.3 Planner

- **When:** iteration 1 without `<tasks-dir>`, and every iteration N > 1.
- **Where:** a throwaway detached worktree at the current head (iteration 1: `startingCommit`; N > 1: iteration N−1's integration head), so it can explore the code it plans against.
- **Prompt:** the spec. For N > 1, also the gaps from `iter<N-1>/audit.json`, with the instruction to plan **only** those gaps against the code that exists. The prompt contains the task-writing rules from `skills/to-tasks/SKILL.md` in a non-interactive form: vertical slices, self-sufficient `content` with files, patterns, acceptance criteria and validation commands, dependencies, no human decisions mid-task, and decide granularity yourself instead of asking. It also gives the exact JSON format and the output folder `iter<N>/tasks/`.
- **Check (retried with feedback):** the folder loads and validates with the same `loadTasks` + `validateGraph` as a run, and the errors are given back verbatim on retry. It must contain at least 1 task and at most 30, and the worktree must be unchanged.
- **Exhausted attempts:** abort the loop, exit 2, resumable.

### 6.4 Run

The ordinary `run()` for the iteration's task folder and the shared spec, with its own run id, state, logs and UI. The loop records `runId` before starting it, so an interrupted iteration resumes through the existing `resume()`.

| Run exit | Loop |
|---|---|
| 0 | → audit |
| 1 (review loop exhausted) | Stop. `outcome: "review_failed"`, exit 1. The open findings are in that run's summary, and nothing is applied. |
| 2 (abort) | Stop, exit 2, resumable with `graph-execution auto --resume`. |

### 6.5 Spec auditor

- **Where:** a throwaway detached worktree at the iteration's integration head. Read-only.
- **Prompt:** the full spec; the diff from `startingCommit` to the head (the whole loop's work); the previous iteration's gaps, if any; and the rules:
  - List only requirements the spec states that are missing or clearly not working. No style, no nice-to-haves, no new ideas.
  - Every gap cites where the spec states it (`specRef`: section or quote) and what is missing (`evidence`: file paths, a missing endpoint, a command that fails).
  - For every previous gap, keep its `id` and set `status` to `closed` or `still_missing`. New gaps get new ids.
- **Report** `iter<N>/audit.json`:

```json
{
  "iteration": 2,
  "complete": false,
  "summary": "...",
  "gaps": [
    { "id": "G1", "title": "CSV export", "specRef": "§7.3", "description": "...", "evidence": "...", "status": "still_missing" },
    { "id": "G3", "title": "Pagination on /items", "specRef": "§5 story 4", "description": "...", "evidence": "...", "status": "new" }
  ]
}
```

- **Parsing:** the same repair → strict schema → retry-with-feedback chain as review reports. `complete` is derived, not trusted: `complete` ⇔ no gap with status `new` or `still_missing`.
- **Exhausted attempts:** the loop cannot judge completeness. It stops with `outcome: "capped"`-style handling: exit 1, nothing applied, and the summary says `spec audit not performed: <reason>`.

### 6.6 Stop conditions (checked after each audit, in this order)

1. **Complete:** no open gaps → `outcome: "complete"`, apply the result (§6.2), exit 0.
2. **No progress:** iteration N > 1 has no gap with status `closed` and no gap with status `new` (every gap is `still_missing`) → `outcome: "no_progress"`, exit 1.
3. **Cap:** N = `maxIterations` → `outcome: "capped"`, exit 1.
4. Otherwise → iteration N+1 starts with the planner.

On exit 1 the result is **not** applied, matching a normal run's exhausted review. The summary lists the open gaps and shows how to bring the last branch in by hand (`git merge --squash --no-commit graph/<last-run-id>`).

### 6.7 Exit codes

| Code | Meaning |
|---|---|
| 0 | The spec audit is complete. The result is applied unless something stopped it (same reasons as a normal run). |
| 1 | Capped, no progress, an iteration's review loop exhausted, or the spec audit was not performed. Branches, reports and audits are kept. |
| 2 | Abort: planner exhausted, an iteration aborted, Ctrl+C, startup failure. Resumable. |

### 6.8 Live view and summary

- The phase bar gets a prefix: `iteration 2/3 · plan`, `iteration 2/3 · tasks`, `… · review`, `… · audit`.
- Within an iteration's run, the existing graph view is shown unchanged. Planner and auditor appear as single nodes before and after it.
- The final summary includes a table of iterations (tasks planned, run exit, gaps closed/new/open), the outcome, the open gaps with their `specRef` if any, then the normal apply section.

### 6.9 Resume

`graph-execution auto --resume` loads `auto.json`. It refuses when the config or spec changed, or the user-supplied tasks folder if there was one, and takes the auto lock. Then it continues from `step`:
- `plan`: rerun the planner (its output folder is cleared first);
- `run`: `resume()` the recorded run id, or start it if it has none yet;
- `audit`: rerun the auditor unless a valid `audit.json` already exists;
- `done`: only the final apply, if it didn't happen.

### 6.10 Interaction with other features

- **`improveDocs` (PRD 02):** inner runs don't run the curator. It runs once after the loop ends (exit 0 or 1), over the signals of all iterations, and its proposal lands with the final apply.
- **`--new-terminal` (PRD 01):** supported. Preflight checks the spec, the provider, the optional tasks folder and the config.
- **`run-graph` skill (PRD 01):** offers `auto` when the user asks to "build the whole PRD" rather than run a task folder.

## 7. Code layout

- `src/auto/loop.ts` (new): the state machine of §6.1 and §6.6. It calls the existing `run()`/`resume()` with a computed `RunContext` (starting commit = previous head, `merge: false`).
- `src/auto/state.ts` (new): the `auto.json` schema, store and lock (reuses `StateStore`/`acquireLock` patterns).
- `src/agents/planner.ts`, `src/agents/auditor.ts` (new): prompts, worktrees, checks, retries. They follow `reviewer.ts`.
- `src/auto/audit.ts` (new): the audit schema plus repair, like `review/report.ts`.
- `src/config/config.ts`: `maxIterations`.
- `src/cli.ts`: the `auto` command.
- `src/ui/*`: the iteration prefix, planner and auditor nodes, the iterations table in the summary.
- `src/runner/run.ts`: the only change is allowing a caller-provided starting commit and suppressing the final apply. The internals of a normal run stay as they are.
- `README.md`: an "Auto mode" section with the worst-case bound.

## 8. Edge cases

| Case | Behaviour |
|---|---|
| The planner writes 0 tasks for gaps it thinks are already done | The check fails ("at least 1 task"), and the retry is told to plan the gaps or, if they really exist already, write a single task that verifies them with an empty commit (the existing already-implemented path). |
| The auditor reports a gap the planner can't address (needs a human decision) | It stays `still_missing` and the loop stops by no progress, with the gap listed. Correct and bounded. |
| `maxIterations: 1` | Plan (or the given tasks), run, audit, stop. Useful as "run plus a completeness check". |
| The user commits on the target branch during the loop | Handled by the final `applyToCheckout` exactly as for a normal run (three-way merge, conflicts left as conflicts). |
| Long-path limits on Windows | The auto dir name stays short (`auto-<id>`) and iteration runs use normal run dirs, so worktree paths are no deeper than today. |

## 9. Testing

All with the fake provider:
- **Complete in 1:** given tasks, the run ends with exit 0, the audit has no gaps, the result is applied and the exit code is 0.
- **Complete in 2:** the audit has 1 gap, the planner writes 1 task, iteration 2 runs from iteration 1's head, the audit closes the gap, and the final apply contains both iterations' changes.
- **Cap:** gaps every iteration → exit 1 after `maxIterations`, nothing applied, gaps in the summary.
- **No progress:** iteration 2 marks every gap `still_missing` with no new ones → exit 1 after iteration 2, even with `maxIterations: 5`.
- **Inner review exhausted:** exit 1, loop stops.
- **Planner invalid output:** a cyclic graph is retried with the validator's message, and exhausted attempts give exit 2.
- **Auditor invalid output:** repaired or retried. When exhausted → exit 1 with "spec audit not performed".
- **Resume:** interrupt in each of plan, run and audit, then resume → finishes with the same outcome, with no duplicate planner or run when outputs are valid.
- **Isolation:** a plain `graph-execution <tasks-dir>` run is unchanged (the existing e2e tests pass untouched).

## 10. Acceptance criteria

- [ ] `graph-execution auto --spec <f> --provider <p>` plans, runs and audits, and repeats only on open gaps.
- [ ] The loop stops on complete (exit 0), no progress (exit 1), `maxIterations` (exit 1), an exhausted inner review (exit 1) or an abort (exit 2), and never runs more than `maxIterations` iterations.
- [ ] Iteration N > 1 is cut from iteration N−1's integration head, and only the final result is applied to the user's branch.
- [ ] `auto --resume` continues from the saved step.
- [ ] The summary shows per-iteration results and any open gaps with spec references.
- [ ] Plain runs are unaffected.
- [ ] `npm run typecheck && npm run lint && npm test` pass.
