# Hosted sessions: repo sessions, a workspace agent, gateway sign-in and session limits

## Problem

A hosted, commercial graph-execution is planned in a separate private repository (`romm0109/graph-execution-commercial`). Anyone can register there, and paid features (for example the Jira service, KAN-96) live there. The chosen hosting design is **one shared control plane, and one sandbox container per open repository**.

graph-manager cannot serve that design today:

- **It works only on local folders.** Every route reads and writes workspace files and runs git, PTYs and the engine on the machine it runs on (`ws.path` in `routes/specs.ts`, `routes/inspect.ts`, `routes/runs.ts`, `routes/resume.ts`, `routes/pr.ts`, `runs.ts`, `pr.ts`, `terminals.ts`). In the hosted design the files are in a container, not next to the control plane.
- **It has one user.** Sign-in is one shared password (`GM_PASSWORD`, `src/server/auth.ts`), and all state is one JSON file with nothing per user (`src/server/store.ts`).
- **Workspaces are managed by hand.** A user clones on the Workspaces page, then opens terminals in a clone. In the hosted design a repository is opened by opening a terminal on it, and closing its last terminal frees it.
- **Nothing limits how much one user opens.**

The open-source app must keep working on one machine exactly as it does now, with the simpler UI as a bonus.

## Goals

1. **Repo sessions replace the Workspaces page.** A user opens a terminal by choosing a repository, a branch and an agent. A repository with at least one open terminal is a *live session*. Closing the last terminal of a repository ends its session.
2. **A `WorkspaceHost` seam.** Every operation on a repository's files, git, terminals and engine goes through a `WorkspaceHost`. The open-source default, `LocalWorkspaceHost`, does exactly what the code does today.
3. **A workspace agent.** `graph-manager agent` serves the `WorkspaceHost` operations over HTTP and WebSocket from inside a container, and `RemoteWorkspaceHost` is its client. A `SessionProvisioner` interface lets the commercial repo create and remove the containers.
4. **Configurable caps.** `GM_MAX_SESSIONS` caps live sessions per user and `GM_MAX_RUN_CONTAINERS` caps live sandboxed runs per user. Unset = no cap (the default). The commercial service sets both to 3.
5. **Gateway sign-in and per-user state.** With `GM_AUTH=gateway`, graph-manager trusts a signed identity header. Every route reads and writes state only through `store.forUser(user)`.
6. **Run history survives the session.** A copy of each run's state is kept by the control plane (`RunArchive`), so the Runs page still shows a run after its container is gone.
7. **UI plugin slots.** A small way for the commercial repo to add UI (nav items, pages, a top-bar item, a settings section) without forking.
8. **Project sessions.** A multi-repo project (KAN-95) opens as one session: one container (or local project folder) with all of its repositories, counting as one session. Projects are created from forge repositories, not from workspaces.
9. **Sandboxed runs in hosted mode.** A run with "Run in sandbox" gets its own container from the provisioner, as KAN-88 does with Docker locally.

## The design

### Hosted: one control plane, one container per open repository

```mermaid
flowchart LR
  U["Browser"] --> GW["Commercial gateway<br/>accounts, plans"]
  GW -->|"signed X-GM-Identity"| CP["graph-manager<br/>control plane"]
  CP --> ST[("Store<br/>per user")]
  CP --> RA[("RunArchive")]
  CP -->|"SessionProvisioner"| K8["Container pool<br/>(commercial)"]
  CP -->|"RemoteWorkspaceHost"| A1["Container: user A, repo api<br/>graph-manager agent"]
  CP -->|"RemoteWorkspaceHost"| A2["Container: user A, repo web<br/>graph-manager agent"]
  CP -->|"RemoteWorkspaceHost"| B1["Container: user B, repo api<br/>graph-manager agent"]
  A1 --> F["Forge<br/>clone, push"]
```

### Open source: the same code on one machine

```mermaid
flowchart LR
  U["Browser"] --> GM["graph-manager<br/>password sign-in"]
  GM --> JS[("graph-manager.json")]
  GM -->|"LocalWorkspaceHost"| WS["Local clones<br/>~/graph-manager-workspaces"]
```

### Opening a terminal

