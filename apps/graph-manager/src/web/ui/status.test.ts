import { describe, expect, it } from "vitest";
import { glyphOf, toneOf, type Glyph, type StatusKind, type Tone } from "./status";

const TABLE: [StatusKind, string, number | undefined, Tone, Glyph][] = [
  ["run", "running", undefined, "live", "pulse"],
  ["run", "applied", undefined, "ok", "dot"],
  ["run", "done", undefined, "mute", "ring"],
  ["run", "aborted", undefined, "mute", "bar"],
  ["run", "failed", undefined, "bad", "diamond"],
  ["run", "review", undefined, "rev", "half"],
  ["task", "running", undefined, "live", "pulse"],
  ["task", "validating", undefined, "live", "pulse"],
  ["task", "merging", undefined, "live", "pulse"],
  ["task", "merged", undefined, "ok", "dot"],
  ["task", "failed", undefined, "bad", "diamond"],
  ["task", "pending", undefined, "mute", "dashed"],
  ["term", "working", undefined, "live", "pulse"],
  ["term", "idle", undefined, "warn", "half"],
  ["term", "exited", 0, "mute", "ring"],
  ["term", "exited", 1, "bad", "diamond"],
  ["term", "exited", 137, "bad", "diamond"],
];

describe("status map", () => {
  it.each(TABLE)("%s %s (exit %s) → %s / %s", (kind, value, exitCode, tone, glyph) => {
    expect(toneOf(kind, value, exitCode)).toBe(tone);
    expect(glyphOf(kind, value, exitCode)).toBe(glyph);
  });

  it("maps unknown values to mute / ring", () => {
    expect(toneOf("run", "unknown")).toBe("mute");
    expect(glyphOf("task", "constructor")).toBe("ring");
    expect(toneOf("term", "working", 1)).toBe("live");
  });
});
