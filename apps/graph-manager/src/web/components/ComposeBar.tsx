// Type locally, send on Enter: a textarea under the terminal, so typing never waits on the round trip to the server.
// The message goes to the process as one paste followed by Enter. The keys a TUI needs while you are not typing a
// message (Esc, Ctrl C, arrows, Tab, Shift Tab, Enter) pass through to the terminal.

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { AgentId } from "../types";
import { Mascot } from "./Mascot";
import "./ComposeBar.css";

const MAX_HEIGHT = 168;

/** The escape sequence a key sends to the terminal when the box is empty, or undefined to keep it in the box. */
export function passthroughKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, empty: boolean): string | undefined {
  if (e.metaKey || e.altKey) return undefined;
  // Interrupts work while a message is drafted; the draft stays.
  if (e.key === "Escape" && !e.ctrlKey) return "\x1b";
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "c") return "\x03";
  if (!empty || e.ctrlKey) return undefined;
  if (e.key === "Enter" && !e.shiftKey) return "\r";
  if (e.key === "Tab") return e.shiftKey ? "\x1b[Z" : "\t";
  if (e.shiftKey) return undefined;
  const arrows: Record<string, string> = { ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D" };
  return arrows[e.key];
}

export interface ComposeBarProps {
  agent?: AgentId;
  /** Who the message goes to, e.g. `Claude Code` or `bash`. */
  label: string;
  busy: boolean;
  /** Not connected: the box still takes text (and focus), but Enter keeps the message until it is. */
  disabled?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onSend(text: string): void;
  /** Raw input for a passed-through key. */
  onKey(data: string): void;
}

export function ComposeBar({ agent, label, busy, disabled, inputRef, onSend, onKey }: ComposeBarProps) {
  const [text, setText] = useState("");
  const [fed, setFed] = useState(0);
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? own;

  // Grow with the text, up to MAX_HEIGHT; then it scrolls.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight)}px`;
  }, [text, ref]);

  const send = () => {
    if (!text.trim() || disabled) return;
    onSend(text);
    setText("");
    setFed((n) => n + 1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const selecting = el.selectionStart !== el.selectionEnd;
    if (e.ctrlKey && e.key.toLowerCase() === "c" && selecting) return; // copy
    const data = passthroughKey(e, text.length === 0);
    if (data !== undefined) {
      e.preventDefault();
      onKey(data);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className={`compose${disabled ? " disabled" : ""}`} data-testid="compose-bar">
      <textarea
        ref={ref}
        className="compose-input"
        rows={1}
        value={text}
        aria-disabled={disabled || undefined}
        spellCheck={false}
        placeholder={`Message ${label}…`}
        aria-label={`Message ${label}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        data-testid="compose-input"
      />
      <span className="compose-hint mono" aria-hidden="true">
        {text ? "⏎ send · ⇧⏎ new line" : "empty: ⏎ ↑↓ ⇥ esc go to the terminal"}
      </span>
      <Mascot agent={agent} label={label} busy={busy} fed={fed} />
    </div>
  );
}
