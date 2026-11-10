# Agent supervisor: run tools and run events for terminal agents (KAN-91, KAN-92)

## Summary

An agent in a graph-manager terminal (Claude Code, Codex, OpenCode, Qwen Code) used to have one graph-manager tool, `open_start_run`, and was blind once a run started. It now has eleven more tools to read, steer and show runs of its workspace (KAN-91): `list_runs`, `get_run_log`, `get_node_output`, `get_artifacts`, `list_graphs`, `open_run`, `open_graph`, `propose_graph`, `refresh_ui`, `cancel_run` and `resume_run`. graph-manager also remembers which agent terminal started each run, watches those runs, and types a one-line `[graph-manager] …` event into that terminal when the run starts, enters review, succeeds, fails, is resumed or is cancelled (KAN-92). A per-workspace **Supervisor** setting decides what the failure line tells the agent: report to the user (`report`, the default) or fix, commit and `resume_run` (`act`). The `run-graph` and `to-tasks` skills tell agents about the events and tools.

- Spec: `docs/prd/agent-supervisor.md`.
- Tasks: `.agents/tasks/agent-supervisor/`.
- User docs: "Agents and tools" and "Run events and the Supervisor setting" in `apps/graph-manager/README.md`.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| Events reach the agent by typing one line into its terminal (PTY), then Enter, only once the terminal has been quiet for `WORKING_MS` (3 s). Lines queue in order per terminal. | MCP stdio servers can't wake an idle agent, and typing works the same for all four agents. Waiting for quiet avoids typing into the agent's output or an in-progress turn. | KAN-92 |
| A run's events go only to the terminal that started it (its origin). | The user's choice: the agent that started the run supervises it. | KAN-92 |
| The event is dropped when that terminal was closed, has exited, isn't an agent terminal, or its foreground process is its shell (the user quit the agent). | A shell would run the line as a command. | KAN-92 |
| Origins live in memory (`RunOrigins`), not in `graph-manager.json`. | Terminals don't survive a restart either, so a saved origin would point at nothing. | KAN-92 |
| The shim generates the run id (`gm-<yyyymmdd-hhmmss>-<4 hex>`), sets `GRAPH_EXECUTION_RUN_ID` for the engine and registers the origin before spawning it; sandbox runs send `GM_TERMINAL_ID` with the sandbox request; **Start run** opened from an agent request sends `originTerminalId`; `resume_run` makes the caller the origin. | These are every way an agent starts or resumes a run, and the id is known before the run starts, so the first event isn't missed. The shim stays dependency-free. | KAN-92 |
| The watcher polls the summaries of origin runs every 2 s (`listWorkspaceRuns`) and diffs status and review step with the last seen values. | Reuses the Runs page's status logic (including `interrupted` and `failure`); only runs with an origin are watched, so the cost is small. | KAN-92 |
| Events are run-level only: `started`, `review`, `succeeded`, `failed`, `resumed`, `cancelled`. The first sight of a run sends `started`, then its end event if it already ended. | The ticket. The agent pulls node detail with `get_node_output` and `get_run_log`; fast runs can end between two polls. | KAN-92 |
| The Supervisor setting is per workspace (`workspaceSettings[<ws>].supervisor`), `report` by default, edited in the workspace settings drawer ("Report to me" / "Fix and rerun"), with `GET/PUT /api/workspaces/:id/supervisor`. | The user's choice: one setting per workspace, report by default. | KAN-92 |
| The mode is written into the `failed` line's text, read at the time of the failure. There is no cap on reruns. | The agent needs the instruction at the moment of failure; the setting is the only control. | KAN-92 |
| UI tools (`open_run`, `open_graph`, `propose_graph`, `refresh_ui`) reuse the agent-request queue with new kinds and return at once; `refresh` goes to every tab and expires after 10 s. | The pattern `open_start_run` set: non-blocking, browsers already poll every 2 s. "Refresh" has no single target. | KAN-91 |
| `open_graph` opens a run page at `?node=<id>` or a read-only preview of a task folder's graph; `propose_graph` shows the same preview with **Approve** (opens the prefilled Start run form) and **Reject** (types `[graph-manager] The user rejected the graph <tasksDir>.` into the terminal). | A graph is a run's task graph or a task folder. The agent writes the task folder and the user approves it; graph-manager runs no LLM of its own. | KAN-91 |
| `cancel_run` uses the run page's `POST /abort` when the run is live, else stops its sandbox; worktrees and state are kept. | Same effect as Ctrl+C or the UI's Abort, so the run can be resumed. | KAN-91 |
| `resume_run` calls the existing `resumeRun` and takes no answers. | The engine has no input-wait other than the human review round, which has its own UI. | KAN-91 |
| A recorded resume (`resume_run`, `--resume --run` through the shim, a sandbox resume) stores `resumedAt` on the origin. The watcher waits until the resumed attempt shows (`running`, or `state.json` written after `resumedAt`), then reports `resumed` and that attempt's end, even when the status is the same as before. | A resume that fails again within one poll would otherwise send nothing, and an `act` agent would wait forever. A run first seen through a resume reports `resumed`, not `started`. | KAN-92 |
| A live run that says `running` while a task has `failed` and nothing is in flight (a `--web` run waiting for Retry, Merge or Close) counts as `failed`, once it has been seen twice in a row. `resume_run` closes such a page first, and also the page an aborted run keeps open. | Otherwise the agent gets no failure until a human closes the page, and can't resume a run it cancelled ("the run is live"). | KAN-92 |
| Agent-request toasts stay until the user presses Open or ×. × acks the request; for a proposal it is a rejection. Closing the proposal preview keeps it pending and shows the toast again. A toast goes away when its request is acked in another tab. | A toast that disappears after 6 s left a pending request that came back on every reload, and a closed proposal left the agent with no answer. | KAN-91 |
| An origin whose run folder still doesn't exist after 60 s is dropped. | The engine refused to start (bad args, a dirty tree), so the origin would be polled until the terminal closed. | KAN-92 |
| Every tool sees only the calling terminal's workspace; a run of another workspace is `unknown run <id>`. Read tools return capped plain text. | KAN-91 #4: own-workspace scope. Caps keep the agent's context small. | KAN-91 |

