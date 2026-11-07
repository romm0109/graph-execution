import { describe, expect, it } from "vitest";
import { RunEmitter } from "../runner/events.js";
import { RetryHub } from "../runner/retry-hub.js";
import type { UiOptions } from "./start.js";
import { withWebUi } from "./withWeb.js";

describe("withWebUi", () => {
  it("serves the web view and logs the review URL when the run waits", async () => {
    const events = new RunEmitter();
    const lines: string[] = [];
    let seen: UiOptions | undefined;
    const ui = withWebUi((o) => {
      seen = o;
      return { log: (l) => void lines.push(l), stop: async () => {} };
    });
    const opts: UiOptions = {
      events,
      layers: [["1"]],
      attempts: 3,
      runId: "r",
      provider: "fake",
      retry: new RetryHub(),
    };
    const handle = await ui(opts);
    const url = /web view: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(lines.join("\n"))?.[1];
    expect(url).toBeDefined();
    expect(seen?.reviewUrl).toBe(url);
    expect((await fetch(`${url}state`)).status).toBe(200);
    events.emit("review:waiting", { round: 1, blocking: [] } as never);
    expect(lines.join("\n")).toContain("waiting for your review: http://127.0.0.1:");
    await handle.stop();
  });
});
