// Instant echo for a remote terminal, on xterm-zerolag-input's PredictiveEchoAddon (MIT): each typed character is
// drawn at once on an overlay above the terminal, while the key still goes to the process as usual. When the process
// echoes it back, the guess is checked against the real cell and removed; the real screen always wins. The agent
// gets every key immediately, so its own `/`, `@`, `$` menus and anything else it reacts to keep working.

import type { ITerminalAddon, Terminal } from "@xterm/xterm";
import { PredictiveEchoAddon } from "xterm-zerolag-input";

/** What one `onData` chunk from xterm means for the predictions. */
export type InputKind = { kind: "chars"; chars: string[] } | { kind: "backspace" } | { kind: "submit" } | { kind: "report" } | { kind: "other" };

/**
 * What the terminal sends by itself, not typing: focus in/out (`ESC[I`, `ESC[O`) and mouse reports (`ESC[<b;x;yM`,
 * `ESC[Mbxy`), when the program asked for them as Claude Code does, and answers to the program's queries (cursor
 * position `ESC[r;cR`, device attributes `ESC[?…c`, colors `ESC]…`). They must not clear the guesses: a clear holds
 * new ones until the next output, so the first keys after a click or a mouse move would get no instant echo. (A click
 * that moves the program's own caret is rare mid-word; a guess it puts in the wrong cell is dropped when checked.)
 */
// eslint-disable-next-line no-control-regex
const REPORT = /^(\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[?>]?[\d;]*[Rcn]|\x1b\][^\x07\x1b]*(\x07|\x1b\\))$/;

/** Longer than this is a paste, not typing (an IME commit is a few characters). */
const MAX_TYPED = 4;

export function classifyInput(data: string): InputKind {
  if (data === "\x7f" || data === "\b") return { kind: "backspace" };
  if (data === "\r") return { kind: "submit" };
  if (REPORT.test(data)) return { kind: "report" };
  const chars = Array.from(data);
  // eslint-disable-next-line no-control-regex
  if (chars.length === 0 || chars.length > MAX_TYPED || /[\x00-\x1f\x7f]/.test(data)) return { kind: "other" };
  return { kind: "chars", chars };
}

/** The text before the cursor asks for a secret: typed characters must not be drawn, even for a moment. */
export function isSecretPrompt(beforeCursor: string): boolean {
  return /(password|passphrase|passcode|\bpin\b|token|secret|otp)[^:\n]*:\s*$/i.test(beforeCursor);
}

/** Writes in a row that dropped guesses and confirmed none, after which echo switches off for a while. */
export const MISS_LIMIT = 3;
export const BACKOFF_MS = 10_000;

/** Counts confirmed and dropped guesses and backs off when the process keeps not echoing what was typed. */
export class EchoBackoff {
  private misses = 0;
  private until = 0;
  private confirmed = 0;
  private dropped = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed the addon's running totals after each parsed write. A write that drops guesses counts once, however many. */
  observe(confirmedTotal: number, droppedTotal: number): void {
    if (confirmedTotal > this.confirmed) this.misses = 0;
    else if (droppedTotal > this.dropped) this.misses += 1;
    this.confirmed = confirmedTotal;
    this.dropped = droppedTotal;
    if (this.misses >= MISS_LIMIT) {
      this.misses = 0;
      this.until = this.now() + BACKOFF_MS;
    }
  }

  /** Takes the totals without counting them: guesses we cleared ourselves (Enter, arrows, a paste) are not misses. */
  sync(confirmedTotal: number, droppedTotal: number): void {
    this.confirmed = confirmedTotal;
    this.dropped = droppedTotal;
  }

  /** A submitted line starts afresh (a new prompt may echo again). */
  reset(): void {
    this.misses = 0;
    this.until = 0;
  }

  get paused(): boolean {
    return this.now() < this.until;
  }
}

/** xterm keeps the cursor's visibility (DECTCEM) private; a hidden cursor means the program draws its own input. */
function cursorHidden(term: Terminal): boolean {
  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core;
  return core?.coreService?.isCursorHidden === true;
}

export interface PredictiveEcho {
  /** Called for every `onData` chunk before it is sent; never changes or holds what is sent. */
  input(data: string): void;
  dispose(): void;
}

/**
 * Loads the addon on `term`. `enabled` is read on every keystroke (the pane's toggle). The terminal must be created with
 * `allowProposedApi: true`: the addon measures characters with `term.unicode`, which throws otherwise, and then it
 * silently predicts nothing.
 */
export function attachPredictiveEcho(term: Terminal, enabled: () => boolean, colors: { foreground?: string; background?: string }): PredictiveEcho | undefined {
  const backoff = new EchoBackoff();
  let addon: PredictiveEchoAddon;
  try {
    addon = new PredictiveEchoAddon({
      foregroundColor: colors.foreground,
      backgroundColor: colors.background,
      predictWhen: () => {
        if (!enabled() || backoff.paused || cursorHidden(term)) return false;
        const buf = term.buffer.active;
        const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(false) ?? "";
        return !isSecretPrompt(line.slice(0, buf.cursorX));
      },
    });
    // Its own minimal terminal type is a subset of xterm's; the shapes match at runtime.
    term.loadAddon(addon as unknown as ITerminalAddon);
  } catch {
    return undefined;
  }
  const watch = term.onWriteParsed(() => {
    const s = addon.state;
    backoff.observe(s.confirmedTotal, s.droppedTotal);
  });
  return {
    input(data) {
      const k = classifyInput(data);
      if (k.kind === "chars") {
        for (const ch of k.chars) addon.predictChar(ch);
      } else if (k.kind === "backspace") {
        addon.predictBackspace();
      } else if (k.kind !== "report") {
        if (k.kind === "submit") backoff.reset();
        // Enter, Esc, arrows, Tab, Ctrl keys, pastes: their effect on the screen can't be guessed.
        addon.clearPredictions();
        const s = addon.state;
        backoff.sync(s.confirmedTotal, s.droppedTotal);
      }
    },
    dispose() {
      watch.dispose();
      addon.dispose();
    },
  };
}