```mermaid
sequenceDiagram
  participant B as Browser
  participant CP as Control plane
  participant P as SessionProvisioner
  participant A as Workspace agent
  B->>CP: POST /api/sessions {repo, branch, agent}
  CP->>CP: check owner and GM_MAX_SESSIONS
  CP->>P: acquire(user, repo)
  P-->>CP: agent URL and token
  CP->>A: prepare(repo, branch)
  A->>A: clone or reuse, check out branch
  CP->>A: open terminal (agent)
  CP-->>B: 201 {sessionId, terminalId}
  B->>CP: WebSocket /api/terminals/:id/ws
  CP->>A: WebSocket (proxied)
```

### Session lifecycle

```mermaid
stateDiagram-v2
  [*] --> Starting: open a terminal
  Starting --> Live: agent ready, repo cloned
  Live --> Live: open or close a terminal
  Live --> Asking: last terminal closed, uncommitted changes
  Live --> Ending: last terminal closed, clean
  Asking --> Live: user picks Keep open
  Asking --> Ending: user picks Push or Discard
  Live --> Ending: idle 15 min (backup push)
  Ending --> Ending: a run is still live (wait)
  Ending --> SaveFailed: push failed
  SaveFailed --> Ending: Retry or Discard
  Ending --> [*]: saved, released
```

In open-source mode the flow is the same, including the question on close. Release keeps the clone on disk (no container to remove), so the next session on that repository starts from a clean clone and can switch branch.

## Decisions

