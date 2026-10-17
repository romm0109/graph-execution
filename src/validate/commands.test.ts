import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, runCommands, truncateOutput } from "./commands.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graph-execution-commands-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const node = (code: string): string => `node -e ${JSON.stringify(code)}`;

describe("runCommands", () => {
  it("runs every command in order in cwd and succeeds", async () => {
    const append = (s: string): string => node(`require("fs").appendFileSync("out.txt", "${s}")`);
    expect(await runCommands([append("a"), append("b")], dir)).toEqual({ ok: true });
    expect(await readFile(path.join(dir, "out.txt"), "utf8")).toBe("ab");
  });

  it("succeeds with no commands", async () => {
    expect(await runCommands([], dir)).toEqual({ ok: true });
  });

  it("stops at the first failure and returns its command and combined output", async () => {
    const fail = node(`console.log("to stdout"); console.error("to stderr"); process.exit(3)`);
    const never = node(`require("fs").writeFileSync("never.txt", "")`);
    const result = await runCommands([fail, never], dir);
    expect(result).toMatchObject({ ok: false, command: fail, exitCode: 3 });
    if (result.ok) throw new Error("unreachable");
    expect(result.output).toContain("to stdout");
    expect(result.output).toContain("to stderr");
    await expect(readFile(path.join(dir, "never.txt"))).rejects.toThrow();
  });

  it("uses a shell", async () => {
    expect(await runCommands(["exit 0 && true"], dir)).toEqual({ ok: true });
    expect(await runCommands(["false || exit 4"], dir)).toMatchObject({ ok: false, exitCode: 4 });
  });

  it("truncates long output to the tail", async () => {
    const result = await runCommands([node(`for (let i = 1; i <= 1000; i++) console.log("line " + i); process.exit(1)`)], dir);
    if (result.ok) throw new Error("expected a failure");
    expect(result.output).toContain("line 1000");
    expect(result.output).not.toContain("line 800\n");
    expect(result.output.split("\n").length).toBeLessThanOrEqual(MAX_OUTPUT_LINES + 1);
  });
});

describe("truncateOutput", () => {
  it("keeps short output as is", () => {
    expect(truncateOutput("a\nb\n")).toBe("a\nb\n");
  });

  it("keeps the last 200 lines", () => {
    const text = Array.from({ length: 300 }, (_, i) => `l${i + 1}`).join("\n");
    const out = truncateOutput(text);
    expect(out.startsWith("[output truncated]\nl101\n")).toBe(true);
    expect(out.endsWith("l300")).toBe(true);
  });

  it("keeps at most 8 KB, starting on a line boundary", () => {
    const text = Array.from({ length: 100 }, (_, i) => `${i}:${"x".repeat(200)}`).join("\n");
    const out = truncateOutput(text);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + "[output truncated]\n".length);
    expect(out.split("\n")[1]).toMatch(/^\d+:x{200}$/);
    expect(out.endsWith(`99:${"x".repeat(200)}`)).toBe(true);
  });
});

describe("runCommands in parallel", () => {
  // Each command waits until the other has started: run one after another, they would time out.
  const meet = (me: string, other: string): string =>
    node(
      `const fs = require("fs"); fs.writeFileSync("${me}", ""); const t = Date.now();` +
        `while (!fs.existsSync("${other}")) { if (Date.now() - t > 3000) process.exit(9); }`,
    );

  it("runs the commands at the same time", async () => {
    expect(await runCommands([meet("a", "b"), meet("b", "a")], dir, undefined, { parallel: true })).toEqual({ ok: true });
  });

  it("lets every command finish and reports all failures together", async () => {
    const fail = (msg: string, code: number): string => node(`console.error(${JSON.stringify(msg)}); process.exit(${code})`);
    const done = node(`require("fs").writeFileSync("done.txt", "")`);
    const result = await runCommands([fail("type error", 2), done, fail("lint error", 1)], dir, undefined, { parallel: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.command).toBe(`${fail("type error", 2)}, ${fail("lint error", 1)}`);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(`$ ${fail("type error", 2)}  (exit code 2)\ntype error`);
    expect(result.output).toContain(`$ ${fail("lint error", 1)}  (exit code 1)\nlint error`);
    expect(await readFile(path.join(dir, "done.txt"), "utf8")).toBe("");
  });

  it("reports a single failure exactly like the sequential mode", async () => {
    const fail = node(`console.log("boom"); process.exit(4)`);
    const result = await runCommands([node("0"), fail], dir, undefined, { parallel: true });
    expect(result).toEqual({ ok: false, command: fail, exitCode: 4, output: "boom" });
  });
});
