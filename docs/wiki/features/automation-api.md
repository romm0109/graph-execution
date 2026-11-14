# Automation API: runs from plain content, API tokens, /api/v1 and extensions (AA-01 … AA-22)

## Summary

A run can now start from free markdown instead of a spec and a task folder. `graph-execution --content <file>` adds a plan stage to the run: a planner agent checks whether the content is ready, then writes a spec and tasks with the bundled `to-spec` and `to-tasks` skills. The engine checks them and commits them as `Plan: <name>`, then stops for approval or runs them. graph-manager exposes this to other programs through API tokens and a versioned API under `/api/v1`: start a run from content, poll it, approve or reject its plan, resume, abort and open its PR. A new **Approvals** page lists the plans that wait. An extension slot (`GM_EXTENSIONS`) shows another service's UI inside graph-manager, in an iframe behind a login-protected proxy.

- Spec: `docs/prd/automation-api.md` (moved to `docs/prd/done/` when the PR is opened).
- Tasks: `.agents/tasks/automation-api/`.
- User docs: "Starting from plain content", the options table, "Exit codes" and "Resume" in `packages/graph-execution/README.md`; "Automation API" in the root `README.md`; "Configuration", "The app", "Automation API", "Extensions" and "Security" in `apps/graph-manager/README.md`; the fake planner, "Automation API (`/api/v1`)" and "Extensions" in `TESTING.md`.

These ids are not Jira tickets: the work was agreed with the user in conversation.

## Decisions