| Decision | Why |
|---|---|
| One container per (user, repository). More terminals on the same repository open as more shells in the same container | A shell costs a few MB; a container costs real money. The user asked for a container per repo. |
| The branch is chosen when the session starts and is fixed while it is live. A new terminal on a live repository shows its branch and does not ask again | One checkout per container; no surprise branch switches under a running agent. |
| `GM_MAX_SESSIONS` (integer ≥ 1, unset = unlimited) caps live sessions per user. Above the limit `POST /api/sessions` answers 409 `{"error":"You have 3 open repositories. Close all terminals of one to open another."}` (the number is the limit) | Everyone gets 3 at the start (the commercial deployment sets `GM_MAX_SESSIONS=3`). Per-plan limits can come later from the gateway. |
| Every cap is an environment variable and is off by default: `GM_MAX_SESSIONS`, `GM_MAX_RUN_CONTAINERS`, `GM_SESSION_IDLE_MINUTES` | The user's rule: all caps configurable, none by default. Open-source installs never hit one. |
| A project session counts as one session. It clones every repository of the project into one container (hosted) or reuses the local clones and the project folder (local), all on the same new or existing branch name | One change across repos is one unit of work, like KAN-95's suite. |
| Projects are created and edited from forge repositories (the same search as the New terminal dialog); a repository is cloned when a project session starts. The Projects page stays | The Workspaces tab is gone, so projects can no longer be built from existing clones. |
| Hosted sandboxed runs: the provisioner starts a run container (`acquireRun`) running `graph-manager agent`. The session host exports the working tree (tracked and untracked files, git-ignored files excluded) into it, the run executes there, and on apply the run's diff comes back as a patch that the session host applies (`git apply --3way`). `GM_MAX_RUN_CONTAINERS` caps them; above it `POST /api/runs/:ws` answers 409 `{"error":"You have 3 sandboxed runs. Wait for one to finish or stop it."}` | Separate containers keep runs isolated from the session (as KAN-88 does locally) without Docker inside the container. The result still lands as uncommitted changes in the session, as today. |
| Local sandboxed runs are unchanged (Docker, KAN-88). `LocalProvisioner.acquireRun` is not used locally | No behaviour change for open-source users. |
| Each user connects their own GitHub or GitLab token in Settings, stored in their own store data. In password mode there is one user, so this is today's behaviour | The user's choice; a GitHub App can come later in the commercial repo. |
| Closing the last terminal of a repository ends the session. If a run of that repository is live, the session ends when the run ends. A session counts toward the limit until it is fully released | Frees the slot so the user can open another repository; never kills a running run. |
| **Ask before closing**: when the last terminal closes and the clone has uncommitted changes (`git status --porcelain` not empty), the UI asks "acme/api has uncommitted changes." with three choices: **Push to branch** (commit and push to the session branch), **Keep open** (the session stays live with no terminal and still counts toward the limit) and **Discard** (drop the changes). A clean clone ends without a question | The user decides what happens to half-done work; nothing lands on the forge without consent. |
| The same question is asked in open-source mode. There, release keeps the clone on disk; after Push or Discard the clone is clean, so the next session can switch branch | Local and hosted behave the same. Clones and settings that already exist keep working. |
| Commits made by graph-manager (`Push to branch`, idle backup) stage only files git does not ignore and never files matching `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`; skipped files are listed to the user. Message: `graph-manager: save session <id>` | No secrets pushed by accident. |
| **Idle**: with `GM_SESSION_IDLE_MINUTES` set, a session with no terminal input or output and no live run for that long ends without asking. Uncommitted changes are committed and pushed to `gm/backup/<session-id>`, then the session is released. Next time the user opens the app, a notice says "Your session on acme/api was closed after 15 minutes idle. Changes were saved to branch gm/backup/<id>." Unset (the open-source default) = never | Nobody is there to ask; the backup branch keeps the work without touching the working branch. The commercial deployment sets 15. |
| If a push fails, the session goes to `save-failed`, the container is kept, and the UI shows the error with **Retry** and **Discard** | Never delete unsaved work silently. |
| **Agent logins**: each agent keeps its own login method. graph-manager reuses the per-provider tables `LOGIN_FILES` and `LOGIN_KEYS` (`sandbox-run.ts` lines 37–50). (1) Login files: after a session ends, the agent's login files from the container's home are saved to the user's store and copied into every new container for that user. (2) API keys: Settings → Agents lets a user save a key per provider (the variables in `LOGIN_KEYS`, for example `ANTHROPIC_API_KEY`), injected into that user's terminals and runs. A key wins over saved login files | A user logs in once per agent, whatever way that agent logs in, or uses an API key instead. |
| New branches default to `gm/<user-id>-<yyyymmdd>-<4 random chars>`. The user can pick an existing branch instead | A predictable, unique branch the session can push to. |
| The control plane talks to an agent with a per-container random token (header `Authorization: Bearer <token>`), given by the provisioner. The agent rejects any other request with 401 | One container's token cannot drive another container. |
| Security is kept to what matters: (1) every store access is `store.forUser(req.user)`, (2) every session, terminal and run route checks that the session's owner is `req.user` and answers 404 otherwise, (3) per-container agent tokens, (4) containers are never reused for another user, (5) gateway and agent secrets are stripped from terminal and run environments | The user asked not to overdo security. These five close the real cross-user paths. Sandbox hardening of the containers is the commercial repo's job (non-privileged, no service-account token, containers cannot reach each other). |
| The identity is an HS256 JWT in `X-GM-Identity`, signed with `GM_GATEWAY_SECRET` (≥ 32 characters), verified with Node's `crypto`. Only `alg: HS256` is accepted. Claims `sub`, `name` required, `email` optional, `iat`/`exp` required, lifetime ≤ 10 minutes, 30 s clock skew | Standard for any gateway; short-lived; no new dependency. |
| In gateway mode the password login and logout answer 404 and session cookies are not accepted. The Origin check stays on | One way in per mode; CSRF protection still applies. |
| In password mode the user is `{ id: "admin", name: "admin" }` and `store.forUser` returns the whole file as today | Open-source behaviour does not change. |
| The open-source repo ships the agent (`graph-manager agent`), `RemoteWorkspaceHost` and the `SessionProvisioner` interface. Only the provisioner implementation (Kubernetes, warm pool) is commercial | The split can be tested end to end here (an agent as a local process); the commercial repo only manages containers. |
| `RunArchive`: the control plane copies a run's `state.json`, its summary and the last 1 MB of `run.log` when the run's status changes and when the session ends. Default: files under `<dataDir>/archive/<user>/<ws>/<runId>/` | History outlives the container. The existing view cache (`viewcache.ts`) already snapshots live run pages; this adds the state. |
| Repository settings (sandbox image or recipe, run defaults, "Run in sandbox") move to **Settings → Repositories**, keyed by repository id as today (`workspaceSettings`, `runDefaults`) | The Workspaces page goes away; today's keys are already per repository. |
| UI plugins: `GM_UI_PLUGINS` lists ES module URLs. Each default-exports `(api) => void`; `api` gives `React`, `registerNav({ label, path })`, `registerRoute({ path, element })`, `registerTopbar(element)` and `registerSettingsSection({ title, element })` | Commercial-only UI without a build tie between repos; graph-manager's own React is passed in, so there is no second copy. Plugin URLs are trusted config, like `GM_EXTENSIONS`. |
| This work builds on `main` with multi-repo (KAN-95, merged) and starts after `feat/automation-api` (KAN-96) is merged | KAN-96 changes auth, the store and the routes; building on top avoids conflicts. |
| The whole spec is built in one graph-execution run | The user's choice. Tasks are chained with dependencies so the `WorkspaceHost` seam lands first. |

