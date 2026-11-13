# Multi-repo runs: graph-manager projects, one suite across repos, a joint verification (KAN-95)

## Summary

A change that spans repositories (an API and the client that calls it) is planned, built and verified as one unit.

- **Projects in graph-manager.** A project is a named group of workspaces from one forge, with its own folder `<workspacesDir>/.projects/<id>/`. That folder is a local git repo holding `project.json`, a `repos/<name>` link per workspace, `contract.md`, `specs/<name>.md`, `tasks/<name>/` and a joint `test-plan.json`.
- **Agent terminals on a project.** The agent starts in the project folder and sees every repo under `repos/`.
- **One suite across repos.** `graph-execution suite --project <dir>` runs one feature per repo in that repo, with that repo's config, and gives each feature its spec plus the contract.
- **A joint phase.** After the features, the suite runs in `<suiteDir>/worktrees/joint/repos/<name>/`: every repo's validation commands, every enabled reviewer on the combined diff (paths prefixed `<repo>/`) with every spec and the contract, the tester on the joint test plan, and a fixer that can edit any repo.
- **All or nothing, then one PR per repo.** Nothing is applied until everything passes, and every repo is re-checked before the first apply. **Create PR** opens one linked PR per changed repo.

Suites also stop ignoring custom reviewers. Settings, Reviewers and Runs use the full width, and graph-manager has a favicon.

- Spec: `docs/prd/multi-repo.md` (goals MR-01 … MR-11). It moves to `docs/prd/done/` in the PR.
- Tasks: `.agents/tasks/multi-repo/` (12 tasks), built in run `20261113-121843-c4a7`.
- Ticket: [KAN-95](https://graph-execution.atlassian.net/browse/KAN-95).
- User docs: "Multi-repo suites" in `packages/graph-execution/README.md`, and "Projects" in `apps/graph-manager/README.md`.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| Extend the suite rather than build a new kind of graph. A multi-repo run is a suite whose features live in different repos, with a joint phase in place of the git merge. | The suite already runs child runs in parallel, then a shared review phase, then one apply, on one page. | KAN-95 (MR-04) |
| Repos are coupled through a contract in the specs, never through task dependencies across repos. | The user chose "contract is enough". Each feature stays a normal run, and no cross-repo scheduler is needed. | KAN-95 (MR-04) |
| Exactly one feature per repo. | The user chose it. A multi-repo suite has no merge step and no integration agent. | KAN-95 (MR-04) |
| One spec per repo plus one contract. Each feature gets its spec with the contract appended (`<suiteDir>/specs/<name>.md`). The joint reviewers get every spec and the contract (`<suiteDir>/joint/spec.md`). | The user chose it. A repo's agents see only their part plus the shared interface. | KAN-95 (MR-03, MR-05) |
| The project lives in `<workspacesDir>/.projects/<id>/`, a local git repo with no remote. It holds `project.json` and `repos/<name>` links (junctions on Windows). | The engine's run machinery assumes a git repo as its home. The dot folder is skipped by `listWorkspaces`. The links give the agent and the joint test plan the same `repos/<name>` paths. | KAN-95 (MR-01) |
| The engine reads `project.json` (`suite --project <dir>`), not a three-part `--feature`. | A Windows drive letter makes a `:`-separated triple ambiguous. | KAN-95 (MR-04) |
| Each feature run uses its own repo's `graph-execution.config.json` (`validate`, reviewers' repo files, test plan). The suite settings come from the project folder's config. | The user asked for each repo's own validation. | KAN-95 (MR-04, MR-05) |
| `runReviewPhase` works over a `ReviewWorkspace` (`review/workspace.ts`). `singleWorkspace` reproduces the old single-worktree behaviour, and the joint workspace spans repos. The heads of several repos are one string, `api=<sha> web=<sha>`. | It is the smallest change that lets the same review loop run over several repos without a schema change to `fixBase` or human-review rounds. | KAN-95 (MR-05) |
| The joint folder holds a sentinel git repo. A fake or careless fixer that commits there is caught. A joint fixer that gives up ends the suite `failed` with `error` in `suite.json`, and a web suite offers **Retry joint review**. | Review finding T1: a human-review fix pass committed at the joint root and left the suite stuck in `integrating`. | KAN-95 (MR-05) |
| Every enabled reviewer runs in the joint phase, the code reviewer included. Joint reviewer nodes use the run page's names. | The user changed their mind on leaving the code reviewer out. Finding T3 aligned the names. | KAN-95 (MR-05) |
| A failed feature doesn't stop the others. A web suite offers Retry and waits. Nothing is applied while a feature is failed. | The user chose it. | KAN-95 (MR-06) |
| Every repo is checked (clean, same branch, same commit) before the first apply. If any repo fails the check, nothing is applied and every result stays on `suite/<rid>`. | The user chose it, to keep all or nothing at the end. | KAN-95 (MR-06) |
| A git failure while applying a later repo, after every check passed, leaves the earlier repos applied. It is logged and documented, and there is no rollback. | Finding F2, accepted as a documented limit for now (see follow-ups). | KAN-95 (MR-06) |
| Each member repo gets `<repo>/.graph-execution/_projects/<suite-id>.json`. | `list` and `clean` run inside a repo then know the suite's `graph/…` and `suite/<rid>` branches are not orphans, and `open --run` works from a repo. | KAN-95 (MR-06) |
| Suites take `--reviewers` or `GRAPH_EXECUTION_REVIEWERS`, and copy it to `<suiteDir>/reviewers.json` for every feature run and the e2e or joint phase. | The user asked for custom reviewers in suites. Before, `suite/spawn.ts` blanked the env var and the e2e phase used the built-ins. | KAN-95 (MR-07) |
| A project's id goes where a workspace id goes, as `project~<id>` (`runhome.ts`: `resolveRunHome`). | The run list, run detail, proxy, resume, sandboxes and Create PR needed a resolver change, not a second set of routes. | KAN-95 (MR-08) |
| A sandboxed project run mounts the project folder and every repo at its `/workspaces` path, and the suite honours `GRAPH_EXECUTION_RUN_ID` and listens like a run's page. | A Linux container can't follow a Windows junction. graph-manager must name the container and reach the page. | KAN-95 (MR-08) |
| Create PR opens one PR per repo whose `repos[].applied.files` is above 0. It adds `docs/prd/done/<project>.md` and `<project>-contract.md`, then links every PR from the others. | The user chose "spec copied into each". Finding F1: a dirty but unchanged workspace must not get a PR. | KAN-95 (MR-09) |
| A project needs workspaces from one forge connection. | The user's only non-goal. One token opens every PR. | KAN-95 (MR-01) |
| Drop `max-width` on `.settings-page`, `.reviewers-page` and `.runs-page`. Add `src/web/public/favicon.svg` (the logo mark, with a `prefers-color-scheme` rule). | The user asked for full-width pages and a tab icon. | KAN-95 (MR-10, MR-11) |

