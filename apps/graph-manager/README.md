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

## First steps

1. **Log in** with `GM_PASSWORD`.
2. **Settings:** paste a GitHub personal access token with the `repo` scope, or a GitLab token with the `api` scope (plus the base URL for self-hosted GitLab). graph-manager verifies the token and never sends it back to the browser.
3. **Workspaces:** pick a repository and clone it.
4. **Terminals:** open a terminal in the workspace and run `claude`. Log in once; the login is kept in `/data/home` and survives restarts.
5. Plan the work with the `to-tasks` skill in `claude`. Then start the run with `graph-execution <tasks-folder> --spec <spec> --web` in the terminal, or with the **Start run** form on the Runs page.
6. **Runs:** follow the run on the dashboard. While it is live, the run page is proxied under `/runs/<workspace>/<run-id>/view/`.
7. Once the run is `applied`, use **Create PR** to commit, push and open the PR or MR.

## Local development

From the repository root:

```bash
npm ci
npm run build -w graph-execution && npm run build -w graph-manager
GM_PASSWORD=pw npm start -w graph-manager        # http://127.0.0.1:7420
```

For the UI with hot reload, keep the server running and start `npx vite` in `apps/graph-manager`. Vite proxies `/api` and `/runs` to port 7420.

The checks: `npm run typecheck && npm run lint && npm test -w graph-manager`.

## Security

- Agents run with full permissions inside the container, and the terminals are shells. Anyone who can log in can run any command there and read the tokens. Protect the port: bind it to `127.0.0.1`, or put it behind a VPN or a TLS reverse proxy, and use a strong `GM_PASSWORD`.
- Tokens are stored in `/data/graph-manager.json` with mode 600. Clones use the token without writing it into `.git/config`.
- Everything except `/healthz`, the login and the static UI is behind the login (`/api/*` and the proxied run pages).

## Limitations

- One user per deployment (a single admin password).
- Terminals are plain PTYs: they don't survive a restart of the server or the container. Runs started with `--web` keep running detached, and the files in `/workspaces` stay.
