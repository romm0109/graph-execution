# Contributing to graph-execution

Thank you for wanting to contribute. This repository is an npm workspaces monorepo. By opening a pull request, you agree to the [Contributor License Agreement](CLA.md). You keep the copyright in your work. The agreement lets the maintainer ship your contribution under the project's [MIT License](LICENSE), and under other licenses (including commercial ones) in the future.

Please also follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Monorepo layout

| Workspace | Path | What it is |
| --- | --- | --- |
| `graph-execution` | [`packages/graph-execution`](packages/graph-execution/README.md) | The open-source CLI, published to npm as `graph-execution` |
| `graph-manager` | [`apps/graph-manager`](apps/graph-manager/README.md) | The web service around the engine, shipped inside the `graph-execution` npm package (`graph-execution manager`) and as a Docker image |

User documentation for the CLI lives in [`packages/graph-execution/README.md`](packages/graph-execution/README.md). The root [`README.md`](README.md) is a short monorepo index: it points at the CLI and at `graph-execution manager`, and lists the development commands below.

## Prerequisites

From the root `package.json` `engines` field, both workspace `package.json` files, and the CLI README:

- **Node.js 20 or later.** Continuous integration (`.github/workflows/qa.yml`) uses **Node 22**. There is no `.nvmrc` or `packageManager` field in the repo.
- **npm.** This is an npm workspaces monorepo (`workspaces`: `packages/*`, `apps/*`) with a root `package-lock.json`. The documented install command is `npm ci`.
- **git**, with a commit identity. The CLI README requires `git config --global user.name` and `user.email` (or `GIT_AUTHOR_*` / `GIT_COMMITTER_*`) because every agent commits. The `qa` workflow also sets `user.email` / `user.name` before tests. You will need an identity for tests that create repositories.

You do **not** need a provider CLI (`claude`, `codex`, `opencode`, `qwen`) or a login for the automated tests: they use a fake provider.

Optional, only for the work they cover:

