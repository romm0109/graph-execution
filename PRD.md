# PRD: graph-execution — Dependency-Graph Task Executor for AI Coding Agents

## 1. Executive Summary

`graph-execution` is an npm CLI that executes a folder of tasks arranged as a dependency graph (DAG) using headless AI coding agents (Claude Code, Codex, OpenCode). Each task is a JSON file with an `id`, `content` and `dependencies`. Independent tasks run in parallel, each in its own git worktree. Finished tasks are merged into an integration branch, which unlocks their dependents.

After every task has merged, an automated review phase runs. Deterministic validation commands (`tsc`, `eslint`, build) act as a cheap gate. A code reviewer (guided by the optional `REVIEW.md`) and a live tester (guided by the optional `TESTING.md`, which really exercises the API or UI) run in parallel; both judge the result against a required PRD (`--spec`) and emit structured JSON reports. A fixer agent consumes the reports, and the loop repeats up to a bounded number of rounds.

The terminal shows the live graph, per-node state, the current phase and a tail of the focused agent's output.

**Value proposition:** turn a task breakdown (for example the output of an "issues" skill) into a reviewed, validated, integrated branch with minimal human involvement, while keeping cost bounded and the run resumable.

**MVP goal:** given a valid task folder, a PRD and a provider, produce a `graph/<run-id>` branch that passes the validation commands and has no blocker or major review findings, or stop with a clear, resumable state and report.

## 2. Mission

Make multi-task AI-driven development reliable, observable and resumable by treating the work as an explicit dependency graph rather than one long agent session.

**Core principles**
1. **Git is the source of truth.** State records intent, git records what happened, and on resume git wins.
2. **Deterministic gates before AI gates.** Validation commands run before the reviewers, so the expensive steps never see code that does not build.
3. **Bounded everything.** Every agent invocation, validation gate and review loop has an explicit retry or round budget.
4. **Observable.** The user always knows what is running, what failed and why.
5. **Never touch the user's branch.** Output lands on an integration branch for the human to merge.

## 3. Target Users

- **Primary:** developers already using AI coding CLIs (Claude Code, Codex, OpenCode) who break features into tasks and want them executed in parallel and unattended.
- **Technical comfort:** high. They are comfortable with git, worktrees, npm and CLI configuration files.
- **Needs and pain points:**
  - Long single-agent sessions drift and cannot be parallelized.
  - Agents stop suddenly and need manual restarts.
  - Reviewing and fixing AI output is manual and repetitive.
  - No visibility into what parallel agents are doing.

## 4. MVP Scope

### In Scope

**Core Functionality**
- ✅ Load and validate a folder of task JSON files (cycles, missing dependencies, duplicate ids)
- ✅ DAG scheduler with a configurable concurrency cap (default 3)
- ✅ One git worktree per task, branched from the integration branch
- ✅ Serialized merge into `graph/<run-id>`, with an AI conflict resolver only on conflicts
- ✅ Validation gate after each task and in the review loop (commands run directly, not through AI)
- ✅ Review phase: code reviewer and live tester in parallel, JSON reports
- ✅ Fixer agent and a bounded review loop
- ✅ Uniform retry policy: 3 attempts per agent invocation
- ✅ Resume from persisted state (`--resume`)
- ✅ Startup checks (see 7.11) and graceful abort on Ctrl+C or exhausted retries

**Technical**
- ✅ TypeScript on Node, Ink TUI
- ✅ Provider adapters that spawn headless CLIs in full-auto mode, with the worktree as their working directory
- ✅ Atomic state file plus git reconciliation
- ✅ Per-agent logs on disk

**Integration**
- ✅ Providers: Claude Code, Codex, OpenCode (one provider per run)
- ✅ `graph-execution.config.json` (`setup`, `validate`), optional `REVIEW.md` and `TESTING.md`, required `--spec` file (PRD)
- ✅ `graph-execution install skills`: installs the bundled `to-issues` skill (AFK-only, emits task JSON, ships a validation script)

