import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseReportText, summaryPathLine } from "../review/report.js";
import { logFileName } from "../ui/store.js";
import type { Provider } from "../providers/types.js";
import { fence } from "./reviewer.js";

export const failureSummarySchema = z.object({
  cause: z.string().min(1),
  verdict: z.enum(["likely_to_work", "unlikely_to_help", "unclear"]),
  why: z.string().min(1),
});

export type FailureSummary = z.infer<typeof failureSummarySchema>;

export interface FailureSummaryPromptInput {
  title: string;
  kind: string;
  error: string;
  /** One line per failed attempt so far, oldest first. */
  attempts: string[];
  logTail: string;
  path: string;
  /** The task's text, for a task node. */
  taskContent?: string;
}

/** The directory summarizer agents run in: empty, so a full-auto agent cannot touch a worktree or the repo. */
export const summaryWorkDir = (runDir: string): string => path.join(runDir, "summaries", "work");

const sanitize = (id: string): string => id.replace(/[^\w.-]+/g, "-").replace(/^-+/, "");

export const summaryLabel = (nodeId: string): string => `summary-${sanitize(nodeId)}`;

export function failureSummaryPrompt(input: FailureSummaryPromptInput): string {
  const out = [
    "You are explaining a failure to a developer who does not know why it happened. The failed step is part of a run in which AI coding agents build a change set from a specification.",
    "",
    "Read nothing else unless you really need to, and do NOT modify any file except the summary file named at the end.",
    "Answer in plain language, without jargon, as a JSON object with these keys:",
    "",
    "- `cause`: one or two sentences saying what went wrong.",
    "- `verdict`: whether trying the step again is likely to help.",
    "  - `likely_to_work` for transient causes such as timeouts, rate limits, flaky tests, an agent that crashed or made no commit.",
    "  - `unlikely_to_help` for causes a retry will not change, such as contradictory task text, a missing dependency, a spec that cannot be satisfied.",
    "  - `unclear` otherwise.",
    "- `why`: one line giving the reason for the verdict.",
    "",
    `## The failed step: ${input.title} (${input.kind})`,
    "",
    "Last error:",
    "",
    fence(input.error),
  ];
  if (input.taskContent && input.taskContent.trim() !== "") {
    out.push("", "The task the step was given:", "", fence(input.taskContent.slice(0, 4000)));
  }
  if (input.attempts.length > 0) out.push("", "Attempts so far:", "", ...input.attempts.map((a) => `- ${a}`));
  if (input.logTail.trim() !== "") out.push("", "The end of the agent's output:", "", fence(input.logTail));
  out.push("", summaryPathLine(input.path));
  return out.join("\n");
}

/** How much of the end of an agent's log `readLogTail` reads: the log holds every attempt's output and can be huge. */
export const LOG_TAIL_BYTES = 64 * 1024;

/**
 * The last `maxLines` lines of an agent's log, capped to `maxChars` characters; empty when there is no log. Only the
 * last `LOG_TAIL_BYTES` of the file are read.
 */
export async function readLogTail(logsDir: string, label: string, maxLines = 60, maxChars = 4000): Promise<string> {
  let text: string;
  try {
    const fh = await open(path.join(logsDir, logFileName(label)), "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      let bytes = buf.subarray(0, bytesRead);
      // The read began inside a line: drop that partial line, unless it is all there is (one huge line).
      if (start > 0) {
        const nl = bytes.indexOf(0x0a);
        if (nl !== -1 && nl < bytes.length - 1) bytes = bytes.subarray(nl + 1);
      }
      text = bytes.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
  const tail = text.trimEnd().split("\n").slice(-maxLines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

export interface RunFailureSummaryOptions {
  provider: Provider;
  model?: string;
  runDir: string;
  nodeId: string;
  /** The failed node's agent label, whose log tail is shown to the summarizer. */
  label: string;
  title: string;
  kind: string;
  error: string;
  attempts: string[];
  logTail: string;
  taskContent?: string;
  signal: AbortSignal;
  /** Stops the summarizer after this long, whatever the config says; defaults to `SUMMARY_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** A summarizer is always stopped after this long, so it can never hold up the end of a run. */
export const SUMMARY_TIMEOUT_MS = 5 * 60_000;

/** Asks the provider for a plain-language summary of a failure; `undefined` when anything goes wrong. */
export async function runFailureSummary(opts: RunFailureSummaryOptions): Promise<FailureSummary | undefined> {
  const file = path.join(opts.runDir, "summaries", `${sanitize(opts.nodeId)}-${Date.now()}.json`);
  const own = new AbortController();
  const relay = (): void => own.abort(opts.signal.reason);
  if (opts.signal.aborted) own.abort(opts.signal.reason);
  else opts.signal.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => own.abort(), opts.timeoutMs ?? SUMMARY_TIMEOUT_MS);
  timer.unref();
  try {
    const cwd = summaryWorkDir(opts.runDir);
    await mkdir(cwd, { recursive: true });
    await rm(file, { force: true });
    const prompt = failureSummaryPrompt({ ...opts, path: file });
    const agent = opts.provider.run({
      role: "summarizer",
      prompt,
      cwd,
      signal: own.signal,
      model: opts.model,
      label: summaryLabel(opts.nodeId),
    });
    agent.done.catch(() => undefined);
    for await (const _ of agent.events) void _;
    if ((await agent.done).exitCode !== 0 || own.signal.aborted || !existsSync(file)) return undefined;
    const parsed = failureSummarySchema.safeParse(parseReportText(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", relay);
  }
}
