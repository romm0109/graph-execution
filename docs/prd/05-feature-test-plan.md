# PRD: Feature test plan (KAN-5)

Jira: [KAN-5](https://graph-execution.atlassian.net/browse/KAN-5) (epic) → [KAN-11](https://graph-execution.atlassian.net/browse/KAN-11) (to-tasks drafts the plan), [KAN-23](https://graph-execution.atlassian.net/browse/KAN-23) (the tester checks every case, and failures get fixed).

## 1. Executive Summary

`TESTING.md` tells the live tester **how** to test the app: how to boot it, which ports and logins to use. Nothing tells it **what** to test for *this* feature, so it guesses from the spec and the changed files. Users often have specific cases they need checked, and today there is no way to make sure they were. PRD 02 listed per-run test plans as "dropped for now". This PRD picks them up.

The `to-tasks` skill also writes a `test-plan.json` next to the task files. It lists test cases, each with an id, title, steps, expected result and priority (`must` / `should`). The user reviews and edits the cases during the skill's quiz step. During the review loop the live tester gets the plan and reports a verdict for every case (`pass` / `fail` / `blocked`) with evidence. graph-execution, not the agent, turns failed and blocked cases into findings, so they go through the existing fixer → re-review loop. A failed `must` case blocks the apply.

**MVP goal:** in a real run with a `test-plan.json`, every case gets a verdict each round. A failed `must` case is fixed by the fixer and passes in the next round, or the run ends without applying. The summary and the web view show `Test plan: 7/8 passed (1 blocked)`. Without a `test-plan.json`, a run behaves exactly as today.

## 2. Mission

Let the user state what "done" means for a feature in concrete, checkable cases, and make the tool, not the agent's judgment, hold the run to them.

**Principles**

1. **The tool sets the severity.** The tester reports facts (verdict + evidence). graph-execution maps them to findings deterministically, so a failed `must` case can never come back as a minor.
2. **Every case, every round.** A fix can break a case that passed. Each round runs the whole plan again.
3. **Fail fast on bad input.** A malformed plan stops the run before any agent starts, the same as a malformed task file.
4. **Optional and backward compatible.** No plan means no change. A hand-written plan works the same as one drafted by the skill.
5. **One job per agent.** Only the live tester gets the plan. The code reviewer's prompt is unchanged.

## 3. Target Users

- **A developer who breaks a PRD into tasks with `to-tasks`** and runs them unattended. They know which flows must work ("an expired token returns 401", "export with 0 rows downloads an empty CSV") and want them checked, not guessed.
- **A developer who writes plans by hand**, for example from a QA checklist, and drops a `test-plan.json` into an existing tasks folder.

Pain today: a run ends "clean", and only then do you find that the one case you cared about was never exercised. Or the tester found it but called it minor.

## 4. MVP Scope

### Core Functionality
- ✅ `<tasksDir>/test-plan.json`: cases with `id`, `title`, `steps`, `expected`, `priority`
- ✅ `to-tasks` always drafts a plan during its quiz step. The user edits it, or says "no plan" and no file is written
- ✅ The live tester's prompt includes the plan. The tester reports `cases: [{id, verdict, evidence}]` and still tests freely beyond the plan
- ✅ The tool maps verdicts to findings: `must` fail → blocker, `should` fail → major, `blocked` (any priority) → major
- ✅ All cases run again in every review round
- ✅ Summary line `Test plan: 7/8 passed (1 blocked)` in the terminal and web summaries
- ✅ A checklist of cases (verdict + evidence, latest round) in the tester node's web panel
- ❌ Giving the plan to the code reviewer
- ❌ A separate test-plan skill, or a `--test-plan <path>` flag
- ❌ Running only the failed cases again
- ❌ Automated (scripted) test cases. Cases stay instructions for an agent

### Technical
- ✅ `test-plan.json` is a reserved file name: `loadTasks` and `validate-tasks.mjs` skip it as a task
- ✅ The plan is checked at startup (zod schema, unique ids, known priorities). Any problem fails the run before agents start
- ✅ `validate-tasks.mjs` checks the plan too
- ✅ The plan is read again at each review round, so edits apply on `--resume`
- ✅ A report that misses a case, or gives a `fail`/`blocked` verdict with empty evidence, is invalid and the attempt is retried
- ❌ A per-case retry budget

### Integration
- ✅ Findings created from cases flow through the existing `openBlocking` → fixer → re-review loop in `src/review/phase.ts`
- ✅ The existing `fixPasses` limit applies. Open blockers left after the last pass already stop the apply
- ✅ The checklist reuses the KAN-7 node side panel

### Deployment
- ✅ Ships in the npm package and the bundled `to-tasks` skill. No new config, flags or dependencies

## 5. User Stories

1. **As a** developer running `to-tasks`, **I want** it to propose test cases from the PRD next to the task breakdown, **so that** I can fix them while I'm already reviewing the plan.
   *Example:* the quiz step shows `P1 (must) Login with an expired token returns 401` and `P2 (should) The error toast disappears after 5 s`. I change P2 to `must` and approve.
2. **As a** developer, **I want to** say "no plan" and get no file, **so that** small refactors don't need cases.
   *Example:* the tasks folder contains only `1.json`…`4.json`, and the run behaves exactly as today.
3. **As a** developer, **I want** the tester to report a verdict for every case, **so that** I know each one was really exercised.
   *Example:* `tester.json` contains `cases: [{"id":"P1","verdict":"pass","evidence":"curl … → 401 {\"error\":\"expired\"}"}, …]`.
4. **As a** developer, **I want** a failed `must` case fixed automatically, or the run to stop without applying, **so that** a broken core flow never lands on my branch.
   *Example:* round 0: P1 fails and becomes blocker `plan-P1`. The fixer patches the middleware. Round 1: P1 passes, the finding is marked `fixed`, and the result is applied.
5. **As a** developer, **I want** a case the tester couldn't run to stay visible without blocking the run, **so that** a flaky environment doesn't fail correct code.
   *Example:* P4 needs an SMTP server that isn't there. It is `blocked` and becomes a major finding. The fixer gets one try, and the summary shows `(1 blocked)`.
6. **As a** developer, **I want** to see the checklist in the summary and the web view, **so that** I can judge the result at a glance.
   *Example:* `Test plan: 7/8 passed (1 blocked)`. Clicking the tester node lists P1–P8 with their verdicts and evidence.
7. **As a** developer, **I want** a typo in the plan to fail the run right away, **so that** I don't find out after a 30-minute run.
   *Example:* two cases with id `P3` → `test-plan.json: duplicate case id "P3"`, exit before any agent starts.
8. **(Technical) As a** maintainer, **I want** the mapping from verdict to finding to be pure code with unit tests, **so that** severity never depends on the model.

## 6. Core Architecture & Patterns

```
to-tasks skill ──writes──► <tasksDir>/test-plan.json
                                  │
run start: loadTestPlan(tasksDir) ┤ invalid → fail before any agent
                                  │
review round N: loadTestPlan again ──► testerPrompt(ctx + plan)
                                          │
                                   tester writes reports/roundN/tester.json
                                   { findings: [T1…], cases: [{id, verdict, evidence}] }
                                          │
                   checkPlanCases(report, plan)  ── missing id / empty evidence → invalid → retry attempt
                                          │
                   planFindings(report.cases, plan, previous)  ──► findings plan-P1…  (merged into report)
                                          │
                     openBlocking() ──► fixer ──► round N+1 (all cases again)
                                          │
                     summary / web panel: planStats(report) → "7/8 passed (1 blocked)"
```

**Verdict → finding mapping (pure function)**

| Verdict | `must` | `should` |
|---|---|---|
| `pass` | no finding (an open `plan-<id>` from the previous round → `fixed`) | same |
| `fail` | **blocker** `plan-<id>` | **major** `plan-<id>` |
| `blocked` | major `plan-<id>` | major `plan-<id>` |

The created finding uses the case title as `description` and the evidence as `failureScenario`, so the existing downgrade rule never applies to it. From round 1 on, its `status` is `not_fixed` if the case still fails, else `fixed`.

**Patterns**

- **The plan lives with the tasks.** The tasks folder is already the run's input. `--resume` and a later suite (KAN-43) find the plan without new flags.
- **Validation by retry, not repair.** The report check reuses the `withRetries` / `retryNote` path in `src/agents/reviewer.ts`. A failure lists the missing case ids or the cases without evidence.
- **Free-form findings unchanged.** The tester's own T-findings, and its check of the previous round's T-findings, work as today. `plan-*` findings are left out of the "previous report" in the prompt, because the tool keeps track of them.

**Files touched**

```
src/graph/testPlan.ts      NEW: zod schema, loadTestPlan, TEST_PLAN_FILE
src/graph/load.ts          skip test-plan.json
src/review/report.ts       cases[] in reportSchema; planFindings, planStats
src/review/context.ts      ReviewerContext.testPlan
src/agents/tester.ts       plan section + cases[] in the prompt and the example
src/agents/reviewer.ts     checkPlanCases in the report check
src/review/phase.ts        load the plan each round; merge plan findings
src/ui/Summary.tsx         "Test plan: x/y passed (z blocked)"
src/web/page.html          checklist in the tester node panel
skills/to-tasks/SKILL.md   draft + quiz the plan; write test-plan.json
skills/to-tasks/validate-tasks.mjs   skip and check test-plan.json
```

## 7. Features

### 7.1 Plan file (KAN-11 + KAN-23)
- Path: `<tasksDir>/test-plan.json`. It is the only accepted location.
- Shape: `{ "cases": [ { id, title, steps: string[], expected, priority: "must"|"should" } ] }`.
- Rules: at least one case; ids are non-empty, unique and match `^[A-Za-z0-9_-]+$`; `steps` is non-empty.
- Checked at run start and by `validate-tasks.mjs`. Any problem → exit with a message naming the file and the case.

### 7.2 to-tasks skill (KAN-11)
- After drafting the slices, the skill drafts cases from the PRD's user stories and acceptance criteria, ids `P1…`.
- The quiz step shows them together with the slice list. The user can edit, add, remove or reprioritize cases, or say "no plan".
- With "no plan", no file is written. Otherwise it is written after the task files and validated by `validate-tasks.mjs`.

### 7.3 Live tester (KAN-23)
- A new `## Test plan` section in `testerPrompt` lists every case with its priority, steps and expected result.
- Instructions: report a verdict for **every** case in `cases`. `fail` and `blocked` need concrete evidence (requests, output, screenshots). Keep testing freely beyond the plan and report other problems as T-findings, as today.
- "Live test not performed" (`NOT_PERFORMED`): every case counts as `blocked`, with no findings, as today.

### 7.4 Report check and mapping (KAN-23)
- `checkPlanCases`: every plan id appears exactly once, no unknown ids, and `fail`/`blocked` have non-empty evidence. Otherwise the report is invalid → the attempt is retried (budget 3) with the problems in the retry note. If the last attempt is still invalid, the missing cases count as `blocked`.
- `planFindings` applies the table in §6 and merges the findings into the report before `openBlocking` reads it.
- Cases removed from the plan between rounds (on resume) are dropped, along with their `plan-*` findings.

### 7.5 Summary and web (KAN-23)
- Terminal and web summaries: `Test plan: 7/8 passed (1 blocked)`, only when a plan exists, based on the latest round.
- Tester node panel: one row per case with id, title, priority badge, verdict badge, and evidence that expands.

## 8. Technology Stack

No new dependencies.

| Area | Tech |
|---|---|
| Runtime | Node ≥ 20, TypeScript 5.9 |
| Schema | `zod` 4 (same style as `reportSchema` in `src/review/report.ts`) |
| Terminal UI | Ink 6 + React 19 (`Summary.tsx`) |
| Web | Static `page.html`, SSE `state` snapshot |
| Skill | `to-tasks` `SKILL.md` + `validate-tasks.mjs` (plain Node, no deps) |
| Tests | Vitest 3, fake provider (`src/providers/fake.ts`), fixture repo |

## 9. Security & Configuration

- **No new configuration.** The plan exists or it doesn't. No config key, no flag.
- **Prompt content:** plan text is copied into the tester's prompt as-is. It is the user's own file in the user's own repo, so it has the same trust level as `TESTING.md`.
- **Secrets:** cases should reference the credentials in `TESTING.md`, not contain them. The skill never writes secrets into the plan.
- **Out of scope:** checking that the evidence is genuine. The tester is trusted as much as it is today.

## 10. API Specification

### `test-plan.json`

```json
{
  "cases": [
    {
      "id": "P1",
      "title": "Login with an expired token returns 401",
      "steps": ["Boot the API as in TESTING.md", "GET /me with the expired token from TESTING.md"],
      "expected": "401 with body {\"error\":\"expired\"}",
      "priority": "must"
    }
  ]
}
```

### Tester report additions (`reports/round<N>/tester.json`)

```json
{
  "round": 0,
  "reviewer": "tester",
  "findings": [],
  "cases": [
    { "id": "P1", "verdict": "fail", "evidence": "GET /me → 200 {\"id\":1}; expected 401" },
    { "id": "P2", "verdict": "pass", "evidence": "toast gone after ~5 s" }
  ]
}
```

After mapping, the stored report also contains:

```json
{ "id": "plan-P1", "severity": "blocker", "description": "Login with an expired token returns 401",
  "failureScenario": "GET /me → 200 {\"id\":1}; expected 401", "status": "open" }
```

### Web state
The tester node's `NodeView` gains `testPlan?: { cases: Array<{ id; title; priority; verdict; evidence }>; passed; total; blocked }`, carried by the existing SSE `state` snapshot.

## 11. Success Criteria

**MVP is done when** a real run (real provider, `--web`) with a 5-case plan reports a verdict for every case each round, a failing `must` case is fixed or blocks the apply, and the summary and the panel show the right counts.

**Functional**
- ✅ No `test-plan.json` → the prompts, reports and summary are the same as today (snapshot test)
- ✅ `test-plan.json` is never loaded as a task
- ✅ A malformed plan (bad JSON, duplicate id, unknown priority, empty steps) fails at startup with a clear message
- ✅ `must` fail → blocker, `should` fail → major, `blocked` → major (unit tests for every cell of the table)
- ✅ A missing case or empty evidence → retried attempt. After the last attempt, missing cases count as blocked
- ✅ Every case runs again each round. A case that regresses produces an open finding again
- ✅ Open `must` failure after `fixPasses` → no apply, non-zero exit
- ✅ An edited plan is picked up on `--resume`
- ✅ `to-tasks` drafts cases, honors "no plan", and its output passes `validate-tasks.mjs`

**Quality**
- ✅ Mapping and checks are pure functions with unit tests
- ✅ A fake-provider e2e test covers fail → fix → pass across two rounds
- ✅ Web e2e test opens the tester panel and sees the checklist

**UX**
- ✅ One summary line, with no output when there's no plan
- ✅ The evidence for a failed case is one click away in the web view

## 12. Implementation Phases

### Phase 1: Plan file + loader, ~0.5 day
- ✅ `src/graph/testPlan.ts` schema and `loadTestPlan`
- ✅ `loadTasks` and `validate-tasks.mjs` skip and check the file
- ✅ Startup failure on an invalid plan

*Validation:* unit tests for valid and invalid plans; a run with a bad plan exits before agents.

### Phase 2: Tester + mapping (KAN-23 core), ~2 days
- ✅ Plan section and `cases[]` in `testerPrompt`
- ✅ `cases` in `reportSchema`; `checkPlanCases` in the reviewer retry path
- ✅ `planFindings` merged before `openBlocking`; `plan-*` left out of the previous-report section
- ✅ Plan read again each round

*Validation:* unit tests for the table and the checks; fake-provider e2e over two rounds.

### Phase 3: Summary + web checklist, ~1 day
- ✅ `planStats` → `Summary.tsx` line
- ✅ `NodeView.testPlan` → checklist in the tester panel

*Validation:* `Summary.test.tsx`, `web-e2e.test.ts`, manual check with agent-browser per `TESTING.md`.

### Phase 4: to-tasks skill (KAN-11), ~0.5 day
- ✅ `SKILL.md`: draft cases, show them in the quiz step, honor "no plan", write and validate
- ✅ README section "Test plans"

*Validation:* run the skill on a sample PRD; the file passes `validate-tasks.mjs`; a real run uses it.

## 13. Future Considerations

- **Suite** ([KAN-43](https://graph-execution.atlassian.net/browse/KAN-43)): the e2e tester runs all features' plans together. Case ids would need a per-feature prefix.
- **Human review** ([KAN-15](https://graph-execution.atlassian.net/browse/KAN-15)): show the checklist next to the final diff. A human could add a case as a review comment.
- **History:** the verdicts of every round in the panel, not only the latest.
- **Scripted cases:** an optional `command` per case, run by the tool deterministically, before any agent.
- **A plan for the code reviewer**, if separating the two jobs turns out to miss things.

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| The tester says `pass` without really testing | Evidence is required for fail/blocked. Pass evidence is shown in the panel for spot checks. The tester's prompt asks for concrete output |
| Large plans make every round slow and expensive | `to-tasks` aims for 5–10 cases. Running every case is a deliberate choice. Revisit with a "must only after round 0" option if runs get slow |
| A blocked case caused by the environment burns fix passes | `blocked` is major, never blocker, so it never stops the apply by itself. The summary flags it |
| Repeated invalid reports (missing cases) use up attempts | The retry note lists exactly which ids are missing. After the last attempt the cases count as blocked, so the run goes on |
| Plan edits on resume make findings inconsistent | Removed cases drop their `plan-*` findings. New cases start at `open` |

## 15. Appendix

**Decisions log (grill session, 2026-10-21)**

| Topic | Decision |
|---|---|
| Format | JSON with case ids, not markdown |
| Who gets the plan | Live tester only |
| Fail → finding | The tool maps it (must → blocker, should → major); the tester only reports verdicts |
| Blocked | Major for any priority, never blocker; "not performed" → all blocked, no findings |
| Re-test | Every case, every round |
| Missing case | Invalid report → retry; after the last attempt → blocked |
| No evidence on fail/blocked | Invalid report → retry (never downgraded) |
| Malformed plan | Fail at startup; `validate-tasks.mjs` checks it too |
| Location | `<tasksDir>/test-plan.json` only; reserved file name |
| to-tasks | Always drafts; "no plan" → no file |
| Resume | Re-read the current file each round |
| Web | Checklist in the tester node panel + summary line |

**Assumptions (not discussed in the grill session)**
- Ids of findings created from cases are `plan-<caseId>`, so they never clash with the tester's own `T1…`.
- `plan-*` findings are left out of the "previous report" the tester verifies; the tool tracks their status from the new verdicts.
- When a plan exists, "live test not performed" still produces no findings. The summary shows every case as blocked.

**Related**
- `PRD.md` §7.5 (live tester), §7.6 (review loop)
- `docs/prd/02-self-improving-review-and-testing-docs.md` (where per-run test plans were dropped)
- `docs/prd/04-live-change-view.md` (node side panel)
- Code: `src/agents/tester.ts`, `src/agents/reviewer.ts`, `src/review/report.ts`, `src/review/phase.ts`, `src/graph/load.ts`, `skills/to-tasks/`
