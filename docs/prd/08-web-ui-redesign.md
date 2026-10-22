# PRD: Web UI redesign ("mission control")

## 1. Executive Summary

The two browser views are the single-run page (`src/web/page.html`, served by `--web`) and the suite page (`src/suite/page.html`). Each is a stack of sections: header, phase bar, review box, final diff, a graph with a fixed side panel, events and summary. The graph sits in the middle of a scrolling page. Diffs show either inline under a file row or in a crude `<pre>` in the suite review section. The panel has a fixed width (`min(520px,45vw)`), so long lines and big diffs are cramped. The two pages share no code. The theme tokens, diff parser, highlighter, SVG graph and pan/zoom are copied between them, and they have already drifted apart. For example, the suite review diff has no line numbers and no highlighting, and only the suite page shows agent logs.

This PRD redesigns both pages into one dark, sleek "mission control" interface. The graph becomes a full-screen canvas with animated status and richer node cards. A slim top bar holds status and actions, a floating phase stepper sits over the canvas, and the events log is a collapsible bottom drawer. Everything you drill into opens in **one right panel that you resize by dragging**: node details, a proper diff viewer, live agent logs, and the human-review diff and decision. The diff viewer has a file tree, unified and split views, real syntax highlighting (vendored highlight.js), and GitHub-style "expand context" between hunks. The shared parts move into plain ES modules and CSS under `src/web/assets/`, which both servers serve. There is still no framework, no bundler and no CDN.

**MVP goal:** start `--web` on the diamond fixture and the suite demo. Both pages open as a full-viewport dark canvas with no page scroll. Clicking a node opens the right panel, and you drag it to ~70% of the width. The node's diff renders with highlight.js colours and a split view, "expand 20 lines" works between hunks, and the Logs tab streams the running agent's output live. The final human-review diff and the Apply / Request changes / Drop controls are in the same panel on both pages. Server behaviour, run results and the review data model are unchanged.

## 2. Mission

Make watching and reviewing a run feel like a polished tool you want to keep open, and make the diff the best-looking thing on the screen.

**Principles**

1. **The canvas is the page.** The graph owns the viewport. Everything else is a dock, drawer or panel that appears when asked for and gets out of the way.
2. **One panel, one diff viewer.** Every diff, on both pages, renders through the same module, with line numbers, highlighting, file tree and context expansion.
3. **Share, don't copy.** Theme, diff, graph, panel and log code live once in `src/web/assets/` and both pages import them.
4. **Zero install weight.** No framework and no bundler. Vendored assets (highlight.js and fonts) are served from the package, so it works offline and over SSH tunnels.
5. **Behaviour-preserving.** Same endpoints, same actions, same review flow. This is a UI change plus three additive read-only endpoints.

## 3. Target Users

- **A developer watching a run** in a browser tab on a second monitor. They want to see at a glance what is running, failing or done, and to dig into one node without losing the graph.
- **A developer reviewing the result** before Apply (PRD 06). They read large diffs and want room, highlighting and context, as on GitHub.
- **A developer running a suite** of several PRDs. Today they get the uglier page, with no line numbers in the review diff.

Technical comfort: high. They are developers using AI coding agents from the CLI. Pain today: a cramped fixed panel, unhighlighted or raw diffs, page scrolling to reach the graph or events, no logs on the single-run page, and two pages that look and behave differently.

## 4. MVP Scope

### Core Functionality
- ✅ Full-viewport layout on both pages (no page scroll):
  - top bar: title, run or suite id, provider, elapsed time, progress, connection and actions
  - graph canvas filling the rest
  - floating phase stepper
  - collapsible bottom events drawer
  - right panel
- ✅ Dark-only "mission control" theme:
  - near-black background with a subtle dot grid on the canvas
  - glassy translucent panels (backdrop blur) with thin accent borders
  - status colours as tokens
  - Inter for the UI and JetBrains Mono for code
- ✅ Graph:
  - richer node cards: title, status icon, agent and provider, elapsed time, attempt count, `+x −y` line counts
  - running nodes pulse or glow; edges into running nodes show flowing dashes; failed nodes get a red ring
  - floating zoom +/−, fit-to-screen, and keyboard shortcuts (`F` fits, `Esc` closes the panel, `+`/`-` zooms)
