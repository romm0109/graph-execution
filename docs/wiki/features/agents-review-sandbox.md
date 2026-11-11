# More agents, review provider, standalone sandbox and agent-opened Start run

## Summary

- **Three new agents.** **pi**, **oh-my-pi** (`omp`) and **GitHub Copilot** (`copilot`) work as engine providers (`--provider`, `--review-provider`, reviewers files) and as graph-manager terminal agents with graph-manager's tools.
- **One provider table.** Everything that differs per agent lives in `src/providers/catalog.ts`, which graph-manager imports.
- **Review provider and model.** `--review-provider` and `--review-model` set them for one run. The fixer stays on the run's provider and model.
- **A sandbox without graph-manager.** The npm package has its own Docker sandbox: `--sandbox`, `--sandbox-*` image flags, and `graph-execution sandbox build|dockerfile|config`.
- **A distinct agent-opened Start run.** When an agent opens Start run, it slides in, glows once and shows "Opened by <agent>".
- **graph-manager's skills and engine everywhere.** graph-manager syncs the skills into every agent's folder, and any `graph-execution` started in its terminals, `npx graph-execution` included, runs graph-manager's own engine.

- Spec: `docs/prd/agents-review-sandbox.md` (moves to `docs/prd/done/` with the PR).
- Tasks: `.agents/tasks/agents-review-sandbox/` (12 tasks, run `20261111-111750-3eff`; applied after 2 review rounds and 1 fix pass).
- User docs:
  - `packages/graph-execution/README.md`: Supported agents, flags, Configuration, Sandbox (Docker), Skills, Safety.
  - `apps/graph-manager/README.md`: Terminals, how each agent is connected, Start run.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| One provider catalog (`id, label, bin, npmPackage, engine, loginFiles, loginEnv, sessionEnv, userSkillDirs, projectSkillDir, mcp`), exported from `graph-execution/api`. | Adding an agent touched about 15 files; with one table an agent can't be half-added. | — |
