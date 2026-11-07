# PRD: Monorepo and graph-manager

No Jira tickets for this work: it was agreed with the user in conversation (2026-11-06). Ids below are `GM-xx`.

## 1. Executive summary

graph-execution is an open-source CLI. It runs a graph of agent tasks and shows each run in its own local web page. The user wants a bigger product around it, **graph-manager**: one service that runs anywhere Docker runs (a laptop, a VM, OpenShift). You open it in the browser and log in. You connect GitHub or GitLab, clone repositories into workspaces, and open terminals inside the service (plain PTYs, in the spirit of herdr) where you run `claude` or any other CLI. From those terminals you plan with the `to-tasks` skill and start graph-execution runs. A dashboard shows every run in every workspace with its live graph. When a run lands, a button commits the result, pushes a branch and opens a GitHub PR or GitLab MR.

To build both in one place, this repository becomes an **npm-workspaces monorepo**:

```
package.json                  private root, "workspaces": ["packages/*", "apps/*"]
packages/graph-execution/     the open-source engine and CLI (published to npm as before)
apps/graph-manager/           the wrapper product: server, web UI, Dockerfile
```

**Goal:** `docker build -f apps/graph-manager/Dockerfile .` builds an image. `docker run -e GM_PASSWORD=… -p 7420:7420 -v gm-data:/data -v gm-ws:/workspaces <image>` serves graph-manager on port 7420. After login you can do all of these:
- save a GitHub or GitLab token
- clone a repository
- open a terminal in it
- run `graph-execution … --provider fake --web` in that terminal and see the run appear in the dashboard with its live graph
- press **Create PR** on the applied run and get a PR/MR link

## 2. Principles

1. **The engine stays a standalone open-source CLI.** graph-manager depends on graph-execution, never the other way round. The engine only gains a small library entry (`graph-execution/api`) and sub-path-safe web URLs. Nothing in it knows about graph-manager, forges or Docker.
2. **The host decides nothing.** The same image runs on a laptop, a VM or OpenShift. All state lives in two volumes: `/data` (settings, tokens, HOME of the terminals) and `/workspaces` (clones).
3. **Plain PTYs.** Terminals are `node-pty` processes streamed over WebSocket to xterm.js. They work in every desktop browser on every OS. They survive a browser reload, not a server restart.
4. **One user per deployment.** Login is a single admin password from `GM_PASSWORD`. Forge access is a personal access token per forge.
5. **Every forge call is testable offline.** API base URLs are configurable, and the tests run against a fake forge server and local bare repositories.

## 3. Users

- **The owner.** A developer who wants to drive coding agents from any device against a long-running box. They run one container, log in from the browser, and keep many terminals and runs going.

## 4. Scope

### In scope

- ✅ **GM-01 Monorepo restructure.**
  - The engine moves to `packages/graph-execution/` with its `src/`, `scripts/`, `skills/`, `demo/`, `docs/img/`, tsconfigs, vitest config, README, LICENSE and CHANGELOG.
  - The root becomes a private workspaces package with delegating scripts.
  - CI, docs (CLAUDE.md, TESTING.md) and every root-relative path are updated.
  - The npm package contents stay the same.
- ✅ **GM-02 Engine library entry.**
  - `graph-execution/api` exports the state schemas, run discovery and the exit codes, with type declarations.
  - The run web page uses relative URLs, so it works when proxied under a sub-path.
- ✅ **GM-03 graph-manager skeleton.**
  - Fastify server and React + Vite UI in `apps/graph-manager`.
  - Admin-password login with a signed session cookie.
  - App shell with navigation (Workspaces, Terminals, Runs, Settings).
  - Workspace scripts, tests, lint and typecheck wired into the root.
- ✅ **GM-04 Forge connections.**
  - Settings page to save, verify and remove a GitHub token and a GitLab token (with base URL, for self-hosted GitLab).
  - Tokens are stored in `/data`, never sent to the browser after saving.
- ✅ **GM-05 Workspaces.**
  - List repositories from the connected forges and clone one into `/workspaces/<forge>/<owner>/<repo>`.
  - Workspace list page with branch and dirty state, and an **Open terminal** button.
  - Clones use the token without writing it into `.git/config`.
