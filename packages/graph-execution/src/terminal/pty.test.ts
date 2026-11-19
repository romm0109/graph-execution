import { describe, expect, it } from "vitest";
import { clamp, createPtySession, SCROLLBACK_MAX } from "./pty.js";

const skip = process.platform === "win32";

describe("clamp", () => {
  it("keeps sizes in 2..1000 with a fallback", () => {
    expect([clamp(undefined, 80), clamp(Number.NaN, 24), clamp(1, 80), clamp(5000, 80), clamp(99.7, 80)]).toEqual([80, 24, 2, 1000, 99]);
  });
});

describe.skipIf(skip)("createPtySession", () => {
  it("streams output, reports the exit, replays and restarts with a line break", async () => {
    const chunks: string[] = [];
    const s = await createPtySession({ file: "/bin/sh", args: ["-c", "printf hi; exit 3"], cwd: process.cwd(), env: process.env, onActivity: (c) => chunks.push(c) });
    let out = "";
    let restarts = 0;
    const exited = new Promise<number>((resolve) => s.attach({ data: (d) => (out += d), exit: resolve, restart: () => restarts++ }));
    expect(await exited).toBe(3);
    expect(out).toContain("hi");
    expect(chunks.join("")).toContain("hi");
    expect(s.exited).toBe(true);
    expect(() => s.attach({ data: () => {}, exit: () => {} }).write("ignored")).not.toThrow();

    const late = await new Promise<number>((resolve) => s.attach({ data: () => {}, exit: resolve }));
    expect(late).toBe(3);

    s.restart();
    expect(restarts).toBe(1);
    expect(s.exited).toBe(false);
    await new Promise<void>((resolve) => s.attach({ data: () => {}, exit: () => resolve() }));
    const replay = s.attach({ data: () => {}, exit: () => {} }).replay;
    expect(replay).toMatch(/hi\r\nhi/);
    expect(replay.length).toBeLessThanOrEqual(SCROLLBACK_MAX);
  });

  it("refuses to restart a running process and kills it", async () => {
    const s = await createPtySession({ file: "/bin/sh", args: ["-c", "sleep 30"], cwd: process.cwd(), env: process.env, cols: 100, rows: 30 });
    expect(s.cols).toBe(100);
    expect(s.pid).toBeGreaterThan(0);
    expect(() => s.restart()).toThrow();
    const exited = new Promise<void>((resolve) => s.attach({ data: () => {}, exit: () => resolve() }));
    s.kill();
    await exited;
    expect(s.exited).toBe(true);
  });
});
