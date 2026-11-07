import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import { tempRepo } from "./repo.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider } from "../providers/fake.js";
import type { AgentRun, Provider } from "../providers/types.js";
import { stateSchema } from "../state/state.js";
import { RunEmitter } from "../runner/events.js";
import { run } from "../runner/run.js";
import { startup } from "../runner/startup.js";

export const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));
export const spec = fixture("spec.md");

export let repo: string;
export let lines: string[];
export const log = (line: string): void => {
  lines.push(line);
};

beforeEach(async () => {
  repo = await tempRepo();
  lines = [];
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

export const readState = async (runDir: string) =>
  stateSchema.parse(JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")));

export async function runDiamond(
  provider: Provider = createFakeProvider(),
  concurrency?: number,
  extra: { merge?: boolean; events?: RunEmitter } = {},
) {
  const tasks = await loadTasks(fixture("diamond"));
  const ctx = await startup({ cwd: repo, provider: "fake", providerInstance: provider, log });
  const result = await run(ctx, tasks, { specPath: spec, tasksDir: fixture("diamond"), log, concurrency, ...extra });
  return { ctx, tasks, result };
}

/** Runs `fn` in the user's checkout when the first code reviewer starts, i.e. while the run is under way. */
export function onReview(provider: Provider, fn: () => Promise<unknown>): Provider {
  let done = false;
  return {
    name: provider.name,
    run(opts): AgentRun {
      if (opts.role !== "reviewer" || done) return provider.run(opts);
      done = true;
      const ready = fn();
      const agent = provider.run(opts);
      return { events: agent.events, done: ready.then(() => agent.done) };
    },
  };
}
