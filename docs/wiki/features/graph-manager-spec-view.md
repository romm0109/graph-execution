# graph-manager: see the spec while it is being created (KAN-82)

## Summary

The agent writes a spec (PRD) into `docs/prd/<name>.md` of a workspace with the new `to-spec` skill. graph-manager polls the focused terminal's workspace for `docs/prd/*.md`. When one is created or changes, a floating pane opens over the Terminals page and shows it live, with Markdown and Mermaid diagrams. The user reads it there and answers the agent in the terminal, either asking for changes or approving. **Create PR** moves the run's spec to `docs/prd/done/` in the PR's commit. Spec: `docs/prd/done/graph-manager-spec-view.md`. Tasks: `.agents/tasks/spec-view/`. User docs: the Skills section of `packages/graph-execution/README.md` and "First steps" and "The app" in `apps/graph-manager/README.md`.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| The spec view lives in graph-manager, as a floating pane on the Terminals page, not as a command in the engine. | The ticket is a graph-manager ticket. The spec is written while the user talks to the agent in a terminal. | KAN-82 |
| No spec status, no approval gate, no Approve button. The agent asks for approval in the chat. | The user asked for it, to avoid the extra steps. | KAN-82 |
| A spec is any `.md` file directly in `docs/prd/`. `done/`, other subfolders and symlinks are ignored. | Matches where `to-spec` writes. Symlinks could point outside the workspace. | KAN-82 |
| The pane opens by itself when a spec gets a newer modification time than any seen since the page loaded, and follows it. A `spec <name>` chip on the terminal reopens it. | The user chose auto-open plus a chip. Old specs don't pop up on every page load. | KAN-82 |
| The page polls every 2 s (`POLL_MS`) instead of using a file watcher. | Every graph-manager screen polls. | KAN-82 |
| marked 18.1.1 and Mermaid 12.2.0 are graph-manager dependencies. Mermaid is loaded only when the pane renders, so it stays out of the main bundle. | Works offline, and the main bundle stays small. | KAN-82 |
| Raw HTML in a spec shows as text. Only `http(s)`, relative and `#` links keep their `href`. Mermaid runs with `securityLevel: "strict"`. | Specs come from agents, and graph-manager's origin holds the session cookie. | KAN-82 |
| The file route refuses every symlink with 400, whatever its target. | Otherwise a 404-or-400 answer reveals whether a path outside the workspace exists (review finding F3, fixed by hand after the run). | KAN-82 |
| The spec moves to `done/` in Create PR's commit step, not in the engine. Specs under `.graph-execution/`, outside the workspace or already in `done/` are left alone. | The user chose it, so the move is part of the PR. | KAN-82 |
| The finished PRDs (`01`–`12`, `bug-hunt-ge-01-13`, `graph-manager*.md`) and this spec were moved to `docs/prd/done/` by hand in this change. | One-off migration, so `docs/prd/` holds only specs in progress. | KAN-82 |

## Known follow-ups

- **F1 (review, minor):** only terminals in the focused workspace show the `spec` chip. In a split layout, an unfocused pane in another workspace shows it only once focused.
- **F2 (review, minor):** a slow answer for the previously focused workspace can overwrite the current one, so the chip and spec list vanish for one poll (about 2 s).
- **F4 (review, minor):** saving the spec briefly turns the diagrams back into their source before they are redrawn, so the content can jump.
- **Tester note:** at its default spot, the open pane covers the right end of the terminal's pane head, where the chip sits.
- After Create PR the workspace goes back to its original branch, where the spec is still in `docs/prd/`. It reaches `done/` there once the PR is merged and pulled.
- The Docker image doesn't install the bundled skills into the terminals' home folder. A project gets `to-spec` from `graph-execution install skills`.

## Code references

- `apps/graph-manager/src/server/routes/specs.ts`: `GET /api/workspaces/:id/specs` and `…/specs/file?path=`.
- `apps/graph-manager/src/server/specdone.ts`: `moveSpecToDone`, called from `runPrJob` in `apps/graph-manager/src/server/pr.ts`.
- `apps/graph-manager/src/web/spec.ts`: `renderSpecHtml` (marked with escaped HTML and safe links), `mermaidSources`.
- `apps/graph-manager/src/web/components/SpecView.tsx`: the rendered spec with lazily loaded Mermaid diagrams.
- `apps/graph-manager/src/web/pages/specPane.ts`: `nextWatch` (when to auto-open) and the saved pane box (`gm.specPane`).
- `apps/graph-manager/src/web/pages/SpecFloat.tsx`: `useWorkspaceSpecs` and the floating pane (drag, resize, Escape, narrow mode).
- `apps/graph-manager/src/web/pages/Terminals.tsx`, `TerminalPane.tsx`: wiring and the `spec <name>` chip.
- `packages/graph-execution/skills/to-spec/SKILL.md` (copy in `.claude/skills/to-spec/`): the skill.