- ✅ Right panel:
  - drag-resize from its left edge, from 320px up to 85% of the viewport; double-clicking the handle resets the width
  - width and open state remembered in `localStorage`
  - the panel pushes (shrinks) the canvas and does not overlay it
- ✅ Panel tabs for the selected node or feature: **Overview** (details, status, actions such as Retry), **Changes** (file tree + diffs), **Logs** (live agent logs)
- ✅ Review mode: when the run (or suite) waits for human review, the panel opens on a **Review** tab. It shows the final diff in the same viewer, today's comment UI restyled, and the Apply / Request changes / Drop decision bar pinned at the bottom of the panel. The `#review` and `#reviewdiff` sections above the graph go away.
- ✅ Diff viewer:
  - file tree or list at the top with A/M/D/R status and `+/−` counts; click a file to jump to it; files collapse and expand one by one
  - unified view by default; a split (side-by-side) toggle that is enabled when the panel is ≥ 900px wide; the choice is remembered
  - highlight.js syntax highlighting per file language
  - "expand up / expand down / expand all" bars between hunks and at file edges, 20 lines per click, fetched from the new file-content endpoint
  - binary and truncated files keep today's notices
- ✅ Logs tab:
  - a live tail of the selected node's agent logs (one collapsible block per log file) that auto-scrolls and pauses when you scroll up, with a "jump to bottom" chip
  - "load full log" button and a text filter
  - on both pages; the single-run page gets logs for the first time
- ✅ Narrow screens (< 900px): the panel becomes a full-screen sheet with a back button; the events drawer stays

### Out of Scope
- ❌ A light theme or a theme toggle (dark only)
- ❌ Minimap
- ❌ New comment features (line ranges, suggestions, a comments navigator); they are in PRD 09. This PRD only restyles and relocates today's comment UI.
- ❌ Changes to the terminal (Ink) UI in `src/ui/`
- ❌ Editing code in the browser
- ❌ Playwright or any browser-based CI tests

### Technical
- ✅ Shared assets in `src/web/assets/`, served by both servers at `GET /assets/*`, copied to `dist/web/assets/` by `postbuild`
- ✅ Each `page.html` shrinks to markup plus a page-specific module (`run.js` / `suite.js`) that imports the shared modules
- ✅ Vendored highlight.js core and about 15 languages, plus woff2 fonts, under `src/web/assets/vendor/` with their licence files
- ✅ Pure modules have vitest unit tests: diff parsing, context merging, split-row pairing, graph layout, log tail merging
- ✅ A browser smoke checklist, run with the `agent-browser` skill, documented in `TESTING.md`

### Integration
- ✅ Reuses the existing endpoints (`/state`, `/events`, `/changes/:id`, `/review*`, and the suite `/api/*`) unchanged
- ✅ Three additive endpoints on each server: file lines at a ref, log tail/full, and log streaming (see §10)

### Deployment
- ✅ Ships in the npm package; `files` already includes `dist`. No new runtime npm dependencies. README screenshots updated.

## 5. User Stories

1. **As a** developer watching a run, **I want** the graph to fill the screen with clear live status, **so that** I can see progress at a glance.
   *Example:* a diamond run. Node `2-api` pulses cyan with "running · claude · 3m12s · +84 −10". The edge into it animates, and `1-schema` shows a green check.
2. **As a** developer, **I want to** drag the diff panel wider, **so that** long lines and big files are readable.
   *Example:* I click `2-api`, and the panel opens at the width I used last time (640px). I drag the handle to about 75%, switch to split view, and the setting sticks after a reload.
3. **As a** developer, **I want** GitHub-quality diffs, **so that** reviewing feels like reviewing a PR.
   *Example:* `src/api/users.ts` shows TypeScript highlighting. Between two hunks a bar says "↕ 37 hidden lines". Two clicks on "expand" show the 37 lines around `listUsers`.
4. **As a** developer, **I want to** watch an agent's log live on both pages, **so that** I can see what it is doing without opening a terminal.
   *Example:* the Logs tab for `2-api` streams `2-api-implement-1.log`. I scroll up and streaming pauses with a "↓ 14 new lines" chip. I type `error` in the filter and only matching lines stay.
