# 17. Install skills command and the to-issues skill

**Type:** AFK

## Parent

`PRD.md` (repo root), §7.12 (skill installation), §7.1 (task file shape), §7.10 (CLI). This repo is greenfield; paths come from PRD §6 and earlier issues.

## What to build

Add `graph-execution install skills [--target agents|claude|both] [--force]` and the skill it installs. The package ships `skills/to-issues/` containing `SKILL.md` and `validate-tasks.mjs`. The command copies that folder into `<cwd>/.agents/skills/to-issues/` (default `--target agents`), `<cwd>/.claude/skills/to-issues/` (`--target claude`) or both. It refuses if a destination folder already exists, unless `--force`. The skill is the existing `to-issues` skill with no HITL/AFK distinction (every slice is AFK) that writes one task JSON file per slice to `.agents/tasks/<id>.json` (PRD §7.1 shape, `content` = full self-sufficient issue text in Markdown) instead of Markdown issue files, and tells the agent to run `node <skill-dir>/validate-tasks.mjs .agents/tasks` at the end and fix the files until it passes. The script is dependency-free and applies exactly the same rules as the tool's own validator.

## Context: files to read before implementing

- `PRD.md` §7.1 (task JSON), §7.10 (CLI), §7.12 (install behavior and skill requirements), §8 (packaging), §11 (success criteria).
- `src/graph/task.ts`, `src/graph/validate.ts`, `src/graph/load.ts` from issue 01 — the rules the standalone script must replicate.
- `src/cli.ts` from issue 01 — where the `install` command is registered.
- The source skill to adapt, if available on the machine: `~/.claude/skills/to-issues/SKILL.md`. If it is not available, write the skill from the requirements below; the changes list is complete.

## Patterns to follow

**Conventions:** TypeScript ESM, zod schemas, execa for any process calls, tests next to modules, npm scripts `typecheck`, `lint`, `test`, `build` (all from issue 01).

**Skill folder layout (shipped in the package, repo root):**
```
skills/to-issues/SKILL.md
skills/to-issues/validate-tasks.mjs
```
`SKILL.md` keeps the front matter (`name: to-issues`, a `description`) of the source skill.

**Changes from the source skill (complete list):**
1. Remove every HITL/AFK concept: no `Type` field, no question about marking slices; all slices are implemented unattended.
2. Keep: gather context, explore the codebase, draft vertical (tracer-bullet) slices, quiz the user on granularity and dependencies until they approve.
3. Output: no Markdown issue files and no `.agents/issues/`. For each approved slice write `.agents/tasks/<id>.json` with `{ "id": "<id>", "content": "<markdown>", "dependencies": ["<id>", ...] }`. Ids are short strings ("1", "2", ...). Slices are written in dependency order. Optional `"validate"` may be added only if the user asks for a per-task override.
4. `content` is the full self-sufficient issue text as Markdown (what to build, files to read, patterns, step-by-step tasks, acceptance criteria, validation commands). It must not reference other tasks by number for needed information, because the task agent sees only its own `content`.
5. Final step: run `node <path-to-skill>/validate-tasks.mjs .agents/tasks`; if it prints problems, fix the JSON files and rerun until it exits 0. Do not finish before it passes.
6. Do not create GitHub issues.

## Step-by-step tasks

Execute in order. Each task is atomic.

### CREATE `skills/to-issues/validate-tasks.mjs`

- **IMPLEMENT**: Node 20, ESM, only `node:fs` and `node:path`. Usage `node validate-tasks.mjs <tasks-dir>`. Read every `*.json` file (non-recursive, sorted). Report ALL problems at once, one per line prefixed with the file name: invalid JSON; not an object; `id` missing or not a non-empty string; `content` missing or empty string; `dependencies` present but not an array of strings; `validate` present but not (array of strings | `false` | `null`); duplicate ids across files; dependency on an unknown id; self-dependency; cycles (print one cycle as `a -> b -> a`); empty folder ("no task files found"). Exit 0 and print `OK: <n> tasks, <m> layers` when valid, otherwise exit 1.
- **GOTCHA**: must not import anything from the package; it is copied standalone. Keep rule semantics identical to `src/graph/validate.ts` (including that `dependencies` defaults to `[]`).
- **VALIDATE**: `node skills/to-issues/validate-tasks.mjs src/__fixtures__/diamond`

### CREATE `skills/to-issues/SKILL.md`

- **IMPLEMENT**: the adapted skill per the changes list above. Reference the script with a path relative to the skill folder and tell the agent to resolve it from where the skill was loaded.

### CREATE `src/install/skills.ts`

- **IMPLEMENT**: `installSkills({ target, force, cwd })`. Locate the bundled `skills/to-issues` folder relative to the compiled file (`new URL('../../skills/to-issues/', import.meta.url)` from `dist/install/skills.js`). Destinations: `.agents/skills/to-issues`, `.claude/skills/to-issues`. Check all selected destinations first; if any exists and `!force`, throw an error naming it and installing nothing (no partial installs). Copy recursively with `fs.cp`; with `force` remove the destination first. Print each installed path.
- **GOTCHA**: works from an `npx` install (files are inside the package) and from the repo during development. Destinations are relative to the directory where the command runs (`cwd`), not to the package.

### MODIFY `src/cli.ts`

- **IMPLEMENT**: register `install skills` as a commander subcommand with `--target <agents|claude|both>` (default `agents`, validate the value) and `--force`. Exit 0 on success, 2 on refusal/errors. It must not require `--spec` or `--provider`.

### CREATE tests

- **IMPLEMENT**: `src/install/skills.test.ts` (temp dir as cwd): default target creates `.agents/skills/to-issues/SKILL.md` and `validate-tasks.mjs` only; `claude` creates `.claude/skills/...`; `both` creates both; second run refuses and changes nothing; `--force` overwrites; a partial conflict (one of two destinations exists) installs nothing. `skills/to-issues/validate-tasks.test.ts`: run the script via execa against fixtures and compare its verdict (OK / problem count by category) with `validateGraph` from `src/graph/validate.ts` for the same fixtures (valid diamond, duplicate id, unknown dep, self-dependency, cycle, bad types, empty folder) so the two cannot drift.

## Acceptance criteria

- [ ] `graph-execution install skills` in an empty directory creates `.agents/skills/to-issues/SKILL.md` and `.agents/skills/to-issues/validate-tasks.mjs`
- [ ] `--target claude` installs into `.claude/skills/to-issues/`; `--target both` installs into both
- [ ] A second run exits 2 with a message and changes nothing; `--force` overwrites
- [ ] The installed `SKILL.md` has no HITL/AFK wording, tells the agent to write `.agents/tasks/<id>.json` in the PRD §7.1 format with full Markdown `content`, and to run the validation script until it passes
- [ ] `node validate-tasks.mjs <dir>` exits 0 for every folder the tool's `validateGraph` accepts and exits 1 (listing all problems) for every folder it rejects, proven by the shared-fixture test
- [ ] The script has no imports other than `node:` builtins
- [ ] Tests pass: `npm test -- src/install skills`

## Validation commands

```bash
npm run typecheck && npm run lint && npm test
npm run build
cd "$(mktemp -d)" && node /path/to/repo/dist/cli.js install skills && ls .agents/skills/to-issues
node .agents/skills/to-issues/validate-tasks.mjs /path/to/repo/src/__fixtures__/diamond
```

## Blocked by

- 01-project-skeleton-and-task-graph-validation.md — provides the task schema, the validator whose rules the script replicates, the CLI and the diamond fixture.
