import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOKEN, toolApp, writeRun, type ToolApp } from "./tool-test-helpers.js";

let t: ToolApp;
const A = "gm-20261106-100000-aaaa";
const B = "gm-20261107-100000-bbbb";

beforeEach(async () => {
  t = await toolApp();
});
afterEach(async () => {
  await t.cleanup();
});

describe.skipIf(process.platform === "win32")("list_runs", () => {
  it("is listed with the other read tools", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/internal/tools", headers: { authorization: `Bearer ${TOKEN}` } });
    const names = (res.json() as { tools: { name: string }[] }).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["list_runs", "get_run_log", "list_graphs"]));
  });

  it("says when there are no runs", async () => {
    expect(await t.call("list_runs", {})).toEqual({ text: "Supervisor: report\n\nNo runs in this workspace." });
  });

  it("shows a failed run with its failure, task progress and task folder", async () => {
    await writeRun(t.wsDir, A, { status: "failed" });
    const r = await t.call("list_runs", {});
    expect(r.isError).toBeFalsy();
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("Supervisor: report");
    const row = lines.find((l) => l.includes(A))!;
    expect(row).toContain("| failed |");
    expect(row).toContain("task 2 failed");
    expect(row).toContain("1/2 merged, 1 failed");
    expect(row).toContain(".agents/tasks/demo");
    expect(row).toContain("2026-11-06T10:00:00.000Z");
  });

  it("shows the Supervisor mode", async () => {
    const put = await t.app.inject({ method: "PUT", url: `/api/workspaces/${t.wsId}/supervisor`, headers: { cookie: t.cookie }, payload: { mode: "act" } });
    expect(put.statusCode).toBe(204);
    expect((await t.call("list_runs", {})).text.split("\n")[0]).toBe("Supervisor: act");
  });

  it("sorts newest first, filters by status and limits", async () => {
    await writeRun(t.wsDir, A, { status: "failed", createdAt: "2026-11-06T10:00:00.000Z" });
    await writeRun(t.wsDir, B, { status: "applied", createdAt: "2026-11-07T10:00:00.000Z", tasks: { "1": { status: "merged", attempts: 1 } } });
    const all = (await t.call("list_runs", {})).text;
    expect(all.indexOf(B)).toBeGreaterThan(0);
    expect(all.indexOf(B)).toBeLessThan(all.indexOf(A));
    const applied = (await t.call("list_runs", { status: "applied" })).text;
    expect(applied).toContain(B);
    expect(applied).not.toContain(A);
    expect((await t.call("list_runs", { status: "done" })).text).toBe("Supervisor: report\n\nNo runs with status done in this workspace.");
    const one = (await t.call("list_runs", { limit: 1 })).text;
    expect(one).toContain(B);
    expect(one).not.toContain(A);
    expect(one).toContain("(1 more; pass limit to see them)");
  });

  it("refuses a terminal outside every workspace", async () => {
    expect(await t.call("list_runs", {}, { terminalId: t.rootTerminalId, cwd: t.config.workspacesDir })).toEqual({
      isError: true,
      text: "this terminal is not inside a graph-manager workspace",
    });
  });
});
