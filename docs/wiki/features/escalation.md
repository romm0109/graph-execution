# Escalation: a task agent stops its branch and asks for a decision (KAN-105)

## Summary

A task agent or the review-phase fixer can stop and escalate when its task can't be done as written, or needs a product or design decision. A task whose validation is exhausted escalates too. Only the escalated task and its dependents wait; the rest of the graph keeps running. The user resolves it on the run page (Decision tab, with an advisor agent in a terminal), with `graph-execution resolve`, or through `POST /escalations/resolve`. The run then continues without rerunning finished tasks. User docs: the "Escalation" section of `packages/graph-execution/README.md`. Spec: `docs/prd/done/escalation.md`.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| The agent writes a JSON escalation file at `<runDir>/escalations/inbox/<label>-a<attempt>.json` (outside its worktree), shaped `{ reason, evidence, questions[] }`. The engine turns it into the record `<runDir>/escalations/E<n>.json`. | It works the same for every provider, and `commitLeftovers` never commits it. The questions are what a human or the closed harness answers. | KAN-106 |
| Prompt rules only: escalate on a contradiction with the spec or the code, or a decision that is costly to reverse; evidence is required; no cap. | The user chose rules over heuristics. | KAN-106 |
| Task agents and the fixer escalate. Exhausted validation escalates. Reviewers, the tester, the resolver, the summarizer and the gate fixer don't. | Scope for v1. | KAN-106 |
| Only the escalated branch pauses, and several escalations are independent. The review starts when every task is merged and none is open. | The user chose branch-only; escalations arrive at different times. | KAN-106 |
| Resolutions are applied one at a time and checked against the task set at that moment. Stale ones get 409 (`not_open`, `task_started`). | The run process is the single writer of the state. | KAN-107 |
| `continue` / `change` (edit, add, remove, reopen) / `abort`. Reopened tasks rerun on top of their merged work. The escalated attempt is not merged. | Reruns only what the resolution names; partial work from a wrong design must not land. | KAN-107 |
| Changed tasks live in the run's copy `<runDir>/tasks/` (`tasksSource: "run"`); the user's folder is never written. | `--resume` would refuse after every task change otherwise. | KAN-107 |
| It waits forever and can be resumed. An `abort` resolution marks the run `abortedBy: "resolution"`, which can't be resumed. | The user chose to wait forever; abort means "stop the run". | KAN-107 |
| One HTTP route serves every client. `resolve` posts live, or applies offline under the run lock (also when a stopped `--web` page answers `not_waiting`). | One code path; the offline path covers Ctrl+C. | KAN-107 |
| The advisor is the provider's interactive CLI in a PTY on the run page, in its own worktree. It writes `draft.json` (Apply resolution) or runs `resolve` itself. | The user wanted a real chat, like graph-manager's terminals, and asked for both ways to apply. | KAN-108 |
| The terminal code is shared in `packages/graph-execution/src/terminal/` (`graph-execution/terminal` export); graph-manager uses it, and its existing tests are unchanged. | The user asked for a common folder inside the engine. | KAN-108 |
| graph-manager's run proxy passes WebSocket upgrades through with the same auth, Origin and token rules. | Otherwise the advisor can't work through graph-manager or its sandboxes. | KAN-108 |
| The `escalation` config key is on by default, with `--escalation` / `--no-escalation`, saved in the run. It is forced off in suite feature runs. | The suite page has no Decision screen yet. | KAN-106 |

## Known follow-ups

- `node-pty` in sandbox images: without it the advisor terminal shows "unavailable" (drafts by hand still work).
- Escalation in suites (forced off now) and a suite-level Decision screen.
- The fake provider forgets used attempts after `--resume`, so a requeued scripted task escalates again; the tests empty the script first.
- After an offline `resolve` plus `--resume` of a stopped `--web` run, the old page process can outlive `--resume` briefly.
- The closed harness (arbiter, email/Slack notification) builds on `POST /escalations/resolve` and the exported API.

## Code references

- `packages/graph-execution/src/escalation/schema.ts`, `store.ts`: the file and record schemas, inbox intake, `E<n>` records.
- `packages/graph-execution/src/escalation/resolve.ts`: `resolutionSchema`, `checkResolution`, `applyResolution`.
- `packages/graph-execution/src/escalation/draft.ts`: draft read and watch.
- `packages/graph-execution/src/runner/run.ts`, `src/scheduler/scheduler.ts`, `src/runner/retry-hub.ts`: branch-only pause, requeue, the resolution queue.
- `packages/graph-execution/src/agents/task.ts`, `src/agents/fixer.ts`: the escalation rules and the `## Decision` prompt section.
- `packages/graph-execution/src/review/phase.ts`: fixer escalation and the review round restart.
- `packages/graph-execution/src/agents/advisor.ts`, `src/providers/*.ts` (`interactive`): the advisor.
- `packages/graph-execution/src/terminal/`: the shared PTY session, WebSocket bridge and browser client.
- `packages/graph-execution/src/web/server.ts`, `src/web/assets/escalation.js`: routes and the Decision tab.
- `packages/graph-execution/src/cli.ts`, `src/launch/preflight.ts`: `resolve`, `escalations`, flags.
- `apps/graph-manager/src/server/proxy.ts` (+ `proxy-ws.test.ts`), `apps/graph-manager/vite.config.ts`: the WebSocket pass-through.

## Related

- [Project wiki index](../index.md)
- [Human review round](human-review-round.md)
- [Terminal lag: instant echo, WebGL, batched output](terminal-instant-echo.md)

## Last updated

2026-11-18
