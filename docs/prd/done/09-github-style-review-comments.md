# PRD: GitHub-style review comments

## 1. Executive Summary

The human review round (PRD 06) lets you comment on the final diff before a run is applied. Today that comment UI is basic:

- On the single-run page you click **one** new-side line number. A small full-width textarea (`min-height:56px`) appears inline in the `#reviewdiff` section above the graph.
- You can't select a range of lines, and you can't comment on deleted lines.
- Comment bodies are plain text.
- No list shows every comment in the round.
- The suite page has no line anchoring at all, only a single textarea and a file dropdown.

This PRD brings the review experience to GitHub's level, on both pages:

- **Lines:** select one line or a range (drag or shift-click in the gutter) on added, context **or deleted** lines, in unified or split view.
- **Composer:** a large markdown composer opens inline under the selection, **inside the right side panel**, which gets room to work (it is wide and resizable).
- **Suggested changes:** a button inserts a ```` ```suggestion ```` block pre-filled with the selected lines. The fixer is told it is the exact replacement wanted.
- **Comments tab:** lists every comment, grouped by round with status, and clicking one jumps to its lines. The file list shows comment counts.
- **Saved bodies** render as safe markdown.
- **Earlier rounds:** comments of earlier rounds show as inline threads on that round's diff, with the fixer note and the reviewer verdict.

The data model gains `side`, `startLine` and `endLine`. Old round files (which only have `line`) still load.

This PRD is **independent** of PRD 08 (the UI redesign). It builds on today's pages. The comment logic goes into one shared module both pages load, and it relies only on a small rendering contract (data attributes on diff lines). That keeps integration with PRD 08 mechanical.

**MVP goal:** in a `--web` run with `humanReview: true`, you leave these three comments, on the run page and then on the suite page:

- a range comment on `src/api/users.ts` new lines 12–18
- a comment on a deleted line
- a suggestion on one line

You then request changes. The fixer prompt names each exact range, and the suggestion is applied. The next pause shows all three in the Comments tab with fixer notes and verdicts.

## 2. Mission

Make reviewing a run's result feel exactly like reviewing a pull request on GitHub, so precise human feedback reaches the fixer intact.

**Principles**

1. **Precise anchors.** A comment points at exact lines on an exact side. The fixer sees the same range and snippet you saw.
2. **Room to write.** The composer is a real editor surface (multi-line, markdown, preview) in the right panel, not a small box.
3. **What you preview is what's saved.** One safe markdown renderer is used for preview and for saved comments.
4. **Backward compatible.** Old `round<H>.json` files and today's `{file, line}` API calls keep working. The review flow, budgets and verdict mapping are unchanged.
5. **One implementation.** Selection, composer, suggestion and list logic live once in a shared module used by both pages.

## 3. Target Users

- **A developer reviewing a run** who has opinions about specific blocks of code and is used to GitHub PR review.
- **A suite user** reviewing the integrated result of several features. Today they can't anchor a comment to a line at all.

Technical comfort: high. Pain points today:

- You can only point at one line, and only on the new side.
- You can't say "this deleted check must come back" on the deleted line.
- The composer is tiny.
- No overview of open and resolved comments.
- To give an exact replacement you type it out in prose.
- The suite page has no line comments.

## 4. MVP Scope

### Core Functionality
- ✅ **Line selection** in the review diff:
  - hovering a line shows a `+` button in its gutter, and clicking it selects that line
  - dragging along the gutter, or shift-clicking a second line, selects a range in the same hunk side
  - the selection is highlighted
- ✅ Selectable lines are added, context and deleted lines:
  - unified view: a range covering deleted lines anchors to `side: "old"` when it has only deleted lines. Otherwise it anchors to `side: "new"`, and the range spans the new-side lines plus the context.
  - split view (when the page has one): each column selects its own side
- ✅ **Inline composer** under the last selected line, inside the right panel:
  - full panel width, auto-grows from a minimum of 8 rows to 60% of the panel height
  - **Write / Preview** tabs (markdown) and a header that shows `Commenting on lines +12 to +18` (or `−40 to −44`)
  - toolbar: **Suggestion**, bold, code, link
  - `⌘/Ctrl+Enter` saves, `Esc` cancels (with a confirm when the composer has text)
  - "needs live check" checkbox (as today)
- ✅ **Suggested changes:**
  - **Suggestion** inserts a ```` ```suggestion ```` block holding the selected new-side lines. It is disabled for `side: "old"`.
  - Saved suggestions render as a mini-diff (selected lines vs. the suggestion)
  - the fixer prompt states that the block is the exact replacement for those lines
