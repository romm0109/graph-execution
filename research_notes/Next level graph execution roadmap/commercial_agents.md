# Commercial AI coding agents (non-Anthropic), state as of 2026-11-10 — feature inventory vs graph-execution

Method note: 17 tool calls. Search snippets were available, but direct fetches of developers.openai.com, docs.devin.ai, github.blog, cursor.com and jules.google failed (hosts not allowed in this sandbox's network). Many findings therefore rest on search-result summaries and secondary sources; these are flagged. Items marked **[prior knowledge, URL not re-fetched]** come from the researcher's training data (cutoff mid-2026) with the canonical URL, and should be spot-checked before quoting.

## 1. How each product parallelizes, plans, verifies and hands off

### Takeaway
The industry has converged on: (a) isolated cloud VM/worktree per agent, (b) many agents at once managed from a "mission control"/"agent manager" surface, (c) an explicit plan/spec artifact a human can steer before code is written, (d) agent self-verification with artifacts (screenshots, browser video, logs) attached to the PR, and (e) a PR as the hand-off unit, usually pre-reviewed by an AI reviewer. graph-execution already has (a), DAG-level parallelism, a PRD-driven review loop and a live tester, but lacks best-of-N per task, visual verification artifacts (video/screenshots) surfaced in hand-off, plan-critic before execution, and auto-decomposition by a planner agent at run time.

### Cited Findings

**OpenAI Codex (cloud + CLI + IDE)**
- Codex cloud launched 2025-05-16 as a cloud agent running each task in its own sandbox, reading AGENTS.md; GPT-5-Codex (agentic-coding-tuned GPT-5) shipped 2025-09-15 — [Wikipedia: Codex (AI agent)](https://en.wikipedia.org/wiki/Codex_(AI_agent)); [Adaline: Coding with GPT-5 Codex](https://labs.adaline.ai/p/coding-with-gpt-5-codex) (secondary).
- Best-of-N: `codex cloud exec --attempts` runs 1–4 independent attempts and the user picks the best result/PR; requires `--env` — [Daniel Vaughan, 2026-04-01](https://codex.danielvaughan.com/2026/04/01/codex-cloud-exec-best-of-n-attempts/) (secondary); described as "best of N" in an OpenAI build-hour write-up — [videotoblog summary](https://rmj.videotoblog.ai/codex-unified-agent-ide-cli-cloud-github).
- Known best-of-N pitfall: attempts can be identical when the task is too deterministic; advice is to prompt for different approaches — [Daniel Vaughan](https://codex.danielvaughan.com/2026/04/01/codex-cloud-exec-best-of-n-attempts/).
- AGENTS.md hierarchy: global → project root → working dir, most specific wins — [Adaline](https://labs.adaline.ai/p/coding-with-gpt-5-codex). (AGENTS.md is now a cross-vendor convention; Copilot, Cursor, Jules, Amp, etc. read it — [prior knowledge, agents.md](https://agents.md).)
- DevDay 2026 (late Sept 2026): reusable cloud environments that work across devices; tasks reuse a published environment's prepared filesystem; a task's VM state is recoverable for up to 7 days after the last turn; voice in CLI — [TechCrunch, 2026-09-29](https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/); [Windows Report](https://windowsreport.com/openai-gives-codex-a-major-upgrade-with-cloud-environments-voice-cli-code-review/); [szymonpaluch.com](https://szymonpaluch.com/blog/posts/openai-codex-cloud).
- Codex code review: GitHub review GA, GitLab merge requests in preview; a review view in the ChatGPT desktop app lets users walk diffs and question Codex before feedback goes to GitHub/GitLab; separate "automatic reviews" review every PR before a human looks — [Windows Report](https://windowsreport.com/openai-gives-codex-a-major-upgrade-with-cloud-environments-voice-cli-code-review/); [techbytes](https://techbytes.app/posts/openai-codex-cloud-cli-voice-code-review-devday/) (search-snippet level).
- Codex Cloud (Legacy) retains code review and Linear + GitHub integrations — [szymonpaluch.com](https://szymonpaluch.com/blog/posts/openai-codex-cloud).
- Model churn: GPT-5.5 retired from Codex for ChatGPT-signed-in users on 2026-10-14 (per changelog, as summarized by search) — [Codex changelog](https://developers.openai.com/codex/changelog) (not fetched directly).
- Research thread on scaling test-time compute (rollout summaries / retry strategies) applied to Codex CLI — [Daniel Vaughan, 2026-06-20](https://codex.danielvaughan.com/2026/06/20/scaling-test-time-compute-agentic-coding-codex-cli-rollout-retry-rtv-pdr-strategy/).
- OpenAI "harness engineering" post about building with Codex as the primary engineer — [OpenAI](https://openai.com/index/harness-engineering/) (not fetched).
- Implication for graph-execution: add per-task best-of-N (`attempts: n` in task JSON) with diverse-approach prompting and an AI judge (reviewers already exist) to pick the winner before merge; keep VM/worktree state resumable for a time window (graph-execution resume exists — consider snapshotting finished worktrees); support GitLab MR review as graph-manager already supports GitLab workspaces.

**GitHub Copilot coding agent / Agent HQ / mission control**
- Agent HQ announced at GitHub Universe 2025-10-28: run agents from Anthropic, OpenAI, Google, Cognition, xAI inside a Copilot subscription; "mission control" is a unified surface on GitHub.com, VS Code, mobile and CLI to assign tasks across repos, watch live session logs, steer mid-run, and open resulting PRs — [GitHub Blog: Introducing Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/); [GitHub Blog: mission control](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/).
- Claude and Codex partner agents in public preview from Feb 2026 alongside Copilot coding agent (as of Sept 2026) — search summary of [eficode](https://www.eficode.com/insights/blog/why-github-agent-hq-matters-for-engineering-teams-in-2026) / GitHub materials.
- Governance: control plane with policy management, audit logging, admin of AI access incl. agents and MCP — [GitHub Blog: Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/).
- 2026-02-26: coding agent reviews its own changes with Copilot code review before opening the PR; runs code scanning, secret scanning and dependency-vulnerability checks inside its workflow at no extra cost — [GitHub Blog: What's new with Copilot coding agent](https://github.blog/ai-and-ml/github-copilot/whats-new-with-github-copilot-coding-agent/).
- Custom agents defined as files under `.github/agents/` — [same](https://github.blog/ai-and-ml/github-copilot/whats-new-with-github-copilot-coding-agent/).
- Copilot for Jira GA 2026-06-25 (preview from March 2026): model selection, Confluence context via MCP, custom agents, custom fields, space-level guidance, review-request notifications, follow-up instructions in Jira chat panel after draft PR — [GitHub Changelog 2026-06-25](https://github.blog/changelog/2026-06-25-github-copilot-for-jira-is-now-generally-available/); [DevOps.com](https://devops.com/github-copilot-coding-agent-for-jira-connects-planning-to-pull-requests-without-leaving-your-workflow).
- Copilot code review customization/configurability improvements 2026-07-17 — [GitHub Changelog](https://github.blog/changelog/2026-07-17-copilot-code-review-customization-and-configurability-improvements/).
- Linear, Slack, Teams, Azure Boards integrations listed — [github/docs CHANGELOG](https://github.com/github/docs/blob/main/CHANGELOG.md) (titles only); [kalinga.ai](https://kalinga.ai/github-copilot-coding-agent-2026-updates/) (secondary, less reliable).
- Implication for graph-execution: (1) run a security pass (secret scan, dependency audit, e.g. `npm audit`/gitleaks/semgrep) as a built-in validation/reviewer type; (2) adopt `.github/agents/*.md`-style custom reviewer/agent definitions so repos can ship reviewers; (3) graph-manager could be a "mission control" with mid-run steering (send a message into a running task's agent), not only retry after failure; (4) Jira/Linear trigger: "assign ticket → generate spec → tasks → run" is the obvious integration given CLAUDE.md already starts from Jira.

**Cursor**
- Cursor 2.0 (Oct 2025): multiple agents in parallel using git worktrees or remote machines; Composer in-house model — [Wikipedia: Cursor (code editor)](https://en.wikipedia.org/wiki/Cursor_(code_editor)); search summary.
- Cursor 2.5: long-running cloud agents, up to 8 in parallel in isolated Ubuntu VMs — search summary of [codersera](https://codersera.com/blog/cursor-ide-complete-guide-2026/) (secondary).
- 2026-02-24: "Cloud Agents with Computer Use" — each agent gets its own VM with full dev environment, can open browsers, hit localhost, click through UI, and produce artifacts (videos, screenshots, logs) attached to merge-ready PRs; users can take over the agent's remote desktop without checking out the branch; agents "onboard themselves" to the codebase — [Cursor changelog 02-24-26](https://cursor.com/changelog/02-24-26); [Cursor blog](https://cursor.com/blog/agent-computer-use); DevOps.com reports ~35% of Cursor's internal PRs were produced by these agents — [DevOps.com](https://devops.com/cursor-cloud-agents-get-their-own-computers-and-35-of-internal-prs-to-prove-it).
- Reliability complaints: models often attach broken Playwright-made mp4s or claim no access to recording tools (Apr 2026); artifacts recorded to `/opt/cursor/artifacts/` don't render on GitHub unless an opt-in dashboard setting is on — [Cursor forum: video demos](https://forum.cursor.com/t/getting-video-demos-out-of-cloud-agents/157217); [Cursor forum bug](https://forum.cursor.com/t/cursor-cloud-agents-do-not-post-their-screenshots-or-videos-to-pr/152974).
- Cursor 3.0 (2026-04-02): Agents Window to run many agents across local, worktree, cloud and SSH — [digitalapplied](https://www.digitalapplied.com/blog/cursor-3-deep-dive-agents-composer-review-2026) (secondary).
- Cursor 3.3 (2026-05-07) "Build in Parallel": Composer breaks a plan into a dependency graph, identifies branches with no shared writes, and dispatches them to async subagents, then merges — [DEV Community](https://dev.to/davekurian/cursor-3s-parallel-agents-change-what-a-template-ships-with-joc); [luonghongthuan.com](https://luonghongthuan.com/en/blog/cursor-parallel-subagents-2026/) (secondary). This is essentially graph-execution's model embedded in an IDE, with the DAG generated automatically.
- Cursor 3.5 (reported 2026-05-20): cloud agents across multiple repos in parallel, reporting back asynchronously — single secondary source [codersera](https://codersera.com/blog/cursor-ide-complete-guide-2026/); unverified.
- Bugbot: PR reviewer launched July 2025; Bugbot Autofix late Feb 2026; moved to in-house Composer 2.5 in June 2026, review time ~5 min → ~90 s; admin model block lists/governance — [TheRouter.ai](https://therouter.ai/news/cursor-bugbot-composer-2-5-model-block-list-governance/) (secondary citing changelog).
- 2026-11-06: realtime voice calls with agents across Agents Window/IDE/web/iOS; an Agent SDK used to build managed agents (Bugbot, Security Reviewer, Rollouts) — [Releasebot: Cursor](https://releasebot.io/updates/cursor) (aggregator).
- Implication for graph-execution: (1) the live tester should save screenshots/video (Playwright `recordVideo`, trace.zip) into `.graph-execution/<run-id>/artifacts/` and the web view / Create PR should embed them — and must validate that the files are real (Cursor's failure mode); (2) a "decompose" mode where a planner agent turns a PRD into a DAG at run time, checking write-set disjointness, would match Cursor 3.3 — graph-execution's to-tasks is the offline version; (3) "take over the sandbox" (remote desktop/terminal into the task's worktree container) fits graph-manager's Docker sandboxes; (4) multi-repo runs.

**Google Jules / Gemini CLI / Antigravity**
- Antigravity (launched Nov 2025 with Gemini 3): Editor view for synchronous work + Agent Manager "mission control" for spawning/supervising many async agents; agents produce **Artifacts** — Markdown implementation plans, task lists, code diffs, architecture diagrams, screenshots, browser recordings — which users review and comment on inline (Google-Docs-style) to steer before/while code changes — [Google Developers Blog](https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/); [Antigravity docs: Artifacts](https://antigravity.google/docs/artifacts/).
- Browser subagent runs in an isolated managed Chrome and records video of UI interaction; Antigravity 2.0 is a standalone app independent of an IDE — [Google Codelab](https://codelabs.developers.google.com/getting-started-google-antigravity); [Wikipedia: Google Antigravity](https://en.wikipedia.org/wiki/Google_Antigravity).
- Jules: async GitHub coding agent; official changelog describes a **Planning Critic** — a secondary agent that critiques and refines the plan before any code runs; scheduled tasks exist (included in data export) — [Jules changelog](https://jules.google/docs/changelog/) (search summary); [DEV Community guide](https://dev.to/therealmrmumba/how-to-use-google-jules-in-2026-a-practical-guide-before-it-winds-down-4p54).
- **Jules is being shut down**: winds down 2026-12-31, read-only after ~Nov 11, learnings folded into Antigravity — [Jules changelog](https://jules.google/docs/changelog/); [Times of AI](https://www.timesofai.com/news/google-jules-antigravity/); [daily.dev](https://daily.dev/posts/google-is-shutting-down-jules-and-moving-its-coding-agent-work-to-antigravity-qfzrufkpz).
- Jules auto-fixing failing CI on its own PRs — single DEV post, no official confirmation — [DEV Community](https://dev.to/jubinsoni/jules-googles-async-coding-agent-is-changing-how-we-think-about-ai-and-software-development-3j0d).
- Implication for graph-execution: (1) a plan-critic step per task (or for the whole tasks folder) before agents start is cheap and catches bad decompositions — graph-execution only reviews after code; (2) inline comments on plan/spec artifacts (graph-manager already has GitHub-style comments on code — extend to the PRD and per-task plans); (3) Google consolidating a standalone async cloud agent into an "agent manager" app suggests orchestration UIs, not separate products, are where value accrues.

**Cognition Devin + Windsurf**
- Devin 2.0 (Apr 2025): parallel Devins in cloud IDEs, Interactive Planning (Devin proposes a plan with relevant files before work), Devin Search, Devin Wiki (auto-generated, continually updated repo wiki with architecture diagrams) — [prior knowledge, Cognition blog "Devin 2.0", URL not re-fetched: https://cognition.ai/blog/devin-2]. DeepWiki public repo wikis (Apr 2025) — [prior knowledge: https://deepwiki.com].
- Playbooks (reusable task prompts/procedures), Knowledge (learned/curated repo facts auto-suggested from sessions), session insights/analytics — documented Devin features **[prior knowledge; not verified this session — docs.devin.ai unreachable]**.
- 2026 release notes: "Improve with Devin" action that iterates on an existing **automation** (i.e., Devin has automations/scheduled triggers); Devin Outposts for running workloads in self-hosted customer environments; automated code scans — [Devin release notes 2026](https://docs.devin.ai/release-notes/2026) (search summary); [fast.io](https://fast.io/resources/devin-ai-changelog/) (secondary).
- 2026-10-21: Devin Review expands to Bitbucket Cloud, richer PR comment and merge actions, more accurate "finding analytics"; 2026-10-23: customizable agent defaults, automated PR reviews, expanded GitHub automations and APIs — [Releasebot: Devin](https://releasebot.io/updates/devin) (aggregator).
- Devin Desktop (Windsurf successor) 2026-10-23: MCP protocol revision 2026-07-28 support; enterprise extension-marketplace URL setting — [Devin Desktop changelog](https://docs.devin.ai/desktop/changelog).
- Implication for graph-execution: (1) a generated repo wiki/knowledge base (DeepWiki-style) feeding every task's context would reduce per-task exploration and could be produced once per run; (2) "playbooks" ≈ reusable task templates (e.g., "add CLI flag", "add web view panel") that to-tasks could reference; (3) "finding analytics" — track reviewer finding counts/acceptance over runs; (4) self-hosted runners (Outposts) ≈ graph-manager Docker already.

**Amazon Kiro**
- Spec-driven: generates requirements (EARS-style), design and sequenced task list from intent; human reviews; implements against spec and keeps spec/code aligned — [axonbuild review](https://axonbuild.com/blog/kiro-ide-review/); [AWS builder guide](https://builder.aws.com/content/39juiKF2uwxhek0RuYHhjf24JjL/kiro-the-complete-guide-for-teams); [testmuai comparison](https://www.testmuai.com/blog/spec-driven-development-tools/).
- Property-based tests derived from acceptance criteria ("correctness properties"); optional by default, not formal verification, IDE-only per Nov 2026 comparison — [developertoolkit.ai](https://developertoolkit.ai/en/comparison/kiro/); [DEV: invariant-driven](https://dev.to/yapingma/beyond-vibe-coding-building-invariant-driven-agentic-systems-with-aws-kiro-2gcn).
- Agent hooks: trigger on file save / post-task to run a shell command (no credits) or send an agent prompt (credits) — [axonbuild](https://axonbuild.com/blog/kiro-ide-review/).
- Supervised, not fully autonomous — [axonbuild](https://axonbuild.com/blog/kiro-ide-review/). Kiro launched July 2025 [prior knowledge: https://kiro.dev/blog/introducing-kiro/].
- Implication for graph-execution: graph-execution's to-spec/to-tasks is the same pattern but offline; gaps: (1) traceability — each acceptance criterion should map to task(s) and to test(s), and the reviewer should report per-criterion pass/fail; (2) generate property-based tests from acceptance criteria as a validation gate; (3) spec–code sync: after fixes, update PRD/tasks to reflect what was actually built; (4) hooks on task lifecycle events (pre-task, post-merge, post-review).

**Other products (thin evidence)**
- Amp (Sourcegraph → spun out as Amp Inc.): auto-spawned subagents with isolated context windows reporting to a parent thread; Thread Map visualizing threads; May 2026 CLI rebuild with auto-compaction, plugin API, remote control from web — [secondtalent](https://www.secondtalent.com/resources/amp-ai-review/); [arcbjorn mid-2026](https://blog.arcbjorn.com/state-of-cli-coding-agents-2026) (secondary).
- Warp: runs its own agent plus Claude Code, Codex, Gemini CLI side-by-side in one interface with a code review panel — [tembo.io comparison](https://www.tembo.io/blog/coding-cli-tools-comparison) (secondary).
- Augment Code (Auggie CLI): context engine indexing whole codebase incl. dependencies, git history, even Slack threads — [iceberglakehouse guide](https://iceberglakehouse.com/posts/agentic-coding-tools-may-2026/) (secondary).
- JetBrains Junie CLI: beta Mar 2026, GA Jun 2026, ACP-native — [cleverhack landscape](https://cleverhack.com/ai-coding-landscape) (secondary).
- Replit Agent 4 (Mar 2026): parallel task forking; model routing at "65% lower cost" — [mightybot](https://mightybot.ai/blog/coding-ai-agents-for-accelerating-engineering-workflows/) (secondary, unverified).
- Implication for graph-execution: Warp/Agent HQ normalize **mixing providers in one session**; graph-execution's "one provider per run" is now a visible gap (e.g., Codex for implementation, Claude for review, cheap model for fixer). ACP (Agent Client Protocol) is emerging as a provider-neutral way to drive agent CLIs — could replace per-CLI adapters.

### Inferences
- The dominant hand-off is a PR with an AI pre-review, CI/security checks, and visual evidence. graph-execution's "apply as uncommitted changes" is a local-dev hand-off; Create PR in graph-manager partially covers it but artifacts (screenshots/video/test report) are not attached.
- Best-of-N is shipped (Codex), but practitioners report homogeneous attempts; the value is higher with forced diversity (different providers/models/prompts) — graph-execution's multi-provider support makes cross-provider best-of-N a differentiator.
- Cursor 3.3's "plan → dependency graph → parallel subagents with disjoint writes → merge" is graph-execution's architecture; competitors do it implicitly and automatically, graph-execution does it explicitly with human-reviewable task files. Positioning: explicit, auditable DAG + PRD-judged review loop.

### Gaps
- Could not fetch official Codex changelog, Devin docs, GitHub blog or Cursor pages directly (sandbox network); exact dates for several items are from search summaries/aggregators.
- No verified detail on Devin Playbooks/Knowledge/Session Insights current (2026) form.
- No verified 2026 details for Gemini CLI specifically, Zed (agent panel/ACP), or Replit Agent beyond secondary blurbs.

## 2. Triggers and integrations

### Takeaway
Every major vendor now triggers agents from where work is tracked: issue assignment (GitHub/Jira/Linear), @-mentions in PRs and Slack, automatic PR review on every PR, and scheduled/automated runs. graph-execution is CLI/web-triggered only.

### Cited Findings
- Copilot: assign issue to Copilot; Jira GA 2026-06-25 with follow-ups in Jira panel after draft PR; Linear/Slack/Teams entries in docs changelog — [GitHub Changelog](https://github.blog/changelog/2026-06-25-github-copilot-for-jira-is-now-generally-available/); [github/docs CHANGELOG](https://github.com/github/docs/blob/main/CHANGELOG.md).
- Codex: GitHub + Linear integrations; automatic PR reviews; GitLab MR review preview — [szymonpaluch.com](https://szymonpaluch.com/blog/posts/openai-codex-cloud); [Windows Report](https://windowsreport.com/openai-gives-codex-a-major-upgrade-with-cloud-environments-voice-cli-code-review/).
- Cursor: Bugbot on every PR, Bugbot Autofix (Feb 2026) pushes fixes for its own findings — [TheRouter.ai](https://therouter.ai/news/cursor-bugbot-composer-2-5-model-block-list-governance/).
- Devin: automations (with "Improve with Devin"), automated PR reviews, expanded GitHub automations/APIs (Oct 2026), Bitbucket review — [Releasebot: Devin](https://releasebot.io/updates/devin); [Devin release notes](https://docs.devin.ai/release-notes/2026).
- Jules: scheduled tasks; claimed CI-failure autofix (unverified) — [DEV guide](https://dev.to/therealmrmumba/how-to-use-google-jules-in-2026-a-practical-guide-before-it-winds-down-4p54); [DEV](https://dev.to/jubinsoni/jules-googles-async-coding-agent-is-changing-how-we-think-about-ai-and-software-development-3j0d).
- Kiro: event hooks on file save / post-task — [axonbuild](https://axonbuild.com/blog/kiro-ide-review/).
- Implication for graph-execution: add to graph-manager (1) webhook/label trigger: Jira/Linear/GitHub issue labelled → to-spec draft for approval → run; (2) PR comment autofix: re-enter the fixer stage with review comments from a GitHub PR as input (graph-manager already has GitHub-style human comments internally); (3) CI-failure autofix: on failing check of a Create-PR PR, feed logs to the fixer; (4) scheduled runs (nightly suites, dependency upgrades).

### Inferences
- PR-comment and CI-failure loops are the cheapest high-value integration because graph-execution already has a fixer stage that takes structured findings.

### Gaps
- No primary-source confirmation of Slack/Linear trigger details for Copilot or Cursor in 2026.

## 3. Codebase knowledge

### Takeaway
Converged primitives: AGENTS.md (hierarchical instructions), repo-level custom agent files, auto-generated repo wikis/indexes (Devin Wiki/DeepWiki, Augment context engine), and learned memory/knowledge that persists across sessions.

### Cited Findings
- AGENTS.md hierarchical precedence in Codex — [Adaline](https://labs.adaline.ai/p/coding-with-gpt-5-codex); experiment where Codex iteratively optimized AGENTS.md against real PRs 8 times but the best version regressed on a clean holdout (caution on auto-tuned memory) — [feedbagel](https://feedbagel.com/post/i-used-autoresearch-to-improve-my-agentsmd-measured-against-real-tasks).
- `.github/agents/` custom agents — [GitHub Blog](https://github.blog/ai-and-ml/github-copilot/whats-new-with-github-copilot-coding-agent/).
- Augment indexes code, deps, git history, Slack — [iceberglakehouse](https://iceberglakehouse.com/posts/agentic-coding-tools-may-2026/).
- Cursor cloud agents "onboard themselves" to a codebase before work — [Cursor changelog 02-24-26](https://cursor.com/changelog/02-24-26).
- Devin Wiki / DeepWiki / Knowledge / Playbooks — [prior knowledge: https://deepwiki.com, https://cognition.ai/blog/devin-2].
- Implication for graph-execution: (1) a run-level "onboarding" step that writes a cached repo summary (keyed by commit) passed to all tasks; (2) a learnings file: after each run, extract reviewer/fixer findings and validation failures into proposed AGENTS.md/CLAUDE.md additions for human approval (avoid auto-applying — holdout regression evidence); (3) read AGENTS.md uniformly for all providers.

### Inferences
- graph-execution's task `content` carries all context hand-written by to-tasks; a shared knowledge layer would cut to-tasks effort and token cost per task.

### Gaps
- No quantitative evidence found that repo wikis improve merge rates.

## 4. Multi-model routing, cost controls, dashboards, governance

### Takeaway
Vendors route between in-house fast models and frontier models (Cursor Composer for Bugbot; Replit routing), expose admin model allow/block lists, audit logs, and usage dashboards; users still complain loudly about surprise overage costs.

### Cited Findings
- Bugbot moved to Composer 2.5 (June 2026), 5 min → 90 s; admin model block lists — [TheRouter.ai](https://therouter.ai/news/cursor-bugbot-composer-2-5-model-block-list-governance/).
- Copilot for Jira supports model selection; Agent HQ control plane with policy, audit logging, MCP access admin — [GitHub Changelog](https://github.blog/changelog/2026-06-25-github-copilot-for-jira-is-now-generally-available/); [GitHub Blog](https://github.blog/news-insights/company-news/welcome-home-agents/).
- Replit model routing "65% lower cost" — [mightybot](https://mightybot.ai/blog/coding-ai-agents-for-accelerating-engineering-workflows/) (unverified).
- Kiro hooks: shell-command hooks cost no credits; agent-prompt hooks consume credits — [axonbuild](https://axonbuild.com/blog/kiro-ide-review/).
- Devin Desktop enterprise extension-marketplace setting; Devin Outposts self-hosted — [Devin Desktop changelog](https://docs.devin.ai/desktop/changelog); [fast.io](https://fast.io/resources/devin-ai-changelog/).
- HN: user spent $638 on Cursor in 6 weeks, $348.56 on-demand overage, hit $400 cap; cache savings lost when changing reasoning levels — [HN 45914307](https://news.ycombinator.com/item?id=45914307).
- Implication for graph-execution: (1) per-stage model/provider config (implementer, merger/resolver, reviewers, fixer, tester) — cheap fast model for conflict resolution and fixer passes, frontier model for review; (2) run budget (`--max-cost`/token cap) with per-task cost in state.json and the web view; (3) cost/time per task and per stage in the run dashboard; (4) audit log of agent commands for graph-manager.

### Inferences
- Since graph-execution multiplies agent calls (N tasks × review passes × reviewers), cost visibility and caps are more important than for single-agent tools.

### Gaps
- No published per-task cost figures for Codex/Copilot cloud agents found.

## 5. User praise and complaints

### Takeaway
Praise: parallel async work, PR-ready output for bounded tasks. Complaints: review bottleneck (agents write more than humans can review), band-aid fixes / code quality decay, flaky artifacts, cost overruns, outage dependence.

### Cited Findings
- "Agents are writing more code than reviewers can keep up with" — [HN: Six months of writing code exclusively with agents](https://news.ycombinator.com/item?id=49465119).
- Agents patch with band-aids, hard to keep code clean; can't work during provider outages — [Ask HN: I hate coding agents](https://news.ycombinator.com/item?id=48844345).
- Free-roaming internal agent → impressive demos, constant production incidents — [HN: less capability, more reliability](https://news.ycombinator.com/item?id=43535653).
- Consensus framing: agents useful for bounded tasks, not autonomous software production — [developersdigest HN roundup](https://www.developersdigest.tech/blog/what-hacker-news-gets-right-about-ai-coding-agents-2026) (secondary).
- Agent-generated code churns faster (110k PRs) — [Daniel Vaughan, 2026-05-01](https://codex.danielvaughan.com/2026/05/01/agent-code-churn-research-codex-cli-durability-patterns/).
- Cursor video/screenshot artifacts broken or not posted — [Cursor forum](https://forum.cursor.com/t/getting-video-demos-out-of-cloud-agents/157217).
- Implication for graph-execution: the review bottleneck is the core complaint — invest in reviewability: per-criterion verdicts, risk-ranked diff summary, evidence artifacts, and smaller per-task PRs/commits (stacked commits per task rather than one blob of uncommitted changes).

### Inferences
- graph-execution's PRD-judged review loop directly targets the top complaint; its marketing/UX should lead with "evidence of correctness" rather than speed.

### Gaps
- Little Reddit/X sentiment collected due to tool budget.

## 6. Published merge-rate / acceptance statistics

### Takeaway
Academic 2026 studies of agent-authored GitHub PRs put pooled merge rates ~65–71%, Codex and Claude Code highest (~74–84%), Copilot coding agent and Devin lowest (~42–43%), but heavily confounded by task type and repo popularity.

### Cited Findings
- Overall agentic PR merge rate 71.48% (33k+ PRs) — [arXiv 2607.21832](https://arxiv.org/html/2607.21832v1).
- Agents 65% vs humans 85% (Python repos); Claude Code ~84%, Devin ~43% — [Robert Stowe](https://robertstowe.com/agent-pull-requests-merge-at-65-humans-at-85/).
- Fix-related PRs: Codex 81.6%; Copilot 42.4%, Devin 42.9% — [arXiv 2602.00164](https://arxiv.org/html/2602.00164v1).
- Claude 84.3%, Codex 73.5% highest in another study; Copilot lowest 43.04% — search summaries of [arXiv 2607.21832](https://arxiv.org/html/2607.21832v1) / [alphaxiv 2601.15195](https://www.alphaxiv.org/abs/2601.15195) (attribution between the two uncertain).
- Merge rate falls from 91.58% (0-star repos) to 60.05% (1000+ stars) across 2M agent PRs — [IJRASET Sept 2026](https://www.ijraset.com/best-journal/ai-coding-agents-on-github-repository-popularity-as-a-hidden-confounder-in-the-acceptance-of-2-million-agentauthored-pull-requests).
- Config/docs/CI PRs merge >80%; function implementation and LLM-integration <60% — search summary of [arXiv 2607.21832](https://arxiv.org/html/2607.21832v1).
- Codex has highest merge-conflict rate 32.31%, >2× Copilot — [AgenticFlict arXiv 2604.03551](https://arxiv.org/html/2604.03551v2).
- Pooled co-authorship effects reverse within each agent (Simpson's paradox) — [arXiv 2606.22711](https://arxiv.org/html/2606.22711v1).
- Cursor: ~35% of internal PRs by cloud agents (vendor claim) — [DevOps.com](https://devops.com/cursor-cloud-agents-get-their-own-computers-and-35-of-internal-prs-to-prove-it).
- Implication for graph-execution: (1) merge conflicts are a measurable failure mode (AgenticFlict) — graph-execution's AI conflict resolver plus dependency chaining is a strength worth benchmarking and publishing; (2) collect its own metrics (task first-pass validation rate, review blockers per pass, fixer convergence, human-accept rate) and show them in the dashboard.

### Inferences
- Vendor-reported numbers are rare and self-serving; academic numbers are confounded. A credible graph-execution benchmark on a fixed task set would be differentiating.

### Gaps
- Numbers came from search snippets; papers not read in full. No vendor-published acceptance rate for Codex, Copilot or Devin found.

## Converging industry patterns (summary)
1. Isolated sandbox per agent (VM/container/worktree), resumable state — [TechCrunch](https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/); [Cursor](https://cursor.com/changelog/02-24-26).
2. Mission-control UI for many agents with live logs and mid-run steering — [GitHub](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/); [Antigravity](https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/).
3. Plan/spec artifact first, human-steerable, sometimes AI-critiqued — [Kiro](https://axonbuild.com/blog/kiro-ide-review/); [Jules Planning Critic](https://jules.google/docs/changelog/); [Antigravity Artifacts](https://antigravity.google/docs/artifacts/).
4. Self-verification with browser/computer use and visual evidence on the PR — [Cursor](https://cursor.com/blog/agent-computer-use); [Antigravity](https://codelabs.developers.google.com/getting-started-google-antigravity).
5. AI review on every PR + autofix of review findings; self-review before opening PR; security scanning built in — [GitHub](https://github.blog/ai-and-ml/github-copilot/whats-new-with-github-copilot-coding-agent/); [Bugbot](https://therouter.ai/news/cursor-bugbot-composer-2-5-model-block-list-governance/).
6. Triggers from trackers/chat (Jira, Linear, Slack) and automations/schedules — [GitHub Jira GA](https://github.blog/changelog/2026-06-25-github-copilot-for-jira-is-now-generally-available/); [Devin](https://releasebot.io/updates/devin).
7. Multi-agent/multi-vendor hubs (Agent HQ, Warp) and auto-decomposition into parallel subagents (Cursor 3.3, Amp) — [GitHub](https://github.blog/news-insights/company-news/welcome-home-agents/); [DEV](https://dev.to/davekurian/cursor-3s-parallel-agents-change-what-a-template-ships-with-joc).
8. In-house fast models for high-volume sub-steps (review), with admin model governance — [TheRouter.ai](https://therouter.ai/news/cursor-bugbot-composer-2-5-model-block-list-governance/).