**Deployment**
- ✅ Published to npm as a CLI (`npx graph-execution`)

### Out of Scope
- ❌ Per-role provider mixing (for example Codex for tasks and Claude for review)
- ❌ Automatic PR creation
- ❌ Fast-forwarding into the user's current branch
- ❌ Optional fixer "won't fix" responses
- ❌ Cost and token budgets (`--max-review-cost`)
- ❌ Interactive pause-and-ask flows
- ❌ Sandbox or `--safe` permission mode
- ❌ Web dashboard
- ❌ Providers beyond the three listed

## 5. User Stories

1. **As a developer, I want to point the tool at a folder of tasks, so that they execute in dependency order without me orchestrating them.**
   Example: `tasks/1.json` has no dependencies, `2` and `3` depend on `1`, and `4` depends on `2` and `3`. Tasks 2 and 3 run in parallel after 1 merges.
2. **As a developer, I want independent tasks to run in parallel in separate worktrees, so that the run finishes faster and agents cannot clobber each other.**
   Example: with `--concurrency 3`, tasks 2 and 3 run at the same time in `.graph-execution/<run-id>/worktrees/task-2-a1` and `.../task-3-a1`.
3. **As a developer, I want a task's dependents to see its code, so that downstream work builds on upstream work.**
   Example: task 4's worktree is created from `graph/<run-id>` after 2 and 3 merged.
4. **As a developer, I want build, lint and type errors caught automatically, so that I don't pay for AI review of broken code.**
   Example: `validate: ["tsc --noEmit", "eslint ."]` fails and the errors are fed back to the task agent.
5. **As a developer, I want a code reviewer and a live tester to check the integrated result, so that conventions are followed and the feature actually works.**
   Example: the tester boots the API per `TESTING.md` and calls the endpoints.
6. **As a developer, I want a bounded fix loop, so that the tool does not spend indefinitely on nitpicks.**
   Example: only blockers and majors trigger another round, and minors are listed in the final report.
7. **As a developer, I want crashed or silently stopped agents retried automatically, so that I do not babysit unreliable runs.**
   Example: an agent exits with no commit and is retried up to 3 times.
8. **As a developer, I want to resume an aborted run, so that a failure late in the graph does not discard earlier work.**
   Example: `graph-execution --resume` skips merged tasks and retries the failed one.
9. **As a developer, I want to see the graph and live status in my terminal, so that I know exactly what is running.**
10. **As a developer, I want to install a skill that turns a PRD into valid task JSON files, so that I do not write the task folder by hand.**
   Example: `graph-execution install skills` puts `to-issues` in `.agents/skills/`. The agent runs it, writes `.agents/tasks/*.json`, and runs the skill's validation script until it passes.

## 6. Core Architecture & Patterns

**Approach:** an orchestrator process with a state machine per task and per review phase, a pluggable provider adapter, and a git service. All progress is written to `.graph-execution/<run-id>/state.json`.

```
src/
  cli.ts                 # argument parsing, entry
  config/                # graph-execution.config.json, REVIEW.md, TESTING.md loading
  graph/                 # task loading, validation (cycles, deps), ready-set computation
  scheduler/             # concurrency-capped execution of ready tasks
  git/                   # worktrees, branches, merge, reconciliation
  providers/             # Provider interface + claude, codex, opencode adapters
  agents/                # task, resolver, reviewer, tester, fixer prompts and runners
  validate/              # setup/validate command runner (no AI)
  review/                # review loop, report schema
  state/                 # atomic state file, lock file, resume reconciliation
  ui/                    # Ink components: graph, phase bar, log tail
  install/               # `install skills` command
skills/
  to-issues/             # bundled skill: SKILL.md + validate-tasks.mjs (copied by `install skills`)
.graph-execution/<run-id>/
  state.json  lock  logs/  reports/round<N>/{code,tester}.json  worktrees/
```