| graph-manager's web keeps its own provider and label lists, and `catalog-sync.test.ts` checks them against the catalog. | The web bundle can't import `graph-execution/api`, which pulls in Node modules. | — |
| The sandbox `PASSED` env list is the old list plus every catalog `loginEnv`. | Before this change, a key the login check accepted (for example `GEMINI_API_KEY`) never reached the container. | — |
| The review provider takes precedence in this order: the reviewer's own provider, then `--review-provider`, then config `reviewProvider`, then `--provider`. The review model goes only to reviewers without their own provider. | The reviewers file is the most specific, and a review model belongs to the review provider. | — |
| The review provider and model are saved in `state.json` and applied when the reviewers are read. The run's `reviewers.json` copy is unchanged. | Always rewriting the copy would make built-in runs look "custom" and change `hashes.reviewers`. | — |
| The fixer, gate fixer, resolver and summarizer keep the run's provider and model. | The user asked for this explicitly. | — |
| pi: `--mode json --no-session`, prompt on stdin. An assistant `stopReason` of `error` or `aborted` with exit 0 counts as exit 1. | pi's JSON mode exits 0 when the model request fails. | — |
| omp: `--mode json --no-session --auto-approve`, and the startup check also requires `bun`. | omp runs only on Bun; without `--auto-approve`, a user setting could deny tools in headless mode. | — |
| Copilot: `--output-format json --allow-all --no-auto-update --session-id <uuid>`, prompt on stdin with no `-p`, and `COPILOT_AUTO_UPDATE=false`. Its session folder is deleted after each run. | Without `--allow-all`, headless Copilot denies every tool and still exits 0. With `-p` it ignores stdin. It has no `--no-session`. | — |
| How each graph-manager agent gets the tools: Copilot with `--additional-mcp-config @<dataDir>/agents/copilot-mcp.json`; omp from graph-manager's entry merged into `~/.omp/agent/mcp.json`; pi through a generated extension (`pi -e <dataDir>/agents/pi-graph-manager.ts`) that bridges graph-manager's MCP server. | Copilot takes an MCP flag, omp reads only config files, and pi has no MCP at all. | — |
| The standalone sandbox uses the `docker` CLI, not the socket API. | The CLI handles contexts, Docker Desktop and remote daemons. | — |
| The sandbox image is generated from `packages/graph-execution/sandbox/Dockerfile.template` and tagged by the hash of its Dockerfile. It installs only the CLIs of the run's providers, plus `bun` for omp. | Docker builds Linux CLIs (the macOS "Exec format error" lesson), and identical settings share one image. | — |
| The image is set by run flags (`--sandbox-image/--sandbox-base/--sandbox-line`) first, then the `sandbox` config section, then the default. `sandbox config` edits that config section. | The user asked to configure the image from the CLI. | — |
| The engine is copied per version into `~/.cache/graph-execution/sandbox-engine/` and mounted read-only. | A local build and a published version run the same way, and an engine upgrade doesn't rebuild the image. | — |
| Logins are staged in a 0700 temp dir, then `docker cp -a` into `/home/sandbox`, and the temp dir is deleted. | The credentials don't linger on the host, and the container keeps the user's uid. | — |
| The page is published on `127.0.0.1:<port>` with a token. `?token=` sets an HttpOnly, `SameSite=Strict` cookie, and `GRAPH_EXECUTION_WEB_PUBLIC_PORT` makes the published port pass the Host and Origin checks. | Other containers can reach the container's port. Before this change the engine answered 421 on any port but its own. | — |
| A sandboxed run's liveness comes from `docker inspect` of the container named in `sandbox.json`. It is resumed with `--resume --run <id> --sandbox`, which uses `TAKE_LOCK_FROM`. | PIDs and locks written inside the container mean nothing on the host. | — |
| The sandbox is refused on Windows (use WSL), inside a sandbox, and for suites. | A Windows path can't be mounted at the same path; nested containers and suites are out of scope. | — |
| An agent-opened Start run gets `.drawer-agent` (a 420 ms slide from off-screen and a 1.6 s accent glow) and a badge "Opened by <label>". With reduced motion it gets no animation but keeps the badge. | The user chose "slide + agent glow". | — |
| Skills are synced into every catalog agent's user skill folder. `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `COPILOT_HOME` are honoured. | Each CLI reads different folders. | — |
| Terminals get `GRAPH_EXECUTION_DELEGATE` (graph-manager's shim) and `GM_ENGINE_BIN`. Any other engine copy re-launches the delegate, with `GRAPH_EXECUTION_DELEGATED=1` to stop loops. | This catches `npx`, global installs and `node_modules/.bin`, and keeps `--sandbox` going to graph-manager. | — |
| graph-manager writes `.cmd` shims on Windows. `/api/health` and Settings show the engine's path and version; `/healthz` is unchanged. | Before this, Windows terminals ran whatever was on the PATH. | — |
| `install skills --target` takes each provider id and `all`. | Each agent reads its own project folder (`.pi/skills`, `.github/skills`, …). | — |

## Known follow-ups

- Suites: no review provider or model, and no sandbox.
- In oh-my-pi, graph-manager's tools are reached through omp's tool discovery (`mcp__graph-manager_open_start_run`); in pi they are named `graph-manager_<tool>`. If an agent doesn't find `open_start_run` by the name the skills use, add the alternative names to the skills.
- `open_start_run` opens the drawer only in a browser that has the calling terminal on screen, and toasts otherwise. This behaviour predates this change.
- The standalone sandbox has no network filtering, and no Podman or rootless Docker support.
- Copilot keeps its login in the OS keychain when one exists. On such a host, a sandbox needs `COPILOT_GITHUB_TOKEN`.
- Real pi, omp and Copilot were not run end to end: only fake binaries were, plus the earlier research against a fake model server.

## Code references

- `packages/graph-execution/src/providers/catalog.ts`, `pi.ts`, `omp.ts`, `pi-json.ts`, `copilot.ts`, `tools.ts`, `spawn.ts` (the new `env` option).
- `packages/graph-execution/src/review/reviewers.ts` (`applyReviewDefaults`, `readRunReviewers`), `src/launch/preflight.ts`, `src/runner/run.ts`, `src/config/config.ts`.
- `packages/graph-execution/src/sandbox/` (`docker.ts`, `image.ts`, `engine.ts`, `settings.ts`, `run.ts`), `sandbox/Dockerfile.template`, `src/__fixtures__/fake-docker.ts`.
- `packages/graph-execution/src/web/server.ts` and `start.ts` (the token cookie and public port).
- `packages/graph-execution/src/launch/delegate.ts`, `src/install/skills.ts`, `src/standalone-e2e.test.ts`.
- `apps/graph-manager/src/server/agents.ts`, `pi-extension.ts`, `skills.ts`, `terminals.ts`, `app.ts`, `routes/health.ts`, `runoptions.ts`, `catalog-sync.test.ts`.
- `apps/graph-manager/src/web/ui/Drawer.tsx`, `ui/base.css`, `agentRequests.tsx`, `pages/StartRunDrawer.tsx`, `pages/RunOptionsFields.tsx`, `pages/Terminals.tsx`, `pages/Settings.tsx`, `ui/AgentIcon.tsx`.

## Related

- [Agent tools](agent-tools.md) · [Sandboxed runs in graph-manager (KAN-88)](sandboxes.md) · [Run options (KAN-89)](run-options.md) · [Reviewers from the UI (KAN-87)](ui-reviewers.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-11
