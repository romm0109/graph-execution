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
