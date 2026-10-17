import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCommand, ReadmeError, showReadme } from "./readme.js";

let dir: string;
let html: string;
let markdown: string;
let out: string[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "readme-"));
  html = path.join(dir, "README.html");
  markdown = path.join(dir, "README.md");
  await writeFile(html, "<h1>graph-execution</h1>");
  await writeFile(markdown, "# graph-execution\n");
  out = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = () => ({ html, markdown, out: (text: string) => out.push(text) });

describe("showReadme", () => {
  it("opens the rendered README in the browser", async () => {
    const opened: string[] = [];
    await showReadme({ ...base(), open: async (file) => (opened.push(file), true) });
    expect(opened).toEqual([html]);
    expect(out.join("")).toContain(`Opened the README in your browser: ${pathToFileURL(html).href}`);
  });

  it("prints where the file is when no browser opens", async () => {
    await showReadme({ ...base(), open: async () => false });
    expect(out.join("")).toContain(`Could not open a browser. Open this file to read the README: ${pathToFileURL(html).href}`);
    expect(out.join("")).toContain("graph-execution readme --print");
  });

  it("prints the markdown with --print, without opening anything", async () => {
    let opened = false;
    await showReadme({ ...base(), print: true, open: async () => (opened = true) });
    expect(opened).toBe(false);
    expect(out.join("")).toBe("# graph-execution\n");
  });

  it("says how to get the rendered README when it is missing", async () => {
    await rm(html);
    await expect(showReadme({ ...base(), open: async () => true })).rejects.toThrow(ReadmeError);
    await expect(showReadme({ ...base(), open: async () => true })).rejects.toThrow("npm run build");
  });
});

describe("openCommand", () => {
  it("uses the platform's opener", () => {
    expect(openCommand("/r/README.html", "darwin")).toEqual(["open", ["/r/README.html"]]);
    expect(openCommand("/r/README.html", "linux")).toEqual(["xdg-open", ["/r/README.html"]]);
    expect(openCommand("C:\\r\\README.html", "win32")).toEqual(["cmd", ["/c", "start", "", "C:\\r\\README.html"]]);
  });
});
