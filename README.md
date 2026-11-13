# graph-execution monorepo

This repository holds the graph-execution engine and the apps built around it, as npm workspaces.

| Workspace | What it is |
| --- | --- |
| [`packages/graph-execution`](packages/graph-execution/README.md) | The open-source CLI, published to npm as `graph-execution` |
| [`apps/graph-manager`](apps/graph-manager/README.md) | The web service around the engine, shipped inside the `graph-execution` npm package (`graph-execution manager`) and as a Docker image |

The engine's user documentation lives in [`packages/graph-execution/README.md`](packages/graph-execution/README.md).

## graph-manager

graph-manager is a web service around the engine. It connects GitHub or GitLab, clones repositories into workspaces, opens terminals to run `claude` and `graph-execution`, shows every run on a dashboard and opens a PR from an applied run.

It ships inside the `graph-execution` npm package:

```bash
npm install -g graph-execution
graph-execution manager
```

It prints its address and the password for the login page, then opens the browser:

```text
graph-manager listening on http://127.0.0.1:7420
Password: kq3ZJ0cXo1b9mVd2wTn5Hs8yLr4uAe7P (saved in /home/ada/.graph-manager/password)
```

The password is generated on the first start and saved in `~/.graph-manager/password`; set `GM_PASSWORD` to choose your own. The flags are `--port`, `--host`, `--data-dir`, `--workspaces-dir` and `--no-open`. On Linux, `npm install` compiles `node-pty` and needs Python 3, make and a C++ compiler; macOS and Windows get a prebuilt binary.

It also ships as one Docker image:

```bash
docker build -f apps/graph-manager/Dockerfile -t graph-manager:dev .
docker run -d -e GM_PASSWORD='choose-a-password' -p 127.0.0.1:7420:7420 \
  -v gm-data:/data -v gm-workspaces:/workspaces graph-manager:dev
```

See [`apps/graph-manager/README.md`](apps/graph-manager/README.md) for the configuration, the first steps, sandboxed runs and the security notes.

## Automation API

graph-manager has a versioned HTTP API under `/api/v1` for scripts, CI jobs and other services. A client sends markdown (`content`) with an API token. graph-manager starts a run whose first stage plans a spec and tasks from it ([`--content`](packages/graph-execution/README.md#starting-from-plain-content)). The client polls the run, then approves or rejects the plan.

**Token.** In graph-manager open **Settings → API tokens**, enter a name, pick the scopes and press **Create token**. The token (`gmt_…`) is shown once: copy it then. Only its SHA-256 hash is stored. You can also create one with the login cookie: `POST /api/tokens` with `{"name":"ci","scopes":["runs:start","runs:read"]}` answers `201` with the `token` field.

**Start a run, then poll it.** The workspace id is the clone's path with `~` between the parts: `<forge>~<owner>~<repo>`, for example `github~octo~hello` (`GET /api/v1/workspaces` lists them).

```bash
TOKEN=gmt_...
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"content":"# Add a dark mode toggle\n...","refs":[{"ref":"KAN-41","url":"https://…/browse/KAN-41"}],"provider":"claude","openPr":true}' \
  http://127.0.0.1:7420/api/v1/workspaces/github~octo~hello/runs        # 201 {"runId":"gm-…","viewUrl":"/runs/github~octo~hello/gm-…"}
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7420/api/v1/runs/<runId>   # {"runId":"gm-…","status":"planning", …}
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7420/api/v1/runs/<runId>/approve   # needs runs:approve
```

The run goes `planning` → `awaiting-approval` (or `needs-info`, with the planner's questions in `questions`) → `running` → `applied`. A planned run also waits on graph-manager's **Approvals** page. By default the run starts in a Docker sandbox (`"sandbox": false` runs it on the server). With `"openPr": true` graph-manager opens the pull request once the run is `applied`.

The scopes, every endpoint, the run object and the extension slot (`GM_EXTENSIONS`) are in [graph-manager's README](apps/graph-manager/README.md#automation-api).

## Development

Run these at the repository root:

```bash
npm ci                              # install all workspaces
npm run typecheck                   # runs the build below, then type-checks every workspace
npm run lint                        # eslint over the whole repo
npm test                            # every workspace's tests
npm run build                       # build the engine, then graph-manager, then copy graph-manager into the engine's dist/manager
npm run build -w graph-execution    # build the engine only, into packages/graph-execution/dist
```

After a build, run the CLI from the root with `node packages/graph-execution/dist/cli.js`. `node packages/graph-execution/dist/cli.js manager` needs the full `npm run build`: the engine-only build removes `dist/manager`'s bundle, and the command then exits 2 with `graph-manager is not part of this build: run npm run build at the repository root`.

## License

MIT, see [LICENSE](LICENSE). Contributions are accepted under the [Contributor License Agreement](CLA.md).
