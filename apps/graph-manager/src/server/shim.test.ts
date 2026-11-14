import { describe, expect, it, vi } from "vitest";
import { planShim, runShim, type ShimIo } from "./shim.js";

const ENV = { GM_INTERNAL_URL: "http://127.0.0.1:7420", GM_INTERNAL_TOKEN: "tok" };

function io(answer?: () => Promise<Response>): ShimIo & { outs: string[]; errs: string[]; fetchMock: ReturnType<typeof vi.fn>; engine: ReturnType<typeof vi.fn> } {
  const outs: string[] = [];
  const errs: string[] = [];
  const fetchMock = vi.fn(answer ?? (async () => new Response("{}", { status: 500 })));
  const engine = vi.fn(async () => 7);
  return { cwd: "/ws/github/octo/hello", fetch: fetchMock as unknown as typeof fetch, spawnEngine: engine, out: (s) => outs.push(s), err: (s) => errs.push(s), outs, errs, fetchMock, engine };
}

const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("planShim", () => {
  it("runs the engine without --sandbox", () => {
    expect(planShim(["x", "--web"])).toEqual({ mode: "engine", args: ["x", "--web"] });
  });
  it("strips --sandbox and --web", () => {
    expect(planShim(["x", "--spec", "s", "--provider", "fake", "--web", "--sandbox"])).toEqual({ mode: "sandbox", args: ["x", "--spec", "s", "--provider", "fake"] });
    expect(planShim(["--sandbox", "x", "--sandbox"])).toEqual({ mode: "sandbox", args: ["x"] });
  });
  it("refuses --web-serve with --sandbox", () => {
    expect(planShim(["x", "--web-serve", "--sandbox"])).toEqual({ mode: "error", message: "--web-serve is internal" });
  });
});

describe("runShim", () => {
  it("prints the run URL on 201", async () => {
    const i = io(json(201, { runId: "gm-1", viewUrl: "/runs/github~octo~hello/gm-1/view/", url: "http://127.0.0.1:7420/runs/github~octo~hello/gm-1" }));
    expect(await runShim(["x", "--spec", "s", "--provider", "fake", "--web", "--sandbox"], ENV, i)).toBe(0);
    expect(i.outs.join("")).toBe("Run gm-1 started in a sandbox: http://127.0.0.1:7420/runs/github~octo~hello/gm-1\n");
    const [url, init] = i.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:7420/api/internal/sandbox-runs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({ cwd: "/ws/github/octo/hello", args: ["x", "--spec", "s", "--provider", "fake"] });
    expect(i.engine).not.toHaveBeenCalled();
  });

  it("prints the server's error and exits 2", async () => {
    const i = io(json(400, { error: "Docker is not reachable at /var/run/docker.sock", output: "line 1\nline 2" }));
    expect(await runShim(["x", "--sandbox"], ENV, i)).toBe(2);
    expect(i.errs.join("")).toBe("error: Docker is not reachable at /var/run/docker.sock\nline 1\nline 2\n");
  });

  it("exits 2 outside a graph-manager terminal", async () => {
    const i = io();
    expect(await runShim(["x", "--sandbox"], {}, i)).toBe(2);
    expect(i.errs.join("")).toBe("error: graph-execution --sandbox works only in a graph-manager terminal\n");
    expect(i.fetchMock).not.toHaveBeenCalled();
  });

  it("exits 2 when graph-manager does not answer", async () => {
    const i = io(async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    });
    expect(await runShim(["x", "--sandbox"], ENV, i)).toBe(2);
    expect(i.errs.join("")).toBe("error: graph-manager did not answer at http://127.0.0.1:7420: connect ECONNREFUSED\n");
  });

  it("exits 2 on --web-serve", async () => {
    const i = io();
    expect(await runShim(["x", "--web-serve", "--sandbox"], ENV, i)).toBe(2);
    expect(i.errs.join("")).toBe("error: --web-serve is internal\n");
  });

  it("runs the engine without --sandbox and returns its code", async () => {
    const i = io();
    expect(await runShim(["x", "--web"], ENV, i)).toBe(7);
    expect(i.engine).toHaveBeenCalledWith(["x", "--web"]);
    expect(i.fetchMock).not.toHaveBeenCalled();
  });
});
