import { describe, expect, it } from "vitest";
import { splitArgs } from "./args.js";

const split = (input: string | undefined): string[] => splitArgs(input, "X_ARGS");

describe("splitArgs", () => {
  it("keeps quoted and escaped words together (GE-11)", () => {
    expect(split('"two words"')).toEqual(["two words"]);
    expect(split("'two words'")).toEqual(["two words"]);
    expect(split("a\\ b")).toEqual(["a b"]);
  });

  it("splits unquoted input on runs of whitespace", () => {
    expect(split(" --max-turns  5 ")).toEqual(["--max-turns", "5"]);
  });

  it("treats tabs and newlines as separators", () => {
    expect(split("a\tb\nc \t\n d")).toEqual(["a", "b", "c", "d"]);
  });

  it("returns no words for an unset, empty or whitespace-only value", () => {
    expect(split(undefined)).toEqual([]);
    expect(split("")).toEqual([]);
    expect(split("   ")).toEqual([]);
  });

  it("joins adjacent quoted and unquoted pieces into one word", () => {
    expect(split('--x="a b"c')).toEqual(["--x=a bc"]);
    expect(split("'it''s'")).toEqual(["its"]);
  });

  it("turns empty quotes into an explicit empty argument", () => {
    expect(split('""')).toEqual([""]);
    expect(split("''")).toEqual([""]);
    expect(split('a "" b')).toEqual(["a", "", "b"]);
  });

  it("allows escaping of \", \\, $ and ` inside double quotes and keeps other backslashes", () => {
    expect(split('"say \\"hi\\""')).toEqual(['say "hi"']);
    expect(split('"\\\\ \\$ \\`"')).toEqual(["\\ $ `"]);
    expect(split('"a\\b"')).toEqual(["a\\b"]);
  });

  it("keeps backslashes literal inside single quotes", () => {
    expect(split("'a\\b'")).toEqual(["a\\b"]);
  });

  it("never expands variables, globs or ~", () => {
    expect(split("$HOME * ~")).toEqual(["$HOME", "*", "~"]);
  });

  it("throws a message naming the env var on malformed input", () => {
    expect(() => split('"x')).toThrow("X_ARGS: unterminated double quote");
    expect(() => split("'x")).toThrow("X_ARGS: unterminated single quote");
    expect(() => split("a\\")).toThrow("X_ARGS: trailing backslash");
  });
});
