# Anthropic on agentic coding and multi-agent orchestration (2025 to Nov 2026), and what graph-execution can take from it

Research date: 2026-11-10. All dates are publication dates unless marked otherwise. The engineering index (https://www.anthropic.com/engineering) lists 28 posts. Posts read in full for these notes: the harness-design posts, Managed Agents, the C compiler post, auto mode, containment, agent memory, the multi-agent research system, advanced tool use, sandboxing and measuring agent autonomy. Claude Code docs read: agent teams, headless/`-p`, Agent SDK overview, dynamic workflows and Code Review. API docs read: context editing and compaction.

## 1. Claude Code features (2025-2026) and which ones graph-execution can use

### Takeaway
Claude Code now ships, as product features, much of what graph-execution builds by hand:
- dynamic **workflows**: a JS script that orchestrates up to 1,000 subagents, with resume, schemas and prompt-cache sharing;
- **agent teams**: a shared task list with dependencies, mailboxes and quality-gate hooks;
- managed **Code Review**: find, verify, rank, post.

The headless CLI and the Agent SDK expose what an orchestrator needs: stream-json events, JSON-schema structured output, cost per run, session resume, permission modes and budgets. graph-execution's edge is what these lack: a persistent DAG across many features with git-worktree isolation, a merge/integration branch, validation gates, a PRD-driven review loop, a live tester, multiple providers, and a human review UI.

### Cited Findings

**Dynamic workflows** (Claude Code docs, current as of Nov 2026)
- A workflow is "a JavaScript script that orchestrates many subagents at once". Claude writes it and a runtime runs it in the background. Uses: codebase-wide sweeps, 500-file migrations, cross-checked research. — [Workflows docs](https://code.claude.com/docs/en/workflows)
- Script API:
  - `agent(prompt, {schema, label, stallMs})`, `pipeline(items, fn)`, `parallel(tasks)`, `phase(title)`, `log()`, plus an `args` global.
  - `agent()` resolves to `null` when the agent is stopped or fails, and `pipeline()` keeps those nulls.
  - With a `schema`, a subagent returns JSON. The schema is checked for contradictions first, and output is retried up to 5 times (`MAX_STRUCTURED_OUTPUT_RETRIES`).
  - `Date.now()` and `Math.random()` throw inside scripts, so a relaunch replays the same calls deterministically.
  — [Workflows docs](https://code.claude.com/docs/en/workflows)
- Limits:
  - Default 16 concurrent agents (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, 1 to 256).
  - At most 4,096 items per `parallel()` or `pipeline()` call, and 1,000 agents per run.
  - No mid-run user input: "For sign-off between stages, run each stage as its own workflow."
  - A "Large workflow" warning appears above 25 agents or 1.5M projected tokens.
  — [Workflows docs](https://code.claude.com/docs/en/workflows)
- Resume semantics: completed agents return cached results until the first agent whose prompt differs. That agent and every later one rerun, as does a failed agent and everything after it, "even ones that completed". Results persist under `~/.claude/projects/`, and in cloud sessions they survive VM reclaim. — [Workflows docs](https://code.claude.com/docs/en/workflows)
- Stall handling: an agent whose output stops arrives restarts from the same prompt without its transcript, up to 5 times. Files it already changed stay changed. `stallMs` is set per agent, and `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` sets it globally. — [Workflows docs](https://code.claude.com/docs/en/workflows)
- Usage limits: a run that hits a claude.ai usage limit pauses until the reset (v2.1.271+). This applies to interactive sessions only, not to `-p` or the SDK. — [Workflows docs](https://code.claude.com/docs/en/workflows)
- Prompt caching in a fan-out: agents with the same model, effort, agent type, tools, schema and working directory share a cache prefix. Claude Code holds sibling agents until the first agent's response begins (`CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS`, default 5000) so their first requests read the cache. The subagent cache TTL is 5 minutes by default, and `subagentPromptCacheTtl: 1h` extends it. — [Workflows docs](https://code.claude.com/docs/en/workflows)
- Quality patterns the docs name: adversarial verification of findings, multi-angle planning, "keep fixing until check passes or two rounds make no progress", "stop once two rounds find nothing new", and per-file review merged into one ranked summary. `/deep-research` "votes on each claim" and lists unverifiable claims as unverified, not refuted. — [Workflows docs](https://code.claude.com/docs/en/workflows)
- `ultracode` (keyword or `/effort ultracode`) makes Claude plan a workflow for each substantive task, often understand, then change, then verify. Saved workflows live in `.claude/workflows/` and plugins can ship them. — [Workflows docs](https://code.claude.com/docs/en/workflows)
- Anthropic also published a blog post, "A harness for every task: dynamic workflows in Claude Code" (linked from the Agent SDK overview). This session could not fetch it: the redirect host claude.dev is not reachable from here. — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- Implication for graph-execution:
  - Workflows overlap heavily with graph-execution's "run a DAG of agents" core, but they run inside one Claude session, with no git-worktree-per-task, no merge or integration step, no multi-provider support and no human review UI. Position graph-execution as the durable, multi-feature, git-native layer above them.
  - Copy specific mechanics:
    - Deterministic replay resume, where completed tasks are cached unless their prompt or inputs changed. graph-execution could hash each task's content plus its dependency outputs.
    - Stall detection with a capped number of automatic restarts. This complements the existing loop and idle detection.
    - A staggered start for siblings that share a prompt prefix, to share the cache.
    - Explicit run-size and token warnings before launch.
    - "Two rounds without progress" as the stop rule for the fixer loop.
  - Consider letting a task type be "run a Claude Code workflow" for large fan-out subtasks such as migrations.

**Agent teams** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)
- A lead session plus teammates, each a full Claude Code instance with its own context.
- A shared task list with pending, in-progress and completed states, plus dependencies: blocked tasks are not self-claimed and unblock automatically.
- Task claiming uses file locking. Mailboxes are JSON files at `~/.claude/teams/{team}/inboxes/{agent}.json`.
- Quality-gate hooks: `TeammateIdle`, `TaskCreated` and `TaskCompleted`. Exit code 2 blocks the event and sends feedback.
— [Agent teams docs](https://code.claude.com/docs/en/agent-teams)
- Limitations:
  - Teams need an interactive session: "In non-interactive mode with the -p flag, including Agent SDK sessions, Claude doesn't spawn teammates."
  - No resume of in-process teammates, task status can lag, there are no nested teams, and the lead is fixed.
  - Docs advice: 3-5 teammates, 5-6 tasks per teammate, and "Two teammates editing the same file leads to overwrites".
  — [Agent teams docs](https://code.claude.com/docs/en/agent-teams)
- Security: a message from another agent is marked as coming from another Claude session. A teammate cannot approve permissions on the user's behalf. In auto mode the classifier treats relayed approval claims as untrusted and screens inter-agent messages. — [Agent teams docs](https://code.claude.com/docs/en/agent-teams)
- Implication for graph-execution: teams are not usable from headless spawns, so graph-execution's own scheduler stays necessary. Adopt the hook-style gates: a "TaskCompleted" gate that can reject completion with feedback maps onto validation commands that return feedback to the same agent session. Also adopt the rule that agent-to-agent messages, for example reviewer to fixer, are marked untrusted data, not instructions.

**Headless mode (`claude -p`) and the Agent SDK**
- Output formats are `text`, `json` and `stream-json`. `--json-schema` makes the result carry a `structured_output` field. When the run fails to produce valid output that field is absent, so callers must check for it. — [Headless docs](https://code.claude.com/docs/en/headless)
- The JSON result includes `total_cost_usd` and a per-model cost breakdown. These are client-side estimates. With `--resume` the figures cover the whole conversation. — [Headless docs](https://code.claude.com/docs/en/headless)
- stream-json events:
  - `system/init` carries the model, tools, `mcp_servers`, `mcp_server_errors`, `plugins`, `plugin_errors`, and a `capabilities` array for feature detection.
  - `system/api_retry` carries attempt, retry delay and error category.
  - `permission_denied` events and a `permission_denials` list arrive in the result.
  - Subagent messages carry `parent_tool_use_id`, and `--forward-subagent-text` includes their text.
  - The last event is a `result` with cost and session metadata.
  — [Headless docs](https://code.claude.com/docs/en/headless)
- Unattended runs:
  - `--permission-mode auto|dontAsk|acceptEdits`.
  - `--permission-prompts none` (v2.1.259+) denies anything that would prompt and tells Claude not to retry.
  - `-p` runs start in Manual mode when nothing sets a mode (v2.1.302+).
  - `--max-budget-usd` caps spend.
  - `--bare` skips CLAUDE.md, hooks, skills, plugins, MCP and auto memory. It is "recommended mode for scripted and SDK calls, and will become the default for `-p`". It requires an API key, not a subscription login.
  — [Headless docs](https://code.claude.com/docs/en/headless)
- Security caveat: without `--bare`, a `-p` session runs a project's `.claude/settings.json` hooks and connects its `.mcp.json` servers "even in a folder you've never trusted". — [Headless docs](https://code.claude.com/docs/en/headless)
- Signals and resume:
  - SIGTERM exits 143 and leaves the turn unfinished.
  - SIGINT or the SDK's `interrupt()` ends the turn cleanly.
  - `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` continues an interrupted turn on resume.
  - `--resume <session_id>` works from any directory, and also accepts a path to a `.jsonl` transcript.
  — [Headless docs](https://code.claude.com/docs/en/headless)
- Agent SDK:
  - TS and Python packages that run the Claude Code binary, with built-in tools, hooks, subagents, MCP, permissions (`canUseTool`), sessions (resume and fork), skills and plugins.
  - Third parties may not offer claude.ai login or rate limits unless approved, so an API key is required.
  - Branding: a product may not call itself "Claude Code".
  — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- Recent changelog items relevant to an orchestrator (only the newest roughly 100KB of a 1.19MB changelog was read):
  - 2.1.314: `claude -p` prints startup errors and exits 1 instead of exiting 0 with no output. `permissions.blockWritesOutsideWorkingDirectories` added.
  - 2.1.317: fixed `-p` exiting 0 on a full disk. Added `onFailure: "block"` for SDK hook callbacks.
  - 2.1.318: `-p` JSON includes `credential_expires_at`. Background subagents move long shell commands to the background after 3 minutes to keep the cache warm.
  - 2.1.319: `permissions.denyInsteadOfPrompting`. `-p --resume` exits 1 when a deferred tool's MCP server is missing.
  — [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Implication for graph-execution: for the Claude provider, either move to the TS Agent SDK, which is native to this TypeScript codebase, or at least standardise on `-p --output-format stream-json --verbose --bare --json-schema --max-budget-usd --permission-prompts none`. Concrete wins:
  1. **Structured task results.** A per-task JSON schema (status, summary, files touched, open questions, blockers) replaces parsing free text for failure summaries and reviewer verdicts. Reviewers would emit `{severity, file, line, rationale}` arrays, which removes the need for brittle prompt parsing.
  2. **Per-task and per-run cost and token accounting** from `total_cost_usd` and `modelUsage`, shown in the web view, with budget caps per task, review pass and run.
  3. **Session resume.** Store `session_id` per task, then retry or "fix" with `--resume` instead of a cold start, which keeps the context and the prompt cache. Fork sessions for reviewer to fixer handoffs.
  4. **Health gates.** Fail fast on `mcp_server_errors` or `plugin_errors` in `system/init`, and surface `api_retry` events in the live view.
  5. **`--bare` for reproducibility and safety** in worktrees cloned from untrusted repos, especially in graph-manager.
  6. **Clean stop.** Send SIGINT before SIGTERM so aborts leave a resumable transcript.
  7. **Tight permissions.** `--permission-mode auto` plus `--permission-prompts none` as the default.

**Code Review (managed product) and local review**
- Several agents examine the diff and surrounding code in parallel. A verification step filters false positives, then findings are deduplicated, ranked by severity, and posted as inline comments plus a check run.
- Review levels are Quick, Standard and Deep. By default it focuses on correctness, "not formatting preferences or missing test coverage".
- It never approves or blocks a PR. It reads `REVIEW.md` from the base branch, "never from the pull request's own changes".
- Team and Enterprise plans only. There is also local `/code-review` and Ultrareview (cloud sandbox).
— [Code Review docs](https://code.claude.com/docs/en/code-review)
- Implication for graph-execution:
  - Add an explicit **verify** stage between reviewers and fixer: an independent agent re-checks each blocker or major against the code and drops false positives before the fixer spends a pass on them.
  - Deduplicate and rank findings across reviewers.
  - Read reviewer guidance (a REVIEW.md-like file, custom reviewer configs) only from the base commit, never from the agent-produced diff, so agents cannot weaken their own review.
  - Offer quick, standard and deep review levels as a cost knob.

### Inferences
- Product direction: Anthropic is moving orchestration into scripts ("the script holds the plan") with deterministic replay, and away from LLM-as-orchestrator turn by turn. graph-execution's static task DAG is aligned with this.
- The gaps graph-execution can own are cross-provider support, git-worktree isolation with real merges, a PRD-driven acceptance review, a live app tester, and human-in-the-loop review comments. Workflows explicitly lack mid-run human input.
- Because `--bare` will become the `-p` default, graph-execution should pass project context (CLAUDE.md content, skills) explicitly with `--append-system-prompt-file` and `--plugin-dir`, or tasks will silently lose it after that change.

### Gaps
- The "dynamic workflows" blog post (claude.com → claude.dev) could not be fetched from this environment, so its internal numbers are not captured.
- Only the newest roughly 100KB of the changelog was read. The dates when subagents, hooks, skills, plugins, checkpoints and Claude Code on the web first shipped (2025) were not verified here.
- The Agent SDK's TS API details (session fork API, file checkpointing, cost-tracking objects) were not read beyond the overview page.

## 2. Engineering blog lessons applicable to an orchestrator

### Takeaway
Anthropic's harness research converges on a few patterns:
- a planner that expands a short prompt into a spec;
- a generator that works incrementally from a structured feature list, keeps a progress file and commits to git;
- a separate, tuned-to-be-skeptical evaluator that exercises the running app (Playwright);
- agreed "sprint contracts" of testable criteria;
- near-perfect verifiers;
- quiet, grep-friendly test output.

Every harness component should be re-justified on each new model. Multi-agent setups cost 4-15x the tokens and pay off only on parallelisable work.

### Cited Findings

**"Effective harnesses for long-running agents" (Nov 26, 2025)**
- An initializer agent creates `init.sh`, `claude-progress.txt`, an initial git commit and a feature list. Later coding agents work one feature per session, leave the code mergeable, and update git and the progress file. Both use the same prompt and tools, only the first user prompt differs. — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- The feature list is JSON (200+ features in the claude.ai-clone example). Each entry has a category, description, test steps and `passes: false`. Agents may only flip `passes`: "It is unacceptable to remove or edit tests". JSON was chosen because models are "less likely to inappropriately overwrite it" than Markdown. — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Failure modes:
  - one-shotting the whole app;
  - later sessions seeing progress and declaring the job done;
  - marking features done after only unit tests or curl checks.
  Prompting for browser automation (Puppeteer MCP) "markedly improved" end-to-end verification. — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Session startup routine: `pwd`, read git log and progress, pick the highest-priority failing feature, run `init.sh` and a basic e2e test before new work. — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Implication for graph-execution:
  - Make acceptance criteria machine-readable in JSON with a `passes` flag per criterion. Let only the live tester or validation flip them, never the implementing agent.
  - Have every task agent run a smoke check ("init.sh") before starting, to catch breakage inherited from dependencies.
  - Persist a per-task progress file in the worktree so retries and resumes start oriented.

**"Harness design for long-running application development" (Mar 24, 2026)**
- Planner, generator and evaluator. The evaluator drives the app with Playwright and grades against a "sprint contract" agreed before coding (27 criteria in one sprint). A hard threshold on any criterion fails the sprint. Agents communicate through files. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Separating the evaluator matters because generators praise their own work. Out of the box, "Claude was a weak QA agent": it found issues, then talked itself into approving them. Tuning took several rounds of reading logs. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Retro game maker (Opus 4.5): solo 20 minutes and $9 with a broken core feature, against the full harness at 6 hours and $200 with a working product. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Simplified harness on Opus 4.6:
  - Sprints were removed and the evaluator became a single pass at the end, "worth its cost only for parts beyond what the model does reliably solo".
  - The planner was kept because without it the generator under-scoped.
  - Simplification was done one component at a time, after a radical simplification failed.
  — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- DAW build (Opus 4.6): 3 h 50 min and $124.70 in total. The planner took 4.7 min and cost $0.46. There were 3 build/QA rounds, with QA at $3-4 each, and QA caught stubbed features. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Context resets (fresh agent plus handoff artifact) were needed for Sonnet 4.5's "context anxiety". Opus 4.5 largely removed the need, so one continuous session with automatic compaction was used. — [Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Implication for graph-execution:
  - Add a "contract" step: before a task starts coding, the implementing agent and the reviewer or tester agree on testable criteria derived from the PRD, stored in JSON.
  - Calibrate reviewers with few-shot graded examples and hard per-criterion thresholds.
  - Make the review loop adaptive: skip or lighten the evaluator for tasks the model reliably does solo, and spend it on risky tasks.
  - Ship an ablation or "harness eval" mode so users can test which stages are load-bearing on each new model.
  - Report time and cost per stage, as the DAW table does.

**"Building a C compiler with a team of parallel Claudes" (Feb 5, 2026)**
- Setup: 16 parallel Opus 4.6 agents, about 2,000 Claude Code sessions over two weeks, about 2B input and 140M output tokens, just under $20,000, about 100K lines of Rust. The compiler builds Linux 6.9 on x86, ARM and RISC-V. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Harness:
  - Each agent runs `while true; claude -p` in its own Docker container, cloning from a bare upstream repo.
  - Tasks are claimed via lock files in `current_tasks/`, with git as the arbiter. Agents pull, merge, push and unlock themselves.
  - There is no orchestrator agent and no messaging. Merge conflicts were "frequent but manageable".
  — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Lessons:
  - "The verifier must be nearly perfect."
  - A stricter CI was added because new features broke old ones.
  - Avoid context pollution: print few lines, log to files, and put `ERROR` plus the reason on one grep-able line.
  - Time blindness: add a `--fast` deterministic 1%/10% test sample that differs per agent.
  - Write extensive READMEs and progress files because agents start fresh.
  — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Parallelism broke down on one giant task: all 16 agents hit the same Linux bug and overwrote each other's fixes. The fix was a known-good oracle (GCC) that compiles a random subset of files, so the work split into independent units. Delta debugging then found interacting pairs. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Specialised agent roles: dedup/refactor, performance, codegen quality, a design critic, documentation. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
- Implication for graph-execution:
  - Make validation output agent-friendly: truncate logs, write full logs to files, extract an error summary.
  - Provide a "fast sample" validation mode for inner loops and the full suite at the gate.
  - Detect several tasks failing on the same root cause (same error signature) and serialise or merge them instead of letting them fight.
  - Offer optional "maintenance" roles after integration (dedup, docs, perf) as review-phase agents.
  - The C compiler had no orchestrator. graph-execution's explicit DAG is a stronger structure, but a "self-claim from pool" mode could suit long test-driven backlogs.

**"How we built our multi-agent research system" (Jun 13, 2025)**
- An Opus 4 lead with Sonnet 4 subagents beat single-agent Opus 4 by 90.2% on an internal eval. Token usage explained about 80% of BrowseComp variance. Agents use about 4x the tokens of chat, and multi-agent systems about 15x. Parallelism cut research time by up to 90%. — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Delegation needs an objective, output format, tool guidance and boundaries. Vague instructions duplicated work. Effort-scaling rules go in prompts. Rewriting tool descriptions cut task time by 40%. — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Production lessons:
  - Checkpoint and resume rather than restart.
  - Subagents write artifacts to the filesystem and pass references back.
  - Rainbow deployments avoid breaking long-running agents.
  - Evaluate end states with an LLM judge (0.0-1.0 plus pass/fail), starting with about 20 queries.
  — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Implication for graph-execution:
  - Task `content` should follow the delegation template (objective, output format, boundaries/owned files, validation), which the to-tasks skill can enforce.
  - Reviewers should pass findings as files or structured artifacts rather than prose relayed through context.
  - Build a small eval set of about 20 real PRDs with end-state judging to regression-test graph-execution's own prompts across model upgrades.
  - Upgrading graph-execution mid-run should not break in-flight runs, so the state file should be versioned.

**"Scaling Managed Agents: Decoupling the brain from the hands" (Apr 8, 2026)**
- Session, harness and sandbox are separated:
  - The session is an append-only event log.
  - The harness is stateless: `wake(sessionId)`, `getSession`, `emitEvent`.
  - Sandboxes are "cattle" behind `execute(name, input) → string` and `provision({resources})`.
  — [Anthropic](https://www.anthropic.com/engineering/managed-agents)
- "The session is not the context window." `getEvents()` positional slices let the brain rewind or reread. Irreversible compaction can discard needed context, so durable storage sits outside the context window. — [Anthropic](https://www.anthropic.com/engineering/managed-agents)
- Credentials never reach the sandbox. The git token is used only at init to clone and set the remote. MCP calls go through a proxy that uses a session-bound token and a vault. — [Anthropic](https://www.anthropic.com/engineering/managed-agents)
- Lazy container provisioning cut p50 time-to-first-token by about 60% and p95 by more than 90%. — [Anthropic](https://www.anthropic.com/engineering/managed-agents)
- Implication for graph-execution:
  - Model the run as an append-only event log (state.json plus run.log becomes `events.jsonl`) from which state is derived. That gives resume, replay, the web view and post-mortems from one source.
  - Treat each worktree or sandbox as disposable and recreatable from the log.
  - In graph-manager, keep GitHub/GitLab tokens out of the per-run Docker sandbox and push through a proxy or host-side step.
  - Offer a "Managed Agents" provider as a hosted, durable alternative to local CLI spawns.

**"The components of agent memory" (Nov 6, 2026)**
- Memory hierarchy: transcripts, then memory notes, then representations (wikis), then a small injected context. "Dreaming" is offline reflection over transcripts to fix and organise memory. — [Anthropic](https://www.anthropic.com/engineering/components-of-agent-memory)
- With memory, CL-Bench database-task scores rose from 0.655 to 0.838 for Opus 5.5 and from 0.383 to 0.700 for Opus 4.7. A rule to record only failures hurt (-0.234 for Opus 5). Guidance should say what memory is for, not how to use it. — [Anthropic](https://www.anthropic.com/engineering/components-of-agent-memory)
- Keep the injected layer small: Claude Code loads only the first 200 lines or 25 KB of its auto-memory index. Concurrent writers to one page overwrite each other, so give each page one owner. — [Anthropic](https://www.anthropic.com/engineering/components-of-agent-memory)
- Implication for graph-execution: add a post-run "dreaming" step that reads run.log, failure summaries and review findings, then writes a small per-repo lessons file (for example `.graph-execution/memory/`, or a CLAUDE.md section) that later runs inject. Keep it capped in size, with one writer, the orchestrator. Parallel agents must not edit shared memory.

**Other relevant posts (dates from the engineering index, not read in full this session)**
- "Claude Code: Best practices for agentic coding" (Apr 18, 2025); "Effective context engineering for AI agents" (Sep 29, 2025); "Writing effective tools for agents — with agents" (Sep 11, 2025); "Equipping agents for the real world with Agent Skills" (Oct 16, 2025); "Code execution with MCP" (Nov 4, 2025); "Demystifying evals for AI agents" (Jan 9, 2026); "Quantifying infrastructure noise in agentic coding evals" (Feb 5, 2026); "An update on recent Claude Code quality reports" (Apr 23, 2026); "Redesigning source control at Anthropic" (Oct 13, 2026). — [Anthropic Engineering index](https://www.anthropic.com/engineering)

### Inferences
- The biggest quality lever across these posts is **independent, skeptical, tool-using verification** (Playwright evaluator, near-perfect test oracle, Code Review's verify step). graph-execution already has a live tester. The next step is calibration (few-shot, thresholds), contracts agreed upfront, and a verify-the-findings stage.
- The second lever is **durable external state** (JSON feature lists, progress files, event logs) over context-window state.
- The third is **re-ablating the harness per model**: Anthropic removed sprints, resets and per-sprint QA as models improved. graph-execution should make stages configurable and measurable rather than fixed.

### Gaps
- The context engineering, tools, skills, code-execution-with-MCP, evals and "Redesigning source control" posts were not re-read in this session, so their specific numbers are not cited here.

## 3. Platform and API features for cost and long runs

### Takeaway
For long, costly runs the relevant platform levers are:
- server-side compaction (`compact_20260112`) and context editing (clearing tool results and thinking);
- the memory tool;
- prompt caching (5-minute default, 1-hour optional);
- tool search and programmatic tool calling (37-85% token cuts);
- Claude Managed Agents, a hosted durable harness.

Most apply directly only if graph-execution calls the API or Agent SDK rather than spawning CLIs. Via Claude Code they are partly applied automatically (compaction, caching).

### Cited Findings
- Context editing:
  - Beta header `context-management-2025-06-27`, with strategies `clear_tool_uses_20250919` and `clear_thinking_20251015`.
  - Parameters `trigger` (default 100K input tokens), `keep` (default 3 tool uses), `clear_at_least` (to make the cache invalidation worthwhile) and `exclude_tools`.
  - Clearing invalidates the cached prefix.
  - Anthropic recommends server-side compaction (`compact_20260112`) for most long conversations.
  — [Context editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- Memory tool `memory_20250818` combined with tool clearing: Claude is warned to save important information to memory files before results are cleared. — [Context editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- The default compaction summary prompt has five sections: Task Overview, Current State, Important Discoveries, Next Steps, Context to Preserve. — [Context editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- Advanced tool use (Nov 24, 2025, header `advanced-tool-use-2025-11-20`):
  - Tool Search Tool: about 85% less context (about 77K to 8.7K tokens). MCP-eval accuracy rose from 49% to 74% (Opus 4) and from 79.5% to 88.1% (Opus 4.5).
  - Programmatic Tool Calling: 37% fewer tokens (43,588 to 27,297).
  - Tool Use Examples: complex-parameter accuracy rose from 72% to 90%.
  — [Anthropic](https://www.anthropic.com/engineering/advanced-tool-use)
- Prompt caching in Claude Code subagents: 5-minute TTL by default, and `subagentPromptCacheTtl: 1h` extends it, with 1-hour writes billed higher. Background subagents move long shell commands to the background after 3 minutes "to keep the prompt cache warm" (v2.1.318). — [Workflows docs](https://code.claude.com/docs/en/workflows); [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- Managed Agents is a hosted harness with sessions in an Anthropic-managed cloud sandbox or a self-hosted sandbox, usable via SDKs, the `ant` CLI or REST. — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview); [Managed Agents post](https://www.anthropic.com/engineering/managed-agents)
- Implication for graph-execution:
  - Fan-out caching. Run sibling tasks and parallel reviewers with an identical system-prompt prefix (shared PRD and repo context first, task-specific text last), and stagger their start by a few seconds so they hit the cache. This is cheap and large for reviewers that all read the same PRD and diff.
  - Graph-manager MCP tools. graph-manager exposes MCP tools to agents. Keep tool counts small or deferred, and write tool descriptions with examples (the 72% to 90% finding).
  - Fixer resume. Resuming the same session for fixer passes (rather than a new process) keeps the cache warm within the TTL.
  - Managed Agents provider. A "claude-managed" provider could give durable, crash-resumable sessions for very long tasks without local process supervision.

### Inferences
- With CLI spawning, graph-execution's main cost controls are model choice per stage (for example Opus for planning and review, Sonnet or Haiku for simple tasks), cache-friendly prompt layout, session resume, `--max-budget-usd`, and not re-running unchanged tasks on resume.

### Gaps
- Current per-token pricing, cache pricing, and Batch API discounts were not verified in this session. The Managed Agents pricing and GA status were not found.

## 4. Autonomy, safety, sandboxing and prompt injection

### Takeaway
Anthropic reports agents running longer with less intervention:
- The 99.9th-percentile Claude Code turn rose from under 25 minutes to over 45 minutes between Oct 2025 and Jan 2026.
- Internal human interventions per session fell from 5.4 to 3.3.
- METR estimates multi-hour to 16+-hour 50% horizons for the latest models, from secondary sources.

Anthropic's safety guidance for autonomous coding is to put containment at the environment layer first (filesystem plus network isolation, credentials outside the sandbox, egress proxy), with classifiers such as auto mode on top. Both are fallible and must be layered.

### Cited Findings
- "Measuring AI agent autonomy in practice" (Feb 18, 2026):
  - The median Claude Code turn is about 45 seconds. The 99.9th percentile rose from under 25 minutes to over 45 minutes between Oct 2025 and Jan 2026.
  - Internal success on the hardest tasks doubled from Aug to Dec, and interventions per session fell from 5.4 to 3.3.
  - Experienced users auto-approve more (from about 20% to more than 40% of sessions) but also interrupt more (from about 5% to about 9% of turns).
  - The commonest reason Claude stops itself is to present a choice between approaches (35%). The commonest reason humans interrupt is missing context or corrections (32%).
  - About 0.8% of API actions appear irreversible.
  - Recommendation: design for visibility and simple intervention rather than per-action approval.
  — [Anthropic](https://www.anthropic.com/research/measuring-agent-autonomy)
- METR time horizons (secondary sources, treat as approximate):
  - Claude Opus 4.6: about 14.5 hours at 50%.
  - Claude Mythos Preview (March 2026 snapshot): at least 16 hours, and METR says measurements above 16 hours are unreliable.
  — [OfficeChai](https://officechai.com/ai/exponential-progress-claude-opus-4-6-has-50-time-horizon-of-14-5-hours-on-metr-time-horizons-benchmark); [OfficeChai on Mythos](https://officechai.com/ai/claude-mythos-shows-50-time-horizon-of-16-hours-on-metr-benchmark/); [The Decoder](https://the-decoder.com/metr-says-it-can-barely-measure-claude-mythos-palo-alto-networks-warns-of-autonomous-ai-attackers/)
- Sandboxing (Oct 20, 2025):
  - "Effective sandboxing requires both filesystem and network isolation."
  - Built on bubblewrap (Linux) and seatbelt (macOS). Network goes through an external proxy with a domain allowlist. Open source as `sandbox-runtime`.
  - It cut permission prompts by 84%.
  - Claude Code on the web keeps git credentials outside the sandbox. A git proxy checks a scoped credential and the request (for example, that a push targets only the configured branch) before attaching the real token.
  — [Anthropic](https://www.anthropic.com/engineering/claude-code-sandboxing)
- Auto mode (Mar 25, 2026):
  - A server-side prompt-injection probe screens tool outputs, and a Sonnet 4.6 transcript classifier screens each action in two stages. In-project file edits skip the classifier.
  - The classifier is reasoning-blind: assistant prose and tool outputs are stripped from its input.
  - Results: 0.4% false-positive rate on real traffic, and a 17% false-negative rate on real overeager actions.
  - Deny-and-continue: after 3 consecutive or 20 total denials the session escalates to a human, and in `-p` mode the process terminates.
  - Subagent delegation is checked at spawn and at return.
  - "Not a substitute for careful human review on high-stakes infrastructure."
  — [Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode)
- "How we contain Claude across products" (May 25, 2026):
  - Risk = likelihood x blast radius. Build containment at the environment layer first.
  - In a Feb 2026 red team, a phished employee's Claude exfiltrated `~/.aws/credentials` in 24 of 25 retries. Only egress and filesystem boundaries would have stopped it.
  - An allowlisted api.anthropic.com was abused with an attacker's API key to upload files.
  - Project `.claude/settings.json` hooks ran before the trust prompt, in three vulnerabilities.
  - "Be wary of custom components": standard hypervisors and syscall filters held up, while custom proxies and glue code failed.
  - Emerging risks: memory and CLAUDE.md poisoning, and multi-agent trust escalation where subagent output is treated as higher-trust.
  — [Anthropic](https://www.anthropic.com/engineering/how-we-contain-claude)
- Implication for graph-execution:
  1. **Default-on sandboxing.** Run each task agent with filesystem confined to its worktree (`permissions.blockWritesOutsideWorkingDirectories`, sandbox-runtime, or graph-manager's per-run Docker) and network egress through an allowlist proxy. Keep credentials (git tokens, cloud keys, `~/.aws`) out of the agent environment.
  2. **Permission defaults.** Use `--permission-mode auto --permission-prompts none` (or dontAsk with explicit allow rules) rather than `--dangerously-skip-permissions`. Surface `permission_denials` in failure summaries.
  3. **Untrusted repos.** Use `--bare` or a trust gate so cloned repos' hooks and MCP configs cannot execute (the pre-trust hook CVE class).
  4. **Inter-agent trust.** Treat reviewer, tester and resolver outputs and fetched content as data. Never let one agent's output grant permissions to another, and screen memory files and lesson files that persist across runs.
  5. **Oversight UX.** Following the autonomy study, invest in visibility (live view, per-task transcripts) and cheap intervention (pause, steer and retry a task, inject a message) rather than approval gates. Let agents emit structured "needs decision" questions, since presenting a choice is the commonest reason Claude stops.
  6. **Run length.** Multi-hour single-agent tasks are now realistic. Size tasks larger than before, with fewer but meatier tasks, and rely on stall detection and checkpoints rather than short timeouts.

### Inferences
- graph-execution runs many unattended agents in parallel, so its blast radius is larger than a single interactive session's. Environment-level containment (graph-manager Docker sandboxes plus an egress proxy plus host-side push) should be the default even for the local CLI, not an add-on.
- The finding that the strictest interventions catch 83% of overeager actions, not 100%, supports keeping the final human-review step and applying results as uncommitted changes. That is graph-execution's current design.

### Gaps
- METR figures come from secondary coverage. METR's primary pages were not fetched.
- I found no Anthropic primary statement giving a single "agents can now work N hours" figure beyond the turn-length percentiles and the harness case studies (about 4-6 hour builds, and a two-week, 2,000-session compiler).
- Anthropic's internal usage statistics for Claude Code (for example, the share of code written by Claude) were not re-verified in this session.
