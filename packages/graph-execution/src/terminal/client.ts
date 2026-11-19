// The browser side of the shared terminal: an xterm attached to a terminal WebSocket (socket.ts), without React.
// graph-manager's TerminalView and the run page both mount it. It has no bare imports (the run page has no bundler):
// the xterm classes are passed in, and only ./echo.js and ./touch.js are imported.
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { WebglAddon as XWebglAddon } from "@xterm/addon-webgl";
import type { ITerminalOptions, ITheme, Terminal as XTerminal } from "@xterm/xterm";
import { attachPredictiveEcho, type PredictiveEchoAddonClass } from "./echo.js";
import { attachTouch, setTextareaAttrs } from "./touch.js";

export * from "./echo.js";
export * from "./touch.js";

export type ServerMessage =
  | { type: "replay"; data: string }
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "restart" }
  | { type: "pong"; t: number };

/** How often the round trip to the server is measured while attached. */
export const PING_MS = 2000;
/** The first ping waits this long after attaching: the scrollback replay is still being drawn and would delay the pong. */
export const FIRST_PING_MS = 1000;

/** `open`: attached; `reconnecting`: the socket dropped and a retry is scheduled; `gone`: the server doesn't know the terminal (4404). */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "gone";

/** Reconnect delays in ms: 0.5 s, 1 s, 2 s, then 4 s and 5 s at most. */
export function reconnectDelay(attempt: number): number {
  return Math.min(5000, 500 * 2 ** Math.max(0, attempt));
}

/** The control code for one character (Ctrl+c → "\x03"), or null when Ctrl doesn't apply to it. */
export function toCtrl(ch: string): string | null {
  if (ch.length !== 1 || !/[a-z@[\\\]^_]/i.test(ch)) return null;
  return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
}

export interface MountOptions {
  /** The terminal's WebSocket URL; a function is called on every (re)connect. */
  url: string | (() => string);
  /** `@xterm/xterm`'s Terminal class. */
  Terminal: new (options?: ITerminalOptions) => XTerminal;
  /** `@xterm/addon-fit`'s FitAddon class. */
  FitAddon: new () => XFitAddon;
  /** `@xterm/addon-webgl`'s WebglAddon class; without it xterm keeps its DOM renderer. */
  WebglAddon?: new () => XWebglAddon;
  /** xterm-zerolag-input's PredictiveEchoAddon class; without it there is no instant echo. */
  PredictiveEchoAddon?: PredictiveEchoAddonClass;
  /** The colors. A function is read again whenever `<html data-theme>` changes (the page's theme switch). */
  theme?: ITheme | (() => ITheme);
  /** Draw typed characters at once, before the server echoes them (echo.ts); a function is read on every key. Default on. */
  instantEcho?: boolean | (() => boolean);
  /** Take the keyboard right after mounting. */
  focus?: boolean;
  /** Extra xterm options, over the defaults. */
  terminalOptions?: ITerminalOptions;
  onConnection?: (state: ConnectionState) => void;
  onExit?: (code: number) => void;
  /** The process was restarted on the server. */
  onRestart?: () => void;
  /** Called on every output frame from the process. */
  onOutput?: () => void;
  /** The round trip to the server, in ms, measured every PING_MS. */
  onLatency?: (ms: number) => void;
  /** Any input was typed or pasted. */
  onInput?: () => void;
  /** Enter was typed. */
  onSubmit?: () => void;
  /** Called for every key event xterm sees; return false to keep it from the terminal. */
  keyFilter?: (e: KeyboardEvent) => boolean;
  /** Sees typed data first; return true to swallow it. */
  onPrefixData?: (data: string) => boolean;
  /** Sticky Ctrl is on: the next single typed character is sent as its control code. */
  ctrlArmed?: () => boolean;
  /** Sticky Ctrl was applied to a typed character. */
  onCtrlUsed?: () => void;
  /** A touch tap on the terminal (it already took focus). */
  onTap?: () => void;
}

export interface TerminalController {
  /** Input as if typed (it goes through the same path as the keyboard). */
  input(data: string): void;
  focus(): void;
  /** Fits the terminal to its host and tells the server the new size. */
  fit(): void;
  setInstantEcho(on: boolean): void;
  /** The cursor-key mode, for arrow keys sent by an extra-keys row. */
  appCursor(): boolean;
  /** Closes the socket and disposes the terminal. */
  destroy(): void;
}

/**
 * Draws the terminal with WebGL instead of xterm's DOM renderer, which re-lays out HTML on every redraw and lags under
 * full-screen TUIs such as Claude Code. Without WebGL (old browsers, tests, a lost GPU context) xterm keeps the DOM renderer.
 */
function loadWebgl(Addon: new () => XWebglAddon, term: XTerminal): { dispose(): void } | undefined {
  let addon: XWebglAddon | undefined;
  try {
    addon = new Addon();
    term.loadAddon(addon);
  } catch {
    return undefined;
  }
  const dispose = () => {
    addon?.dispose();
    addon = undefined;
  };
  // A lost GPU context: drop back to the DOM renderer.
  addon.onContextLoss(dispose);
  return { dispose };
}

/**
 * Mounts an xterm in `host`, attached to the terminal WebSocket at `o.url`. The server replays the scrollback on every
 * attach, so a remount or a reconnect redraws the screen. Reconnects with backoff when the socket drops unexpectedly.
 */
