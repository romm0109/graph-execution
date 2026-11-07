import type { NodeStatus } from "./store.js";

/** Neon palette of the terminal UI; terminals without true color get the nearest color. */
export const THEME = {
  accent: "#00e5ff",
  accent2: "#ff4fd8",
  text: "#e6edf3",
  muted: "#6b7689",
  faint: "#3b4252",
  ok: "#39ff88",
  warn: "#ffd166",
  bad: "#ff3860",
} as const;

export const STATUS_COLOR: Record<NodeStatus, string> = {
  pending: THEME.muted,
  running: THEME.accent,
  validating: "#b388ff",
  fixing: THEME.warn,
  merging: THEME.accent2,
  merged: THEME.ok,
  done: THEME.ok,
  failed: THEME.bad,
  skipped: THEME.faint,
};

export const ACTIVE: ReadonlySet<NodeStatus> = new Set(["running", "validating", "fixing", "merging"]);

const STATUS_ICON: Record<NodeStatus, string> = {
  pending: "○",
  running: "",
  validating: "",
  fixing: "",
  merging: "",
  merged: "✔",
  done: "✔",
  failed: "✖",
  skipped: "⊘",
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The node's icon: a spinner frame while it works. */
export const statusIcon = (status: NodeStatus, frame: number): string =>
  ACTIVE.has(status) ? SPINNER[frame % SPINNER.length]! : STATUS_ICON[status];

/** Interpolates `from` → `to` (hex colors) at `t` in [0, 1]. */
export function mix(from: string, to: string, t: number): string {
  const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [rgb(from), rgb(to)];
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}
