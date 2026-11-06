import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

type ServerMessage = { type: "replay"; data: string } | { type: "data"; data: string } | { type: "exit"; code: number };

export function terminalSocketUrl(id: string): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminals/${encodeURIComponent(id)}/ws`;
}

/** One terminal: an xterm attached to `/api/terminals/<id>/ws`. Stays mounted while hidden so its state survives tab switches. */
export default function TerminalView({ id, active }: { id: string; active: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const host = el.current;
    if (!host) return;
    const term = new Terminal({ cursorBlink: true, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13, scrollback: 10000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    // A new or shown terminal takes the keyboard, so typing never goes to the button that opened it.
    if (activeRef.current) term.focus();
    const ws = new WebSocket(terminalSocketUrl(id));
    const send = (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const doFit = () => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return; // hidden tab
      try {
        fit.fit();
      } catch {
        return;
      }
      send({ type: "resize", cols: term.cols, rows: term.rows });
    };
    fitRef.current = doFit;
    ws.onopen = () => doFit();
    ws.onmessage = (ev) => {
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
      else if (msg.type === "exit") term.write(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
    };
    ws.onclose = (ev) => {
      if (ev.code === 4404) term.write("\r\n\x1b[2m[terminal not found]\x1b[0m\r\n");
    };
    const input = term.onData((data) => send({ type: "input", data }));
    const observer = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(() => doFit()) : undefined;
    observer?.observe(host);
    return () => {
      fitRef.current = null;
      termRef.current = null;
      observer?.disconnect();
      input.dispose();
      ws.onclose = null;
      ws.close();
      term.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    fitRef.current?.();
    termRef.current?.focus();
  }, [active]);

  return <div ref={el} className={active ? "terminal-view" : "terminal-view hidden"} data-testid={`terminal-view-${id}`} />;
}
