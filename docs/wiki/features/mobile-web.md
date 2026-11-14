# graph-manager on phones: nav drawer, terminal keyboard and extra keys, PWA, optional HTTPS

graph-manager's web UI and the engine's live run page work on a 360–430 px phone: no page scrolls sideways, the nav is a top bar with a drawer, a tap on a terminal opens the phone keyboard with a row of extra keys above it, and the live run graph pans and pinch-zooms. Served over HTTPS (Tailscale, own certificate or a reverse proxy), it installs as a home-screen app. Nothing changes on a desktop at 900 px and wider, apart from bigger touch targets on touch screens. The spec is `docs/prd/mobile-web.md` (or `docs/prd/done/mobile-web.md` once merged).

## How it works

- **Breakpoints** (`ui/media.ts`): `NARROW` is `(max-width: 899.98px)` (top bar, drawers, one terminal pane), `PHONE` is `(max-width: 599.98px)` (tables become cards). A touch screen is `COARSE`, `(pointer: coarse)`, not a width. `useMedia(query)` follows `matchMedia` changes.
- **Height and keyboard** (`ui/viewport.ts`, called in `Shell.tsx`): `useVisualViewport()` sets `--app-h` on `<html>` to `visualViewport.height`, and `.gm-shell` uses it, so the app fits above the keyboard on iOS too. While an editable element has focus and `visualViewport.height < innerHeight - 120`, `<html>` gets `kb-open`, which hides the top bar and the Terminals chrome below 900 px.
- **Top bar and drawer** (`Shell.tsx`, `Shell.css`): below 900 px a 48 px `.gm-topbar` holds ☰ (`nav-menu`), the brand and the page title. ☰ opens the full nav as `.gm-nav.drawer` over a scrim (`nav-scrim`); a route change, a scrim tap or Escape closes it, and it traps focus.
- **Touch on a terminal** (`components/touch.ts`): a touch `pointerup` that moved less than 10 px calls `term.focus()` in the gesture (so iOS opens the keyboard); a vertical move of 10 px or more is a swipe that becomes `WheelEvent`s on the xterm element, so the scrollback scrolls in a shell and a TUI with mouse mode gets wheel reports.
- **Extra keys** (`components/ExtraKeys.tsx`, rendered by `pages/Terminals.tsx`): `Esc`, `Tab`, `Ctrl`, the arrows and `⌃␣`, shown only on `pointer: coarse` while a terminal has focus. They send through `term.input(data, true)` like typed input; arrows follow application cursor mode; `Ctrl` is sticky for one key (`toCtrl`); `⌃␣` arms the `Ctrl Space` prefix. `preventDefault()` on `pointerdown` keeps the keyboard open.
- **PWA** (`public/manifest.webmanifest`, `public/sw.js`, `public/icons/`, `ui/standalone.ts`): a manifest and a service worker that caches nothing and only answers a failed navigation with a "graph-manager is not reachable" page with **Retry**. In standalone mode, same-origin `target=_blank` links stay in the app window. Settings → **Install app** shows the button, the iPhone steps or the HTTPS note.
- **HTTPS** (`server/config.ts`, `main.ts`, `app.ts`, `auth.ts`): `GM_TLS_CERT` and `GM_TLS_KEY` (or `--tls-cert`/`--tls-key` on `graph-execution manager`) make graph-manager serve HTTPS itself; `GM_TRUST_PROXY=1` trusts `X-Forwarded-*` behind a proxy. The session cookie is `Secure` on HTTPS.
- **Engine live run page** (`packages/graph-execution/src/web/assets`): below 600 px the top bar wraps to two lines and the phase row scrolls sideways; one finger pans the graph and two fingers pinch-zoom it (`pinchView`); the panel is a full-screen sheet with safe-area padding.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| One narrow breakpoint, `(max-width: 899.98px)`, defined once in `ui/media.ts` and reused by Shell and Terminals | The Terminals page, drawers, page padding and the engine panel already switched at 900 px; one value keeps them in step. | — |
| "Touch screen" is `(pointer: coarse)`, not the screen width | An iPad or a phone in landscape can be wider than 900 px and still needs big targets and the extra keys; a narrow desktop window must not get them. | — |
| Below 900 px a 48 px top bar with ☰ opens the full nav as a left drawer; the 56 px rail stays for 900–1099 px | The user chose a menu button over a bottom bar, and the drawer reuses the nav markup, so every item, badge and status row stays the same. | — |
| The nav drawer closes on a route change, a scrim tap and Escape, and traps focus | This is how the Terminals sidebar drawer already behaves (`ui/focus.ts`). | — |
| The app height comes from `visualViewport` (`--app-h` on `<html>`) | iOS Safari doesn't resize the layout viewport when the keyboard opens; only `visualViewport` reports the space left. | — |
| The viewport meta has `viewport-fit=cover, interactive-widget=resizes-content` and no `maximum-scale` | Paint behind the notch with safe-area padding, let Android resize for the keyboard, and keep user zoom for accessibility. | — |
| "Keyboard open" = `visualViewport.height < innerHeight - 120` while an editable element has focus | No browser says the keyboard is open; 120 px is more than any browser bar and less than any phone keyboard. | — |
| While `kb-open` is set on a narrow screen, the top bar and the Terminals top bar and tab bar are hidden | With the keyboard open a phone has 300–400 px left; every row of chrome is a terminal row lost. | — |
| A tap is a touch `pointerup` under 10 px of movement, and it calls `term.focus()` synchronously | iOS only opens the keyboard on `focus()` inside the gesture, and a scrolling swipe must not open it. | — |
| xterm's textarea gets autocapitalize/autocorrect/autocomplete off, `spellcheck=false`, `enterkeyhint=send` and a 16 px font | Otherwise the phone capitalises and autocorrects shell commands, and iOS zooms in on focus. | — |
| A one-finger swipe becomes synthetic `WheelEvent`s on the xterm element | xterm already scrolls the scrollback or sends wheel reports to mouse-mode TUIs (Claude Code); native scrolling covers only the first. | — |
| Extra keys send with `term.input(data, true)` | It goes through `onData`, so predictive echo, `onInput`, `onSubmit` and the socket see it like typed input. | — |
| The arrows follow application cursor mode (`\x1bOA` or `\x1b[A`) | It matches what xterm sends for the real keys, so vim, less and the agent TUIs behave the same. | — |
| `Ctrl` is sticky for one key; a second tap turns it off | You can't hold two keys on a touch screen; Termux works the same way. | — |
| `⌃␣` calls the page's existing `arm(true)` | The prefix actions and their hint stay in one place. | — |
| Extra-key buttons call `preventDefault()` on `pointerdown` | The xterm textarea keeps focus, so the keyboard stays open while you tap the row. | — |
| The extra-keys row shows only with `pointer: coarse` and a focused terminal, at the bottom of the page inside `--app-h` | The bottom of a page sized to the visual viewport is the top of the keyboard on iOS and Android. | — |
| Instant echo is off by default on touch screens | Phone keyboards send composition and autocorrect input the predictor wasn't built for. | — |
| Tables become cards below 600 px; the task graph and the diff scroll inside their own box | A phone can't show 6 columns; a graph and a diff only make sense at their real size. | — |
| Touch targets are 40 px under `pointer: coarse` (hit area; icons stay the same size) | 40 px is the most that fits in the pane header and tab bar; desktop sizes don't change. | — |
| The engine's live run page gets its own phone pass: a wrapping top bar, a scrolling phase row, pinch zoom and pan | It is what a phone shows during a live run. | — |
| The PWA has a service worker with no cache and only an offline fallback page | graph-manager is useless offline, and a cache would serve an old `index.html` after an upgrade; standalone mode has no reload button. | — |
| The service worker registers only in a production build, on a secure context | Browsers refuse it on HTTP anyway, and it avoids stale-worker surprises in the Vite dev server. | — |
| PNG icons (180, 192, 512, maskable 512) made by `scripts/make-icons.mjs` and committed | iOS needs a PNG touch icon and Chrome wants 192 and 512 px; committed files keep the build free of an image dependency. | — |
| In standalone mode, same-origin `target=_blank` links open in the app window | A home-screen app has its own cookies; the link opened in Safari would land on the login page. | — |
| `black-translucent` iOS status bar | The app paints under the status bar like a native app, and the safe-area padding keeps content clear of it. | — |
| HTTPS is optional and off by default; setting only one of cert/key is a startup error (exit code 2) | Laptop use on `127.0.0.1` needs no certificate; a half-set pair is a usage error. | — |
| `GM_TRUST_PROXY` is opt-in | Behind a proxy every request seems to come from the proxy, but a direct client could forge forwarded headers. | — |
| The cookie is `secure` when `req.protocol === "https"` | A secure cookie is never sent over HTTP, and plain-HTTP setups never get the flag. | — |
| The README has three recipes: `tailscale serve` (recommended), own certificate files, and a reverse proxy (Caddy) | Tailscale gives an address a phone trusts with nothing installed; the other two cover users without it. | — |
| The certificate is read once at startup | Hot reload is more code than a home server needs; `tailscale serve` and Caddy renew on their own. | — |
| Checks: jsdom unit tests for the logic, `scripts/ui-mobile.sh` (agent-browser at 390 × 844 and 360 × 740), and a manual checklist on real phones | jsdom has no layout or keyboard; agent-browser measures overflow and drives taps; only a real phone shows a real keyboard. | — |
| `ui-mobile.sh` fakes touch with an init script that makes `matchMedia("(pointer: coarse)")` true | agent-browser 0.27's viewport and `set device` don't turn on `pointer: coarse` or touch. | — |