- ✅ **File and general comments** stay: a "comment on file" button on each file header, and a general comment composer at the top of the Review area. Both use the same big composer.
- ✅ **Saved comments** render inline under their range as GitHub-style threads:
  - author "you", round id, status, markdown body
  - Edit and Delete (current round)
  - Resolve and Reopen with a follow-up (earlier rounds, as today)
- ✅ **Comments tab** (or section) in the review panel:
  - all comments grouped by round, then by file
  - filters: Open / Resolved / All
  - each item shows `file:L12–L18`, the first line of the body, status, fixer note and verdict
  - clicking an item opens that round's diff, scrolls to the range and flashes it
  - the file list shows a 💬 count per file
- ✅ **Earlier rounds:** switching the round shows that round's diff with its comments inline, plus the fixer note, reviewer verdict and live-check result under each thread (as PRD 06 requires, comments stay pinned to their round)
- ✅ **Review in the right panel on both pages:**
  - when the run waits for review, the review diff, comments and decision buttons open in the right side panel instead of above the graph
  - the panel opens at ≥ 60% of the viewport width and has a drag handle on its left edge
  - this mirrors PRD 08 §7.3: the same `localStorage` key `ge.panel` and the same min and max limits
- ✅ **Suite page parity:** the suite review diff gets line numbers, selection and inline threads, with the same module as the run page. Its review diff today is a raw `<pre>`, so this PRD replaces it with the run page's `fillDiff`-style rendering (line numbers, data attributes).

### Out of Scope
- ❌ Comments on node or task diffs while the run is running (only the final review diff, as today)
- ❌ Reply threads or several reviewers (Reopen with a follow-up remains the only "reply")
- ❌ Moving comments onto a newer round's diff ("outdated" re-anchoring)
- ❌ Ranges that cross hunks or files
- ❌ Applying suggestions yourself in the browser (the fixer applies them)
- ❌ Emoji reactions, mentions, images in comments
- ❌ The full visual redesign (PRD 08)

### Technical
- ✅ `commentSchema` gains optional `side`, `startLine` and `endLine`. `line` is kept as a legacy alias (read as `{side:"new", startLine:line, endLine:line}`).
- ✅ The snippet is the exact selected lines (≤ 2,000 chars, with an ellipsis note when cut). Today's "line plus 2 before" heuristic goes away for new comments.
- ✅ The finding text, fixer prompt and reviewer prompt include the range, the side and the suggestion semantics
- ✅ Shared browser module `src/web/assets/comments.js` (with `comments.css`) loaded by both pages. A minimal `GET /assets/*` route (`/assets/*` on the suite server too) and a `postbuild` copy. Both are written so that they are the same route and helper PRD 08 defines (`serveAsset`), and whichever lands second reuses them.
- ✅ A tiny safe markdown renderer `src/web/assets/markdown.js` (escape first, then a whitelist: paragraphs, line breaks, `**`, `_`, inline code, fenced code, `-`/`1.` lists, `[text](http…)` links with `rel=noopener`, and suggestion blocks)

### Integration
- ✅ Comment findings still flow through `commentFindings` → `openBlocking` → fixer → `applyCommentVerdicts` (`src/review/human.ts`, `src/review/phase.ts`)
- ✅ `liveCheck` comments still become `must` test cases

### Deployment
- ✅ Ships in the npm package. No new dependencies. README "Human review" section updated with a GIF of range selection and suggestions.

## 5. User Stories

1. **As a** reviewer, **I want to** select a range of lines and comment on it, **so that** the fixer knows exactly which block I mean.
   *Example:* I drag in the gutter from `+12` to `+18` in `src/api/users.ts`. The composer header says "Commenting on lines +12 to +18", and I write "extract this into `paginate()`".
2. **As a** reviewer, **I want to** comment on deleted lines, **so that** I can say "don't remove this".
   *Example:* on the deleted lines `−40 … −42` (`if (!user.active) return 403;`) I write "this check must stay". The fixer prompt shows `src/api/users.ts old L40–L42` with the removed snippet.
