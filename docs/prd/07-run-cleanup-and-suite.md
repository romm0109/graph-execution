# PRD: Run cleanup and suite (KAN-21, KAN-43)

Jira: [KAN-21](https://graph-execution.atlassian.net/browse/KAN-21) (epic: run cleanup) → [KAN-29](https://graph-execution.atlassian.net/browse/KAN-29) (runs clean up after themselves), [KAN-30](https://graph-execution.atlassian.net/browse/KAN-30) (list and clean runs by hand). [KAN-43](https://graph-execution.atlassian.net/browse/KAN-43) (epic: suite) → [KAN-44](https://graph-execution.atlassian.net/browse/KAN-44) (run several features in parallel with one command), [KAN-45](https://graph-execution.atlassian.net/browse/KAN-45) (features are integrated, checked together, and applied once).

## 1. Executive Summary

This PRD covers two features that share one foundation: a run status in `state.json`.

**Run cleanup.** Runs leave things behind. On this repo today (2026-10-21) there are 5 run folders but 170 `graph*` branches. Branches are never deleted, not even after a successful run, and unfinished runs keep their worktrees (\~215 MB each). With this feature, a run writes its status (`running`, `applied`, `done`, `failed`, `aborted`), deletes its task branches when it ends, and old applied runs are deleted automatically beyond `keepRuns` (default 5). Two new commands, `list` and `clean`, show and remove everything else, safely.

**Suite (graph of graphs).** I often have several PRDs at once. Today each is a separate run, and I merge the branches by hand with no check of how the features interact. `graph-execution suite` runs several features in parallel, each as a normal run with its own review loop, then merges them all at the end, resolves conflicts with an integration agent that gets the relevant PRDs, runs a light end-to-end phase on the combined result, and applies once.

**MVP goal:** after 7 successful runs with `keepRuns: 5`, only 6 applied runs (the 5 newest kept at the last run start, plus that run) and no `graph-task/*` branches are left, and `clean` removes the leftovers on this repo. A `suite` with 2 features that edit the same file (fake provider) runs both features in parallel, resolves the conflict with the integration agent at the end, runs the e2e phase, and applies the combined result once as uncommitted changes.

## 2. Mission

Let a developer start as many runs and features as they want without managing branches, folders or merges by hand, and without ever losing a result they haven't applied.

**Principles**

1. **Never lose work.** Nothing that can be resumed, or that holds a result you never applied, is deleted automatically.
2. **Clean up by default.** What nothing needs anymore (task branches after the merge, old applied runs) goes away without asking.
3. **Ask before deleting by hand.** `clean` shows its plan and the space it frees, then asks.
4. **A suite is runs, not a new engine.** Each feature is a normal run in its own process. The suite only adds orchestration, integration and the end-to-end check.
5. **One result, one apply.** A suite lands on your branch once, after everything is integrated and checked.

## 3. Target Users

- **A developer who runs graph-execution often** on one repo and finds hundreds of `graph*` branches and gigabytes in `.graph-execution/`.
- **A developer with several PRDs at once** who wants them built in parallel and merged without manual conflict resolution.

Pain today: `git branch` is unreadable, disk fills up, and there's no safe way to know which runs can be deleted. Parallel features mean separate runs, separate tabs, a manual merge and no check of how the features interact.

## 4. MVP Scope

### Core Functionality: run cleanup
- ✅ `status` field in `state.json`: `running`, `applied`, `done` (finished without apply, `--no-merge`), `failed`, `aborted`
- ✅ Old runs without the field count as unfinished
- ✅ A run that ends `applied` or `done` deletes its `graph-task/*` branches
- ✅ `keepRuns` config key (default 5, 0 disables): at run start, applied runs beyond the newest `keepRuns` are deleted (folder and `graph/<run-id>`)
- ✅ Hint at run start about unfinished runs and their size
- ✅ `graph-execution list`: runs, suites, orphan branches
- ✅ `graph-execution clean`: plan, y/N prompt, `--yes`, `clean <run-id>`, `--done`, `--force`

### Core Functionality: suite
- ✅ `graph-execution suite --feature <tasks-dir>:<prd> ...` (two or more features)
- ✅ One process per feature, plus a suite process that coordinates
- ✅ Split concurrency cap, with queued features when the cap is smaller than the number of features
- ✅ Integration at the end: merge in finish order, integration agent on conflicts only
- ✅ Light e2e phase: validation, cross-feature reviewer, e2e tester, fixer (`e2eReview: false` keeps only validation)
- ✅ One web page with a lane per feature and an integration lane
- ✅ One apply, after the human review when `humanReview` is on
- ✅ Retry on a failed feature or failed integration, and `--resume` for the whole suite

### Out of Scope
- ❌ Deleting runs from the web view
- ❌ Time-based retention (`keep runs newer than 7 days`)
- ❌ Merging features while others still run
- ❌ A shared, dynamic concurrency pool across feature processes
- ❌ Dependencies between features (feature B starts after feature A)
- ❌ Nested suites
- ❌ Suites across several repositories

## 5. User Stories

1. **As a developer, I want finished runs to delete the branches nothing needs, so that `git branch` stays readable.**
   Example: a 13-task run is applied. Its 13 `graph-task/<run-id>/*` branches are gone, and `graph/<run-id>` stays as the only committed copy of the result.

2. **As a developer, I want old applied runs deleted automatically, so that `.graph-execution/` doesn't grow forever.**
   Example: with `keepRuns: 5` and 6 applied runs, starting a 7th run deletes the oldest applied run's folder and `graph/<run-id>` branch before the new run creates its folder.

3. **As a developer, I want to be reminded about unfinished runs without losing them, so that I can resume or delete them myself.**
   Example: a new run prints `3 unfinished runs use 650 MB, run graph-execution clean`. Nothing is deleted.

4. **As a developer, I want to see all runs and leftover branches, so that I know what takes space.**
   Example: `graph-execution list` shows each run's id, status, age, size and branches, each suite as one line, and 160 orphan branches with no run folder.

5. **As a developer, I want to delete leftovers safely, so that I never delete a live run or an unapplied result by accident.**
   Example: `graph-execution clean` shows "2 unfinished runs (430 MB), 160 orphan branches, 1 applied run beyond keepRuns", asks y/N, and skips the run whose lock PID is alive.

6. **As a developer with several PRDs, I want to start them all with one command, so that they build in parallel.**
   Example: `graph-execution suite --feature tasks/auth:PRD-auth.md --feature tasks/export:PRD-export.md --web` starts two feature runs and opens one page.

7. **As a developer, I want the features merged and checked together, so that I get one working result.**
   Example: both features edit `src/router.ts`. At the end, the integration agent resolves the conflict with both PRDs, the cross-feature reviewer reviews `src/router.ts`, the e2e tester runs both test plans, and the result is applied once.

8. **As a developer, I want a failed feature not to stop the others, so that one failure costs me only a retry.**
   Example: the export feature fails a task. The auth feature finishes. The suite waits with Retry on the export lane. After Retry succeeds, integration starts.

## 6. Core Architecture & Patterns

### Run status

`stateSchema` in `src/state/state.ts` gets an optional `status`. The runner sets it:

| Status | Set when |
|---|---|
| `running` | the run starts or resumes |
| `applied` | the result is applied to the target branch |
| `done` | the review phase ends without apply (`--no-merge`, or a suite feature) |
| `failed` | the run exits with an error it can't wait on |
| `aborted` | the user stops the run |

A missing `status` means unfinished. A run whose status is `running` but whose lock PID is dead is also unfinished (it was killed).

### Cleanup module

A new `src/cleanup/` module, used by the run start, `list` and `clean`:

- `scan(repo)`: reads every run and suite folder and every `graph/*`, `graph-task/*` and `suite/*` branch. Returns runs (id, status, age, size, branches, lock PID) and orphan branches (branches whose run folder is missing).
- `plan(scan, opts)`: decides what to delete under the safety rules. Returns entries with a reason and a size.
- `execute(plan)`: removes worktrees (`removeWorktreeIfPresent`), branches (`deleteBranchIfPresent`) and folders, then `pruneWorktrees`.

The run start calls `scan` → `plan({ retention: keepRuns })` → `execute`, and prints the hint from the same scan. Failures are warnings.

### Suite

```
graph-execution suite ...
  └── suite process (detached, holds suite-<id>/lock, serves the web page)
        ├── feature run A (own process, --no-merge, concurrency share)
        ├── feature run B (own process)
        └── feature run C (queued until a slot frees up)
        then: integration → e2e phase → human review? → apply
```

- Feature runs are normal runs started with apply off and a run folder inside the suite folder. They end with status `done`.
- The suite process watches each feature's `state.json` (and the run's events for the web page).
- When every feature is `done`, the suite creates `suite/<id>` from the starting commit and merges each feature's `graph/<run-id>` in finish order with `merge` from `src/git/git.ts`. A conflict calls the integration agent in the suite's integration worktree.
- The e2e phase reuses `src/review/phase.ts` on `suite/<id>` with suite-specific inputs: changed files limited to overlaps for the reviewer, the combined test plans for the tester.
- The apply reuses `applyToCheckout`.

