# graph-manager

graph-manager is a small web service around the [graph-execution](../../packages/graph-execution/README.md) engine. From one browser tab you can:

- connect GitHub or GitLab with a personal access token,
- clone repositories into workspaces,
- open terminals in those workspaces to run `claude` and `graph-execution`,
- follow every run on a dashboard, and
- open a pull request (or merge request) from an applied run.

It ships as one Docker image that runs the same on a laptop, a VM or OpenShift.

## Quick start

With Docker Compose, from `apps/graph-manager`:

```bash
GM_PASSWORD='choose-a-password' docker compose up --build
```

Or with plain Docker, from the repository root:

```bash
docker build -f apps/graph-manager/Dockerfile -t graph-manager:dev .
# behind a TLS-intercepting proxy, add: --secret id=ca,src=/path/to/proxy-ca.crt
docker run -d --name graph-manager \
  -e GM_PASSWORD='choose-a-password' \
  -e GIT_AUTHOR_NAME='Ada Lovelace' -e GIT_AUTHOR_EMAIL=ada@example.com \
  -e GIT_COMMITTER_NAME='Ada Lovelace' -e GIT_COMMITTER_EMAIL=ada@example.com \
  -p 127.0.0.1:7420:7420 \
  -v gm-data:/data -v gm-workspaces:/workspaces \
  graph-manager:dev
```

Then open <http://127.0.0.1:7420>.

The image contains git, the built `graph-execution` CLI on `PATH` and the Claude Code CLI (`claude`). It runs as a non-root user. `/data` and `/workspaces` are writable by group 0, so it also runs under OpenShift's arbitrary UIDs. `GET /healthz` answers `{"ok":true}` without logging in, for the Docker `HEALTHCHECK` and for liveness and readiness probes.

To check an image end to end (build, health, UI, login, the CLIs and a writable `/data`), run `bash apps/graph-manager/scripts/docker-smoke.sh` from the repository root. It needs Docker and is not part of `npm test`.

## Configuration

| Env var | Default (outside Docker) | In the image | Meaning |
| --- | --- | --- | --- |
| `GM_PASSWORD` | required | required | The admin password for the login page |
| `GM_PORT` | `7420` | `7420` | The port to listen on |
| `GM_HOST` | `127.0.0.1` | `0.0.0.0` | The address to listen on |
| `GM_DATA_DIR` | `~/.graph-manager` | `/data` | The state: tokens, the session secret and the saved Start run choices (`graph-manager.json`), and the `bin/` shim |
| `GM_WORKSPACES_DIR` | `~/graph-manager-workspaces` | `/workspaces` | Where repositories are cloned, as `<forge>/<owner>/<repo>` |
| `GM_GITHUB_API_URL` | `https://api.github.com` | same | The GitHub API base URL (for GitHub Enterprise) |
| `GM_GRAPH_EXECUTION_BIN` | the workspace's `graph-execution` | `/app/packages/graph-execution/dist/cli.js` | The graph-execution CLI used by terminals and the **Start run** form |
| `HOME` | | `/data/home` | Keeps the `claude` login and git config on the data volume |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | git config | `graph-manager`, `graph-manager@localhost` | The identity graph-execution and **Create PR** commit with. Override them with `-e`. |
| `ANTHROPIC_API_KEY` | | | Optional. Lets `claude` run without an interactive login. |
| `GM_DOCKER_SOCKET` | `/var/run/docker.sock` | same | The Docker Engine API socket graph-manager starts sandboxes through |
| `GM_SANDBOX_IMAGE` | none | graph-manager's own image in Docker, else `node:24.22.1-bookworm` | The default sandbox image (a workspace can override it) |
| `GM_SANDBOX_WORKSPACES_SOURCE` | found by inspecting graph-manager's container | same | The Docker volume name or host path behind `GM_WORKSPACES_DIR`. Set it only when the self-inspection can't find it. |
| `GM_SANDBOX_TOOLS_DIR` | `<GM_DATA_DIR>/sandbox-tools` | `/opt/gm-tools` | Where graph-manager puts the engine and provider CLIs that sandboxes mount read-only |
| `GM_PUBLIC_URL` | the internal URL | same | The base URL that `graph-execution --sandbox` prints in a terminal (set it when graph-manager is behind a proxy) |
| `DOCKER_GID` | | compose only | The group id of the Docker socket (`stat -c %g /var/run/docker.sock`), added to graph-manager's groups so UID 1000 can use it |

