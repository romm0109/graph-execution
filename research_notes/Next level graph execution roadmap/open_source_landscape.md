# Open-source landscape: multi-agent coding orchestration (as of 2026-11-10)

> **About these notes (read first).** This session could reach only the web search tool. Direct page fetches (openalternative.co, addyosmani.com, augmentcode.com) failed DNS under the session's network allowlist, and both the GitHub API (`gh` and `api.github.com`) were blocked. So:
> - Star counts come from third-party snapshots dated in the search results. Treat them as approximate and re-check on GitHub.
> - Items tagged **[BK]** come from the researcher's background knowledge (training data up to about mid-2026). They were **not** re-verified this session, and the link is the canonical repo or page, not proof of the claim. The report writer should treat [BK] items as lower confidence.
> - Every other item cites the search result it came from.

---

## Q1. Which tools orchestrate task graphs, and how do they decompose work, merge, verify and keep memory?

### Takeaway
The field splits into four layers:
1. **Single-agent harnesses**: OpenCode, Claude Code, Codex, Goose, Aider, mini-swe-agent.
2. **Parallel-session managers**: Claude Squad, Conductor, Crystal/Nimbalyst, vibe-kanban, Sculptor, container-use, Emdash. These give each agent a worktree or container, but a human decides what to merge.
3. **Spec/task planners**: Spec Kit, Kiro, BMAD, Task Master, beads. These produce task lists and dependencies, but most do not execute them in parallel.
4. **Fleet orchestrators**: Gas Town, Composio Agent Orchestrator, Claude Flow/Ruflo, OpenHands Refactor SDK, Claude Code agent teams. These do run many agents, but usually as PR-per-agent or role-based swarms, not a validated DAG.

Almost nobody combines all of it in one open-source CLI: a dependency DAG, an integration branch with AI conflict resolution, validation gates, and a multi-reviewer and fixer loop against a PRD. That combination is graph-execution's niche.

### Cited Findings

