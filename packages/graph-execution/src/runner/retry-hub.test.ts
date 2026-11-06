import { describe, expect, it } from "vitest";
import { RetryHub } from "./retry-hub.js";

describe("RetryHub review wait", () => {
  it("rejects a decision when nothing waits", () => {
    expect(new RetryHub().decide({ review: "drop" })).toEqual({ ok: false, reason: "not_waiting" });
  });

  it("resolves the wait with the decision", async () => {
    const hub = new RetryHub();
    const wait = hub.waitReview();
    expect(hub.reviewWaiting).toBe(true);
    expect(hub.decide({ review: "apply", force: true })).toEqual({ ok: true });
    expect(await wait).toEqual({ review: "apply", force: true });
    expect(hub.reviewWaiting).toBe(false);
  });

  it("resolves undefined after quit, now and later", async () => {
    const hub = new RetryHub();
    const wait = hub.waitReview();
    hub.quit();
    expect(await wait).toBeUndefined();
    expect(await hub.waitReview()).toBeUndefined();
  });
});
