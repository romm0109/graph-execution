import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { mountTerminal, type ConnectionState, type TerminalController } from "graph-execution/terminal/client";
import { useEffect, useRef, type MutableRefObject } from "react";
import { PredictiveEchoAddon } from "xterm-zerolag-input";

// The terminal itself lives in the engine's shared module (packages/graph-execution/src/terminal/client.ts).
export { FIRST_PING_MS, PING_MS, reconnectDelay, toCtrl, type ConnectionState } from "graph-execution/terminal/client";

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

/** What the extra-keys row drives: input as if typed, focus, and the cursor-key mode for arrows. */
export interface TerminalHandle {
  input(data: string): void;
  focus(): void;
  appCursor(): boolean;
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
  /** Called on every output frame from the process. */
  onOutput?: () => void;
  /** Any input was typed or pasted. */
  onInput?: () => void;
  /** Enter was typed. */
  onSubmit?: () => void;
  /** The round trip to the server, in ms, measured every PING_MS. */
  onLatency?: (ms: number) => void;
  /** Draw typed characters at once, before the server echoes them (the engine's terminal/echo.ts). */
  instantEcho?: boolean;
  /** A touch tap on the terminal (it already took focus). */
  onTap?: () => void;
  /** Filled with a handle that types into this terminal (the extra-keys row). */
  handleRef?: MutableRefObject<TerminalHandle | null>;
  /** Sticky Ctrl is on: the next single typed character is sent as its control code. */
  ctrlArmed?: () => boolean;
  /** Sticky Ctrl was applied to a typed character. */
  onCtrlUsed?: () => void;
  /** Sees typed data first; return true to swallow it (the Ctrl Space prefix from a phone keyboard). */
  onPrefixData?: (data: string) => boolean;
}

/**
 * One terminal: an xterm attached to `/api/terminals/<id>/ws`. The server replays the scrollback on every attach, so
 * a remount or a reconnect redraws the screen. Reconnects with backoff when the socket drops unexpectedly.
 */
export default function TerminalView({ id, active, onExit, onRestart, onConnection, keyFilter, onOutput, onInput, onSubmit, onLatency, onTap, handleRef, ctrlArmed, onCtrlUsed, onPrefixData, instantEcho = true }: TerminalViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<TerminalController | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const cb = useRef({ onExit, onRestart, onConnection, keyFilter, onOutput, onInput, onSubmit, onLatency, onTap, ctrlArmed, onCtrlUsed, onPrefixData });
  cb.current = { onExit, onRestart, onConnection, keyFilter, onOutput, onInput, onSubmit, onLatency, onTap, ctrlArmed, onCtrlUsed, onPrefixData };
  const echoOn = useRef(instantEcho);
  echoOn.current = instantEcho;

  useEffect(() => {
    const host = el.current;
    if (!host) return;
    const ctrl = mountTerminal(host, {
      url: () => terminalSocketUrl(id),
      Terminal,
      FitAddon,
      WebglAddon,
      PredictiveEchoAddon,
      theme: termTheme,
      instantEcho: () => echoOn.current,
      focus: activeRef.current,
      onConnection: (state) => cb.current.onConnection?.(state),
      onExit: (code) => cb.current.onExit?.(code),
      onRestart: () => cb.current.onRestart?.(),
      onOutput: () => cb.current.onOutput?.(),
      onLatency: (ms) => cb.current.onLatency?.(ms),
      onInput: () => cb.current.onInput?.(),
      onSubmit: () => cb.current.onSubmit?.(),
      keyFilter: (e) => cb.current.keyFilter?.(e) ?? true,
      onPrefixData: (data) => cb.current.onPrefixData?.(data) ?? false,
      ctrlArmed: () => cb.current.ctrlArmed?.() ?? false,
      onCtrlUsed: () => cb.current.onCtrlUsed?.(),
      onTap: () => cb.current.onTap?.(),
    });
    ctrlRef.current = ctrl;
    return () => {
      ctrlRef.current = null;
      ctrl.destroy();
    };
  }, [id]);

  // The handle reads ctrlRef lazily, so it survives reconnects and remounts of the xterm.
  useEffect(() => {
    if (!handleRef) return;
    const handle: TerminalHandle = {
      input: (data) => ctrlRef.current?.input(data),
      focus: () => ctrlRef.current?.focus(),
      appCursor: () => ctrlRef.current?.appCursor() ?? false,
    };
    handleRef.current = handle;
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [handleRef, id]);

  useEffect(() => {
    if (!active) return;
    ctrlRef.current?.fit();
    ctrlRef.current?.focus();
  }, [active]);

  return <div ref={el} className="terminal-view" data-testid={`terminal-view-${id}`} />;
}