| Decision | Why | Id |
| --- | --- | --- |
| The input is free markdown (`--content <file>`, API `content`) plus optional refs (`--refs <file>`, API `refs`), a JSON array `[{ref, url?, title?}]`. There is no ticket schema. | Any tracker or a person can send it. Refs are the only structure needed: to drop one unclear item, to link the run, to find it again. | AA-01 |
| Without refs the content is one unit: the planner's result is `{ name, ready: boolean, questions }`, so either all of it is planned or the run ends `needs-info`. With refs it is `{ name, ready: [refs], notReady: [{ref, questions}] }`; the refs that are not ready go to `plan.dropped` and the run goes on with the rest. | Without refs there is nothing to drop by. | AA-02 |
| Planning is the first stage of the same run: same run id, same `graph/<run-id>` branch, same run page. The planner runs in the run's integration worktree. | One call starts everything. The client and the run page see one lifecycle. | AA-03 |
| `runStatusSchema` has three new statuses: `planning`, `needs-info`, `awaiting-approval`. The run's `state.json` has a `plan` object (`contentPath`, `refs`, `gate`, `name`, `attempts`, `questions`, `dropped`, `feedback`, `error`). | The client and graph-manager read where the run is from `state.json`, as before. | AA-04 |
| At `awaiting-approval` the process exits with `EXIT_AWAITING_APPROVAL` (5). `--resume --run <id> --approve-plan` runs the plan; `--resume --run <id> --replan <file>` resets `graph/<run-id>` to the starting commit, adds the feedback to `plan.feedback` and plans again with all the feedback so far. `--resume` without either flag is a usage error that names both. With `--web` the run page closes too. | An approval can take days. A waiting process or sandbox container would hold resources the whole time. Resume, sandbox resume included, already exists. | AA-05 |
| `needs-info` is final: the process exits with `EXIT_NEEDS_INFO` (4), the questions are in `plan.questions`, and `--resume` refuses the run. | The client asks the questions and starts a new run when the content changes. | AA-06 |
| The gate is on by default. The engine flag is `--no-plan-gate`; the API field is `gate: "approve" \| "auto"` (default `approve`). | Keep a human in the loop until the plans are trusted. | AA-07 |
| The planner is a new agent role, `planner`. Its prompt is a headless preamble ("you run unattended… never ask"), then the texts of the bundled `to-spec` and `to-tasks` skills, the content, the refs, the names already in use and any rejected-plan feedback. | One source for "how to write a spec and tasks", shared by humans in terminals and by the engine. | AA-08 |
| The engine checks the planned spec and tasks with the same `checkSpec`, `loadTasks`, `validateGraph` and `loadTestPlan` as a normal start. On an error the planner runs again with the error in its prompt, up to `planAttempts` rounds (config key, default 3; `--plan-attempts <n>` for one run). After the last round the run ends `failed` with `plan.error`. | A broken task folder must not reach `awaiting-approval`. | AA-09 |
| The planned files go in `docs/prd/<name>.md` and `.agents/tasks/<name>/`, committed on the integration branch as `Plan: <name>`. `<name>` comes from the planner, kebab-case. A name already used in `docs/prd/`, `docs/prd/done/` or `.agents/tasks/` is rejected (`name <name> is taken: use <name>-2`) and the planner tries again. | It's the same layout as the manual flow, so the result looks the same, and agents only see committed files. | AA-10 |
| The input hashes (`hashes`) are written after the plan commit. A run killed in `planning` (or interrupted there, `aborted` without hashes) plans again from scratch on `--resume`, keeping `plan.feedback`. | No spec or tasks exist to hash before planning. | AA-11 |
| Tokens are `gmt_` plus 32 random bytes in base64url. graph-manager stores only their SHA-256 hash (`apiTokens` in `graph-manager.json`), compares it in constant time over every entry, and shows the plain token once. `lastUsedAt` is written at most once a minute. | A leaked `graph-manager.json` must not leak working tokens. | AA-12 |
| Bearer tokens work only on `/api/v1/*`. There they replace the cookie and skip the Origin check. Elsewhere the header is ignored (a token alone gets `401 login required`). A cookie session also works on `/api/v1`, with every scope. The token admin routes `/api/tokens` are cookie only. | Browsers don't send a bearer token across sites by themselves, so the Origin check (CSRF) isn't needed for it. The old `/api/*` stays cookie-only. | AA-13 |
| Scopes: `runs:start`, `runs:read`, `runs:approve`, `runs:control`, `runs:pr`, `workspaces:read`. A missing scope answers `403 {"error":"missing scope <scope>"}`; a wrong or revoked token `401 {"error":"invalid token"}`. `GET /api/v1/ping` needs no scope. | A poller doesn't need `runs:approve`. | AA-14 |
| One implicit tenant. A token record keeps `createdBy: "admin"`, and an API run records `startedBy` (the token id, or `admin`). | graph-manager has one user. Users can be added later without breaking v1 clients. | AA-15 |
| `sandbox` defaults to `true` on `POST /api/v1/workspaces/:ws/runs`. | Unattended runs must not touch a human's checkout or each other. A client may pass `false` (tests, laptops without Docker). | AA-16 |
| `provider` defaults to the workspace's saved Start run provider (`runDefaults[ws].provider`), else `400 {"error":"no provider: pass provider or start a run in this workspace once"}`. | This is the "configured main provider". | AA-17 |
| `openPr: true` makes graph-manager run the existing Create PR job, with the suggested values, once the run is `applied`. A loop checks every 15 s (`AUTO_PR_MS`). It tries once per run; a failure is kept as `prError` on the run object and not retried. | Reuses `apps/graph-manager/src/server/pr.ts`. The PR branch stays `gm/<runId>`. | AA-18 |
| `idempotencyKey`: a second start with the same key in the same workspace answers `200` with the first run's object, not a new run, while that run's folder exists. Two concurrent requests with one key start one run. | A client that retries after a timeout doesn't start a duplicate run. | AA-19 |
| Progress is polled (`GET /api/v1/runs/:id`, `GET /api/v1/runs?workspace=&status=&ref=`). No webhooks in v1. | Clients run on a schedule anyway. | AA-20 |
| The extension UI is an iframe of `/ext/<name>/` at the client route `/x/<name>`, which graph-manager proxies (HTTP and WebSocket) to the URL in `GM_EXTENSIONS`. There is no Module Federation. | No build coupling between repositories. It reuses the run-page proxy pattern (GM-07). | AA-21 |
| Every proxied extension request carries `X-GM-Extension-Secret: <GM_EXTENSION_SECRET>`, `X-GM-User: admin` and `X-Forwarded-Prefix: /ext/<name>`; graph-manager's cookie is never forwarded. `GM_EXTENSIONS` without `GM_EXTENSION_SECRET` stops startup. The secret is removed from the environment of terminals and of started runs. | The extension can tell graph-manager's requests from anyone else's, and an agent in a terminal can't read the secret. | AA-22 |