5. **As a** developer reviewing the result, **I want** the final diff and the decision in the same panel, **so that** I don't scroll between a diff above the graph and buttons elsewhere.
   *Example:* the run pauses for review. The panel opens on **Review** with the file tree (`4 files +212 −31`) and a sticky bar at the bottom: *Request changes (2)*, *Apply*, *Drop*.
6. **As a** suite user, **I want** the suite page to look and behave exactly like the run page, **so that** I learn one UI.
   *Example:* in a suite, the integration review diff has line numbers, highlighting and expand context. The same viewer is used for a feature's node diffs.
7. **As a** developer on a laptop, **I want** the UI to stay usable at narrow widths, **so that** I can check on a run from a small window.
   *Example:* at 800px, clicking a node opens a full-screen sheet with "← Graph".
8. **(Technical) As a** maintainer, **I want** the diff, layout and log logic in pure shared modules with unit tests, **so that** both pages stay in sync and regressions are caught.

## 6. Core Architecture & Patterns

```
src/web/
  page.html            markup + <script type="module" src="/assets/run.js">
  server.ts            + GET /assets/*  + GET /file  + GET /logs  (+ SSE "log" events)
  assets/
    theme.css          tokens (colours, radii, blur, fonts), base, buttons, dock/drawer/panel
    diff.css           diff viewer, file tree, split view, expand bars, hljs theme
    fonts.css          @font-face for vendored Inter / JetBrains Mono
    dom.js             tiny helpers: h(tag, attrs, ...children), on(), clamp()
    graph.js           layered layout (pure) + SVG render + pan/zoom/fit + status animation
    panel.js           right panel: resize handle, persistence, tabs, narrow-sheet mode
    diff.js            parseUnifiedDiff (pure), toSplitRows (pure), mergeContext (pure), renderDiff
    filetree.js        file list with status/counts, jump/collapse
    highlight.js       wraps vendor hljs; per-line highlighting that keeps multi-line state per hunk
    logs.js            mergeTail (pure), LogView (autoscroll/pause/filter/full)
    review.js          review tab: today's comment UI + decision bar (shared by both pages)
    events.js          bottom drawer
    run.js             single-run page wiring (/state, /events)
    suite.js           suite page wiring (/api/suite, polling/SSE)
    vendor/
      highlight/       highlight.min.js core + languages + LICENSE
      fonts/           Inter-*.woff2, JetBrainsMono-*.woff2 + OFL.txt
src/suite/
  page.html            markup + <script type="module" src="/assets/suite.js">
  server.ts            + GET /assets/* (same dir: ../web/assets)  + /api/file  + /api/logs?stream
```

**Patterns**

- **Pure core, thin DOM.** Every module exports pure functions, tested in vitest under `node` by importing the `.js` files directly, plus a `render*`/`mount*` function that touches the DOM. Tests never need a DOM.
- **One static-file route** in a shared helper, `serveAsset(root, pathname, res)`. It resolves inside `assets/`, rejects `..` and absolute paths, sets content types (`.js`, `.css`, `.woff2`, `.svg`), and sends `cache-control: no-cache` so a rebuilt package is never stale.
- **Panel state** lives in `localStorage` under `ge.panel` (`{width, open, tab, diffMode}`). Every read and write is wrapped in try/catch, and the page works without it.
- **Highlighting per line with hunk state.** highlight.js runs on each hunk's reconstructed old and new text, and the HTML is split back into lines, so multi-line strings and comments colour correctly. Above 2,000 lines in a file it falls back to plain text.
- **Animation** is CSS only (`@keyframes` on `.node.running`, and `stroke-dashoffset` on `.edge.active`). It respects `prefers-reduced-motion`.
- **Live logs** use the existing SSE channel on the run page (a new `log` event type) and a per-feature SSE stream on the suite page. The server tails files by byte offset (`fs.watch` with a 1s poll fallback) and only for log files a client has subscribed to.

## 7. Tools/Features

### 7.1 Layout shell
- The top bar is 48px high, glass, with the run title and id on the left and progress, elapsed time and connection in the centre. Abort, Merge and Close sit on the right, and the suite page adds "Start integration".
- The phase stepper is a pill row floating at the top left of the canvas with the current phase highlighted. Suite phases: features → integration → e2e → human → done.
- The events drawer is a bottom drawer, collapsed to a 28px strip that shows the latest event. Clicking the strip or pressing `E` toggles it, and it is resizable up to 50% of the height.
- The summary (when the run finishes) shows as a centred card over the canvas that can be dismissed, and from the top bar you can open it again.

