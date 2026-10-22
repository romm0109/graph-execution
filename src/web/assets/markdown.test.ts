import { describe, expect, it } from "vitest";
import { parseSuggestion, renderMarkdown, suggestionDiff } from "./markdown.js";
import { insertAt } from "./comments.js";

describe("renderMarkdown", () => {
  it("renders paragraphs and line breaks", () => expect(renderMarkdown("a\nb\n\nc")).toBe("<p>a<br>b</p><p>c</p>"));
  it("renders lists", () => {
    expect(renderMarkdown("- a\n* b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });
  it("renders inline code, bold, italic", () => {
    expect(renderMarkdown("`x` **b** _i_ *j*")).toBe("<p><code>x</code> <strong>b</strong> <em>i</em> <em>j</em></p>");
  });
  it("does not format inside code spans", () => expect(renderMarkdown("`**a**`")).toBe("<p><code>**a**</code></p>"));
  it("renders http links only", () => {
    expect(renderMarkdown("[x](https://a.b/c?d=1&e=2)")).toBe('<p><a href="https://a.b/c?d=1&amp;e=2" target="_blank" rel="noopener noreferrer">x</a></p>');
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
  });
  it("renders fences with and without a language", () => {
    expect(renderMarkdown("```\n<a>\n```")).toBe("<pre><code>&lt;a&gt;</code></pre>");
    expect(renderMarkdown("```ts\nlet a;\n```")).toBe("<pre><code>let a;</code></pre>");
  });
  it("renders a suggestion as a mini diff", () => {
    const h = renderMarkdown("```suggestion\nnew1\nnew2\n```", { snippet: "old" });
    expect(h).toContain("Suggested change");
    expect(h).toContain('<div class="sd"><span class="mk">-</span>old</div>');
    expect(h).toContain('<div class="sa"><span class="mk">+</span>new1</div><div class="sa"><span class="mk">+</span>new2</div>');
  });
  it("renders an unclosed fence as escaped text", () => {
    const h = renderMarkdown("```\n<b>x</b>");
    expect(h).not.toContain("<pre");
    expect(h).toContain("&lt;b&gt;");
  });
  it.each([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "[x](javascript:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    '"><svg onload=alert(1)>',
    "`<script>alert(1)</script>`",
    "```\n<script>alert(1)</script>\n```",
    "[x](https://a.b/\"onmouseover=alert(1))",
  ])("keeps %s inert", (payload) => {
    const h = renderMarkdown(payload);
    expect(h).not.toMatch(/<script|<img|<svg|<[^>]*\son\w+=|href="javascript/i);
    expect(h).not.toMatch(/<a [^>]*"onmouseover/);
  });
});

describe("parseSuggestion / suggestionDiff", () => {
  it("parses the replacement text", () => {
    expect(parseSuggestion("x\n```suggestion\na\nb\n```\n")).toBe("a\nb");
    expect(parseSuggestion("```suggestion\n```")).toBe("");
    expect(parseSuggestion("no")).toBeUndefined();
  });
  it("drops old-side snippet lines and strips +", () => {
    expect(suggestionDiff("-gone\n+kept\nctx", "n")).toEqual({ del: ["kept", "ctx"], add: ["n"] });
    expect(suggestionDiff(undefined, "")).toEqual({ del: [], add: [] });
  });
});

describe("insertAt", () => {
  it("wraps a selection", () => expect(insertAt("a bc d", 2, 4, "**", "**")).toEqual({ value: "a **bc** d", cursor: 8 }));
  it("inserts at the cursor between the markers", () => expect(insertAt("ab", 1, 1, "`", "`")).toEqual({ value: "a``b", cursor: 2 }));
  it("inserts a prefix only", () => expect(insertAt("ab", 1, 1, "  ", "")).toEqual({ value: "a  b", cursor: 3 }));
});
