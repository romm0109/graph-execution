/** How long terminal output is collected before it goes out as one WebSocket frame. */
export const OUTPUT_BATCH_MS = 6;

export interface OutputBatcher {
  /** Takes a chunk of PTY output. */
  push(chunk: string): void;
  /** Sends whatever is pending now (before an `exit` or `restart` message, so the order holds). */
  flush(): void;
  /** Drops the pending timer; pending output is lost (the socket is gone). */
  dispose(): void;
}

/**
 * Merges PTY output into fewer, larger frames. A full-screen TUI (Claude Code, Codex) redraws in dozens of small
 * chunks per keystroke; one frame per chunk floods the socket and the browser's xterm. A chunk that arrives when nothing
 * was sent for `ms` goes out at once, so the echo of a single typed key is not delayed; chunks that follow within `ms`
 * are joined and sent together when the window ends.
 */
export function batchOutput(send: (data: string) => void, ms = OUTPUT_BATCH_MS, now: () => number = Date.now): OutputBatcher {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSent = -Infinity;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    const data = pending;
    pending = "";
    lastSent = now();
    send(data);
  };
  return {
    push(chunk) {
      if (!chunk) return;
      if (timer === undefined && now() - lastSent >= ms) {
        lastSent = now();
        send(chunk);
        return;
      }
      pending += chunk;
      timer ??= setTimeout(flush, ms);
    },
    flush,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = "";
    },
  };
}