### Directory structure

```
.graph-execution/
  20261021-141518-13d3/          normal run
  suite-20261022-090000-ab12/
    suite.json                   suite state
    lock
    logs/                        integration and e2e agent logs
    worktrees/integration/       suite/<id>
    features/
      20261022-090001-c3d4/      feature run (normal run folder)
      20261022-090001-e5f6/
src/cleanup/                     scan, plan, execute
src/suite/                       command, state, orchestration, integration, e2e inputs
src/agents/integration.ts        integration agent prompt
```

### Key patterns
- **Reuse the PID lock** (`acquireLock`, `lockHolder`) for runs and suites, and for cleanup's "is it live" check.
- **Reuse the retry hub** for the failed integration node, as for a failed task.
- **Helper agent pattern** from `src/agents/resolver.ts` for the integration agent: same commit and conflict-marker rules, with PRDs added.

## 7. Features

### 7.1 Run status and task branch deletion
- The runner sets `status` at each transition listed in §6 and saves it with the state.
- When the run ends `applied` or `done`, it deletes every `graph-task/<run-id>/*` branch. A branch that can't be deleted (checked out somewhere) is a warning.

### 7.2 Retention
- Config key `keepRuns`, integer ≥ 0, default 5. `0` disables retention.
- At run start, before the new run folder is created: sort `applied` runs and applied suites by creation time and delete all but the newest `keepRuns` (folder plus `graph/<run-id>`, or `suite/<id>` and the feature branches for a suite).
- Only `applied` counts. `done`, unfinished, and locked runs are never touched.
- Between runs there can be `keepRuns + 1` applied runs on disk; that is accepted.

