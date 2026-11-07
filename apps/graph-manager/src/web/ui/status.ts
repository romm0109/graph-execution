/** The six status tones of the design system; each has a color pair in tokens.css and its own glyph shape. */
export type Tone = "live" | "ok" | "warn" | "bad" | "mute" | "rev";
/** Glyph shapes, so a status still reads without color. */
export type Glyph = "pulse" | "dot" | "ring" | "dashed" | "diamond" | "bar" | "half";
export type StatusKind = "run" | "task" | "term";

type Entry = readonly [Tone, Glyph];

const RUN: Record<string, Entry> = {
  running: ["live", "pulse"],
  applied: ["ok", "dot"],
  done: ["mute", "ring"],
  aborted: ["mute", "bar"],
  failed: ["bad", "diamond"],
  review: ["rev", "half"],
};

const TASK: Record<string, Entry> = {
  running: ["live", "pulse"],
  validating: ["live", "pulse"],
  merging: ["live", "pulse"],
  merged: ["ok", "dot"],
  failed: ["bad", "diamond"],
  interrupted: ["mute", "bar"],
  pending: ["mute", "dashed"],
};

const TERM: Record<string, Entry> = {
  working: ["live", "pulse"],
  idle: ["warn", "half"],
};

const UNKNOWN: Entry = ["mute", "ring"];

function entryOf(kind: StatusKind, value: string, exitCode?: number): Entry {
  if (kind === "term" && value === "exited") return exitCode === undefined || exitCode === 0 ? ["mute", "ring"] : ["bad", "diamond"];
  const map = kind === "run" ? RUN : kind === "task" ? TASK : TERM;
  return Object.hasOwn(map, value) ? (map[value] ?? UNKNOWN) : UNKNOWN;
}

/** The tone of a run, task or terminal status. Unknown values are `mute`. */
export function toneOf(kind: StatusKind, value: string, exitCode?: number): Tone {
  return entryOf(kind, value, exitCode)[0];
}

/** The glyph of a run, task or terminal status. Unknown values are a `ring`. */
export function glyphOf(kind: StatusKind, value: string, exitCode?: number): Glyph {
  return entryOf(kind, value, exitCode)[1];
}