### 7.2 Graph canvas
- Node card size is 220×64 and holds:
  - line 1: status icon and title
  - line 2: agent, elapsed time, attempt (`×2`) and `+x −y` in green/red
- Statuses and their styles:

  | Status     | Style                                        |
  |------------|----------------------------------------------|
  | pending    | dim outline                                  |
  | running    | accent glow pulse, 2s                        |
  | validating | amber glow                                   |
  | done       | green check, solid border                    |
  | failed     | red ring + ⚠                                 |
  | skipped    | dashed                                       |

- Edges are beziers. An edge into a running node animates its dashes, and an edge out of a failed node is dimmed.
- Controls: `+`/`−`, fit, and reset. The canvas fits on first load and after the panel is resized, unless the user has panned since.

### 7.3 Right panel
- The drag handle is 6px with a visible 2px line on hover. Pointer capture makes dragging smooth over the iframe or SVG, and the arrow keys resize it in 32px steps when it has focus (`role="separator"`, `aria-valuenow`).
- The header shows the node or feature title, a status chip, and close (×).
- Tabs depend on the node and the mode:
  - task node: Overview · Changes · Logs
  - a suite feature: Overview · Changes · Logs
  - integration agent: Overview · Changes · Logs
  - human review waiting: **Review** first, plus the node tabs when a node is selected
- Narrow mode (< 900px): the panel is fixed, full screen, with "← Graph".

### 7.4 Diff viewer (`diff.js`)
- `parseUnifiedDiff(text) → { files: [{ path, oldPath, status, hunks: [{ oldStart, oldLines, newStart, newLines, header, lines: [{ kind: 'add'|'del'|'ctx', old?, new?, text }] }] }] }`
- `toSplitRows(hunk)` pairs del/add runs into side-by-side rows, with blanks on the shorter side.
- `mergeContext(hunks, fetched)` inserts fetched lines into a gap, merges hunks once a gap closes, and computes `{ gapAbove, gapBelow }` for each hunk. That is the "N hidden lines" count.
- The rendering contract is that every rendered line carries `data-file`, `data-side`, `data-old-line` and `data-new-line`. PRD 09 builds line selection on these attributes. This PRD does not implement selection beyond today's single-line click in the Review tab.
- Expanding context calls `GET /file?ref=<head>&path=<p>&from=&to=` (or `/api/file`). The ref is the diff's head side, which is the new file, since context lines are the same on both sides. A running node with a worktree diff reads the worktree file.
- File tree: path (directories collapse when there is one child), status letter, and `+/−` bar. "Collapse all" and "Expand all" act on the whole list. Viewed or reviewed state is out of scope.

### 7.5 Logs (`logs.js`)
- The list of log files for the node comes from `GET /logs?node=<id>` (run page) and `GET /api/logs?feature=` or `?label=` (suite). Each entry is `{label, size, tail}`.
- Streaming: the client sends `POST /logs/subscribe {labels}` (run page; the subscription is tied to the SSE connection id) and receives SSE `log` events `{label, offset, text}`. The suite page uses `GET /api/logs/stream?labels=` as its own SSE.
- `mergeTail(existing, chunk)` is pure. It appends at an offset and drops duplicate or overlapping data after a reconnect.
- "Load full log" is `GET /logs/<label>?full=1`, capped at 5 MB, with a notice when it is truncated.
- Filter: a case-insensitive substring match that hides lines which don't match. Matches are highlighted.

### 7.6 Review tab (both pages)
- Today's human-review features, moved into the panel and restyled, with no behaviour change:
  - final diff of round H, with the round switcher
  - comments: single line, file and general
  - the "needs live check" checkbox
  - previous-round cards with fixer note, verdict and live-check result, plus Resolve / Reopen
- The suite page gets the run page's richer comment UI through the shared `review.js`. That includes single-line comments, which the suite page lacks today (it has a file dropdown). The data sent is the same as today: `{file?, line?, snippet?, body, liveCheck}`.
- Sticky decision bar: *Request changes (n open)*, *Apply* (or *Apply anyway* when blockers are open, with a confirm), and *Drop* (with a confirm).

