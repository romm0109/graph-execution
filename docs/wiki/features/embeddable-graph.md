# The run graph as a public, embeddable module

The task graph of the engine's run page is a supported part of the package. Another app, graph-execution Cloud first,
imports `mountGraph` from `graph-execution/graph` and the styles from `graph-execution/graph.css`. It is the same code
the run and suite pages use. The user-facing docs are in the package README, section "Embedding the graph". The spec is
`docs/prd/embeddable-graph.md` (or `docs/prd/done/embeddable-graph.md` once merged).

## How it works

- **Entry points** (`packages/graph-execution/package.json` `exports`): `./graph` → `dist/web/assets/graph.js`, with
  types from `dist/web/assets/graph.d.ts`, and `./graph.css` → `dist/web/assets/graph.css`. The `postbuild` step
  already copies `src/web/assets` to `dist/web/assets`, which brings the `.d.ts` along.
- **`graph.js`** has no imports, so it loads in a browser as is and imports cleanly in Node (it touches no DOM until
  called). It holds the low-level pieces (`layoutLayers`, `renderNodeCard`, `renderEdge`, `createCanvas`,
  `tickElapsed`, `pinchView`) and the high-level `mountGraph`.
- **`mountGraph(host, options)`** builds on `createCanvas` with `refit: true`. `update(data)` runs `layersFromEdges` (Kahn's
  algorithm, nodes in input order within a layer), then `layoutLayers`, `renderEdge` and `renderNodeCard`, then
  `setContent`. It runs its own 1-second `tickElapsed` timer, which stops while `document.hidden`.
- **`createCanvas`** has `interactive`, `keyboard` (`"document"` by default, the engine pages' behaviour; `"host"`
  puts the listener on the host and gives it `tabindex="0"`), `refit` and `destroy()`. The host listeners hang off one
  `AbortController`, and the `document` `keydown` listener and the `ResizeObserver` are removed by hand.
- **`graph.css`**: every class and keyframe starts with `ge-`, and the internal status colour is `--ge-c`. It reads
  only 17 documented custom properties, each with a fallback equal to `theme.css`'s dark value. It sets nothing on
  `:root` and loads no fonts. The zoom bar's buttons are styled fully, so they don't depend on `theme.css`'s global
  `button` rule.
- **Types**: `graph.d.ts` is hand-written and is the public contract. Because it sits next to `graph.js`, TypeScript
  uses it for `./graph.js` imports, so `tsconfig.assets.json` (run by `npm run typecheck`) type-checks `graph.js`
  itself.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| Prefix every class with `ge-`, modifiers and status classes included, rather than scoping under a root class | A root-class scope still lets a host's own `.node {…}` style our cards; a prefix protects both ways. No other app used the old names. | — |
| Hand-written `graph.d.ts`, with `graph.js` kept as `// @ts-check` JS | The pages load `graph.js` in the browser with no build step; the `.d.ts` is reviewed as the public contract. | — |
| `tsconfig.assets.json` type-checks `graph.js` on its own | The `.d.ts` beside it hides `graph.js` from the main typecheck. | — |
| A test checks that the names `graph.js` exports equal the names `graph.d.ts` declares | The `.d.ts` can't silently drift from the code. | — |
| The run and suite pages keep the low-level calls; `mountGraph` is built from them | The pages draw badges, retry markers, `resumed`, the human review node and feature clusters, which `GraphData` doesn't carry. One implementation either way. | — |
| `GraphData` has no layers: `layersFromEdges` uses Kahn's algorithm with input order kept within a layer | It matches `executionLayers`, so passing the run page's nodes in layer order gives the run page's positions (tested). | — |
| A cycle draws its nodes in a last column with `console.warn`; edges to unknown ids are skipped | An embedding app should not crash on bad data. | — |
| `createCanvas` keeps `keyboard: "document"` and fit-once by default; `mountGraph` uses `"host"` and `refit: true` | The engine pages must not change; an embedded graph must not take the host's keys, and should fit new data until the user moves. | — |
| Cards are never focusable (as before); read-only cards get `aria-disabled` | It meets "not focusable in read-only" and leaves the engine pages unchanged. | — |
| Clicking a node in `mountGraph` moves the selection and redraws | `GraphOptions` has no setter for `selectedId`, and the click should show on the graph. | — |
| `escalated` gets "needs decision" as its detail by default | The spec's "needs decision" style, without the host having to pass the text. | — |
| No version bump in the change | The release sets it: 2.1.0, a minor, since the change only adds API. | — |

## Follow-ups

- Selecting a card from the keyboard (Tab to a card, Enter to select).
- A light-theme example in the README (the variables already allow it).
- A `setSelected(id)` on the handle, if a host needs to move the selection without a click.

## Code references

- `packages/graph-execution/src/web/assets/graph.js`: `mountGraph`, `layersFromEdges`, `createCanvas`, `renderNodeCard`, `renderEdge`
- `packages/graph-execution/src/web/assets/graph.d.ts`: the public types
- `packages/graph-execution/src/web/assets/graph.css`: the styles and the custom-property list
- `packages/graph-execution/src/web/assets/graph-mount.test.ts`: layout parity, snapshots, timers, keyboard, read-only, leaks, the engine-page card
- `packages/graph-execution/src/web/assets/graph-public.test.ts`: the CSS, export and type contract
- `packages/graph-execution/tsconfig.assets.json`
