---
name: to-tasks
description: Break a plan, spec, or PRD (or several PRDs, for a graph-execution suite) into independently-grabbable task files for graph-execution using tracer-bullet vertical slices. Use when user wants to convert a plan into issues or tasks, create implementation tickets, or break down work into issues.
---

# To Issues

Break a plan into independently-grabbable, technically rich tasks using vertical slices (tracer bullets). Each task is written as a JSON file under `.agents/tasks/` so that `graph-execution` can run the whole graph with AI coding agents, unattended.

Every slice is implemented by an agent without human interaction. Do not plan slices that need a human decision or review in the middle; resolve those questions with the user now, while quizzing them, and bake the answers into the task text.

## One PRD or several

- **One PRD:** write its tasks to `.agents/tasks/`. It runs as a normal run.
- **Several PRDs** (the user gives more than one, or asks for a suite): each PRD is a **feature** with its own task folder, `.agents/tasks/<feature>/`. They run together as a `graph-execution suite`: each feature is a normal run in parallel, then the features are merged one by one, an integration agent resolves merge conflicts, and an end-to-end phase checks the combined result. Name each feature with a short kebab-case name from its PRD (`auth`, `export`), using only `A-Z a-z 0-9 _ -`: the folder name is the feature's name on the suite page. Leave `.agents/tasks/` itself without task files.

For several PRDs, do every step below once per feature (one quiz can cover all features). Also plan for the parallel features:

- **No dependencies between features.** A feature runs from the starting commit and never sees another feature's code. Never make a slice depend on, import or call code that another feature adds. If two PRDs really depend on each other, tell the user to run them one after the other instead, or merge them into one PRD.
- **Shared files conflict at the end.** When two features edit the same file (a router, a registry, a config), the second merge conflicts and the integration agent resolves it with both PRDs. Prefer additive edits there (append a route, add a key) over rewriting shared code, and say in the task which lines it adds.
- **Features in several repos.** When PRDs target different repos (for example a backend and a frontend), each feature belongs to exactly one repo: the git root of its task folder. Write each feature's task folder inside its own repo, `<repo>/.agents/tasks/<feature>/`. Never write one folder for a feature that spans repos: split a PRD that spans repos into one feature per repo. Features in different repos never see each other's code while they run, so write the shared **contract** verbatim into both PRDs: endpoints, request and response shapes, env vars. Do not choose ports: the suite assigns one per repo and lists them at the top of the e2e spec. Tell the user which repos the suite spans.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it and read its full body and comments.

### 2. Explore the codebase (REQUIRED)

Before drafting any tasks, deeply explore the codebase. The goal is to collect the raw technical material that will make each task self-sufficient — the agent picking up a task sees only that task's text and should not need to do their own research.

Gather:

- **Relevant existing files** — find files each slice will touch or mirror, with line numbers
- **Patterns to follow** — naming conventions, error handling, API shape, data model patterns; extract real code examples
- **Integration points** — where new code registers, connects, or replaces existing code (routers, DI containers, index files, config)
- **Test examples** — find the closest existing test to each slice so the pattern is concrete
- **Gotchas and constraints** — things the codebase enforces that an agent wouldn't know from the spec alone (e.g. "all routes go through X middleware", "models must extend Y base class")
- **Validation commands** — the exact runnable commands to verify correctness (lint, type check, test, curl examples)

Check CLAUDE.md, AGENTS.md and any ADRs in `docs/adr/` for project-specific rules that must be respected.

### 3. Draft vertical slices

Break the plan into **tracer bullet** slices. Each slice is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
- Slices that do not depend on each other can run in parallel; only add a dependency when a slice really needs another one's code
</vertical-slice-rules>

### 3b. Draft the test plan

Next to the slices, draft 5–10 test cases from the PRD's user stories and acceptance criteria. Use ids `P1`, `P2`, ….

- `must` is for core flows that must work before the result lands. `should` is for the rest.
- Each case needs concrete steps and an observable expected result (status codes, UI text, files).
- Cases must be checkable by an agent running the app as `TESTING.md` describes. Put no credentials in the plan; refer to `TESTING.md` for them.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Id**: short string id (`"1"`, `"2"`, ...)
- **Title**: short descriptive name
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Then show the test cases as a second list under the slices, one per line: `P1 (must) Title — expected`.

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the test cases and their priorities right? The user can edit, add, remove or reprioritize cases, or answer "no plan".

Iterate until the user approves the breakdown.

### 5. Write the task files

