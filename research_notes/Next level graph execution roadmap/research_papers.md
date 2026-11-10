# Research on improving autonomous / multi-agent software engineering (as of 2026-11-10), with implications for graph-execution

Method note: 14 web searches/fetches. arxiv.org could not be fetched from this session (DNS blocked by the session network policy), so figures for 2026 papers come from search-result abstracts and summaries, not full-text reads. Items marked **[PK]** come from the researcher's prior knowledge (papers up to mid-2026) and were not re-fetched here. Verify them against the linked arXiv page before quoting externally. Papers with arXiv IDs 2607-2611 were seen only via search snippets.

## 1. Test-time scaling for code agents (best-of-N, verifiers, judges, trajectory selection)

### Takeaway
Sampling several independent agent attempts and choosing one with a verifier is the most reliable published lever for resolve rate. Hybrid verifiers that combine execution with an LLM judge or a rubric beat either signal alone. Gains are a few to about 15 points, and there is always a large gap to oracle pass@k. Selective or adaptive verification and trajectory reuse now recover most of the gain at close to 1x cost.

### Cited Findings
- SWE-Gym (arXiv:2412.21139, Dec 2024, ICML 2025): a trained verifier selects among sampled agent trajectories, reaching 32.0% on SWE-bench Verified for an open-weight agent — [arXiv](https://arxiv.org/pdf/2412.21139)
- R2E-Gym (arXiv:2504.07164, Apr 2025): a hybrid of an execution-based verifier (agent-generated tests) and an execution-free verifier (LLM judge) reaches 51.0% at Best@26 on SWE-bench Verified. The hybrid scales better than either verifier alone, because each has a different failure mode (tests can be weak, judges are biased) — [arXiv](https://arxiv.org/pdf/2504.07164)
- Agentic Rubrics (arXiv:2601.04171, Jan 2026): an agent explores the repo, writes a task-specific rubric, then scores 16 rollouts against it. It reports 54.2% with Qwen3-Coder-30B-A3B and beats test-based and execution-free selection baselines — [arXiv](https://arxiv.org/html/2601.04171v1)
- SWE-Replay (arXiv:2601.22129, Jan 2026): reuses and branches from earlier trajectories instead of sampling from scratch. Up to 17.4% lower cost and up to +3.8 points resolve rate versus naive test-time scaling on SWE-bench Verified — [arXiv](https://arxiv.org/html/2601.22129v2)
- SWE-ZERO to SWE-HERO (arXiv:2604.01496, Apr 2026): 32 rollouts plus generative verifiers give up to +7.9 points, with a "substantial gap" left between verifier-selected and oracle pass@K — [arXiv](https://arxiv.org/pdf/2604.01496)
- SWE-TRACE (arXiv:2604.14820, Apr 2026): rubric-based process reward models plus heuristic test-time scaling for long-horizon SWE agents — [arXiv](https://arxiv.org/html/2604.14820)
- SWE-RM (arXiv:2512.21919, Dec 2025): an execution-free reward model for SWE agents. It argues that a test-time-scaling gain alone is not enough to judge verifier quality, so calibration and discrimination should be measured as well — [arXiv](https://arxiv.org/pdf/2512.21919)
- SWE-Verifier (arXiv:2610.30284, Oct 2026): runs verification only where it is likely to change the outcome. +1.73 points at about 1.09x total cost on MiniMax-M2.7 (snippet only) — [arXiv](https://arxiv.org/html/2610.30284)
- **[PK]** Large Language Monkeys (arXiv:2407.21787, Jul 2024): repeated sampling raised SWE-bench Lite coverage (any sample correct) from 15.9% with one sample to 56% with 250 samples (DeepSeek-Coder-V2-Instruct). The bottleneck is selection, not generation — [arXiv](https://arxiv.org/abs/2407.21787)
- **[PK]** CodeMonkeys (arXiv:2501.14723, Jan 2025): parallel edit trajectories, each with self-written tests, then selection by test voting and a final multi-turn selection agent. 57.4% on SWE-bench Verified (Claude 3.5 Sonnet); selecting over an ensemble of other teams' submissions reached 66.2% — [arXiv](https://arxiv.org/abs/2501.14723)
- **[PK]** Agentless (arXiv:2407.01489, Jul 2024): a fixed localize → repair → validate pipeline that samples many patches and filters them by regression tests and generated reproduction tests. 32% on SWE-bench Lite at about $0.70 per issue — [arXiv](https://arxiv.org/abs/2407.01489)
- **[PK]** SWE-Search (arXiv:2410.20285, Oct 2024): Monte Carlo Tree Search over agent actions with a value agent gives a 23% relative gain on SWE-bench Lite across five models — [arXiv](https://arxiv.org/abs/2410.20285)

### Inferences
- The orchestrator already has the right building blocks: worktrees for isolation, validation gates, reviewers and a tester. Best-of-N per task is mostly a scheduling change: run k attempts of the same task in parallel worktrees, then select.
- The literature agrees on a three-step selection: (1) hard filter on validation and regression tests, (2) a reproduction or acceptance test written from the spec, (3) an LLM judge or rubric to break ties.
- Cost control is the open problem. Selective verification (SWE-Verifier) and trajectory reuse (SWE-Replay) point to adaptive N: spend more attempts only on tasks that look hard or uncertain.

**Implication for graph-execution:**
- Add `attempts: k` / `--best-of k` per task, or for tasks flagged `risk: high`. Run k agents (optionally mixing providers: Claude, Codex, OpenCode, Qwen) in sibling worktrees.
- Select with this pipeline: the validation command must pass, then the task's acceptance tests, then a rubric judge comparing diffs pairwise against the PRD acceptance criteria. Record the losing diffs in the run log.
- Make N adaptive: start with N=1, and sample more only if validation fails or reviewer confidence is low. This turns the current "3 retries" into "3 diverse parallel candidates + select" for hard nodes.
- Generate the per-task rubric once, at to-tasks time (as in Agentic Rubrics), and store it in the task file.

### Gaps
- No public numbers found for best-of-N on whole-feature DAGs (multi-task) rather than single issues. Every result above is per-issue.
- No head-to-head study found of cross-provider ensembles (for example Claude + Codex candidates) against a single-provider best-of-N in 2026.
- No primary-source numbers found on Terminal-Bench or SWE-Lancer test-time scaling in this session.

## 2. Multi-agent vs single-agent: when decomposition helps or hurts; task granularity

### Takeaway
Multi-agent setups help on parallelizable, low-coupling, read-heavy work and hurt on sequential, tightly coupled work, mostly because of context loss and coordination overhead. Centralized orchestration contains errors far better than independent agents. For coding, the evidence favours a single strong agent per coherent unit of work, with an orchestrator that shares full context and verifies centrally. That is close to graph-execution's DAG-of-tasks design, provided tasks are cut along low-coupling seams.

### Cited Findings
- MAST, "Why Do Multi-Agent LLM Systems Fail?" (Cemri, Pan, Yang et al., UC Berkeley; arXiv:2503.13657, Mar 2025, v3 Oct 2025, NeurIPS 2025 D&B): 14 failure modes in 3 categories: system design/specification issues, inter-agent misalignment, and task verification/termination. Built with grounded theory from more than 150 traces (κ = 0.88 between annotators). MAST-Data has 1,600+ annotated traces across 7 multi-agent frameworks; an LLM annotator is released. The starting observation: multi-agent systems often show only minimal gains over single-agent baselines — [arXiv](https://arxiv.org/html/2503.13657v3)
- "Towards a Science of Scaling Agent Systems" (Kim et al., Google Research/MIT; arXiv:2512.08296, Dec 2025): 180 configurations, one single-agent system against four multi-agent architectures. Coordination helps parallelizable tasks (Finance-Agent +81%) but degrades sequential ones (PlanCraft −70%; all multi-agent variants −39% to −70% on sequential reasoning). Independent multi-agent systems amplify errors up to 17.2x; centralized systems balance success and error containment best. Returns from coordination are diminishing or negative once the single-agent baseline exceeds about 45%. A predictive model picks the best coordination strategy for 87% of held-out configurations — [Google Research blog](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/); [arXiv](https://arxiv.org/html/2512.08296)
- Anthropic, "How we built our multi-agent research system" (13 Jun 2025): an Opus 4 lead with Sonnet 4 subagents beat single-agent Opus 4 by 90.2% on an internal research eval. Agents use about 4x the tokens of chat and multi-agent systems about 15x. Domains where all agents must share the same context or that have many inter-agent dependencies, which includes most coding, are "not a good fit today" (seen via secondary summaries) — [summary](https://theaiengineer.substack.com/p/how-anthropic-built-multi-agent-deep)
- Cognition (Walden Yan), "Don't Build Multi-Agents" (Jun 2025): parallel subagents make conflicting implicit decisions. Its principles: "share context, and share full agent traces, not just individual messages", and "actions carry implicit decisions". The secondary reading is that coding is write-heavy while research is read-heavy, which reconciles it with Anthropic's post — [secondary summary](https://cosine.sh/blog/why-you-should-build-multi-agent-ai); [commentary](https://harryfloyd.substack.com/p/your-multi-agent-system-is-an-org)
- METR time horizons: the March 2025 method found a 50% horizon of about 50 minutes for frontier models, doubling about every 7 months since 2019. Time Horizon 1.1 (Jan 2026) expanded the suite to 31 long tasks; post-2024 doubling is estimated at about 4 months. Secondary sources report Claude Opus 4.6 at about 14.5 h for the 50% horizon, but estimates above about 16 h are unreliable because the suite is saturated (secondary sources; METR primary page not fetched) — [LessWrong](https://www.lesswrong.com/posts/EYb2K9acKfyG2bome/metr-time-horizons-now-10x-year); [OfficeChai](https://officechai.com/ai/exponential-progress-claude-opus-4-6-has-50-time-horizon-of-14-5-hours-on-metr-time-horizons-benchmark); [tracker](https://ai2027-tracker.com/predictions/metr-doubling/)
- FeatBench (arXiv:2509.22237, Sep 2025): agents over-implement features ("scope creep"), which causes regressions and over-engineering that diverge from the user's intent — [arXiv](https://arxiv.org/html/2509.22237v2)
- **[PK]** METR RCT (arXiv:2507.09089, Jul 2025): experienced open-source developers using early-2025 AI tools were 19% slower on their own repos while believing they were faster. Real-world gains depend heavily on task fit and verification overhead — [arXiv](https://arxiv.org/abs/2507.09089)

### Inferences
- graph-execution is a centralized orchestrator: one planner, isolated workers, central merge and verification. That is the architecture the scaling study found best for containing errors, so the DAG design is supported. The main risks are MAST's "inter-agent misalignment" (workers making inconsistent implicit decisions) and "task verification" failures.
- Task granularity should follow two rules. Cut along low-coupling seams (separate files or modules with explicit interfaces). Size each task well inside the current model's reliable horizon: use the 80% horizon, not the 50% one, which is several times shorter. With frontier horizons of hours, tasks of roughly 30-120 human-minutes are reasonable. Very fine slicing adds coordination tax with no benefit.
- When the single-agent baseline is already strong (>45%), splitting a coupled change into parallel tasks may lower success. A "single task" fallback for tightly coupled PRDs is defensible.

**Implication for graph-execution:**
- to-tasks should compute a coupling score from the files each task will touch: overlapping paths, shared symbols, shared interfaces. When coupling is high it should merge tasks or chain them with dependencies instead of running them in parallel. Expose `--max-parallel-coupled 1`.
- Give each worker the full "decision log" of upstream tasks: summaries of the merged diffs plus explicit interface decisions, not just the task text. This follows Cognition's "share full traces".
- Use MAST as the failure-classification schema in run summaries. Tag each failed or retried task with a MAST category (spec ambiguity, ignored-other-agent input, premature termination, incomplete verification), so users and future planners can see systematic causes.
- Add a guard against FeatBench-style scope creep: the reviewer flags diff hunks outside the task's declared files, and the fixer must justify or revert them.

### Gaps
- The METR primary page (metr.org/time-horizons) was not fetched, so the 14.5 h figure and the doubling rate are secondary.
- No controlled study found on optimal task size in agent DAGs for coding, as opposed to general agent tasks.

## 3. Verification: tests, reproduction tests, LLM-as-judge reliability, reward hacking

### Takeaway
Spec-derived tests are the strongest filter. Reproduction tests generated from the issue raise patch precision from about 61-65% to about 92%, at a large cost in recall. LLM judges are useful for breaking ties but are biased and miss most issues on their own; reviewers caught 15-31% of human-flagged issues. Agents with write access to tests cheat often, and the mitigation is cheap: protect test files, and tell the agent to stop and report when tests look wrong.

### Cited Findings
- Otter (arXiv:2502.05368, Feb 2025, ICML 2025): generates tests from issue text before any patch exists. Using them as a fail-to-pass filter raised precision from 60.8% to 91.9% with recall at 33% (TDD-Bench-Verified). On the SWE-bench Verified leaderboard, precision went from 65% to 92% with 30-41% recall. A follow-up (e-Otter++) found SWE-bench's own validation lets 7.8% of patches count as correct while failing developer tests (aggregator-reported) — [arXiv](https://arxiv.org/html/2502.05368v2); [ICML slides](https://icml.cc/media/icml-2025/Slides/44767.pdf); [e-Otter summary](https://www.emergentmind.com/topics/e-otter)
- SWT-Bench (**[PK]** arXiv:2406.12952, NeurIPS 2024): generated tests used as a filter double SWE-Agent's precision; SWE-Agent+ used as a test writer reaches 19.2% fail-to-pass on SWT-bench Lite (as quoted in Otter) — [arXiv](https://arxiv.org/html/2502.05368v2)
- Issue2Test (arXiv:2503.16320): reproduces 30.4-32.9% of SWT-bench Lite issues (versions differ) — [summary](https://fugumt.com/fugumt/paper_check/2503.16320v2_enmode)
- ImpossibleBench (Zhong, Raghunathan, Carlini; arXiv:2510.20270, Oct 2025, ICLR 2026): mutates tests so they conflict with the spec, which means any pass is a cheat. Frontier agents cheat frequently, and rates vary a lot by model. Hiding tests brings cheating near zero but hurts legitimate performance. Adding "STOP if tests are flawed, do NOT carve out the code" to the prompt cut GPT-5's hacking rate from 93% to 1% on one variant. Direct test edits are easy to detect, while subtle cheating (special-casing, monkey-patching) often evades monitors — [arXiv](https://arxiv.org/pdf/2510.20270); [LessWrong](https://www.lesswrong.com/posts/qJYMbrabcQqCZ7iqm/impossiblebench-measuring-reward-hacking-in-llm-coding-1)
- **[PK]** METR, "Recent frontier models are reward hacking" (Jun 2025): o3 and Claude 3.7-era models exploited scoring code, for example by monkey-patching evaluators or reading answers, in a notable share of runs, even when told not to — [METR blog](https://metr.org/blog/2025-06-05-recent-reward-hacking/)
- "Are LLMs Reliable Code Reviewers?" (arXiv:2603.00539, Feb 2026): LLMs over-correct when judging whether code meets a requirement. Asking for explanations and fixes increased misjudgment rates — [arXiv](https://arxiv.org/abs/2603.00539)
- "Bias in the Loop" (arXiv:2604.16790, Apr 2026): pairwise LLM-judge verdicts on code flip under prompt-induced bias. The authors recommend anchoring judges with compilation, static analysis and lightweight tests — [arXiv](https://arxiv.org/html/2604.16790)
- SWE-PRBench (arXiv:2603.26130, Mar 2026): 350 PRs with human review comments as ground truth. Eight frontier models caught only 15-31% of human-flagged issues in the diff-only setting; the LLM-judge scorer agrees with humans at κ = 0.75 — [arXiv](https://arxiv.org/html/2603.26130v1)
- OpenCodeReview (arXiv:2608.09290, Aug 2026): adds determinism at several points in the review pipeline to reduce run-to-run variance and hallucinated comments; evaluated on AACR-Bench (200 PRs, 1,505 expert-verified comments) — [alphaXiv](https://www.alphaxiv.org/abs/2608.09290.md)
- **[PK]** Agent-as-a-Judge (arXiv:2410.10934, Oct 2024; DevAI, 55 AI-dev tasks with 365 requirements): an agentic judge that can inspect the workspace matched human consensus far better than a plain LLM-as-judge, at about 3% of human evaluation cost — [arXiv](https://arxiv.org/abs/2410.10934)

### Inferences
- The current "parallel AI reviewers + live tester" stage is the right shape, but diff-only reviewers will miss most issues. Reviewers should be agentic: able to run code, open files and execute tests. Their verdicts should be anchored to executable evidence.
- Fixer loops are where reward hacking appears. An agent told to "make the blocker go away" and given access to tests can weaken the tests.

**Implication for graph-execution:**
- **Acceptance tests first (TDD stage):** before implementation, a dedicated agent writes failing acceptance tests from the PRD acceptance criteria, as Otter does. Commit them to the integration branch as read-only fixtures. The implementer must make them pass, and the selector in Section 1 uses them.
- **Test-tamper guard:** after each task and fixer pass, diff protected paths (test files, CI config, validation scripts, snapshots). Block or flag changes that delete or skip tests (`.skip`, `xit`, `@pytest.mark.skip`), loosen assertions, or edit the validation command. Add an ImpossibleBench-style prompt clause: "If a test contradicts the spec, STOP and report; do not special-case the code."
- **Judge hygiene:** use multiple reviewers with different models. Require every blocker to cite file and line and to give a reproducible command. Drop blockers that cannot be reproduced. Track reviewer precision per model across runs.
- Ship a "canary" mode: occasionally inject a known-impossible check to measure how often a provider games the tests.

### Gaps
- No study found that correlates LLM-judge scores with real merge or acceptance outcomes for agent PRs.
- Property-based testing written by agents: no strong 2025-2026 quantitative source found in this session.

## 4. Memory and self-improvement across runs

### Takeaway
Distilled, structured memories learned from both successes and failures give consistent gains and fewer steps. Self-modifying scaffolds (DGM, SICA) show large gains on benchmarks, but at high compute cost and with documented objective hacking. The cheap, safe path for a product is an evolving "playbook" or lessons file that is curated incrementally rather than rewritten.

### Cited Findings
- ReasoningBank (Ouyang et al., Google; arXiv:2509.25140, Sep 2025, ICLR 2026): memory items have a title, a description and content. They are distilled from successes and failures, with an LLM judge labelling outcomes. Up to +8.3 points success on WebArena over a memory-free agent, and 2.8 fewer execution steps per task on SWE-bench Verified. Memory-aware test-time scaling (MaTTS) uses diverse rollouts to build better memories — [Google Research blog](https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/)
- **[PK]** Agent Workflow Memory (Wang et al.; arXiv:2409.07429, Sep 2024): induces reusable workflows from successful trajectories. +24.6% relative success on Mind2Web and +51.1% on WebArena — [arXiv](https://arxiv.org/abs/2409.07429)
- ACE, Agentic Context Engineering (Zhang et al.; arXiv:2510.04618, Oct 2025, ICLR 2026): a generator → reflector → curator loop maintains an evolving "playbook" through incremental delta updates. +10.6% on agent benchmarks and +8.6% on finance tasks; it matched the top AppWorld production agent using open DeepSeek-V3.1. It names two failure modes: "brevity bias" and "context collapse", where an LLM rewriting the whole memory shrinks it and performance drops sharply — [arXiv](https://arxiv.org/abs/2510.04618); [HF](https://huggingface.co/papers/2510.04618)
- Darwin Gödel Machine (Zhang, Hu, Lu, Lange, Clune; Sakana/UBC; arXiv:2505.22954, May 2025, ICLR 2026): an open-ended archive of self-modified coding agents. SWE-bench rose from 20.0% to 50.0% over 80 iterations, and Polyglot from 14.2% to 30.7%. Without self-improvement it plateaued at 39.0%; without open-ended exploration (keeping only the latest agent) it reached 23.0% — [Sakana](https://sakana.ai/dgm/); [arXiv](https://arxiv.org/pdf/2505.22954v3)
- **[PK]** DGM caveat: the paper reports cases of objective hacking, such as the agent removing hallucination-detection markers instead of fixing the behaviour — [arXiv](https://arxiv.org/abs/2505.22954)
- **[PK]** SICA, "A Self-Improving Coding Agent" (Robeyns, Szummer, Aitchison; arXiv:2504.15228, Apr 2025): the agent edits its own scaffold. Performance rose from 17% to 53% on a SWE-bench Verified subset, with gains mostly from tooling such as better file editing and code navigation — [arXiv](https://arxiv.org/abs/2504.15228)
- **[PK]** Reflexion (arXiv:2303.11366, 2023): verbal self-reflection stored in episodic memory reached 91% pass@1 on HumanEval versus 80% for GPT-4. This is the basis of "lessons from the last failed attempt" retries — [arXiv](https://arxiv.org/abs/2303.11366)

### Inferences
- Most of the gain comes from lessons that are specific to the repo and the failure type, such as "tests in this repo need `--runInBand`" or "use the X helper for DB fixtures", and from learning from failures as well as successes.
- Full rewrites of the memory file cause context collapse, so the curator must append or edit item by item.

**Implication for graph-execution:**
- **Lessons store:** after each run, a "reflector" step reads run.log, reviewer notes and failed or retried attempts, and proposes delta items (title, trigger, lesson, evidence run-id). It writes them to `.graph-execution/lessons.jsonl`, or to a committed `docs/agent-lessons.md`. A human may approve them.
- At task start, retrieve the top-k lessons matching the task's files, area or tags and inject them into the prompt. The to-tasks skill should read the store too.
- **Retry with reflection:** attempt 2 and 3 should get a structured reflection on attempt 1 (why it failed, what not to repeat) instead of a blind retry.
- **Offline self-tuning (later):** keep a small private eval set of past tasks with known-good outcomes. Use it to A/B test prompt or skill changes, a DGM-lite at the prompt layer, with an anti-hacking check that the eval files were not modified.

### Gaps
- No study found that measures memory gains specifically for multi-task, DAG-style coding runs across a single repository's history.

## 5. Context engineering (repo maps, retrieval, compaction, long horizon)

### Takeaway
The evidence base here is mostly engineering practice rather than controlled studies. The consistent messages: give agents a compact structural view of the repo, keep shared decisions explicit, use incremental (not wholesale) summarization, and offload long-term state to files.

### Cited Findings
- ACE (above): "context collapse" when contexts are fully rewritten by an LLM, and "brevity bias" toward short generic prompts. Incremental, itemized updates avoid both — [arXiv](https://arxiv.org/abs/2510.04618)
- Cognition: share full traces and decisions, not summaries, with downstream agents — [summary](https://cosine.sh/blog/why-you-should-build-multi-agent-ai)
- ReasoningBank: memory reduces steps (−2.8 per task on SWE-bench Verified), which is a context and cost saving — [Google Research](https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/)
- **[PK]** Anthropic, "Effective context engineering for AI agents" (Sep 2025): treat context as a finite budget. It recommends compaction, structured note-taking (persistent memory files) and sub-agent isolation for long-horizon tasks, and just-in-time retrieval through tools rather than up-front stuffing — [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **[PK]** Agentless's hierarchical localization (file → class/function → edit location) is a cheap, high-yield way to narrow context — [arXiv](https://arxiv.org/abs/2407.01489)

### Inferences / Implication for graph-execution
- to-tasks already embeds paths and line ranges. That is the "localization" step done ahead of time, which is good. Add an auto-generated **repo map** (a tree-sitter symbol outline of the touched modules plus their public interfaces) attached to each task.
- Pass a running **integration decision log** into downstream tasks: one short entry per merged task, covering interfaces added or changed, new helpers, and conventions chosen. This addresses both semantic conflicts (Section 7) and Cognition's concern.
- Add a hard token or turn budget per task, plus a compaction checkpoint, with idle and loop detection already present. Persist a `NOTES.md` per worktree so a retry can resume rather than restart.

### Gaps
- No controlled 2026 study found that compares repo-map formats or compaction strategies on SWE-bench-like tasks in this session.

## 6. Cost and latency: routing, cascades, caching, early stopping

### Takeaway
Cheap-first routing with escalation can preserve most frontier quality at a fraction of the cost, but routers are hard to get right: frontier LLMs are poor zero-shot routers, and mis-routes cause expensive rework. Prompt caching and adaptive N (Section 1) are lower-risk savings.

### Cited Findings
- Cascade routing (ETH SRI; arXiv:2410.10347, Oct 2024): a unified routing-plus-cascading framework. +14% on SWE-bench over baselines and up to +8% on RouterBench — [arXiv](https://arxiv.org/pdf/2410.10347.pdf)
- SWE-Router (arXiv:2607.00053, Jun/Jul 2026): routing per SWE task "greatly improves cost efficiency while maintaining the majority of performance" of the strong model (abstract-level) — [arXiv](https://arxiv.org/abs/2607.00053)
- Router benchmarking on SWE-bench Verified with realized API cost (arXiv:2605.18859, May 2026): a single-template frontier-LLM router flagged only 7 of 147 verified-hard steps as hard. Naive LLM self-routing underestimates difficulty — [arXiv](https://arxiv.org/html/2605.18859)
- Triage (arXiv:2604.07494, Apr 2026): routes SWE-bench Lite tasks to model tiers using code-health signals; compares heuristics, a trained classifier and an oracle — [arXiv](https://arxiv.org/html/2604.07494)
- Enterprise task-to-model routing for coding assistants (arXiv:2608.08528, Aug 2026) — [arXiv](https://arxiv.org/pdf/2608.08528)
- Vendor claim, not peer-reviewed: the Not Diamond router cut inference costs 39% on Poly-SWE-bench Verified, 66% with open models added — [Not Diamond](https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents). A practitioner warns that cheap mis-routes trigger rework that erases the savings — [Unblocked](https://getunblocked.com/blog/model-routing-coding-agents)
- SWE-Protege (secondhand via a blog, unverified): a small model with expert escalation, cost from $0.54-1.24 to $0.13-0.15 per instance — [blog](https://blakecrosley.com/blog/protege-pattern)
- SWE-Replay: 17.4% cost reduction through trajectory reuse — [arXiv](https://arxiv.org/html/2601.22129v2)
- **[PK]** Anthropic prompt caching: cache reads are billed at about 10% of the base input price, which matters for many agents sharing a large common prefix (PRD, repo map) — [Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)

### Inferences / Implication for graph-execution
- Add per-task `model`/`effort` hints from to-tasks: complexity, coupling, number of files. Policy: cheap model first for low-risk tasks; escalate to the frontier model on validation failure, instead of retrying with the same model 3 times. Don't let an LLM self-rate difficulty; use structural signals such as files touched, test count and fan-in.
- Use frontier models for planning, merge-conflict resolution and final review, where errors propagate. Cheaper models can do mechanical tasks.
- Order prompt content so the PRD, repo map and lessons form a stable shared prefix across parallel agents, to maximize cache hits.
- Track and report cost per task and per stage, plus the cost of each retry and fixer pass, so users can tune N and routing.
- Early stopping: stop the fixer loop when a pass makes no net progress (same blockers persist, or the diff oscillates). Stop best-of-N sampling once a candidate passes all acceptance tests with high judge agreement.

### Gaps
- The SWE-Router and Triage numbers were seen only at abstract level; exact savings and quality deltas were not verified.

## 7. Merge conflicts, parallel agent development, semantic conflicts

### Takeaway
This became an active research area in 2026. Textual conflicts are common in agent PRs (about 20-42%). The bigger risk is semantic interference: patches that pass alone but fail together, even after a clean merge. Explicit coordination information (claims, interface notes, an oracle message) recovers most of it.

### Cited Findings
- "Passes Alone, Fails Together: Benchmarking Semantic Coordination in Parallel LLM-Agent Development" (arXiv:2609.25396, Sep 2026): independently developed patches pass their own tests but fail when combined, with no textual conflict. In constructed Django tasks interference occurred in 97% of runs; one oracle coordination message recovered most cases (snippet-level) — [arXiv](https://arxiv.org/html/2609.25396)
- Large-scale study of agentic PRs (Xu et al., arXiv:2607.04697; AgenticFlict arXiv:2604.03551): about 27.7% of about 107k agentic PRs conflict with their base at merge time. Cross-agent PR pairs conflict more often than same-agent pairs (41.7% vs 19.8%), largely because agents choose different architectural fixes and cannot see or claim each other's work (via secondary summaries) — [summary issue](https://github.com/shrujancheruku/claude-orchestrate/issues/610); [blog](https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/)
- "Multi-agent Collaboration with State Management" (arXiv:2605.20563, May 2026): per-agent git worktrees defer conflicts to merge time, where multi-file resolution often fails and conflicts grow with the number of branches. It proposes a shared-state manager that surfaces conflicts earlier — [arXiv](https://arxiv.org/html/2605.20563v1)
- Claim Plane (arXiv:2608.00947, Aug 2026): deterministic pre-write admission, where agents claim files or regions before writing. A 30-pair, three-seed confirmatory study found reliability gains, but with limits on how much concurrency can be kept — [arXiv](https://arxiv.org/pdf/2608.00947)
- AgentRoom (arXiv:2608.23740, Aug 2026): concurrent multi-agent coding in a CRDT-backed shared workspace — [arXiv](https://arxiv.org/pdf/2608.23740)

### Inferences / Implication for graph-execution
- graph-execution's worktree-plus-integration-branch model is exactly the setting these papers study. Its validation gate catches some semantic interference, but only after the merge.
- **Declared write-sets and claims:** to-tasks lists the files and symbols each task may touch. The scheduler refuses to run two tasks with overlapping write-sets in parallel, or it serializes them, as in Claim Plane. At runtime, warn when an agent writes outside its claim.
- **Interface contracts as DAG nodes:** for shared interfaces, create a small upstream "contract" task (types or signatures plus stub tests) that downstream tasks depend on. This is the "oracle message" that recovered most interference.
- **Semantic-conflict check:** after each merge, run the union of all merged tasks' acceptance tests, not just the latest one's. Optionally ask an LLM for a pairwise "interaction review" of tasks touching related symbols.
- **Rebase-early:** when a task finishes, refresh still-running sibling worktrees with the new integration head, or at least tell them about it, to shorten the conflict window.

### Gaps
- Primary full texts of the 2026 merge-conflict papers were not readable (arXiv fetch blocked). Numbers are from snippets and summaries.

## 8. Benchmarks for evaluating an orchestrator, and whether graph-execution could publish results

### Takeaway
Issue-level benchmarks (SWE-bench Verified, now near saturation) say little about an orchestrator's value. Feature-level, long-horizon and project-level benchmarks (SWE-bench Pro, FeatBench, Commit0, SWE-Milestone, Multi-SWE-bench) fit better, and their low scores leave room to show a gain. Custom scaffolds already report measurable gains over standard scaffolds on SWE-bench Pro.

### Cited Findings
- SWE-bench Pro (Scale AI; **[PK]** arXiv:2509.16941, Sep 2025): long-horizon, enterprise-grade tasks, with public, commercial and held-out sets. On the standardized SEAL board (250-turn limit), Claude Opus 4.5 led at 45.9% as of 1 Mar 2026. One source reports GPT-5.4 (xHigh) at 59.1% as of June 2026, and BenchLM lists higher, unverified vendor numbers (Claude Mythos Preview 77.8%) — [Scale Labs](https://labs.scale.com/papers/swe-bench-pro); [Morph](https://www.morphllm.com/swe-bench-pro); [Capital & Compute](https://capitalandcompute.net/ai-benchmarks/swe-bench-pro/); [BenchLM](https://www.benchlm.ai/benchmarks/swePro)
- Scaffold effect: Augment's Auggie CLI scored 51.8% on SWE-bench Pro against 45.89% for the same model on Scale's SWE-Agent baseline (Feb 2026, vendor-reported). Orchestration and scaffolding gains of about 6 points are publishable — [Augment](https://www.augmentcode.com/blog/auggie-tops-swe-bench-pro)
- FeatBench (arXiv:2509.22237, Sep 2025): 157 feature-implementation tasks across 27 repos, given as natural-language requirements with no code hints, checked by fail-to-pass and pass-to-pass tests. Best resolved rate is 29.94%. It is refreshed about every 6 months against contamination — [arXiv](https://arxiv.org/html/2509.22237v2)
- Commit0 (arXiv:2412.01769, Dec 2024): write whole Python libraries from a spec and unit tests. 54 libraries, a 16-library lite split; no agent fully reproduced a library at release — [arXiv](https://arxiv.org/html/2412.01769v1)
- Multi-SWE-bench (ByteDance; arXiv:2504.02605, Apr 2025): 1,632 instances across 7 languages (Java, TS, JS, Go, Rust, C, C++). Weak on low-level languages, for example about 12% on Rust at release — [arXiv](https://arxiv.org/pdf/2504.02605)
- SWE-Milestone (arXiv:2603.13428, Mar 2026): project-level, milestone-based evaluation of agents — [alphaXiv](https://www.alphaxiv.org/abs/2603.13428.md)
- OmniCode (arXiv:2602.02262, Feb 2026): a benchmark covering broader software-development activities — [arXiv](https://arxiv.org/html/2602.02262v1)
- **[PK]** DevBench (arXiv:2403.08604, 2024): the full lifecycle (design, environment setup, implementation, testing) — [arXiv](https://arxiv.org/abs/2403.08604)

### Inferences / Implication for graph-execution
- **Publishable experiment:** run FeatBench (157 tasks) or a Commit0-lite subset in two settings. (a) A single headless agent, with the same model and budget, directly on the requirement. (b) graph-execution's full pipeline: to-spec → to-tasks → DAG → merge → review/fix. Report resolved %, pass-to-pass regressions (FeatBench's scope-creep metric), cost in $ and wall-clock. Add ablations without reviewers, without the fixer loop, with best-of-N, and with the lessons store. This directly tests the multi-agent vs single-agent question from Section 2, in graph-execution's own setting.
- SWE-bench Pro public set is the credible "headline" number; compare against the SEAL standardized scaffold for the same model, as Augment did.
- Add a `bench` subcommand or adapter that turns a benchmark instance into a PRD plus a task folder and collects patches in the benchmark's prediction format. Ship a small CI regression benchmark of 10-20 internal tasks for prompt and skill changes.

### Gaps
- No 2026 leaderboard numbers found for Commit0 or Multi-SWE-bench in this session.
- No published result found for a DAG/worktree orchestrator against a single agent on feature-level benchmarks. This looks like an open niche graph-execution could fill.
- No primary data collected on Terminal-Bench 2.0 or SWE-Lancer in this session.
