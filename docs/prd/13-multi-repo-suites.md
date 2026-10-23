# PRD: Multi-repo suites

## 1. Executive Summary

A suite today runs several features in parallel and integrates them, but only inside one repo: the repo is `repoRoot(cwd)` (`src/suite/orchestrator.ts:148`), every feature run is spawned there (`src/suite/orchestrator.ts:108`), and integration, the e2e phase and the apply all work on one `suite/<id>` branch.

This PRD extends the existing `suite` command so its features can live in different git repos, for example a frontend and a backend. Each feature still belongs to exactly one repo, given by the full path of its task folder. Each repo is integrated on its own `suite/<id>` branch, and then **one cross-repo e2e phase** runs on a combined workspace that holds every repo's integration worktree, so the reviewer, tester and fixer can bring up both sides and fix either of them.

**Value:** the cross-repo e2e test is the only thing a multi-repo suite gives that N separate suites started together do not. A frontend feature is tested against the backend feature that it calls, before anything is applied.

**MVP goal:** `graph-execution suite --feature /abs/backend/.agents/tasks/api:/abs/backend/PRD-api.md --feature /abs/frontend/.agents/tasks/ui:/abs/frontend/PRD-ui.md --provider claude --web`, run from any folder, ends with each repo's result applied as uncommitted changes to the branch it was on, or with nothing applied and every result left on its `suite/<id>`.

## 2. Mission

Let one suite build and test a change that spans repos, without changing how a single-repo suite or a run behaves.

**Core principles**
1. **One code path.** A single-repo suite is the one-repo case of the new code. There is no second orchestrator.
2. **Features stay single-repo.** Child runs are unchanged runs. Only the suite layer and the review phase learn about several repos.
3. **All or nothing.** A frontend applied without its backend is broken. Either every repo gets its result or none does.
4. **Each repo keeps its own rules.** Its `setup`, `validate`, `REVIEW.md` and `TESTING.md` apply to its own code.
5. **Never lose a branch.** A `clean` run in any of the repos must not delete branches that a live multi-repo suite still needs.

## 3. Target Users

- **Primary:** developers who already use `graph-execution suite` and own a product split across repos, typically a frontend and a backend talking over HTTP.
- **Technical comfort:** high. They work with git, worktrees and several checkouts side by side.
- **Pain points:** today they run one suite per repo. Each side is tested only against the other side's old code, so contract mismatches (a renamed field, a new endpoint) surface only after both are applied by hand.

## 4. MVP Scope

### Core Functionality
- ✅ `--feature <tasks-dir>:<prd>` accepts absolute paths in any repo. A feature's repo is the git root of its task folder.
- ✅ The command runs from any folder, a repo or not.
- ✅ The suite folder lives in `<launch-folder>/.graph-execution/suite-<id>`.
- ✅ One `suite/<id>` branch and integration worktree per repo, with features merged per repo.
- ✅ One cross-repo e2e phase on a combined workspace.
- ✅ The suite commits the fixer's changes in each repo after every fix pass.
- ✅ All-or-nothing apply across repos.
- ✅ `--resume`, `list`, `open`, `clean` work from the launch folder.
- ✅ Today's single-repo suites behave exactly as before, and old `suite.json` files load.
- ❌ A feature that spans repos (one PRD with tasks in two repos).
- ❌ A declared start command per repo (`serve`). Agents start the servers themselves.
- ❌ Repos that are not git repos, or remote repos that are not checked out locally.

### Technical
- ✅ Per-repo fields in `suite.json`, with a schema migration from the current shape.
- ✅ `runReviewPhase` takes a list of repos instead of one `repo` / `integrationWorktree`.
- ✅ The suite passes a free port per repo to the e2e agents (agents already run in their own process group, killed when they exit).
- ❌ Changes to the task runner or scheduler.