`<GM_DATA_DIR>/views/` keeps a snapshot of each run's view while its page is live, so finished runs keep task times, line counts and review results.

## First steps

1. **Log in** with `GM_PASSWORD`. You land on **Runs**.
2. **Settings:** paste a GitHub personal access token with the `repo` scope, or a GitLab token with the `api` scope (plus the base URL for self-hosted GitLab). graph-manager verifies the token and never sends it back to the browser; a connected card shows the login, the API URL and the token's last 4 characters.
3. **Workspaces → Clone repository:** search a repository and clone it. The clone runs in the background with a progress bar, and a toast offers **Open terminal** when it is done.
4. **Terminals:** open a terminal in the workspace and run `claude`. Log in once; the login is kept in `/data/home` and survives restarts.

   At startup graph-manager copies its engine's skills (`to-spec`, `to-tasks`, `run-graph`) into `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and `~/.agents/skills`, so the agents in its terminals use the skills that match its engine, whatever version a workspace checks in under `.claude/skills`. Each copy carries a `.graph-manager` file with a hash of its content and is replaced when the engine's skill changes. A skill folder you made yourself (without that file) is never replaced; the server log says so.

   A run an agent starts from a terminal shows up in the UI by itself: a toast with **Open** on every page, and on the Terminals page it opens in the next free pane when it belongs to the focused terminal's workspace.
5. Plan the work in `claude`: write the spec with the `to-spec` skill, then the tasks with `to-tasks`. While the agent writes the spec (`docs/prd/<name>.md`), it opens in a floating pane next to the terminal and updates live; read it there and answer the agent in the terminal, with changes or your approval. Then start the run with `graph-execution <tasks-folder> --spec <spec> --web` in the terminal, or with **Start run** (`s`) on the Runs page. To run it in its own container, see [Sandboxed runs](#sandboxed-runs).
6. **Runs:** follow the run on the dashboard. While it is live, its detail page embeds the run's own page (proxied under `/runs/<workspace>/<run-id>/view/`); afterwards it shows the phase cards, the task graph and the task table.
7. Once the run is `applied`, use **Create PR** (or **Create MR** on GitLab) to commit, push and open the PR or MR. The run's spec moves to `docs/prd/done/` in that commit.

## Sandboxed runs

A sandboxed run runs the engine and its agents in a Docker container of its own, one per run (`gm-run-<run-id>`). It is off by default. Turn it on with **Run in sandbox** in **Start run** (remembered per workspace), or add `--sandbox` to `graph-execution` in a graph-manager terminal; the command prints the run's URL (based on `GM_PUBLIC_URL`) and returns.

What the container sees:

- only the run's workspace, mounted read-write at the same path as in graph-manager;
- the engine and the provider CLIs, read-only from `/opt/gm-tools` (graph-manager fills that folder at startup);
- a copy of the provider's login files in `/home/sandbox` (in the container's own layer, deleted with the container; it is not a tmpfs, because a tmpfs would hide the files copied in before the container starts):

  | Provider | Files copied |
  | --- | --- |
  | `claude` | `~/.claude/.credentials.json`, `~/.claude.json` |
  | `codex` | `~/.codex/auth.json`, `~/.codex/config.toml` |
  | `opencode` | `~/.local/share/opencode/auth.json`, `~/.config/opencode/` |
  | `qwen` | `~/.qwen/oauth_creds.json`, `~/.qwen/settings.json` |

