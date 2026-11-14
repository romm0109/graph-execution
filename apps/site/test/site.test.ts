import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadShippedSpecs } from "../src/lib/specs";

// `npm test` builds the site first, so dist/ is fresh here.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const specsDir = fileURLToPath(new URL("../../../docs/prd/done/", import.meta.url));
const html = () => readFileSync(join(dist, "index.html"), "utf8");

describe("loadShippedSpecs", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-specs-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("titles specs by their first heading and falls back to the file name", () => {
    writeFileSync(join(dir, "b.md"), "no heading here\n");
    writeFileSync(join(dir, "a.md"), "intro\r\n# PRD: Foo `bar`\r\n\r\n## Problem\n");
    writeFileSync(join(dir, "notes.txt"), "# ignored\n");
    expect(loadShippedSpecs(dir)).toEqual([
      { file: "a.md", title: "Foo bar", url: "https://github.com/romm0109/graph-execution/blob/main/docs/prd/done/a.md" },
      { file: "b.md", title: "b", url: "https://github.com/romm0109/graph-execution/blob/main/docs/prd/done/b.md" },
    ]);
  });
});

describe("built site", () => {
  it("has the hero, the install command, the video and the sections", () => {
    const page = html();
    expect(page).toContain("Turn a spec into a reviewed, tested pull request.");
    expect(page).toContain("npm install -g graph-execution &amp;&amp; graph-execution manager");
    expect(page).toContain('src="/demo.mp4"');
    expect(page).toContain('id="how"');
    expect(page).toContain('id="proof"');
    expect(page).toContain('<link rel="canonical" href="https://graph-execution.com/"');
    expect(page).toContain('property="og:image" content="https://graph-execution.com/demo-poster.jpg"');
  });

  it("lists every shipped spec", () => {
    const count = readdirSync(specsDir).filter((f) => f.endsWith(".md")).length;
    const page = html();
    expect(page).toContain(`${count} specs shipped`);
    expect(page).toContain("https://github.com/romm0109/graph-execution/blob/main/docs/prd/done/multi-repo.md");
  });

  it("shows the GitHub link instead of a form when no waitlist endpoint is set", () => {
    if (process.env.PUBLIC_WAITLIST_ACTION) return;
    const page = html();
    expect(page).not.toContain("<form");
    expect(page).toContain("Watch the repo on GitHub for the launch");
  });

  it("ships the 404 page, robots.txt, favicon and the video files", () => {
    for (const file of ["404.html", "robots.txt", "favicon.svg", "demo.mp4", "demo-poster.jpg"]) {
      expect(existsSync(join(dist, file)), file).toBe(true);
    }
  });
});
