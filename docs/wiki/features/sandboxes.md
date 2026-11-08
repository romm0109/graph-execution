# Sandboxed runs (KAN-88)

## Summary

A run started from graph-manager can run in its own Docker container: a **sandbox**. It's an option per run and off by default, turned on with **Run in sandbox** in Start run or with `graph-execution … --sandbox` in a graph-manager terminal.

graph-manager starts the container through the host's Docker socket:

- the container sees only that workspace, mounted at the same path;
- a read-only tools volume provides the engine, and a read-only `gm-clis-*` volume the provider CLIs (Linux builds made by Docker);
- the provider login is copied into the container's own home.

The container never sees `/data` (forge tokens, session secret), other workspaces or any `GM_` variable. The live run page, abort, retry, the human-review pause, resume and the apply all work as for a normal run. Push and **Create PR** stay on the server. Each workspace can set its image, and Settings has the CPU, memory and PID limits.

- Spec: `docs/prd/done/sandboxes.md`.
- Tasks: `.agents/tasks/sandboxes/`, built in suite `suite-20261107-153515-d7da`.
- User docs: the Sandboxes section of `apps/graph-manager/README.md` (with "The sandbox images"), and the compose file.
- Sandbox image spec: `docs/prd/done/sandbox-image.md` (no ticket; follows the macOS "Exec format error" report).

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| The sandbox is an option per run, off by default. | The user asked for it. | KAN-88 |
| Docker on a VM or laptop, through the mounted host socket (`/var/run/docker.sock`). The compose file adds `group_add: ${DOCKER_GID}`. The README says plainly that the socket gives graph-manager root-equivalent access to the host. | The user chose plain Docker with the socket. | KAN-88 |
| One container per run, with the engine and every agent of the run inside it. | Much simpler than one container per agent. The point is to keep the run away from the server and the other workspaces. | KAN-88 |
| A small Docker Engine API client over the socket (`node:http`, API `v1.45`), with no `dockerode` dependency. | Only a few calls are needed. `v1.45` is the first version with `volume-subpath` mounts. | KAN-88 |
| The workspace is mounted read-write at the same absolute path, and only that workspace's subfolder. graph-manager finds the source of its own `/workspaces` mount by inspecting its own container. `GM_SANDBOX_WORKSPACES_SOURCE` overrides it. | git worktrees and `state.json` store absolute paths, and other workspaces must stay hidden. | KAN-88 |
| The engine comes from a `gm-tools` volume that graph-manager fills at startup and mounts read-only at `/opt/gm-tools`. Outside Docker it is a bind of `<dataDir>/sandbox-tools`. The provider CLIs are no longer copied there (superseded, see below). | A custom image then only needs `node` 20+, `git` and glibc. | KAN-88, sandbox image |
| The image is set per workspace. The default is the `gm-sandbox:<hash>` image graph-manager builds (superseded the old default of `GM_SANDBOX_IMAGE`, else graph-manager's own image, else `node:24.22.1-bookworm`). A missing workspace image is pulled at start; a missing built image is built again (409 meanwhile). | The user chose it. The built image has the common languages, so most repos need no image of their own. | KAN-88, sandbox image |
| The provider login is copied into `/home/sandbox` before the container starts (`PUT /containers/{id}/archive`), with only the provider's login files. `/data` is never mounted. | The user chose a copy per run. The sandbox can't change the server's login. | KAN-88 |
| There is no tmpfs at `/home/sandbox`. The home lives in the container's own layer and is removed with the container. | A tmpfs mounted at start would hide the login files copied in before start. | KAN-88 |
| Provider API keys, the git identity (from `GIT_*` or `git config` in the workspace) and `GRAPH_EXECUTION_*` variables go in as env. `GM_*` variables never do. | Agents need keys and an identity, and the engine never pushes. The reviewers file (KAN-87) reaches sandboxed runs through `GRAPH_EXECUTION_*`. | KAN-88 |
| The engine runs `--web-serve` as the container's main process (`Init: true`) and binds `0.0.0.0:7600`, through `GRAPH_EXECUTION_WEB_HOST` and `GRAPH_EXECUTION_WEB_PORT`. The proxy reaches it at `<container ip>:7600` on the `gm-sandbox` network, rewriting `Host` to `127.0.0.1:7600`. | The container is the detached process, and the engine's Host check needs no change. | KAN-88 |
| A sandbox's run page also requires a per-run token (`GRAPH_EXECUTION_WEB_TOKEN`). Only graph-manager's proxy sends it, in `x-graph-execution-token`, and a token sent by the browser is replaced. | Review F1: every sandbox is on the same network, so one sandbox's agent could otherwise reach another run's page and abort it. | KAN-88 |
| A sandboxed run is live while its container runs (Docker inspect), not by PID. | PIDs in another PID namespace mean nothing to the server. | KAN-88 |
| Outside Docker, the container publishes port 7600 on `127.0.0.1:<free port>`. The proxy connects there and still sends `Host: 127.0.0.1:7600` (`upstream.hostPort`). | Docker Desktop (macOS, Windows) does not route the host to container IPs, so the run page of a sandbox never loaded. | sandbox fixes |
| A run whose `state.json` says `running` but whose container (or process) is gone is listed as `interrupted`, kind `unfinished`. | Its foreign lock made `scan` call it live forever after `docker rm`. The container decides for a sandboxed run. | sandbox fixes |
| The run lock and the process registry record the host. The lock is `<pid>\n<token>\n<written ms>\n<host>\n`, plus `sandbox` in a sandbox (informational); the time line comes from main's Windows CI work. Any lock or record of another host is foreign: never stale, its processes never killed. Each container gets a fixed hostname `sbx-<hex>`. | Review F2 first narrowed this to locks marked `sandbox`. The end-to-end fixer went back to "any other host", because the end-to-end test plan still required it, and made graph-manager's **Resume** pass `TAKE_LOCK_FROM` for locks left by graph-manager's own previous container, so those runs stay resumable from the UI. | KAN-88 |
| A sandboxed run is resumed in a new sandbox: through **Resume** in graph-manager, or `--resume --run <id> --sandbox`. A plain `--resume` exits 2 with a hint. Only graph-manager, after Docker confirms the old container is gone, passes `GRAPH_EXECUTION_TAKE_LOCK_FROM=<old host>`. | Only the server can tell that a foreign lock is really dead. | KAN-88 |
| `AutoRemove: false`. graph-manager waits for the container, reads its logs before removing it, and then removes it itself. | Review T4: a race lost the container log, and sometimes the exit code, when a start failed. | KAN-88 |
| `graph-execution --sandbox` in a terminal is handled by graph-manager's shim. It posts to `/api/internal/sandbox-runs` with a per-boot `GM_INTERNAL_TOKEN`, accepted only from loopback (or `GM_HOST`). The plain engine refuses `--sandbox` with exit 2. | Only the server talks to Docker, and terminals are already fully trusted. | KAN-88 |
| The container runs as the workspace owner, with `no-new-privileges`. The network is open. Limits come from Settings: 2 CPUs, 4096 MB and 2048 PIDs by default. | The user chose an open network and configurable limits. Nothing runs as root. | KAN-88 |
| A top-level `sandbox` field in the start body, and the last choice saved in `workspaceSettings[<id>].sandbox`. | It was built in parallel with KAN-89 in one suite, so it couldn't depend on KAN-89's `options` object. | KAN-88 |
| Two images: `gm-sandbox-clis:<gm version>` with only the provider CLIs, and `gm-sandbox:<12 hex of sha256(Dockerfile)>`, the default sandbox image. | Workspace images need the CLIs too. Kept apart, a recipe change never reinstalls the CLIs, and the reverse. | sandbox image |
| The CLIs are installed with `npm install -g --prefix /opt/gm-clis` inside a Docker build `FROM node:24.22.1-bookworm-slim`; graph-manager no longer copies them from its PATH. | Copies from a Mac were Mach-O binaries (`Exec format error` in the Linux container). Docker builds on its own OS and CPU, so npm picks the right Linux build. | sandbox image |
| The CLIs are the latest versions at build time. The CLIs image is rebuilt when graph-manager's version changes, or with **Rebuild**. | graph-manager no longer needs the CLIs installed at all. | sandbox image |
| The CLIs reach a sandbox through the named volume `gm-clis-<12 hex of the image id>`, filled from the image (Docker copies an image's files into an empty named volume when it is mounted) and mounted read-only at `/opt/gm-clis`. The fill container also runs for an existing volume, so one left empty by a crash is filled. | Works with any image and with Docker 26 (image mounts need Docker 28). A rebuild makes a new volume while running sandboxes keep the old one. | sandbox image, review F4 |
| The recipe is base image + apt packages + extra Dockerfile lines, saved as `sandboxRecipe` in `graph-manager.json`. Extra lines may not contain `FROM` (400). | Several `FROM`s don't merge images; `COPY --from=<image>` adds a tool from another image. | sandbox image |
| The default recipe has Python, Java (Maven, Gradle), Ruby, PHP, C/C++ from bookworm's apt, Go and Rust by `COPY --from=` their official images, pnpm/yarn through corepack. | Bookworm's Go (1.19) and Rust (1.63) are too old. | sandbox image |
| The sandbox's `PATH` is `/opt/gm-tools/bin:/opt/gm-clis/bin:` + the image's own `PATH` (image inspect). | Images put tools on their PATH with `ENV` (Go, Cargo). | sandbox image |
| Builds run in the background; `status()` is `building` (not available) until both images exist, and answers at once, also while the startup copies the engine. A sandboxed start during a build answers 409. | A build takes minutes; the Start run drawer must not hang. | sandbox image, review T1 |
| A failed build leaves sandboxes unavailable with the error and the log in Settings; no automatic retry. | A half-built image would hide the error. | sandbox image |
| **Rebuild** builds both images with `nocache=1`; a recipe save builds only the sandbox image. A Rebuild asked for while the startup still copies the engine makes the startup build the forced one. | Rebuild is how the user gets newer CLIs and packages. Before, an early Rebuild got 409 and only a cached build ran. | sandbox image, review F3 |
| Older labelled images are removed by their `gm-sandbox*` tags (dangling ones by id), and older `gm-clis-*` volumes by name, after a successful build; in-use ones are skipped. | They are large. Removing by id failed for an image with a second tag. | sandbox image, review F5 |
| `GM_SANDBOX_IMAGE` sets the base image of the default recipe. Sandbox images must be glibc-based (not Alpine). | The built image replaces the old defaults; the CLIs in the volume are glibc builds. | sandbox image |
| Tests use `scripts/fake-docker.mjs`, a fake Docker API on a unix socket. In `--exec` mode it runs each container's command locally on its own `127.0.0.x` address. One end-to-end test uses real Docker and is skipped without a daemon or a local image. | CI has no Docker on macOS. The behaviour is still tested end to end. | KAN-88 |

## Known follow-ups

- **Foreign locks:** any lock from another host is held. A run that graph-manager's previous container left behind can be resumed from the UI, but not with `--resume` or `clean` typed in a terminal. Narrowing the rule back to locks marked `sandbox` (the F2 fix) would allow that.
- **F4 (review, minor, accepted):** `/api/internal/*` also accepts requests from `GM_HOST`'s own address, besides loopback. That's needed when `GM_HOST` is a specific IP, and the bearer token still applies.
- With real Docker, `GRAPH_EXECUTION_FAKE_SCRIPT` must point inside the workspace, because the container sees nothing else. This is a testing note.
- No network allow-list or egress filtering. No Kubernetes, OpenShift, rootless Docker or gVisor backends. No sandboxed suites. No images built from a repo's Dockerfile.
- Live previews (KAN-90) will build on sandboxes.
- **Sandbox image, review F5:** every image labelled `gm.sandbox-image=1` on the daemon is cleaned up, so two graph-manager instances of different versions on one daemon remove each other's CLIs image and rebuild it at each start.
- **Sandbox image, review F7:** extra Dockerfile lines are trimmed and empty lines dropped (as the spec asks), which breaks indentation inside a `RUN <<EOF` heredoc; the `FROM` check also rejects a continuation line starting with `FROM`.
- No per-workspace recipes, no building from a repo's Dockerfile, no pinned CLI versions, no registry push.

## Code references

- `packages/graph-execution/src/state/state.ts`, `packages/graph-execution/src/state/processes.ts`: the host-aware lock, the registry and `TAKE_LOCK_FROM`.
- `packages/graph-execution/src/web/server.ts`, `packages/graph-execution/src/web/serve.ts`, `packages/graph-execution/src/web/start.ts`, `packages/graph-execution/src/web/webjson.ts`: the bind host and port, the token, and `host` in `web.json`.
- `packages/graph-execution/src/cli.ts`, `packages/graph-execution/src/launch/preflight.ts`: the `--sandbox` refusal and the resume guard.
- `apps/graph-manager/src/server/docker.ts`, `apps/graph-manager/src/server/tar.ts`: the Docker client and the archive for the login copy.
- `apps/graph-manager/src/server/sandbox.ts`, `apps/graph-manager/src/server/sandbox-run.ts`, `apps/graph-manager/src/server/sandbox-tools.ts`: status, network, tools volume, the image builder state, and starting and watching a sandbox.
- `apps/graph-manager/src/server/sandbox-image.ts`: the CLIs image, the gm-clis volume, the recipe, its Dockerfile, tag and validation, and the cleanup. `sandbox.docker.test.ts` builds the CLIs image on a real daemon and runs `claude --version` from the volume.
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