- ✅ **GM-06 Terminals.**
  - Create, list, attach to, resize and kill PTY terminals with a cwd inside `/workspaces`.
  - Tabs in the UI, and a sidebar status per terminal (`working` when it produced output in the last 3 s, `idle`, `exited <code>`).
  - Scrollback replay on reattach.
  - The terminal environment has `graph-execution` on `PATH`, `GRAPH_EXECUTION_HANDOFF=detached` and `SSH_CONNECTION=1`, so `--web` runs start detached and don't try to open a browser.
- ✅ **GM-07 Runs dashboard.**
  - Discover every run and suite under every workspace via `graph-execution/api`, with status, live/finished state, created time and workspace.
  - Run detail page: the live run page proxied under `/runs/<ws>/<runId>/view/` while the run's web server is up; otherwise a static graph built from `state.json`.
  - **Start run** form: tasks folder, spec, provider.
- ✅ **GM-08 Run → PR.**
  - On a run with status `applied` whose workspace has uncommitted changes, a **Create PR** form takes branch, title and body.
  - It commits, pushes with the token and opens a GitHub PR or GitLab MR. The link is stored and shown on the run.
- ✅ **GM-09 Docker.**
  - `apps/graph-manager/Dockerfile` (build context: the repo root) and `apps/graph-manager/docker-compose.yml`.
  - The image contains git, the built graph-execution CLI on `PATH`, the Claude Code CLI, and graph-manager listening on `0.0.0.0:7420`.
  - Volumes `/data` and `/workspaces`, with `HOME=/data/home` so a `claude` login in a terminal survives restarts.

### Out of scope

- ❌ Jira, and forges other than GitHub and GitLab.
- ❌ Multiple users, roles, SSO, OAuth apps.
- ❌ Billing, licensing, a hosted SaaS.
- ❌ A desktop app wrapper (the web UI is built so it can be wrapped later).
- ❌ Persistent terminals across server restarts (tmux).
- ❌ OpenShift manifests and Helm charts (the image must simply run as an arbitrary non-root UID).
- ❌ Changing how graph-execution runs, reviews or applies.

## 5. User stories and acceptance criteria

**US-1 Engine still works as before (GM-01).** As a maintainer, I run the same checks and publish the same package.
- `npm ci && npm run typecheck && npm run lint && npm test` at the root passes, and runs the engine's and graph-manager's checks.
- `npm run build -w graph-execution` builds `packages/graph-execution/dist/cli.js`.
- `npm pack -w graph-execution` produces a tarball with exactly `dist`, `skills`, `README.md`, `LICENSE`, `package.json`, as before.
- `.github/workflows/qa.yml` passes on ubuntu and macos.
- `node packages/graph-execution/dist/cli.js --help` works from the repo root.

**US-2 graph-manager can read runs (GM-02).** As graph-manager, I import `graph-execution/api` and get typed schemas and discovery.
- `import { stateSchema, scan, lockHolder, readWebJson, EXIT } from "graph-execution/api"` compiles, with declarations.
- Importing it does not run the CLI.
- The run page works at `http://127.0.0.1:<port>/` exactly as before. Fetched through a sub-path proxy (`/x/y/` mapped to `/`), it loads its assets, state and SSE events too.

**US-3 Log in (GM-03).** As the owner, I open graph-manager and log in with `GM_PASSWORD`.
- Without a session every `/api/*` route answers 401 and the UI shows the login page.
- A wrong password gives 401. A correct one sets an HttpOnly session cookie and shows the app shell.
- The server refuses to start without `GM_PASSWORD`.

**US-4 Connect a forge (GM-04).** As the owner, I paste a GitHub token, or a GitLab token plus base URL.
- **Save** verifies the token against the forge (`GET /user`, or `GET /api/v4/user`) and shows the account login. An invalid token shows the forge's error and is not saved.
- `GET /api/forges` never returns the token.
- **Remove** deletes it.

**US-5 Clone a repo (GM-05).** As the owner, I pick a repository from a connected forge and clone it.
- The repo appears under Workspaces with its path, current branch and clean/dirty state.
- The token is not in `.git/config`.
- Cloning the same repo twice answers 409.