## 8. Technology Stack

- **Runtime:** Node ≥ 20, TypeScript servers (existing `node:http`). No new npm runtime dependencies.
- **Frontend:** vanilla ES2022 modules and CSS (custom properties, `backdrop-filter`, grid), loaded with `<script type="module">`. No bundler.
- **Vendored:**
  - highlight.js 11.x core plus the languages: typescript, javascript, json, python, go, rust, java, css, scss, xml/html, bash, markdown, yaml, sql, diff (BSD-3-Clause)
  - Inter 4.x and JetBrains Mono 2.x as woff2, 400/500/600 weights (SIL OFL 1.1)
- **Tests:** vitest (existing). The shared `.js` modules are imported from tests, with `// @ts-check` and JSDoc types so `tsc` checks them through `allowJs`/`checkJs` on `src/web/assets/*.js`, excluding `vendor/`.
- **Manual and browser checks:** the `agent-browser` skill, following a checklist in `TESTING.md`.

## 9. Security & Configuration

- Same model as today: localhost-only and no authentication.
- `/assets/*` serves only files under the assets directory. The path is normalized, it is rejected if it leaves the root, and only allowlisted extensions are served.
- `/file` reads only through git (`git show <ref>:<path>`) or from the tracked worktree of a known node. `ref` must be the base or head of a known node or review round, and `path` must be one of the files in that diff. It never reads arbitrary paths.
- `/logs` serves only `*.log` files in the run's (or suite's) `logs/` directory, by label. A label must match `^[\w.-]+$`.
- Comment and log text are always inserted with `textContent`. highlight.js output is the only HTML that is set, and it comes from escaped source.
- No new config keys. UI preferences are in `localStorage` only.

## 10. API Specification

All additive. The run server uses the paths without a prefix, and the suite server uses `/api/...`.

**`GET /assets/<path>`** returns the static file. `404` if it is missing or outside the root.

**`GET /file?node=<id>&path=<p>&from=<n>&to=<n>`**, or `?round=<H>&path=&from=&to=` for the review diff:
```json
{ "path": "src/api/users.ts", "from": 40, "to": 59, "lines": ["export function listUsers(", "..."], "total": 212 }
```
`from`/`to` are 1-based and inclusive, clamped to `total`, with at most 500 lines per call. `404` when the node, round or path is unknown, and `415` for a binary file.

**`GET /logs?node=<id>`**:
```json
{ "logs": [{ "label": "2-api-implement-1", "size": 18422, "tail": "...last 8 KB..." }] }
```
**`GET /logs/<label>?full=1`** returns `{ "label", "text", "truncated": false }`.

**Live log lines.**
- Run page: `POST /logs/subscribe {"client":"<sse id>","labels":["2-api-implement-1"]}` → `204`. After that the client's `/events` stream also carries:
  ```
  event: log
  data: {"label":"2-api-implement-1","offset":18422,"text":"Running tests…\n"}
  ```
  The first SSE message gives each client an `id` (`event: hello`).
- Suite page: `GET /api/logs/stream?labels=a,b` is a dedicated SSE stream with the same `log` payload.

## 11. Success Criteria

**MVP success:** both pages, in a real run of the diamond fixture and of `demo/suite`, meet every functional item below. Existing server tests pass unchanged, and nobody needs to scroll the page.

**Functional**
- ✅ The full-viewport canvas renders on both pages, with no vertical page scrollbar at 1280×800
- ✅ Node cards show status, agent, elapsed time, attempts and `+/−`, and running nodes and their incoming edges animate
- ✅ Drag-resizing the panel works from 320px to 85% and survives a reload, and double-clicking resets it
- ✅ The diff viewer shows the file tree, unified view, split view (≥ 900px) and highlight.js colours, on both pages, for node diffs and the review diff
- ✅ Expand context reveals 20 lines per click and merges hunks when a gap closes
- ✅ The Logs tab streams new lines within 1.5s of them being written, pauses on scroll-up, filters, and loads the full log
- ✅ The Review tab shows the decision bar, and Apply / Request changes / Drop behave exactly as today on both pages
- ✅ At < 900px the panel is a full-screen sheet
- ✅ `npm run build` copies the assets, and the installed package works offline

