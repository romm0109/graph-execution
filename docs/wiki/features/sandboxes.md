# Sandboxed runs (KAN-88)

## Summary

A run started from graph-manager can run in its own Docker container: a **sandbox**. It's an option per run and off by default, turned on with **Run in sandbox** in Start run or with `graph-execution … --sandbox` in a graph-manager terminal.

graph-manager starts the container through the host's Docker socket:

- the container sees only that workspace, mounted at the same path;
- a read-only tools volume provides the engine and the provider CLIs;
- the provider login is copied into the container's own home.

The container never sees `/data` (forge tokens, session secret), other workspaces or any `GM_` variable. The live run page, abort, retry, the human-review pause, resume and the apply all work as for a normal run. Push and **Create PR** stay on the server. Each workspace can set its image, and Settings has the CPU, memory and PID limits.

- Spec: `docs/prd/done/sandboxes.md`.
- Tasks: `.agents/tasks/sandboxes/`, built in suite `suite-20261107-153515-d7da`.
- User docs: the Sandboxes section of `apps/graph-manager/README.md`, and the compose file.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| The sandbox is an option per run, off by default. | The user asked for it. | KAN-88 |
| Docker on a VM or laptop, through the mounted host socket (`/var/run/docker.sock`). The compose file adds `group_add: ${DOCKER_GID}`. The README says plainly that the socket gives graph-manager root-equivalent access to the host. | The user chose plain Docker with the socket. | KAN-88 |
| One container per run, with the engine and every agent of the run inside it. | Much simpler than one container per agent. The point is to keep the run away from the server and the other workspaces. | KAN-88 |
| A small Docker Engine API client over the socket (`node:http`, API `v1.45`), with no `dockerode` dependency. | Only a few calls are needed. `v1.45` is the first version with `volume-subpath` mounts. | KAN-88 |
| The workspace is mounted read-write at the same absolute path, and only that workspace's subfolder. graph-manager finds the source of its own `/workspaces` mount by inspecting its own container. `GM_SANDBOX_WORKSPACES_SOURCE` overrides it. | git worktrees and `state.json` store absolute paths, and other workspaces must stay hidden. | KAN-88 |
| The engine and the provider CLIs come from a `gm-tools` volume that graph-manager fills at startup and mounts read-only at `/opt/gm-tools`. Outside Docker it is a bind of `<dataDir>/sandbox-tools`. | A custom image then only needs `node` 20+ and `git`. | KAN-88 |
| The image is set per workspace. The default is `GM_SANDBOX_IMAGE`, else graph-manager's own image (found by self-inspect), else `node:24.22.1-bookworm`. A missing image is pulled at start. | The user chose it. A Python repo can use an image with Python. Outside Docker there was no default at all; the full bookworm image has git. | KAN-88, sandbox fixes |
| The provider login is copied into `/home/sandbox` before the container starts (`PUT /containers/{id}/archive`), with only the provider's login files. `/data` is never mounted. | The user chose a copy per run. The sandbox can't change the server's login. | KAN-88 |
| There is no tmpfs at `/home/sandbox`. The home lives in the container's own layer and is removed with the container. | A tmpfs mounted at start would hide the login files copied in before start. | KAN-88 |
| Provider API keys, the git identity (from `GIT_*` or `git config` in the workspace) and `GRAPH_EXECUTION_*` variables go in as env. `GM_*` variables never do. | Agents need keys and an identity, and the engine never pushes. The reviewers file (KAN-87) reaches sandboxed runs through `GRAPH_EXECUTION_*`. | KAN-88 |
| The engine runs `--web-serve` as the container's main process (`Init: true`) and binds `0.0.0.0:7600`, through `GRAPH_EXECUTION_WEB_HOST` and `GRAPH_EXECUTION_WEB_PORT`. The proxy reaches it at `<container ip>:7600` on the `gm-sandbox` network, rewriting `Host` to `127.0.0.1:7600`. | The container is the detached process, and the engine's Host check needs no change. | KAN-88 |
| A sandbox's run page also requires a per-run token (`GRAPH_EXECUTION_WEB_TOKEN`). Only graph-manager's proxy sends it, in `x-graph-execution-token`, and a token sent by the browser is replaced. | Review F1: every sandbox is on the same network, so one sandbox's agent could otherwise reach another run's page and abort it. | KAN-88 |
| A sandboxed run is live while its container runs (Docker inspect), not by PID. | PIDs in another PID namespace mean nothing to the server. | KAN-88 |
| Outside Docker, the container publishes port 7600 on `127.0.0.1:<free port>`. The proxy connects there and still sends `Host: 127.0.0.1:7600` (`upstream.hostPort`). | Docker Desktop (macOS, Windows) does not route the host to container IPs, so the run page of a sandbox never loaded. | sandbox fixes |
| A run whose `state.json` says `running` but whose container (or process) is gone is listed as `interrupted`, kind `unfinished`. | Its foreign lock made `scan` call it live forever after `docker rm`. The container decides for a sandboxed run. | sandbox fixes |
| The run lock and the process registry record the host. A lock is foreign only when it carries the `sandbox` marker (`<pid>\n<token>\n<host>\nsandbox`). A foreign lock is never stale and its processes are never killed. Each container gets a fixed hostname `sbx-<hex>`. | Review F2: treating every lock from another hostname as held forever could block runs for good. Only real sandboxes need protection from `clean` and `--resume` in a terminal. | KAN-88 |
| A sandboxed run is resumed in a new sandbox: through **Resume** in graph-manager, or `--resume --run <id> --sandbox`. A plain `--resume` exits 2 with a hint. Only graph-manager, after Docker confirms the old container is gone, passes `GRAPH_EXECUTION_TAKE_LOCK_FROM=<old host>`. | Only the server can tell that a foreign lock is really dead. | KAN-88 |
| `AutoRemove: false`. graph-manager waits for the container, reads its logs before removing it, and then removes it itself. | Review T4: a race lost the container log, and sometimes the exit code, when a start failed. | KAN-88 |
| `graph-execution --sandbox` in a terminal is handled by graph-manager's shim. It posts to `/api/internal/sandbox-runs` with a per-boot `GM_INTERNAL_TOKEN`, accepted only from loopback (or `GM_HOST`). The plain engine refuses `--sandbox` with exit 2. | Only the server talks to Docker, and terminals are already fully trusted. | KAN-88 |
| The container runs as the workspace owner, with `no-new-privileges`. The network is open. Limits come from Settings: 2 CPUs, 4096 MB and 2048 PIDs by default. | The user chose an open network and configurable limits. Nothing runs as root. | KAN-88 |
| A top-level `sandbox` field in the start body, and the last choice saved in `workspaceSettings[<id>].sandbox`. | It was built in parallel with KAN-89 in one suite, so it couldn't depend on KAN-89's `options` object. | KAN-88 |
| Tests use `scripts/fake-docker.mjs`, a fake Docker API on a unix socket. In `--exec` mode it runs each container's command locally on its own `127.0.0.x` address. One end-to-end test uses real Docker and is skipped without a daemon or a local image. | CI has no Docker on macOS. The behaviour is still tested end to end. | KAN-88 |