Example with `keepRuns: 5`:

| Before the new run starts | What retention does |
|---|---|
| 5 applied | nothing |
| 6 applied | deletes the oldest applied run |
| 5 unfinished | nothing, prints the hint |

### 7.3 Unfinished-runs hint
At run start, if there are unfinished runs (other than ones locked by a live PID):

```
3 unfinished runs use 650 MB, run graph-execution clean
```

### 7.4 `graph-execution list`

```
RUN                          STATUS    AGE    SIZE    BRANCHES
20261021-141518-13d3         running   2h     38 MB   graph/…, 1 task branch   (pid 4123)
20261021-114429-182f         applied   5h     8.9 MB  graph/…
suite-20261022-090000-ab12   done      1d     120 MB  suite/…, 2 features
ORPHAN BRANCHES: 160 (graph/* 34, graph-task/* 126)
```

### 7.5 `graph-execution clean`

| Invocation | Deletes |
|---|---|
| `clean` | unfinished runs (and their worktrees), orphan branches, applied runs beyond `keepRuns`; shows the plan and asks y/N |
| `clean --yes` | same, no prompt |
| `clean <run-id>` | that run or suite only (any status except locked) |
| `clean --done` | also `done` (`--no-merge`) runs |
| `clean --force` | also branches with unmerged commits that the rules would otherwise keep |

