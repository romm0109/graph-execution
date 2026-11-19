// Instant echo moved to the engine's shared terminal module (packages/graph-execution/src/terminal/echo.ts). This
// wrapper keeps the old signature: the addon class comes from xterm-zerolag-input through Vite.

import type { Terminal } from "@xterm/xterm";
import { attachPredictiveEcho as attach, type PredictiveEcho } from "graph-execution/terminal/client";
import { PredictiveEchoAddon } from "xterm-zerolag-input";

export { BACKOFF_MS, classifyInput, EchoBackoff, isSecretPrompt, MISS_LIMIT, type InputKind, type PredictiveEcho } from "graph-execution/terminal/client";

/** Loads the instant-echo addon on `term` (see the engine's echo.ts). */
export function attachPredictiveEcho(term: Terminal, enabled: () => boolean, colors: { foreground?: string; background?: string }): PredictiveEcho | undefined {
  return attach(PredictiveEchoAddon, term, enabled, colors);
}