## Known follow-ups

- Headless agent-browser can't emulate `pointer: coarse` in CSS or open a real keyboard. The 40 px targets, the 16 px inputs, `kb-open` and the terminal refit when the keyboard opens and closes are only checked by hand (the checklist below).
- A terminal swipe has no momentum: the scroll stops when the finger lifts.
- No pinch-to-zoom of the terminal font, and no long-press selection or copy in the terminal (paste works through the keyboard's own paste).
- No Alt, Home/End or PgUp/PgDn extra keys.
- No hot reload of a renewed TLS certificate, and no built-in ACME (Let's Encrypt): restart after renewing.
- Landscape uses the same rules as portrait, decided by width and `pointer: coarse`.
- A graph-manager started from inside another graph-manager terminal inherits its `GM_GRAPH_EXECUTION_BIN`, so its runs use that engine, not the local build. `ui-mobile.sh` pins `GM_GRAPH_EXECUTION_BIN` to the checkout's `packages/graph-execution/dist/cli.js` for that reason; `ui-smoke.sh` doesn't yet.

## Manual checklist (real phones)

Run it on both phones before a release that touches the phone layout. Tick each step when its expected result holds.

### iPhone (Safari)

1. [ ] Start graph-manager with `GM_TRUST_PROXY=1`, run `tailscale serve --bg 7420`, and open `https://<machine>.<tailnet>.ts.net` in Safari. Log in. → The Runs page shows; in Safari Web Inspector (Mac → Develop → the phone) → Storage → Cookies, the session cookie is `Secure`.
2. [ ] Tap ☰. → The drawer opens from the left. A nav link and a tap on the dimmed area each close it. Nothing hides under the notch or the home bar.
3. [ ] Open Runs, a finished run, a live run, Workspaces, Projects, Reviewers and Settings. → No page scrolls sideways, and every button is easy to hit with a thumb.
4. [ ] On a live run page. → The top bar is two lines and **Abort** can be reached. The phase row swipes sideways. One finger pans the graph, two fingers pinch-zoom it, and a tap on a node opens the full-screen panel. A diff scrolls only inside its box.
5. [ ] **Keyboard:** on Terminals, tap a terminal. → The keyboard opens. A swipe on the terminal does not open it.
6. [ ] With the keyboard open. → The cursor line sits right above the keyboard (above the extra-keys row). The top bar and the Terminals tab bar are hidden. Close the keyboard. → The terminal refits to the full height with no garbled screen.
7. [ ] **Extra keys,** in Claude Code. → `Esc` interrupts, `↑` recalls a prompt, `Tab` completes. In a plain shell, `Ctrl` then `c` stops a command (try `sleep 100`). `⌃␣` then `n` opens the new-terminal dialog. Tapping any key keeps the keyboard open.
8. [ ] **Swipe:** a one-finger swipe on the terminal. → It scrolls the shell's scrollback, and Claude Code's view.
9. [ ] Type in the terminal and in a form input. → No auto-capitalisation or autocorrect in the terminal, and the page does not zoom in when an input gets focus.
10. [ ] **Install:** Share → **Add to Home Screen**. → The graph-manager icon is on the home screen, it opens full screen with no Safari bar, and you log in once inside it.
11. [ ] **Offline page:** stop the server, then open the installed app. → It shows "graph-manager is not reachable" with **Retry**. Start the server and tap **Retry**. → The app loads.
12. [ ] In the installed app, tap "open ↗" on a run page. → It opens in the same window and stays logged in. A GitHub PR link opens in Safari.
13. [ ] Open the plain-HTTP address (`http://<lan-ip>:7420`). → Settings → **Install app** shows the HTTPS note with a link to the README section.
14. [ ] **Tailscale HTTPS:** on the `https://…ts.net` address. → Terminals connect (`wss:`), a live run page loads, and Create PR works.

### Android (Chrome)

1. [ ] Start graph-manager with `GM_TRUST_PROXY=1`, run `tailscale serve --bg 7420`, and open `https://<machine>.<tailnet>.ts.net` in Chrome. Log in. → The Runs page shows; in Chrome remote devtools (`chrome://inspect` on a desktop) → Application → Cookies, the session cookie is `Secure`.
2. [ ] Tap ☰. → The drawer opens from the left. A nav link and a tap on the dimmed area each close it. Nothing hides under the status bar or the gesture bar.
3. [ ] Open Runs, a finished run, a live run, Workspaces, Projects, Reviewers and Settings. → No page scrolls sideways, and every button is easy to hit.
4. [ ] On a live run page. → The top bar is two lines and **Abort** can be reached. The phase row swipes sideways. One finger pans the graph, two fingers pinch-zoom it, and a tap on a node opens the full-screen panel. A diff scrolls only inside its box.
5. [ ] **Keyboard:** on Terminals, tap a terminal. → The keyboard opens. A swipe on the terminal does not open it.
6. [ ] With the keyboard open. → The cursor line sits right above the keyboard (above the extra-keys row). The top bar and the Terminals tab bar are hidden. Close the keyboard. → The terminal refits to the full height with no garbled screen.
7. [ ] **Extra keys,** in Claude Code. → `Esc` interrupts, `↑` recalls a prompt, `Tab` completes. In a plain shell, `Ctrl` then `c` stops a command. `⌃␣` then `n` opens the new-terminal dialog (the key after `⌃␣` is caught even though Gboard sends `Unidentified` keydowns). Tapping any key keeps the keyboard open.
8. [ ] **Swipe:** a one-finger swipe on the terminal. → It scrolls the shell's scrollback, and Claude Code's view.
9. [ ] Type in the terminal and in a form input. → No auto-capitalisation or autocorrect in the terminal, and the page does not zoom in on focus.
10. [ ] **Install:** Settings → **Install app** (or Chrome's menu → **Install app**). → The app opens with no browser bar, with the graph-manager icon in the launcher.
11. [ ] **Offline page:** stop the server, then open the installed app. → It shows "graph-manager is not reachable" with **Retry**. Start the server and tap **Retry**. → The app loads.
12. [ ] In the installed app, tap "open ↗" on a run page. → It opens in the same window and stays logged in. A GitHub PR link opens in Chrome.
13. [ ] Open the plain-HTTP address (`http://<lan-ip>:7420`). → Settings → **Install app** shows the HTTPS note with a link to the README section.
14. [ ] **Tailscale HTTPS:** on the `https://…ts.net` address. → Terminals connect (`wss:`), a live run page loads, and Create PR works.

## Code

- `apps/graph-manager/src/web/ui/media.ts`: `NARROW`, `PHONE`, `COARSE`, `useMedia`.
- `apps/graph-manager/src/web/ui/viewport.ts`: `useVisualViewport` (`--app-h`, `html.kb-open`), `isKeyboardOpen`, `isEditable`, `KEYBOARD_MIN_PX`.
- `apps/graph-manager/src/web/ui/standalone.ts`: `isStandalone`, `isIos`, `standaloneLinkHandler`, `useStandaloneLinks`, `registerSw`.
- `apps/graph-manager/src/web/Shell.tsx` and `Shell.css`: the `.gm-topbar` (`gm-topbar`, `nav-menu`), `.gm-nav.drawer`, the scrim (`nav-scrim`), the focus trap.
- `apps/graph-manager/src/web/components/touch.ts`: `attachTouch` (tap and swipe), `TAP_PX`, `setTextareaAttrs`.
- `apps/graph-manager/src/web/components/ExtraKeys.tsx`: `ExtraKeys`, `keySequence`.
- `apps/graph-manager/src/web/components/TerminalView.tsx`: `TerminalHandle`, `toCtrl`, the textarea attributes and the `visualViewport` refit.
- `apps/graph-manager/src/web/pages/TerminalPane.tsx`: instant echo off by default on `COARSE`.
- `apps/graph-manager/src/web/pages/Terminals.tsx` and `Terminals.css`: the extra-keys row, sticky Ctrl, `⌃␣` → `arm(true)`, the `kb-open` rules.
- `apps/graph-manager/src/web/public/manifest.webmanifest`, `public/sw.js`, `public/icons/`, `apps/graph-manager/scripts/make-icons.mjs`, `apps/graph-manager/src/web/index.html` (viewport meta, manifest, Apple meta tags).
- `apps/graph-manager/src/server/config.ts` (`GM_TLS_CERT`, `GM_TLS_KEY`, `GM_TRUST_PROXY`), `main.ts` (`readTls`), `app.ts` (the `https` option), `auth.ts` (the `secure` cookie).
- `packages/graph-execution/src/cli.ts` and `src/manager/start.ts`: `--tls-cert`/`--tls-key` on `graph-execution manager`.
- `packages/graph-execution/src/web/assets/graph.js` (`pinchView`, `MIN_K`, `MAX_K`), `shell.css` (the phone top bar and phase row), `panel.css` (the safe-area sheet), `comments.css` (touch sizes).
- `apps/graph-manager/scripts/ui-mobile.sh`: the phone check (`npm run ui:mobile -w graph-manager`).