3. **As a** reviewer, **I want to** suggest the exact replacement, **so that** I don't describe code in prose.
   *Example:* I select `+27`, click **Suggestion**, and change `const limit = q.limit` to `const limit = Math.min(Number(q.limit) || 20, 50)`. The saved comment shows a red and green mini-diff. In the next round the line matches and the reviewer marks it addressed.
4. **As a** reviewer, **I want** a big composer with preview, **so that** I can write detailed feedback comfortably.
   *Example:* the panel is at 70% width. The composer grows to 20 lines while I write a list and a code block, and the Preview tab shows them formatted. `⌘Enter` saves.
5. **As a** reviewer, **I want** a list of all comments, **so that** I can see what's open and jump to each one.
   *Example:* the Comments tab shows "Round 1 · 3 comments (2 addressed, 1 not addressed)". I click H1-3 and the panel switches to round 1's diff, scrolls to `admin.ts:L8–L9` and flashes it. I click **Reopen** and add "you missed the export".
6. **As a** suite user, **I want** the same line comments on the suite review, **so that** I can review integrated results precisely.
   *Example:* on the suite page's integration review, I select `+5..+9` in `src/index.ts` and comment. It is saved with the same fields as on the run page.
7. **As a** user with an old run, **I want** old comments to still load, **so that** resuming a paused run doesn't break.
   *Example:* `--resume` on a run whose `round1.json` has `{line: 18}`. It shows as a one-line comment on `+18`.
8. **(Technical) As a** maintainer, **I want** selection, anchoring, snippet extraction and markdown rendering as pure functions with unit tests, **so that** the anchors are right on both pages.

## 6. Core Architecture & Patterns

```
 review diff (either page)                 shared: src/web/assets/comments.js
 ┌─────────────────────────────────┐      ┌─────────────────────────────────────────────┐
 │ line rows with data-file,       │◄────►│ selection: pointer events on gutter          │
 │ data-side, data-old-line,       │      │   rangeFrom(anchorRow, focusRow) (pure)      │
 │ data-new-line, data-kind        │      │ anchor(range, hunkLines) → {side,start,end}  │
 └─────────────────────────────────┘      │ snippetFor(anchor, hunkLines) (pure)         │
                                          │ composer (write/preview, toolbar, keys)      │
                                          │ threads: place(comment) after end line       │
                                          │ list: group/filter/jump                      │
                                          └──────────────┬──────────────────────────────┘
                                                         │ POST /review/comments  {file, side, startLine, endLine, snippet, body, liveCheck}
                                                         ▼
                                   src/review/human.ts  commentSchema (+side/startLine/endLine; line = legacy)
                                                         │ commentFindings → finding {file, line:startLine, endLine, side, failureScenario}
                                                         ▼
                                   src/agents/fixer.ts  humanSection: "file old|new L12–L18", snippet, suggestion rule
                                   reviewer prompt      verdict per comment (unchanged mapping)
```

**Rendering contract.** Each page's diff renderer (today's `fillDiff` on the run page, and the suite review diff once it is upgraded) tags every line row with these attributes:

```html
<div class="dl" data-file="src/api/users.ts" data-kind="add|del|ctx"
     data-old-line="40" data-new-line="" data-hunk="2"></div>
```

and calls `comments.mount(container, { round, readOnly, api })`. PRD 08's viewer emits the same attributes, so the module works unchanged on top of it.

**Anchor rules (pure, `anchor()`)**
- Every row in the range is in the same file and the same hunk; otherwise the selection is clipped to the anchor's hunk.
- Every row is a `del` row → `side:"old"`, and start and end are old line numbers.
- Otherwise → `side:"new"`. Start and end are the new line numbers of the first and last non-deleted rows. Deleted rows inside the range are still included in the snippet, marked with `-`.
- In split view, the column you start the selection in fixes the side.

**Data model** (`src/review/human.ts`)

```ts
export const commentSchema = z
  .object({
    id: z.string().regex(/^H\d+-\d+$/),
    round: z.number().int().min(1),
    file: z.string().min(1).optional(),
    side: z.enum(["new", "old"]).optional(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    line: z.number().int().min(1).optional(),          // legacy: one new-side line
    snippet: z.string().max(2000).optional(),
    body: z.string().trim().min(1).max(10_000),
    liveCheck: z.boolean().default(false),
    status: z.enum(["open", "resolved", "reopened"]).default("open"),
    followUps: z.array(z.string().min(1)).default([]),
  })
  .transform((c) => (c.line !== undefined && c.startLine === undefined
    ? { ...c, side: "new" as const, startLine: c.line, endLine: c.line }
    : c));
// refine: startLine ≤ endLine; startLine needs file; side defaults to "new" when startLine is set
```