- as environment variables: the provider API keys (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`), the git identity (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) and `GRAPH_EXECUTION_*`.

What it never sees: `/data` (the forge tokens and the session secret), the other workspaces, and any `GM_*` variable. Push and **Create PR** stay on the server.

The container runs as the owner (uid:gid) of the workspace folder, with `no-new-privileges` and an init process.

All sandboxes share the `gm-sandbox` network. Each run page requires a per-run secret (`GRAPH_EXECUTION_WEB_TOKEN`, sent only by graph-manager's proxy), so an agent in one sandbox can't read or drive another sandbox's run page.

- **Image:** `GM_SANDBOX_IMAGE`, else graph-manager's own image when it runs in Docker, else `node:24.22.1-bookworm` (node and git); set one per workspace in **Workspaces → Settings → Sandbox image**. It needs node 20+ and git, for example an image based on `python:3.12-bookworm` with node installed. A missing image is pulled when the run starts.
- **Outside Docker** (for example `npm start` on macOS): Docker Desktop can't route the host to container IPs, so each sandbox publishes its page port on `127.0.0.1` (a free port Docker picks) and the proxy connects there.
- **A sandbox that is stopped or removed** outside graph-manager (for example `docker rm -f`) shows as **interrupted**, not running, and can be resumed. The same goes for a run whose process was killed.
- **Limits:** **Settings → Sandbox** sets the CPUs (default 2), the memory (default 4096 MB) and the PIDs (default 2048) of each container.
- **The run page** works as for any run: it is proxied from the container, with abort, retry and human review.
- **Resume:** a sandboxed run resumes only in a sandbox: **Resume** on the run page, or `graph-execution --resume --run <id> --sandbox` in a terminal. A plain `--resume` exits 2 with a hint.
- **Stop sandbox** on the run page kills the container. Otherwise graph-manager removes the container when the engine exits (it does not use Docker's auto-remove, so that it can read the logs of a sandbox that failed to start). A container that exits while graph-manager is down is removed at its next start.
- When Docker isn't reachable, **Run in sandbox** is disabled with the reason, and `--sandbox` exits 2.

Sandboxes need Docker 26 or newer (Engine API 1.45, for mounting a subfolder of a volume). With an older daemon, **Run in sandbox** is disabled with that reason.

Setup, with Docker Compose from `apps/graph-manager`:

```bash
DOCKER_GID=$(stat -c %g /var/run/docker.sock) GM_PASSWORD='choose-a-password' docker compose up --build
```

The compose file mounts the host's Docker socket, adds its group to graph-manager's and mounts the `gm-tools` volume at `/opt/gm-tools`. With plain Docker, add `-v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)" -v gm-tools:/opt/gm-tools`.

Security:

- A sandbox is a container, not a VM: it shares the host's kernel.
- The network is open: there is no egress filtering.
- The Docker socket gives graph-manager root-equivalent access to the host. Remove the socket and `group_add` lines from the compose file to turn sandboxes off.

Not supported:

- sandboxed terminals;
- egress filtering;
- Kubernetes or OpenShift pods, rootless Docker, Sysbox or gVisor;
- sandboxed `suite` runs;
- images built from a repository's Dockerfile;
- Docker Desktop on macOS when graph-manager itself runs outside Docker (container IPs are not reachable from the macOS host; graph-manager in Docker on macOS works).

## The app

The left nav has, from top to bottom, a **status block** (runs live, runs failed; each count opens Runs pre-filtered), **Runs**, **Terminals**, **Workspaces** and **Settings** with their badges (the Terminals badge is the number of terminals), then **Jump to… Ctrl K**, the theme button and **Log out**. Below 1100 px, and on the detail page of a live run, the nav collapses to a 56 px icon rail. Every screen polls the server every 2 s, keeps the last data on screen when a poll fails, and shows "Can't reach the server…" after 3 failures in a row.