**Key patterns**
- **Provider interface:** `run({prompt, cwd, signal}) -> AsyncIterable<event> + result`. Each adapter maps to `claude -p`, `codex exec` or `opencode run` in full-auto mode.
- **Uniform retry wrapper:** every agent invocation passes through `withRetries(3)`, with failure classes: crash, no commit, invalid report.
- **Success detection:** a task succeeds only if a new commit exists in its worktree.
- **State machine transitions** are persisted before and after side effects, and git reconciliation repairs the gaps.
- **Single-writer merges:** a mutex serializes merges, performed in the integration worktree (the only checkout of `graph/<run-id>`).

## 7. Tools/Features

### 7.1 Task Graph
Task file `tasks/<id>.json`:
```json
{ "id": "4", "content": "Implement the export endpoint...", "dependencies": ["2", "3"], "validate": null }
```
`content` is Markdown and carries everything the task agent needs (it is the only thing the agent sees), for example the full self-sufficient issue text. `validate` is an optional per-task override: a command list, `false` to skip validation for this task, or `null`/absent to use `config.validate`.

### 7.2 Task Execution
Prompt = the task's own content + the instruction to commit when done. Dependency descriptions are not included (their code is already in the worktree), and neither is the spec. Up to 3 attempts, each in a fresh worktree. After success, the validation gate runs: failures return to the same agent for up to 3 rounds. Then the branch merges into `graph/<run-id>`.

### 7.3 Merge Resolver
Invoked only when `git merge` conflicts. 3 attempts. A failure aborts the run.

### 7.4 Validation Gates
Commands from `config.validate` run directly (no AI). Failing output is truncated to the relevant tail and fed back to the agent. Gates run after each task and before the reviewers on each review round.

### 7.5 Reviewers
A single integration worktree stays checked out on `graph/<run-id>` for the whole run, because git does not allow one branch to be checked out in two worktrees. Merges happen there, and the fixer commits to it.

**Reviewers never touch the integration worktree.** Each review round, the code reviewer and the live tester each get their own throwaway worktree, created detached at the current head of `graph/<run-id>`, with `setup` run in it. They read the code and boot the app from their own copy, so a stray edit by one cannot affect the other or the branch. Each reviewer writes its report to `.graph-execution/<run-id>/reports/round<N>/` (outside its worktree), and its worktree is deleted when it finishes. After both finish, the tool checks that the head of `graph/<run-id>` is unchanged. If it moved, the run aborts. No provider-specific tool blacklists are used.

- **Code reviewer:** reads `REVIEW.md` (conventions, optional) and reviews the integrated diff. Without `REVIEW.md` it applies general review rules (bugs, security, correctness).
- **Live tester:** reads `TESTING.md` (optional: how to boot the app, endpoints and URLs, credentials, checks) and exercises the API, or uses a browser tool for UIs. Without `TESTING.md` it makes a best-effort attempt from the README and package scripts. If it cannot run the app, it records an informational note in its report ("live test not performed"), the final summary mentions it, and it never fails the run.
- **Where the files come from:** `REVIEW.md` and `TESTING.md` are read by the tool from the repo root at startup and passed to the reviewers in their prompts, so they work even when they are not committed (the throwaway worktrees only contain committed files).
- **Both files are optional.** A repo without `REVIEW.md` or `TESTING.md` is valid. It never causes an error or an abort, at most a one-line notice in the TUI.

