/** The six status tones of the design system; each has a color pair in tokens.css and its own glyph shape. */
export type Tone = "live" | "ok" | "warn" | "bad" | "mute" | "rev";
/** Glyph shapes, so a status still reads without color. */
export type Glyph = "pulse" | "dot" | "ring" | "dashed" | "diamond" | "bar" | "half";
export type StatusKind = "run" | "task";

type Entry = readonly [Tone, Glyph];

const RUN: Record<string, Entry> = {
  running: ["live", "pulse"],
  applied: ["ok", "dot"],
  done: ["mute", "ring"],
  aborted: ["mute", "bar"],
  interrupted: ["mute", "bar"],
  failed: ["bad", "diamond"],
  review: ["rev", "half"],
  planning: ["live", "pulse"],
  "needs-info": ["warn", "dashed"],
  "awaiting-approval": ["rev", "half"],
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

const UNKNOWN: Entry = ["mute", "ring"];

function entryOf(kind: StatusKind, value: string): Entry {
  const map = kind === "run" ? RUN : TASK;
  return Object.hasOwn(map, value) ? (map[value] ?? UNKNOWN) : UNKNOWN;
}

/** The tone of a run or task status. Unknown values are `mute`. */
export function toneOf(kind: StatusKind, value: string): Tone {
  return entryOf(kind, value)[0];
}

/** The glyph of a run or task status. Unknown values are a `ring`. */
export function glyphOf(kind: StatusKind, value: string): Glyph {
  return entryOf(kind, value)[1];
}
