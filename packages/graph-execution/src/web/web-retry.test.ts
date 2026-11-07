import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempRepo } from "../__fixtures__/repo.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import { RetryHub } from "../runner/retry-hub.js";
import { run } from "../runner/run.js";
import { startup } from "../runner/startup.js";
import type { ViewState } from "../ui/store.js";
import { startWebUi, type WebUiHandle } from "./start.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));

let repo: string;
beforeEach(async () => {
  repo = await tempRepo();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const fail = { commit: false, write: {} };
const summary = { cause: "the agent made no commit", verdict: "likely_to_work", why: "looks transient" };

async function start() {
  const provider = createFakeProvider(
    fakeScriptSchema.parse({
      "task:2": { attempts: [fail, fail, fail] },
      "summarizer:summary-2": { attempts: [{ summary }] },
    }),
  );
  const hub = new RetryHub();
  const tasks = await loadTasks(fixture("diamond"));
  const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log: () => {} });
  let web!: WebUiHandle;
  const done = run(ctx, tasks, {
    specPath: fixture("spec.md"),
    tasksDir: fixture("diamond"),
    log: () => {},
    concurrency: 1,
    retry: hub,
    ui: async (o) => (web = await startWebUi(o)),
  });
  const state = async () => (await (await fetch(`${web.url}state`)).json()) as ViewState;
  const until = async (pred: (s: ViewState) => boolean): Promise<ViewState> => {
    for (let i = 0; i < 400; i++) {
      const s = await state().catch(() => undefined);
      if (s && pred(s)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timeout");
  };
  const post = (path: string) => fetch(`${web.url}${path.replace(/^\//, "")}`, { method: "POST" });
  return { hub, done, until, post };
}

describe("web retry", () => {
  it("retries a failed node from the page and ends with the new result", async () => {
    const { done, until, post } = await start();
    const s = await until((s) => s.retryable.includes("2") && s.failures["2"]?.summary.status === "ready");
    expect(s.failures["2"]!.summary).toMatchObject({ status: "ready", verdict: "likely_to_work" });
    expect((await post("/retry/2")).status).toBe(200);
    await until((s) => s.summary?.exitCode === 0);
    expect((await post("/close")).status).toBe(200);
    expect((await done).exitCode).toBe(0);
  });

  it("quits the hub on Close without a retry", async () => {
    const { hub, done, until, post } = await start();
    await until((s) => s.retryable.includes("2"));
    expect((await post("/close")).status).toBe(200);
    expect((await done).exitCode).toBe(2);
    expect(hub.retryNode("2")).toEqual({ ok: false, reason: "not_waiting" });
  });
});