New comments are saved without `line`. Legacy files are normalized on read and written back in the new shape the next time the round is saved.

**Suggestions.** A suggestion is a ```` ```suggestion ```` fence in the body. No separate field is needed. `parseSuggestion(body)` is pure and returns the replacement text or `undefined`. A suggestion is only valid for `side:"new"`; the server rejects one on `side:"old"` with `400`.

## 7. Tools/Features

### 7.1 Selection UX
- The gutter `+` button appears on row hover (on the new-number column, or the old-number column for deleted rows) with a tooltip "Comment on this line (drag for a range)".
- **Drag:** pointerdown on `+` → pointermove over gutters → pointerup opens the composer. The page auto-scrolls when the pointer is near the top or bottom of the panel.
- **Shift-click:** with a single-line selection active, shift-clicking another row's `+` extends the selection.
- **Highlight:** the selected rows get `.sel` (a translucent accent background and a 3px accent bar on the left edge).
- **Keyboard:** with focus on a row's `+`, Shift+↑/↓ extends the selection and Enter opens the composer.
- Only one composer can be open at a time. Opening a second one while the first has text asks first.

### 7.2 Composer
- Header: the file path and `Commenting on lines +12 to +18` / `line −40` / `this file` / `the whole change`.
- Tabs: Write | Preview. Preview runs `markdown.js` on the body.
- Toolbar:
  - **Suggestion** (±): disabled for `side: "old"`. It inserts `\n```suggestion\n<selected new lines>\n```\n` at the cursor.
  - **B**, `</>`, 🔗: wrap the selection
- Textarea: monospace, minimum 8 rows. It auto-grows to 60% of the panel height and then scrolls. Tab inserts two spaces inside code fences.
- Footer: ☐ needs live check · *Cancel* · **Comment** (`⌘/Ctrl+Enter`).
- Drafts: the composer text is kept in `sessionStorage` per anchor until it is saved or cancelled. The comment itself is saved to the server on *Comment*, as today.

### 7.3 Threads (saved comments)
- Placed after the row of `endLine` on the matching side. A file comment sits under the file header, and a general comment sits at the top of the review area.
- The range gets a faint persistent highlight while the thread is hovered.
- Card: `H2-3 · lines +12–18 · open`, the markdown body, then:
  - suggestion blocks as a mini-diff (snippet lines in red, suggestion lines in green)
  - follow-ups
  - for earlier rounds: *Fixer:* note · *Reviewer:* addressed/not addressed + evidence · *Live check:* pass/fail
- Actions: current round → Edit (opens the composer pre-filled) and Delete (with a confirm). Earlier rounds → Resolve and Reopen (Reopen opens the composer for the follow-up).
- If a comment's lines are not in the rendered diff (for example the file is truncated), the thread shows under the file header with the note "lines not shown".

### 7.4 Comments list
- In the review panel, as a **Comments (n)** section or tab next to Files.
- Grouped by round (newest first), then by file. Each row shows a status dot, `file:L12–L18`, the first 80 characters of the body, and a verdict chip.
- Filters: Open (default), Resolved, All, and "this round only".
- Click → switch the round if needed, expand the file, scroll the range into view, and flash it for 1.2s.
- The file list shows a 💬 count of open comments per file.

### 7.5 Fixer and reviewer prompts
- `commentFindings`:
  - `line: startLine`, plus `endLine` and `side` on the finding (`src/review/report.ts` `findingSchema` gains optional `endLine` and `side`)
  - `failureScenario` is `src/api/users.ts new L12–L18\n<snippet>`, or `old L40–L42`
- `humanSection` in `src/agents/fixer.ts`:
  - each comment is shown as `- **human-H1-2** \`src/api/users.ts\` new lines 12–18:`, followed by the snippet in a fenced block and then the body
  - when a comment has a suggestion, it adds "Replace exactly these lines with the suggestion block, unless that breaks the build; if you deviate, say why in your note."
  - for `old` comments: "these lines were removed by the change; the reviewer is commenting on the removal"
- The code reviewer's prompt gets the same range text. The verdict mapping is unchanged.

