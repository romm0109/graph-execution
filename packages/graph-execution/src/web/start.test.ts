import { afterEach, describe, expect, it } from "vitest";
import { RunEmitter } from "../runner/events.js";
import { startWebUi, type WebUiHandle } from "./start.js";

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