## Non-goals

- The Kubernetes provisioner, the warm pool of containers, container hardening, billing, accounts and per-plan limits (all in the commercial repo).
- A database `Store` implementation (commercial). This spec only adds `forUser` scoping and keeps the JSON file.
- Row-level security, a GitHub App instead of PATs, penetration tests, OIDC inside graph-manager, asymmetric identity tokens.
- Changing the engine (`packages/graph-execution`) or how local Docker run sandboxes work.
- A GitHub App or "Sign in with GitHub" (commercial, later).

## User stories

- As a user, I click **New terminal**, pick `acme/api`, keep "New branch", pick Claude, and get a terminal in that repository without visiting any other page.
- As a user, I open a second terminal on `acme/api` and it opens at once in the same session, on the same branch.
- As a hosted user with 3 open repositories, I try a fourth and see "You have 3 open repositories. Close all terminals of one to open another."
- As a hosted user, I close the last terminal of `acme/web`; my changes are pushed to its session branch and I can open a different repository.
- As a hosted user, I close the last terminal while a run is live; the session ends after the run ends, and the run still shows on the Runs page afterwards.
- As a self-hoster, I upgrade and keep my password login, my clones and my runs. The Workspaces page is gone; I open terminals from the new dialog and change repository settings in Settings → Repositories.
- As the commercial developer, I implement `SessionProvisioner` to start a container running `graph-manager agent`, set `GM_AUTH=gateway`, `GM_MAX_SESSIONS=3`, `GM_MAX_RUN_CONTAINERS=3` and `GM_SESSION_IDLE_MINUTES=15`, and add my UI with `GM_UI_PLUGINS`.
- As a user, I open the project "checkout-flow" from the New terminal dialog and get one terminal in a session with both of its repositories, counting as one of my sessions.
- As a hosted user, I start a sandboxed run; it runs in its own container and its result lands in my session as uncommitted changes.

## Requirements

### Config (`apps/graph-manager/src/server/config.ts`)

- `GM_AUTH`: `password` (default) or `gateway`; other values: `ConfigError` `GM_AUTH must be "password" or "gateway"`.
- `GM_GATEWAY_SECRET`: required in gateway mode, ≥ 32 characters (`GM_GATEWAY_SECRET is required when GM_AUTH=gateway` / `GM_GATEWAY_SECRET must be at least 32 characters`).
- `GM_GATEWAY_LOGOUT_URL`: optional absolute `http(s)` URL.
- `GM_MAX_SESSIONS`: optional integer ≥ 1.
- `GM_MAX_RUN_CONTAINERS`: optional integer ≥ 1.
- `GM_SESSION_IDLE_MINUTES`: optional integer ≥ 1.
- `GM_UI_PLUGINS`: optional comma-separated list of URLs (absolute `https://` or a path starting with `/`).
- In gateway mode `GM_PASSWORD` is not required or read. `GM_GATEWAY_SECRET` joins `STRIPPED_ENV` (`terminals.ts` line 99) and is deleted from engine run environments like `GM_PASSWORD` (`routes/runs.ts`).

### Identity and auth (`src/server/identity.ts` new, `src/server/auth.ts`)

- `User { id; name; email? }`, `ADMIN_USER = { id: "admin", name: "admin" }`, `verifyIdentity(header, secret, now)`, `signIdentity(user, secret, now, ttl = 300)` as in the decisions. `req.user` is set by the auth hook in both modes.
- Gateway mode: `needsAuth` paths (including WebSocket upgrades and the run-page proxy) require a valid `X-GM-Identity`, else 401 `{"error":"gateway identity required"}`. Login/logout answer 404 `{"error":"not available in gateway mode"}`.
- `GET /api/auth/me` → `{ user, mode, logoutUrl? }`. `GET /api/auth/info` also returns `mode`.

### Per-user store (`src/server/store.ts`)

