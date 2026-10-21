import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import { tempRepo } from "./repo.js";
import { codeReportPath } from "../agents/reviewer.js";
import { testerReportPath } from "../agents/tester.js";
import { CONFIG_FILE } from "../config/config.js";
import { loadTasks } from "../graph/load.js";
import { createFakeProvider, fakeScriptSchema } from "../providers/fake.js";
import type { Provider } from "../providers/types.js";
import { RunEmitter } from "../runner/events.js";
import { RetryHub } from "../runner/retry-hub.js";
import { run } from "../runner/run.js";
import { startup } from "../runner/startup.js";

export const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));
export const spec = fixture("spec.md");
export const tasksDir = fixture("diamond");

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
  await rm(repo, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

export const blocker = {
  id: "F1",
  severity: "blocker",
  file: "1.txt",
  line: 1,
  description: "Wrong content.",
  failureScenario: "Reading 1.txt returns the task id instead of the result.",
  status: "open",
};

export async function runReview(
  script: unknown = {},
  opts: {
    config?: unknown;
    wrap?: (p: Provider) => Provider;
    noTaskValidation?: boolean;
    events?: RunEmitter;
    tasksDir?: string;
    retry?: RetryHub;
  } = {},
) {
  if (opts.config !== undefined) await writeFile(path.join(repo, CONFIG_FILE), JSON.stringify(opts.config));
  const provider = createFakeProvider(fakeScriptSchema.parse(script));
  const instance = opts.wrap ? opts.wrap(provider) : provider;
  const ctx = await startup({
    cwd: repo,
    provider: "fake",
    providerInstance: instance,
    log,
  });
  const dir = opts.tasksDir ?? tasksDir;
  const loaded = await loadTasks(dir);
  const tasks = opts.noTaskValidation ? loaded.map((t) => ({ ...t, validate: false as const })) : loaded;
  const result = await run(ctx, tasks, {
    specPath: spec,
    tasksDir: dir,
    log,
    concurrency: 1,
    events: opts.events,
    ...(opts.retry ? { retry: opts.retry } : {}),
  });
  const reviewerCalls = provider.calls.filter((c) => c.role === "reviewer");
  const testerCalls = provider.calls.filter((c) => c.role === "tester");
  const reportFile = codeReportPath(ctx.runDir, 0);
  const testerFile = testerReportPath(ctx.runDir, 0);
  return {
    provider,
    ctx,
    result,
    reviewerCalls,
    testerCalls,
    reportFile,
    testerFile,
  };
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
