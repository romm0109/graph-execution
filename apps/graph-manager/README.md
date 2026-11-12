# graph-manager

graph-manager is a small web service around the [graph-execution](../../packages/graph-execution/README.md) engine. From one browser tab you can:

- connect GitHub or GitLab with a personal access token,
- clone repositories into workspaces,
- open terminals in those workspaces to run `claude` and `graph-execution`,
- follow every run on a dashboard, and
- open a pull request (or merge request) from an applied run.

It ships in two ways, built from the same code: inside the [`graph-execution`](https://www.npmjs.com/package/graph-execution) npm package, started with `graph-execution manager`, and as one Docker image that runs the same on a laptop, a VM or OpenShift.

## Quick start

### From npm

```bash
npm install -g graph-execution
graph-execution manager
```

It needs Node.js 20 or later and git. No clone of this repository and no Docker are needed (Docker is only for [sandboxed runs](#sandboxed-runs)). On Linux, `npm install` compiles `node-pty` and needs Python 3, make and a C++ compiler (`build-essential` on Debian and Ubuntu); macOS and Windows get a prebuilt binary.

The command prints the address and the password for the login page, then opens the browser:

```text
graph-manager listening on http://127.0.0.1:7420
Password: kq3ZJ0cXo1b9mVd2wTn5Hs8yLr4uAe7P (saved in /home/ada/.graph-manager/password)
```

The password is generated on the first start and saved in `<data dir>/password`, so the next start prints the same one. With `GM_PASSWORD` set, that password is used, nothing is saved, and the line is `Password: from GM_PASSWORD`.

| Flag | Meaning |
| --- | --- |
| `--port <n>` | The port to listen on (default: `$GM_PORT`, else 7420; `0` picks a free one) |
| `--host <host>` | The address to listen on (default: `$GM_HOST`, else 127.0.0.1) |
| `--data-dir <dir>` | Where graph-manager keeps its data (default: `$GM_DATA_DIR`, else `~/.graph-manager`) |
| `--workspaces-dir <dir>` | Where repositories are cloned (default: `$GM_WORKSPACES_DIR`, else `~/graph-manager-workspaces`) |
| `--no-open` | Do not open the browser. `GRAPH_EXECUTION_NO_OPEN=1` does the same; it is not opened either over SSH or when the output is not a terminal. |

The command stays in the foreground until Ctrl+C (exit code 0). When the port is taken it exits 1 with `port <n> is already in use: pass --port or set GM_PORT`. Everything else is set with the variables in [Configuration](#configuration).

### With Docker

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

The image contains git, the built `graph-execution` CLI on `PATH` and the Claude Code CLI (`claude`). It starts the server with `graph-execution manager --no-open`. The compose file requires `GM_PASSWORD`; with plain Docker and no `GM_PASSWORD`, the password is generated, saved in `/data/password` and printed in the container's log (`docker logs graph-manager`). It runs as a non-root user. `/data` and `/workspaces` are writable by group 0, so it also runs under OpenShift's arbitrary UIDs. `GET /healthz` answers `{"ok":true}` without logging in, for the Docker `HEALTHCHECK` and for liveness and readiness probes.

To check an image end to end (build, health, UI, login, the CLIs and a writable `/data`), run `bash apps/graph-manager/scripts/docker-smoke.sh` from the repository root. It needs Docker and is not part of `npm test`.

## Configuration

A flag of `graph-execution manager` overrides its variable.

| Env var | Flag | Default (outside Docker) | In the image | Meaning |
| --- | --- | --- | --- | --- |
| `GM_PASSWORD` | | generated, saved in `<GM_DATA_DIR>/password` | same (required by the compose file) | The admin password for the login page. Optional: when it is unset or blank, the password is read from `<GM_DATA_DIR>/password`; when that file is missing or empty, a random one (24 bytes, base64url) is generated and saved there with mode 600. A password set here is never written to the file or printed. |
| `GM_PORT` | `--port` | `7420` | `7420` | The port to listen on |
| `GM_HOST` | `--host` | `127.0.0.1` | `0.0.0.0` | The address to listen on |
| `GM_DATA_DIR` | `--data-dir` | `~/.graph-manager` | `/data` | The state: the generated password (`password`), tokens, the session secret and the saved Start run choices (`graph-manager.json`), and the `bin/` shims |
| `GM_WORKSPACES_DIR` | `--workspaces-dir` | `~/graph-manager-workspaces` | `/workspaces` | Where repositories are cloned, as `<forge>/<owner>/<repo>` |
| `GRAPH_EXECUTION_NO_OPEN` | `--no-open` | | | `1` stops `graph-execution manager` from opening the browser |
| `GM_GITHUB_API_URL` | | `https://api.github.com` | same | The GitHub API base URL (for GitHub Enterprise) |
| `GM_GRAPH_EXECUTION_BIN` | | the CLI that ran `graph-execution manager`; with `npm start`, the workspace's `graph-execution` | `/app/packages/graph-execution/dist/cli.js` | The graph-execution CLI used by terminals and the **Start run** form |
| `HOME` | | | `/data/home` | Keeps the `claude` login and git config on the data volume |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | | git config | `graph-manager`, `graph-manager@localhost` | The identity graph-execution and **Create PR** commit with. Override them with `-e`. |
| `ANTHROPIC_API_KEY` | | | | Optional. Lets `claude` run without an interactive login. |
| `GM_DOCKER_SOCKET` | | found, see the meaning | `/var/run/docker.sock` | The Docker Engine API endpoint graph-manager starts sandboxes through: a unix socket path or a Windows named pipe, used as given. When unset, the first of: `DOCKER_HOST` when it is `unix://<path>` or `npipe://<pipe>`; on Windows `//./pipe/docker_engine`; else the first that exists of `/var/run/docker.sock`, `~/.docker/run/docker.sock` and `~/.docker/desktop/docker.sock` (`/var/run/docker.sock` when none does). |
| `DOCKER_HOST` | | | | Read only when `GM_DOCKER_SOCKET` is unset, and only a `unix://` or `npipe://` value. A `tcp://` or `ssh://` value is ignored: a remote daemon can't see the workspaces folder. |
| `GM_SANDBOX_IMAGE` | | `node:24.22.1-bookworm` | same | The base (Node) image of the default recipe |
| `GM_SANDBOX_WORKSPACES_SOURCE` | | found by inspecting graph-manager's container | same | The Docker volume name or host path behind `GM_WORKSPACES_DIR`. Set it only when the self-inspection can't find it. On a Windows host a Windows path (`D:\ws`) is a host path. |
| `GM_SANDBOX_TOOLS_DIR` | | `<GM_DATA_DIR>/sandbox-tools` | `/opt/gm-tools` | Where graph-manager puts the engine and provider CLIs that sandboxes mount read-only |
| `GM_PUBLIC_URL` | | the internal URL | same | The base URL that `graph-execution --sandbox` prints in a terminal (set it when graph-manager is behind a proxy) |
| `DOCKER_GID` | | | compose only | The group id of the Docker socket (`stat -c %g /var/run/docker.sock`), added to graph-manager's groups so UID 1000 can use it |

`<GM_DATA_DIR>/views/` keeps a snapshot of each run's view while its page is live, so finished runs keep task times, line counts and review results.

## First steps

1. **Log in** with the password printed at startup (or your `GM_PASSWORD`). You land on **Runs**.
2. **Settings:** paste a GitHub personal access token with the `repo` scope, or a GitLab token with the `api` scope (plus the base URL for self-hosted GitLab). graph-manager verifies the token and never sends it back to the browser; a connected card shows the login, the API URL and the token's last 4 characters.
3. **Workspaces → Clone repository:** search a repository and clone it. The clone runs in the background with a progress bar, and a toast offers **Open terminal** when it is done.
4. **Terminals:** click **Claude Code** to open a terminal in the workspace with Claude Code running and connected to graph-manager's tools (or open a **Plain terminal** and run `claude`). See [Agents and tools](#agents-and-tools). Log in once; the login is kept in `/data/home` and survives restarts.

   At startup graph-manager copies its engine's skills (`to-spec`, `to-tasks`, `run-graph`) into `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and `~/.agents/skills`, so the agents in its terminals use the skills that match its engine, whatever version a workspace checks in under `.claude/skills`. Each copy carries a `.graph-manager` file with a hash of its content and is replaced when the engine's skill changes. A skill folder you made yourself (without that file) is never replaced; the server log says so.

   A run an agent starts from a terminal shows up in the UI by itself: a toast with **Open** on every page, and on the Terminals page it opens in the next free pane when it belongs to the focused terminal's workspace.
5. Plan the work in `claude`: write the spec with the `to-spec` skill, then the tasks with `to-tasks`. While the agent writes the spec (`docs/prd/<name>.md`), it opens in a floating pane next to the terminal and updates live; read it there and answer the agent in the terminal, with changes or your approval. When `to-tasks` is done, an agent opened with an agent button calls `open_start_run`, and the **Start run** form opens next to the terminal, prefilled; review it and click **Start run**. Otherwise start the run with `graph-execution <tasks-folder> --spec <spec> --web` in the terminal, or with **Start run** (`s`) on the Runs page. To run it in its own container, see [Sandboxed runs](#sandboxed-runs).
6. **Runs:** follow the run on the dashboard. While it is live, its detail page embeds the run's own page (proxied under `/runs/<workspace>/<run-id>/view/`); afterwards it shows the phase cards, the task graph and the task table.
7. Once the run is `applied`, use **Create PR** (or **Create MR** on GitLab) to commit, push and open the PR or MR. The run's spec moves to `docs/prd/done/` in that commit.

## Sandboxed runs

A sandboxed run runs the engine and its agents in a Docker container of its own, one per run (`gm-run-<run-id>`). It is off by default. Turn it on with **Run in sandbox** in **Start run** (remembered per workspace), or add `--sandbox` to `graph-execution` in a graph-manager terminal; the command prints the run's URL (based on `GM_PUBLIC_URL`) and returns.

What the container sees:

- only the run's workspace, mounted read-write at the same path as in graph-manager (at `/workspaces/<forge>/<owner>/<repo>` when graph-manager runs on Windows, see [Platforms](#platforms));
- the engine, read-only from `/opt/gm-tools` (graph-manager fills that folder at startup), and the provider CLIs, read-only from `/opt/gm-clis` (see [The sandbox images](#the-sandbox-images));
- a copy of the provider's login files in `/home/sandbox` (in the container's own layer, deleted with the container; it is not a tmpfs, because a tmpfs would hide the files copied in before the container starts):

  | Provider | Files copied |
  | --- | --- |
  | `claude` | `~/.claude/.credentials.json`, `~/.claude.json` |
  | `codex` | `~/.codex/auth.json`, `~/.codex/config.toml` |
  | `opencode` | `~/.local/share/opencode/auth.json`, `~/.config/opencode/` |
  | `qwen` | `~/.qwen/oauth_creds.json`, `~/.qwen/settings.json` |

- as environment variables: the provider API keys (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`), the git identity (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) and `GRAPH_EXECUTION_*`.

What it never sees: `/data` (the forge tokens and the session secret), the other workspaces, and any `GM_*` variable. Push and **Create PR** stay on the server.

The container runs as the owner (uid:gid) of the workspace folder (as `1000:1000` when graph-manager runs on Windows), with `no-new-privileges` and an init process.

All sandboxes share the `gm-sandbox` network. Each run page requires a per-run secret (`GRAPH_EXECUTION_WEB_TOKEN`, sent only by graph-manager's proxy), so an agent in one sandbox can't read or drive another sandbox's run page.

- **Image:** by default the image graph-manager builds from the global recipe in **Settings → Sandbox**. A workspace can use its own recipe or a ready-made image instead (**Workspaces → Settings → Sandbox image**, see [The sandbox images](#the-sandbox-images)). A ready-made image needs node 20+, git and glibc (Debian, Ubuntu…; not Alpine), for example an image based on `python:3.12-bookworm` with node installed; it is pulled when the run starts if it is missing.
- **Outside Docker** (`graph-execution manager` or `npm start`, on any OS): Docker Desktop can't route the host to container IPs, so each sandbox publishes its page port on `127.0.0.1` (a free port Docker picks) and the proxy connects there.
- **A sandbox that is stopped or removed** outside graph-manager (for example `docker rm -f`) shows as **interrupted**, not running, and can be resumed. The same goes for a run whose process was killed.
- **Limits:** **Settings → Sandbox** sets the CPUs (default 2), the memory (default 4096 MB) and the PIDs (default 2048) of each container.
- **The run page** works as for any run: it is proxied from the container, with abort, retry and human review.
- **Resume:** a sandboxed run resumes only in a sandbox: **Resume** on the run page, or `graph-execution --resume --run <id> --sandbox` in a terminal. A plain `--resume` exits 2 with a hint.
- **Stop sandbox** on the run page kills the container. Otherwise graph-manager removes the container when the engine exits (it does not use Docker's auto-remove, so that it can read the logs of a sandbox that failed to start). A container that exits while graph-manager is down is removed at its next start.
- When Docker isn't reachable, **Run in sandbox** is disabled with the reason, which names the endpoint that was tried (`Docker is not reachable at <endpoint>: …`, on macOS and Windows followed by `; is Docker Desktop running?`), and `--sandbox` exits 2. graph-manager itself works as usual.

Sandboxes need Docker 26 or newer (Engine API 1.45, for mounting a subfolder of a volume). With an older daemon, **Run in sandbox** is disabled with that reason.

#### Platforms

Sandboxes need a local Docker daemon that runs Linux containers. graph-manager finds it without any setting (the order is in [Configuration](#configuration), `GM_DOCKER_SOCKET`).

| Platform | Docker endpoint | Workspace path in the sandbox | Container user | How it was checked |
| --- | --- | --- | --- | --- |
| Linux | `/var/run/docker.sock` | the same path as on the host | the owner of the workspace folder | automated tests and a real run |
| macOS with Docker Desktop | `/var/run/docker.sock` or `~/.docker/run/docker.sock` | the same path as on the host | the owner of the workspace folder | unit tests and CI only, not run against a real Docker Desktop |
| Windows with Docker Desktop in Linux-containers mode | `//./pipe/docker_engine` | `/workspaces/<rel>` (`<rel>` is the workspace's path under the workspaces folder, `<forge>/<owner>/<repo>`) | `1000:1000` | unit tests and CI only, not run against a real Docker Desktop |

Windows:

- A Windows path can't be a mount target in a Linux container, so the workspace is mounted at `/workspaces/<rel>`. graph-manager translates the paths it hands to the engine (the working directory, the tasks folder, `--spec`, `--reviewers`, the ready file) and translates the tasks folder and spec path of the run back when it reads them.
- Git settings are passed into the container as `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`: `safe.directory=*` and `core.filemode=false` (Docker Desktop shows the mounted files as owned by another user and as executable), and `core.autocrlf` with the value `git config --get core.autocrlf` gives in the workspace on the host (not passed when it is unset).
- Windows containers are refused: **Run in sandbox** is disabled with `Docker is running Windows containers: switch Docker Desktop to Linux containers`.
- The workspaces folder must be on a drive Docker Desktop can share with containers.
- The run's `state.json` and its git worktree records hold `/workspaces/<rel>/…` paths, so the run page shows container paths.
- A `git worktree prune` on the host drops the worktree records of a paused sandboxed run, because their paths don't exist on the host. A non-sandboxed run in the same workspace runs one too. Finish or stop a paused sandboxed run before you start another run in that workspace.

macOS:

- The workspaces folder must be under a folder Docker Desktop shares with containers. `/Users` is shared by default, so the default `~/graph-manager-workspaces` works.
- A provider's login is copied from the files in the table above. Where a provider CLI keeps its login in the macOS Keychain instead of a file, the copy does not hold the login: the agents in the sandbox are not logged in, or, when none of the provider's files exists, the start fails with `no <provider> login to copy into the sandbox: …`. Set that provider's API key or token variable in graph-manager's environment instead (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for `claude`, `OPENAI_API_KEY` for `codex` and `qwen`, either key for `opencode`).

#### The sandbox images

graph-manager builds two images on the Docker daemon itself, so they are Linux builds for the daemon's CPU whatever OS graph-manager runs on (a Mac included). It no longer copies the CLIs from its own PATH, and does not need them installed.

| Image | What it holds | Rebuilt when |
| --- | --- | --- |
| `gm-sandbox-clis:<graph-manager version>` | `claude`, `codex`, `opencode` and `qwen`, the latest versions at build time, installed with `npm install -g` into `/opt/gm-clis` | graph-manager's version changes, or **Rebuild** |
| `gm-sandbox:<12 hex of the Dockerfile's sha256>` | a sandbox image, from the global recipe or a workspace's own recipe | that recipe's Dockerfile changes, or **Rebuild** |

The CLIs reach a sandbox through the named volume `gm-clis-<12 hex of the CLIs image id>`, filled from the CLIs image and mounted read-only at `/opt/gm-clis` in every sandbox, the default image or a workspace image. The sandbox's `PATH` is `/opt/gm-tools/bin:/opt/gm-clis/bin:` followed by the image's own `PATH`, so tools an image puts on its `PATH` with `ENV` (Go, Cargo) are found. The CLIs are glibc builds: sandbox images must be glibc-based (Debian, Ubuntu…), not Alpine.

**The recipe** (**Settings → Sandbox → Image**) is a Node base image, 7 opt-in toolchains and extra Dockerfile lines. The default is Node only:

```dockerfile
FROM node:24.22.1-bookworm
```

Each toolchain is a row with a checkbox (all unchecked by default), an editable Dockerfile snippet with **Reset to default**, and **Move up** / **Move down**: the Dockerfile follows the rows' order. `<apt>` below stands for `RUN apt-get update && apt-get install -y --no-install-recommends <packages> && rm -rf /var/lib/apt/lists/*`.

- **Python**: `<apt>` with `python3 python3-pip python3-venv pipx`
- **Java**: `<apt>` with `default-jdk-headless maven gradle`
- **Go**: `COPY --from=golang:1-bookworm /usr/local/go /usr/local/go` and `ENV PATH=/usr/local/go/bin:$PATH` (bookworm's Go is too old)
- **Rust**: `/usr/local/cargo` and `/usr/local/rustup` copied from `rust:1-bookworm`, with `RUSTUP_HOME`, `CARGO_HOME` and `PATH` set (bookworm's Rust is too old)
- **Ruby**: `<apt>` with `ruby-full`
- **PHP**: `<apt>` with `php-cli composer`
- **C/C++**: `<apt>` with `build-essential pkg-config cmake`

The Dockerfile is `FROM <base>`, then for each checked toolchain in order a `# <Name>` comment and its snippet, then the **Extra Dockerfile lines**, for anything else. Snippets and extra lines are kept verbatim (only `\r` and trailing blank lines are dropped), so heredocs keep their indentation. None of them may contain a `FROM` line (a second `FROM` starts a new image and drops the first): add a tool from another image with `COPY --from=<image> <dir> <dir>`. The **Dockerfile** preview updates as you edit (300 ms after the last change) and shows the validation error, without saving.

`GM_SANDBOX_IMAGE`, when set, is the **base image** of the default recipe, not the sandbox image itself. The toolchain snippets run on top of it, so it must be Debian-based with apt (an Alpine base fails the build).

**Per workspace** (**Workspaces → Settings → Sandbox image**), a workspace picks one image source:

- **Global recipe** (the default): the image built from Settings → Sandbox.
- **Own recipe**: a full copy of the global recipe, taken when you first choose it, edited with the same editor (its own Node base image, toolchains, snippets, order and extra lines). It doesn't follow later global changes; **Copy global again** replaces it with the current global recipe. It is built on save; that workspace's sandboxed runs answer 409 until it is ready, and **Run in sandbox** is disabled with "Building this workspace's sandbox image… (workspace settings)". Other workspaces aren't blocked. The drawer shows its build state, log and a **Rebuild** button.
- **Ready-made image**: an image name, used instead of any recipe.

**Building:**

- Builds run **one at a time** through one queue: the CLIs image first, then the global recipe, then each workspace recipe. A target already queued isn't queued twice. Images are tagged by the hash of their Dockerfile, so two recipes with the same Dockerfile share one image.
- The missing images are built in the background at startup, so a second start with the same version and recipes builds nothing. **Save and rebuild** builds only the global sandbox image (with the build cache). **Rebuild** in Settings builds the CLIs and the global image without the cache: that is how you get newer CLIs and newer apt packages.
- The Node-only default builds in seconds; each toolchain adds to the build time and the size.
- While the global build runs, **Run in sandbox** is disabled with "Building the sandbox image… (Settings → Sandbox)" for the workspaces that use it, and starting a sandboxed run there answers 409. Settings shows the build state and its log.
- A failed build leaves that image unavailable, with the error and the log in Settings (or in the workspace's drawer). Fix the recipe and save, or press **Rebuild**.
- **Cleanup:** after a successful build, older `gm-sandbox*` images are removed unless they belong to the CLIs, the global recipe or a workspace recipe, and older `gm-clis-*` volumes are removed; those a running sandbox still uses are kept. Each graph-manager labels what it builds with its own id (`gm.instance`, the `instanceId` in `graph-manager.json`) and removes only its own, so several graph-managers can share one Docker daemon. Images and volumes without that label (built by an earlier version) are left alone; remove them with `docker rmi` / `docker volume rm` if you need the space.
- **Missing CLI volume:** before each sandboxed start, graph-manager checks that its `gm-clis-*` volume still exists (another graph-manager or `docker volume prune` may have removed it; Docker would then mount a new, empty volume and the agents would fail with `claude: not found`). A missing volume is filled again from the CLIs image; if that image is gone too, it is rebuilt and the start answers 409 meanwhile.
- A recipe saved by an earlier build of this feature (with an apt `packages` list) is migrated on read: the packages become one `RUN apt-get …` line at the start of the extra lines.

| Route | What it does |
| --- | --- |
| `GET /api/settings/sandbox` | `{ limits, recipe, defaultRecipe, toolchains: [{ id, name, snippet }], dockerfile, image }` |
| `PUT /api/settings/sandbox` | `{ limits?, recipe? }`; `recipe: null` resets to the default; a changed Dockerfile queues the global build; 400 for an invalid recipe, 409 while the global build runs |
| `POST /api/sandbox/dockerfile` | `{ recipe }` → `{ dockerfile, image, error? }`: the live preview, saves nothing |
| `POST /api/sandbox/rebuild` | 202: rebuilds the CLIs and the global image without the cache; 409 while a build runs |
| `GET /api/sandbox/build` | the global build: `{ state, step, startedAt, finishedAt, error, log }`, `state` one of `idle`, `queued`, `building`, `ready`, `failed` |
| `GET /api/workspaces/:id/settings` | `{ sandbox, source: "global" \| "recipe" \| "image", image, recipe, dockerfile, effectiveImage }` |
| `PUT /api/workspaces/:id/settings` | `{ source: "global" }`, `{ source: "image", image }` or `{ source: "recipe", recipe }`; answers the view plus `build`; 400 for an invalid image or recipe, 409 while that workspace's build runs |
| `GET /api/workspaces/:id/sandbox/build` | that workspace's build, same shape as `/api/sandbox/build` |
| `POST /api/workspaces/:id/sandbox/rebuild` | 202 `{ build }`: rebuilds that workspace's recipe image; 400 when its source isn't `recipe`, 409 while it builds |

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
- images built from a repository's Dockerfile, per-workspace recipes, pinned CLI versions;
- Windows containers (Docker Desktop must be in Linux-containers mode);
- a remote Docker daemon (`DOCKER_HOST` set to `tcp://` or `ssh://`): it can't see the workspaces folder;
- Podman.

## The app

The left nav has, from top to bottom, a **status block** (runs live, runs failed; each count opens Runs pre-filtered), **Runs**, **Terminals**, **Workspaces** and **Settings** with their badges (the Terminals badge is the number of terminals), then **Jump to… Ctrl K**, the theme button and **Log out**. Below 1100 px, and on the detail page of a live run, the nav collapses to a 56 px icon rail. Every screen polls the server every 2 s, keeps the last data on screen when a poll fails, and shows "Can't reach the server…" after 3 failures in a row.

- **Runs** (home): cards for live, failed and ready-for-PR runs; the runs grouped by workspace, sorted by attention (failed and live first, then ready for PR). **Start run** opens a drawer with the workspace, tasks folder, spec, provider, the run options (human review, merge, model, concurrency, and under **More options** attempts, fix passes, validation rounds, when to validate, parallel validation, idle timeout and extra arguments) and the command it will run. An option left at "Repo default" sends no flag, so the repo config or the engine default decides. The preview prints every flag on its own line, in the order the server passes them; an invalid number shows an error under its field and disables **Start run**. The last choices are remembered per workspace on the server (`runDefaults` in `graph-manager.json`).
- **Run detail:** the live run page in an iframe while it runs (it falls back to the static view if the page stops answering); after it, the Validation, Review + live test, Fixer and Landed cards, the layered task graph and the task table with attempts, elapsed times and line counts, and the Pull request panel. Create PR shows each step (checkout, commit, push, create) as it runs, then the PR link. Its commit also moves the run's spec to `docs/prd/done/<name>.md` (the commit step says `spec → docs/prd/done/<name>.md`), unless it is already there or outside the workspace.
- **Terminals:** a sidebar with one section per workspace and the workspaces root, where each terminal shows its title and foreground process (`bash`, `node`, `claude`) but no working/idle status; tabs; and 1, 2 or 4 split panes. A pane holds a terminal or a run's live page (the run chip on a terminal opens it). An exited terminal can be restarted in place. Closing a terminal asks first only while a program other than a plain shell runs in it. Under 900 px the sidebar is a drawer and one pane fills the page.
  - **Spec pane:** when a spec (`docs/prd/*.md`, not `docs/prd/done/`) is created or changes in the workspace of the focused terminal, a floating pane opens over the panes and shows it live: rendered Markdown with ```` ```mermaid ```` blocks drawn as diagrams, updated within a few seconds of each save. Specs that already existed when the page loaded open it only once they change. Drag it by its head, resize it from its corner, switch specs with its select, and close it with × or `Esc`; its position and size are remembered in this browser. A `spec <name>` chip on the terminal's pane head reopens it on the newest spec. Under 900 px it fills the main area. There is no status or Approve button: you answer the agent in the terminal.
- **Workspaces:** each clone with its forge, branch, clean/dirty state and runs, with Open terminal, Runs and Delete (disabled while a run is live in it).
- **Settings:** the GitHub and GitLab cards, and **Appearance**: Dark (the default), Light or System, saved in this browser only.

### Agents and tools

The Terminals sidebar starts with one button per agent: **Claude Code**, **Codex**, **OpenCode** and **Qwen Code**, and a secondary **Plain terminal** (`Ctrl Space n`) that opens a shell as before. An agent button asks for the workspace and title (`New <Agent> terminal`), shows `Connecting tools…` while graph-manager connects its tools to that agent, then opens a terminal in that workspace, with the agent typed into the shell and running. Quitting the agent leaves the shell; **Restart** runs the agent again. Each button and each agent terminal in the sidebar shows the agent's logo in its brand color. A CLI that is not on the server's `PATH` has its button disabled, with the tooltip `<binary> is not installed` (only Claude Code ships in the Docker image). Agents keep their normal permission prompts; only graph-manager's tools are pre-allowed where the agent supports it.

How each agent is connected:

| Agent | How graph-manager connects its tools |
| --- | --- |
| Claude Code | `claude --mcp-config <dataDir>/agents/claude-mcp.json --allowedTools mcp__graph-manager` (the file is written at startup and holds no secrets) |
| Codex | `codex -c mcp_servers.graph-manager.command="graph-manager-mcp"` |
| OpenCode | the `OPENCODE_CONFIG_CONTENT` env var, with an `mcp.graph-manager` entry running `graph-manager-mcp` |
| Qwen Code | No flag or env var for this, so graph-manager writes `mcpServers["graph-manager"] = { "command": "graph-manager-mcp", "trust": true }` into the workspace's `.qwen/settings.json` (other keys kept) and commits only that file on the current branch: `chore: connect graph-manager tools for Qwen Code`. It does this once; when the entry is already there, nothing is written or committed. Nothing is pushed. It refuses (409, no terminal opens) when that file has uncommitted changes, a merge, rebase or cherry-pick is in progress, or HEAD is detached. |

`graph-manager-mcp` is a stdio MCP server on the terminals' `PATH` (`<dataDir>/bin/graph-manager-mcp`, which runs `dist/server/mcp.js`). On Windows the file is `<dataDir>\bin\graph-manager-mcp.cmd`, next to `graph-execution.cmd`, and Claude Code, Codex and OpenCode are given the name with `.cmd`. It reaches graph-manager with the per-boot `GM_INTERNAL_TOKEN` and `GM_INTERNAL_URL` and the terminal's `GM_TERMINAL_ID`, all inherited from the terminal, so it works only inside graph-manager terminals; outside them it lists no tools. It fetches the tool list from graph-manager each time, so a new tool needs no change to any agent's config.

The tools:

- **`open_start_run { tasksDir, spec, provider?, options? }`** opens the **Start run** popup prefilled with the tasks folder, the spec, and the provider and run options when given (a prefill wins over the workspace's saved run defaults). The browser tab that shows the calling terminal opens it directly; other tabs show a toast `<Agent> in <repo> wants to start a run` with **Open**. The tool returns right away; the user reviews the options and clicks **Start run**. Paths may be relative to the agent's cwd or to the workspace root, and must be inside the workspace. The bundled `to-tasks` and `run-graph` skills call it when it is in the agent's tools, instead of starting the run themselves.

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
npm run build                                      # the engine, graph-manager, then the bundle in packages/graph-execution/dist/manager
node packages/graph-execution/dist/cli.js manager  # http://127.0.0.1:7420, as the npm package starts it
```

Or start the server from `apps/graph-manager/dist` as before, without the bundle step:

```bash
npm run build -w graph-execution && npm run build -w graph-manager
GM_PASSWORD=pw npm start -w graph-manager        # http://127.0.0.1:7420
```

Both read the same `GM_*` variables, and both generate a password when `GM_PASSWORD` is unset. `graph-execution manager` runs the copy in `packages/graph-execution/dist/manager`: after a change to graph-manager, run `npm run build` at the root again (`npm run build -w graph-manager` alone updates only `apps/graph-manager/dist`).

For the UI with hot reload, keep the server running and start `npx vite` in `apps/graph-manager`. Vite proxies `/api` and `/runs` to port 7420.

The checks: `npm run typecheck && npm run lint && npm test -w graph-manager`. To drive the whole loop in a real browser (fake forge, clone, a fake run, Create PR), run `bash apps/graph-manager/scripts/ui-smoke.sh` from the repository root; it needs [agent-browser](https://www.npmjs.com/package/agent-browser) and is not part of `npm test`. `TESTING.md` has the manual UI checklist.

### Adding a tool

Tools are written by graph-execution developers, in code; end users can't add them. To add one:

1. Create `apps/graph-manager/src/server/tools/<name>.ts`:

   ```ts
   import { z } from "zod";
   import { defineTool } from "./types.js";

   export const myTool = defineTool({
     name: "my_tool", // snake_case, unique
     description: "What it does and when the agent should call it.",
     input: z.object({ path: z.string() }),
     async run(input, { ctx, terminal, workspace, cwd }) {
       return { text: `did it with ${input.path}` }; // isError: true for a failure
     },
   });
   ```

   `ctx` is the server's `AppContext`, `terminal` the calling terminal, `workspace` its workspace (if any), and `cwd` the agent's working directory. Invalid arguments never reach `run`: the agent gets `invalid arguments: …`.
2. Append it to `TOOLS` in `apps/graph-manager/src/server/tools/index.ts`.
3. Add a test next to it (`<name>.test.ts`).
4. Rebuild (`npm run build` at the root, or `npm run build -w graph-manager` when you start it with `npm start`) and restart graph-manager.

Every agent sees the new tool with no config change, since `graph-manager-mcp` fetches the list from `GET /api/internal/tools`. A tool that needs the browser queues a request on `ctx.agentRequests`, which the web app polls and acts on; see `open-start-run.ts`.

## Security

- Agents run with full permissions inside the container, and the terminals are shells. Anyone who can log in can run any command there and read the tokens. Protect the port: bind it to `127.0.0.1`, or put it behind a VPN or a TLS reverse proxy, and use a strong `GM_PASSWORD`.
- Tokens are stored in `/data/graph-manager.json` with mode 600. Clones use the token without writing it into `.git/config`.
- Everything except `/healthz`, the login and the static UI is behind the login (`/api/*` and the proxied run pages).

## Limitations

- One user per deployment (a single admin password).
- Terminals are plain PTYs: they don't survive a restart of the server or the container. Runs started with `--web` keep running detached, and the files in `/workspaces` stay.
- Windows terminals: `graph-execution` and `graph-manager-mcp` are `.cmd` files there.
  - After Ctrl+C in one, `cmd.exe` asks `Terminate batch job (Y/N)?`.
  - A shim is not written when the path of the engine or of graph-manager contains `%` or `"` (the terminals then have no `graph-execution` command or no agent tools). A path with non-ASCII characters may not work in a `.cmd` file.
  - Qwen Code's committed `.qwen/settings.json` keeps the bare `graph-manager-mcp` name on every platform, so that the file is the same for everyone who clones the repository. Whether Qwen Code finds `graph-manager-mcp.cmd` by that name on Windows has not been checked.
  - Claude Code, Codex and OpenCode are given the name `graph-manager-mcp.cmd` on Windows. Whether each of them starts a `.cmd` MCP command there has not been checked against the real CLIs (Node refuses to spawn a `.cmd` file without a shell since 20.12 / 18.20.2).
- Sandboxes on macOS and Windows are covered by unit tests and CI only; see [Platforms](#platforms).
- Agent requests (such as a pending Start run popup from `open_start_run`) are kept in memory only: a server restart drops them. Unhandled ones expire after 24 h.