### 7.6 Right panel for review
- **Run page:** when `review.waiting` (or a past round is selected), the review diff, comments and decision buttons render in `aside#panel` instead of `#reviewdiff`. The panel opens at `max(60vw, 640px)` (capped at 85vw) and has a 6px drag handle on its left edge. The width is kept in `localStorage['ge.panel']`.
- **Suite page:** the same, in its panel.
- The decision buttons (Request changes (n), Apply / Apply anyway, Drop) stick to the bottom of the panel.
- If PRD 08 has landed, this section is satisfied by its Review tab, and only `comments.mount` is wired in.

## 8. Technology Stack

- Node ≥ 20, TypeScript and zod (existing) for the schema and server changes
- Vanilla ES2022 browser modules: `src/web/assets/comments.js`, `markdown.js` and `comments.css`, with `// @ts-check` and JSDoc
- vitest unit tests for the pure functions: `rangeFrom`, `anchor`, `snippetFor`, `parseSuggestion`, `renderMarkdown`, `groupComments`, plus the schema normalization and prompt text
- No new dependencies. The markdown renderer is home-grown (~150 lines) to keep the package dependency-free and fully escaped.
- Browser checks: an `agent-browser` smoke checklist in `TESTING.md`

## 9. Security & Configuration

- Localhost-only and no authentication, as today.
- **Markdown safety:**
  - the renderer HTML-escapes the whole body first, then applies whitelisted transforms
  - links only for `http:`/`https:`, with `target=_blank rel="noopener noreferrer"`
  - no raw HTML, images or `style` attributes
  - unit tests cover XSS payloads (`<script>`, `javascript:` links, `onerror=`, unclosed fences)
- Input limits as today: body ≤ 10k chars, snippet ≤ 2k, and also `endLine - startLine ≤ 500`.
- The server checks that `file` is one of the files in the round's diff, and that `startLine`/`endLine` are within that file's diff range when they can be resolved. If they can't, the comment is accepted, as today.
- No new config keys.

## 10. API Specification

Same endpoints, with extended bodies. The run server uses `/review/...` and the suite server uses `/api/review/...`.

**`POST /review/comments`**
```json
{
  "file": "src/api/users.ts",
  "side": "new",
  "startLine": 12,
  "endLine": 18,
  "snippet": "  const rows = await db.users.findMany();\n  ...",
  "body": "Extract into `paginate()`.\n\n```suggestion\nconst rows = await paginate(db.users, q);\n```",
  "liveCheck": false
}
```
→ `201` with the saved comment. The legacy body `{ "file": "...", "line": 18, ... }` is still accepted and stored as `side:"new", startLine:18, endLine:18`.

Errors (`400`):
- `startLine needs a file`
- `endLine before startLine`
- `range too long`
- `suggestion needs side new`

**`PUT /review/comments/:id`** → `{ body?, liveCheck? }` (unchanged; the range cannot be edited, so delete and re-comment to change it).

**`GET /review`** returns each comment with `side`, `startLine` and `endLine` always set for line comments (legacy ones are normalized), so the client never reads `line`.

## 11. Success Criteria

**MVP success:** the MVP-goal scenario works on both pages, the fixer prompt contains exact ranges and the suggestion rule, and an old-format round file resumes correctly.

**Functional**
- ✅ Single-line, drag-range and shift-click range selection, on add, ctx and del rows, in unified view (and in split view where the page has it)
- ✅ Side and line anchoring follow the rules in §6 (unit-tested with mixed hunks)
- ✅ The composer opens inline in the right panel: ≥ 8 rows, auto-grow, Write/Preview, toolbar, `⌘Enter`/`Esc`, live-check checkbox
- ✅ Suggestion insert, mini-diff render, fixer prompt rule, and the server rejects suggestions on old-side comments
- ✅ Saved comments show as inline threads with markdown, and Edit/Delete or Resolve/Reopen work as today
- ✅ The Comments list groups, filters and jumps to the range, and the file list shows per-file counts
- ✅ Earlier-round threads show the fixer note, verdict and live check inline on that round's diff
- ✅ The suite page has full parity (line numbers in its review diff, selection, threads, list)
- ✅ Legacy `line` comments load, display and are fixed exactly as before

**Quality**
- ✅ The pure functions have ≥ 90% coverage, and the markdown XSS test suite passes
- ✅ The existing `server.test.ts`, `human` and `fixer` tests pass, with additions for the new fields
- ✅ The `TESTING.md` smoke checklist passes with agent-browser on both pages

