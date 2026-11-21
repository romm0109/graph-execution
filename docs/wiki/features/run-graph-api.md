# Reading a run's graph from another process, and `--config`

graph-execution Cloud runs the CLI in a sandbox and draws the run on its own page with `mountGraph`
(`graph-execution/graph`, see [embeddable-graph.md](embeddable-graph.md)). `readRunGraph(runDir)` in
`graph-execution/api` gives it the `GraphData` to draw. `--config <file>` lets it pass its own config file. Both ship
in 2.0.7. User-facing docs: package README, "Reading the graph from another process" and the flags table.

## How it works

- **One graph, three readers.** `liveGraph()` (`src/ui/rungraph.ts`) is `graphModel()` (`src/ui/model.ts`) plus the
  human review node (`@human`, before `@merge`) and each node's card text (`nodeDetail`). The web server's
  `GET /state` (`src/web/server.ts`, `snapshot`) sends it, the run page draws it (`runpage.js` no longer adds the
  human node itself), and `readRunGraph` rebuilds it from `graph.json`. `toGraphData()` turns it into `GraphData`:
  nodes in layer order, an edge per drawn `parents` entry.
- **`graph.json`.** `run.ts` starts `writeGraphFile(view, runDir, meta)` right after it creates the run's
  `RunStore`. It writes at once, then batches store changes for `GRAPH_WRITE_MS` (100 ms), writing to
  `graph.json.<pid>.tmp` and `renameReplacing` it over the file. `stop()` in the run's `finally` writes the final
  state. The file holds the store slice the graph needs (nodes, agents, gate, merge, reviewers, review wait/decision,
  the changed task graph, `ended`) and the fixed facts (provider, mergeTarget, humanReview, layers, parents).
- **Fallback.** Without a readable `graph.json`, `readRunGraph` feeds `state.json`'s task statuses into a fresh
  `RunStore` (tasks from `<runDir>/tasks`, `context/tasks`, else `tasksDir`), so the result is still the store's.
  Nothing readable gives `{ nodes: [], edges: [] }`.
- **`--config`.** `loadConfig(repo, configFile?)` (`src/config/config.ts`); `preflight` resolves the path against
  `cwd`, `startup`/`checkEnvironment` load it, `run()` saves `configFile` in `state.json` and hashes that file.
  `preflightResume` refuses the flag and loads and hashes `state.configFile`.

## Decisions

| Decision | Why | Ticket |
|---|---|---|
| Persist `graph.json` instead of deriving everything from `state.json` | Reviewer, fixer, gate and human-review statuses, timers and fix rounds only live in the in-process `RunStore` | — |
| Rebuild the graph from the store slice with the same `liveGraph()`, rather than saving the finished `GraphData` | A node added later (a new reviewer, a new pipeline step) appears in the web view and in `readRunGraph` from one code path | — |
| Move the human review node and the card text to the server (`liveGraph`) | The run page and `readRunGraph` must draw the same nodes; one implementation instead of a JS and a TS copy | — |
| `graph.json`'s content is not public API; `readRunGraph`'s shape and the node ids are | The file can change with the store; callers depend on `GraphData` | — |
| An explicit `--config` file that is missing exits 2 | Unlike the repo root's optional file, a named file that is missing is a mistake | — |
| `--config` is refused on `--resume` and its hash is checked | Same rule as the other run options (`--fix-passes`, …): a run keeps the options it started with | — |

## Follow-ups

- `suite` has no `--config`; feature runs of a suite read the repo root's config.
- `readRunGraph` has no watch helper; callers poll or watch `graph.json`.

## Code

- `packages/graph-execution/src/ui/rungraph.ts`: `liveGraph`, `toGraphData`, `writeGraphFile`, `readRunGraph`
- `packages/graph-execution/src/ui/rungraph.test.ts`: every phase, custom reviewer, human review, fallbacks
- `packages/graph-execution/src/runner/nodes.ts`: node ids (`HUMAN_NODE` added)
- `packages/graph-execution/src/launch/preflight.ts`, `src/config/config.ts`, `src/cli.ts`: `--config`
