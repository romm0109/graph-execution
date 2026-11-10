import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolApp, type ToolApp } from "./tool-test-helpers.js";

let t: ToolApp;

beforeEach(async () => {
  t = await toolApp();
});
afterEach(async () => {
  await t.cleanup();
});

async function put(rel: string, body = "{}"): Promise<void> {
  const f = path.join(t.wsDir, rel);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, body);
}

describe.skipIf(process.platform === "win32")("list_graphs", () => {
  it("lists task folders recursively with their counts and specs", async () => {
    await put(".agents/tasks/a/1.json");
    await put(".agents/tasks/a/2.json");
    await put(".agents/tasks/a/test-plan.json");
    await put(".agents/tasks/group/b/1.json");
    await put(".agents/tasks/empty/notes.md", "x");
    await put("docs/prd/a.md", "# a");
    await put("docs/prd/done/b.md", "# b");
    const r = await t.call("list_graphs", {});
    expect(r.isError).toBeFalsy();
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("| tasksDir | tasks | spec |");
    expect(lines.slice(2)).toEqual(["| .agents/tasks/a | 2 | docs/prd/a.md |", "| .agents/tasks/group/b | 1 | docs/prd/done/b.md |"]);
  });

  it("says when there are no task folders", async () => {
    expect(await t.call("list_graphs", {})).toEqual({ text: "No task folders in this workspace (none under .agents/tasks/)." });
  });

  it("refuses a terminal outside every workspace", async () => {
    expect(await t.call("list_graphs", {}, { terminalId: t.rootTerminalId, cwd: t.config.workspacesDir })).toEqual({
      isError: true,
      text: "this terminal is not inside a graph-manager workspace",
    });
  });
});
