import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the favicon source and its link; auth.test.ts pins that the server serves it without login.
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const svg = readFileSync(new URL("../web/public/favicon.svg", import.meta.url), "utf8");

describe("favicon", () => {
  it("is linked from index.html", () => {
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
  });

  it("is the logo mark with fixed light and dark colors", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 22 22"');
    expect(svg).toContain('<rect class="bg" x="1" y="1" width="20" height="20" rx="5" />');
    expect(svg).toContain('d="M7 9.5 10 13.3M15 9.5 12 13.3"');
    for (const part of ["#16171a", "#ffffff", "prefers-color-scheme: dark", "#ecedef", "#16181b"]) expect(svg).toContain(part);
    // A CSS variable does not resolve in a favicon.
    expect(svg).not.toContain("var(");
  });
});
