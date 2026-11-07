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
| `GM_DATA_DIR` | `~/.graph-manager` | `/data` | The state: tokens and the session secret (`graph-manager.json`), and the `bin/` shim |
| `GM_WORKSPACES_DIR` | `~/graph-manager-workspaces` | `/workspaces` | Where repositories are cloned, as `<forge>/<owner>/<repo>` |
| `GM_GITHUB_API_URL` | `https://api.github.com` | same | The GitHub API base URL (for GitHub Enterprise) |
| `GM_GRAPH_EXECUTION_BIN` | the workspace's `graph-execution` | `/app/packages/graph-execution/dist/cli.js` | The graph-execution CLI used by terminals and the **Start run** form |
| `HOME` | | `/data/home` | Keeps the `claude` login and git config on the data volume |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | git config | `graph-manager`, `graph-manager@localhost` | The identity graph-execution and **Create PR** commit with. Override them with `-e`. |
| `ANTHROPIC_API_KEY` | | | Optional. Lets `claude` run without an interactive login. |

`<GM_DATA_DIR>/views/` keeps a snapshot of each run's view while its page is live, so finished runs keep task times, line counts and review results.

## First steps

1. **Log in** with `GM_PASSWORD`. You land on **Runs**.
2. **Settings:** paste a GitHub personal access token with the `repo` scope, or a GitLab token with the `api` scope (plus the base URL for self-hosted GitLab). graph-manager verifies the token and never sends it back to the browser; a connected card shows the login, the API URL and the token's last 4 characters.
3. **Workspaces → Clone repository:** search a repository and clone it. The clone runs in the background with a progress bar, and a toast offers **Open terminal** when it is done.
4. **Terminals:** open a terminal in the workspace and run `claude`. Log in once; the login is kept in `/data/home` and survives restarts.
5. Plan the work in `claude`: write the spec with the `to-spec` skill, then the tasks with `to-tasks`. While the agent writes the spec (`docs/prd/<name>.md`), it opens in a floating pane next to the terminal and updates live; read it there and answer the agent in the terminal, with changes or your approval. Then start the run with `graph-execution <tasks-folder> --spec <spec> --web` in the terminal, or with **Start run** (`s`) on the Runs page.
6. **Runs:** follow the run on the dashboard. While it is live, its detail page embeds the run's own page (proxied under `/runs/<workspace>/<run-id>/view/`); afterwards it shows the phase cards, the task graph and the task table.
7. Once the run is `applied`, use **Create PR** (or **Create MR** on GitLab) to commit, push and open the PR or MR. The run's spec moves to `docs/prd/done/` in that commit.

## The app

The left nav has, from top to bottom, a **status block** (runs live, runs failed; each count opens Runs pre-filtered), **Runs**, **Terminals**, **Workspaces** and **Settings** with their badges (the Terminals badge is the number of terminals), then **Jump to… Ctrl K**, the theme button and **Log out**. Below 1100 px, and on the detail page of a live run, the nav collapses to a 56 px icon rail. Every screen polls the server every 2 s, keeps the last data on screen when a poll fails, and shows "Can't reach the server…" after 3 failures in a row.

- **Runs** (home): cards for live, failed and ready-for-PR runs; the runs grouped by workspace, sorted by attention (failed and live first, then ready for PR). **Start run** opens a drawer with the workspace, tasks folder, spec, provider and the command it will run.
- **Run detail:** the live run page in an iframe while it runs (it falls back to the static view if the page stops answering); after it, the Validation, Review + live test, Fixer and Landed cards, the layered task graph and the task table with attempts, elapsed times and line counts, and the Pull request panel. Create PR shows each step (checkout, commit, push, create) as it runs, then the PR link. Its commit also moves the run's spec to `docs/prd/done/<name>.md` (the commit step says `spec → docs/prd/done/<name>.md`), unless it is already there or outside the workspace.
- **Terminals:** a sidebar with one section per workspace and the workspaces root, where each terminal shows its title and foreground process (`bash`, `node`, `claude`) but no working/idle status; tabs; and 1, 2 or 4 split panes. A pane holds a terminal or a run's live page (the run chip on a terminal opens it). An exited terminal can be restarted in place. Closing a terminal asks first only while a program other than a plain shell runs in it. Under 900 px the sidebar is a drawer and one pane fills the page.
  - **Spec pane:** when a spec (`docs/prd/*.md`, not `docs/prd/done/`) is created or changes in the workspace of the focused terminal, a floating pane opens over the panes and shows it live: rendered Markdown with ```` ```mermaid ```` blocks drawn as diagrams, updated within a few seconds of each save. Specs that already existed when the page loaded open it only once they change. Drag it by its head, resize it from its corner, switch specs with its select, and close it with × or `Esc`; its position and size are remembered in this browser. A `spec <name>` chip on the terminal's pane head reopens it on the newest spec. Under 900 px it fills the main area. There is no status or Approve button: you answer the agent in the terminal.
- **Workspaces:** each clone with its forge, branch, clean/dirty state and runs, with Open terminal, Runs and Delete (disabled while a run is live in it).
- **Settings:** the GitHub and GitLab cards, and **Appearance**: System, Light or Dark, saved in this browser only.

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