**Parallel-session managers (isolation-first, human merges)**
- **Common pattern.** Most tools give each agent its own git worktree on a separate branch. Worktrees isolate files but not ports, databases or Docker daemons, so dev servers collide. — [Tembo roundup](https://www.tembo.io/blog/ai-agent-orchestration-tools); [CircleCI](https://circleci.com/blog/parallel-coding-agents/)
- **Coordination is still manual.** One 2026 review found that most tools "still leave task alignment, conflict resolution, and merge decisions" to the human. Augment Intent is an exception: a coordinator agent decomposes features and runs implementors in parallel worktrees. — [Verdent guide](https://www.verdent.ai/guides/multi-agent-coding-tools); [Augment OSS orchestrators](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- **Claude Squad** (smtg-ai/claude-squad). Terminal UI; each agent runs in its own tmux session and git worktree. About 8,700 stars as of 2026-10-31. — [Traycer comparison](https://traycer.ai/compare/best-parallel-coding-agent-tools)
- **vibe-kanban** (BloopAI/vibe-kanban). Kanban board that dispatches cards to Claude Code, Codex and other agents, each in a worktree. About 28.5–28.6k stars (2026-10-26). Its company, Bloop, **shut down on 2026-04-10**; the project is now community-maintained and the cloud boards are gone. A community add-on (ericblue/claude-vibekanban) adds a PRD-to-tasks workflow. — [GitHub](https://github.com/BloopAI/vibe-kanban); [DEV: alternatives after Bloop shutdown](https://dev.to/agentverateam/vibe-kanban-alternatives-after-the-bloop-shutdown-2026-p80); [ericblue/claude-vibekanban](https://github.com/ericblue/claude-vibekanban)
- **Crystal → Nimbalyst** (stravu/crystal). MIT, about 3,100 stars, last commit 2026-02-26. The repo now points to nimbalyst.com. — [Traycer comparison](https://traycer.ai/compare/best-parallel-coding-agent-tools); [Nimbalyst worktrees guide](https://nimbalyst.com/blog/git-worktrees-for-ai-coding-agents-complete-guide/)
- **Conductor** (Melty Labs; closed source, Mac). Runs Claude Code, Codex or Cursor agents, each in a worktree, with a diff-first review UI. One roundup says **Conductor Cloud shuts down 2026-11-20**; another says there have been no new sign-ups since 2026-11-04. Both claims are unverified. — [Tembo](https://www.tembo.io/blog/ai-agent-orchestration-tools); [Augment desktop apps](https://www.augmentcode.com/tools/best-ai-coding-agent-desktop-apps)
- **Sculptor** (Imbue). Each agent runs in its **Docker container** instead of a worktree, and changes sync back when the user approves. Sources disagree on which agents it supports (Claude Code plus Imbue's "Pi" harness, versus its own model-based agents). — [Augment desktop apps](https://www.augmentcode.com/tools/best-ai-coding-agent-desktop-apps); [DEV: managing parallel agents](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8)
- **Emdash.** Apache-2.0 "agentic development environment" that runs 25+ coding agents, each in its own worktree. — [Agentastic comparison](https://www.agentastic.dev/compare/ai-coding-agent-orchestration-tools)
- **container-use** (dagger/container-use). [BK] An MCP server (2025) that gives each agent its own container plus git branch, so users can inspect the agent's environment and `git checkout` its work. It returned no 2026 coverage in search. — [repo](https://github.com/dagger/container-use)
- **Uzi** (devflowinc/uzi). [BK] A 2025 CLI that runs several agents in worktrees with their own dev-server ports, and includes a "checkpoint"/merge command. It returned **no 2026 search coverage**, which suggests it is dormant. — [repo](https://github.com/devflowinc/uzi)
- **Zed parallel agents** (2026). The HN discussion reports port conflicts with Docker projects. — [HN](https://news.ycombinator.com/item?id=47866750)

**Fleet orchestrators (many agents, some automation)**
- **Gas Town** (steveyegge/gastown, now gastownhall/gastown). Go and tmux; launched **2026-01-01**; reached v1.0 later in 2026. Runs 20–30 parallel agents through seven roles: Mayor (coordinator), Polecats (workers), Refinery (merge queue), Witness, Deacon, Dogs and Crew, across multiple project "rigs". Work state persists in git-backed hooks. It is built on **beads**, but beads is "completely unaware of Gas Town". Critics cite a steep learning curve and high complexity; supporters say it tackles the real coordination problems. — [ascii.co.uk 2026-01-02](https://ascii.co.uk/news/article/news-20260102-190a5f9f/steve-yegge-releases-gas-town-multi-agent-orchestrator-for-c); [GitHub](https://github.com/gastownhall/gastown); [Yegge: Clown Show to v1.0](https://steve-yegge.medium.com/gas-town-from-clown-show-to-v1-0-c239d9a407ec); [SE Daily 2026-02-12](https://softwareengineeringdaily.com/2026/02/12/gas-town-beads-and-the-rise-of-agentic-development-with-steve-yegge/); [heise](https://heise.de/-11178824); [cloudnativenow 2026-06-02](https://cloudnativenow.com/features/gas-town-what-kubernetes-for-ai-coding-agents-actually-looks-like/)
- **beads** (steveyegge/beads). Started as a lightweight, git-versioned issue tracker for agents. [BK] Issues live as JSONL in the repo, with typed dependency edges (blocks, parent-child, discovered-from); `bd ready` lists unblocked work. It gives agents durable, queryable memory across sessions. — [ascii.co.uk](https://ascii.co.uk/news/article/news-20260125-f25263de/steve-yegges-gas-town-reveals-agent-orchestration-design-pat); [repo](https://github.com/steveyegge/beads)
- **Composio Agent Orchestrator** (ComposioHQ/agent-orchestrator; npm package renamed `@composio/agent-orchestrator` → `@composio/ao`). MIT. Each agent gets its own worktree, branch and **PR**. Failed **CI logs go back to the agent that opened the PR**, which tries a fix, with configurable retry limits and escalation after a timeout. **Review comments are routed back** to the authoring agent. Composio describes it as "self-improving", built largely by itself. — [Mintlify docs](https://mintlify.com/ComposioHQ/agent-orchestrator/introduction); [Composio blog](https://composio.dev/blog/the-self-improving-ai-system-that-built-itself); [orchestrator landscape (Scion, CAO, Composio), 2026-04-17](https://codex.danielvaughan.com/2026/04/17/agent-orchestrator-landscape-scion-cao-composio/)
- **Claude Flow → Ruflo** (ruvnet). Swarm and "hive-mind" orchestration for Claude Code, with SQLite memory. Critics report that much of it is stubbed: a Substack analysis lists agent execution, hive-mind transport and the workflow runtime as stubs, and an anonymous gist (unverified) says hive-mind is essentially `spawn('claude', ['--dangerously-skip-permissions', …])`. A GitHub issue reports that uninstalling leaves `.swarm/`, `.hive-mind/` and other folders behind, plus edits to `.claude/settings.json`. Its marketing numbers (for example 84.8% on SWE-bench) are unvalidated. — [AlphaSignal Substack](https://alphasignalai.substack.com/p/how-ruflo-turns-claude-code-into); [ruflo issue #1375](https://github.com/ruvnet/ruflo/issues/1375); [discussion #1513](https://github.com/ruvnet/ruflo/discussions/1513); [rywalker research](https://rywalker.com/research/claude-flow)
- **OpenHands** (OpenHands/OpenHands, MIT; grew out of OpenDevin). The V1 Software Agent SDK overhaul shipped around Nov 2025. For large refactors it uses a **rolling integration branch** (for example `v1-refactor`) with per-agent sub-branches (`v1-refactor/component-a`); agents resolve conflicts, and humans check at checkpoints. The separate **Refactor SDK** (task decomposition that finds independent code sections, fixers, verifiers, progress tracking) is in **private beta**. — [OpenHands blog](https://openhands.dev/blog/automating-massive-refactors-with-parallel-agents); [AI Engineer talk](https://ai.engineer/talks/automating-large-scale-refactors-with-parallel-agents); [agentwiki](https://agentwiki.org/_export/raw/openhands)
- **Claude Code built-ins.** Subagents run inside one session. **Agent teams** (experimental, off by default, enabled with an env var as of 2026-04) add a shared task list, peer messaging and file locking. The docs put them at about **7× the tokens** of a standard session when teammates run in plan mode. **Codex** now enables subagents by default; `/subagents` switches between threads. — [Parreño Garcia Substack](https://joseparreogarcia.substack.com/p/claude-code-agent-teams); [qcode guide](https://qcode.cc/en/ai-coding-multi-agent-guide)
- **Ralph Wiggum loop.** Geoffrey Huntley, post dated 2025-07-14. A bash `while` loop re-runs an agent on the same prompt file. Each pass starts with fresh context, and state lives in files and git. There is no framework. Anthropic shipped an official Ralph plugin for Claude Code in Dec 2025 built on Stop hooks; purists, including Huntley, say it misses the point. The Register (2026-01-27) covered the loop being used to "vibe-clone commercial software for $10 an hour". An unverified anecdote claims a $50k contract was delivered for $297 in API costs. Huntley describes it as "deterministically bad in an undeterministic world". — [The Register](https://www.theregister.com/2026/01/27/ralph_wiggum_claude_loops/); [VentureBeat](https://venturebeat.com/ai/how-ralph-wiggum-went-from-the-simpsons-to-the-biggest-name-in-ai-right-now/); [Dev Interrupted interview](https://devinterrupted.substack.com/p/inventing-the-ralph-wiggum-loop-creator); [DreamHost explainer](https://www.dreamhost.com/blog/ralph-wiggum/)

**Spec and task planners (decomposition, but mostly serial execution)**
- **GitHub Spec Kit** (github/spec-kit). MIT. Workflow is constitution → specify → plan → tasks → implement, as plain markdown, across about 30 agents. One source reports **115k+ stars by June 2026**. The main criticism is "review overload from verbose markdown". [BK] `tasks.md` marks tasks that can run in parallel with `[P]`, but Spec Kit does not run them itself. — [ssojet](https://ssojet.com/blog/best-spec-driven-development-tools); [codemyspec](https://codemyspec.com/blog/spec-driven-development); [aicodingpatterns](https://aicodingpatterns.com/en/patterns/openspec-vs-spec-kit-vs-bmad/)
- **BMAD-METHOD** (bmad-code-org). A simulated agile team (analyst, PM, architect, scrum master, dev, QA) with a plan-then-develop lifecycle. Critics estimate about **2 months to master**, versus a day or two for Spec Kit. — [ssojet](https://ssojet.com/blog/best-spec-driven-development-tools); [particula](https://particula.tech/blog/spec-driven-development-tools-spec-kit-vs-kiro-vs-tessl)
- **Uvik SDD benchmark** (50 Python tickets; self-reported, not peer-reviewed): Spec Kit 80%, BMAD 82%, with BMAD costing more per run. — [Uvik](https://uvik.net/blog/spec-driven-development-benchmark/)
- **Kiro** (AWS; closed IDE, metered pricing). Produces requirements in **EARS** notation, a design doc and a sequenced task list with requirement-to-task traceability. — [particula](https://particula.tech/blog/spec-driven-development-tools-spec-kit-vs-kiro-vs-tessl); [augment SDD tools](https://www.augmentcode.com/tools/best-spec-driven-development-tools)
- **Task Master** (eyaltoledano/claude-task-master). A PRD-to-ordered-tasks engine, MIT with Commons Clause. [BK] Supports task dependencies, a complexity-analysis command that expands complex tasks into subtasks, a "next task" command, and an MCP server. Execution is still one task at a time. — [codemyspec](https://codemyspec.com/blog/best-spec-driven-development-tools); [repo](https://github.com/eyaltoledano/claude-task-master)
- **OpenSpec** and **Tessl** are other 2026 SDD tools named in comparisons. — [ssojet](https://ssojet.com/blog/best-spec-driven-development-tools)

**Single-agent harnesses (the "workers" graph-execution drives)**
- **OpenCode** (sst/opencode). About **209k–212k stars** (Sep–Oct 2026). Has dual build and plan agents. **Kilo Code** (about 27.4k stars, Sep 2026, up from 16.2k in Mar 2026) is an OpenCode fork with an **Orchestrator mode** that splits a task into isolated subtasks (the "boomerang" pattern that came from Roo Code). — [morphllm OpenCode vs Kilo](https://www.morphllm.com/comparisons/opencode-vs-kilo-code); [morphllm Kilo vs OpenCode](https://www.morphllm.com/comparisons/kilo-code-vs-opencode); [Tembo CLI guide](https://www.tembo.io/blog/coding-cli-tools-comparison)
- **Roo Code / Cline.** [BK] Roo's Orchestrator ("Boomerang") mode spawns subtasks in other modes, each with its own context, and returns only summaries to the parent. Cline added CLI/headless and subagent features in 2025. Neither uses worktree isolation or a DAG. — [Roo Code](https://github.com/RooCodeInc/Roo-Code); [Cline](https://github.com/cline/cline)
- **Goose** (block/goose; Apache-2.0, Rust). About **54.6k stars** (Sep 2026). Donated to the Linux Foundation's AAIF in Dec 2025. [BK] Has "recipes" and sub-recipes and subagents for parallel subtasks. — [morphllm OpenCode vs Goose](https://www.morphllm.com/comparisons/opencode-vs-goose); [getgalaxy](https://www.getgalaxy.io/articles/ai-agent-communication)
- **Aider** (Aider-AI/aider). About **49.1k stars** (Sep 2026). **No commits since 2026-05-22** according to an Aug 2026 post, so development has slowed. [BK] Known for architect/editor model pairing and auto-lint and test after each edit. — [morphllm open-source assistants](https://www.morphllm.com/ai-coding-assistant-open-source)
- **SWE-agent → mini-swe-agent.** The SWE-agent README now says most development has moved to mini-swe-agent. mini-swe-agent v2.0.0 shipped Feb 2026 and v2.4.6 Jul 2026. It has only bash, a linear message history and independent commands, and scores above 74% on SWE-bench Verified. Stars: about 5.6k–8.9k (Jul–Oct 2026). — [PyPI](https://pypi.org/project/mini-swe-agent/); [vibecodinghub review](https://vibecodinghub.org/blog/mini-swe-agent-review); [DEV underrated harnesses](https://dev.to/rigor120000/underrated-ai-coding-agent-harnesses-in-2026-pi-mini-swe-agent-crush-plandex-amp-and-more-5c0a)
- **Plandex.** Terminal tool for large multi-file tasks. [BK] Changes collect in a diff sandbox that the user reviews before applying, and it supports plan branches. Activity in 2026 is unclear. — [faun.dev](https://faun.dev/toolbox/mini-swe-agent-vs-plandex/)
- **AutoCodeRover.** AST-aware code search plus spectrum-based fault localization. No 2026 release info was found. **Agentless** [BK]: a fixed localize → repair → validate pipeline that samples several patches, keeps those that pass regression and reproduction tests, and majority-votes among them. No 2026 coverage was found. — [DEV OSS agents 2026](https://dev.to/jovan_chan_9500711396d4e6/open-source-coding-agents-2026-which-one-to-run-5g14); [Agentless repo](https://github.com/OpenAutoCoder/Agentless)
- **MetaGPT / ChatDev.** "Software company" frameworks with SOP-based roles (PM, architect, engineer, QA). No 2026 release or status info was found; they appear to be research-era projects. — [DEV OSS agents 2026](https://dev.to/jovan_chan_9500711396d4e6/open-source-coding-agents-2026-which-one-to-run-5g14)
- **LangGraph-based coding agents.** [BK] LangChain's **Open SWE** (langchain-ai/open-swe, 2025) is an async cloud agent built on LangGraph, with planner, programmer and reviewer graph nodes, and it opens PRs. Its 2026 status was not verified. — [repo](https://github.com/langchain-ai/open-swe)
- **Academic harness study.** "Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents" (arXiv 2609.00006, Sep 2026) is a source-code study of 11 systems and could be useful for the report writer. — [arXiv](https://arxiv.org/html/2609.00006v1)

### Implication for graph-execution (per tool or pattern)
- **Claude Squad, Conductor, Crystal, vibe-kanban, Emdash:** These are session managers, and graph-execution is a level above them. Borrow the kanban-style board (vibe-kanban's main draw) for graph-manager's dashboard. Two companies have shut down in this space (Bloop; Conductor Cloud reportedly), so a self-hostable OSS tool is a selling point.
- **Sculptor and container-use:** Their per-agent container isolation matches graph-manager's per-run Docker sandboxes, but at **task granularity**. Consider per-task containers or per-task port and DB namespaces to solve the shared-ports and shared-DB collisions people report with worktrees.
- **Gas Town:** Borrow the **Refinery** idea, a dedicated merge-queue role (graph-execution's integration-branch merger is close already), and git-backed persisted work state, which overlaps with graph-execution's resume. Avoid its role sprawl and learning curve; graph-execution's "folder of JSON tasks" is simpler.
- **beads:** Add a **beads adapter**: import ready beads issues and their dependency edges as a task DAG, and write status back. Also add a `discovered-from` mechanism so agents can file follow-up tasks mid-run instead of drifting out of scope.
- **Composio AO:** Graph-execution stops at "uncommitted changes" (graph-manager has Create PR). Borrow the **post-PR loop**: route CI failures and PR review comments back to the agent or task that owns the code, with retry limits and escalation.
- **Claude Flow/Ruflo:** A cautionary tale. Trust erodes when features are documented but stubbed, and when uninstall leaves state behind. Keep an honest "implemented / experimental" matrix in the README, and keep `.graph-execution/` self-contained.
- **OpenHands rolling integration branch:** This validates graph-execution's integration-branch design. The Refactor SDK's automatic "find independent sections" decomposition is still private beta, so graph-execution's to-tasks skill is ahead in OSS. Possible addition: a dependency-graph or code-ownership analysis to suggest task boundaries that minimise file overlap.
- **Claude Code agent teams and Codex subagents:** Vendors are absorbing the basic multi-agent pattern. Graph-execution should **stay provider-agnostic** and could let a single task use the provider's native subagents internally. Cite the about-7× token cost of agent teams when arguing for DAG-scheduled, isolated tasks.
- **Ralph loop:** Graph-execution's fixer loop is a bounded, review-gated Ralph. Two options: a "ralph mode" task type (re-run with fresh context until the validation command passes or the budget runs out), and making the fresh-context-per-iteration principle explicit in the fixer.
- **Spec Kit, Kiro, BMAD, Task Master:** These all stop at a task list. Graph-execution's to-spec and to-tasks skills plus parallel execution is the "missing back half". Add **importers** from Spec Kit `tasks.md` (with `[P]` markers), Kiro task lists and Task Master `tasks.json` into the graph-execution task format. Borrow Kiro's **EARS acceptance criteria and requirement → task traceability** so reviewers can check each criterion.
- **Kilo/Roo boomerang:** Summary-only return to the parent is a proven way to control context, and it applies to how graph-execution passes dependency results to downstream tasks.
- **Agentless:** Sample-and-select (several candidate patches per task, keep those that pass validation, then pick by test results or review) could be an optional "best-of-N" mode for high-risk tasks.
- **mini-swe-agent:** The minimal-harness trend favours keeping graph-execution's provider adapter thin. Adding mini-swe-agent as a provider would cover cheap and local models.

### Gaps
- No live GitHub star counts for OpenHands, Spec Kit (only the June 2026 "115k+"), BMAD, Task Master, Claude Flow/Ruflo, Gas Town, beads, Composio AO, container-use, Sculptor, MetaGPT, ChatDev, Plandex, AutoCodeRover, Agentless or Cline/Roo, because the GitHub API was blocked.
- Uzi, container-use, Agentless and ChatDev returned no 2026 coverage; their status is unknown.
- The Conductor Cloud shutdown date (2026-11-20) and the sign-up freeze come from single secondary sources.
- Whether Gas Town's Refinery uses AI conflict resolution or rebase-and-retry was not confirmed.

---

## Q2. What do users get excited about, and what failures do they report?

### Takeaway
People get excited about running many agents at once with zero setup (worktrees plus a dashboard), spec-first workflows, and dumb-but-persistent loops (Ralph). The common failures are merge incoherence (clean merges that break the build), review becoming the bottleneck, runtime collisions (ports and DBs), token blowups from multi-agent setups, and over-engineered frameworks whose features turn out to be stubs.

### Cited Findings
- **Clean merges that are semantically broken.** Two agents can change the same function on two branches and merge cleanly into a broken build. An HN commenter: "neither worktree is 'wrong' but the code is incoherent". — [HN search results / CircleCI](https://circleci.com/blog/parallel-coding-agents/); [HN: parallel coding agent lifestyle](https://news.ycombinator.com/item?id=45489884)
- **Review is the bottleneck.** "It is where most of the remaining cost of parallel agents sits." On HN: keeping environments straight and merging to the right upstream branches "can quickly turn into a very complex co-ordination problem". — [CircleCI](https://circleci.com/blog/parallel-coding-agents/); [HN: desktop app for parallel agentic dev](https://news.ycombinator.com/item?id=46027947)
- **Skeptics:** "if your hitting merge conflicts that bad all the time you should probably just have a single agent doing the work." — [HN](https://news.ycombinator.com/item?id=45489884)
- **Runtime collisions:** Worktrees don't isolate ports, databases or other services; HN users report port conflicts with Docker projects in Zed's parallel agents. — [CircleCI](https://circleci.com/blog/parallel-coding-agents/); [HN: Parallel agents in Zed](https://news.ycombinator.com/item?id=47866750)
- **Practitioner win:** A hackathon team took second place with Codex and 18 git worktrees. A conflict appeared in a shared contracts package. "Review and CI told us whether we could merge that progress." — [DEV](https://dev.to/carlos/how-we-took-second-at-a-hackathon-with-codex-and-18-git-worktrees-n1b)
- **Aggregate HN sentiment:** an analysis of 663 HN comments on agent setups. — [techbytes](https://techbytes.app/posts/ai-coding-agent-setups-from-663-hacker-news-comments/)
- **A new merge tool:** "Show HN: Foremerge" (2026) is a merge-focused tool for agent output. This shows the merge problem is attracting dedicated tools. — [HN](https://news.ycombinator.com/item?id=49789356)
- **Cost:** Claude Code agent teams use about 7× the tokens of a standard session (plan-mode teammates). — [Substack](https://joseparreogarcia.substack.com/p/claude-code-agent-teams). The Ralph loop is marketed as cheap ("$10 an hour"). — [The Register](https://www.theregister.com/2026/01/27/ralph_wiggum_claude_loops/)
- **Framework trust failures:** Claude Flow/Ruflo features are stubbed and uninstall leaves state behind. — [ruflo #1375](https://github.com/ruvnet/ruflo/issues/1375); [AlphaSignal](https://alphasignalai.substack.com/p/how-ruflo-turns-claude-code-into)
- **Heavy process fatigue:** Spec Kit causes "review overload from verbose markdown"; BMAD takes about 2 months to master. — [ssojet](https://ssojet.com/blog/best-spec-driven-development-tools)
- **Complexity and learning curve:** Gas Town is criticised for a steep learning curve and high complexity. — [ascii.co.uk](https://ascii.co.uk/news/article/news-20260125-f25263de/steve-yegges-gas-town-reveals-agent-orchestration-design-pat)
- **Vendor risk:** Bloop (vibe-kanban) shut down 2026-04-10; Conductor Cloud is reportedly shutting down 2026-11-20. — [DEV](https://dev.to/agentverateam/vibe-kanban-alternatives-after-the-bloop-shutdown-2026-p80); [Tembo](https://www.tembo.io/blog/ai-agent-orchestration-tools)

### Inferences
- Graph-execution's pipeline (validation gates after each merge, then whole-result reviewers plus a live tester) directly answers the "clean merge, broken build" and "review bottleneck" complaints. That should be the headline message.
- Its weak spot is cost visibility. Users fear multi-agent token blowups, so per-task and per-run **token/$ budgets with hard stops**, shown in the web view, would counter a well-known objection.
- Task boundaries drive conflict rate. A pre-run **file-overlap check** (tasks that touch the same files must be chained or merged) would reduce merge hell before it happens. This is the same guidance CLAUDE.md gives humans.

### Gaps
- No quantitative cost data for parallel-agent runs was found, beyond the 7× agent-teams figure.
- No first-hand HN threads on Gas Town or Composio AO were fetched (fetch was blocked).
- No Reddit or X sentiment was captured this session.

---

## Q3. Which standards are emerging (AGENTS.md, MCP, A2A, ACP, skills, beads)?

### Takeaway
Standards consolidated under the Linux Foundation's **Agentic AI Foundation (AAIF, formed Dec 2025)**: MCP, AGENTS.md, goose and, from Aug 2026, A2A. In the editor and client layer, Zed and JetBrains' **Agent Client Protocol** (with a registry since Jan 2026, about 50–60+ agents) is now the de facto way to drive any coding agent through one interface. IBM's other "ACP" (Agent Communication Protocol) merged into A2A in Aug 2025.

### Cited Findings
- **AAIF.** Formed Dec 2025 with MCP (Anthropic), AGENTS.md (OpenAI) and goose (Block). As of Aug 2026 it hosts A2A, MCP, AGENTS.md, goose and agentgateway. — [getgalaxy](https://www.getgalaxy.io/articles/ai-agent-communication); [blckalpaca](https://blckalpaca.at/en/knowledge-base/ai-agents/a2a-protocol-basics/linux-foundation-aaif-bedeutung)
- **A2A.** Google gave it to the Linux Foundation in Jun 2025; v1.0 in early 2026 (sources say Jan–Mar 2026; one says 2026-03-12); joined AAIF in Aug 2026 (sources say the 17th, 18th or 27th). The Linux Foundation reports 150+ supporting organisations. — [pebblous](https://blog.pebblous.ai/blog/a2a-mcp-agentic-ai-foundation-authorization/en/); [dailyaiworld](https://dailyaiworld.com/blogs/a2a-10-joins-agentic-ai-foundation-internet-agents); [cryptothreads](https://cryptothreads.io/insights/a2a-protocol-linux-foundation/)
- **IBM's Agent Communication Protocol** was folded into A2A in Aug 2025. Do not confuse it with Zed's Agent *Client* Protocol. — [architecturediagram.ai](https://architecturediagram.ai/blog/ai-agent-interoperability-protocols); [boldare](https://www.boldare.com/blog/agent-communication-protocol-acp-explained-what-it-is-and-why-it-matters/)
- **Agent Client Protocol (Zed).**
  - JetBrains joined Oct 2025; beta support in a Dec 2025 RC.
  - The ACP Registry launched **2026-01-28** with 9 agents (Claude Code, Codex CLI, Gemini CLI, Copilot); it later grew to about 50 agents (DEV) or 60+ (Zed page, via rywalker).
  - Cursor joined in Mar 2026. Docker's cagent supports ACP.
  - ACP was the headline feature of **Zed 1.0 (2026-04-29)**, with Claude Code, Codex CLI, Gemini CLI and OpenCode available.
  - Zed first wrote the Claude Code and Codex adapters, then handed adapter work to the community.

  Sources: [zed.dev ACP registry](https://zed.dev/blog/acp-registry); [JetBrains blog 2026-01](https://blog.jetbrains.com/ai/2026/01/acp-agent-registry/); [heise](https://heise.de/-11160709); [gihyo.jp](https://gihyo.jp/article/2026/01/acp-registry); [tessl 2025-10-23](https://tessl.io/blog/jetbrains-joins-agent-client-protocol-to-open-ai-coding-agents-to-any-ide/); [Docker blog](https://docker.com/blog/docker-jetbrains-and-zed-building-a-common-language-for-agents-and-ides/); [rywalker](https://rywalker.com/research/zed-agent-client-protocol); [zed.dev/acp](https://zed.dev/acp); [Codex in Zed](https://zed.dev/blog/codex-is-live-in-zed)
- **Skills format.** [BK] Anthropic launched Agent Skills (`SKILL.md` folders with YAML front matter: name, description; progressive disclosure) in Oct 2025 and published it as an open spec in Dec 2025. Other agents adopted it during 2026. Not re-verified this session. — [anthropics/skills](https://github.com/anthropics/skills)
- **beads as a de facto standard.** It is a standalone issue tracker that Gas Town and others build on, and it reached v1.0 in 2026. — [ascii.co.uk](https://ascii.co.uk/news/article/news-20260125-f25263de/steve-yegges-gas-town-reveals-agent-orchestration-design-pat); [Yegge Medium](https://steve-yegge.medium.com/gas-town-from-clown-show-to-v1-0-c239d9a407ec)

### Inferences / Implication for graph-execution
- **ACP as a universal provider adapter.** Graph-execution keeps separate adapters for Claude Code, Codex, OpenCode and Qwen Code. An **ACP client provider** would cover the 50+ agents in the registry with one adapter, and would give structured session, tool-call and permission events for the web view and for loop and idle detection. This is the highest-leverage standards move.
- **AGENTS.md:** Inject or merge each task's context through the repo's AGENTS.md, and have to-tasks read AGENTS.md and CLAUDE.md. Generated task content should not duplicate those files.
- **MCP:** graph-manager already exposes MCP tools. Expose **graph-execution itself as an MCP server** (start run, status, retry task, read review notes) so any agent or IDE can drive it. Composio AO and Task Master both ship MCP surfaces.
- **A2A:** Low priority for a local CLI. Possibly expose runs as A2A tasks for enterprise and agent-mesh users later.
- **Skills:** to-spec, to-tasks and run-graph already use the skills format, which is aligned. Publish them as installable skills in a public skills marketplace.
- **beads:** Add import and export (see Q1).

### Gaps
- The exact A2A v1.0 and AAIF-join dates conflict across secondary sources; the official LF/AAIF announcement was not fetched.
- The 2026 status of the Agent Skills open standard (governance, which vendors adopted it) was not verified this session.

---

## Q4. Where is graph-execution ahead, and where is it behind?

### Takeaway
Graph-execution is **ahead** on: end-to-end DAG execution with dependency scheduling, an integration branch with AI conflict resolution, validation gates, a PRD-anchored multi-reviewer, live-tester and fixer loop, multi-feature suites, and spec and task authoring skills. No single OSS tool found does all of these. It is **behind** on: distribution and mindshare (stars), post-PR automation (CI and review comment routing), editor and protocol integration (ACP), per-task runtime isolation, cost controls, durable cross-run memory or issue-tracker integration, and the UX polish of kanban and desktop apps.

### Cited Findings (comparators)
- Session managers leave merging to humans. — [Verdent](https://www.verdent.ai/guides/multi-agent-coding-tools)
- SDD tools stop at task lists. — [ssojet](https://ssojet.com/blog/best-spec-driven-development-tools)
- OpenHands' automated decomposition and verification (Refactor SDK) is still private beta. — [OpenHands blog](https://openhands.dev/blog/automating-massive-refactors-with-parallel-agents)
- Composio AO routes CI and review feedback to agents. — [Mintlify](https://mintlify.com/ComposioHQ/agent-orchestrator/introduction)
- The ACP registry has 50–60+ agents. — [rywalker](https://rywalker.com/research/zed-agent-client-protocol)
- Mindshare benchmarks: OpenCode about 212k, Spec Kit 115k+, vibe-kanban about 28.6k, Kilo about 27k, Claude Squad about 8.7k. — [morphllm](https://www.morphllm.com/comparisons/opencode-vs-kilo-code); [ssojet](https://ssojet.com/blog/best-spec-driven-development-tools); [Traycer](https://traycer.ai/compare/best-parallel-coding-agent-tools)

### Inferences

**Ahead**

| Capability | graph-execution | Nearest OSS comparator |
|---|---|---|
| DAG scheduling from task files | Yes | Task Master and beads have dependency graphs but no parallel executor; Gas Town (Mayor) dispatches work but is role-based |
| Integration branch with AI conflict resolution | Yes | OpenHands rolling branch (agents resolve, humans checkpoint); Gas Town Refinery |
| Validation gates per merge | Yes | Composio AO (CI after PR); most others have none |
| PRD-anchored parallel reviewers, live tester, N fixer passes | Yes | BMAD QA role (serial); Agentless test-based selection (research) |
| Multi-feature suites | Yes | None found |
| Interactive spec → task authoring skills | Yes | Spec Kit, Kiro, Task Master (planning only) |
| Multi-provider (Claude, Codex, OpenCode, Qwen) | Yes | Claude Squad, vibe-kanban, Conductor |

**Behind or opportunities (in rough priority order)**
1. **ACP client provider**, to reach any registry agent through one adapter.
2. **Post-apply / post-PR loop**: route CI failures and PR review comments back to the owning task (Composio AO).
3. **Cost governance**: per-task and per-run token and $ budgets with hard stops, shown in the web view (answers the 7× agent-teams fear).
4. **Pre-run conflict prediction**: a file and symbol overlap check across tasks, suggesting chaining or merging (answers "merge hell").
5. **Per-task runtime isolation**: container or port and DB namespacing (Sculptor, container-use), not only per-run sandboxes.
6. **Durable memory and issue-tracker integration**: beads, Spec Kit, Kiro and Task Master importers; agents can file "discovered" follow-up tasks mid-run (beads `discovered-from`).
7. **MCP server for graph-execution**, so IDEs and agents can start, monitor and retry runs.
8. **Best-of-N per risky task** (Agentless-style sample-and-select) and a "ralph mode" retry-until-green task type.
9. **Traceability**: EARS-style acceptance criteria per user story, mapped to tasks and reviewer verdicts (Kiro).
10. **UX and distribution**: a kanban view in graph-manager, an honest feature-maturity matrix (the Ruflo lesson), and positioning as the self-hostable OSS option after the Bloop and Conductor shutdowns.

### Gaps
- No head-to-head benchmark (success rate, cost, wall-clock) exists between DAG orchestrators like graph-execution and session managers or role swarms. A self-run benchmark on the same PRD would give the strongest evidence.
- Gas Town's and Composio AO's verification depth (do they run reviewers against a spec?) could not be confirmed from primary READMEs because fetch was blocked.
