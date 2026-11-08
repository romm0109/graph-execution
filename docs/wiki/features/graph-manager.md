# graph-manager: web service and Docker image (GM-01 … GM-09)

## Summary

graph-manager (`apps/graph-manager`) is a Fastify server and React UI around the graph-execution engine. It connects GitHub or GitLab with a personal access token, clones repositories into workspaces, opens PTY terminals in them, lists every run on a dashboard (proxying the engine's own run page while it is live) and opens a PR or MR from an applied run. It ships as one Docker image (`apps/graph-manager/Dockerfile`, built from the repo root) that runs the same on a laptop, a VM or OpenShift. The spec is `docs/prd/done/graph-manager.md`. These ids are not Jira tickets: the work was agreed with the user in conversation.

## Decisions

| Decision | Why | Id |
|---|---|---|
| Full restructure into `packages/graph-execution` + `apps/graph-manager` (npm workspaces) | The user chose a monorepo with a clean layout over keeping the engine at the root. The npm package contents stay the same. | GM-01 |
| graph-manager reads runs through `graph-execution/api` (state schemas, run discovery, exit codes); the run page uses relative URLs | One source of truth for the state format, and the engine's page works when proxied under a sub-path. | GM-02 |
| Single admin password (`GM_PASSWORD`) with an HMAC-signed session cookie | One user per deployment for now. | GM-03 |
| PATs, not OAuth apps | Works with GitHub, GitLab.com and self-hosted GitLab without registering apps. | GM-04 |
| Clone from the forge into `/workspaces/<forge>/<owner>/<repo>`, without writing the token into `.git/config` | Workspaces come from the connected forge; runs start from the terminal or a button. | GM-05 |
| Plain PTYs, not tmux; terminals get a `graph-execution` shim on `PATH`, `GRAPH_EXECUTION_HANDOFF=detached` and `SSH_CONNECTION=1` | Must work for every frontend OS; persistence across server restarts is not needed now. `--web` runs start detached and don't try to open a browser. | GM-06 |
| Proxy the run page instead of rebuilding it | The engine's page is complete; graph-manager adds the list, the fallback graph and the PR flow. | GM-07 |
| A **Create PR** button | Commits, pushes and opens the PR/MR from the dashboard. | GM-08 |
| One multi-stage image: `node:22-bookworm` builds (node-pty is native), `node:22-bookworm` also runs it (git, ssh and procps are preinstalled, tini is fetched by checksum, so the build needs no apt mirror, only HTTPS; a proxy CA goes in as the optional `ca` build secret) with, the built engine on `PATH` and the Claude Code CLI | The same image everywhere. `npm prune --omit=dev` keeps node-pty's compiled binary and the workspace symlinks (vite and the other build tools are devDependencies). | GM-09 |
| `USER 1000`; `/data` and `/workspaces` are owned by `1000:0` and `chmod g=u` | UID 1000 owns them under plain Docker; OpenShift runs an arbitrary UID in group 0, which group-0 write covers. `chgrp 0` alone left UID 1000 unable to write under plain Docker. | GM-09 |
| `HOME=/data/home` and default `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars | A `claude` login in a terminal survives restarts, and graph-execution runs can commit out of the box. Users override the identity with `-e`. | GM-09 |
| An unauthenticated `GET /healthz` (outside `/api`) | Docker `HEALTHCHECK` and OpenShift probes can't log in. It only answers `{"ok":true}`. `/api/health` stays behind login. | GM-09 |
| `apps/graph-manager/scripts/docker-smoke.sh` is not part of `npm test` | CI has no Docker on macOS. | GM-09 |
| WebSocket upgrades and non-GET `/api/*` and `/runs/*/view/*` requests must have no `Origin` or one whose host matches `Host` / `X-Forwarded-Host` (403 otherwise) | `SameSite=Strict` does not separate ports on one host, so a page on another port could drive a terminal or abort a run. The proxy strips `Origin` only after this check. | GM-03, GM-06, GM-07 |
| Session cookies carry a random nonce; logout records it in `revokedSessions` (pruned at expiry) | A copied cookie stops working after logout. | GM-03 |
| 10 failed logins per IP in 15 min → 429 with `Retry-After` | Slows password guessing on an exposed deployment without a dependency. In memory, so it resets on restart. | GM-03 |
| Terminal cwd and clone paths are checked after `realpath` | A symlink committed in a cloned repo must not let a terminal start outside `/workspaces`. | GM-05, GM-06 |
| Create PR switches the workspace back to its original branch after the push | Later runs and terminals start from the user's branch, not `gm/<runId>`. A failed push leaves it on the PR branch. | GM-08 |
| At startup graph-manager copies its engine's skills (`to-spec`, `to-tasks`, `run-graph`) into `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and `~/.agents/skills`, tagged with a content hash in `.graph-manager`, and replaces only its own copies (`src/server/skills.ts`). | A workspace on an old branch taught the agent an engine without `--sandbox`, so it researched instead of running. User-level skills win over a project's `.claude/skills` in Claude Code, so the agent always sees the skills of the engine it runs, neither older nor newer. | sandbox fixes |
| The `run-graph` skill says: in a graph-manager terminal (`GM_INTERNAL_URL` set) run `graph-execution` from the PATH, never `npx` or a repo build, and use `--sandbox` when asked for a sandbox. | The agent used the repo's own `dist/cli.js`, which can't start sandboxes. | sandbox fixes |
| A run that starts while the app is open (`nextRunWatch`: new since the first poll, and live or running) gets a toast with **Open**; on Terminals it opens in the next free pane when it is in the focused terminal's workspace. | A run the agent starts from a terminal showed up only in the Runs list. | sandbox fixes |

## Known follow-ups

- Terminal persistence across restarts (tmux or similar).
- OAuth apps instead of pasted PATs.
- Multiple users, roles, SSO.
- Jira integration.
- A desktop wrapper around the web UI.
- OpenShift manifests / a Helm chart (the image already runs as an arbitrary non-root UID in group 0).
- Run the Docker smoke test in CI on the ubuntu runner.

## Code references

- `apps/graph-manager/src/server/main.ts`, `apps/graph-manager/src/server/config.ts`: startup and the `GM_*` env vars.
- `apps/graph-manager/src/server/app.ts`: `buildApp`, the route wiring and the SPA fallback.
- `apps/graph-manager/src/server/auth.ts`: login, session cookie, `needsAuth`.
- `apps/graph-manager/src/server/store.ts`: `/data/graph-manager.json` (mode 600).
- `apps/graph-manager/src/server/forges.ts`, `apps/graph-manager/src/server/routes/forges.ts`: GitHub/GitLab tokens.
- `apps/graph-manager/src/server/workspaces.ts`, `apps/graph-manager/src/server/routes/workspaces.ts`: clones.
- `apps/graph-manager/src/server/terminals.ts`, `apps/graph-manager/src/server/routes/terminals.ts`: PTYs and the `graph-execution` shim.
- `apps/graph-manager/src/server/runs.ts`, `apps/graph-manager/src/server/routes/runs.ts`, `apps/graph-manager/src/server/proxy.ts`: the runs dashboard and the run-page proxy.
- `apps/graph-manager/src/server/pr.ts`, `apps/graph-manager/src/server/routes/pr.ts`: **Create PR**.
- `apps/graph-manager/src/server/routes/health.ts`: `/healthz` and `/api/health`.
- `apps/graph-manager/Dockerfile`, `apps/graph-manager/docker-compose.yml`, `.dockerignore`, `apps/graph-manager/scripts/docker-smoke.sh`: packaging.
- `packages/graph-execution/src/api.ts`: the engine's library entry.

## Related

- [graph-manager README](../../../apps/graph-manager/README.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-08
