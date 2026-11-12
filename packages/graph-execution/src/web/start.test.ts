import { afterEach, describe, expect, it } from "vitest";
import { RunEmitter } from "../runner/events.js";
import { listenFromEnv, startWebUi, type WebUiHandle } from "./start.js";

let ui: WebUiHandle | undefined;
afterEach(async () => {
  await ui?.close();
  ui = undefined;
});

describe("startWebUi", () => {
  it("keeps run log lines in the snapshot and drops agent output lines", async () => {
    ui = await startWebUi({ events: new RunEmitter(), layers: [["1"]], attempts: 3, runId: "r1", provider: "fake" });
    ui.log("starting");
    ui.log("[1] agent says hi");
    const body = (await (await fetch(`${ui.url}state`)).json()) as { events: { text: string }[] };
    expect(body.events.map((e) => e.text)).toEqual(["starting"]);
    await ui.stop();
    expect((await fetch(`${ui.url}state`)).status).toBe(200);
  });
});

describe("listenFromEnv", () => {
  it("defaults to 127.0.0.1 and any free port", () => {
    expect(listenFromEnv({})).toEqual({ host: "127.0.0.1", port: 0 });
    expect(listenFromEnv({ GRAPH_EXECUTION_WEB_HOST: " ", GRAPH_EXECUTION_WEB_PORT: "" })).toEqual({ host: "127.0.0.1", port: 0 });
  });

  it("reads the bind address and port", () => {
    expect(listenFromEnv({ GRAPH_EXECUTION_WEB_HOST: "0.0.0.0", GRAPH_EXECUTION_WEB_PORT: "7600", GRAPH_EXECUTION_WEB_TOKEN: "s3cret" })).toEqual({
      host: "0.0.0.0",
      port: 7600,
      token: "s3cret",
    });
  });

  it("requires a token for a non-loopback address", () => {
    expect(() => listenFromEnv({ GRAPH_EXECUTION_WEB_HOST: "0.0.0.0" })).toThrow("GRAPH_EXECUTION_WEB_HOST=0.0.0.0 needs GRAPH_EXECUTION_WEB_TOKEN");
    expect(listenFromEnv({ GRAPH_EXECUTION_WEB_HOST: "127.0.0.1", GRAPH_EXECUTION_WEB_TOKEN: "t" })).toEqual({ host: "127.0.0.1", port: 0, token: "t" });
  });

  it("rejects an invalid port", () => {
    expect(() => listenFromEnv({ GRAPH_EXECUTION_WEB_PORT: "abc" })).toThrow("GRAPH_EXECUTION_WEB_PORT must be a port number (0-65535), got 'abc'");
    expect(() => listenFromEnv({ GRAPH_EXECUTION_WEB_PORT: "70000" })).toThrow("got '70000'");
    expect(() => listenFromEnv({ GRAPH_EXECUTION_WEB_PORT: "-1" })).toThrow();
  });

  it("reads the public port and rejects an invalid one", () => {
    expect(listenFromEnv({ GRAPH_EXECUTION_WEB_PUBLIC_PORT: "49152" })).toEqual({ host: "127.0.0.1", port: 0, publicPort: 49152 });
    expect(listenFromEnv({ GRAPH_EXECUTION_WEB_PUBLIC_PORT: " " })).toEqual({ host: "127.0.0.1", port: 0 });
    for (const v of ["0", "70000", "abc", "-1", "1.5"]) {
      expect(() => listenFromEnv({ GRAPH_EXECUTION_WEB_PUBLIC_PORT: v })).toThrow("GRAPH_EXECUTION_WEB_PUBLIC_PORT");
    }
  });
});