- `interface Store { forUser(user: User): UserStore }` and `interface UserStore { get(): Data; update(fn): Promise<void>; reviewers(): Reviewer[] }`.
- `JsonFileStore implements Store`. In password mode `forUser` returns the whole file. In gateway mode it keeps one `Data` per user id under `users[<id>]` in the same file (created on first use with a new reviewer seed); the top level keeps only instance data (`sessionSecret`, `instanceId`).
- Every route uses `ctx.store.forUser(req.user)`. A test fails the build if a route module imports `DataStore`/`JsonFileStore` or calls `ctx.store.get` directly.

### `WorkspaceHost` (`src/server/host/`)

```ts
export interface WorkspaceHost {
  prepare(p: { repo: RepoRef; branch: { new: string } | { existing: string } }): Promise<{ workspaceId: string; branch: string }>;
  spawnPty(p: { workspaceId: string; argv: string[]; env: Record<string, string>; cols: number; rows: number }): Promise<PtyProcess>;
  startEngine(p: { workspaceId: string; args: string[]; env: Record<string, string>; timeoutMs: number }): Promise<EngineStart>;
  readFile(workspaceId: string, rel: string): Promise<string | undefined>;
  listFiles(workspaceId: string, rel: string, opts?: { glob?: string }): Promise<string[]>;
  listRuns(workspaceId: string): Promise<RunSummary[]>;
  runDetail(workspaceId: string, runId: string): Promise<RunDetail | undefined>;
  git(workspaceId: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  activity(): Promise<{ terminals: number; liveRuns: number; lastInputAt: string | null; lastOutputAt: string | null }>;
  /** Uncommitted changes in the clone (`git status --porcelain`), empty when clean. */
  changes(workspaceId: string): Promise<string[]>;
  /** Commits allowed files and pushes to `branch` (the session branch, or `gm/backup/<id>`). */
  save(p: { workspaceId: string; branch: string; message: string }): Promise<{ pushed: boolean; skipped: string[]; error?: string }>;
  /** Drops uncommitted changes (`git reset --hard` and `git clean -fd`, git-ignored files kept). */
  discard(workspaceId: string): Promise<void>;
  /** Reads (`get`) or writes (`put`) the agents' login files in the home folder, as `{ relPath: base64 }`. */
  loginFiles(op: "get" | "put", providers: string[], files?: Record<string, string>): Promise<Record<string, string>>;
}
```

- `LocalWorkspaceHost`: today's code moved behind the interface (`pty.spawn` from `terminals.ts` lines 255–270, the `execa` engine start from `routes/runs.ts` lines 131–145, `listWorkspaceRuns`/`runDetail` from `runs.ts`, the git calls in `pr.ts`, the file reads in `routes/specs.ts` and `routes/inspect.ts`). `prepare` clones into the workspaces folder if missing (reusing `routes/workspaces.ts` clone code), else fetches and checks out the branch; it refuses with 409 `{"error":"acme/api has uncommitted changes. Close its session with Push or Discard first."}` when the clone is not clean and the branch differs. Paths are checked with the existing `insideWorkspaces` / `realpath` rules. In local mode `loginFiles` is a no-op (the user's own home is used).
- `RemoteWorkspaceHost(url, token)`: the same operations over the agent API.
- The routes `specs.ts`, `inspect.ts`, `runs.ts`, `resume.ts`, `pr.ts` and `terminals.ts` call the session's host instead of touching `ws.path`. With `LocalWorkspaceHost`, sandboxed runs use Docker (`sandbox.ts`) as today. With `RemoteWorkspaceHost`, they use `provisioner.acquireRun` (below).
- Two more host operations for hosted sandboxed runs: `exportTree(workspaceId): Promise<Buffer>` (a tar of tracked and untracked, non-ignored files) and `applyPatch(workspaceId, patch: string): Promise<{ ok: boolean; error?: string }>` (`git apply --3way`). The run container's agent gets `importTree` and returns the run's diff with `git diff` after apply.
- Project sessions: `prepare` takes `{ project: { id, repos: RepoRef[] } }` instead of `repo`, clones every repository and writes the project folder the same way `routes/projects.ts` does today (`project.json`, `repos/<name>` links, its own git repo). `changes`, `save` and `discard` act on every repository of the project.

### Workspace agent (`src/server/agent/`, CLI `graph-manager agent`)

- Started as `graph-manager agent --port <p> --workspaces <dir>` with `GM_AGENT_TOKEN` in the environment (required, ≥ 32 characters).
- Serves every `WorkspaceHost` operation under `/agent/v1/*` (JSON), and PTYs as WebSocket `/agent/v1/pty/:id`, all behind `Authorization: Bearer <GM_AGENT_TOKEN>`; anything else answers 401.
- Uses `LocalWorkspaceHost` internally, so the behaviour is identical.
- `GET /agent/v1/healthz` (no token) answers `{"ok":true}`.

