import { describe, expect, it } from "vitest";
import { glyphOf, toneOf, type Glyph, type StatusKind, type Tone } from "./status";

const TABLE: [StatusKind, string, Tone, Glyph][] = [
  ["run", "running", "live", "pulse"],
  ["run", "applied", "ok", "dot"],
  ["run", "done", "mute", "ring"],
  ["run", "aborted", "mute", "bar"],
  ["run", "failed", "bad", "diamond"],
  ["run", "review", "rev", "half"],
  ["task", "running", "live", "pulse"],
  ["task", "validating", "live", "pulse"],
  ["task", "merging", "live", "pulse"],
  ["task", "merged", "ok", "dot"],
  ["task", "failed", "bad", "diamond"],
  ["task", "pending", "mute", "dashed"],
];

describe("status map", () => {
  it.each(TABLE)("%s %s → %s / %s", (kind, value, tone, glyph) => {
    expect(toneOf(kind, value)).toBe(tone);
    expect(glyphOf(kind, value)).toBe(glyph);
  });

  it("maps unknown values to mute / ring", () => {
    expect(toneOf("run", "unknown")).toBe("mute");
    expect(glyphOf("task", "constructor")).toBe("ring");
  });
});