export function mountTerminal(host: HTMLElement, o: MountOptions): TerminalController {
  const themeOf = (): ITheme => (typeof o.theme === "function" ? o.theme() : (o.theme ?? {}));
  let echoEnabled: () => boolean = typeof o.instantEcho === "function" ? o.instantEcho : ((on) => () => on)(o.instantEcho ?? true);
  const term = new o.Terminal({
    // A blinking cursor repaints twice a second for nothing; TUIs draw their own.
    cursorBlink: false,
    fontFamily: "'Geist Mono Variable', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    // The server keeps 256 KB of scrollback anyway; a smaller buffer makes clears and reflows cheaper.
    scrollback: 5000,
    theme: themeOf(),
    // Instant echo measures characters with term.unicode, a proposed API (echo.ts).
    allowProposedApi: true,
    ...o.terminalOptions,
  });
  const fit = new o.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  if (term.textarea) setTextareaAttrs(term.textarea);
  const untouch = attachTouch(host, term, { onTap: () => o.onTap?.() });
  const webgl = o.WebglAddon ? loadWebgl(o.WebglAddon, term) : undefined;
  const theme = themeOf();
  const echo = o.PredictiveEchoAddon
    ? attachPredictiveEcho(o.PredictiveEchoAddon, term, () => echoEnabled(), { foreground: theme.foreground, background: theme.background })
    : undefined;
  term.attachCustomKeyEventHandler((e) => o.keyFilter?.(e) ?? true);
  if (o.focus) term.focus();

  // Follow the page theme.
  const themeObserver =
    typeof o.theme === "function" && typeof MutationObserver === "function" ? new MutationObserver(() => (term.options.theme = themeOf())) : undefined;
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  let ws: WebSocket | null = null;
  let pingAfter = Infinity;
  let disposed = false;
  let attempt = 0;
  let timer: number | undefined;
  const send = (msg: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const doFit = () => {
    if (disposed) return;
    if (host.offsetWidth === 0 || host.offsetHeight === 0) return; // not laid out
    try {
      fit.fit();
    } catch {
      return;
    }
    send({ type: "resize", cols: term.cols, rows: term.rows });
  };

  const connect = () => {
    if (disposed) return;
    const sock = new WebSocket(typeof o.url === "function" ? o.url() : o.url);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      o.onConnection?.("open");
      doFit();
      pingAfter = performance.now() + FIRST_PING_MS;
    };
    sock.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "replay") {
        term.reset();
        term.write(msg.data);
      } else if (msg.type === "pong") {
        o.onLatency?.(Math.max(0, performance.now() - msg.t));
      } else if (msg.type === "data") {
        term.write(msg.data);
        o.onOutput?.();
      } else if (msg.type === "exit") o.onExit?.(msg.code);
      else if (msg.type === "restart") {
        // The server put a line break in the scrollback; mirror it so both agree.
        term.write("\r\n");
        o.onRestart?.();
        doFit();
      }
    };
    sock.onclose = (ev) => {
      if (disposed || ws !== sock) return;
      if (ev.code === 4404) {
        term.write("\r\n\x1b[2m[terminal not found]\x1b[0m\r\n");
        o.onConnection?.("gone");
        return;
      }
      o.onConnection?.("reconnecting");
      timer = window.setTimeout(connect, reconnectDelay(attempt++));
    };
  };
  o.onConnection?.("connecting");
  connect();

  const input = term.onData((typed) => {
    // A phone keyboard's key after a prefix arrives here (Android sends keydown "Unidentified").
    if (o.onPrefixData?.(typed)) return;
    let data = typed;
    if (o.ctrlArmed?.()) {
      const c = toCtrl(typed);
      if (c !== null) {
        data = c;
        o.onCtrlUsed?.();
      }
    }
    // The guess is drawn first; the key goes out unchanged either way.
    echo?.input(data);
    send({ type: "input", data });
    o.onInput?.();
    if (data === "\r") o.onSubmit?.();
  });
  const ping = window.setInterval(() => {
    if (!document.hidden && performance.now() >= pingAfter) send({ type: "ping", t: performance.now() });
  }, PING_MS);
  const observer = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(() => doFit()) : undefined;
  observer?.observe(host);
  // iOS doesn't resize the layout viewport for the keyboard: refit when the visual viewport changes, and keep the
  // prompt in view if the terminal was at the bottom.
  const vv = window.visualViewport;
  let raf = 0;
  const onViewport = () => {
    const b = term.buffer.active;
    const atBottom = b.viewportY >= b.baseY;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      doFit();
      if (atBottom) term.scrollToBottom();
    });
  };
  vv?.addEventListener("resize", onViewport);

  return {
    input: (data) => {
      if (!disposed) term.input(data, true);
    },
    focus: () => {
      if (!disposed) term.focus();
    },
    fit: doFit,
    setInstantEcho: (on) => {
      echoEnabled = () => on;
    },
    appCursor: () => (disposed ? false : term.modes.applicationCursorKeysMode),
    destroy: () => {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(timer);
      window.clearInterval(ping);
      echo?.dispose();
      observer?.disconnect();
      themeObserver?.disconnect();
      input.dispose();
      webgl?.dispose();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      untouch();
      vv?.removeEventListener("resize", onViewport);
      cancelAnimationFrame(raf);
      term.dispose();
    },
  };
}
