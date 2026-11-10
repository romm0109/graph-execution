import { describe, expect, it, vi } from "vitest";
import { originOf, planShim, runShim, shimRunId, type ShimIo } from "./shim.js";

const ENV = { GM_INTERNAL_URL: "http://127.0.0.1:7420", GM_INTERNAL_TOKEN: "tok" };
const TERM_ENV = { ...ENV, GM_TERMINAL_ID: "t3" };

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

describe("shimRunId", () => {
  it("has graph-manager's run id format in local time", () => {
    expect(shimRunId(new Date(2026, 10, 9, 8, 5, 3))).toMatch(/^gm-20261109-080503-[0-9a-f]{4}$/);
  });
});

describe("originOf", () => {
  it("picks a run id for a new run", () => {
    expect(originOf(["tasks", "--spec", "s.md", "--provider", "fake"], {})).toEqual({ runId: expect.stringMatching(/^gm-/), setEnv: true });
  });
  it("uses --run of --resume without setting the env", () => {
    expect(originOf(["--resume", "--run", "gm-1"], {})).toEqual({ runId: "gm-1", setEnv: false });
    expect(originOf(["--resume", "--run=gm-1"], {})).toEqual({ runId: "gm-1", setEnv: false });
  });
  it("finds no run for subcommands, help, version, --web-serve and --resume without --run", () => {
    for (const args of [["--resume"], ["suite", "--feature", "a:b"], ["list"], ["tasks", "--help"], ["--version"], ["tasks", "--web-serve"]]) {
      expect(originOf(args, {})).toBeUndefined();
    }
  });
  it("keeps a GRAPH_EXECUTION_RUN_ID already set", () => {
    expect(originOf(["tasks"], { GRAPH_EXECUTION_RUN_ID: "r9" })).toEqual({ runId: "r9", setEnv: false });
  });
  it("rejects an invalid run id", () => {
    expect(originOf(["--resume", "--run", ".bad"], {})).toBeUndefined();
  });
});

describe("runShim origins", () => {
  const ARGS = ["tasks", "--spec", "s", "--provider", "fake"];
  const bodyOf = (i: ReturnType<typeof io>, n = 0) => JSON.parse(String((i.fetchMock.mock.calls[n] as [string, RequestInit])[1].body)) as Record<string, unknown>;

  it("registers the origin and passes the run id to the engine", async () => {
    const i = io(async () => new Response(null, { status: 204 }));
    expect(await runShim(ARGS, TERM_ENV, i)).toBe(7);
    expect(i.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = i.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:7420/api/internal/run-origins");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const body = bodyOf(i);
    expect(body).toEqual({ terminalId: "t3", cwd: "/ws/github/octo/hello", runId: expect.stringMatching(/^gm-/) });
    expect(i.engine).toHaveBeenCalledWith(ARGS, { GRAPH_EXECUTION_RUN_ID: body.runId });
  });

  it("registers --resume --run without setting the env", async () => {
    const i = io(async () => new Response(null, { status: 204 }));
    expect(await runShim(["--resume", "--run", "gm-1"], TERM_ENV, i)).toBe(7);
    expect(bodyOf(i)).toMatchObject({ runId: "gm-1", resume: true });
    expect(i.engine.mock.calls[0]).toEqual([["--resume", "--run", "gm-1"]]);
  });

  it("still runs the engine when graph-manager does not answer", async () => {
    const i = io(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await runShim(ARGS, TERM_ENV, i)).toBe(7);
    expect(i.engine).toHaveBeenCalled();
    expect(i.errs).toEqual([]);
    expect(i.outs).toEqual([]);
  });

  it("still runs the engine when graph-manager refuses the origin", async () => {
    const i = io(json(400, { error: "unknown terminal t3" }));
    expect(await runShim(ARGS, TERM_ENV, i)).toBe(7);
    expect(i.engine).toHaveBeenCalled();
    expect(i.errs).toEqual([]);
    expect(i.outs).toEqual([]);
  });

  it("registers nothing without GM_TERMINAL_ID", async () => {
    const i = io();
    expect(await runShim(["tasks"], ENV, i)).toBe(7);
    expect(i.fetchMock).not.toHaveBeenCalled();
    expect(i.engine).toHaveBeenCalledWith(["tasks"]);
  });

  it("registers nothing for a subcommand", async () => {
    const i = io();
    await runShim(["list"], TERM_ENV, i);
    expect(i.fetchMock).not.toHaveBeenCalled();
    expect(i.engine.mock.calls[0]).toEqual([["list"]]);
  });

  it("sends the terminal id with a sandbox run", async () => {
    const i = io(json(201, { runId: "gm-1", url: "u" }));
    expect(await runShim([...ARGS, "--sandbox"], TERM_ENV, i)).toBe(0);
    expect(bodyOf(i)).toEqual({ cwd: "/ws/github/octo/hello", args: ARGS, terminalId: "t3" });
  });
});
