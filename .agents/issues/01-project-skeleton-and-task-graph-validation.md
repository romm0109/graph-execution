# 01. Project skeleton and task graph validation

**Type:** AFK

## Parent

`PRD.md` (repo root). Section references below (e.g. §7.5) point at its numbered headings. This repo is greenfield: there are no existing source files, so file paths are defined by PRD §6 and by the earlier issues named under "Blocked by".

## What to build

Create the npm package skeleton (`package.json` with name `graph-execution`, `bin`, ESM, TypeScript, eslint, vitest) and the first end-to-end path: `graph-execution <tasks-dir> --spec <prd-file> --provider <name>` loads every `*.json` task file in the folder, validates the graph, and prints either a numbered list of tasks in a valid execution order (layers of tasks that could run in parallel) or a clear error. No git, no agents yet. This slice establishes the module layout from PRD §6, the zod-schema convention, and the CLI argument parsing used by every later issue. It covers PRD §7.1 and §7.10 and the "invalid graphs are rejected" criterion.

## Context: files to read before implementing

- `PRD.md` §6 (directory layout), §7.1 (task file shape and the optional `validate` field), §7.10 (CLI), §7.11 (startup checks: spec present, readable, non-empty), §8 (libraries).

## Patterns to follow

**Conventions (set in issue 01, mirror in every issue):**
```
- TypeScript 5, Node 20+, ESM ("type": "module"), strict mode. Imports use the .js extension for local files.
- Source in src/<module>/ exactly as listed in PRD §6; tests next to the module: src/<module>/<name>.test.ts (vitest).
- Schemas (task JSON, state, config, reports) are zod schemas exported from the module that owns them; types come from z.infer.
- Shell/git calls go through execa with an argument array, never a single shell string, and always pass cwd explicitly.
- npm scripts (created in issue 01): "typecheck": "tsc --noEmit", "lint": "eslint .", "test": "vitest run", "build": "tsc -p tsconfig.build.json".
- Errors that should abort the run extend `AbortRunError` (src/state/errors.ts, created in issue 03; until then throw plain Error).
```


## Step-by-step tasks

Execute in order. Each task is atomic.

### CREATE `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`

- **IMPLEMENT**: package name `graph-execution`, `"type": "module"`, `"bin": {"graph-execution": "dist/cli.js"}`, `engines.node >=20`. Dependencies: `zod`, `commander`, `execa`. Dev: `typescript`, `vitest`, `eslint`, `typescript-eslint`, `@types/node`. Scripts exactly as in the conventions block. `.gitignore`: `node_modules`, `dist`, `.graph-execution`.
- **GOTCHA**: `tsc -p tsconfig.build.json` must exclude `*.test.ts`; `bin` file needs a `#!/usr/bin/env node` first line (emitted from `src/cli.ts`).
- **VALIDATE**: `npm run typecheck && npm run lint`

### CREATE `src/graph/task.ts`

- **IMPLEMENT**: `taskSchema = z.object({ id: z.string().min(1), content: z.string().min(1), dependencies: z.array(z.string()).default([]), validate: z.union([z.array(z.string()), z.literal(false), z.null()]).optional() })`. Export `Task`.
- **GOTCHA**: ids are strings even if they look numeric; do not coerce.

### CREATE `src/graph/load.ts`

- **IMPLEMENT**: `loadTasks(dir): Promise<Task[]>` reads every `*.json` in `dir` (non-recursive, sorted by filename), parses with `taskSchema`, and throws `GraphError` with the file name for invalid JSON/schema. Also export `GraphError`.
- **GOTCHA**: an empty folder is an error ("no task files found").

### CREATE `src/graph/validate.ts`

- **IMPLEMENT**: `validateGraph(tasks): void` throws `GraphError` listing ALL problems found: duplicate ids, dependencies that reference unknown ids, self-dependency, and cycles (report one cycle as `a -> b -> c -> a`). `executionLayers(tasks): Task[][]` returns tasks grouped so every task's dependencies are in earlier layers (Kahn's algorithm, stable by id order).
- **VALIDATE**: `npm test -- src/graph`

### CREATE `src/cli.ts`

- **IMPLEMENT**: commander program with `<tasks-dir>`, required `--spec <file>`, required `--provider <claude|codex|opencode>` (also accept a hidden `fake` value), optional `--concurrency <n>` (default 3), `--model <m>`. Checks: spec file exists, is readable and is non-empty, otherwise exit code 2 with a message (PRD §7.11). Then load and validate the graph and print the layers. Exit code 2 on any `GraphError`. Also define `graph-execution --resume [--run <id>]` as a parsed-but-not-yet-implemented mode that prints "not implemented yet" and exits 2.
- **GOTCHA**: `--spec` must be required only when not using `--resume`.

### CREATE tests `src/graph/validate.test.ts`, `src/graph/load.test.ts`, `src/cli.test.ts`

- **IMPLEMENT**: cover duplicate ids, unknown dependency, self-dependency, 3-node cycle, valid diamond (layers `[[1],[2,3],[4]]`), invalid JSON, empty folder, missing/empty spec file. The CLI test runs the built entry with `execa` against fixture folders under `src/__fixtures__/`.


## Acceptance criteria

- [ ] `graph-execution ./fixtures/diamond --spec PRD.md --provider fake` prints the layers `1 | 2 3 | 4` and exits 0
- [ ] A cycle prints `a -> b -> a` style output and exits 2
- [ ] Duplicate id, unknown dependency, and self-dependency are all reported (together, in one run) and exit 2
- [ ] Missing, unreadable, or empty `--spec` exits 2 with a message
- [ ] Task `validate` accepts a string array, `false`, `null`, or absence
- [ ] `npm run typecheck`, `npm run lint`, `npm test` all pass

## Validation commands

```bash
npm install
npm run typecheck && npm run lint && npm test
npm run build && node dist/cli.js src/__fixtures__/diamond --spec PRD.md --provider fake
```

## Blocked by

None — can start immediately.