### Integration
- ✅ `to-tasks` writes each feature's task folder in its own repo and puts the shared contract in both PRDs.
- ✅ `run-graph` passes absolute paths.
- ❌ Git submodules or monorepo tooling.

## 5. User Stories

1. **As a developer with a frontend and a backend repo, I want one suite to build an API feature and the UI that calls it, so that the UI is tested against the real new endpoint.**
   Example: `export-api` in `~/code/shop-api`, `export-ui` in `~/code/shop-web`. The e2e tester starts both, clicks "Export", and the fixer corrects the field name mismatch in `shop-web`.
2. **As a developer, I want to launch the suite from any folder, so that I don't have to pick one repo as the home.**
   Example: `cd ~/code && graph-execution suite --feature ~/code/shop-api/...:... --feature ~/code/shop-web/...:...`. The suite folder is `~/code/.graph-execution/suite-<id>`.
3. **As a developer, I want nothing applied if any repo can't take its result, so that I never end up with half a change.**
   Example: `shop-web` was switched to another branch while the suite ran. Both results stay on `suite/<id>` in their repos, and the log names `shop-web` as the reason.
4. **As a developer, I want each repo validated with its own commands, so that `pytest` never runs in the frontend.**
   Example: `shop-api` has `"validate": ["pytest"]`, `shop-web` has `"validate": ["npm run build"]`. Each runs in its own integration worktree.
5. **As a developer reviewing the result, I want the suite page and the human review to show diffs grouped by repo, so that I can tell which change goes where.**
6. **As a developer, I want `graph-execution clean` inside `shop-api` to leave a live multi-repo suite's branches alone, so that cleaning one repo doesn't break a running suite.**
7. **As an existing user, I want my single-repo suites and old suite folders to keep working unchanged, so that the feature costs me nothing if I don't use it.**
8. **As an agent user, I want `to-tasks` to split a cross-repo PRD into one feature per repo, so that I can start a multi-repo suite from my agent.**

## 6. Core Architecture & Patterns

### Repo resolution
`validateSuite` (`src/suite/orchestrator.ts:122`) resolves each feature's `tasksDir` and `prd` against `cwd` as today, then sets `feature.repo = repoRoot(tasksDir)`. The PRD may sit outside the repo. The suite's repos are the distinct `feature.repo` values, in first-seen order. A repo is identified by its absolute git root.

Preflight runs per feature with `cwd: feature.repo` instead of the launch folder.

### Layout on disk

```
<launch-folder>/.graph-execution/suite-<id>/
  suite.json  lock  run.log
  features/<run-id>/              # feature runs, as today (via GRAPH_EXECUTION_RUNS_ROOT)
  logs/
  e2e/
    spec.md  tasks/
    workspace/                    # the combined e2e workspace (agents' cwd)
      <repo-name>/                # each repo's integration worktree on suite/<id>
<repo>/                           # every repo of the suite
  suite/<id>                      # branch
  .graph-execution/_suites/<suite-id>.json   # pointer back to the suite folder (see "Cleanup safety")
```

`<repo-name>` is the basename of the git root, with a `-2` suffix on duplicates, as feature names do today. For a single-repo suite there is one entry, and the worktree path stays `worktrees/integration` so existing folders resume.

### Flow
1. **Features.** Each child run is spawned with `cwd: feature.repo` (`defaultSpawn` already takes a `cwd`; `defaultSpawnOf` becomes per feature). `GRAPH_EXECUTION_RUNS_ROOT` keeps its folder under the suite folder. Concurrency is one cap for the whole suite, split as today.
2. **Integration, per repo.** `integrate` runs once per repo over that repo's done features, on that repo's `suite/<id>` and worktree. Features in different repos never conflict.
3. **E2E, once.** `runE2e` builds the combined spec and test plan as today, then calls `runReviewPhase` with every repo. The agents' cwd is `e2e/workspace/`.
4. **Fix commits.** After each fixer pass and each validation fix round, the suite runs `git add -A && git commit` in every repo worktree that changed, with the same message. Validation then reruns only in the repos that changed.
5. **Apply.** First check every repo: it started on a branch (not detached), its checkout is still on that branch, and `suite/<id>` merges into it without conflicts (a `git merge-tree` dry run). If any check fails, apply nothing and leave every result on `suite/<id>`. Otherwise apply each repo in turn with `applyToCheckout`, which stashes and restores uncommitted changes as it does today. If an apply still fails midway, report which repos were applied; there is no undo of an apply that succeeded.

