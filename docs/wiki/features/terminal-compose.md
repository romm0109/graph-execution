# Terminal lag: WebGL, batched output, and the compose bar

graph-manager's terminals lagged on a remote host (a VPS), plain shells included and Claude Code most of all. Measured on the server with no network in between, a key's echo takes about 1 ms (median 1.1 ms, worst 3 ms over 40 keys), so almost all of the lag is the round trip each key makes to the server and back. Two changes address it: the terminal renders and streams faster, which helps full-screen agents, and a compose bar lets you type locally, which removes the round trip from typing.

## Decisions

| Decision | Why |
| --- | --- |
| Keep xterm.js, node-pty and the WebSocket; don't move to another terminal | It is the standard stack (VS Code's remote terminal, ttyd), and the server adds about 1 ms. Another terminal would make the same round trip. |
| Render with `@xterm/addon-webgl`, falling back to the DOM renderer | The DOM renderer re-lays out HTML on every redraw, and Claude Code redraws its input box on each key. |
| Upgrade xterm 5.5 → 6.0 | 6.x supports synchronized output (DEC mode 2026), so a TUI's frame is drawn whole. `@xterm/addon-fit` 0.11 and `@xterm/addon-webgl` 0.19 were published alongside 6.0.0. |
| Batch PTY output into ~6 ms frames (`batchOutput`) | A redraw is dozens of small chunks; one JSON frame each floods the socket. A chunk after 6 ms of quiet goes out at once, so a key's echo isn't delayed. Pending output is flushed before `exit` and `restart`. |
| Compose bar on by default, terminal display only meanwhile | Typing in a local textarea has no round trip. A terminal that also takes keys invites typing in two places, so it shows no cursor, sets `disableStdin`, and moves typed keys to the box. |
| Send a message as one paste, then Enter 40 ms later | A paste (bracketed when the program asked for it) keeps a multi-line message together; a separate Enter keeps a TUI from reading it as part of the paste. Escape characters are stripped so pasted text can't end the paste early. |
| With the box empty, Enter, Esc, arrows, Tab and Shift Tab go to the terminal; Esc and Ctrl C always do | Agents ask questions through menus and need interrupting while you draft. |
| Keep terminals rather than replace them with a chat view | Logins, slash commands and plain shells need a real terminal; a chat view for agents is a separate, later feature. |

## Known follow-ups

- Predictive local echo (as in mosh, or VS Code's `terminal.integrated.localEchoEnabled`) would remove the lag when typing straight into the terminal too.
- A chat view for agents, built on the providers' structured output, with tool calls and skill loads, switching agents mid-conversation, and fallback agents for runs.

## Code

- `apps/graph-manager/src/server/output-batch.ts`: `batchOutput`, used by the terminal WebSocket in `src/server/routes/terminals.ts`.
- `apps/graph-manager/src/web/components/TerminalView.tsx`: WebGL, `readOnly`, the `control` ref (`input`, `paste`, `focus`), `pasteData`.
- `apps/graph-manager/src/web/components/ComposeBar.tsx`: the box and `passthroughKey`; `Mascot.tsx` is the agent icon beside it.
- `apps/graph-manager/src/web/pages/TerminalPane.tsx`: the toggle (`localStorage["gm.compose"]`), sending, and moving keys typed into the terminal to the box.