#### Reviewer context
Both reviewers receive the same intent context so they judge the result against what was asked for:
- **The spec (required):** the PRD given with `--spec <file>`, included in full. It is the statement of intent, so the reviewers judge the result against what was asked for.
- **The tasks folder path:** the reviewers are told where the task JSON files are and may read them if they want. The task contents are not pasted into the prompt.
- **Code reviewer only (in addition):** the diff of `graph/<run-id>` against the starting commit recorded at startup and `REVIEW.md` if present. It can read the repo freely.
- **Live tester only:** `TESTING.md` if present, and the list of changed files as a hint for what to exercise. It tests behavior and does not need the diff.
- **Rounds 2 and later:** the previous round's report and the fixer's commit summary.
- **Not included:** agent logs from the task phase, since they are noisy and bias the reviewers.
- **Report format:** JSON with a schema. A Markdown rendering is shown in the TUI.
```json
{ "round": 1, "reviewer": "code", "findings": [
  { "id": "F1", "severity": "blocker|major|minor", "file": "src/a.ts", "line": 42,
    "description": "...", "failureScenario": "...", "suggestedFix": "...",
    "status": "open|fixed|not_fixed" } ] }
```
- **Findings without a concrete failure scenario** are downgraded to minor.
- **Rounds 2 and later:** reviewers first verify the previous findings, then may add only new blocker or major findings.

### 7.6 Fixer and Review Loop
The fixer receives both reports and the spec (so it can pick a fix consistent with the PRD when a suggested fix would contradict it; it cannot decline a finding) and commits fixes. The validation gate then runs, and up to 3 validation rounds do not consume a fix pass. The loop is: review, then up to 3 fix passes, each followed by a re-review (so at most 4 reviews in total). It ends clean as soon as a review shows zero open blockers or majors. If the final re-review still has any, the run ends with exit code 1. Minors go to the final report.

### 7.7 Retry Policy (every agent)
| Agent | Failure | Attempts |
|---|---|---|
| Task / Fixer | crash, no commit | 3 |
| Merge resolver | crash, conflict markers left | 3 |
| Reviewer / Tester | crash, invalid or missing report | 3 (only that reviewer reruns) |

Exhausted retries abort the run with state kept.

**Abort and Ctrl+C behavior (same path):** stop launching new work, terminate running agents, flush the state file, keep all worktrees and logs, print the failing step and how to resume. No cleanup happens on abort.

### 7.8 Resume
`--resume [--run <id>]` loads the state, verifies the config, task and spec hashes, and reconciles with git: `merged` tasks must have their merge commit present, `merging` tasks are checked, and `running` or `validating` tasks get a fresh worktree with the attempt counter kept, and leftover reviewer worktrees are discarded and recreated. It rebuilds the ready set and continues the review phase from the saved round and step. Valid existing reports are not regenerated. A task that failed gets a fresh 3 attempts. A lock file with a PID prevents concurrent resumes.

### 7.9 Terminal UI
- DAG with node states: pending, running (spinner), retry N/3, validating, merging, merged, failed.
- Phase bar: tasks, validate, fix pass N/3, fixer.
- Live tail of the focused agent's output, switchable with arrow keys.
- Final summary: branch name, minors, next steps.

### 7.10 CLI
```
graph-execution <tasks-dir> --spec <prd-file> --provider claude|codex|opencode [--concurrency 3] [--model <m>]
graph-execution --resume [--run <id>]
graph-execution install skills [--target agents|claude|both] [--force]
```

### 7.11 Startup Checks and End of Run

**Startup checks (fail fast, before any agent runs):**
- Inside a git repo. If the working tree has uncommitted changes, print a warning that the agents will not see them (worktrees are cut from committed state) and continue.
- The selected provider CLI is on the PATH.
- `--spec` is present, readable and non-empty. The task folder is valid (graph validation).
- `.graph-execution/` is added to `.git/info/exclude` (local, uncommitted), so run state and nested worktrees never make the working tree look dirty on the next run.
- The starting commit is recorded in the state as the base for the final diff.

**End of run**
- **Success:** worktrees are removed and the branch `graph/<run-id>` is left. The summary lists the branch, the minor findings and the next steps. Exit code 0.
- **Review loop exhausted** (still blockers or majors after the 3rd fix pass): exit code 1. The branch, worktrees and reports are kept.
- **Abort** (retries exhausted, merge resolver failed, validation exhausted): exit code 2. Everything is kept, ready for `--resume`.

### 7.12 Skill Installation

