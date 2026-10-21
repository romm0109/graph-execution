# PRD: Human review round (KAN-15)

Jira: [KAN-15](https://graph-execution.atlassian.net/browse/KAN-15) (epic) → [KAN-24](https://graph-execution.atlassian.net/browse/KAN-24) (review the result and request changes before it lands on my branch), [KAN-19](https://graph-execution.atlassian.net/browse/KAN-19) (show how each comment was handled; resolve or reopen it).

## 1. Executive Summary

Today a run ends in one of two ways: the result is applied to your branch, or it isn't. If you want changes ("rename this", "this endpoint must be paginated"), you make them by hand after the apply, and those edits skip the validation, review and live testing the rest of the result went through. Steering mid-run was dropped because changes made that way skip review. The right place for human input is **after** the result is built and reviewed and **before** it lands, with your comments going through the same loop again.

With `humanReview` on, the run pauses before applying and the web view shows "Waiting for your review". You read the final diff, comment on lines, files or the change as a whole, and choose **Request changes**, **Apply** or **Drop**. Request changes turns your comments into blocker findings. The fixer handles them, then validation, the code reviewer and the live tester run again with a fresh `fixPasses` budget. The run pauses again and shows, for each comment, the fixer's note and the reviewer's verdict (addressed / not addressed). You resolve or reopen comments and go again, as many rounds as you want.

**MVP goal:** in a real `--web` run with `humanReview: true`, you leave three comments, request changes, and the next pause shows each comment as addressed with a fixer note and the updated diff. Then **Apply** lands the result as uncommitted changes, exactly like today. With `humanReview` off, a run behaves exactly as today.

## 2. Mission

Make the human the last reviewer of every run that asks for it, without ever letting a human change skip the checks an agent change gets.

**Principles**

1. **Human changes go through the loop.** You never edit the result yourself before applying. Your comments become findings, and the fixer → validate → review → test loop handles them.
2. **The human has the final say.** No round limit. A run with open blockers still pauses for you; you decide to go again, apply anyway, or drop.
3. **Nothing is lost.** The waiting state, your draft comments and every round's diff survive a restart. Drop keeps the result branch.
4. **Opt in, backward compatible.** Off by default. A normal run, its prompts, reports and exit codes are unchanged.
5. **Reuse, don't fork.** The pause is a step of the existing review phase, the wait reuses the retry hub pattern, and the diff reuses the KAN-7 panel.

## 3. Target Users

- **A developer who runs features unattended** with `--web` and wants to look at the result before it touches their branch, the same way they'd review a teammate's PR.
- **A developer with taste-level feedback** the agents can't infer from the spec: naming, structure, an edge case the PRD forgot.

Pain today: the result lands, you spot three things to change, and you either fix them by hand (unreviewed, untested) or start a new run.

## 4. MVP Scope

### Core Functionality
- ✅ `humanReview` config key (default `false`) and `--human-review` / `--no-human-review` flags; the effective value is saved in the run state
- ✅ When on, the run pauses after the review loop instead of applying, whether the loop ended clean or with open blockers
- ✅ Web view: the final diff (integration branch vs. run base), line comments, file comments and general comments
- ✅ A comment can be marked **needs live check**; it then reaches the live tester as an extra `must` test case
- ✅ **Request changes**: open comments become blocker findings; fixer → validate → review → test runs with a fresh `fixPasses` budget
- ✅ The fixer writes a note per comment; the code reviewer reports each comment as `addressed` / `not_addressed` with evidence
- ✅ The next pause shows each comment's fixer note, reviewer verdict and the round's new diff; you **resolve** or **reopen** it
- ✅ **Apply** lands the result as uncommitted changes (today's apply). With open blockers it's **Apply anyway** and needs a confirm click
- ✅ **Drop** (confirm click) ends the run without applying; the `graph/<run-id>` branch stays
- ✅ No limit on human rounds
- ❌ Reviewing in the terminal view (it only prints that the run is waiting, with the URL)
- ❌ Moving comments onto the new diff (comments stay pinned to the round they were written on)
- ❌ Several reviewers, comment threads or replies
- ❌ Pausing before the automated review loop ends (no mid-run steering)
- ❌ Editing code in the browser

### Technical
- ✅ New review step `human` in `reviewStateSchema`; `--resume` and `graph-execution open` return to the waiting screen
- ✅ Comments are written to `.graph-execution/<run-id>/human/round<H>.json` as you type them (drafts survive a restart)
- ✅ The retry hub becomes a generic wait hub; the run waits for `apply` / `changes` / `drop`
- ✅ `humanReview` on without `--web` still starts the web server; the terminal prints the URL
- ❌ Authentication on the web server (same localhost-only model as today)

### Integration
- ✅ Comment findings flow through the existing `openBlocking` → fixer → re-review path in `src/review/phase.ts`
- ✅ Live-check comments reuse the KAN-5 test-plan mapping (`must` fail → blocker)
- ✅ The diff view reuses the KAN-7 diff rendering and `rangeChanges` / `rangeFileDiff`

### Deployment
- ✅ Ships in the npm package. No new dependencies. README section "Human review"

## 5. User Stories

1. **As a** developer, **I want** the run to stop before applying and show me the final diff, **so that** nothing lands on my branch I haven't seen. *(KAN-24)*
   *Example:* the run ends its loop clean; the web view shows "Waiting for your review" and a file list with `src/api/users.ts +42 −3`.
2. **As a** developer, **I want to** comment on a line, a file or the whole change and request changes, **so that** the agents fix it instead of me. *(KAN-24)*
   *Example:* on `users.ts:18` I write "paginate this, max 50 per page" and tick *needs live check*; a general comment says "rename `fetchAll` to `listUsers` everywhere". **Request changes** → the phase line shows `fix pass 1/3 (human round 1)`.
3. **As a** developer, **I want to** see what was done for each comment, **so that** I don't have to hunt through the new diff. *(KAN-19)*
   *Example:* comment H1-1 shows *Fixer:* "added `limit`/`offset`, capped at 50" · *Reviewer:* addressed — "`users.ts:18-31` applies `Math.min(limit, 50)`" · *Live check:* pass.
4. **As a** developer, **I want to** resolve or reopen each comment, **so that** the next round only works on what's still wrong. *(KAN-19)*
   *Example:* I resolve H1-1, reopen H1-2 with "you missed `admin.ts`", add one new comment, and request changes again.
5. **As a** developer, **I want to** apply anyway or drop when the agents can't get it clean, **so that** I decide, not a hard failure.
   *Example:* after a human round, a blocker is still open with no fix passes left; the run pauses with the finding shown; I click **Apply anyway** → confirm, and finish the last bit by hand.
6. **As a** developer, **I want** a waiting run to survive closing my laptop, **so that** I can review it tomorrow.
   *Example:* Ctrl+C while waiting → `graph-execution --resume` brings back the same pause, with my two draft comments still there.
7. **As a** developer, **I want** human review to be opt-in per project and per run, **so that** quick runs still apply on their own.
   *Example:* `humanReview: true` in the config; `graph-execution … --no-human-review` for a one-off small fix.
8. **(Technical) As a** maintainer, **I want** the comment → finding mapping and the review-state transitions to be pure functions with unit tests, **so that** resume and budgets are predictable.

## 6. Core Architecture & Patterns

```
review loop (validate → review ⇄ fix, fixPasses budget)
        │ ends clean, or with open blockers and no passes left
        ▼
 humanReview off? ──yes──► today: apply (success) / exit 1 (exhausted)
        │ no
        ▼
 phase "human", humanRound H ── save state ── events "human:waiting"
        │
        ▼   web: GET /review → diff of round H, comments, verdicts
  hub.wait() ◄── POST /review/{apply,changes,drop}
        │
   ┌────┼──────────────────────┬─────────────────────────────┐
 apply                       drop                       changes
   │                           │                            │
 applyToCheckout          keep graph/<run-id>      open comments of round H
 (force if blockers open)  exit 0 / 1               → findings human-<id> (blocker)
   │                                                → liveCheck → plan cases H<id> (must)
 finish("success")                                  phase "fix", round N+1,
                                                    budgetBase = N+1  (fresh fixPasses)
                                                            │
                                     fixer (notes per comment) → validate →
                                     code reviewer (verdict per comment) + tester
                                                            │
                                                  back to phase "human", H+1
```

**Review state additions** (`src/state/state.ts`)

```ts
export const reviewStepSchema = z.enum(["validate", "review", "fix", "human", "done"]);
// reviewStateSchema gains:
humanRound: z.number().int().min(0).default(0),  // pauses so far; H in human/round<H>.json
budgetBase: z.number().int().min(0).default(0),  // round where the current fixPasses budget started
```

The exhaustion check in `phase.ts` becomes `round - budgetBase >= config.fixPasses`. Rounds keep counting up across human rounds, so report folders (`reports/round<N>/`) never collide.

**Comment → finding mapping (pure function, `src/review/human.ts`)**

| Comment | Finding / case |
|---|---|
| open (new or reopened) | blocker `human-<id>`, `description` = comment body, `failureScenario` = `file:line` + snippet (or "general comment") so it's never downgraded |
| open + `liveCheck` | also a test-plan case `H<id>`, priority `must`, `expected` = comment body |
| resolved | nothing |

The reviewer's verdict sets the finding status in the next round: `addressed` → `fixed`, `not_addressed` → `not_fixed` (still open, still blocking). The **human** still decides: a resolved comment stays resolved even if the reviewer said not addressed, and a reopened one is open even if addressed.

**Patterns**

- **Pause is a review step.** One state file, one resume path. `reconcile` treats `human` like `done`: nothing to redo, just wait.
- **Write-through comments.** Every comment edit is saved to `human/round<H>.json` before the HTTP response, so the page and the file never disagree.
- **Generic wait hub.** `RetryHub` becomes `WaitHub` with a choice union `{retry} | {merge} | {review: "apply" | "changes" | "drop", force?}`. The run loop in `run.ts` and the review phase share it.

**Files touched**

```
src/config/config.ts        humanReview: boolean (default false)
src/cli.ts                  --human-review / --no-human-review; saved in state
src/state/state.ts          "human" step, humanRound, budgetBase, humanReview
src/state/resume.ts         reconcile the "human" step
src/review/human.ts         NEW: comment schema, load/save, toFindings, toCases, stats
src/review/phase.ts         pause instead of finishing; fresh budget; human findings + cases
src/agents/fixer.ts         comment section; write fixer-comments.json
src/agents/reviewer.ts      comment section; comments[] verdicts in the code report
src/review/report.ts        comments[] in reportSchema
src/runner/retry-hub.ts     → WaitHub with review choices
src/runner/run.ts           apply / apply anyway / drop from the pause
src/launch/launch.ts        start the web server when humanReview is on
src/web/server.ts           /review routes
src/web/page.html           review screen: diff + comments + actions
src/ui/…                    terminal line "waiting for your review: <url>"
```

## 7. Features

### 7.1 Turning it on (KAN-24)
- `humanReview` in `graph-execution.config.json` sets the default. `--human-review` / `--no-human-review` override it for one run.
- The effective value is saved in `state.json`; `--resume` uses the saved value and rejects the flags (same rule as `--spec`).
- On but no `--web`: the web server starts in-process next to the terminal UI, and the terminal prints `waiting for your review: http://127.0.0.1:<port>` when the pause comes.

### 7.2 The pause (KAN-24)
- Reached when the automated loop ends — clean, or with open blocker/major findings and the budget spent.
- State: `phase: "human"`, `humanRound: H`. The web view shows a banner: "Waiting for your review — round H", plus a warning listing open findings if any.
- Ctrl+C or closing the page leaves the run waiting; exit code 2 like an abort, with the resume hint. Nothing is applied.

### 7.3 Diff and comments (KAN-24)
- Diff: `run base … integration HEAD`, file list + per-file diff, rendered with the KAN-7 diff code.
- A **line comment** is anchored to `file`, `line` (new side) and a 3-line `snippet`. A **file comment** has `file` only. A **general comment** has neither.
- Each comment has `body` (required) and `liveCheck` (checkbox, default off).
- Ids: `H<round>-<n>`, e.g. `H1-2`.
- Comments from earlier rounds are listed in a "Previous comments" section with their snippet, pinned to the round they were written on (not moved onto the new diff).

### 7.4 Request changes (KAN-24)
- Enabled when at least one comment is open (new this round or reopened).
- Saves the round, maps open comments (§6), and starts fix pass `N+1` with `budgetBase = N+1`. The phase line reads `fix pass 1/3 (human round H)`.
- The fixer prompt gets a `## Human review comments` section before the other findings: id, location, snippet, body. Human comments come first; they're the reason for this pass.
- Validation, then the code reviewer and the tester run as usual. Live-check comments are added to the tester's plan as `must` cases for this and every later round until resolved.

### 7.5 How each comment was handled (KAN-19)
- **Fixer:** writes `reports/round<N>/fixer-comments.json`: `[{ "id": "H1-1", "note": "…" }]`. Missing notes are allowed (shown as "no note").
- **Code reviewer:** gets the open comments and reports `comments: [{ id, verdict: "addressed" | "not_addressed", evidence }]` in `code.json`. Every open comment id must appear once with non-empty evidence, or the report is invalid and the attempt is retried (same path as KAN-5's `checkPlanCases`).
- **Next pause:** each comment shows fixer note, reviewer verdict + evidence, live-check result (if any) and **Resolve** / **Reopen** buttons. Reopen asks for an optional follow-up text that's appended to the body.

### 7.6 Apply and Drop
- **Apply** (no open blocker/major): `applyToCheckout` as today → uncommitted changes on the starting branch → `finish("success")`, exit 0. With `--no-merge` the button reads **Finish** and leaves the result on `graph/<run-id>`.
- **Apply anyway** (open blockers): confirm dialog listing them; same apply; exit 0; the summary says "applied with N open finding(s)".
- **Drop**: confirm dialog; nothing applied; worktrees removed, `graph/<run-id>` kept; exit 0 if the last loop was clean, else 1. Summary: "dropped — result kept on graph/<run-id>".

## 8. Technology Stack

No new dependencies.

| Area | Tech |
|---|---|
| Runtime | Node ≥ 20, TypeScript 5.9 |
| Schema | `zod` 4 (comments, report additions, state) |
| Web | `node:http` server in `src/web/server.ts`, static `page.html`, SSE `state` snapshot |
| Diff | `rangeChanges` / `rangeFileDiff` in `src/git/git.ts`, KAN-7 diff rendering |
| Terminal UI | Ink 6 + React 19 |
| Tests | Vitest 3, fake provider, `web-e2e.test.ts`, agent-browser for the manual check |

## 9. Security & Configuration

- **Config:** `humanReview: boolean` (default `false`) in `graph-execution.config.json`; strict schema, so typos are rejected.
- **Flags:** `--human-review`, `--no-human-review`; rejected with `--resume`.
- **Web server:** same model as today — binds to localhost, POSTs checked against the `Origin` allow-list. New routes inherit it. No auth.
- **Prompt content:** comment text is copied into the fixer, reviewer and tester prompts as-is. It's the user's own input, same trust as the spec.
- **Out of scope:** multi-user access, review over a network.

## 10. API Specification

All routes are on the existing run web server. Errors use `{ "error": "…" }` with 409 when the run isn't waiting for review.

| Method & path | Body | Effect |
|---|---|---|
| `GET /review` | — | Current round, diff file list, comments (this + earlier rounds), verdicts, open findings |
| `GET /review/diff?file=<path>&round=<H>` | — | Diff text of one file for round H |
| `POST /review/comments` | `{ file?, line?, snippet?, body, liveCheck }` | Adds a comment; returns it with its id |
| `PUT /review/comments/<id>` | `{ body?, liveCheck? }` | Edits a comment of the current round |
| `DELETE /review/comments/<id>` | — | Deletes a comment of the current round |
| `POST /review/comments/<id>/resolve` | — | Resolves an earlier comment |
| `POST /review/comments/<id>/reopen` | `{ followUp? }` | Reopens an earlier comment |
| `POST /review/changes` | — | Request changes (409 if no open comment) |
| `POST /review/apply` | `{ force?: boolean }` | Apply; `force` required when blockers are open |
| `POST /review/drop` | — | Drop |

### `human/round<H>.json`

```json
{
  "round": 1,
  "diffBase": "3f2a1c0",
  "diffHead": "9be41d7",
  "comments": [
    {
      "id": "H1-1",
      "file": "src/api/users.ts",
      "line": 18,
      "snippet": "  const rows = await db.users.findMany();\n  return rows;\n}",
      "body": "Paginate this, max 50 per page",
      "liveCheck": true,
      "status": "open"
    },
    { "id": "H1-2", "body": "Rename fetchAll to listUsers everywhere", "liveCheck": false, "status": "open" }
  ]
}
```

`status`: `open` | `resolved` | `reopened`. Later rounds update the status of earlier comments in their own file's `previous` map (`{ "H1-1": "resolved" }`), so each file stays append-only.

### Code reviewer report addition

```json
{ "comments": [ { "id": "H1-1", "verdict": "addressed", "evidence": "users.ts:18-31 caps limit at 50" } ] }
```

### Web state
`state.review?: { waiting: boolean; round: number; openFindings: number; comments: { total; open; addressed } }` in the SSE snapshot drives the banner and buttons; the comment details come from `GET /review`.

## 11. Success Criteria

**MVP is done when** a real `--web` run with `humanReview: true` pauses, takes three comments (one line + live check, one file, one general), runs a human round, shows a note and verdict for each, and applies on **Apply** — and a run with `humanReview` off is unchanged.

**Functional**
- ✅ Off → same prompts, reports, exit codes and summary as today (snapshot test)
- ✅ On → pauses after a clean loop and after an exhausted loop
- ✅ Request changes → human findings are blockers; the fixer gets them first; budget is fresh (`fix pass 1/3`)
- ✅ Live-check comments appear as `must` cases in the tester's plan; a fail is a blocker
- ✅ Code report must have a verdict + evidence for every open comment, or it's retried
- ✅ Next pause shows fixer note, verdict and new diff per comment; resolve / reopen work
- ✅ No round limit (e2e test runs 3 human rounds)
- ✅ Apply / Apply anyway (confirm, `force`) / Drop (confirm, branch kept) behave as in §7.6
- ✅ Ctrl+C while waiting → `--resume` and `open` return to the same pause with drafts intact
- ✅ `humanReview` without `--web` starts the web server and prints the URL

**Quality**
- ✅ Mapping, verdict checks and state transitions are pure functions with unit tests
- ✅ Fake-provider e2e: pause → comments → changes → pause → apply
- ✅ Web e2e: add a line comment, request changes, see the verdict, resolve, apply

**UX**
- ✅ From the banner, any comment's outcome is one click away
- ✅ Every destructive action (Apply anyway, Drop) needs a confirm

## 12. Implementation Phases

### Phase 1: State, config and the pause, ~1.5 days
- ✅ `humanReview` config + flags, saved in state
- ✅ `human` step, `humanRound`, `budgetBase`; `phase.ts` pauses instead of finishing
- ✅ `RetryHub` → `WaitHub`; apply / apply anyway / drop in `run.ts`
- ✅ Resume and `open` return to the pause; web server starts without `--web`

*Validation:* unit tests for transitions; fake-provider run pauses, `POST /review/apply` applies, Ctrl+C + `--resume` pauses again.

### Phase 2: Comments → fix loop (KAN-24 core), ~2 days
- ✅ `src/review/human.ts`: schema, write-through storage, `toFindings`, `toCases`
- ✅ `/review` routes for comments and request changes
- ✅ Fixer prompt section; tester plan gets live-check cases; fresh budget

*Validation:* unit tests for the mapping; e2e run where a comment becomes a blocker and the fixer gets it.

### Phase 3: How each comment was handled (KAN-19), ~1.5 days
- ✅ `fixer-comments.json`; code reviewer `comments[]` verdicts + retry check
- ✅ Resolve / reopen with follow-up; status carried across rounds

*Validation:* unit tests for the verdict check; e2e over two human rounds with one resolve and one reopen.

### Phase 4: Review screen, ~2 days
- ✅ `page.html`: banner, diff with inline comment boxes, previous comments, outcome per comment, Apply / Apply anyway / Request changes / Drop with confirms
- ✅ Terminal waiting line; README "Human review"

*Validation:* `web-e2e.test.ts`; manual check with agent-browser per `TESTING.md`.

## 13. Future Considerations

- **Review in the terminal view** (comment on files by number, keys for apply / changes / drop).
- **Moving comments onto the new diff**, GitHub-style "outdated" markers.
- **Suite** ([KAN-43](https://graph-execution.atlassian.net/browse/KAN-43)): one human review over all features' integrated result.
- **Hand-off notes** ([KAN-20](https://graph-execution.atlassian.net/browse/KAN-20)): show each task's notes next to its files in the review diff.
- **Test-plan checklist** (KAN-5) shown next to the diff on the review screen.
- **Notify when waiting** (desktop notification or webhook) so unattended runs don't sit unnoticed.

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Unlimited rounds burn tokens without converging | Each round still has the `fixPasses` cap; every round is an explicit click; the phase line and summary show the round count |
| The reviewer marks a comment addressed when it isn't | Evidence is required and shown; the human resolves, not the reviewer; reopen is one click |
| Diffs grow across rounds and the reviewer loses track of what changed for a comment | Each round stores its `diffHead`; the review screen can show "changes since last round" in addition to the full diff |
| A waiting run holds worktrees and the PID lock for days | Waiting is just saved state: Ctrl+C releases everything, resume restores it. KAN-21 cleanup must skip runs in the `human` step |
| Apply anyway lands broken code | Confirm dialog lists the open findings; summary records "applied with N open finding(s)" |

## 15. Appendix

**Decisions log (grill session, 2026-10-21)**

| Topic | Decision |
|---|---|
| Turning it on | `humanReview` config (default off) + `--human-review` / `--no-human-review`; saved in state |
| No web view | Start the web server anyway; the terminal prints the URL |
| Fix budget | Fresh `fixPasses` budget for each human round |
| Round limit | None; the human decides when to apply or drop |
| Who checks comments | Fixer writes a note per comment; code reviewer reports addressed / not addressed; human resolves or reopens |
| Live tester | Only comments marked *needs live check*, as `must` test-plan cases |
| Still failing after a round | Pause again; Request changes, Apply anyway (confirm) or Drop |
| Drop | Yes, with confirm; result branch kept |
| Comment position | Pinned to the round's diff with a snippet; not moved onto the new diff |
| Pause and restart | New `human` review step; comments in `human/round<H>.json`; generic wait hub |

**Assumptions (not discussed in the grill session)**
- Ctrl+C while waiting exits with code 2 (like an abort) and leaves everything for `--resume`.
- Drop exits 0 if the last loop was clean, 1 otherwise; worktrees are removed, the branch is kept.
- With `--no-merge`, Apply is labeled **Finish** and only ends the run.
- Human comments are always blockers; there's no severity picker.
- Rounds keep counting up across human rounds (`budgetBase` tracks the budget), so report folders never collide.
- Resolving a comment the reviewer called not addressed is allowed; the human wins.

**Related**
- `PRD.md` §7.5 (live tester), §7.6 (review loop), §7.8 (resume), §7.11 (end of run)
- `docs/prd/04-live-change-view.md` (KAN-7 diff panel)
- `docs/prd/05-feature-test-plan.md` (test-plan cases and the verdict check reused here)
- Code: `src/review/phase.ts`, `src/state/state.ts`, `src/runner/retry-hub.ts`, `src/runner/run.ts`, `src/web/server.ts`, `src/agents/fixer.ts`, `src/agents/reviewer.ts`, `src/git/git.ts`
