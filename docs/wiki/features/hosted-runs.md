# Hosted runs: every run of a remote session in its own run container, ending in a PR

When a session's host is remote (a Docker or hosted session), `POST /api/runs/:ws` no longer runs the engine in the session. It pushes the session branch, asks the provisioner for a run container (`acquireRun`), clones the session branch there and starts the engine in it. A background monitor (`HostedRuns`) watches the run; once it ends it opens the PR(s) from inside the container (when `applied`), archives the run (row and folder blob) and releases the container. Local hosts keep the old behaviour (the "Run in sandbox" toggle and local Docker sandboxes of KAN-88).

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| A remote session is detected from the user's session record on the workspace id and `host.kind === "remote"`, before the local home lookup. | A remote session's clone is not on the control plane's disk, so `resolveRunHome` cannot find it. | hosted-sessions |
| `sandbox` in the body is ignored; the drawer hides the toggle when `GET /api/workspaces/:id/inspect` answers `hosted: true`. | Every hosted run is sandboxed: it has its own container. | hosted-sessions |
| The session branch is pushed (`pushBranch`) before the run, and the run clones it (`prepare({ branch: { existing } })`). A failed push answers 409 `Could not push <branch> before the run: <error>`. | The run starts from the last pushed commit; uncommitted changes stay in the session (the drawer warns about them). | hosted-sessions |
| `GM_MAX_RUN_CONTAINERS` counts the user's `hostedRuns` records in `starting`, `running` or `finishing`; at the cap: 409 `You have N sandboxed runs. Wait for one to finish or stop it.` | One limit per user, from the stored records, so it holds across restarts. | hosted-sessions |
| Create PR of an applied run is the existing `startPr` through the run container's host (branch `gm/<runId>`, base = the session branch, spec to `docs/prd/done/`). | No second PR implementation; the session's files are never touched. | hosted-sessions |
| A project run: one run container prepared with `prepare({ project, branch: { existing } })`; the project folder's inputs (specs, tasks, contract, test plan) are copied from the session and committed; on `applied` the agent commits and pushes `gm/<runId>` in each changed repository (`POST /agent/v1/project-pr`), then the control plane opens one PR per repository into the session branch and links their bodies (`## Related PRs`). | The project folder is not on any forge; forge calls and the PR index stay on the control plane, git stays in the container. | hosted-sessions |
| The run owner's reviewers file is written into the run container (`.graph-execution/gm-reviewers.json`, `POST /agent/v1/write-files`) and passed as `GRAPH_EXECUTION_REVIEWERS`. | Hosted runs use the user's reviewers, as local runs do. | hosted-sessions |
| The archive's folder blob comes from `POST /agent/v1/run-folder` (files of `.graph-execution/<runId>`, no `worktrees/`, no `.git`, 50 MB cap) plus `gm-detail.json`. | The host API lists files of one folder only; one call returns the whole run folder. | hosted-sessions |
| If opening the PR fails, `prError`, `prTitle` and `prBody` are kept and the container is released anyway; `POST …/pr` later only calls the forge again for `gm/<runId>`. | The branch is already pushed; the container is not needed for a retry. | hosted-sessions |
| A run with `--web` stays open after a failed task (retry on its page); the monitor ends it only when it is `applied`, `done`, `failed`, `aborted`, or `interrupted` with no process left. | The user can still retry the task in the run page of the container. | hosted-sessions |
| A session's end waits while one of its hosted runs is active (`SessionManager` option `hostedRunLive`). | Closing the last terminal must not release a session whose run is still going. | hosted-sessions |
| After a control-plane restart, `GET /api/runs` and `POST /api/runs/:ws` reattach the user's active runs (`acquireRun` is idempotent for a running container); a run that cannot be reattached is marked `failed` and released. | Runs outlive the control plane process. | hosted-sessions |

## Known follow-ups

- A run that stays open on its page (a failed task waiting for a retry) keeps its container until it is closed from the page; there is no idle limit for run containers yet.
- `RemoteWorkspaceHost.writeFiles`, `runFolder` and `commitProjectRun` are not on the `WorkspaceHost` interface; a non-remote run host gets no reviewers file and a flat archive.
- Retrying Create PR for a project run re-opens only the PRs of repositories that were pushed.

## Code references

- `apps/graph-manager/src/server/hosted-runs.ts`: `HostedRuns` (`startRun`, `tick`, `finish`, `reattach`, `retryPr`), `endedStatus`.
- `apps/graph-manager/src/server/hosted-project-pr.ts`: `commitProjectRun` (the agent's half of a project Create PR).
- `apps/graph-manager/src/server/routes/runs.ts`: `remoteSessionOf`, `startHosted`; the listing and detail of live hosted runs.
- `apps/graph-manager/src/server/routes/pr.ts`: `hostedPrStatus` and the retry.
- `apps/graph-manager/src/server/proxy.ts`: the run page of a live hosted run through `viewTarget`.
- `apps/graph-manager/src/server/agent/server.ts`: `/write-files`, `/run-folder`, `/project-pr`.
- `apps/graph-manager/src/server/store.ts`: `hostedRuns`; `config.ts`: `GM_MAX_RUN_CONTAINERS`.
- `apps/graph-manager/src/web/pages/StartRunDrawer.tsx`: no toggle and the uncommitted-changes warning for hosted sessions.
- Tests: `apps/graph-manager/src/server/hosted-runs.test.ts`, `apps/graph-manager/src/web/pages/StartRunDrawer.test.tsx`.