`graph-execution install skills` copies the bundled `to-issues` skill into the directory where the command is run:
- `--target agents` (default) installs into `.agents/skills/to-issues/`. `--target claude` installs into `.claude/skills/to-issues/` (where Claude Code discovers project skills). `--target both` installs into both.
- If the destination folder already exists the command refuses with a message. `--force` overwrites it.
- **The skill** is the `to-issues` skill we used, without the HITL/AFK distinction (every slice is AFK). It still explores the codebase, drafts vertical slices and quizzes the user. Instead of Markdown issue files it writes one task JSON file per slice, `.agents/tasks/<id>.json`, in the format of 7.1, where `content` is the full self-sufficient issue text as Markdown and `dependencies` lists the ids of the blocking slices.
- **The validation script** `validate-tasks.mjs` ships inside the skill folder. It is a standalone Node script with no dependencies that applies the same rules as the tool (schema, duplicate ids, unknown dependencies, self-dependency, cycles) and exits non-zero with every problem listed. The skill instructs the agent to run it at the end and fix the files until it passes. A test runs the script and the tool's own validator against the same fixtures so they cannot drift apart.

## 8. Technology Stack

- **Runtime:** Node.js 20+ (LTS), TypeScript 5.x
- **TUI:** Ink (React for CLIs)
- **Libraries (proposed):** `execa` (subprocesses), `simple-git` or direct git CLI calls, `zod` (task and report schemas), `commander` or `yargs` (CLI), `proper-lockfile` or a PID lock, `vitest` (tests)
- **Provider CLIs (user-installed):** Claude Code, Codex, OpenCode
- **Optional:** a browser automation CLI for the live tester when the target is a UI
- **Packaging:** npm, with `bin` entry, ESM

## 9. Security & Configuration

**Configuration**
- `graph-execution.config.json`: `setup` (commands run once per worktree, for example `npm ci`), `validate` (gate commands), optional `concurrency` and retry and round numbers (defaults: 3 attempts, 3 validation rounds, 3 fix passes).
- `REVIEW.md` and `TESTING.md` at the repo root. Both are optional, and their absence is never an error.
- `--spec <file>`: required PRD given to the reviewers. The run refuses to start if the flag is missing or the file is unreadable or empty. Its hash is stored in the state file and checked on resume.
- Provider authentication relies on the user's existing CLI login. The tool stores no credentials.

**Security scope**
- In scope: agents run in full-auto mode with their worktree as the working directory (this is not a sandbox), with a clear warning at startup. The tool itself never pushes, never touches the user's current branch, and never writes outside `.graph-execution/` and git worktree and branch metadata.
- Out of scope: sandboxing against malicious tasks or prompts, secret redaction in logs, and network isolation. Full-auto agents can run arbitrary commands, so tasks must be trusted.

**Deployment:** published to npm. Requires git and the selected provider CLI on the PATH.

## 10. API Specification

Not applicable (CLI). The contracts are the task JSON, the state file, the config file and the report schema defined above. All are validated with zod at load time.

## 11. Success Criteria

**MVP success:** an end-to-end run on a sample 4-task diamond graph produces `graph/<run-id>` that passes `validate` with no open blockers or majors.

**Functional requirements**
- ✅ Invalid graphs are rejected before any agent runs
- ✅ Independent tasks run concurrently up to the cap
- ✅ A dependent task's worktree contains all of its dependencies' code
- ✅ Validation failures are fed back to the agent without AI judgement
- ✅ Every agent type retries up to 3 times, and exhaustion aborts the run
- ✅ The review loop stops on zero blockers and majors, or after the 3rd fix pass and its re-review
- ✅ `--resume` after a kill at any step yields the same final result without repeating completed work
- ✅ The user's current branch is never modified
- ✅ A missing `REVIEW.md` or `TESTING.md` never errors or aborts, while a missing `--spec` refuses to start
- ✅ Exit codes are 0 (success), 1 (review loop exhausted) and 2 (abort)
- ✅ `install skills` refuses to overwrite without `--force`, and the installed validation script accepts exactly the task folders the tool accepts

