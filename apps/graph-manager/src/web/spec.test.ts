import { describe, expect, it } from "vitest";
import { mermaidSources, renderSpecHtml, safeHref } from "./spec";

describe("renderSpecHtml", () => {
  it("renders headings, lists and GFM tables", () => {
    const html = renderSpecHtml("# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain("<h1");
    expect(html).toContain("Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it("escapes raw HTML, block and inline", () => {
    const block = renderSpecHtml("<script>alert(1)</script>\n");
    expect(block).toContain("&lt;script&gt;");
    expect(block).not.toContain("<script");
    const inline = renderSpecHtml("text <img src=x onerror=alert(1)> more\n");
    expect(inline).toContain("&lt;img");
    expect(inline).not.toContain("<img");
  });

  it("drops unsafe hrefs and keeps safe ones", () => {
    const bad = renderSpecHtml("[x](javascript:alert(1))");
    expect(bad).not.toContain("href");
    expect(bad).toContain("x");
    const ext = renderSpecHtml("[x](https://a.b)");
    expect(ext).toContain('href="https://a.b"');
    expect(ext).toContain('target="_blank"');
    expect(ext).toContain('rel="noopener noreferrer"');
    expect(renderSpecHtml("[x](#goal)")).toContain('href="#goal"');
    expect(renderSpecHtml("[x](#goal)")).not.toContain("target=");
    expect(renderSpecHtml("[x](../a.md)")).toContain('href="../a.md"');
  });

  it("renders images only for safe sources", () => {
    expect(renderSpecHtml("![alt](https://a.b/i.png)")).toContain('loading="lazy"');
    const bad = renderSpecHtml("![alt](javascript:alert(1))");
    expect(bad).not.toContain("<img");
    expect(bad).toContain("alt");
  });

  it("turns mermaid blocks into indexed placeholders with escaped source", () => {
    const text = "```mermaid\ngraph TD\nA-->B\n```\n\ntext\n\n```mermaid\ngraph LR\nC-->D\n```\n";
    const html = renderSpecHtml(text);
    expect(html).toContain('class="spec-mermaid"');
    expect(html).toContain('data-mermaid="0"');
    expect(html).toContain('data-mermaid="1"');
    expect(html).toContain("A--&gt;B");
    expect(mermaidSources(text)).toEqual(["graph TD\nA-->B", "graph LR\nC-->D"]);
    // Index restarts per render.
    expect(renderSpecHtml(text)).toContain('data-mermaid="0"');
  });

  it("renders other code blocks escaped with their language class", () => {
    const html = renderSpecHtml("```ts\nconst a = 1 < 2;\n```\n");
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain("1 &lt; 2");
  });
});

describe("safeHref", () => {
  it("classifies schemes", () => {
    expect(safeHref("HTTPS://x")).toBe("HTTPS://x");
    expect(safeHref("http://x")).toBe("http://x");
    expect(safeHref("a/b:c")).toBe("a/b:c");
    expect(safeHref("a?x=1:2")).toBe("a?x=1:2");
    for (const h of ["javascript:alert(1)", "JavaScript:x", "data:text/html,x", "vbscript:x", "file:///etc"]) {
      expect(safeHref(h)).toBeUndefined();
    }
  });
});
