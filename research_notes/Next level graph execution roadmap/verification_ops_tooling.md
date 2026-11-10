# Verification, review, observability, cost and security tooling for autonomous coding agents (as of 2026-11-10)

Method note: findings come from web search result summaries (about 17 searches). Page fetches of cursor.com and arize.com failed because those hosts are outside this session's network allowlist, so several primary vendor pages were seen only through search summaries. Most comparison numbers come from vendor or secondary blogs; this is flagged per item.

## 1. AI code review products and techniques: what makes reviewers precise?

### Takeaway
The precise reviewers in 2026 share three techniques: (a) generate candidates in parallel, then run a separate **verification pass** that tries to disprove each finding before posting it; (b) give the reviewer **codebase context beyond the diff** (a repo graph, the blast radius, existing reviewer comments); (c) a **feedback loop** that turns reactions to and dismissals of comments into rules that are kept or retired. The headline metric is now the **resolution rate**: the share of comments that lead to a code change before merge. All published benchmarks conflict and most are vendor-run.

### Cited Findings
- **Cursor Bugbot resolution rate:** Cursor's 2026-04-08 post says it is "nearing 80%". Its own table lists Bugbot at 78.13% on 50,310 PRs, Greptile at 63.49% and CodeRabbit at 48.96%, judged by an LLM on public repos. The rate rose from 52% at GA (July 2025) to over 70% after 40 experiments (Jan 2026) and 76% (Feb 2026) — [Cursor blog: Bugbot learning](https://cursor.com/blog/bugbot-learning); [Cursor changelog 04-08-26](https://cursor.com/changelog/04-08-26); [creativeainews summary](https://www.creativeainews.com/blog/cursor-bugbot-78-resolution-rate-learned-rules/)
- **Bugbot learned rules:** Bugbot reads reactions and replies to its comments, plus comments from human reviewers, and turns them into *candidate rules*. It promotes rules that build up positive signal and disables those that stop being useful. Learning is on in more than 110k repos and has produced more than 44k learned rules. Cursor does not separate how much of the gain comes from learning and how much from model changes — [Cursor blog: Bugbot learning](https://cursor.com/blog/bugbot-learning); [startuphub summary](https://www.startuphub.ai/ai-news/technology/2026/bugbot-learns-from-live-code-reviews)
- **Bugbot Autofix:** Cursor also ships Autofix, which spawns an agent to fix what Bugbot finds — [Cursor blog: bugbot autofix](https://cursor.com/blog/bugbot-autofix). I saw only the page title and not its details.
- **Anthropic Code Review for Claude Code:** launched 2026-03-09 as a research preview for Team and Enterprise. It is a managed GitHub app that runs several Claude agents in parallel on each PR, verifies their findings and posts ranked comments. Reviews reportedly average $15–25 each. Anthropic reports that engineers marked fewer than 1% of findings incorrect (company-reported) — [SiliconANGLE 2026-03-09](https://siliconangle.com/?p=733747); [DEV: pricing, setup and limits](https://dev.to/umesh_malik/anthropic-code-review-for-claude-code-multi-agent-pr-reviews-pricing-setup-and-limits-3o35); [Gigazine 2026-03-10](https://www.gigazine.net/gsc_news/en/20260310-anthropic-claude-code)
- **anthropics/claude-code-security-review**, an open-source GitHub Action that runs a security review of the PR diff, warns explicitly that it is "not hardened against prompt injection" and should review only trusted PRs — [GitHub repo](https://github.com/anthropics/claude-code-security-review); [README](https://cdn.jsdelivr.net/gh/anthropics/claude-code-security-review@main/README.md); [Anthropic announcement](https://www.anthropic.com/news/automate-security-reviews-with-claude-code)
- **Greptile** indexes the repo into a graph of files, functions and dependencies. It runs parallel agents over the change *and its blast radius*, and reads existing engineer comments to learn house standards. It needs an initial indexing period — [levelop comparison](https://levelop.dev/blog/best-ai-code-review-tools-2026-coderabbit-greptile-qodo-compared); [baeseokjae Greptile review](https://baeseokjae.github.io/posts/greptile-review-2026/)
- **CodeRabbit** keeps "learnings", repo patterns gathered from feedback over time. It also runs LLM output through 40+ linters to reduce noise — [coderbuds comparison](https://coderbuds.com/blog/ai-code-review-tools-comparison-2026); [aicoolies](https://aicoolies.com/comparisons/coderabbit-vs-greptile)
- **Qodo:** the separate products (Merge, Gen, Command, Aware) have been merged into one "Qodo AI Code Review Platform" — [Wikipedia: Qodo](https://en.wikipedia.org/wiki/Qodo). **Graphite Diamond** is tuned to the team's feedback history inside stacked-PR workflows — [coderbuds](https://coderbuds.com/blog/ai-code-review-tools-comparison-2026)
- **Benchmarks conflict:**
  - On the Martian Code Review Bench, one source puts CodeRabbit first at 51.2% F1 (P 49.2%, R 53.5%) and another puts Qodo first at 63.4% precision.
  - A MorphLLM benchmark (Mar 2026) found Greptile at 66.2% precision and 40.4% recall, against CodeRabbit at 50.5% and 52.5%.
  - Greptile's own test (Jul 2025) claims an 82% bug catch rate for Greptile and 44% for CodeRabbit.
  - A Signal65 test reportedly gave Bugbot 95.95% precision with 3 false positives, but 23% fewer true positives than CodeRabbit.
  - A small self-run study (146 PRs, 679 findings) reported false-positive rates of 2.3% for CodeRabbit and 4.8% for Bugbot.
  - Sources: [levelop](https://levelop.dev/blog/best-ai-code-review-tools-2026-coderabbit-greptile-qodo-compared), [DEV 146-PR study](https://dev.to/_vjk/best-ai-code-reviewer-in-2026-we-ran-4-in-parallel-for-3-weeks-146-prs-679-findings-1c0f), [screencli](https://screencli.sh/blog/best-ai-pr-review-tools-2026), [codepulsehq](https://codepulsehq.com/guides/ai-code-review-bots-2026)
- An academic benchmark, c-CRAB (Mar 2026), reportedly found 40–70% false-positive rates for top review agents. This comes from a secondary source and is unverified — [promptquorum](https://www.promptquorum.com/prompt-engineering/ai-code-review)

### Inferences
- **Implication for graph-execution (verify-then-post):** the diff reviewers should produce *candidate* findings. A cheap second stage then tries to refute each one by reading the code, running a test or reproducing the problem. Only findings that survive should reach the fixer loop or the human. This mirrors Anthropic Code Review's "verify findings" step and Bugbot's validator design. It also directly cuts wasted fixer iterations.
- **Implication (resolution rate as the reviewer KPI):** graph-execution already has a closed loop of reviewer finding, then fixer, then re-review. Log each finding's fate (fixed by the fixer, dismissed by a human in review, ignored) and compute a per-reviewer, per-glob resolution rate. This gives the product an objective way to tune reviewer prompts and severity thresholds.
- **Implication (learned rules):** when a human dismisses a reviewer comment in the human-review step, store the dismissal and reason as a candidate rule (`.graph-execution/learned-rules.json` or committed to the repo). Inject the rules into future reviewer prompts, and retire a rule if it later correlates with missed bugs. This is a Bugbot-style loop that the product can build locally without a SaaS.
- **Implication (blast-radius context):** give reviewers callers and callees of the changed symbols, using the TypeScript language service, ctags or tree-sitter, plus the PRD acceptance criteria. Do not give them only the diff. This is Greptile's key differentiator.
- **Implication (deterministic pre-filter):** run linters, typecheck and SAST *before* the LLM reviewers and pass their output as context. This is the CodeRabbit "40+ linters" approach. The LLM then does not re-report what tools already catch.
- **Implication (integration, not competition):** a "reviewers: external" option could request a review from Bugbot, CodeRabbit or Claude Code Review on the PR that graph-manager creates, and pull their comments back into the fixer loop.

### Gaps
- No independent, methodologically clear false-positive benchmark exists. All numbers above are vendor-run or come from small samples.
- I found no reliable details on OpenAI Codex cloud code review, Sourcery or Ellipsis in 2026, beyond listings.
- The Bugbot architecture post (cursor.com/blog/building-bugbot) could not be fetched because the host is blocked. Its specifics (parallel passes, majority voting, validator) are therefore not verified here.

## 2. Browser/UI verification, evidence in PRs, API and mutation testing

### Takeaway
Two pieces became standard in 2026. **Playwright** (MCP or, more token-efficiently, its CLI with skills) drives and asserts on the UI. **Chrome DevTools MCP** is used to debug console, network and performance problems. "Proof of work" artifacts, such as a video or screenshots tied to the diff, are becoming the expected output of autonomous agents (Cursor cloud agents, the ProofShot and Argos patterns). Mutation testing is the best-supported way to check whether agent-written tests actually test anything (Meta ACH).

### Cited Findings
- **Playwright MCP vs Chrome DevTools MCP:**
  - Playwright MCP covers Chrome, Firefox, WebKit and Edge and works through the accessibility tree. It is best for repeatable QA that can become tests.
  - Chrome DevTools MCP is Chrome-only and built on CDP and Puppeteer. It exposes full network payloads and performance traces.
  - The common recommendation: debug with DevTools MCP, then encode the regression as a Playwright test.
  - Microsoft reportedly says the Playwright CLI with skills is "more token-efficient" than MCP for coding agents.
  - Sources: [Steve Kinney: Driving vs Debugging](https://stevekinney.com/writing/driving-vs-debugging-the-browser); [Steve Kinney course: runtime tools compared](https://stevekinney.com/courses/self-testing-ai-agents/runtime-tools-compared); [trackingplan 2026](https://www.trackingplan.com/blog/chrome-devtools-mcp-vs-playwright-mcp-digital-analysts); [vibebrowser](https://www.vibebrowser.app/blog/chrome-devtools-mcp-vs-playwright-mcp)
- **Cursor's agent factory:** an unsupervised cloud agent built a feature, ran the UI and returned a *video* of the result. Proof can be a video, screenshot, test run or other evidence that ties the diff to visible behaviour (Arize analysis, Jul 2026, updated Oct 2026) — [Arize: Inside Cursor's agent factory](https://arize.com/blog/inside-cursors-agent-factory-how-it-verifies-ai-written-code/)
- **ProofShot** (open source, Show HN Mar 2026) is an agent-agnostic CLI that records video, captures screenshots and collects console and server errors. `proofshot pr` posts the evidence to the GitHub PR — [GitHub: proofshot](https://github.com/belinwu/proofshot) (fork; original AmElmo/proofshot); [HN](https://hn.svelte.dev/item/47499672)
- **Argos** publishes an agent skill that teaches when a screenshot is better than text and how to embed media in PRs. Argos is also a visual regression service — [Argos blog: Agents, show your work](https://argos-ci.com/blog/agents-show-their-work). Agentpatterns.ai describes agent-recorded video as proof of work *for humans*, distinct from self-checking tests — [agentpatterns.ai](https://agentpatterns.ai/verification/agent-recorded-video-demos/)
- **Meta ACH** (FSE 2025, arXiv 2501.12862) is mutation-guided LLM test generation. It ran over 10,795 Kotlin classes, produced 9,095 mutants and 571 tests, and engineers accepted 73% of the tests. Its LLM equivalent-mutant detector reached precision 0.79 and recall 0.47, rising to 0.95 and 0.96 with preprocessing — [arXiv/alphaxiv 2501.12862](https://www.alphaxiv.org/abs/2501.12862v1)
- On the **SWE-Mutation** benchmark (May 2026), DeepSeek-V3.1's generated test suites caught only 36.15% of mutants. One source warns against using mutation score alone as a gate — [Rubin Lake tech radar](https://rubinlake.com/en/technology-radar/developer-ai-and-delivery/mutation-testing) (secondary)

### Inferences
- **Implication for graph-execution (evidence bundle):** the live tester should record Playwright traces, video (`recordVideo`) and screenshots per test-plan case into `.graph-execution/<run-id>/evidence/<case-id>/`. Show them in the web live view, and have graph-manager's Create PR attach them to the PR body. Each `must` case should cite its evidence file, so "pass" means "pass with proof".
- **Implication (two browser modes):** expose Playwright (CLI or MCP) to the tester for assertions, and Chrome DevTools MCP for diagnosis when a case fails. The tester could pass console errors and network failures to the fixer as structured data.
- **Implication (visual regression):** add an optional `visual` case type in test-plan.json that compares screenshots between the base and integration branches using pixel diff (Playwright `toHaveScreenshot`) or Argos. A human reviewer approves intended changes.
- **Implication (mutation gate for agent tests):** add a reviewer role or validation step, "test adequacy". Run StrykerJS (or PIT, mutmut) restricted to changed files on the integration branch and report surviving mutants to the fixer ("add a test that kills this mutant"). Use it as advisory, not a hard gate, given the warning above.
- **Implication (API testing):** test-plan.json could add `http` cases (request and expected status/JSON schema) that run without a browser. They are cheaper and deterministic for backend PRDs.

### Gaps
- I could not confirm whether Devin or Google Jules attach videos or screenshots to PRs in 2026; searches returned nothing.
- I did not research browser-use or Stagehand v3 specifics, or the 2026 Playwright Test Agents (planner, generator, healer), in this pass.

## 3. Observability for agent runs: OTel GenAI, Langfuse, LangSmith, Braintrust, Phoenix, Claude Code telemetry

### Takeaway
OpenTelemetry GenAI semantic conventions now define agent spans (`invoke_agent`, `execute_tool`, `invoke_workflow`, ...), but they are still at **Development** stability. They moved to a separate `semantic-conventions-genai` repo in mid-2026. Claude Code already exports OTel metrics and events, with cost and tokens per model and per query source, and traces in beta. Phoenix, Braintrust and Langfuse can each ingest that data. An orchestrator can therefore emit a parent `invoke_workflow` trace and stitch agent telemetry under it.

### Cited Findings
- **GenAI semconv agent operations:** `create_agent`, `invoke_agent`, `invoke_workflow`, `plan` and `execute_tool`. The attributes include `gen_ai.agent.id/name/description/version` and `gen_ai.tool.definitions`. Content capture (prompts and completions) is opt-in — [TrueFoundry (Aug 2026)](https://www.truefoundry.com/blog/opentelemetry-genai-semantic-conventions); [DEV: GenAI semconv 2026](https://dev.to/gabrielanhaia/opentelemetry-genai-semantic-conventions-your-llm-traces-should-look-like-this-in-2026-3ff6)
- **Status and changes:** core semconv v1.42.0 moved the GenAI definitions to a dedicated `semantic-conventions-genai` repo (June 2026), and they are still marked Development. Release v1.41 renamed `execute_tool` naming and split `invoke_agent` into CLIENT and INTERNAL span kinds. MCP has its own Development-stage conventions. One outlier claims GenAI semconv was "stabilized in June 2026"; this contradicts the others and is treated as unreliable — [TrueFoundry](https://www.truefoundry.com/blog/opentelemetry-genai-semantic-conventions); [Greptime 2026-05-09](https://www.greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions); contradicted by [businesstechnavigator](https://businesstechnavigator.com/news/opentelemetry-genai-semantic-conventions-agents-2026)
- **Claude Code telemetry setup:** turn it on with `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp` and `OTEL_LOGS_EXPORTER=otlp`.
  - Metrics: `claude_code.cost.usage` (USD), `claude_code.token.usage` (by type input/output/cacheRead/cacheCreation, by model, by `query_source` main/subagent/auxiliary), `session.count`, `commit.count`, `pull_request.count` and `code_edit_tool.decision`.
  - Events: `claude_code.api_request`, `api_error` and `api_refusal`, each with model, cost, tokens, latency and retry attempt.
  - Traces are in beta. Cost figures are estimates.
  - Sources: [Claude Code docs: Monitoring usage](https://code.claude.com/docs/en/monitoring-usage?m=1); [docs.anthropic.com mirror](https://docs.anthropic.com/en/docs/claude-code/monitoring-usage); [Agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability)
- Claude Code metrics flush every 60 s by default — [Last9](https://last9.io/docs/integrations/claude-code/). In Prometheus the names become e.g. `claude_code_cost_usage_USD_total` — [groundcover](https://docs.groundcover.com/integrations/data-sources/ai-tools-observability/claude-code-metrics). Bindplane describes per-session cost and token tracking — [Bindplane](https://bindplane.com/blog/claude-code-opentelemetry-per-session-cost-and-token-tracking)
- **Arize Phoenix** ships a coding-harness-tracing plugin for Claude Code (CLI and Agent SDK). It hooks lifecycle events and streams OpenInference spans per turn, covering model calls, tool runs and token cost, grouped by session — [Phoenix docs: Claude Code](https://arize.com/docs/phoenix/integrations/coding-agents/claude-code)
- **Braintrust** offers a plugin, or native OTel via `OTEL_TRACES_EXPORTER=otlp` and `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` pointed at Braintrust's OTLP endpoint (beta) — [Braintrust KB](https://braintrust.dev/docs/kb/setup-claude-code-with-otel-tracing-1781641599984)
- **Langfuse** documents a Claude Agent SDK integration (OpenInference plus Langfuse span processor) for both JS and Python — [Langfuse: Claude Agent SDK JS](https://langfuse.com/integrations/frameworks/claude-agent-sdk-js)
- One blog claims that Langfuse, LangSmith, Phoenix and Braintrust all ingest OTel GenAI semconv, and that OpenInference (maintained by Arize) layers on top of OTel. This is a single source — [DEV comparison](https://dev.to/gabrielanhaia/langfuse-vs-langsmith-vs-phoenix-vs-braintrust-the-honest-2026-comparison-253p); [MorphLLM observability roundup](https://www.morphllm.com/ai-agent-observability-tools)

### Inferences
- **Implication for graph-execution (OTel-native run traces):**
  - Emit one root span per run (`invoke_workflow`, `gen_ai.agent.name=graph-execution`).
  - Emit child spans per phase (task, merge, validation, review, tester, fixer, human-review) and per agent (`invoke_agent` with role and task id attributes).
  - Inject `TRACEPARENT` and `OTEL_RESOURCE_ATTRIBUTES` (run id, task id, role) into each spawned Claude Code, Codex or OpenCode process, so their own telemetry joins the run trace.
  - Ship with OTLP off by default and a `--otel-endpoint` flag. Any of Phoenix, Langfuse, Braintrust, Grafana or Honeycomb then works without vendor code.
- **Implication (pin semconv version):** GenAI semconv is still Development and has had breaking renames (v1.41). Record `schema_url` and isolate attribute names in one module.
- **Implication (local first):** for users without a collector, write the same span data as JSONL in `.graph-execution/<run-id>/trace.jsonl` and render a waterfall or Gantt in the web live view. graph-manager can bundle a Phoenix or Jaeger container as an option.

### Gaps
- Whether Codex CLI, OpenCode and Qwen CLI emit OTel natively in late 2026 was not researched here. Their JSON event streams would otherwise have to be parsed.
- I did not verify Claude Code's beta traces span schema, or whether it honours an injected parent `TRACEPARENT`. This needs a hands-on test.
- I found no 2026 data on ccusage itself, a local tool that parses Claude Code JSONL logs for usage.

## 4. Cost control: budgets, per-role model routing, caching, early stopping

### Takeaway
The building blocks exist in the Claude Agent SDK and CLI: `maxBudgetUsd` (a soft cap checked between turns, covering subagents) and `maxTurns`, plus `total_cost_usd` on every result (a client-side estimate). Practitioners route models **at the agent or subagent boundary, not within a session**, because switching models mid-session wastes the prompt cache. Caching is the single largest cost lever for multi-agent systems that share long context.

### Cited Findings
- **Agent SDK caps:** `max_budget_usd`/`maxBudgetUsd` stops a `query()` with subtype `error_max_budget_usd`, and `max_turns` stops it with `error_max_turns`. The budget is checked between turns, so spend can slightly overshoot. The cap is cumulative across subagents. `total_cost_usd` is per `query()` and is a client-side estimate from a bundled price table, not billing data. Applications must sum it across calls, and error results still carry cost — [Claude Code docs: Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking); [Agent SDK agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md); [SDK example max_budget_usd.py](https://git.joshthomas.dev/mirrors/claude-code-sdk-python/src/branch/main/examples/max_budget_usd.py)
- **Routing and caching:** switching models mid-trajectory invalidates the prompt cache, so routing is "a session-level concern, not query-level". Cache reads cost about 0.1× the base input price. Caching is reported as a 5–10× cost reduction for multi-agent systems that share long context — [JFrog: Why model routing backfires](https://jfrog.com/blog/why-model-routing-backfires); [besthub.dev](https://www.besthub.dev/articles/cut-your-ai-coding-bill-by-80-with-smart-model-routing-and-prompt-caching-eae99057faf7); [CallSphere](https://callsphere.ai/blog/cost-aware-agent-orchestration-routing-cheap-expensive-llms-2026)
- **Planner and worker pattern:** a strong planner dispatches cheap workers, with the model set per agent in frontmatter. One source claims "Opus for everything is 10–40× more expensive than needed". Another warns that cheap models on complex work produce more iterations, which eats into savings — [softspark model-routing skill](https://cdn.jsdelivr.net/npm/@softspark/ai-toolkit@4.20.0/app/skills/model-routing-patterns/SKILL.md); [Not Diamond](https://www.notdiamond.ai/blog/how-to-reduce-claude-code-costs-without-sacrificing-output-quality)
- **Pricing conflicts:** published prices for Haiku 4.5 disagree ($1/$5 vs $0.80/$4). One article mentions a "Haiku 5.5" released 2026-10-07 that I could not verify — [Towards AI](https://pub.towardsai.net/a-deep-dive-into-anthropics-claude-haiku-5-5-7c91a19e166a). Check current pricing from the provider.

### Inferences
- **Implication for graph-execution (per-role model config):** add a `models` map to config, e.g. `{task: sonnet, fixer: sonnet, reviewer: opus, tester: sonnet, summarizer: haiku}`, plus per-task override fields in task JSON. Routing at the role boundary fits how graph-execution already spawns a separate process per role, so cache invalidation does not apply.
- **Implication (budgets):** add a run budget (`--budget-usd`) and a per-task budget. Pass `--max-budget-usd` and `--max-turns` (or SDK equivalents) to the agent CLIs where they are supported, and keep a run ledger of cost per task, role and attempt from result JSON or OTel events. When a task hits its cap, mark it `budget_exceeded` and surface it in the web view with a "retry with +$X" action. When the run hits its cap, stop dispatching new tasks and go to human review.
- **Implication (early stopping):** stop the fixer loop when there is no progress, i.e. the same reviewer findings or failing test IDs across two iterations. Do not wait for the max-iterations limit. Skip the AI reviewers when validation commands fail, because there is no point reviewing code that doesn't build.
- **Implication (cache-friendly prompts):** keep stable prefixes (PRD, repo conventions, reviewer rubric) at the start of each agent prompt and put task-specific content last. Reviewers that share the PRD and diff then get cache hits across parallel reviewers. Report the cache-read ratio per role from `token.usage{type=cacheRead}`.
- **Implication (cost report):** add a `cost.json` and a table in run.log and the web view: tokens, cache hit ratio, $ by task and role, and $ per accepted line or per resolved finding. A `graph-execution cost <run-id>` command could serve as a ccusage-style view.

### Gaps
- I did not verify budget and cost flags for Codex CLI, OpenCode or Qwen CLI. graph-execution's multi-provider support needs this.
- I found no rigorous public study of quality vs cost for per-role routing in multi-agent coding orchestrators.

## 5. Sandboxing and security

### Takeaway
The 2026 consensus is to run agents in a **microVM or similar** with a **default-deny egress proxy** that also injects credentials, so secrets never sit in the sandbox. Treat issue and PR text as untrusted input: the 2026 CVEs in Claude Code GitHub Actions show that prompt injection can lead to secret theft. Supply-chain defence against slopsquatting means checking new dependencies against the registry and an allowlist *before install*. CVE scanners cannot catch a freshly registered malicious package.

### Cited Findings
- **Docker Sandboxes (`sbx`):** each sandbox is a microVM with its own kernel and private Docker Engine, and only the project directory is shared. A proxy enforces allow/deny network policy and injects credentials into outbound requests. UDP and ICMP are blocked. Presets are Open, Balanced (the default) and Locked Down, and checks such as `sbx policy allow network <domain>` are available. Organizations can set policy through the Admin Console or Governance API. GA dates conflict (Jan vs Mar 2026). Docker Cloud Sandboxes were reportedly launched 2026-09-24 (single source) — [Docker docs: Sandboxes get started](https://docs.docker.com/ai/sandboxes/get-started/); [Docker: Why MicroVMs](https://www.docker.com/?p=88631); [Andrew Lock](https://andrewlock.net/running-ai-agents-safely-in-a-microvm-using-docker-sandbox); [forkast: Cloud Sandboxes](https://forkast.news/docker-launched-cloud-sandboxes-containers-werent-designed-for-ai-agent-isolation/); [Codex + Docker Sandboxes (Apr 2026)](https://codex.danielvaughan.com/2026/04/13/docker-sandboxes-codex-cli-microvm-isolation/)
- Rivet reverse-engineered Docker Sandbox's undocumented microVM API for orchestration (2026-02-04) — [Rivet blog](https://rivet.dev/blog/2026-02-04-we-reverse-engineered-docker-sandbox-undocumented-microvm-api/)
- **Anthropic sandbox-runtime (`srt`):** an open-source tool that enforces filesystem and network restrictions at the OS level without a container (bubblewrap on Linux, sandbox-exec on macOS). An egress proxy allows no domains by default and uses `allowedDomains`/`deniedDomains`. It does not terminate TLS. Known issues:
  - A SOCKS5 null-byte bypass affected Claude Code roughly v2.0.24 to 2.1.88/89.
  - CVE-2025-66479: an empty `allowedDomains` was not enforced.
  - Defaults let the agent read `~/.aws` and `~/.ssh` unless `denyRead` is set, and the sandbox inherits env secrets unless they are scrubbed.
  - Sources: [srt README](https://cdn.jsdelivr.net/gh/anthropics/sandbox-runtime/README.md); [Claude Code sandboxing docs](https://docs.claude.com/en/docs/claude-code/sandboxing); [Agent SDK secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment); [Penligent bypass write-up](https://www.penligent.ai/hackinglabs/ar/claude-code-sandbox-bypass/)
- **Lethal trifecta framing** (Simon Willison): untrusted content, plus external communication, plus access to private data. Egress proxies cut the communication leg — [Formal: Sandboxing agentic coding tools is a networking problem](https://www.joinformal.com/blog/using-proxies-claude-code)
- **Hosted sandboxes:** isolation is Firecracker for E2B and gVisor for Modal, while Daytona defaults to hardened containers. Reported cold starts are Daytona under 90 ms (27 ms optimised), E2B about 150 ms and Blaxel about 25 ms (vendor-reported). E2B and Daytona charge $0.0504 per vCPU-hour. Vercel Sandbox bills only active CPU. Modal is the only one with GPU sandboxes — [superagent benchmark 2026](https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026); [Upstash: 15 providers compared](https://upstash.com/blog/ai-agent-sandbox-providers-compared-2026); [ZenML: long-lived coding agents](https://www.zenml.io/blog/choosing-a-sandbox-runtime-for-long-lived-coding-agents); [bug0](https://bug0.com/blog/ai-sandbox-coding-agents)
- **Prompt injection in CI:**
  - April 2026, CVSS 9.4: crafted PR titles prompt-injected Claude Code in GitHub Actions to exfiltrate `ANTHROPIC_API_KEY`.
  - 2026-06-01, CVSS 7.8 (GMO Flatt Security): claude-code-action allowed an unauthenticated attacker to steal OIDC tokens and push code.
  - A permissions bug (`checkWritePermissions`) trusted any GitHub Action.
  - Mitigations: upgrade, least-privilege workflow permissions, and require approval for fork PRs.
  - Sources: [eSecurity Planet](https://www.esecurityplanet.com/threats/claude-code-github-actions-flaw/); [DEV: hardening after CVSS 9.4](https://dev.to/sahil_kat/hardening-claude-code-in-github-actions-after-the-cvss-94-cve-3id5); [Codex CLI pipeline hardening (2026-06-14)](https://codex.danielvaughan.com/2026/06/14/claude-code-github-action-rce-lessons-codex-cli-ci-cd-pipeline-hardening-prompt-injection-defence/)
- **Slopsquatting:**
  - Aikido found the hallucinated npm package `react-codeshift` (a mash-up of jscodeshift and react-codemod) in Jan 2026. It reportedly spread to 237 repos through AI-generated agent instructions.
  - "HalluSquatting" (Jul 2026) chains a hallucinated package with prompt injection to get RCE.
  - A May 2026 study found that 4.62–6.10% of suggested packages were hallucinated across 5 frontier models, with 127 names hallucinated by all five. Other blogs cite about 20%, which is unverified.
  - Defences: check the registry before install, private registries or allowlists, human approval for new deps, and sandboxed installs. CVE scanners don't help because new malicious packages have no CVE.
  - Sources: [Endor Labs](https://www.endorlabs.com/learn/slopsquatting-when-ai-agents-hallucinate-malicious-packages); [CSA research note](https://labs.cloudsecurityalliance.org/research-rb/csa-research-note-slopsquatting-ai-coding-assistant-supply-c/); [Codex CLI defences (2026-06-16)](https://codex.danielvaughan.com/2026/06/16/slopsquatting-hallucinated-packages-codex-cli-supply-chain-defence-pretooluse-hooks-lockfile-discipline/); [dependency steering (2026-07-09)](https://codex.danielvaughan.com/2026/07/09/dependency-steering-attacks-slopsquatting-codex-cli-supply-chain-defence-sandbox-approval-hooks/)

### Inferences
- **Implication for graph-execution (sandbox backends):** define a `SandboxProvider` interface (`worktree-local` (today), `srt`, `docker-sandbox` (`sbx`), `e2b`/`daytona`/`modal`). graph-manager's per-run Docker containers could move to Docker Sandboxes microVMs for kernel isolation. Without Docker, `srt` gives a zero-dependency option for the CLI.
- **Implication (egress allowlist per run):** add a `network` block to task or run config (default: package registries, the model API and the git host). Log denied egress attempts to run.log and surface them as reviewer input, since an agent trying to reach a strange host is a signal.
- **Implication (secrets brokering):** do not pass API keys in env to agents. Use proxy credential injection (Docker Sandboxes, or a graph-manager egress proxy). Scrub env and deny `~/.ssh` and `~/.aws` reads.
- **Implication (untrusted input labelling):** when tasks come from Jira or GitHub issues, wrap issue text as quoted untrusted data in prompts. Agents that read untrusted input should not also hold write-capable credentials. graph-manager's MCP tools should be least-privilege per role; reviewers, for example, need read-only access.
- **Implication (dependency gate):** add a validation step that diffs lockfiles on the integration branch. For each new package, check it exists in the registry, its age and download count (flag packages younger than N days), and run OSV or Socket checks. Fail or escalate to human review. An agent hook (PreToolUse on `npm install`/`pip install`) can block unknown packages at task time.
- **Implication (SAST as gate):** run Semgrep (fast, rule-based, diff-aware) and optionally CodeQL as validation commands. Pass findings to a security reviewer that verifies them rather than re-detecting them, which mirrors Anthropic's security-review action in-process.

### Gaps
- I did not research Firecracker or gVisor directly, devcontainer-based isolation, or Modal sandbox specifics.
- I did not cover Microsoft's or Google's 2026 published prompt-injection defences (e.g. CaMeL-style designs) in this pass.

## 6. CI/CD integration, auto-fix of CI failures, preview environments

### Takeaway
GitHub Agentic Workflows (gh-aw) set the 2026 pattern for running agents in Actions. The agent runs read-only, and writes go through "safe outputs", a separate job with scoped permissions and capped output counts. Auto-fix-CI is a `workflow_run` on failure that opens a PR on a restricted branch, and PRs are never auto-merged. The 2026 CVEs make hardening (no secrets in agent context, fork-PR approval) mandatory for any graph-execution GitHub Action.

### Cited Findings
- **gh-aw:** workflows are Markdown with YAML frontmatter, and `gh aw compile` produces a lock workflow for Actions. Agents run read-only by default. Write operations go through *safe outputs*, separate jobs with their own permissions and max counts (e.g. `create-issue` max: 1). Execution is sandboxed. Status conflicts: technical preview Feb 2026, public preview June 2026, and one Japanese blog claims GA on 2026-10-28 (unconfirmed by GitHub) — [GitHub blog (Feb 2026)](https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/); [gh-aw docs](https://github.github.com/gh-aw/); [issoh.co.jp](https://www.issoh.co.jp/md/tech/19098)
- **CI-fix example:** `workflow_run` on a failed "CI" run creates an issue and a PR restricted to `branch-pattern: "^automated/ci-fix-.*"`. This is a community example, not an official template — [htekdev gh-aw use cases](https://htekdev.github.io/gh-aw-overview/use-cases/)
- Microsoft Research describes a "Safe agentic automation" approach behind it — [Microsoft Research](https://www.microsoft.com/en-us/research/?p=1156384)
- **Ephemeral environments:** Qovery compares platforms for spinning up ephemeral dev environments for coding agents (2026) — [Qovery](https://www.qovery.com/blog/ephemeral-dev-environments-for-coding-agents-platforms-compared). Vercel Sandbox is recommended when you are already on Vercel — [bug0](https://bug0.com/blog/ai-sandbox-coding-agents)

### Inferences
- **Implication for graph-execution (GitHub Action):** publish a `graph-execution-action`. It would be triggered by `workflow_dispatch`, by a label on an issue or PR (e.g. `graph:run`), or by a committed `.agents/tasks/<name>`. It would run the DAG on the runner (or in a Docker sandbox), push the integration branch, and open a PR with the review notes, cost table and evidence. Follow the safe-outputs design: the agent job has `contents: read` and no secrets beyond the model key behind a proxy, and a separate job with write permissions creates the PR. Require approval for fork-triggered runs.
- **Implication (headless output):** CI needs `--non-interactive --json-summary out.json`, with a JUnit XML of the tester's must and should cases, so CI dashboards show results natively. Use exit codes: 0 for applied, 1 for failed, 2 for needs-human.
- **Implication (auto-fix CI):** add a "ci-fix" mode. Given a failed workflow run, fetch logs, generate a single fixer task with the failure as context, run validation, and push to `automated/ci-fix-*`. This reuses the existing fixer loop.
- **Implication (preview envs for the live tester):** let test-plan.json take a `baseUrl` from env (`PREVIEW_URL`). In CI, the tester can then target a Vercel or Netlify preview deployment of the integration branch rather than a locally started app. Wait for the deployment-status event before running.
- **Implication (GitLab):** the same CLI with JSON and JUnit output runs as a GitLab CI job. Only the PR/MR creation adapter differs.

### Gaps
- I did not verify Netlify, Vercel or GitLab specifics (deployment status APIs, GitLab Duo agent CI) in this pass.
- I did not research GitHub Copilot coding agent's or Cursor's 2026 handling of CI failures in detail.

## 7. Evals of the orchestrator itself

### Takeaway
The practical 2026 approach is a **private golden-task suite built from your own merged PRs**. Compile each PR into a task at its base commit, with deterministic checker scripts, run several attempts per task, and keep model and harness fixed while changing one prompt or policy at a time. Harbor (the Terminal-Bench 2.0 harness) is the de facto runner format, and it supports Claude Code and Codex CLI. Harness changes can move scores a lot, but self-improving-harness claims need held-out sets.

### Cited Findings
- **Terminal-Bench 2.0:** 89 hand-verified terminal tasks. Frontier agents solve under 65%, and small models about 15%. Tasks use the **Harbor** format and harness, which supports Claude Code, Codex CLI, OpenHands and Mini-SWE-Agent. Harbor includes an Oracle agent for sanity-checking tasks before spending on real agents — [arXiv 2601.11868](https://arxiv.org/html/2601.11868v1); [Harbor docs: Terminal-Bench example](https://mintlify.com/harbor-framework/harbor/examples/terminal-bench); [DZone: AI agent evaluation with Harbor](https://dzone.com/articles/ai-agent-evaluation-harbor)
- **InstaLILY:** built a private eval from merged PRs compiled into Harbor tasks at each PR's base commit (3 codebases, 46 tasks × 3 attempts = 276 trials). It argues that SWE-bench measures generic patching, which isn't the question a deploying company actually has — [InstaLILY engineering](https://instalily.ai/research/build-the-environment-optimize-the-harness)
- **OpenBench pattern:** checker scripts grade results instead of trusting the harness's self-reported success. Validation confirms that each checker *fails on the untouched workspace and passes on the golden solution* — [GitHub: openbench](https://github.com/minghinmatthewlam/openbench)
- **Harness effects:** the same model scores differently across harnesses — [FutureAGI](https://futureagi.com/blog/coding-agent-harness-benchmark/). A claimed gain from automated harness evolution on Terminal-Bench 2 shrank to about +0.6 pp when re-run with disjoint search and eval sets, and simple parallel sampling beat it (secondary summary) — [levelup.gitconnected](https://levelup.gitconnected.com/harness-engineering-ai-harness-evolution-ahe-harness-r1-and-overfitting-without-a-holdout-46458415623b)

### Inferences
- **Implication for graph-execution (`graph-execution eval`):** add an `evals/` folder of golden cases. Each case holds a repo at a base commit (or a Harbor task), a PRD, a task folder, test-plan.json and a hidden checker, i.e. the original PR's tests plus acceptance scripts the agents never see. Run N attempts per case and record:
  - pass@1 and pass@k on hidden checkers
  - reviewer precision against seeded bugs
  - tester must-case accuracy
  - fixer iterations
  - $ and wall-clock per case
- **Implication (seeded-bug reviewer evals):** to measure reviewers specifically, mutate known-good diffs (inject bugs, as Meta ACH does with mutants). Score detection (recall) and false positives on clean diffs (precision). This is the reviewer analogue of resolution rate and can run with cheap models.
- **Implication (fake-provider tier):** graph-execution already has `--provider fake` (TESTING.md). Keep deterministic orchestration tests there, and run the costly real-model eval nightly or on prompt changes with a fixed model version. Compare the run against the stored baseline with confidence intervals, since 3+ attempts per task are needed for variance.
- **Implication (Harbor compatibility):** export graph-execution as a Harbor "agent" so it can be benchmarked on Terminal-Bench-style tasks next to Claude Code alone. This answers "does the DAG/review/fixer machinery beat a single agent, and at what cost?"

### Gaps
- I found no published eval methodology for *multi-agent DAG orchestrators* specifically, as opposed to single agents.
- I did not verify Harbor's current task schema or licence in this pass.
