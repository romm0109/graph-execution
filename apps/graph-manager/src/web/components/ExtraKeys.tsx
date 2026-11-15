import type { TerminalHandle } from "./TerminalView";

export type SeqKey = "esc" | "tab" | "up" | "down" | "left" | "right";

/** The bytes a key sends; arrows follow the cursor-key mode as xterm's own keys do (vim, less, agent TUIs). */
export function keySequence(key: SeqKey, appCursor: boolean): string {
  if (key === "esc") return "\x1b";
  if (key === "tab") return "\t";
  const letter = { up: "A", down: "B", right: "C", left: "D" }[key];
  return (appCursor ? "\x1bO" : "\x1b[") + letter;
}

export interface ExtraKeysProps {
  handle: TerminalHandle | null;
  ctrl: boolean;
  onCtrl(on: boolean): void;
  onPrefix(): void;
}

type KeyDef = { id: string; label: string; aria: string; seq?: SeqKey };

const KEYS: KeyDef[] = [
  { id: "esc", label: "Esc", aria: "Esc", seq: "esc" },
  { id: "tab", label: "Tab", aria: "Tab", seq: "tab" },
  { id: "ctrl", label: "Ctrl", aria: "Ctrl" },
  { id: "up", label: "↑", aria: "Up", seq: "up" },
  { id: "down", label: "↓", aria: "Down", seq: "down" },
  { id: "left", label: "←", aria: "Left", seq: "left" },
  { id: "right", label: "→", aria: "Right", seq: "right" },
  { id: "prefix", label: "⌃␣", aria: "Ctrl Space" },
];

/** Keeps focus (and the phone keyboard) in xterm's textarea: the buttons never take focus. */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/**
 * The extra-keys row for touch screens: Esc, Tab, a sticky Ctrl, the arrows and the Ctrl Space prefix, which a phone
 * keyboard doesn't have. Keys go to the focused terminal as if typed.
 */
export function ExtraKeys({ handle, ctrl, onCtrl, onPrefix }: ExtraKeysProps) {
  const press = (k: KeyDef) => {
    if (k.id === "ctrl") onCtrl(!ctrl);
    else if (k.id === "prefix") onPrefix();
    else if (k.seq) handle?.input(keySequence(k.seq, handle.appCursor()));
  };
  return (
    <div className="extra-keys" role="toolbar" aria-label="Terminal keys" data-testid="extra-keys">
      {KEYS.map((k) => (
        <button
          key={k.id}
          type="button"
          className={`xk-key${k.id === "ctrl" && ctrl ? " on" : ""}`}
          aria-label={k.aria}
          aria-pressed={k.id === "ctrl" ? ctrl : undefined}
          data-testid={`xk-${k.id}`}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => press(k)}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

export default ExtraKeys;