## Known follow-ups

Out of scope for v1 (the spec's non-goals):

- Webhooks or push events: clients poll.
- Multiple users, per-user tokens, SSO.
- Module Federation, or extension widgets inside graph-manager's own pages.
- Licensing or premium checks.
- Custom PR branch names: the auto PR always uses `gm/<runId>`.

Where the code differs from the spec:

- The run object's `pr` is `{ url, number }` (the spec shows only `url`), and it has a `prError` field for a failed auto PR.
- `GET /api/v1/ping` (any valid token, no scope) is not in the spec; clients use it to check a token.
- The extension proxy also sends `X-Forwarded-Prefix: /ext/<name>`, not in the spec.
- The `/ext/<name>/*` routes exist even without `GM_EXTENSIONS`; they answer `404 {"error":"unknown extension"}`. The spec says "no route". The nav item and `/x/<name>` are absent as specified.
- v1 has no `interrupted` status: a run whose process is gone is reported as `failed` (with `error: "interrupted: the run's process is gone"`) and can be resumed.
- `POST /api/v1/runs/:id/abort` works only on a live run (`409 the run is not live`), and answers `502` when the run's page does not answer.
- `--replan` resets the integration branch to the run's starting commit instead of removing the plan commit's files one by one. The result is the same for a run that has only the plan commit.
- A run whose planning failed after `planAttempts` rounds is `failed` and can't be resumed (`planning did not finish (…); start a new run with --content`); the API's `resume` answers with the engine's error.
- `--content` with `--sandbox` works only from a graph-manager terminal, like any `--sandbox` run.
- A sandboxed run's content, refs and feedback are also copied into `<ws>/.graph-execution/<runId>/inputs/`, because a sandbox can't see graph-manager's data dir.

Open points:

- The `idempotencyKey` registry (`apiRuns`) is never pruned; an entry stops matching only when its run folder is deleted (`graph-execution clean`).
- `POST /api/v1/runs/:id/reject` writes each feedback to `<dataDir>/inputs/<runId>/feedback-<time>-<random>.md` (a new file each time, never overwritten); these files are not cleaned up with the run.
- The review and tester notes of this feature's graph-execution run were not available when this page was written; check `.graph-execution/<run-id>/run.log` of the run and add anything left open here.

## Code references

Engine (`packages/graph-execution/src/`):

- `packages/graph-execution/src/cli.ts`: the options `--content`, `--refs`, `--no-plan-gate`, `--plan-attempts`, `--approve-plan`, `--replan`; `runPlannedGraph`, `serveWeb` (closes the page at exit 4 and 5).
- `packages/graph-execution/src/launch/preflight.ts`: `preflightPlan`, `readRefsFile`, `preflightResume` (the usage errors of the plan flags and of resume).
- `packages/graph-execution/src/runner/run.ts`: `runPlanned`, `planAndContinue` (the planner rounds, `needs-info`, the gate), `resume`, `replan`.
- `packages/graph-execution/src/plan/stage.ts`: `planStage` (one planner round, the checks, the `Plan: <name>` commit), `takenPlanNames`.
- `packages/graph-execution/src/plan/prompt.ts`: `plannerPrompt`, `validateTasksScript`.
- `packages/graph-execution/src/plan/result.ts`: `unitResultSchema`, `refsResultSchema`, `readPlanResult`.
- `packages/graph-execution/src/plan/paths.ts`: `planResultPath`, `planContentPath`, `planSpecRel`, `planTasksRel`, `runInputs`.
- `packages/graph-execution/src/plan/view.ts`: `planView` (the run page's plan stage).
- `packages/graph-execution/src/state/state.ts`: `runStatusSchema`, `planRefSchema`, `planStateSchema`.
- `packages/graph-execution/src/state/errors.ts`: `EXIT_NEEDS_INFO`, `EXIT_AWAITING_APPROVAL`.
- `packages/graph-execution/src/config/config.ts`: `planAttempts`.
- `packages/graph-execution/src/providers/types.ts`: the `planner` role.
- `packages/graph-execution/src/providers/fake.ts`: `fakeReadiness`, `fakePlan`, `FAKE_PLAN_NAME`.

graph-manager (`apps/graph-manager/src/`):

- `apps/graph-manager/src/server/tokens.ts`: `API_SCOPES`, `newToken`, `hashToken`, `findToken`.
- `apps/graph-manager/src/server/auth.ts`: `needsAuth`, `needsSameOrigin`, `bearerOf`, `requireScope`, `apiAuthOf`, the bearer branch of the auth hook.
- `apps/graph-manager/src/server/store.ts`: `apiTokens`, `apiRuns`.
- `apps/graph-manager/src/server/routes/tokens.ts`: `tokenRoutes`, `listTokens` (`/api/tokens`).
- `apps/graph-manager/src/server/routes/v1.ts`: `v1Routes` (every `/api/v1` route), `NO_PROVIDER`.
- `apps/graph-manager/src/server/v1-runs.ts`: `V1_STATUSES`, `v1StatusOf`, `findRun`, `toRunObject`.
- `apps/graph-manager/src/server/run-actions.ts`: `approveRun`, `rejectRun`, `resumeApiRun`, `abortRun`, `startApiRunPr`, `runActionRoutes` (the UI's approve and reject).
- `apps/graph-manager/src/server/autopr.ts`: `autoPrTick`, `startAutoPr`, `AUTO_PR_MS`.
- `apps/graph-manager/src/server/inputs.ts`: `writeRunInputs`, `inputsDirOf`.
- `apps/graph-manager/src/server/start-run.ts`: `startEngine` (shared with Start run).
- `apps/graph-manager/src/server/runoptions.ts`: `contentArgs`, `RESERVED_FLAGS`.
- `apps/graph-manager/src/server/routes/plan.ts`: `GET /api/runs/:ws/:runId/plan` (the planned spec and tasks, read from `graph/<runId>`).
- `apps/graph-manager/src/server/config.ts`: `parseExtensions`, `loadConfig` (`GM_EXTENSIONS`, `GM_EXTENSION_SECRET`).
- `apps/graph-manager/src/server/extensions.ts`: `extensionRoutes` (`GET /api/extensions`, the `/ext/<name>/*` proxy).
- `apps/graph-manager/src/web/pages/Approvals.tsx`: the Approvals page.
- `apps/graph-manager/src/web/pages/TokensCard.tsx`: Settings → API tokens.
- `apps/graph-manager/src/web/pages/Extension.tsx`, `apps/graph-manager/src/web/Shell.tsx`: `/x/<name>` and the nav items (Approvals badge, extensions).
- `apps/graph-manager/src/web/ui/RefLinks.tsx`, `apps/graph-manager/src/web/ui/status.ts`, `apps/graph-manager/src/web/pages/RunDetail.tsx`: refs as links, the new status chips, the `needs-info` questions.

## Related

- [graph-manager](graph-manager.md)
- [Sandboxed runs](sandboxes.md)
- [Run options in Start run](run-options.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-13