## Known follow-ups

- **F4 (review, minor, accepted):** `/api/internal/*` also accepts requests from `GM_HOST`'s own address, besides loopback. That's needed when `GM_HOST` is a specific IP, and the bearer token still applies.
- With real Docker, `GRAPH_EXECUTION_FAKE_SCRIPT` must point inside the workspace, because the container sees nothing else. This is a testing note.
- No network allow-list or egress filtering. No Kubernetes, OpenShift, rootless Docker or gVisor backends. No sandboxed suites. No images built from a repo's Dockerfile.
- Live previews (KAN-90) will build on sandboxes.

## Code references

- `packages/graph-execution/src/state/state.ts`, `packages/graph-execution/src/state/processes.ts`: the host-aware lock, the registry and `TAKE_LOCK_FROM`.
- `packages/graph-execution/src/web/server.ts`, `packages/graph-execution/src/web/serve.ts`, `packages/graph-execution/src/web/start.ts`, `packages/graph-execution/src/web/webjson.ts`: the bind host and port, the token, and `host` in `web.json`.
- `packages/graph-execution/src/cli.ts`, `packages/graph-execution/src/launch/preflight.ts`: the `--sandbox` refusal and the resume guard.
- `apps/graph-manager/src/server/docker.ts`, `apps/graph-manager/src/server/tar.ts`: the Docker client and the archive for the login copy.
- `apps/graph-manager/src/server/sandbox.ts`, `apps/graph-manager/src/server/sandbox-run.ts`, `apps/graph-manager/src/server/sandbox-tools.ts`: status, network, tools volume, and starting and watching a sandbox.
- `apps/graph-manager/src/server/routes/sandbox.ts`, `apps/graph-manager/src/server/routes/resume.ts`, `apps/graph-manager/src/server/routes/internal.ts`: the routes.
- `apps/graph-manager/src/server/proxy.ts`, `apps/graph-manager/src/server/viewcache.ts`, `apps/graph-manager/src/server/runs.ts`, `apps/graph-manager/src/server/routes/workspaces.ts`: the upstream, liveness and the Delete guard.
- `apps/graph-manager/src/server/shim.ts`, `apps/graph-manager/src/server/terminals.ts`: `--sandbox` in terminals.
- `apps/graph-manager/src/web/pages/StartRunDrawer.tsx`, `apps/graph-manager/src/web/pages/SandboxCard.tsx`, `apps/graph-manager/src/web/pages/Workspaces.tsx`, `apps/graph-manager/src/web/pages/RunDetail.tsx`: the toggle, the limits, the image setting, and Resume / Stop sandbox.
- `apps/graph-manager/docker-compose.yml`, `apps/graph-manager/Dockerfile`, `apps/graph-manager/scripts/fake-docker.mjs`: packaging and the fake Docker.

## Related

- [Run options in Start run (KAN-89)](run-options.md)
- [Reviewers from the UI (KAN-87)](ui-reviewers.md)
- [graph-manager: web service and Docker image](graph-manager.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-08