### `runReviewPhase` (`src/review/phase.ts`)
`repo`, `integrationWorktree`, `integrationBranch` and `startingCommit` become `repos: ReviewRepo[]`:

```ts
interface ReviewRepo {
  name: string;               // workspace folder name
  repo: string;               // git root
  integrationWorktree: string;
  integrationBranch: string;
  startingCommit: string;
  config: Config;             // that repo's config: validate, validateParallel, setup
}
```

A run passes one entry, so runs behave as today. `fixBase` / `resetHard` on resume become per repo. The reviewer's context reads `REVIEW.md` and `TESTING.md` from each repo and labels them by repo name. `reviewFiles` (`overlapFiles`) is computed per repo and prefixed with the repo name.

### Patterns
- **Pure single-repo fallback.** Every per-repo structure has length 1 for a single-repo suite. There are no `if (multiRepo)` branches beyond resolution and layout.
- **Schema migration in `suiteStateSchema`.** A `suite.json` without `repos` is read as one repo built from the current top-level fields.

## 7. Features

### 7.1 CLI
No new flag. `--feature` already parses `<tasks-dir>:<prd>`; absolute paths work. Errors:
- A task folder that is not inside a git repo: `--feature <value>: <tasks-dir> is not in a git repo`.
- Two features with the same task folder: an error, as today.

`--resume` must run from the launch folder. It fails with `suite <id>: repo <path> not found` when a recorded repo is missing, is no longer a git repo, or no longer has `suite/<id>` while the suite has started integrating.

### 7.2 `suite.json`
New and changed fields:

```ts
repos: z.array(z.object({
  name: z.string(),
  root: z.string(),                       // absolute git root
  startingCommit: z.string(),
  startBranch: z.string().optional(),     // undefined on a detached HEAD
  integrationBranch: z.string().optional(),
  merged: z.array(z.string()).default([]),// feature names, merge order
  applied: z.object({ files: z.number(), conflicts: z.array(z.string()) }).optional(),
})).min(1),
features: [... { ..., repo: z.string() /* repos[].name */ }],
```

`integration.failed`, `integration.agents`, `review` and `status` stay suite-wide. The current top-level `startingCommit`, `startBranch`, `integrationBranch`, `integration.merged` and `applied` move into `repos[0]` on read when `repos` is missing.

### 7.3 E2E agents and their servers
- The reviewer, tester and fixer run with cwd `e2e/workspace/`, so they see `<repo-name>/` folders. Their prompt lists the repos with their roles (from the PRDs) and says that each folder is a separate git repo.
- Each agent already runs in its own process group (`spawnAgent`, `src/providers/spawn.ts`), killed when the agent exits or is aborted, which takes any `npm run dev` the tester started with it. No new code is needed for this.
- The suite picks one free port per repo and passes `SUITE_PORT_<REPO_NAME>` (upper-cased, `-` → `_`) to the agents. The prompt tells the tester to start each side on its port and to point the frontend at the backend's port.

### 7.4 Config
| Setting | Comes from |
|---|---|
| `setup`, `validate`, `validateParallel`, `validateAt`, `keepRuns` | The feature's repo, for its feature runs and its part of e2e validation |
| `concurrency`, `e2eReview`, `humanReview`, `loopDetection`, `attempts`, `validationRounds`, `fixPasses` | The launch folder's `graph-execution.config.json` if it has one, else CLI flags and defaults |