Write one JSON file per approved slice to `.agents/tasks/<id>.json`, or `.agents/tasks/<feature>/<id>.json` for a feature of a suite (in the feature's own repo; this is the "task folder" below). Create the directory if it doesn't exist. Do NOT write Markdown issue files and do NOT create GitHub issues.

Write the files in dependency order (blockers first). Each file has exactly this shape:

```json
{
  "id": "4",
  "content": "# Export endpoint\n\n## What to build\n...",
  "dependencies": ["2", "3"]
}
```

- `id` — the slice's short string id; it must match the file name (`4` → `4.json`) and be unique within the task folder.
- `content` — the full issue text as Markdown, following the template below, encoded as a JSON string (escape newlines as `\n` and double quotes as `\"`).
- `dependencies` — ids of the slices that must be finished first; `[]` when there are none. Never list the task's own id, never create a cycle.
- `validate` — optional. Only add it when the user asks for a per-task override of the validation commands: a list of shell commands, or `false` to skip validation for that task. Otherwise leave it out.

`content` is the ONLY thing the agent implementing the task sees. It must be **technically self-sufficient**: an AI agent picking it up cold should be able to implement it correctly without doing additional research. Fill every section with specifics from your codebase exploration — never leave placeholder text. Do not rely on other tasks for needed information ("see task 2", "as in slice 3"): if the agent needs it, write it out in this task. You may mention what a dependency already delivered, stated concretely (files, functions, shapes), because its code will be in the codebase.

<task-content-template>
# <Title>

## What to build

A precise description of this vertical slice — the end-to-end behavior it delivers, which layers it touches, and how it fits into the broader system. Be concrete: name the files, components, endpoints, and data shapes involved. 3–6 sentences.

## Context: files to read before implementing

List every file an implementor must read before touching anything. Include line ranges and a one-line reason for each.

- `path/to/file.ts` (lines N–M) — reason: contains the pattern this slice must mirror
- `path/to/router.ts` (line N) — reason: where the new route must be registered
- `path/to/model.ts` — reason: data shape this slice extends

## Patterns to follow

Extract concrete patterns from the codebase — include actual code snippets or file:line references. Cover:

**Naming / file conventions:**
```
e.g. all API handlers live in src/api/<resource>/handler.ts and export a named Router
```

**Error handling:**
```typescript
// e.g. mirror the pattern at src/api/projects/handler.ts:42
throw new AppError(404, 'Resource not found')
```

**Data model / schema pattern:**
```
e.g. all Prisma models use snake_case columns; enums are defined in src/types/enums.ts
```

**Test pattern:**
```typescript
// e.g. integration tests use the factory at tests/helpers/factories.ts; see tests/api/projects.test.ts
```

Add or remove pattern sections as relevant to this slice.

## Step-by-step tasks

Execute in order. Each task is atomic.

### {ACTION} `path/to/file`

- **IMPLEMENT**: specific detail of what to write
- **PATTERN**: `path/to/existing/file.ts:line` — what pattern to mirror
- **IMPORTS**: list exact imports needed and where they come from
- **GOTCHA**: known constraint or non-obvious requirement
- **VALIDATE**: `npm run typecheck` or equivalent runnable command

Repeat for each file touched by this slice.

## Acceptance criteria

- [ ] Specific, observable criterion
- [ ] API contract: exact endpoint, method, request shape, response shape
- [ ] UI behavior (if applicable): specific user action → specific outcome
- [ ] Error cases handled (list them)
- [ ] Tests pass: `<exact test command>`

## Validation commands

```bash
# Type / lint
npm run typecheck && npm run lint

# Tests for this slice
npm test -- <relevant pattern>
```
</task-content-template>

After the task files, write `test-plan.json` in the same task folder, unless the user said "no plan" (then write nothing). In a suite, each feature has its own plan; the suite's e2e tester runs all of them together on the combined result. `test-plan.json` is a reserved file name, never a task. Its shape:

```json
{
  "cases": [
    {
      "id": "P1",
      "title": "Create an item",
      "steps": ["Start the app as TESTING.md describes", "POST /items with {\"name\":\"a\"}"],
      "expected": "Response is 201 and GET /items lists the item",
      "priority": "must"
    }
  ]
}
```

- `id` — matches `^[A-Za-z0-9_-]+$` and is unique.
- `steps` — a non-empty list of strings.
- `priority` — `must` or `should`.
- `cases` — non-empty.

### 6. Validate the task files (REQUIRED)

This skill folder contains `validate-tasks.mjs`, next to this `SKILL.md`. Resolve its path from the directory this skill was loaded from (for example `.agents/skills/to-tasks/validate-tasks.mjs` or `.claude/skills/to-tasks/validate-tasks.mjs`) and run:

```bash
node <path-to-this-skill>/validate-tasks.mjs .agents/tasks            # one PRD
node <path-to-this-skill>/validate-tasks.mjs .agents/tasks/<feature>  # each feature of a suite
```

It checks the files exactly as `graph-execution` will: valid JSON, the shape above, unique ids, no unknown or self dependencies, no cycles. It also checks `test-plan.json` when present; its problems start with `test-plan.json:`. If it prints problems and exits non-zero, fix the JSON files and run it again. Repeat until it prints `OK: <n> tasks, <m> layers` and exits 0, for every task folder. Do not finish before it passes.

Finally, tell the user the tasks are ready, show the command, and ask whether to start it now. One PRD:

```bash
npx graph-execution .agents/tasks --spec <prd-file> --provider claude|codex|opencode|qwen
```

Several PRDs, one `--feature <task-folder>:<prd-file>` per feature:

```bash
npx graph-execution suite --feature .agents/tasks/auth:PRD-auth.md --feature .agents/tasks/export:PRD-export.md --provider claude|codex|opencode|qwen
```

Features in several repos, with absolute paths:

```bash
npx graph-execution suite --feature /abs/shop-api/.agents/tasks/export-api:/abs/shop-api/PRD-export-api.md --feature /abs/shop-web/.agents/tasks/export-ui:/abs/shop-web/PRD-export-ui.md --provider claude
```

If they say yes and the `run-graph` skill is available, follow it; otherwise run the command with `--web` yourself, report the URL and stop.