## Known follow-ups

- Machine-wide run status across workspaces, as an opt-in (KAN-91 #4).
- Run origins and queued event lines are lost when graph-manager restarts.
- `graph-execution --resume` without `--run` typed in a terminal registers no origin, so it sends no events.
- A live run waiting on a failed review agent or the validation gate (rather than a task) is not detected as failed until its page is closed: `state.json` doesn't show that wait.
- Origins registered from plain (non-agent) terminals are kept and polled, though their events are always dropped.
- Suites are not supervised: no events, and `cancel_run` / `resume_run` refuse them.
- No `graph-manager-mcp` shim on Windows, so agents there have none of these tools.
- Dictated answers on resume are not supported.

## Code references

- `apps/graph-manager/src/server/tools/list-runs.ts`, `get-run-log.ts`, `get-node-output.ts`, `get-artifacts.ts`, `list-graphs.ts`: the read tools.
- `apps/graph-manager/src/server/tools/open-run.ts`, `open-graph.ts`, `propose-graph.ts`, `refresh-ui.ts`: the UI tools.
- `apps/graph-manager/src/server/tools/cancel-run.ts`, `resume-run.ts`: stopping and resuming runs.
- `apps/graph-manager/src/server/tools/run-helpers.ts`, `tools/index.ts`: shared helpers and the registry.
- `apps/graph-manager/src/server/supervisor.ts`: `RunEventWatcher`, `diffRun`, `eventLine`.
- `apps/graph-manager/src/server/run-origins.ts`: `RunOrigins`.
- `apps/graph-manager/src/server/terminals.ts`: `TerminalManager.typeWhenIdle`.
- `apps/graph-manager/src/server/shim.ts`: run id and origin registration.
- `apps/graph-manager/src/server/routes/internal.ts`: `POST /api/internal/run-origins`, sandbox origins.
- `apps/graph-manager/src/server/routes/supervisor.ts`, `store.ts`: the Supervisor setting.
- `apps/graph-manager/src/server/routes/runs.ts`: `originTerminalId`.
- `apps/graph-manager/src/server/agent-requests.ts`, `routes/agent-requests.ts`: the new request kinds and the reject line.
- `apps/graph-manager/src/server/routes/inspect.ts`: `GET /api/workspaces/:id/graph`.
- `apps/graph-manager/src/web/agentRequests.tsx`, `web/pages/GraphPreviewDialog.tsx`, `web/pages/RunDetail.tsx`, `web/pages/StartRunDrawer.tsx`, `web/pages/WorkspaceSettingsDrawer.tsx`: the web side.
- `packages/graph-execution/skills/run-graph/SKILL.md`, `skills/to-tasks/SKILL.md`: the skill changes.

## Related

- [Agent tools](agent-tools.md)
- [graph-manager](graph-manager.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-09
