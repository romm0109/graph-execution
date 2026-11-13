# CLAUDE.md

## Implementing work: use graph-execution

Implement any change bigger than a one-file fix (Jira tickets, bugs, features, a PRD) by running **graph-execution** on it, not by editing the code yourself. This repo builds the tool, so use its own build.

1. **Gather the work.** Read the tickets or spec, for example Jira with JQL on the `KAN` project. Agree with the user on what goes into this run. Leave out work that can't be verified here (for example Windows-only bugs on Linux) and work that needs a human decision mid-run; settle those decisions with the user now.
2. **Write a spec with the `to-spec` skill** in `docs/prd/<name>.md`: the problem, goals with ticket keys, a Mermaid diagram, decisions, non-goals, user stories and acceptance criteria. Ask the user to approve it before writing tasks.
3. **Write the tasks with the `to-tasks` skill** into their own folder, `.agents/tasks/<name>/`. Don't put them in `.agents/tasks/` itself, which holds older tasks.
   - Explore the code first. Each task's `content` is all the agent sees, so give it real file paths and line ranges, snippets of the patterns to follow, a regression test, and the validation commands.
   - Several tasks can be researched in parallel with subagents, grouped by area.
   - Group tickets that edit the same code into one task, or chain them with `dependencies`, to keep merge conflicts down.
   - Add `test-plan.json` with checks an agent can run using `--provider fake` (see `TESTING.md`).
   - Validate the folder: `node .claude/skills/to-tasks/validate-tasks.mjs .agents/tasks/<name>` must print `OK`.
4. **Commit the spec and task files.** Agents only see committed code.
5. **Run it with the `run-graph` skill**, using the local build:
   ```bash
   npm run build -w graph-execution
   node packages/graph-execution/dist/cli.js list                      # nothing else may be running
   node packages/graph-execution/dist/cli.js .agents/tasks/<name> --spec docs/prd/<name>.md --provider claude --web
   ```
   Report the web port to the user. Watch `.graph-execution/<run-id>/state.json` until `status` is `applied`, `done`, `failed` or `aborted`, using a background monitor rather than a sleep loop. If a task fails, read the summary in the web view and retry it there, or run `node packages/graph-execution/dist/cli.js --resume --web`.
6. **Verify the result yourself** before committing. The result lands as uncommitted changes on the current branch.
   - Run `npm run typecheck && npm run lint && npm test`.
   - Read the review and tester notes at the end of `.graph-execution/<run-id>/run.log`.
   - Known environment failure: `packages/graph-execution/src/cli.test.ts` "exits 2 at startup when --provider claude is not on the PATH" fails wherever a real `claude` is installed next to `node`. CI is the judge.
7. **Record the decisions.** Update the README for any user-facing change. Add or update a page in `docs/wiki/features/` with a decision table (decision, why, ticket), the known follow-ups and code references, and link it from `docs/wiki/index.md`.
8. **Commit, push and open a PR** if the user asked for one. PRs target `development`, not `main`; merging `development` into `main` is a release (see CONTRIBUTING.md, Releases).
   - Move the spec to `docs/prd/done/<name>.md` in the PR (graph-manager's Create PR does this in its commit).
   - Put a table of the tickets in the PR body: key with Jira link, bug id, severity, fix. Add the behaviour changes, testing and follow-ups.
   - Watch the PR for CI results and review comments.
   - Comment on or move Jira tickets only after the user approves.

## Checks

```bash
npm run typecheck && npm run lint && npm test   # CI: .github/workflows/qa.yml (ubuntu + macos + windows); npm publish: publish.yml
```
