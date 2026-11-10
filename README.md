# graph-execution

<!-- logo here -->

Run a PRD as a dependency graph of tasks with your coding agents, in parallel git worktrees, then a review loop. The result lands as uncommitted changes on your branch.

[![npm](https://img.shields.io/npm/v/graph-execution)](https://www.npmjs.com/package/graph-execution)

<!-- demo gif here -->

This monorepo holds the `graph-execution` CLI (published to npm) and **graph-manager**, a self-hosted web app around it.

## Quick start (CLI)

You need:

- Node.js 20+
- git with a commit identity (`user.name` and `user.email`, or the `GIT_AUTHOR_*` / `GIT_COMMITTER_*` variables)
- one supported agent CLI on your `PATH`, installed and logged in: `claude`, `codex`, `opencode` or `qwen`

In the git repository you want to change, write a spec and one task:

```bash
mkdir -p tasks
printf '# Hello\n\nThe repo has a hello.txt file that says "Hello, world".\n' > PRD.md
cat > tasks/1.json <<'JSON'
{ "id": "1", "content": "Create hello.txt containing exactly: Hello, world" }
JSON
```

Run it:

```bash
npx graph-execution ./tasks --spec PRD.md --provider claude
```

Add `--web` to run it in the background and follow the live graph in your browser (`graph-execution open` brings the page back):

```bash
npx graph-execution ./tasks --spec PRD.md --provider claude --web
```

When it finishes, `git status` and `git diff` show the result. Commit it yourself, or drop it with the command the summary prints.

> **Safety:** agents run in full-auto mode with your user's permissions. This is not a sandbox, so only run tasks and specs you trust. See [Safety](#safety).

For real work, let your agent write the spec and the tasks: see [Agent skills](#agent-skills).

## How it works

- **Tasks folder → dependency graph.** Each `*.json` file in the folder is a task with an `id`, a Markdown `content` and optional `dependencies`. The graph is checked (duplicate ids, unknown dependencies, cycles) before any agent runs.
- **Parallel worktrees.** Independent tasks run in parallel, each in its own git worktree. Each finished task is merged into the integration branch `graph/<run-id>`, which unlocks the tasks that depend on it.
- **Review loop.** Once every task is merged, your `validate` commands run first, then a code reviewer and a live tester judge the result against your PRD in parallel. A fixer handles blockers and majors, for up to 3 fix passes.
- **Uncommitted changes on your branch.** A clean result is applied to the branch you started from as uncommitted changes (a `git merge --squash`). Nothing is committed or pushed. `--no-merge` keeps it on `graph/<run-id>` only.
- **Resumable.** `graph-execution --resume` continues an interrupted or aborted run; git is the source of truth for what was already merged.

Task format, `graph-execution.config.json`, reviewers files, test plans, suites, exit codes and the full option list are in the [CLI README](packages/graph-execution/README.md).

## Supported providers

One provider is used for every agent in a run, chosen with `--provider`:

| Provider | `--provider` | CLI |
| --- | --- | --- |
| Claude Code | `claude` | `claude` |
| Codex | `codex` | `codex` |
| OpenCode | `opencode` | `opencode` |
| Qwen Code (0.6 or later) | `qwen` | `qwen` |

graph-execution stores no credentials; it uses the CLI's own login. Extra flags for a CLI go in `GRAPH_EXECUTION_CLAUDE_ARGS`, `GRAPH_EXECUTION_CODEX_ARGS`, `GRAPH_EXECUTION_OPENCODE_ARGS` or `GRAPH_EXECUTION_QWEN_ARGS`.

## Agent skills

```bash
npx graph-execution install skills                 # → .agents/skills/
npx graph-execution install skills --target claude # → .claude/skills/ (Claude Code project skills)
npx graph-execution install skills --target both
```

This copies three skills into the current directory (`--force` overwrites existing ones):

- **`to-spec`** writes the PRD to `docs/prd/<name>.md`, with a Mermaid diagram of the workflow, and asks you to approve it.
- **`to-tasks`** explores the code and turns a PRD into a task folder and a test plan, then checks the folder with a bundled validator.
- **`run-graph`** starts the run (`graph-execution … --web`) and stops; the web page does the monitoring.

## graph-manager

graph-manager is a self-hosted web app around the engine, in [`apps/graph-manager`](apps/graph-manager/README.md). It runs in Docker: one image with git, the `graph-execution` CLI and the Claude Code CLI, running as a non-root user. It is single-user, behind one admin password.

<!-- graph-manager demo here -->

What you can do from one browser tab:

- **Settings:** connect GitHub (or GitHub Enterprise) or GitLab with a personal access token, manage the sandbox image recipe, and pick a theme.
- **Workspaces:** clone repositories into workspaces and see each one's branch, clean/dirty state and runs.
- **Terminals:** open terminals in a workspace with Claude Code, Codex, OpenCode or Qwen Code already running and connected to graph-manager's tools, or a plain shell. Up to 4 split panes; a spec the agent writes opens live in a floating pane.
- **Runs:** start a run from the **Start run** form, follow every run on a dashboard, and open a run's live page embedded in its detail view, with abort, retry and human review.
- **Reviewers:** keep one list of reviewers that every run graph-manager starts uses.
- **Create PR:** once a run is applied, commit, push and open the pull request (or merge request on GitLab) from the run page. The run's spec moves to `docs/prd/done/` in that commit.
- **Sandboxed runs** (optional): run the engine and its agents in a Docker container of their own, one per run.

### Install and start

With Docker Compose, from `apps/graph-manager`:

```bash
GM_PASSWORD='choose-a-password' docker compose up --build
```

Or with plain Docker, from the repository root:

```bash
docker build -f apps/graph-manager/Dockerfile -t graph-manager:dev .
docker run -d --name graph-manager \
  -e GM_PASSWORD='choose-a-password' \
  -e GIT_AUTHOR_NAME='Ada Lovelace' -e GIT_AUTHOR_EMAIL=ada@example.com \
  -e GIT_COMMITTER_NAME='Ada Lovelace' -e GIT_COMMITTER_EMAIL=ada@example.com \
  -p 127.0.0.1:7420:7420 \
  -v gm-data:/data -v gm-workspaces:/workspaces \
  graph-manager:dev
```

Then open <http://127.0.0.1:7420> and log in with `GM_PASSWORD`. Paste a forge token in **Settings**, clone a repository in **Workspaces**, and open a terminal from **Terminals**. The `claude` login is kept on the `/data` volume and survives restarts.

The compose file publishes port 7420 on all interfaces and mounts the host's Docker socket for sandboxed runs, which gives graph-manager root-equivalent access to the host. To turn sandboxes off, remove the socket and `group_add` lines from it.

Configuration (env vars), first steps, sandboxes, keyboard shortcuts and security notes: [graph-manager README](apps/graph-manager/README.md). Design notes: [docs/wiki/features/graph-manager.md](docs/wiki/features/graph-manager.md).

## Safety

- **Agents run in full-auto mode** in their worktree: `claude --dangerously-skip-permissions`, `codex exec --dangerously-bypass-approvals-and-sandbox`, `opencode run --auto`, `qwen --yolo`. **This is not a sandbox.** Agents can run arbitrary commands with your user's permissions, so only run tasks and specs you trust.
- The tool never pushes and never commits on your current branch. A clean run leaves its result there as uncommitted changes.
- **Human review is optional and off by default.** With `--human-review` (or `"humanReview": true` in `graph-execution.config.json`), the run pauses in the web view before applying, so you can comment, request changes, apply or drop. Without it, a clean result is applied as soon as the review loop ends.
- Logs are not redacted. Don't put secrets in task files, `TESTING.md` or the spec.
- graph-manager's terminals are shells with full permissions inside the container. Bind its port to `127.0.0.1` or put it behind a VPN or a TLS reverse proxy, and use a strong `GM_PASSWORD`.

## Repo layout

npm workspaces:

| Path | What it is |
| --- | --- |
| [`packages/graph-execution`](packages/graph-execution/README.md) | The CLI and engine, published to npm as `graph-execution`. Full user docs. |
| [`apps/graph-manager`](apps/graph-manager/README.md) | The self-hosted web app, shipped as a Docker image. |
| [`docs/wiki`](docs/wiki/index.md) | Feature pages: the decisions behind each feature and the code references. |

## Contributing

Run these at the repository root:

```bash
npm ci                              # install all workspaces
npm run typecheck                   # builds the engine, then type-checks every workspace
npm run lint                        # eslint over the whole repo
npm test                            # every workspace's tests
npm run build -w graph-execution    # build the engine into packages/graph-execution/dist
```

After a build, run the CLI from the root with `node packages/graph-execution/dist/cli.js`. CI runs the same checks on Ubuntu, macOS and Windows (`.github/workflows/qa.yml`).

## License

MIT, see [LICENSE](LICENSE).
