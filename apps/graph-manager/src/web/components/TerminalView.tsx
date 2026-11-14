import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

type ServerMessage =
  | { type: "replay"; data: string }
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "restart" };

/** `open`: attached; `reconnecting`: the socket dropped and a retry is scheduled; `gone`: the server doesn't know the terminal (4404). */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "gone";

/** Reconnect delays in ms: 0.5 s, 1 s, 2 s, then 4 s and 5 s at most. */
export function reconnectDelay(attempt: number): number {
  return Math.min(5000, 500 * 2 ** Math.max(0, attempt));
}

export function terminalSocketUrl(id: string): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminals/${encodeURIComponent(id)}/ws`;
}

/** The xterm colors from the `--term` / `--termfg` tokens (dark in both themes). */
function termTheme(): { background?: string; foreground?: string; cursor?: string } {
  const css = getComputedStyle(document.documentElement);
  const background = css.getPropertyValue("--term").trim();
  const foreground = css.getPropertyValue("--termfg").trim();
  // Without the stylesheet (tests), leave xterm's own dark defaults.
  return { ...(background ? { background } : {}), ...(foreground ? { foreground, cursor: foreground } : {}) };
}

/**
 * Draws the terminal with WebGL instead of xterm's DOM renderer, which re-lays out HTML on every redraw and lags under
 * full-screen TUIs such as Claude Code. Without WebGL (old browsers, tests, a lost GPU context) xterm keeps the DOM renderer.
 */
function loadWebgl(term: Terminal): { dispose(): void } | undefined {
  let addon: WebglAddon | undefined;
  try {
    addon = new WebglAddon();
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

export interface TerminalViewProps {
  id: string;
  /** The pane is focused: the terminal takes the keyboard. */
  active: boolean;
  onExit?: (code: number) => void;
  /** The process was restarted on the server. */
  onRestart?: () => void;
  onConnection?: (state: ConnectionState) => void;
  /** Called for every key event xterm sees; return false to keep it from the terminal (the Ctrl Space prefix). */
  keyFilter?: (e: KeyboardEvent) => boolean;
}

/**
 * One terminal: an xterm attached to `/api/terminals/<id>/ws`. The server replays the scrollback on every attach, so
 * a remount or a reconnect redraws the screen. Reconnects with backoff when the socket drops unexpectedly.
 */
export default function TerminalView({ id, active, onExit, onRestart, onConnection, keyFilter }: TerminalViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const cb = useRef({ onExit, onRestart, onConnection, keyFilter });
  cb.current = { onExit, onRestart, onConnection, keyFilter };

  useEffect(() => {
    const host = el.current;
    if (!host) return;
    const term = new Terminal({
      // A blinking cursor repaints twice a second for nothing; TUIs draw their own.
      cursorBlink: false,
      fontFamily: "'Geist Mono Variable', 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      // The server keeps 256 KB of scrollback anyway; a smaller buffer makes clears and reflows cheaper.
      scrollback: 5000,
      theme: termTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const webgl = loadWebgl(term);
    term.attachCustomKeyEventHandler((e) => cb.current.keyFilter?.(e) ?? true);
    termRef.current = term;
    if (activeRef.current) term.focus();

    // Follow the app theme (the tokens differ slightly between light and dark).
    const themeObserver = typeof MutationObserver === "function" ? new MutationObserver(() => (term.options.theme = termTheme())) : undefined;
    themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let timer: number | undefined;
    const send = (msg: unknown) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const doFit = () => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return; // not laid out
      try {
        fit.fit();
      } catch {
        return;
      }
      send({ type: "resize", cols: term.cols, rows: term.rows });
    };
    fitRef.current = doFit;

    const connect = () => {
      if (disposed) return;
      const sock = new WebSocket(terminalSocketUrl(id));
      ws = sock;
      sock.onopen = () => {
        attempt = 0;
        cb.current.onConnection?.("open");
        doFit();
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
        } else if (msg.type === "data") term.write(msg.data);
        else if (msg.type === "exit") cb.current.onExit?.(msg.code);
        else if (msg.type === "restart") {
          // The server put a line break in the scrollback; mirror it so both agree.
          term.write("\r\n");
          cb.current.onRestart?.();
          doFit();
        }
      };
      sock.onclose = (ev) => {
        if (disposed || ws !== sock) return;
        if (ev.code === 4404) {
          term.write("\r\n\x1b[2m[terminal not found]\x1b[0m\r\n");
          cb.current.onConnection?.("gone");
          return;
        }
        cb.current.onConnection?.("reconnecting");
        timer = window.setTimeout(connect, reconnectDelay(attempt++));
      };
    };
    cb.current.onConnection?.("connecting");
    connect();

    const input = term.onData((data) => send({ type: "input", data }));
    const observer = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(() => doFit()) : undefined;
    observer?.observe(host);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      fitRef.current = null;
      termRef.current = null;
      observer?.disconnect();
      themeObserver?.disconnect();
      input.dispose();
      webgl?.dispose();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      term.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    fitRef.current?.();
    termRef.current?.focus();
  }, [active]);

  return <div ref={el} className="terminal-view" data-testid={`terminal-view-${id}`} />;
}
