import { describe, expect, it } from "vitest";
import { quoteCmd, quoteFor, quotePosix } from "./quote.js";

describe("quotePosix", () => {
  it.each([
    ["C:\\Users\\A B\\repo", "'C:\\Users\\A B\\repo'"],
    ["/tmp/it's here", "'/tmp/it'\\''s here'"],
    ["a&b", "'a&b'"],
    ["100%", "'100%'"],
    ["wow!", "'wow!'"],
    ["ünï", "'ünï'"],
    ["", "''"],
  ])("quotes %j", (input, expected) => {
    expect(quotePosix(input)).toBe(expected);
  });
});

describe("quoteCmd", () => {
  it.each([
    ["C:\\Users\\A B\\repo", '"C:\\Users\\A B\\repo"'],
    ["C:\\a b\\", '"C:\\a b\\\\"'],
    ["/tmp/it's here", `"/tmp/it's here"`],
    ["a&b", '"a&b"'],
    ["100%", '"100%%"'],
    ["wow!", '"wow!"'],
    ["ünï", '"ünï"'],
    ["", '""'],
  ])("quotes %j", (input, expected) => {
    expect(quoteCmd(input)).toBe(expected);
  });

  it("throws on a double quote or line break", () => {
    expect(() => quoteCmd('a"b')).toThrow();
    expect(() => quoteCmd("a\nb")).toThrow();
    expect(() => quoteCmd("a\rb")).toThrow();
  });
});

describe("quoteFor", () => {
  it("picks the quoting by platform", () => {
    expect(quoteFor("win32", "a b")).toBe('"a b"');
    expect(quoteFor("linux", "a b")).toBe("'a b'");
    expect(quoteFor("darwin", "a b")).toBe("'a b'");
  });
});
