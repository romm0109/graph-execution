# Unslop pass on the run view and graph-manager

## Summary

A visual pass on the `--web` run and suite pages and a polish pass on graph-manager, following the [unslop](https://github.com/heydamir/unslop) skill by Damir Sokolovsky ([@heydamir](https://x.com/heydamir), CC BY 4.0). Features, content and layout stay the same. Only styles and the status marks change, plus one layout fix: the summary card no longer covers the open side panel.

Direction used for the pass:

- **Product.** A local tool that runs a graph of coding-agent tasks for one developer, who watches, retries, reviews and merges them.
- **Character.** Exact, quiet, a little mechanical.
- **World.** A build console on a night shift, with instrument panels and switchboards.
- **Moments.** The task graph, where status colour sits only on node marks and active edges, and the diff view.
- **Signature.** A small square status mark, used on graph nodes, suite clusters, phase steps, the suite task list and the summary title.

## Decisions

| Decision | Why | Ticket |
|---|---|---|
| The run view moves from a navy and teal palette to a graphite ramp (`#0f0f10` / `#141415` / `#19191b` / `#232325`) with solid surfaces. `--blur` is now `none`. | Glass blur and tinted surfaces made every panel compete with the graph, and the graph is what people watch. | — |
| One accent, `#7aa2ff`, the same as graph-manager's dark accent. `--accent2` (violet) is now an alias of `--accent`. | Two accents with no brand behind them read as decoration. The run page is embedded in graph-manager, so one blue ties the two together. | — |
| Glows are removed: button hover, current or failed phase pill, connection dot, and the drop-shadows on running, validating and failed nodes. The breathing `pulse` on running nodes is gone. | Status shows in the square mark, a 1px stroke and the spinner. The flowing dash on active edges stays because it means "live". | — |
| Node glyphs (`○ ✔ ⚠ ⊘ ◆ ■`) become an 8×8 square `rect.mark`: hollow for pending, queued, waiting, skipped and excluded, filled in the status colour otherwise. Card selectors use `> rect:not(.mark)`. | One shape at one size, coloured by status, instead of a different glyph per status in a different font. | — |
| Done and merged nodes keep a neutral stroke. Only running (accent), failed or retryable (red) and human or stopped (amber) nodes get a coloured stroke. The selection uses a primary-text stroke. | Green on most of a finished graph made the one failure hard to find. | — |
| Phase steps are 28px, 6px-radius steps with the square mark, not glowing 999px pills. | Pills and glows everywhere. The current step is a raised surface. | — |
| Summary card: centred on the canvas (`left: calc((100% - var(--panel-w)) / 2)`), and the title is primary text with a coloured square instead of red or green text with `✔ ▲ ✖`. | It covered the side panel when both were open. A whole red headline shouted. | — |
| The progress bar animates `transform: scaleX(var(--p))`, set from `runpage.js` and `suitepage.js`, instead of `width`. | Animating layout properties stutters. | — |
| Weights are 400 and 500, buttons and controls are on a 28/32px grid with 8px radii, and italics are removed from comments and notes. | Mixed 600/700/bold, odd paddings (`3px 9px`, `1px 10px`) and 999px chips. | — |
| graph-manager keeps its tokens. Labels lose `uppercase` and wide tracking (`.t-label`, table headers, group rows, chips, the terminal sidebar sections, which now read "Workspaces root"), headings move from 600 to 500 with no negative tracking, and badges and chips use 6px and 4px radii instead of pills. | Light slop on an otherwise designed system: polish mode, no new direction. | — |
| graph-manager defaults to dark: with nothing saved, the preference is `dark` (`DEFAULT_THEME_PREF` in `ui/theme.ts`, and the first-paint script in `index.html`). System is now saved as `system` instead of clearing the key, and the theme button cycles dark → system → light. | The run page it embeds is dark only, and the tool is watched for long stretches; a light default put a dark iframe inside a light shell. | — |
| Kept: syntax and diff colours, the live pulse on graph-manager's `glyph-pulse` (it marks something actually running) and the loading skeleton fade. | Colour and motion that carry meaning. | — |

## Known follow-ups

- The run page is dark only, so graph-manager users who pick Light still see a dark run detail. A light theme for the run page would remove that seam.
- The run page still uses Inter and graph-manager uses Geist. Moving the run page to Geist means vendoring the font files in `packages/graph-execution/src/web/assets/vendor/fonts/`.

## Code references

- Tokens: `packages/graph-execution/src/web/assets/theme.css`
- Shell, phase steps, summary card: `packages/graph-execution/src/web/assets/shell.css`
- Node marks: `packages/graph-execution/src/web/assets/graph.js` (`renderNodeCard`, `HOLLOW`), `graph.css`
- Suite clusters and task list: `packages/graph-execution/src/web/assets/suitepage.js`
- graph-manager polish: `apps/graph-manager/src/web/ui/base.css`, `styles.css`, `pages/*.css`, `pages/TerminalSidebar.tsx`
- Dark default: `apps/graph-manager/src/web/ui/theme.ts`, `apps/graph-manager/src/web/index.html`, `apps/graph-manager/src/web/Shell.tsx` (`NEXT_THEME`)
