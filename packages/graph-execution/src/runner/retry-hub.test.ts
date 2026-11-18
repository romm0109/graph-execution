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

describe("RetryHub resolution wait", () => {
  const update = { tasks: [], requeue: ["2"], removed: [] };

  it("refuses a resolution when nothing waits", () => {
    expect(new RetryHub().deliverResolution(update)).toEqual({ ok: false, reason: "not_waiting" });
  });

  it("resolves the wait with the delivered update and tells whenEscalationWaiting", async () => {
    const hub = new RetryHub();
    const started = hub.whenEscalationWaiting();
    expect(hub.escalationWaiting).toBe(false);
    const wait = hub.waitResolution();
    await started;
    expect(hub.escalationWaiting).toBe(true);
    await hub.whenEscalationWaiting();
    expect(hub.deliverResolution(update)).toEqual({ ok: true });
    expect(await wait).toBe(update);
    expect(hub.escalationWaiting).toBe(false);
  });

  it("resolves undefined after quit, now and later", async () => {
    const hub = new RetryHub();
    const wait = hub.waitResolution();
    hub.quit();
    expect(await wait).toBeUndefined();
    expect(await hub.waitResolution()).toBeUndefined();
  });
});

describe("RetryHub submitResolution", () => {
  it("refuses with 409 not_waiting without a handler", async () => {
    expect(await new RetryHub().submitResolution({})).toEqual({
      ok: false,
      status: 409,
      code: "not_waiting",
      message: "the run is not live",
    });
  });

  it("hands resolutions to the handler one at a time, in order", async () => {
    const hub = new RetryHub();
    const seen: string[] = [];
    let active = 0;
    const off = hub.onResolution(async (raw) => {
      active++;
      expect(active).toBe(1);
      seen.push(String(raw));
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { ok: true, requeued: [String(raw)] };
    });
    const results = await Promise.all([hub.submitResolution("a"), hub.submitResolution("b")]);
    expect(seen).toEqual(["a", "b"]);
    expect(results).toEqual([
      { ok: true, requeued: ["a"] },
      { ok: true, requeued: ["b"] },
    ]);
    off();
    expect(await hub.submitResolution("c")).toMatchObject({ ok: false, code: "not_waiting" });
  });
});
