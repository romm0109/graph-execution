# graph-execution monorepo

This repository holds the graph-execution engine and the apps built around it, as npm workspaces.

| Workspace | What it is |
| --- | --- |
| [`packages/graph-execution`](packages/graph-execution/README.md) | The open-source CLI, published to npm as `graph-execution` |
| [`apps/graph-manager`](apps/graph-manager/README.md) | The web service around the engine, shipped as a Docker image |

The engine's user documentation lives in [`packages/graph-execution/README.md`](packages/graph-execution/README.md).

## graph-manager

graph-manager is a web service around the engine. It connects GitHub or GitLab, clones repositories into workspaces, opens terminals to run `claude` and `graph-execution`, shows every run on a dashboard and opens a PR from an applied run. It ships as one Docker image:

```bash
docker build -f apps/graph-manager/Dockerfile -t graph-manager:dev .
docker run -d -e GM_PASSWORD='choose-a-password' -p 127.0.0.1:7420:7420 \
  -v gm-data:/data -v gm-workspaces:/workspaces graph-manager:dev
```

See [`apps/graph-manager/README.md`](apps/graph-manager/README.md) for the configuration, the first steps and the security notes.

## Development

Run these at the repository root:

```bash
npm ci                              # install all workspaces
npm run typecheck                   # builds the engine, then type-checks every workspace
npm run lint                        # eslint over the whole repo
npm test                            # every workspace's tests
npm run build -w graph-execution    # build the engine into packages/graph-execution/dist
```

After a build, run the CLI from the root with `node packages/graph-execution/dist/cli.js`.

## License

MIT, see [LICENSE](LICENSE).
