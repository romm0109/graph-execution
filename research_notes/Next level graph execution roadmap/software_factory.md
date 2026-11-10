# Software factories for AI-driven development (state as of 2026-11-10)

Research notes for the graph-execution / graph-manager roadmap. Method: web search plus page fetches, 2026-11-10. Three primary sites could not be fetched from this sandbox (DNS blocked by the session's network allowlist): `factory.strongdm.ai`, `www.warp.dev`, `simonwillison.net`. Claims about StrongDM, Warp and Willison's commentary therefore come from search-result summaries and secondary coverage. Re-check them against the primary pages before quoting them in public. Many "best software factory platform" pages are vendor marketing (Warp, Mastra, Taskade, Agentastic), so their rankings are not evidence.

## 1. What a "software factory" means in the AI era, and who uses the term

### Takeaway
The term is old (Bob Bemer, 1968), but since mid-2025 it has meant a closed loop: work comes in (tickets, alerts), fleets of headless agents plan, build and verify it in parallel sandboxes, and humans move upstream to specs, scenarios and gates. It spans a spectrum. At one end is the "light factory" (humans approve at gates); at the other is the "dark factory" (StrongDM: no human writes or reviews code). In 2026 the vendors converged on the word: Factory.ai (Droids), Warp Factories (Aug 2026), OpenAI Symphony (Apr 2026), GitHub Agent HQ (2025–26), Mastra Factory, 8090, Ona ("Enterprise software factory"), Port, GitLab Duo Agent Platform, and McKinsey's "agent factory".

### Cited findings
**Lineage and definitions**
- Bob Bemer used "software factory" in 1968. Geoffrey Huntley named the "Ralph Wiggum" loop pattern in July 2025. Dan Shapiro coined "dark factory" in January 2026. Factory.ai, Gas Town and OpenAI Symphony popularised the term in 2025–26. Terragon shut down in February 2026 and released its code as OSS — [awesome-software-factories (GitHub)](https://github.com/varun1505/awesome-software-factories)
- The phrase "has been rebranded for agentic AI". The modern category is a loop of intake → spec → build → review → approval → ship → measure — [Mastra: best software factory platforms](https://mastra.ai/articles/best-software-factory); [Taskade: software factory tools](https://www.taskade.com/blog/software-factory-tools) (both vendor-written)
- Warp's definition: cloud agents "manage work from triage through verification, while humans weigh in at key decision points" — [Fortune press release, 2026-08-18](https://fortune.com/press-releases/warp-launches-warp-factories-automate-software-development-2026-08-18/); [Warp: what is a software factory](https://www.warp.dev/articles/what-is-a-software-factory) (not fetched)

**Dan Shapiro's levels (2026-01-23)**
- "The Five Levels: from Spicy Autocomplete to the Dark Factory" is a 0–5 ladder modelled on the NHTSA driving-automation levels. L0 is spicy autocomplete (original Copilot) and L1 the coding intern (boilerplate, full human review). L5, the "dark factory", is specs in and software out: humans define the what and the why, and the how is autonomous. The name comes from Fanuc's lights-out factory — [Simon Willison, 2026-01-28](https://simonwillison.net/2026/Jan/28/the-five-levels/); [werd.io summary](https://werd.io/the-five-levels-from-spicy-autocomplete-to-the-software-factory/); [Shapiro's post via conffab](https://conffab.com/?p=10043)
- Critique and reframing: "the five levels are gated by verification, not intelligence". L5 says more about your test and rollback infrastructure than about your model — [understandingdata.com](https://understandingdata.com/posts/five-levels-gated-by-verification/)
- Shapiro is the Glowforge CEO. One secondary source wrongly calls him "Ben Shapiro, StrongDM engineering lead" — noted in the search summaries; treat secondary bios with care.

**StrongDM Software Factory (founded 2025-07-14, manifesto Feb 2026)**
- Founded 2025-07-14 by Jay Taylor, Navan Chauhan and Justin McCarthy (StrongDM CTO and co-founder). It is a three-person team. Charter rules: code **must not be written by humans** and **must not be reviewed by humans**. Humans write specs and curate test **scenarios**. Verification uses a "digital twin universe" of cloned external services (simulated Okta, Jira, etc.). The satisfaction metric is computed by an LLM judge (critics call this circular). Cost benchmark from the CTO: if you aren't spending at least **$1,000 on tokens per human engineer per day**, your factory has room to improve — [StrongDM AI site](https://factory.strongdm.ai/) (primary, not fetched); [Stanford CodeX: "Built by Agents, Tested by Agents, Trusted by Whom?" 2026-02-08](https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/); [The Pragmatic CTO](https://hn.jakechampion.name/reader/https://www.thepragmaticcto.com/p/the-software-factory-when-no-human); [skybrian links](https://skybrian-links.exe.xyz/link/193)
- StrongDM published **Attractor**, a non-interactive agent spec (now listed as unmaintained) — [github.com/strongdm/attractor](https://github.com/strongdm/attractor) via [awesome list](https://github.com/varun1505/awesome-software-factories)
- Critique: the human isn't removed, only moved upstream from code review to scenario design. Studies put the security vulnerability rate of AI code at 1.5–2× that of human code — [Stanford CodeX](https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/); [aktagon summary](https://signals.aktagon.com/articles/2026/03/built-by-agents-tested-by-agents-trusted-by-whom-the-rise-of-ai-driven-software-factories/)
- Mechanical Orchard applies the "software dark factory" to legacy modernisation with no humans in the loop — [Mechanical Orchard](https://www.mechanical-orchard.com/insights/the-software-dark-factory-modernizing-legacy-systems-with-no-humans-in-the-loop)
- Dex Horthy ran a lights-off factory for three months in 2025 and abandoned it — [awesome-software-factories](https://github.com/varun1505/awesome-software-factories)

**Factory.ai (Droids, "agent-native software development")**
- Series C, $150M at a $1.5B valuation, led by Khosla, 2026-04-16 — [factory.ai/news/series-c](https://factory.ai/news/series-c); [pulse2](https://pulse2.com/factory-150-million-series-c-values-autonomous-software-platform-at-1-5-billion/amp/)
- Secondary reports: $200M at a $5B valuation on 2026-09-15, total raised over $400M. **Not confirmed on factory.ai** — [Enterprise DNA](https://enterprisedna.co/resources/news/factory-ai-droids-200m-5b-valuation-enterprise-coding-september-2026); [dailyaiworld](https://dailyaiworld.com/public/blogs/factory-triples-5b-200m-bet-autonomous-droids)
- Pricing: free BYOK, Pro $20/mo, Plus $100, Max $200, Enterprise custom, a mix of subscription and usage — [amplifying.ai](https://amplifying.ai/coding-agents/factory-droid); [Sacra](https://sacra.com/c/factory/). Named customers (vary by source): Nvidia, Morgan Stanley, Adobe, EY, Palo Alto Networks, Adyen, MongoDB, Bayer, Zapier — [beri.net](https://www.beri.net/article/factory-ai-coding-150m-enterprise); [tech-insider](https://tech-insider.org/factory-ai-150-million-series-c-khosla-coding-droids-2026/)

**Warp Factories (2026-08-18, closed beta)**
- "Open, flexible infrastructure for engineering organizations to build and run their own cloud software factories". One control plane to launch, track and steer Claude Code, Codex, Cursor and Warp Agent in the cloud. Warp's CEO says about 30% of Warp's own tasks run through its factories (30–35% in some outlets). One secondary source reports $10k of free usage for beta organisations (unconfirmed) — [Fortune PR](https://fortune.com/press-releases/warp-launches-warp-factories-automate-software-development-2026-08-18/); [It's FOSS](https://itsfoss.com/news/warp-factories-launched/); [eWeek](https://eweek.com/news/warp-ai-software-factory/); [The New Stack](https://thenewstack.io/warp-software-factory-infrastructure/) (notes expert scepticism about adoption speed); Warp blog "[the factory stack](https://www.warp.dev/blog/the-factory-stack)" and [docs](https://docs.warp.dev/factories.md) (not fetched)
- Warp also ships `oz-agent-action` and `oz-for-oss` (a GitHub App control plane) — [awesome list](https://github.com/varun1505/awesome-software-factories)

**OpenAI Symphony (2026-04-27, open source)**
- An open-source spec and reference implementation (Elixir, built on the Codex App Server). It turns a Linear board into the control plane: each open issue gets its own agent workspace, and the orchestrator polls the board and restarts agents that crash or stall. Tracker access goes through a dynamic `linear_graphql` tool call instead of handing agents the token. Some OpenAI teams saw **+500% landed PRs** in the first three weeks — [OpenAI](https://openai.com/index/open-source-codex-orchestration-symphony); [Help Net Security 2026-04-28](https://www.helpnetsecurity.com/2026/04/28/openai-symphony-codex-orchestration-linear/); repo [openai/symphony](https://github.com/openai/symphony). Community forks: oh-my-symphony (eight CLIs) and Contrabass (Go).

**GitHub Agent HQ**
- Announced at Universe 2025. Public preview reported in Feb 2026. "Mission control" is one place to assign, steer and track work across Copilot's agent, Claude, Codex (and per the roadmap Google, Cognition, xAI), on github.com, VS Code, mobile and the CLI. A control plane adds policy, audit logging and administration of agent and MCP access — [IT Brief](https://itbrief.co.uk/story/github-copilot-surges-as-agent-hq-targets-ai-ecosystem); [CFOtech](https://cfotech.news/story/github-copilot-surges-as-agent-hq-targets-ai-ecosystem)
- The coding agent moved to one premium request per session (2025-07-10) — [GitHub changelog](https://github.blog/changelog/2025-07-10-github-copilot-coding-agent-now-uses-one-premium-request-per-session/). It was reportedly renamed "Copilot cloud agent" in April 2026 — [dev.to](https://dev.to/mr_manushukla/copilot-cloud-agent-in-2026-reasoning-levels-comment-triggers-and-the-ai-credit-math-behind-them-3jil). GitHub Agentic Workflows (`gh-aw`, markdown compiled to Actions) and GitHub Next "Agentics" — [github/gh-aw](https://github.com/github/gh-aw); spec-kit — [github/spec-kit](https://github.com/github/spec-kit)

**Cognition / Devin**
- Bought Windsurf in July 2025 (about $82M ARR, 350+ enterprise accounts). Run-rate about $492M in May 2026, Sacra estimate about $1B by Sep 2026 (another source says $900M). Valuation about $25–26B — [Sacra](https://sacra.com/research/cognition); [valueaddvc](https://valueaddvc.com/blog/how-does-cognition-make-money-devin-pricing-windsurf-enterprise-and-the-492m-arr-breakdown); [KuCoin flash](https://www.kucoin.com/news/flash/cognition-ai-valuation-surpasses-26b-after-10b-funding-round)
- One source reports Windsurf rebranded as "Devin Desktop" in June 2026 (unverified) — [dev.to review](https://dev.to/jovan_chan_9500711396d4e6/devin-20-review-2026-the-500-ai-engineer-is-now-20-and-bundled-with-windsurf-2h2e)

**Others**
- 8090 "Software Factory" for regulated enterprises. Reported $135M Series A led by Salesforce, June 2026 (secondary) — [Taskade list](https://www.taskade.com/blog/software-factory-tools). Ona calls itself "the Enterprise software factory". Port: "build, govern and operate the Agentic SDLC". Orq.ai "AI Software Factory: Governed AI Agents for SDLC" — [orq.ai](https://orq.ai/platform/software-factory). Mastra Factory, open source TS, beta Sep 2026 — [mastra-ai/softwarefactory-template](https://github.com/mastra-ai/softwarefactory-template)
- Steve Yegge's **Gas Town** (a "Mayor" dispatches colonies of parallel agents) plus **Beads** (git-backed issue tracker as agent memory) — [gastownhall/gastown](https://github.com/gastownhall/gastown), [beads](https://github.com/gastownhall/beads)
- **McKinsey**: "Beyond the copilot: scaling the agentic product development life cycle" (Q2 2026 survey). About 80% of engineers report only about 3% average AI productivity gain. Only a quarter of companies report meaningful PDLC acceleration, and in 30% productivity *fell* after adopting agentic AI. Agentic SDLC investment is set to grow over 12× from 2025 to 2026. "Agent factory" as a two-shift model (humans day shift for direction and quality, agents night shift), with a claimed 10× speed at half the cost at one large bank (excerpt, unverified) — [McKinsey](https://www.mckinsey.com/capabilities/tech-and-ai/our-insights/beyond-the-copilot-scaling-the-agentic-product-development-life-cycle); [CIO Dive](https://www.ciodive.com/news/enterprises-bet-coding-agents-despite-ROI/830943/); "Rewiring software delivery for the agentic era" (May 2026) — [pulse.bot](https://www.pulse.bot/ai/news/rewiring-software-delivery-for-the-agentic-era-05c96c6f-a75d-4061-bed0-2de08813a18f/)
- **Microsoft "agent factory"**: an assembly line where foundation models, research and production systems produce agents. Azure AI Foundry offers "thousands of models". This is a factory *for agents*, not a factory of code — [Madrona](https://www.madrona.com/agent-factory-microsoft-is-reimagining-development/)

### Inferences
- There are two meanings. (a) **Factory as product**: hosted agent fleets (Factory.ai, Devin, Copilot cloud agent). (b) **Factory as infrastructure you assemble**: Warp Factories, Symphony, Mastra, Agent HQ, and about 70 OSS repos. graph-execution sits in (b), with the strongest overlap with Symphony and the OSS "spec → DAG → worktrees → review gates" projects (Fusion, Atomic, OMK "evidence-gated DAG lanes", spec-kitty, Anneal).
- The OSS field is crowded: the awesome list has about 70 "open-source factories", about 45 ticket-to-PR pipelines and about 130 session managers. The defensible ground is **verification quality** (holdout scenarios, digital twins, live testers, multi-reviewer) and **governance**, not orchestration as such.

### Gaps
- I could not fetch the primary StrongDM, Warp and Willison pages (network allowlist), so I have no detail on StrongDM's techniques beyond the summaries (e.g. how holdout scenarios are stored apart from agents, any CXDB or "gene transfusion" techniques).
- Not researched for lack of budget: Sourcegraph Amp, Tessl (spec-centric), Poolside, Magic, IBM, Google (Jules), BCG reports, AI Engineer World's Fair 2026 talks, Latent Space episodes. The awesome list mentions Tessl under "Backlog and spec layer" but I did not retrieve its detail.

## 2. Architecture of a factory

### Takeaway
Across vendors and OSS the reference architecture is consistent: **intake** (tracker, Slack, alerts, CI) → **spec/plan** (human-owned) → **decomposition** → **fleet execution** (one isolated workspace or sandbox per task, a polling orchestrator, restart on stall) → **verification** (CI, scenario and holdout tests, digital twins, independent judges) → **review/merge gate** (AI reviewers, merge queue, human at key points) → **deploy and measure**, with continuous background loops on top. Verification is the bottleneck and the moat.

### Cited findings
- **Intake as control plane**: Symphony polls Linear; each issue becomes an agent workspace — [OpenAI](https://openai.com/index/open-source-codex-orchestration-symphony). OSS pipelines take GitHub issue labels (Alfred, OpenHands), Slack (Open SWE, centaur on Kubernetes, Open Session), Linear (Cyrus, factory-agent "about $1 and 3 minutes per feature") — [awesome list](https://github.com/varun1505/awesome-software-factories)
- **Spec layer**: spec-kit (spec → plan → tasks → code), OpenSpec, BMAD, cc-sdd (Kiro-style), AWS AI-DLC workflows, Backlog.md, Beads — [awesome list](https://github.com/varun1505/awesome-software-factories)
- **Graph and gated orchestration**: Atomic ("process as a graph of stages and approval gates"), Fusion (kanban, plan-review-execute gates, worktrees), OMK (evidence-gated DAG lanes), Super Simple Software Factory (deterministic workflow graph), ESF (Temporal workflows into microVM sandboxes), Optio (Kubernetes-style control plane), DoorDash Agentic Orchestrator (gated phases from feature to reviewed PR) — [awesome list](https://github.com/varun1505/awesome-software-factories)
- **Verification**: StrongDM's scenarios plus digital-twin clones of SaaS dependencies plus an LLM-judged satisfaction score — [Stanford CodeX](https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/). "Sealed-envelope" testing hides tests from agents (DUBSOpenHub/dark-factory). Pullboard has a separate agent verify the exact commit before merge. Fault-injection drills for factories (software-factory-reliability). Chainloop records signed, policy-checked evidence. UI Verify does visual checks — [awesome list](https://github.com/varun1505/awesome-software-factories)
- **Review/merge**: claude-code-merge-queue (FIFO merge queue for worktrees), Turbo Flow (a cross-model reviewer must approve), Anneal (two reviewers), HiveDispatch ("opens PRs, never merges on its own") — [awesome list](https://github.com/varun1505/awesome-software-factories)
- **Cost and audit controls in loops**: Bernstein (zero-LLM-cost scheduler, signed audit chain), MartinLoop (budget caps, signed run receipts), great_cto (spending caps), Mission Control (spend tracking) — [awesome list](https://github.com/varun1505/awesome-software-factories)
- **Migrations as the canonical background workload**:
  - Amazon: Q Developer Transform upgraded tens of thousands of production apps from Java 8/11 to 17. More than 50% of production Java systems were done in under six months, "4,500 developer-years" saved, about $260M a year (company-reported, Aug 2024) — [AWS DevOps blog](https://aws.amazon.com/blogs/devops/amazon-q-developer-just-reached-a-260-million-dollar-milestone); [Simon Willison 2024-08-24](https://www.simonwillison.net/2024/Aug/24/andy-jassy-amazon-ceo)
  - Airbnb: about 3.5k Enzyme → RTL test files in about 6 weeks against a 1.5-year manual estimate. 97% automated, with a per-file validation, retry and dynamic-context pipeline (Mar 2025) — [Airbnb tech blog](https://airbnb.tech/?p=366); [InfoQ 2025-03](https://www.infoq.com/news/2025/03/airbnb-llm-test-migration/)
  - Also covered critically by [The Pragmatic Engineer "we need to talk about migrations with AI"](https://blog.pragmaticengineer.com/the-pulse-we-need-to-talk-about-migrations-with-ai/)

### Inferences
- The Airbnb pattern (state machine per file, validate, retry with more context, humans finish the long tail) matches graph-execution's node → validate → fixer loop. Migrations fit a factory well because correctness is checkable (tests, compiler).
- The StrongDM idea that has no counterpart in graph-execution is **holdout scenarios the implementing agents cannot see**, plus **simulated dependencies**. graph-execution's live tester reads the PRD, which the implementers also see.

### Gaps
- Google's internal LLM-driven migrations paper (arXiv 2501.06972, "How is Google using AI for internal code migrations?", Jan 2025) was not retrieved this session, so its figures are not cited.
- No primary source found on OpenTelemetry semantic conventions for agents (GenAI semconv) or on factory-specific dashboards (merge rate, cost per PR) from a vendor.

## 3. Platform features (multi-tenant, governance, cost, observability)

### Takeaway
The enterprise layer is where the money is: GitHub's control plane (policy, audit, agent/MCP access admin), usage-based credits, per-seat plus consumption pricing, spend caps, and signed evidence and audit chains. Throughput metrics (landed PRs, % of tasks automated) are the headline KPIs vendors quote.

### Cited findings
- GitHub Agent HQ control plane: policy management, audit logging, administration of AI access including agents and MCP — [IT Brief](https://itbrief.co.uk/story/github-copilot-surges-as-agent-hq-targets-ai-ecosystem)
- Copilot moved to usage-based **AI Credits** on 2026-06-01 (1 credit = $0.01), replacing premium requests on Pro, Business and Enterprise. Business $19/user/mo, Enterprise $39/user/mo — [ITPro](https://www.itpro.com/software/development/github-copilot-pricing-changes-premium-requests); [The New Stack](https://thenewstack.io/github-copilot-usage-billing/); [layer3labs](https://www.layer3labs.io/guides/github-copilot-pricing)
- Devin: free, Pro $20, Max $200, Teams (reported as either $80/mo + $40/seat or $500/mo for 250 ACUs), Enterprise custom. ACU about $2.00–2.25, roughly 15 minutes of agent work. Self-serve overage is now in dollars, enterprise stays ACU-metered — [Sacra chat](https://sacra.com/chat/h/8a6f29d8-4edf-4f8f-a73a-6601154b09ec/); [pensero](https://pensero.ai/blog/devin-pricing); [amplifying.ai](https://amplifying.ai/coding-agents/devin)
- Factory.ai: free BYOK through $200/mo tiers plus enterprise usage — see section 1.
- KPIs quoted publicly: OpenAI +500% landed PRs with Symphony; Warp about 30% of tasks automated; StrongDM $1k of tokens per engineer per day as the target spend — sources in section 1.

### Inferences
- Pricing is converging on **seat plus metered compute/tokens** (AI credits, ACUs). An open-core graph-manager could keep the engine MIT and charge for team, governance and hosted-fleet features (the GitHub control-plane feature set is the checklist).
- OTel tracing of agent runs, chargeback per team and RBAC/SSO are table stakes in vendor marketing, but I found no detailed primary docs this session.

### Gaps
- No primary data on Factory.ai's or Devin's enterprise features (SSO/SCIM, audit export, on-prem). Not found: Codex cloud pricing for teams, Sourcegraph Amp pricing, Poolside/Magic on-prem offerings.

## 4. Infrastructure for agent fleets

### Takeaway
Sandboxes are a commodity at about $0.05 per vCPU-hour (E2B, Daytona). Modal's sandbox tier costs more. **Idle time and session caps** affect the bill more than the headline rate. OSS options include Kubernetes SIG agent-sandbox, Dagger container-use, Anthropic sandbox-runtime and NVIDIA OpenShell.

### Cited findings
- E2B and Daytona are both about $0.0504 per vCPU-hour and $0.0162 per GiB-hour, billed per second. E2B Pro is $150/mo plus usage (100 concurrent sandboxes, 24-hour sessions; Hobby has a 1-hour cap). Daytona gives $200 of free credit and no session cap. Modal sandboxes are $0.142 per physical core-hour (about $0.071/vCPU-h), against $0.047 for standard compute. Vercel and Fly bill active CPU. "On a month with long idle tails, billing shape moves the invoice by 10× or more" — [Northflank: AI sandbox pricing](https://northflank.com/blog/ai-sandbox-pricing); [Fly.io: AI sandbox pricing](https://fly.io/learn/ai-sandbox-pricing/); [Morph: E2B pricing](https://www.morphllm.com/e2b-pricing); [beri.net](https://www.beri.net/article/e2b-vs-modal-vs-daytona-agent-sandbox-pricing-isolation-2026); [superagent benchmark](https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026)
- E2B uses Firecracker microVMs with under 200 ms startup. Kubernetes SIG Agent Sandbox, Dagger Container Use (one container and branch per agent), Anthropic Sandbox Runtime (OS-level, no container), NVIDIA OpenShell (kernel-level policy sandbox). ESF runs Temporal into microVMs — [awesome list](https://github.com/varun1505/awesome-software-factories)
- Order-of-magnitude economics: compute for a 1-hour, 2-vCPU, 4 GiB sandbox is about $0.17 at E2B/Daytona rates (derived from the rates above), small against StrongDM's suggested $1k/day per engineer in tokens. **Tokens, not sandboxes, dominate cost.**

### Inferences
- graph-manager's per-run Docker sandbox on the host socket is the "single node" version. Going to a fleet means a pluggable sandbox backend (local Docker → Kubernetes agent-sandbox → E2B/Daytona/Modal) behind one interface, with a queue and concurrency limits.

### Gaps
- Morph, Runloop and Northflank's own sandbox products, devcontainers-based fleets: no primary data gathered.

## 5. Business model, market, adoption

### Takeaway
Capital is flowing into this space (Cognition about $25B, Factory $1.5B, reportedly $5B), but adoption outcomes are mixed: McKinsey finds small average gains and productivity drops at 30% of companies. The business models are seat + usage (SaaS) or open infrastructure with a hosted control plane (Warp, Symphony as OSS reference).

### Cited findings
- See sections 1 and 3 for funding and pricing. McKinsey (Q2 2026): about 3% average productivity acceleration, a quarter of companies see meaningful acceleration, 30% saw productivity fall, investment grows over 12× from 2025 to 2026 — [CIO Dive](https://www.ciodive.com/news/enterprises-bet-coding-agents-despite-ROI/830943/)
- Shutdowns and churn in OSS tools: Terragon shut down in Feb 2026, Bloop shut down (Vibe Kanban is now community-maintained), and many factory repos are marked unmaintained, including StrongDM Attractor — [awesome list](https://github.com/varun1505/awesome-software-factories)

### Inferences
- An open-core route for graph-execution is credible: MIT engine (like Symphony and Attractor), paid or self-hosted team edition of graph-manager (SSO, RBAC, audit, budgets, fleet backends). The churn in the OSS list suggests that a single-maintainer orchestrator alone does not survive. Differentiation and distribution matter.

### Gaps
- No reliable enterprise adoption survey with agent-seat counts found. No case study data from Google (paper not fetched) or other large migrations in 2026.

## 6. Risks and critiques

### Takeaway
The main risks are moving the bottleneck to review (PR volume and size up, review time up), lower security quality, circular AI-judges-AI verification, and the "J-curve" where most teams get slower first.

### Cited findings
- Faros AI telemetry (10k+ developers, 1,255 teams), as reported second-hand: on high-AI teams PR merge volume +98%, PR size +154%, review time +91% — [softwareseni](https://www.softwareseni.com/why-code-review-became-the-bottleneck-and-what-the-numbers-show); [DevOps.com](https://devops.com/coding-agents-moved-the-bottleneck-from-writing-to-reviewing-prs)
- Assembled (first-party engineering post): median time to first review went from 3.5 h (Dec 2025) to over 16 h (May 2026) as PR count rose — [Assembled](https://www.assembled.com/blog/code-review-bottlenecks-how-we-hill-climbed-our-way-to-higher-pr-throughput)
- "Vibe merging" (skimming large plausible diffs) and claims of +441% review duration, +31% zero-review merges and +23.5% incidents per PR all come from vendor blogs. **Unverified** — [Codacy](https://blog.codacy.com/ai-breaking-code-review-how-engineering-teams-survive-pr-bottleneck); [CodeRabbit](https://www.coderabbit.ai/guides/ai-pair-programming)
- Addy Osmani on agentic code review — [addyosmani.com](https://addyosmani.com/blog/agentic-code-review/)
- Security: AI code is said to carry 1.5–2× more vulnerabilities. Removing human review from security software (StrongDM sells access control) is questioned. An AI judge creates circularity — [Stanford CodeX](https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/)
- The "J-curve": most developers get slower while AI writes 90% of code — [aktagon "Dark Factory"](https://signals.aktagon.com/articles/2026/03/the-dark-factory-why-most-developers-are-getting-slower-while-ai-writes-90-of-code/); [infralovers](https://www.infralovers.com/blog/2026-02-20-fuenf-stufen-ki-entwicklung/)
- McKinsey's 30% of companies with lower productivity — [CIO Dive](https://www.ciodive.com/news/enterprises-bet-coding-agents-despite-ROI/830943/)

### Inferences
- A factory needs to **reduce human review load per change** (smaller, well-scoped diffs; evidence bundles; risk-based routing), not only generate more PRs. graph-execution's integrated single result per PRD, with reviewer and tester notes, is a good fit, but the evidence needs to reach the PR.

### Gaps
- The DORA 2025/2026 AI report was not retrieved. METR studies not retrieved. The EASE 2026 paper on human review of AI PRs (arXiv 2605.02273) is cited by others but was not read.

## Gap analysis: what graph-execution/graph-manager would need

Existing pieces are from the repo READMEs and `docs/wiki/features/*` (graph-manager.md, sandboxes.md, human-review-round.md, agent-tools.md, ui-reviewers.md) as of 2026-11-10.

| Factory component | Reference in market | graph-execution / graph-manager today | Missing / to build |
|---|---|---|---|
| **Intake** (tracker, Slack, alerts, CI failures) | Symphony (Linear polling), Agent HQ (issues), Open SWE (Slack/Linear), Cyrus | Manual: an agent skill reads Jira/tickets in a terminal (`to-spec`, `to-tasks`). No webhook or polling | Intake service: Jira/GitHub/GitLab/Linear webhooks plus label triggers ("factory-ready"), Sentry and CI-failure intake, a triage agent that sorts tickets into "safe to automate / needs human decision / reject" |
| **Spec / plan** | spec-kit, Tessl, StrongDM (human specs + scenarios) | `to-spec` writes the PRD with a Mermaid diagram and gets user approval. Spec view in graph-manager | Spec approval in the web UI (not just a terminal), versioned specs linked to tickets, a **holdout scenario** file kept from implementers |
| **Decomposition** | Symphony (1 issue = 1 workspace), Atomic/OMK graphs | `to-tasks` makes a DAG with dependencies, plus `validate-tasks.mjs`. Suites integrate several PRDs | Automatic re-planning when nodes fail repeatedly. Task sizing heuristics from history |
| **Execution fleet** | Warp Factories, Devin, E2B/Daytona/Modal, K8s agent-sandbox | Parallel git worktrees on one host. Multi-provider (Claude Code, Codex, OpenCode, Qwen). Per-run Docker sandbox through the host socket with CPU/mem/PID limits | Queue and scheduler across runs (today `list` expects one run at a time), global concurrency and budget limits, pluggable sandbox backends (K8s, E2B, Daytona), remote workers, warm pools, restart on stalled agent |
| **Verification** | StrongDM scenarios + digital twins + holdout; Pullboard exact-commit verify; sealed-envelope tests | Validation commands per task, `test-plan.json`, live tester against the PRD, parallel AI reviewers (code and UI), fixer loop with `fixPasses` | **Holdout scenarios** hidden from implementer agents. Digital-twin and mock services (docker-compose fixtures) for external APIs. Cross-model reviewer option. Flaky-test detection. Security scanner gate (SAST, secrets) |
| **Review / approval** | Agent HQ mission control, merge queues, HiveDispatch (never auto-merge) | Human review round in the web view with comments, fix passes and Approve. Create PR from graph-manager | Policy-based gates (risk-based: auto-approve low-risk such as dependency bumps, require a human for auth or payments paths). Multiple reviewers or approvers per team. An evidence bundle (reviewer and tester notes, test results, cost) posted in the PR body or checks |
| **Deploy & monitor / feedback** | shipmill (deploy and rollback), Warp "triage → verification" loop | Stops at applied changes + PR | CI result watching and auto-fix on red CI (the PR watch loop), post-merge monitoring hooks (Sentry regressions → new ticket), linking outcomes back to tickets |
| **Continuous / background agents** | Amazon Q Transform, Airbnb migration pipeline, GitHub Agentic Workflows, Ralph loops | None (runs are on demand) | Scheduled "maintenance factories": dependency upgrades, framework migrations (per-file fan-out like Airbnb's), flaky-test fixing, lint/tech-debt sweeps. Cron in graph-manager |
| **Multi-tenant / teams** | Agent HQ, Factory.ai, Devin Teams | Single user, `GM_PASSWORD`, PATs | Users, orgs, teams. OAuth/GitHub App/GitLab app instead of PATs. SSO (OIDC/SAML), SCIM |
| **RBAC & policy / guardrails** | GitHub control plane (policy, agent and MCP access admin) | Per-run sandbox isolation (no `/data`, no `GM_` vars); provider `--allowedTools` for MCP | Roles (viewer, operator, admin), per-repo policies (which providers and models, network egress allowlist, allowed MCP tools, protected paths) |
| **Secrets management** | Symphony keeps the tracker token out of agents; proxy-injected creds | Forge tokens in `/data`, not in sandboxes; provider login copied into the container | Vault or KMS integration, scoped short-lived tokens per run, egress proxy with credential injection, secret-scan gate on diffs |
| **Audit logs** | GitHub audit log, Bernstein signed audit chain, Chainloop | `run.log`, `state.json` per run | Append-only audit of who started, approved and merged what, which agent and model, which tools. Exportable (SIEM). Optional signed provenance (in-toto/SLSA) for each applied run |
| **Cost budgets / chargeback** | Copilot AI credits, Devin ACUs, MartinLoop budget caps | No cost tracking in the README (only `fixPasses` as a loop budget) | Token and cost capture per node/run/provider, per-run and per-team budget caps with abort, chargeback reports |
| **Observability** | OTel GenAI semconv (not researched here), Mission Control spend tracking | Live web view per run, graph-manager dashboard | OpenTelemetry traces and metrics export (span per node, agent call, validation), factory KPIs: throughput, merge rate, time-to-merge, first-pass success, fix passes per node, cost per merged PR, human review minutes |
| **Model gateway** | Azure AI Foundry, Copilot multi-model | Provider CLIs chosen per run | Gateway or router (LiteLLM-style) for model choice per role (cheap model for triage, strong one for implementation, different family for review), rate limiting, fallback |
| **Self-hosted / on-prem** | Enterprise tiers of Factory/Devin, Ona, 8090 | One Docker image, runs on laptop, VM or OpenShift; Qwen/OpenCode allow local models | Helm chart, HA (external DB instead of the `/data` volume), air-gapped image with bundled CLIs, horizontal workers |
| **Business model** | Seat + usage; OSS reference + hosted control plane | MIT CLI on npm + companion app | Open core: keep the engine MIT and sell team/governance/fleet (or a hosted service). Position on **verification and evidence** rather than orchestration (crowded: about 70 OSS factories) |

**Where graph-execution is already ahead of most OSS factories:** integrated DAG + suites, parallel reviewers + live tester against the PRD, a fixer loop, a structured human-review round, multi-provider, and per-run sandboxes. On Shapiro's ladder it is an L3–L4 "light factory". The shortest path to a credible "factory" is: (1) ticket and webhook intake plus scheduler and queue, (2) holdout scenarios and digital-twin fixtures, (3) cost and OTel telemetry with a KPI dashboard, (4) teams, RBAC, audit, then (5) pluggable remote sandbox backends.