- **Runs** (home): cards for live, failed and ready-for-PR runs; the runs grouped by workspace, sorted by attention (failed and live first, then ready for PR). **Start run** opens a drawer with the workspace, tasks folder, spec, provider, the run options (human review, merge, model, concurrency, and under **More options** attempts, fix passes, validation rounds, when to validate, parallel validation, idle timeout and extra arguments) and the command it will run. An option left at "Repo default" sends no flag, so the repo config or the engine default decides. The preview prints every flag on its own line, in the order the server passes them; an invalid number shows an error under its field and disables **Start run**. The last choices are remembered per workspace on the server (`runDefaults` in `graph-manager.json`).
- **Run detail:** the live run page in an iframe while it runs (it falls back to the static view if the page stops answering); after it, the Validation, Review + live test, Fixer and Landed cards, the layered task graph and the task table with attempts, elapsed times and line counts, and the Pull request panel. Create PR shows each step (checkout, commit, push, create) as it runs, then the PR link. Its commit also moves the run's spec to `docs/prd/done/<name>.md` (the commit step says `spec → docs/prd/done/<name>.md`), unless it is already there or outside the workspace.
- **Terminals:** a sidebar with one section per workspace and the workspaces root, where each terminal shows its title and foreground process (`bash`, `node`, `claude`) but no working/idle status; tabs; and 1, 2 or 4 split panes. A pane holds a terminal or a run's live page (the run chip on a terminal opens it). An exited terminal can be restarted in place. Closing a terminal asks first only while a program other than a plain shell runs in it. Under 900 px the sidebar is a drawer and one pane fills the page.
  - **Spec pane:** when a spec (`docs/prd/*.md`, not `docs/prd/done/`) is created or changes in the workspace of the focused terminal, a floating pane opens over the panes and shows it live: rendered Markdown with ```` ```mermaid ```` blocks drawn as diagrams, updated within a few seconds of each save. Specs that already existed when the page loaded open it only once they change. Drag it by its head, resize it from its corner, switch specs with its select, and close it with × or `Esc`; its position and size are remembered in this browser. A `spec <name>` chip on the terminal's pane head reopens it on the newest spec. Under 900 px it fills the main area. There is no status or Approve button: you answer the agent in the terminal.
- **Workspaces:** each clone with its forge, branch, clean/dirty state and runs, with Open terminal, Runs and Delete (disabled while a run is live in it).
- **Settings:** the GitHub and GitLab cards, and **Appearance**: System, Light or Dark, saved in this browser only.

### Reviewers

graph-manager keeps one global list of reviewers (no per-workspace setting) in `graph-manager.json`, seeded with the engine's built-in **Code review** (`code`) and **Live test** (`tester`). On startup and after every change it writes the enabled ones to `<dataDir>/reviewers.json` (mode 600) and passes that file as `GRAPH_EXECUTION_REVIEWERS` to every run it starts: **Start run** and any `graph-execution … --web` typed in a terminal. A run copies the file to its run dir when it starts, so runs already going keep their reviewers. Validation uses the engine's schema, so graph-manager and the engine accept the same reviewers.

| Route | What it does |
| --- | --- |
| `GET /api/reviewers` | The list (disabled ones included), the built-in ids, the providers and the file path |
| `POST /api/reviewers` | Adds a reviewer at the end; `repoFile` defaults to `<ID>_REVIEW.md` |
| `PUT /api/reviewers/:id` | Replaces a reviewer in place; its `id` cannot change |
| `DELETE /api/reviewers/:id` | Deletes one; `tester` can only be disabled |
| `POST /api/reviewers/reset/:id` | Restores the built-in instructions of `code` or `tester` (re-adds `code` if deleted) |

### Keyboard

xterm.js captures every key while a terminal has focus, so app shortcuts inside a terminal take the `Ctrl Space` prefix, as in tmux. Outside terminals, single keys work directly. graph-manager uses Ctrl rather than ⌘, because ⌘T, ⌘W and ⌘N belong to the browser.

| Keys | Action |
| --- | --- |
| `Ctrl K` | Command palette: jump to any run, terminal or workspace |
| `g r` · `g t` · `g w` · `g s` | Go to Runs, Terminals, Workspaces, Settings |
| `j` / `k` · `Enter` | Move through table rows and sidebar items, open |
| `Ctrl Space`, then… | Terminal prefix: `n` new · `x` close · `1`–`4` focus pane · `\|` split |
| `/` | Focus the filter or search on the current screen |
| `Esc` | Close drawer or dialog; return focus to where it was |
| `s` · `Ctrl Enter` | Runs: open Start run · submit it |
| `p` | Runs: Create PR on the focused ready row |

## Local development

From the repository root:

```bash
npm ci
npm run build -w graph-execution && npm run build -w graph-manager
GM_PASSWORD=pw npm start -w graph-manager        # http://127.0.0.1:7420
```

For the UI with hot reload, keep the server running and start `npx vite` in `apps/graph-manager`. Vite proxies `/api` and `/runs` to port 7420.

The checks: `npm run typecheck && npm run lint && npm test -w graph-manager`. To drive the whole loop in a real browser (fake forge, clone, a fake run, Create PR), run `bash apps/graph-manager/scripts/ui-smoke.sh` from the repository root; it needs [agent-browser](https://www.npmjs.com/package/agent-browser) and is not part of `npm test`. `TESTING.md` has the manual UI checklist.

## Security

- Agents run with full permissions inside the container, and the terminals are shells. Anyone who can log in can run any command there and read the tokens. Protect the port: bind it to `127.0.0.1`, or put it behind a VPN or a TLS reverse proxy, and use a strong `GM_PASSWORD`.
- Tokens are stored in `/data/graph-manager.json` with mode 600. Clones use the token without writing it into `.git/config`.
- Everything except `/healthz`, the login and the static UI is behind the login (`/api/*` and the proxied run pages).

## Limitations

- One user per deployment (a single admin password).
- Terminals are plain PTYs: they don't survive a restart of the server or the container. Runs started with `--web` keep running detached, and the files in `/workspaces` stay.