**UX goals**
- Someone who has reviewed a GitHub PR can comment on a range without instructions
- Writing a 20-line comment never feels cramped

## 12. Implementation Phases

**Phase 1: data model and prompts**
- Goal: ranges and suggestions work end to end through the API, with no UI yet.
- ✅ `commentSchema` with side, startLine and endLine and legacy normalization. Server validation on both servers.
- ✅ `findingSchema` gets `endLine` and `side`. Update `commentFindings`, the `humanSection` fixer prompt and the reviewer prompt.
- ✅ `parseSuggestion` and the old-side rejection
- Validation: unit tests, plus a fake-provider run where a POSTed range comment shows up in the fixer prompt.

**Phase 2: shared module and selection**
- Goal: select lines and open the composer on the run page.
- ✅ The `/assets/*` route on both servers and the `postbuild` copy
- ✅ `comments.js`: data attributes on the run page's `fillDiff`, `rangeFrom`, `anchor`, `snippetFor`, gutter `+`, drag, shift-click, keyboard
- ✅ Composer with Write/Preview (`markdown.js`), toolbar, suggestion, keys
- ✅ Review moves into the right panel at ≥ 60vw with a drag handle
- Validation: smoke checklist items on the run page.

**Phase 3: threads, list and earlier rounds**
- Goal: full review loop on the run page.
- ✅ Inline threads, the mini-diff for suggestions, Edit/Delete/Resolve/Reopen
- ✅ Comments list, filters, jump-to-range, per-file counts
- ✅ Earlier-round inline threads with the fixer note, verdict and live check
- Validation: a human-review round-trip with three comments, then Request changes, then a check of the notes and verdicts.

**Phase 4: suite parity and docs**
- Goal: the suite page matches the run page.
- ✅ Replace the suite page's raw review `<pre>` with line-numbered rendering that carries the data attributes, and mount `comments.js`
- ✅ README "Human review" update with a GIF, and the `TESTING.md` checklist
- Validation: the full success criteria on both pages.

## 13. Future Considerations

- Re-anchor open comments onto the next round's diff ("outdated" badge), as on GitHub
- Reply threads and several reviewers (with authentication)
- Commenting on node diffs during the run, queued for the review round
- "Apply suggestion" in the browser as a human commit that still goes through validation
- Batch "Start a review" mode with a summary comment when you request changes

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| PRD 08 and PRD 09 both touch the diff rendering and the panel (merge conflicts in a suite run) | 09 limits itself to the data-attribute contract, a separate `comments.js`/`markdown.js`, and the same `serveAsset` route and `ge.panel` key that 08 defines. The integration step keeps 08's renderer and panel and only wires in `comments.mount`. |
| Mixed add/del ranges anchor confusingly, so the fixer edits the wrong lines | The anchor rules in §6 are pure and table-tested. The composer header always shows the resolved anchor (`+12 to +18`), and the snippet sent to the fixer is the exact rows shown, including `-` rows. |
| Legacy normalization corrupts old round files | Normalize on read, and only write when the round is saved for another reason. A fixture `round1.json` with `line` is tested through load, save, `commentFindings` and the fixer prompt. |
| A home-grown markdown renderer creates an XSS hole | Escape everything first and only add whitelisted tags. A dedicated payload test suite, and links restricted to http(s). |
| Drag selection is janky inside a scrolling panel | Pointer capture on the gutter, row hit-testing with `elementFromPoint` throttled to `requestAnimationFrame`, and auto-scroll near the edges. Covered in the smoke checklist with a 300-line hunk. |

## 15. Appendix

- Related PRDs:
  - `06-human-review-round.md`: the flow, budgets and verdicts, all unchanged
  - `04-live-change-view.md`: the diff panel
  - `08-web-ui-redesign.md`: the redesign, independent; see Risks for integration
- Key code:
  - `src/review/human.ts`: `commentSchema`, `commentFindings`, `applyCommentVerdicts`, `HumanComments.add`
  - `src/review/report.ts`: `findingSchema`
  - `src/agents/fixer.ts`: `humanSection`
  - `src/web/server.ts`: `newCommentSchema`, `/review/*`
  - `src/suite/server.ts`: `/api/review/*`
  - `src/web/page.html`: `fillDiff`, the line-comment form
  - `src/suite/page.html`: the review `showDiff` and the comment form
- Reference UX: GitHub pull request "Files changed" line comments and suggested changes.
