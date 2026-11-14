# Terminal lag: instant echo, WebGL, batched output

graph-manager's terminals lagged on a remote host (a VPS), plain shells included and Claude Code most of all. Measured on the server with no network in between, a key's echo takes about 1 ms (median 1.1 ms, worst 3 ms over 40 keys), so almost all of the lag is the round trip each key makes to the server and back. The fix is the one mosh and VS Code use, applied to the browser terminal: draw each typed character at once as a guess, and let the real echo confirm it.

## How instant echo works

1. A typed key goes to the server unchanged, as before. At the same moment, `xterm-zerolag-input`'s `PredictiveEchoAddon` draws the character at the terminal cursor, on a DOM layer above the screen (`[data-predictive-echo]`). A full-screen TUI redraws the screen all the time, but it can't reach that layer.
2. When the output is parsed, each guess is checked against the real cell. It is removed once the cell shows that character and the cursor has passed it. A different character drops the guess and the ones after it. Guesses also expire after 1 s.
3. Enter, Esc, arrows, Tab, Ctrl keys and pastes clear the guesses, because their effect can't be guessed. The library then holds new guesses until the next output.

The program gets every key immediately, so its own triggers (`/` commands, `@` files, Codex's `$` skills) and menus work unchanged. That is why this replaced the compose bar.

## Decisions

| Decision | Why |
| --- | --- |
| Keep xterm.js, node-pty and the WebSocket | It is the standard stack (VS Code's remote terminal, ttyd), and the server adds about 1 ms. Another terminal would make the same round trip. |
| Predictive echo in the terminal, not a compose bar | A local message box (tried first) types without lag, but the agent never sees the keys until Enter, so its `/`, `@`, `$` menus can't open. Reproducing each agent's triggers doesn't scale, and mirroring keys to the agent goes out of sync when its menu edits the line. With predictive echo the agent stays the only input. |
| Use `xterm-zerolag-input` (MIT, no dependencies) in predictive mode | It does the hard parts: an overlay a TUI can't overwrite, checking guesses against parsed cells, and edge, scroll and resize handling. Its prompt-scanning buffered mode isn't needed, because Claude Code 2.1 keeps the real cursor at the input caret (checked with `@xterm/headless`: after typing `hello wor` at `❯`, the cursor sits right after it, visible). |
| `allowProposedApi: true` on the terminal | The addon measures characters with `term.unicode`, which throws without it. The addon catches the error and silently predicts nothing. |
| The terminal's own reports (focus, mouse, query answers) don't clear guesses | Claude Code turns on focus and mouse reporting. Clearing on `ESC[I` or `ESC[<35;…M` held every guess until the next output, so the first keys after a click or a mouse move got no instant echo. |
| No guess while the cursor is hidden, while scrolled up, or at a password, passphrase, PIN, token or secret prompt | A hidden cursor means the program draws its own input. A secret must not be drawn, even for a moment. |
| Back off for 10 s after 3 writes in a row that drop guesses and confirm none; Enter resets | It adapts like mosh: a program that doesn't echo (a no-echo prompt, a TUI that redraws elsewhere) stops getting guesses. Guesses we clear ourselves don't count. |
| Measure the round trip with `ping`/`pong` over the terminal socket every 4 s, shown under the terminal | You can tell network lag from a slow agent; green under 80 ms, amber under 200 ms, red above. |
| Instant echo on by default, with a switch in the strip | It only draws guesses and never changes what is sent, so it is safe to leave on; the switch is there for a program where guesses look wrong. |
| WebGL renderer, xterm 6, ~6 ms output batches | The DOM renderer re-lays out HTML on every redraw. xterm 6 supports synchronized output (DEC 2026). A redraw is dozens of small chunks; batching them cuts frames, while a chunk after 6 ms of quiet goes out at once. |
| The mascot sits in the strip under the terminal, with an emote per agent | Claude Code: hop, spin and a ring of ✻ on landing. Codex: a whirlpool spin with a ripple. OpenCode: a box flip with braces. Qwen Code: three bounces with hexagons. A plain shell: a nod and a `>_` bubble. It also bobs while the process prints, gulps on Enter, gets dizzy after 5 quick clicks, and naps after 45 s idle. |

## Known follow-ups

- Codex, OpenCode and Qwen Code weren't available to test here. If one hides its cursor or draws its input away from it, guesses are switched off for it by the hidden-cursor check, or dropped and backed off. If it looks wrong, the switch turns echo off.
- In headless Chromium at device scale factor 2, the WebGL renderer showed a blank terminal for an idle shell, before this change as well. Real browsers weren't affected in testing; watch for it on high-DPI screens.
- A chat view for agents, built on the providers' structured output (tool calls, skill loads, switching agents mid-conversation, fallback agents for runs), is a separate feature.

## Code

- `apps/graph-manager/src/web/components/predictiveEcho.ts`: `classifyInput`, `isSecretPrompt`, `EchoBackoff`, `attachPredictiveEcho`.
- `apps/graph-manager/src/web/components/TerminalView.tsx`: WebGL, `allowProposedApi`, instant echo, ping, `onInput`, `onSubmit`, `onLatency`.
- `apps/graph-manager/src/web/pages/TerminalPane.tsx`: the strip under the terminal (`.tp-foot`), the switch (`localStorage["gm.instantEcho"]`), and the busy state (output not within 400 ms of a key).
- `apps/graph-manager/src/web/components/Mascot.tsx` and `Mascot.css`: the mascot, `EMOTES`.
- `apps/graph-manager/src/server/output-batch.ts`: `batchOutput`. `src/server/routes/terminals.ts`: the `ping` message.