### `SessionProvisioner` (`src/server/sessions/provisioner.ts`)

```ts
export interface SessionProvisioner {
  /** A session container for one repository or one project. */
  acquire(p: { user: User; sessionId: string }): Promise<WorkspaceHost>;
  release(p: { user: User; sessionId: string }): Promise<void>;
  /** A run container for a sandboxed run (hosted only). */
  acquireRun(p: { user: User; sessionId: string; runId: string }): Promise<WorkspaceHost>;
  releaseRun(p: { user: User; runId: string }): Promise<void>;
}
```

- Default `LocalProvisioner`: `acquire` returns the one shared `LocalWorkspaceHost`; `release` does nothing; `acquireRun` throws (local sandboxed runs use Docker).
- Hosted sandboxed run: check `GM_MAX_RUN_CONTAINERS` (count of live run containers of the user) → `acquireRun` → `exportTree` from the session → import into the run container → start the engine there without `--web` changes (the run page is proxied from the run container) → when the run is `applied`, take its diff, `applyPatch` it into the session, then `releaseRun`. A failed `applyPatch` keeps the run container and shows the error on the run with **Retry apply**. A run that ends without applying releases its container after its state is archived.
- `buildApp` accepts `provisioner?: SessionProvisioner`, `store?: Store`, `runArchive?: RunArchive`.

### Sessions (`src/server/sessions/`, `src/server/routes/sessions.ts`)

