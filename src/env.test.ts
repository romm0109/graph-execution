import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

// Runs the built files; vitest.global-setup.ts builds dist/ before the suite.
const root = fileURLToPath(new URL("..", import.meta.url));

/** Runs `code` as an ES module in a fresh node process with NODE_ENV set to `nodeEnv` (unset when undefined). */
async function run(code: string, nodeEnv?: string): Promise<string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.NODE_ENV;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  const res = await execa("node", ["--input-type=module", "-e", code], { cwd: root, env, extendEnv: false });
  return res.stdout.trim();
}

describe("NODE_ENV default", () => {
  it("is production when unset, and an explicit value is kept", async () => {
    const print = `import "./dist/env.js"; console.log(process.env.NODE_ENV);`;
    expect(await run(print)).toBe("production");
    expect(await run(print, "development")).toBe("development");
  });

  const renderForASecond = (withEnv: boolean): string => `
    ${withEnv ? 'import "./dist/env.js";' : ""}
    import { Writable, Readable } from "node:stream";
    const { startUi } = await import("./dist/ui/start.js");
    const { RunEmitter } = await import("./dist/runner/events.js");
    const stdout = Object.assign(new Writable({ write(_c, _e, cb) { cb(); } }), { isTTY: true, columns: 120, rows: 40 });
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    startUi({ events: new RunEmitter(), layers: [["1"], ["2"]], attempts: 3, runId: "r", provider: "fake", stdout, stdin });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Not console.log: Ink patches the console and would print into the fake stdout.
    process.stdout.write(String(performance.getEntries().length));
    process.exit(0);
  `;

  it("keeps the live view from piling up performance entries (React's dev build leaked one per render)", async () => {
    expect(await run(renderForASecond(true))).toBe("0");
  });

  it("would leak without it: the same render in a development build records entries", async () => {
    expect(Number(await run(renderForASecond(false)))).toBeGreaterThan(0);
  });

  it("is the first import of cli.ts, so it runs before React is loaded", async () => {
    const source = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
    expect(source.split(/\r?\n/).find((line) => line.startsWith("import "))).toBe('import "./env.js";');
  });
});