**Quality**
- ✅ Pure modules have ≥ 90% line coverage in vitest
- ✅ No duplicated diff, graph or theme code between the two pages, and each `page.html` is under 150 lines
- ✅ A 5,000-line diff renders in < 1s (hljs falls back to plain text above 2,000 lines per file)
- ✅ The `TESTING.md` smoke checklist passes with agent-browser on both pages

**UX goals**
- It feels like a modern dev tool (Linear, Vercel or GitHub dark), not a debug page
- You never lose the graph while you read a diff

## 12. Implementation Phases

**Phase 1: shared foundation**
- Goal: both pages load shared assets, with no visual change yet.
- ✅ `/assets/*` route on both servers, `postbuild` copy, vendored fonts and highlight.js
- ✅ Move `dom.js`, `diff.js` (parser only), `graph.js` (layout and render) and `theme.css` out of both pages, and have both pages import them
- ✅ Unit tests for the parser and the layout
- Validation: existing server and web-e2e tests pass, and both pages render as before.

**Phase 2: shell and canvas**
- Goal: the new look.
- ✅ Top bar, floating phase stepper, events drawer, summary card
- ✅ Node cards, status animation, zoom and fit controls, keyboard shortcuts
- ✅ `panel.js` with resize, persistence, tabs and narrow mode
- Validation: smoke checklist items 1–6.

**Phase 3: diff viewer and review tab**
- Goal: diffs and review move into the panel.
- ✅ File tree, unified and split views, highlight.js per-hunk highlighting
- ✅ `/file` endpoint, expand bars, `mergeContext`
- ✅ `review.js` shared by both pages, and the decision bar; remove the old `#review` and `#reviewdiff` sections
- Validation: a human-review run on both pages, round-tripped through Request changes and then Apply.

**Phase 4: logs and polish**
- Goal: live logs on both pages, then finish.
- ✅ `/logs` endpoints, the subscription, the SSE `log` event, and the suite stream
- ✅ `logs.js` with autoscroll, pause, filter and the full-log view
- ✅ README screenshots, `TESTING.md` checklist, performance check
- Validation: the full success criteria.

## 13. Future Considerations

- A light theme and a toggle
- A minimap for graphs with more than 30 nodes
- Command palette (`⌘K`) to jump to a node or file
- "Viewed" checkboxes per file and keyboard navigation between files and hunks (`j`/`k`)
- A web view for `graph-execution open` history: browsing past runs

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| A big-bang rewrite breaks review flows that today have no DOM tests | The phased plan keeps the pages working after each phase. Review logic moves verbatim into `review.js` before it is restyled, and every phase ends with a human-review round-trip on both pages. |
| Per-line highlighting loses multi-line context, or is slow on large diffs | Highlight each hunk's reconstructed side text in one pass and split it into lines. Fall back to plain text above 2,000 lines, and highlight lazily as files scroll into view (IntersectionObserver). |
| `backdrop-filter` and animations cost too much CPU on long runs | Limit blur to the panel, top bar and drawer, and never apply it per node. Use CSS-only animations, paused when the tab is hidden, and honour `prefers-reduced-motion`. |
| Log tailing leaks file watchers or memory | Watch only subscribed labels, unsubscribe when the SSE connection closes, keep at most 16 watched files per server, and use a byte-offset tail with no full re-reads. |
| Expand-context reads the wrong version of a file for a running node | `/file` resolves the ref the same way `ChangeTracker.fileDiff` does: a worktree for running nodes and the range `to` commit for finished ones. A test covers both. |

## 15. Appendix

- Related PRDs: `04-live-change-view.md` (the change panel this replaces), `06-human-review-round.md` (the review flow, kept as is), `07-run-cleanup-and-suite.md` (the suite page), and `09-github-style-review-comments.md` (line-range comments, written to be independent of this PRD).
- Key code:
  - pages: `src/web/page.html`, `src/suite/page.html`
  - servers: `src/web/server.ts`, `src/suite/server.ts`
  - diffs: `src/runner/changes.ts` (`fileDiff`, `capDiff`)
  - comments: `src/review/human.ts`
  - build: the `postbuild` copy in `package.json`
- Vendored sources: highlight.js (github.com/highlightjs/highlight.js), Inter (rsms.me/inter), and JetBrains Mono (github.com/JetBrains/JetBrainsMono).