For a single-repo suite launched inside that repo, both columns are the same file, as today.

### 7.5 Web page and human review
- The suite graph groups feature boxes and merge nodes by repo, under a repo label. One-repo suites draw no label.
- `suiteChangeSources` (`src/suite/changes.ts:46`) computes diffs in each repo. Paths in the combined diff and in review comments are prefixed with the repo name (`shop-web/src/export.ts`).
- The human review shows one combined diff, grouped by repo. A "request changes" round runs the fixer on the combined workspace.

### 7.6 Lifecycle
- **`list`, `open`:** from the launch folder, as today. `list` shows the repos of a multi-repo suite on its line.
- **`clean <suite-id>`:** from the launch folder. Deletes `suite/<id>`, the feature branches and worktrees in every recorded repo, and each repo's pointer file. A repo that can't be found is skipped with a warning. The suite folder is still deleted.
- **Cleanup safety:** each non-launch repo gets `.graph-execution/_suites/<suite-id>.json` with `{ "suiteDir": "<abs path>", "features": ["<run-id>", ...] }`. `scan` (`src/cleanup/scan.ts:139`) treats the branches of a pointed-to suite as known, not orphans, while its suite folder exists. If the folder is gone, those branches become orphans as usual.

### 7.7 Skills
- **`to-tasks`:** given PRDs for several repos, it writes `.agents/tasks/<feature>/` inside each feature's repo. It puts the cross-repo contract (endpoints, payloads, env vars) verbatim in each PRD, and tells the user which repos the suite will span.
- **`run-graph`:** it passes absolute `--feature` paths and runs from the current folder.

## 8. Technology Stack

No new dependencies. TypeScript on Node, as today: `execa` for spawning, `zod` for the schema migration, `vitest` for tests. Free ports come from `node:net` (`listen(0)`).

## 9. Security & Configuration

- **Write scope:** the e2e fixer can edit every repo in the suite, and only those. Its cwd is the workspace, and each folder there is a worktree of a repo the user named.
- **Process cleanup:** killing the agents' process group bounds what the tester leaves running. A process that detaches itself (a daemon, `docker compose up -d`) can survive; this is a documented limit.
- **Env:** `RUN_ENV_UNSET` (`src/state/paths.ts`) still applies to agents and gate commands. The new `SUITE_PORT_*` variables are only set for the e2e agents.
- **No secrets** are added to `suite.json` or the pointer files: only paths, ids and branch names.

## 10. API Specification

No new HTTP endpoints. The suite page's existing JSON gains `repos[]` (name and root) and a `repo` field on each feature and diff source. The pointer file format is in 7.6.

## 11. Success Criteria

**MVP is done when** a two-repo suite with the fake provider runs end to end: two features, one per repo, both integrate, the e2e phase runs on the combined workspace, the fixer's change in one repo is committed there, and both repos get their result applied.

**Functional**
- ✅ A suite with features in two repos, launched from a non-repo folder, applies to both repos.
- ✅ One repo checked out on another branch, or conflicting with its result, means nothing is applied in either, and the log names that repo.
- ✅ Each repo's `validate` commands run only in that repo's worktree.
- ✅ A fixer edit in repo B is committed on B's `suite/<id>`, and A's branch is untouched.
- ✅ `--resume` continues a multi-repo suite stopped in the features, integration or e2e phase.
- ✅ `--resume` fails with a clear error when a recorded repo is gone; `clean` deletes the suite anyway and warns.
- ✅ `clean` inside a non-launch repo leaves a live suite's branches alone.
- ✅ No e2e agent process (or its children) is alive after the phase ends or the suite is aborted.

**Quality**
- ✅ The existing suite and run tests (`src/suite/*.test.ts`, `src/review/*.test.ts`, `src/e2e.test.ts`) pass without being changed, other than mechanical updates for the new `runReviewPhase` signature.
- ✅ A suite folder written before this change resumes.
- ✅ `npx tsc --noEmit`, `npx eslint .`, `npx vitest run` pass.