**Safety rules**
- Never delete a run or suite whose lock PID is alive, or a branch that is checked out.
- `applied` runs are exempt from the unmerged-commits rule: their result was applied.
- Orphan branches are deleted without `--force`: no run can resume without its folder.
- Otherwise, a branch with commits not reachable from any other branch is kept unless `--force`.

### 7.6 `graph-execution suite`

```
graph-execution suite --feature tasks/auth:PRD-auth.md --feature tasks/export:PRD-export.md \
  --provider claude --concurrency 4 --web
```

- `--feature <tasks-dir>:<prd>`, two or more. Other options as for a run: `--provider`, `--model`, `--concurrency`, `--web`, `--no-merge`, `--human-review`, `--resume`, `--run <suite-id>`.
- **Split cap:** with N = `--concurrency` and F features, if N ≥ F every feature starts with a share of `floor(N / F)`, and the remainder goes to the first features. If N < F, the first N features start with a share of 1 each, and the rest are queued; each queued feature starts when a running feature ends.
- A feature's share is fixed when its process starts.
- **A failed feature** (a task that used all its `attempts`) stops, and its lane shows a **Retry** button, which resumes that feature run with the same share. The other features keep running.
- **Start integration:** when every other feature is `done` and one or more keep failing, the page shows a **Start integration** button. It marks the failed features `excluded` and starts integration with the `done` features only. The summary lists the excluded features, and their runs stay for a later run.
- **Stop:** stopping the suite (or a crash) stops every feature process. Each feature's status becomes `aborted`.
- **Resume:** `graph-execution suite --resume [--run <suite-id>]` resumes each feature that isn't `done`, then the integration where it stopped.

### 7.7 Integration
- Starts only when every feature is `done`, or when you press **Start integration** (failed features are excluded). Nothing is merged while features run.
- `suite/<id>` is created from the suite's starting commit. Features are merged in the order they finished.
- A clean merge is a plain git merge.
- A conflict calls the **integration agent** with:
  - the conflicting files;
  - the incoming feature's PRD;
  - the PRDs of the already-merged features that changed the conflicting files.
- The agent runs within `attempts`. If it fails, the integration node waits with Retry.
- The integration agent never runs at the same time as feature agents, so the suite never exceeds the cap.

### 7.8 End-to-end phase
Once all features are merged, on `suite/<id>`:

1. **Validation:** the config's `validate` commands, with the gate fixer within `validationRounds`.
2. **Cross-feature reviewer:** sees only files changed by more than one feature, plus all PRDs. Skipped when no file overlaps.
3. **E2E tester:** runs every feature's test plan (KAN-5) together.
4. **Fixer:** fixes blockers and majors, with its own `fixPasses` budget.

`e2eReview: false` (config key) keeps only step 1.

