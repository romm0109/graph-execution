# Agent tools: agent buttons on Terminals and graph-manager's MCP tools (AT-01 … AT-06)

## Summary

graph-manager's Terminals page opens agents directly. There are buttons for **Claude Code**, **Codex**, **OpenCode** and **Qwen Code**, and **Plain terminal** is now the secondary option. Each button connects graph-manager's MCP server, `graph-manager-mcp`, to that agent, then runs the agent inside the terminal's shell. graph-execution developers add tools to that server in code, in `apps/graph-manager/src/server/tools/`. The first tool, `open_start_run`, opens the Start run popup prefilled with a task folder and spec, next to the agent's terminal. The `to-tasks` and `run-graph` skills call it when it is available.

- Spec: `docs/prd/done/agent-tools.md`.
- Tasks: `.agents/tasks/agent-tools/`, built in run `20261108-230135-ae80`.
- User docs: "Agents and tools" and "Adding a tool" in `apps/graph-manager/README.md`.

These ids are not Jira tickets: the work was agreed with the user in conversation.

## Decisions

| Decision | Why | Id |
| --- | --- | --- |
| Tools are TypeScript modules registered in `tools/index.ts` (`defineTool({ name, description, input, run })`), written by graph-execution developers. There are no config-file tools. | The user chose a code registry. "Developers" means people working on graph-execution, not its users. | AT-01 |
| There is one hand-written stdio MCP server, `graph-manager-mcp`, with only `node:` imports. It fetches the tool list from `GET /api/internal/tools` and forwards calls to `POST /api/internal/tools/:name`. | It needs no dependency and starts fast. A new tool needs no change to the MCP command or to any agent config. | AT-02 |
| The MCP server authenticates with the per-boot `GM_INTERNAL_TOKEN`. It finds its terminal through the new per-terminal `GM_TERMINAL_ID`. | This reuses KAN-88's internal API, and no token ever lands in a file. | AT-02 |
| Where an agent supports it, the MCP config is injected at launch: Claude Code gets `--mcp-config <dataDir>/agents/claude-mcp.json --allowedTools mcp__graph-manager`, Codex gets `-c mcp_servers.graph-manager.command=…`, OpenCode gets `OPENCODE_CONFIG_CONTENT`. Only Qwen Code gets a committed `.qwen/settings.json`. | The user chose "inject, commit only if needed", which keeps repos clean. | AT-03 |
| The Qwen commit contains only that file, on the current branch, and is never pushed. It happens once (idempotent). It is refused with 409 when the file has uncommitted changes, during a merge, rebase or cherry-pick, or on a detached HEAD. | The user's other edits are never committed. | AT-03 |
| The agent's command line is typed into the shell, so quitting the agent leaves a prompt. Restarting the terminal types the command again. | The user chose "in a shell" with normal permission prompts. Only graph-manager's own tools are pre-allowed. | AT-03 |
| `open_start_run` returns right away. The request waits in memory (24 h, one per terminal) until a browser acks it. | The user chose not to block the agent. Browsers already poll every 2 s. | AT-04 |
| A tab that shows the calling terminal in a visible pane opens the drawer itself. Other tabs show a toast, `<Agent> in <repo> wants to start a run`, with **Open**. | The user chose "pop up where the terminal is". | AT-04 |
| A prefill wins over the workspace's saved run defaults. Its options are merged over the saved options. | Options the agent didn't set keep the user's saved choices (a review finding, fixed after the run). | AT-04 |
| The skills use `open_start_run` only when it is among the agent's tools. | Outside graph-manager the skills work as before. | AT-05 |

## Known follow-ups

These are minor findings from the run's code review that were left open:

- OpenCode's `OPENCODE_CONFIG_CONTENT` and `GM_TERMINAL_ID` live in the shell's environment. A `graph-execution --provider opencode` run started from that terminal therefore gives its task agents the graph-manager tools. Tools for run agents were a non-goal.
- `AgentRequestHost` mounts its own `StartRunDrawer`, next to the one on the Runs page. The spec asked for one shared drawer.
- When another tab acks a request, a toast already shown for it stays on screen. Its **Open** still opens the drawer, and the ack gets a 404 that is ignored.
- Agent buttons on Windows: no `graph-manager-mcp` shim is written there, so agents start without the tools.
- Agent requests are lost when the server restarts.
- Only Claude Code was tried against a real CLI. Codex, OpenCode and Qwen Code were checked with fake CLIs that record their arguments and env.

## Code references

- `apps/graph-manager/src/server/tools/types.ts`, `tools/index.ts`: the registry (`GmTool`, `defineTool`, `TOOLS`, `toolList`).
- `apps/graph-manager/src/server/tools/open-start-run.ts`: the first tool.
- `apps/graph-manager/src/server/mcp.ts`: the stdio MCP server (`handleMessage`).
- `apps/graph-manager/src/server/routes/internal.ts`: `GET /api/internal/tools`, `POST /api/internal/tools/:name`.
- `apps/graph-manager/src/server/agents.ts`: the agent adapters, `commandLine`, `isInstalled`, `prepareProjectConfig`.
- `apps/graph-manager/src/server/terminals.ts`: `GM_TERMINAL_ID`, the per-terminal `env` / `input` / `agent`, `writeMcpShim`.
- `apps/graph-manager/src/server/routes/terminals.ts`: `GET /api/agents`, `POST /api/terminals { agent }`.
- `apps/graph-manager/src/server/agent-requests.ts`, `routes/agent-requests.ts`: the request queue.
- `apps/graph-manager/src/web/agentRequests.tsx`: `AgentRequestHost` and the visible-terminals context.
- `apps/graph-manager/src/web/pages/TerminalSidebar.tsx`, `pages/Terminals.tsx`: the agent buttons and the dialog.
- `apps/graph-manager/src/web/pages/StartRunDrawer.tsx`: `prefill`.
- `packages/graph-execution/skills/to-tasks/SKILL.md`, `skills/run-graph/SKILL.md`: the skill changes.

## Related

- [graph-manager](graph-manager.md)
- [Run options in Start run](run-options.md)
- [Sandboxed runs](sandboxes.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-08