## 12. Implementation Phases

### Phase 1: Per-repo state and features (about 1–2 days)
**Goal:** features run in their own repos; the rest still assumes one repo.
- ✅ `repos[]` and `feature.repo` in `suiteStateSchema`, with the migration.
- ✅ Repo resolution in `validateSuite`; per-repo preflight; spawn with `cwd: feature.repo`.
- ✅ Suite folder in the launch folder; launching from a non-repo folder works.

**Validation:** old suite folders load; existing suite tests pass; two features in two repos both finish.

### Phase 2: Integration, apply and lifecycle (about 2 days)
**Goal:** a multi-repo suite with `e2eReview: false` works end to end.
- ✅ `integrate` per repo.
- ✅ All-or-nothing apply, checked by a dry run in every repo first.
- ✅ Pointer files, `scan` safety, `clean`/`list`/`open`/`--resume` across repos.

**Validation:** a repo on another branch means nothing is applied; `clean` in a non-launch repo spares live branches.

### Phase 3: Cross-repo e2e (about 3–4 days)
**Goal:** the reason for the feature.
- ✅ `runReviewPhase` takes `repos[]`; runs pass one entry.
- ✅ Combined workspace, per-repo validation, per-repo fix commits, per-repo resume reset.
- ✅ Process groups and `SUITE_PORT_*`.

**Validation:** the fake-provider two-repo e2e test from "MVP is done when"; no processes left alive.

### Phase 4: Page, human review and skills (about 2 days)
- ✅ Repo grouping on the suite page; repo-prefixed diffs and review comments.
- ✅ `to-tasks` and `run-graph` updates; README section on multi-repo suites.

**Validation:** `src/suite/web-e2e.test.ts` with a two-repo suite; a one-repo suite's page is unchanged.

**Size:** about 1.2k–1.8k lines including tests, most of it in phase 3.

## 13. Future Considerations

- A declared `serve` command per repo (`cmd`, `ready` URL, `env`), if agent-started servers prove flaky. About 150 lines.
- Features that span repos: one PRD, tasks tagged by repo, a multi-repo child run.
- A suite manifest file instead of repeated `--feature` flags, once suites have more than a few features.
- A global suite registry so `list` and `open` work from any folder.

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Changing `runReviewPhase` breaks plain runs | Runs pass a one-entry `repos[]`; the run tests must pass unchanged before multi-repo tests are added (phase 3 starts with the refactor alone). |
| Agent-started servers are flaky or clash on ports | Process groups killed at the end; free ports passed as `SUITE_PORT_*`; the `serve` config is the fallback (section 13). |
| `clean` in one repo deletes a live suite's branches | Pointer files in each non-launch repo, honored by `scan`. |
| An apply fails halfway, leaving one repo changed | A dry run in every repo first makes this rare; if it happens, the log names the repos already applied. |
| The frontend feature is built against an API that only exists in the other repo's worktree | `to-tasks` writes the contract into both PRDs; mismatches are what the e2e phase exists to catch and fix. |

## 15. Appendix

- Conversation decisions (2026-10-22): one repo per feature; path-based `--feature`; launch from any folder; suite home in the launch folder; combined e2e workspace; agents start the servers; per-repo fix commits; split config; all-or-nothing apply; one code path; `--resume` fails and `clean` skips on a missing repo; minimal skill updates.
- Related: [07-run-cleanup-and-suite.md](07-run-cleanup-and-suite.md) (the current suite), [06-human-review-round.md](06-human-review-round.md).
- Code: `src/suite/orchestrator.ts`, `src/suite/integrate.ts`, `src/suite/e2e.ts`, `src/suite/state.ts`, `src/suite/changes.ts`, `src/suite/server.ts`, `src/review/phase.ts`, `src/cleanup/scan.ts`, `skills/`.