### 7.9 Web page and apply
- The suite process serves one page: a lane per feature (its graph, read from the feature's state and events) and an integration lane (merges, integration agent, e2e nodes, apply).
- Retry on a feature lane is sent to that feature's process.
- With `humanReview` on, the suite pauses before apply, using the KAN-15 review on the `suite/<id>` diff.
- One apply to the starting branch, as uncommitted changes. The suite's status becomes `applied`. With `--no-merge` it becomes `done`.

## 8. Technology Stack

No new dependencies.

- **Runtime:** Node.js ≥ 20, TypeScript 5.9
- **CLI:** commander 14 (`list`, `clean`, `suite` subcommands)
- **Process and git:** execa 9
- **State and config:** zod 4 (`status`, `keepRuns`, `e2eReview`, suite state schema)
- **Terminal UI:** ink 6, React 19 (`clean` prompt and plan table)
- **Tests:** vitest 3 with the fake provider

## 9. Security & Configuration

### Configuration (`graph-execution.config.json`)

```json
{
  "keepRuns": 5,
  "e2eReview": true
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `keepRuns` | integer ≥ 0 | 5 | applied runs kept; 0 disables retention |
| `e2eReview` | boolean | true | suite: reviewer, tester and fixer after validation |

The existing `concurrency`, `attempts`, `validationRounds`, `fixPasses` and `humanReview` apply to the suite as they do to a run.

### Safety
- Deletion never touches anything outside `.graph-execution/` and the `graph/*`, `graph-task/*` and `suite/*` branch namespaces.
- Live runs are detected by PID lock. Checked-out branches are detected with `git worktree list`.
- Automatic cleanup only deletes `applied` runs and finished task branches. Everything else needs `clean`.

### Out of scope
- No authentication changes. The web page stays local as today.

## 10. API Specification

### Suite state (`suite-<id>/suite.json`)

```json
{
  "suiteId": "suite-20261022-090000-ab12",
  "status": "running",
  "startingCommit": "8a87d02",
  "targetBranch": "main",
  "integrationBranch": "suite/20261022-090000-ab12",
  "concurrency": 4,
  "features": [
    { "runId": "20261022-090001-c3d4", "tasksDir": "tasks/auth", "prd": "PRD-auth.md",
      "share": 2, "pid": 4211, "finishedAt": "2026-10-22T09:41:00Z" },
    { "runId": "20261022-090001-e5f6", "tasksDir": "tasks/export", "prd": "PRD-export.md",
      "share": 2, "pid": 4212 }
  ],
  "integration": { "merged": ["20261022-090001-c3d4"], "conflict": null },
  "review": { "phase": "validate", "round": 0, "validationRounds": 0, "reports": {}, "humanRound": 0, "budgetBase": 0 },
  "createdAt": "2026-10-22T09:00:00Z"
}
```

### Web routes (suite process)
- `GET /api/suite`: suite state and each feature's summary.
- `GET /api/features/:runId/events`: the feature's event stream, proxied from its state and logs.
- `POST /api/features/:runId/retry/:nodeId`: forwarded to the feature's process.
- `POST /api/integration/retry`: retries the failed integration node.
- `POST /api/integration/start`: starts integration without the failed features (only when every other feature is `done`).

### Exit codes
- `list`: 0.
- `clean`: 0 on success or when the user answers N; 1 if any deletion failed.
- `suite`: as a run (0 applied or done, non-zero on failure or abort).

## 11. Success Criteria

### Run cleanup
- ✅ After 7 successful runs with `keepRuns: 5`, exactly 6 applied run folders and `graph/*` branches exist (the 5 newest kept at the 7th run start, plus the 7th), and no `graph-task/*` branches.
- ✅ Unfinished and `done` runs are never deleted automatically.
- ✅ On this repo, `list` shows the runs and the orphan branches. `clean --yes` removes unfinished runs and orphans, and leaves the checked-out branch and any live run untouched.
- ✅ `keepRuns: 0` deletes nothing automatically.
- ✅ README documents `list`, `clean` and `keepRuns`.

### Suite
- ✅ 2 features (fake provider) run in parallel with split concurrency, each with its own review loop. Nothing is merged or applied until both are done.
- ✅ 3 features with `--concurrency 2`: 2 start, the third starts when one finishes.
- ✅ 2 features that edit the same file: the integration agent resolves the conflict with both PRDs, the e2e phase runs, and the result is applied once as uncommitted changes.
- ✅ No overlapping files: the cross-feature reviewer is skipped.
- ✅ A failed feature shows Retry while the other finishes. After Retry, integration starts.
- ✅ A feature that keeps failing: Start integration integrates the others and lists the excluded feature.
- ✅ Killing the suite stops all features. `--resume` finishes the suite.
- ✅ `list` and `clean` show and delete a suite as one entry.

## 12. Implementation Phases

### Phase 1: Run status and automatic cleanup (KAN-29)
**Goal:** runs record their status and clean up what nothing needs.
- ✅ `status` in the state schema, set by the runner
- ✅ Task branch deletion on `applied` / `done`
- ✅ `src/cleanup/` scan, plan, execute
- ✅ `keepRuns` retention and the unfinished-runs hint at run start

**Validation:** the 7-runs scenario passes with the fake provider.

### Phase 2: `list` and `clean` (KAN-30)
**Goal:** see and delete everything else, safely.
- ✅ `list` with runs, suites and orphans
- ✅ `clean` with plan, prompt, `--yes`, `<run-id>`, `--done`, `--force`
- ✅ README section

**Validation:** `clean --yes` on a fixture repo with live, unfinished, applied, done and orphan entries deletes exactly the expected ones.

### Phase 3: Suite runs (KAN-44)
**Goal:** run several features in parallel under one suite.
- ✅ `suite` command, suite state, suite process and lock
- ✅ Feature processes with concurrency shares and queueing
- ✅ Retry, stop and `--resume` across features
- ✅ Suite web page with feature lanes

**Validation:** 2 and 3 features run with the fake provider. Nothing is merged.

### Phase 4: Integration, e2e and apply (KAN-45)
**Goal:** one checked, combined result applied once.
- ✅ End-of-suite merge in finish order, integration agent with PRDs, Retry on failure
- ✅ E2E phase with the overlap-only reviewer and combined test plans; `e2eReview`
- ✅ Human review and single apply; suite status `applied` / `done`

**Validation:** the same-file conflict scenario passes end to end with the fake provider.

Phases 1–2 and 3–4 are independent except for the run status from phase 1, which phase 3 uses.

## 13. Future Considerations
- Delete runs and suites from the web view.
- Time-based retention (`keepDays`).
- A shared concurrency pool so a finished feature's share goes to the others.
- Dependencies between features.
- Share the suite orchestration with the `auto` outer loop (PRD 03).
- Merge clean features early to show conflicts sooner, as an option.

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Cleanup deletes a run that is still useful | Only `applied` runs are deleted automatically. Everything else needs `clean`, which shows the plan and asks. Live runs are protected by the PID lock. |
| Old runs without `status` are misread | They count as unfinished: never deleted automatically, and `clean` lists them for you to decide. |
| Features conflict heavily, and the integration agent fails | The integration agent gets the relevant PRDs. On failure, the node waits with Retry. Features are not lost: each `graph/<run-id>` stays. |
| A split cap wastes capacity when one feature finishes early | Accepted for the MVP. A shared pool is a future option. |
| Orphan feature processes after a suite crash | Feature processes are stopped with the suite. On resume, stale feature locks are taken over as with runs today. |
| Integration only at the end finds conflicts late | Accepted: the user chose it for simplicity. Early merging is a future option. |

## 15. Appendix

### Related documents
- [05-feature-test-plan.md](05-feature-test-plan.md): test plans combined for the e2e tester
- [06-human-review-round.md](06-human-review-round.md): the review before the single apply
- [03-auto-loop.md](03-auto-loop.md): run-of-runs orchestration to share later

### Code to reuse
- `src/state/state.ts`: state schema, `acquireLock`, `lockHolder`, `isAlive`
- `src/git/git.ts`: `deleteBranchIfPresent` (not called today), `removeWorktreeIfPresent`, `pruneWorktrees`, `merge`, `applyToCheckout`
- `src/agents/resolver.ts`: base for the integration agent prompt
- `src/review/phase.ts`: the review phase for the e2e phase
- `src/runner/retry-hub.ts`: Retry for the integration node
- `src/launch/handoff.ts`: detached launch of the suite and feature processes
