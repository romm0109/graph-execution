import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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

const ESCALATION = { reason: "A or B is unclear", evidence: "spec line 3", questions: [{ id: "q1", question: "A or B?", suggestedOptions: ["A", "B"] }] };
type State = ViewState & { drafts: Record<string, number> };

async function start() {
  const provider = createFakeProvider(fakeScriptSchema.parse({ "task:2": { attempts: [{ escalate: ESCALATION }] } }));
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
  const get = async (p: string) => {
    const res = await fetch(`${web.url}${p}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const until = async (pred: (s: State) => boolean): Promise<State> => {
    for (let i = 0; i < 400; i++) {
      const s = (await get("state").catch(() => undefined))?.body as State | undefined;
      if (s && pred(s)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timeout");
  };
  const post = (p: string, body?: unknown) =>
    fetch(`${web.url}${p}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  const writeDraft = async (draft: unknown) => {
    const dir = path.join(ctx.runDir, "escalations", "E1");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "draft.json"), JSON.stringify(draft));
  };
  return { done, get, until, post, writeDraft };
}

describe("web escalation", () => {
  it("shows a hand-written draft and applies it from the page", async () => {
    const { done, get, until, post, writeDraft } = await start();
    await until((s) => (s.escalations ?? []).some((e) => e.id === "E1" && e.status === "open"));
    expect(await get("escalations/E1/draft")).toEqual({ status: 200, body: { draft: null } });
    const tasks = (await get("escalations/E1/tasks")).body.tasks as { id: string }[];
    expect(tasks.map((t) => t.id).sort()).toEqual(["1", "2", "3", "4"]);

    // A draft the run would refuse shows its refusal as a preview.
    await writeDraft({ escalationIds: ["E1"], action: "change", editTasks: [{ id: "1", content: "Again." }] });
    const s1 = await until((s) => (s.drafts?.E1 ?? 0) >= 1);
    expect((await get("escalations/E1/draft")).body.error).toMatch(/^refused \(task_started\)/);

    const draft = { escalationIds: ["E1"], action: "continue", guidance: "B" };
    await writeDraft(draft);
    await until((s) => (s.drafts?.E1 ?? 0) > s1.drafts.E1!);
    expect(await get("escalations/E1/draft")).toEqual({ status: 200, body: { draft } });

    const res = await post("escalations/resolve", draft);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, requeued: ["2"] });
    await until((s) => s.summary?.exitCode === 0);
    expect((await post("close")).status).toBe(200);
    expect((await done).exitCode).toBe(0);
  });

  it("aborts the run from the page", async () => {
    const { done, until, post } = await start();
    await until((s) => (s.escalations ?? []).some((e) => e.id === "E1" && e.status === "open"));
    const res = await post("escalations/resolve", { escalationIds: ["E1"], action: "abort" });
    expect(res.status).toBe(200);
    await until((s) => s.summary !== undefined);
    expect((await post("close")).status).toBe(200);
    expect((await done).exitCode).not.toBe(0);
  });
});