- Session record (in the user's store, `sessions: Record<id, { id, repo: RepoRef, workspaceId, branch, state: "starting" | "live" | "asking" | "ending" | "save-failed", startedAt, error? }>`).
- `GET /api/sessions` → the user's sessions with their terminal ids.
- `GET /api/repos?q=` → repositories from the user's connected forge (reuse `forges.ts` listing), for the dialog.
- `POST /api/sessions` `{ repo } | { projectId }, plus { branch: { new?: string } | { existing: string }, agent?: string, cols?, rows? }`:
  - when the repository already has a live session: opens a new terminal in it (branch ignored) → 201 `{ sessionId, terminalId, branch }`;
  - else checks `GM_MAX_SESSIONS` (409 with the message above), calls `provisioner.acquire`, `host.prepare`, opens the terminal → 201.
- `POST /api/sessions/:id/terminals` `{ agent? }` → a new terminal in a live session.
- Closing a terminal (`DELETE /api/terminals/:id`) when it is the session's last: if `host.changes()` is empty → `ending`; else → `asking`, and the response is `200 { sessionId, ask: { changes: string[] } }` so the UI shows the question.
- `POST /api/sessions/:id/close` `{ action: "push" | "keep" | "discard" }`: `push` → `host.save` to the session branch; `discard` → `host.discard`; `keep` → back to `live` with no terminals. Push and discard then go to `ending`.
- `ending`: waits while a run of the session is live; then saves the agents' login files (`host.loginFiles("get", ...)`) into the user's store, calls `provisioner.release`, and removes the session. A failed push → `save-failed` with `error`; `POST /api/sessions/:id/close` with `push` retries and with `discard` drops the changes.
- New sessions: after `prepare`, the control plane writes the user's saved login files (`host.loginFiles("put", ...)`) and adds the user's saved API keys (Settings → Agents, stored per user as `agentKeys: Record<envName, string>`, only names from `LOGIN_KEYS`) to the terminal and engine environments.
- Idle: with `GM_SESSION_IDLE_MINUTES` set, a loop every 60 s ends live and `asking` sessions whose host `activity()` shows no terminal input or output and no live run for that long: changes are saved to `gm/backup/<session-id>`, then `ending`. The user's store keeps a notice that `GET /api/notices` returns once and the UI shows as a banner.
- Every `/api/sessions/:id/*`, `/api/terminals/:id/*` and `/api/runs/:ws/*` route answers 404 when the session or workspace does not belong to `req.user`.

### Run archive (`src/server/runarchive.ts`)

- `interface RunArchive { save(user, workspaceId, runId, snapshot): Promise<void>; list(user): Promise<RunSummary[]>; get(user, workspaceId, runId): Promise<ArchivedRun | undefined> }`; `snapshot = { state, summary?, logTail }`.
- `FileRunArchive` writes under `<dataDir>/archive/<userId>/<workspaceId>/<runId>/` (mode 600 files).
- The Runs page lists live runs from hosts plus archived runs; an archived run opens a read-only detail (graph, tasks, summary, log tail) with the note "This session has ended. The run page is no longer live."

### UI (`apps/graph-manager/src/web`)

- **Remove the Workspaces tab everywhere**, in both local and hosted mode:
  - the route and pages: `App.tsx` line 74, `pages/Workspaces.tsx`, `pages/Workspaces.css`, `pages/CloneDrawer.tsx` and their tests; `/workspaces` redirects to `/terminals`;
  - the nav item and its badge (`Shell.tsx` line 176) and the `g w` chord (`Shell.tsx` line 28);
  - the command palette (`CommandPalette.tsx` lines 52, 56, 79–80): the Workspaces page, "Clone repository" and the workspace entries are replaced by a **New terminal** action and a **Sessions** group (repository and branch; selecting one focuses its terminals);
  - the overview poll (`overview.tsx` line 70) reads `/api/sessions` instead of `/api/workspaces`;
  - the workspace picker in the Terminals page's new-terminal form (`Terminals.tsx` lines 472 and 678–704) is replaced by the New terminal dialog below;
  - the old routes `POST /api/workspaces` (clone) and `DELETE /api/workspaces/:id` are removed; `GET /api/workspaces` stays only as the list `/api/v1` and the agents' tools use;
  - docs: README lines 102, 137, 203, 259, 265 and 306 (and the keyboard table) describe the New terminal dialog, Sessions and Settings → Repositories instead.
- `WorkspaceSettingsDrawer.tsx` moves into **Settings → Repositories** (below).
- `/api/v1` (KAN-96) keeps its `workspaces` paths and scopes: it is an API, not the tab.
- **Projects page** (`pages/Projects.tsx`, `pages/ProjectDialog.tsx`): New project and Edit repos pick repositories from the forge search (`/api/repos`) instead of workspaces; **Open terminal** opens a project session. `routes/projects.ts` stores `repos: RepoRef[]` instead of workspace ids (existing projects are migrated from their workspace ids on read).
- **New terminal** dialog (`pages/Terminals.tsx` / `TerminalSidebar.tsx`): repository or project search (repositories from `/api/repos`, projects from `/api/projects`, live sessions listed first with a "live" badge), branch (**New branch** with the default name editable, or an existing branch from the forge), agent (as today). For a live repository, the branch row shows the session branch read-only.
- The terminal sidebar groups terminals by session: repository, branch, state (`starting`, `live`, `saving`, `save-failed`), and the count "2 of 3 repositories open" when a limit is set.
- Closing the last terminal of a session with changes opens a dialog: title "acme/api has uncommitted changes.", the changed files (first 20), and the buttons **Push to branch**, **Keep open**, **Discard**. Discard asks once more: "Discard all uncommitted changes in acme/api?".
- `save-failed` shows the error with **Retry** and **Discard**.
- **Settings → Agents**: one field per variable in `LOGIN_KEYS` (password input, saved per user, shown as "saved" afterwards, with **Remove**).
- The idle notice from `/api/notices` shows as a dismissible banner.
- **Settings → Repositories**: a table of repositories that have settings, with the existing `WorkspaceSettingsDrawer` contents (sandbox image or recipe, run in sandbox) and the saved run defaults.
- The top bar shows the user's name; log out as in the gateway decisions.
- **Plugins** (`src/web/plugins.ts`): at start the UI reads `/api/ui/plugins` (the `GM_UI_PLUGINS` list) and `import()`s each module, passing the `api` from the decisions. A plugin that fails to load is logged and skipped. With no plugins nothing changes.

### Docs

- `docs/wiki/features/hosted-sessions.md`: the decision table, the diagrams, the agent API, the provisioner contract, the new variables, and how to run the control plane against a local agent for testing. Link it from `docs/wiki/index.md`.
- README graph-manager section: Workspaces page replaced by the New terminal dialog; the new variables.

### Tests

- `identity.test.ts`: valid token, wrong signature, `alg: none`, `alg: HS512`, expired, lifetime over 600 s, missing claims, malformed input, round trip.
- `auth.test.ts`: gateway mode on a route, a WebSocket upgrade and the run-page proxy; login/logout 404; password mode unchanged.
- `store.test.ts`: two gateway users see only their own data; password mode reads the old file unchanged.
- `sessions.test.ts` (with `LocalProvisioner` and a temp git remote): open a session on a new branch; a second terminal joins it; the limit answers 409 with the exact message; closing the last terminal of a clean clone releases it; with changes it asks, and push / keep / discard each do what they say; a live run delays the release; idle with changes pushes to `gm/backup/<id>` and leaves a notice; switching branch on a dirty clone answers 409; another user's session id answers 404.
- `agent.test.ts`: the agent rejects a missing or wrong token; `RemoteWorkspaceHost` against a local agent process passes the same host contract tests as `LocalWorkspaceHost` (one shared contract suite run against both); `save` pushes to a temp bare remote and skips `.env` and git-ignored files; a failing push returns `pushed: false`; `loginFiles` round-trips the files of `LOGIN_FILES.claude`.
- Agent keys: a saved `ANTHROPIC_API_KEY` reaches a new terminal's environment; a name not in `LOGIN_KEYS` is rejected with 400.
- `runarchive.test.ts`: a run archived at session end is listed and opens read-only.
- Web: the New terminal dialog (search, branch default, live badge), the limit message, Settings → Repositories, a plugin registering a nav item and a route.

### Validation commands

```bash
npm run typecheck && npm run lint && npm test
```

## Acceptance criteria

- [ ] There is no Workspaces tab anywhere: not in the nav, the command palette, the `g w` shortcut or the README; `/workspaces` redirects to `/terminals`.
- [ ] **New terminal** lets the user pick a repository, a branch (new by default) and an agent, and opens a terminal in that repository; a missing clone is cloned first.
- [ ] A second terminal on a live repository opens in the same session on the same branch.
- [ ] With `GM_MAX_SESSIONS=3` and 3 live sessions, opening a fourth repository answers 409 `{"error":"You have 3 open repositories. Close all terminals of one to open another."}` and the UI shows that message.
- [ ] Closing the last terminal of a clean repository ends its session and frees a slot; with a live run, it ends only after the run ends.
- [ ] Closing the last terminal of a repository with uncommitted changes shows "acme/api has uncommitted changes." with Push to branch, Keep open and Discard, in both hosted and local mode; each choice does what it says, and Keep open still counts toward the limit.
- [ ] Push to branch never commits `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*` or git-ignored files, and lists what it skipped; a failed push shows `save-failed` with Retry and Discard.
- [ ] With `GM_SESSION_IDLE_MINUTES=15`, an idle session with changes is pushed to `gm/backup/<id>` and released, and the next visit shows the notice; without the variable, sessions never end by themselves.
- [ ] A user who logged in to an agent in one session is logged in in the next session's container; an API key saved in Settings → Agents reaches new terminals.
- [ ] `graph-manager agent` answers 401 without the right bearer token, and the shared host contract tests pass for both `LocalWorkspaceHost` and `RemoteWorkspaceHost`.
- [ ] In gateway mode, requests without a valid `X-GM-Identity` answer 401 `{"error":"gateway identity required"}`; two users never see each other's sessions, terminals, runs or settings (404).
- [ ] In password mode, an existing install keeps its login, clones, runs and settings; `/api/auth/me` returns `admin`.
- [ ] A run from an ended session still shows on the Runs page and opens read-only.
- [ ] Settings → Repositories shows and edits the per-repository sandbox settings and run defaults.
- [ ] With no cap variables set, there are no caps. With `GM_MAX_RUN_CONTAINERS=3` and 3 live sandboxed runs, a fourth answers 409 `{"error":"You have 3 sandboxed runs. Wait for one to finish or stop it."}`.
- [ ] A project opens from the New terminal dialog as one session with all its repositories and counts as one session; New project picks repositories from the forge.
- [ ] With a remote host, a sandboxed run runs in its own container (from `acquireRun`) and its applied result lands in the session as uncommitted changes; the run container is then released.
- [ ] A plugin listed in `GM_UI_PLUGINS` adds a nav item and a page; with no plugins the UI is unchanged.
- [ ] `GM_GATEWAY_SECRET`, `GM_AGENT_TOKEN` and `GM_PASSWORD` are not in a terminal's environment.
- [ ] `docs/wiki/features/hosted-sessions.md` exists and is linked from `docs/wiki/index.md`.
- [ ] `npm run typecheck && npm run lint && npm test` pass.
