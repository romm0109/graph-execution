// The public contract of `graph-execution/graph` and `graph-execution/graph.css` (README › Embedding the graph).
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { GraphData, GraphHandle, GraphOptions, NodeStatus } from "./graph.js";
import * as graph from "./graph.js";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const JS = read("./graph.js");
const DTS = read("./graph.d.ts");
const CSS = read("./graph.css").replace(/\/\*[\s\S]*?\*\//g, "");
const PKG = JSON.parse(read("../../../package.json")) as { exports: Record<string, unknown>; files: string[] };

/** The CSS custom properties graph.css may read, as documented in the README. */
const THEME_VARS = [
  "--bg", "--panel", "--raised", "--text", "--muted", "--faint", "--border", "--border-strong", "--accent", "--ok", "--warn",
  "--bad", "--glow", "--font-ui", "--font-code", "--diff-add-mark", "--diff-del-mark",
];

describe("graph.css", () => {
  it("reads only the documented custom properties, each with a fallback", () => {
    const used = [...CSS.matchAll(/var\((--[\w-]+)\s*(,)?/g)];
    expect(used.length).toBeGreaterThan(0);
    for (const [, name, comma] of used) {
      if (name === "--ge-c") continue; // internal: the card's status colour, set in this file
      expect(THEME_VARS, name).toContain(name);
      expect(comma, `${name} needs a fallback`).toBe(",");
    }
    expect(new Set(used.map((m) => m[1]).filter((n) => n !== "--ge-c"))).toEqual(new Set(THEME_VARS));
  });

  it("never touches :root and only sets --ge-c", () => {
    expect(CSS).not.toMatch(/:root/);
    for (const [, name] of CSS.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)) expect(name).toBe("--ge-c");
  });

  it("prefixes every class and keyframe with ge-", () => {
    // Selectors are the text before each `{` that is not an @-rule.
    const selectors = [...CSS.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((s) => !s.startsWith("@"));
    expect(selectors.length).toBeGreaterThan(20);
    for (const sel of selectors) for (const [, cls] of sel.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) expect(cls, sel).toMatch(/^ge-/);
    for (const [, name] of CSS.matchAll(/@keyframes\s+([\w-]+)/g)) expect(name).toMatch(/^ge-/);
  });

  it("styles every NodeStatus", () => {
    const all: NodeStatus[] = [
      "pending", "queued", "waiting", "running", "validating", "fixing", "merging", "integrating", "merged", "done", "applied",
      "failed", "aborted", "stopped", "human", "skipped", "excluded", "escalated", "dropped", "not_done",
    ];
    for (const s of all) expect(CSS, s).toContain(`.ge-s-${s}`);
  });
});

describe("graph.js", () => {
  it("imports nothing, so it runs in the browser as is", () => {
    expect(JS).not.toMatch(/^\s*import\s/m);
    expect(JS).not.toMatch(/\brequire\(/);
    expect(JS).not.toMatch(/\bimport\(/);
  });

  it("exports exactly what graph.d.ts declares", () => {
    const declared = [...DTS.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]).sort();
    const runtime = Object.keys(graph).sort();
    expect(runtime).toEqual(declared);
  });

  it("has the public types", () => {
    expectTypeOf(graph.mountGraph).parameters.toEqualTypeOf<[HTMLElement, GraphOptions?]>();
    expectTypeOf(graph.mountGraph).returns.toEqualTypeOf<GraphHandle>();
    expectTypeOf<GraphHandle["update"]>().parameters.toEqualTypeOf<[GraphData]>();
    expectTypeOf<GraphOptions["keyboard"]>().toEqualTypeOf<"host" | "document" | false | undefined>();
    expectTypeOf<GraphData["edges"][number]>().toEqualTypeOf<{ from: string; to: string; blocked?: boolean }>();
    expectTypeOf<GraphData["nodes"][number]["changes"]>().toEqualTypeOf<{ added: number; deleted: number; files: number } | undefined>();
    expectTypeOf<"escalated" | "dropped" | "not_done">().toMatchTypeOf<NodeStatus>();
  });
});

describe("package.json", () => {
  it("exports graph-execution/graph and graph-execution/graph.css from the built assets", () => {
    expect(PKG.exports["./graph"]).toEqual({ types: "./dist/web/assets/graph.d.ts", import: "./dist/web/assets/graph.js" });
    expect(PKG.exports["./graph.css"]).toBe("./dist/web/assets/graph.css");
    expect(PKG.files).toContain("dist");
  });
});