- **Docker**, to build or run the graph-manager image, or to run `bash apps/graph-manager/scripts/docker-smoke.sh` (not part of `npm test`).
- **tmux**, to inspect the engine's terminal (Ink) UI as described in [`TESTING.md`](TESTING.md).
- **[agent-browser](https://www.npmjs.com/package/agent-browser)**, for the manual web-UI checklists in `TESTING.md` and for `bash apps/graph-manager/scripts/ui-smoke.sh` (also not part of `npm test`).

## Local setup

From the repository root:

```bash
git clone https://github.com/romm0109/graph-execution.git
cd graph-execution
npm ci
```

The root README also documents these development commands, all run at the repository root:

```bash
npm run typecheck                   # full root build (engine, graph-manager, bundle), then type-checks every workspace
npm run lint                        # eslint over the whole repo
npm test                            # every workspace's tests
npm run build -w graph-execution    # build the engine into packages/graph-execution/dist
```

`npm run typecheck` is `npm run build && npm run typecheck --workspaces --if-present`. `npm run build` builds the engine, then graph-manager, then copies graph-manager into the engine's `dist/manager`. `npm test` is `npm test --workspaces --if-present` (Vitest in each workspace: `vitest run`).

To typecheck, lint, and test only graph-manager, the graph-manager README also lists:

```bash
npm run typecheck && npm run lint && npm test -w graph-manager
```

There is **no** repo-level format script (no Prettier, Biome, or `npm run format`). Style is whatever ESLint reports via `npm run lint`. The config is [`eslint.config.js`](eslint.config.js).

The CLI package README's Development section also shows `npm install` (instead of `npm ci`) and `npm run build && npm pack --dry-run` from a context that packs the engine. For day-to-day work in this monorepo, prefer the root commands above, which match CI.

## How CI tests your change

[`.github/workflows/qa.yml`](.github/workflows/qa.yml) is the only workflow. It runs on `push`, `pull_request`, and `workflow_dispatch`, on `ubuntu-latest`, `macos-latest`, and `windows-latest` (`fail-fast: false`). Each matrix job is named `qa` and shows up on GitHub as these check names:

- `qa (ubuntu-latest)`
- `qa (macos-latest)`
- `qa (windows-latest)`

After checkout and Node 22 setup it runs:

```bash
git config --global user.email ci@ci && git config --global user.name ci
npm ci
npm run typecheck
npm run lint
npm test
```

Please run those same three npm scripts locally before you open a pull request.

## Try the CLI locally

After a build, the root README says to run the CLI from the repository root with:

```bash
npm run build -w graph-execution
node packages/graph-execution/dist/cli.js
```

For example, `node packages/graph-execution/dist/cli.js --help`.

To exercise a run without a real provider or a login, follow [`TESTING.md`](TESTING.md): always test the build in this checkout (not a global `graph-execution`), and **run it in a fresh temporary git repository, never in this worktree** — a run writes `.graph-execution/` and applies changes to the branch.

```bash
npm run build -w graph-execution
CLI="$PWD/packages/graph-execution/dist/cli.js"
FIX="$PWD/packages/graph-execution/src/__fixtures__"

REPO=$(mktemp -d) && git -C "$REPO" init -q -b main && git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init

# --provider fake needs no login and costs nothing
node $CLI $FIX/diamond --spec $FIX/spec.md --provider fake
```

`--provider fake` is also what the automated tests use (scripted through `GRAPH_EXECUTION_FAKE_SCRIPT` when a specific state is needed). See `TESTING.md` and `packages/graph-execution/src/providers/fake.ts` for hang/fail scripts, the terminal UI (tmux), and the web view (`--web`).

### Safety when you run the real CLI

From the CLI README: **agents run in full-auto mode with your user's permissions. This is not a sandbox.** Only run tasks and specs you trust. The fake provider above does not start a real agent. A real `--provider claude` / `codex` / `opencode` / `qwen` run will. The tool itself never pushes and never commits on your current branch; a clean run leaves the result as uncommitted changes (unless you pass `--no-merge`).

## Try graph-manager locally

From the graph-manager README, at the repository root:

```bash
npm ci
npm run build
node packages/graph-execution/dist/cli.js manager --no-open   # http://127.0.0.1:7420
```

`npm start -w graph-manager` starts the same server from `apps/graph-manager/dist` after `npm run build -w graph-manager`. Neither start requires `GM_PASSWORD`. When it is unset or blank, a password is generated, saved in the data dir's `password` file, and printed. Set `GM_PASSWORD` to choose one; that value is not written to the file. `graph-execution manager` needs the full root build: `npm run build -w graph-execution` alone leaves out `dist/manager`, and the command then exits 2 with `graph-manager is not part of this build: run npm run build at the repository root`.

For UI hot reload, keep that server running and start `npx vite` in `apps/graph-manager` (Vite proxies `/api` and `/runs` to port 7420).

Manual and browser-driven checks (fake forge, clone, a fake run, Create PR) are in [`TESTING.md`](TESTING.md) and `bash apps/graph-manager/scripts/ui-smoke.sh`. Those are **not** part of `npm test`. If `npm ci` was run with `NODE_ENV=production` and tests fail to find Vitest, `TESTING.md` says to use `npm ci --include=dev`.

## Branch and pull request conventions

- `development` is the integration branch. Branch from the latest `development` and open your pull request against it: `feat/<short-slug>`, `fix/<short-slug>`, `docs/<short-slug>`, or `ci/<short-slug>`.
- `main` holds released code. Only the maintainer merges `development` into `main`, to cut a release.
- Prefer a conventional PR title (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`), with the workspace in parentheses when the change is graph-manager-only, for example `fix(graph-manager): …`. A ticket key in the title is optional and **not required** of external contributors.
- Keep the PR focused. Fill in the pull request template. Wait for the three `qa (…)` checks to pass.
- There is no required commit-message hook or linter in the repo.

## Releases

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs the `qa` checks on every push to `main` and `development`, then publishes `packages/graph-execution` to npm:

| Branch | npm version | dist-tag | Install with |
| --- | --- | --- | --- |
| `development` | `<next>-dev.<run>.<sha>`, for example `2.0.4-dev.12.abc1234` | `dev` | `npm i -g graph-execution@dev` |
| `main` | the `version` in `packages/graph-execution/package.json` (plus a `v<version>` git tag) | `latest` | `npm i -g graph-execution` |

On `main`, nothing is published when that version is already on npm. To release, bump the version on `development` (`npm version <patch|minor|major> --no-git-tag-version -w graph-execution`), then merge `development` into `main`.

Publishing uses npm trusted publishing (OIDC), so the repository holds no npm token. It is set up once on npmjs.com, under the package's Settings → Trusted publisher: GitHub Actions, repository `romm0109/graph-execution`, workflow `publish.yml`.

## Where to ask questions

Open a GitHub issue. Use the bug or feature templates when they apply, or a blank issue for a question.

GitHub Discussions are not enabled on this repository today. If they are turned on later, that will be a better place for "how do I…?" questions.

Please do not open a PR that only reformats unrelated files, and please do not commit secrets. CLI run logs are not redacted.

## License

[MIT](LICENSE). Copyright (c) 2026 romm0109. Contributions are accepted under the [Contributor License Agreement](CLA.md).