**Quality indicators:** unit tests for graph validation, scheduler and retry wrapper. Integration tests with a fake provider that can crash, stop without committing, conflict and produce invalid reports. A resume test that kills the process at each state transition.

**UX goals:** at any moment the TUI shows the running nodes, phase and retry counters, with no frozen-looking state.

## 12. Implementation Phases

### Phase 1: Foundation
**Goal:** graph, state and providers without the review phase.
- ✅ Task loader, graph validation and startup checks
- ✅ Provider interface with one adapter (Claude Code) and a fake provider for tests
- ✅ Worktree and branch management
- ✅ Sequential task execution, commit detection and retry wrapper
**Validation:** a linear 3-task graph completes with the fake provider and a real provider.

### Phase 2: Parallel Execution & Integration
**Goal:** parallel scheduler, merging and validation gates.
- ✅ Concurrency-capped scheduler
- ✅ Serialized merges into the integration branch and the AI conflict resolver
- ✅ `setup` and `validate` runners with feedback to the task agent
- ✅ Codex and OpenCode adapters
**Validation:** the diamond graph runs with parallel branches, merges and validation feedback.

### Phase 3: Review Loop
**Goal:** reviewers, fixer and loop control.
- ✅ Integration worktree for merges and fixes, throwaway reviewer worktrees, report schema, and the code reviewer (optional `REVIEW.md`)
- ✅ Live tester (optional `TESTING.md`)
- ✅ Spec and tasks-folder context for reviewers
- ✅ Fixer, severity gating, verify-then-add rules
- ✅ Review-phase validation gate
**Validation:** a seeded bug is found, fixed and verified within the 3 fix passes.

### Phase 4: Resume, TUI & Release
**Goal:** durability and visibility.
- ✅ State persistence, locking, git reconciliation and `--resume`
- ✅ Ink TUI (DAG, phase bar, log tail) and final summary
- ✅ Crash-at-every-transition resume tests
- ✅ `install skills` command and the bundled `to-issues` skill with its validation script
- ✅ npm packaging and README
**Validation:** kill-and-resume test suite passes. A manual end-to-end run is clean.

## 13. Future Considerations
- Per-role provider selection
- Automatic PR creation and optional fast-forward modes
- Cost and token budgets, and fixer "won't fix" responses
- Sandboxed or `--safe` permission modes
- More providers
- Web or HTML run report

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Reviewer produces endless nitpicks and burns the rounds | Severity gating, evidence requirement, verify-then-add rules |
| Provider CLI flags or output formats change | Thin adapters behind one interface, adapter-level contract tests, version checks at startup |
| State and git disagree after a crash | Atomic state writes, git-wins reconciliation, kill-at-every-transition tests |
| Merge conflicts between parallel tasks | Dependencies make conflicts rare, the resolver handles the remainder, and failure aborts safely and resumably |
| Full-auto agents act destructively | Each agent works in its own worktree, the tool itself never pushes or touches the user's branch, output lands on a separate branch, and there is a clear startup warning. Agents are not sandboxed |
| Fresh worktrees lack dependencies (`node_modules`) | The `setup` command runs per worktree |
| Uncommitted changes in the user's tree are ignored by worktrees | Startup prints a warning and continues |
| Live tester cannot boot the app | `TESTING.md` is recommended guidance. Without it the tester tries best-effort, and if it still can't run the app it records an informational note and the run continues |

## 15. Appendix
- **Related inputs:** the bundled `to-issues` skill (installed with `install skills`) that emits task JSON (`id`, `content`, `dependencies`).
- **Key dependencies:** Ink, zod, execa, git (worktrees), and the Claude Code, Codex and OpenCode CLIs.
- **Assumptions:** library choices, Node 20+, default concurrency 3 are proposals to be confirmed during implementation.