**US-6 Terminals (GM-06).** As the owner, I open a terminal in a workspace and run commands.
- Typing `echo hi` shows `hi`.
- Reloading the page and reattaching shows the earlier output.
- Two tabs run independently. The sidebar shows `working` while output flows and `exited 0` after `exit`.
- A cwd outside `/workspaces` answers 400.

**US-7 See runs (GM-07).** As the owner, I see every graph-execution run across workspaces.
- A run started in a terminal with `--provider fake --web` appears within 5 s with status `running`, then `applied`.
- Its detail page shows the live graph through the proxy.
- A finished run whose web server is closed shows a static graph of its tasks and their status.
- **Start run** with `--provider fake` starts a run that appears the same way.

**US-8 Create a PR (GM-08).** As the owner, on an applied run with uncommitted changes, I create a PR.
- The changes are committed on the new branch and pushed.
- A PR (GitHub) or MR (GitLab) is created through the API and its URL is shown on the run.
- A run whose workspace is clean shows no button, and the API answers 409.

**US-9 Docker (GM-09).** As the owner, I build and run one image.
- `docker build -f apps/graph-manager/Dockerfile -t graph-manager .` succeeds.
- `docker run` with `GM_PASSWORD` serves the login page on port 7420.
- In a terminal of the container, `graph-execution --version` and `claude --version` work.
- Data survives a container restart.

## 6. Architecture

```
browser ── HTTP/WS ──> graph-manager server (Fastify, :7420)
                          ├─ /api/auth, /api/forges, /api/workspaces, /api/terminals (+ WS), /api/runs
                          ├─ /runs/<ws>/<id>/view/*  ── reverse proxy ──> 127.0.0.1:<run port> (graph-execution --web)
                          ├─ data store: $GM_DATA_DIR/graph-manager.json (mode 600)
                          └─ node-pty terminals, cwd under $GM_WORKSPACES_DIR
```

| Setting | Env var | Default |
|---|---|---|
| Admin password | `GM_PASSWORD` | required |
| Port / host | `GM_PORT` / `GM_HOST` | `7420` / `127.0.0.1` (the image sets `0.0.0.0`) |
| Data dir | `GM_DATA_DIR` | `~/.graph-manager` (image: `/data`) |
| Workspaces dir | `GM_WORKSPACES_DIR` | `~/graph-manager-workspaces` (image: `/workspaces`) |
| GitHub API base | `GM_GITHUB_API_URL` | `https://api.github.com` |
| graph-execution CLI | `GM_GRAPH_EXECUTION_BIN` | resolved from the `graph-execution` workspace package |

Stack: Node 20+, TypeScript (same strict tsconfig options as the engine), Fastify 5, `@fastify/websocket`, `@fastify/cookie`, `node-pty`, zod. UI: React 19, Vite, react-router, `@xterm/xterm` + `@xterm/addon-fit`. Tests: vitest (server with `fastify.inject` and real WebSocket clients, UI logic with plain unit tests).

## 7. Decisions

| Decision | Why |
|---|---|
| Full restructure into `packages/` + `apps/` | The user chose a monorepo with a clean layout over keeping the engine at the root. |
| Plain PTYs, not tmux | Must work for every frontend OS; persistence across server restarts is not needed now. |
| Single admin password | One user per deployment for now. |
| PATs, not OAuth apps | Works with GitHub, GitLab.com and self-hosted GitLab without registering apps. |
| Clone from forge into `/workspaces` | Workspaces come from the connected forge; runs start from the terminal or a button. |
| Create PR button | Commits, pushes and opens the PR/MR from the dashboard. |
| Proxy the run page instead of rebuilding it | The engine's page is complete; graph-manager adds the list, the fallback graph and the PR flow. |

## 8. Risks

- **node-pty is native.** The Docker image and CI need build tools. CI keeps ubuntu and macos.
- **Agents run with full permissions inside the container.** That is the documented graph-execution model. The container is the isolation boundary, and the login protects the terminals.
- **Tokens at rest.** They sit in `/data/graph-manager.json` with mode 600. They are never logged and never returned by the API.
