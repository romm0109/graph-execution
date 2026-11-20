# graph-execution

**Turn a spec into a reviewed, tested pull request.**

graph-execution plans a task graph from your PRD, runs coding agents in parallel in their own git worktrees, gates every task, then has a code reviewer and a live tester check the merged result before you open the PR. It works with Claude Code, Codex, OpenCode and Qwen Code, and runs on your machine.

Website: [graph-execution.com](https://graph-execution.com)

[![graph-execution showing a live task graph: tasks 2 to 7 running in parallel, then validate, code review, live test and fixer. Click to watch the 60-second demo.](docs/assets/demo-poster.jpg)](docs/assets/demo.mp4)

▶ [Watch the 60-second demo](docs/assets/demo.mp4)

## Why graph-execution

Most agent tools make code faster. graph-execution makes the result something you can merge.

- **Verified, not just generated.** Every task passes your gate (build, lint, tests) before it merges. Then a code reviewer and a live tester check the merged result against the spec, and a fixer handles blockers and majors.
- **Any agent.** Claude Code, Codex, OpenCode or Qwen Code, chosen per run.
- **Parallel by default.** Independent tasks run at the same time, each in its own git worktree. A task that depends on others starts after they have merged.
- **A web app for the whole loop.** `graph-execution manager` clones your repos, opens agent terminals, shows every run live and creates the pull request. The same app runs as a desktop app on macOS and Windows, and in a phone browser, where HTTPS lets you add it to the home screen.
- **Multi-repo runs and sandboxes.** A project runs one change across several repos of one forge: one feature per repo, a joint check, then one pull request per repo that changed. Agents can run in their own Docker container.

## Quick start

Node.js 20 or later.

```bash
npm install -g graph-execution && graph-execution manager
```

It listens on http://127.0.0.1:7420, prints a generated password saved in its data directory, and opens the browser.

**Use the CLI directly.** The same package is the engine you can run without the web app. The minimal run is in the [CLI quick start](packages/graph-execution/README.md#quick-start).

## How it works

1. Connect GitHub or GitLab with a personal access token, then clone a repository into a workspace.
2. Open a terminal in that workspace (Claude Code, Codex, OpenCode, Qwen Code, or a plain shell). Each workspace terminal works in its own git worktree and branch, so that terminal and the runs do not share a folder. Closing one that has commits or uncommitted edits asks **Delete**, **Keep** or **Create PR**.
3. Plan the tasks from a PRD in the terminal. The spec file opens beside the terminal when it is created. **Start run** takes that spec, the tasks folder and the branch to **Start from**.
4. Watch the run live. Independent tasks run at the same time, each agent in its own git worktree. A task that depends on others starts after those have merged. By default a validation gate runs on each task before it merges. When a task contradicts the spec or the code, or needs a product decision, the agent pauses that task and the tasks that depend on it and asks for a decision. The other tasks keep running. A task whose validation is still failing after its fix rounds pauses the same way. This is on unless you pass `--no-escalation` or set `"escalation": false`. See [Escalation](packages/graph-execution/README.md#escalation).
5. After every task has merged, and no decision is still open, one code reviewer and a live tester judge the whole result, then a fixer handles blockers and majors. That review runs once for the merged graph, not on each task. The review-phase fixer can pause for a decision too. Human review is off unless you turn it on in Start run, pass `--human-review`, or set `"humanReview": true`.
6. A workspace run leaves its result on `graph/<run-id>` and leaves the checkout as it was. **Create PR** (or **Create MR** on GitLab) pushes that branch and opens the pull request into the branch you pick under **Merge into**. If a step fails, it says why and offers **Retry**. A project run opens one pull request per repo that changed.

Agents run in full-auto mode with your user's permissions unless you run them in a sandbox ([sandboxed runs](apps/graph-manager/README.md#sandboxed-runs)).

## Built by itself

graph-execution is developed with graph-execution. Every feature started as a spec and shipped as a run: the specs are in [`docs/prd/done/`](docs/prd/done/), the task graphs in [`.agents/tasks/`](.agents/tasks/), and the workflow in [`CLAUDE.md`](CLAUDE.md).

## Docs

- [CLI documentation](packages/graph-execution/README.md)
- [Web app](apps/graph-manager/README.md)
- [Desktop app](apps/graph-manager-desktop/README.md)

## The web app

`graph-execution manager` is the web app. From the browser you connect GitHub or GitLab, clone repositories into workspaces, open terminals, follow every run, and open a pull request when a workspace run is `done`.

The quick start command prints the address it is listening on, then a password line, and opens the browser. With the defaults the address is http://127.0.0.1:7420.

When no password is saved yet, one is generated (24 random bytes, base64url) and written to `password` in the data directory (mode 600). Later starts read that file. Set `GM_PASSWORD` to a non-blank value to choose your own. A blank value counts as unset. A password taken from `GM_PASSWORD` is not written to the file. The flags are `--port`, `--host`, `--data-dir`, `--workspaces-dir`, `--tls-cert`, `--tls-key` and `--no-open`. On Linux, `npm install` compiles `node-pty` and needs Python 3, make and a C++ compiler; macOS and Windows get a prebuilt binary.

On a narrow screen the nav is a top bar with a menu, and a terminal is one pane. On a touch screen, tapping a terminal opens the phone keyboard, with Esc, Tab, Ctrl, the arrow keys and Ctrl-Space above it. Over HTTPS the app can be added to the home screen from Settings → **Install app**. Plain HTTP shows why that install is unavailable. See [HTTPS setup](apps/graph-manager/README.md#https-setup-phones-and-installing-the-app).

A desktop app for macOS and Windows runs the same app on your computer and logs in for you, or connects to a server on another machine. On this computer it uses the data folder `~/.graph-manager`. On the login page, **Switch server** returns to the mode picker. The installers are unsigned. Download the macOS `.dmg` files (arm64 and x64) and the Windows setup `.exe` from [GitHub Releases](https://github.com/romm0109/graph-execution/releases). A push to `main` that changes the version in `packages/graph-execution/package.json` tags `v<version>` and attaches those installers. See the [desktop app](apps/graph-manager-desktop/README.md).

The default data directory and the Docker image are under [Development](#development).

## Development

This repository is an npm workspaces monorepo.

| Workspace | What it is |
| --- | --- |
| [`packages/graph-execution`](packages/graph-execution/README.md) | The CLI engine, published to npm as `graph-execution` |
| [`apps/graph-manager`](apps/graph-manager/README.md) | The web app source, shipped inside the `graph-execution` npm package (`graph-execution manager`) and as a Docker image |
| [`apps/graph-manager-desktop`](apps/graph-manager-desktop/README.md) | The Electron desktop app for macOS and Windows: local mode with the bundled server, or remote mode against a server on another machine |
| [`apps/site`](apps/site/README.md) | The [graph-execution.com](https://graph-execution.com) landing site (Astro, static) |

`graph-execution manager` keeps its data in `~/.graph-manager` unless `GM_DATA_DIR` or `--data-dir` is set. The generated password is `~/.graph-manager/password`. Repositories are cloned under `~/graph-manager-workspaces` unless `GM_WORKSPACES_DIR` or `--workspaces-dir` is set.

The web app also ships as one Docker image, built from this repo:

```bash
docker build -f apps/graph-manager/Dockerfile -t graph-manager:dev .
docker run -d -e GM_PASSWORD='choose-a-password' -p 127.0.0.1:7420:7420 \
  -v gm-data:/data -v gm-workspaces:/workspaces graph-manager:dev
```

See [`apps/graph-manager/README.md`](apps/graph-manager/README.md) for configuration, setup, sandboxed runs and the security notes.

Run these at the repository root:

```bash
npm ci                              # install all workspaces
npm run typecheck                   # runs the build below, then type-checks every workspace
npm run lint                        # eslint over the whole repo
npm test                            # every workspace's tests
npm run build                       # build the engine, then the web app, then copy it into the engine's dist/manager
npm run build -w graph-execution    # build the engine into packages/graph-execution/dist
```

After a build, run the CLI from the root with `node packages/graph-execution/dist/cli.js`. `node packages/graph-execution/dist/cli.js manager` needs the full `npm run build`: an engine build on its own removes `dist/manager`, and the command then exits 2 with `graph-manager is not part of this build: run npm run build at the repository root`.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). Contributions are accepted under the [Contributor License Agreement](CLA.md).
