// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { toCtrl } from "./TerminalView";

describe("toCtrl", () => {
  it.each([
    ["a", "\x01"],
    ["A", "\x01"],
    ["c", "\x03"],
    ["z", "\x1a"],
    ["[", "\x1b"],
    ["@", "\x00"],
    ["_", "\x1f"],
  ])("%j becomes its control code", (ch, code) => expect(toCtrl(ch)).toBe(code));

  it.each(["1", "ab", "\x1b[A", ""])("%j is left alone", (ch) => expect(toCtrl(ch)).toBeNull());
});