## Known follow-ups

- **No rollback.** A git failure applying a later repo after the pre-check leaves earlier repos applied (F2).
- **Sandboxes on Windows.** Sandboxed project runs on a Windows host are not checked with real Docker: CI has no Docker on Windows, and a mount target that is a junction is unverified.
- **Feature boxes on the suite page.** They still draw only the code reviewer and the tester, not a feature run's custom reviewers.
- **`--sandbox` from a terminal** is still limited to runs. Sandboxed project runs start from graph-manager's Start run.
- **Test flakiness.** `pr.test.ts` and `PrPanel.test.tsx` failed once under full-suite load in the run and passed on rerun.

## Code references

- `packages/graph-execution/src/suite/project.ts`: `loadProject`, `ProjectError`, the `project.json` schema.
- `packages/graph-execution/src/suite/orchestrator.ts`: the multi-repo start, features, pre-apply check and apply.
- `packages/graph-execution/src/suite/joint.ts`: `jointPhase`, `jointDirOf`, `jointRepoDir`, the joint spec and workspace.
- `packages/graph-execution/src/review/workspace.ts`: `ReviewWorkspace`, `singleWorkspace`.
- `packages/graph-execution/src/suite/spawn.ts`, `suite/e2e.ts`: reviewers in suites.
- `packages/graph-execution/src/suite/changes.ts`, `suite/server.ts`, `web/assets/suitepage.js`: the suite page for multi-repo suites.
- `packages/graph-execution/src/cleanup/links.ts`: per-repo `_projects` links for `list`, `clean` and `open`.
- `apps/graph-manager/src/server/projects.ts`, `routes/projects.ts`: projects and their folders.
- `apps/graph-manager/src/server/runhome.ts`: `project~<id>` homes.
- `apps/graph-manager/src/server/liverun.ts`: live-run lookup shared by workspaces and projects.
- `apps/graph-manager/src/server/project-pr.ts`: Create PR for a project run.
- `apps/graph-manager/src/web/pages/Projects.tsx`, `ProjectDialog.tsx`, `useProjects.ts`: the Projects page.
- `apps/graph-manager/src/web/public/favicon.svg`: the favicon.
- `packages/graph-execution/skills/{to-spec,to-tasks,run-graph}/SKILL.md`: project mode.

## Related

- [Agent tools](agent-tools.md)
- [Sandboxed runs](sandboxes.md)
- [Reviewers from the UI](ui-reviewers.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-13
