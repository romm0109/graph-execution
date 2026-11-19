// The fake provider's interactive advisor (`createFakeProvider().interactive`), a small line-based program that stands in
// for an interactive agent CLI in a PTY, so the advisor terminal is testable without a model:
//   node fake-advisor.js <contextFile> <scriptFile> <id>
// It prints `advisor ready (<id>)`, then echoes every line as `you said: <line>`. The line `draft` writes the `draft` of
// the script's `advisor:<id>` entry to the context file's `Draft file:`; `apply` runs its `Apply command:` (a JSON
// array); `exit` closes stdin, which ends it with code 0. `<scriptFile>` may be empty: GRAPH_EXECUTION_FAKE_SCRIPT is read then.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [contextFile = "", scriptArg = "", id = "E?"] = process.argv.slice(2);
const out = (text: string): void => void process.stdout.write(text.replace(/\r?\n/g, "\r\n"));

/** The value of the context file's `<label>: <value>` line; undefined when there is none. */
function contextLine(label: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(contextFile, "utf8");
  } catch {
    return undefined;
  }
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${label}: `));
  return line?.slice(label.length + 2).trim();
}

function scriptDraft(): unknown {
  const file = scriptArg || process.env.GRAPH_EXECUTION_FAKE_SCRIPT;
  if (!file) return undefined;
  try {
    const script = JSON.parse(readFileSync(file, "utf8")) as Record<string, { draft?: unknown } | undefined>;
    return script[`advisor:${id}`]?.draft;
  } catch {
    return undefined;
  }
}

function writeDraft(): void {
  const file = contextLine("Draft file");
  const draft = scriptDraft();
  if (!file) return out("no draft file in the context\n");
  if (draft === undefined) return out(`no draft for advisor:${id} in the script\n`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(draft, null, 2));
  out("draft written\n");
}

function apply(): void {
  const raw = contextLine("Apply command");
  let argv: unknown;
  try {
    argv = raw ? JSON.parse(raw) : undefined;
  } catch {
    argv = undefined;
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) return out("no apply command in the context\n");
  const [file, ...args] = argv as string[];
  const res = spawnSync(file!, args, { encoding: "utf8" });
  if (res.stdout) out(res.stdout);
  if (res.stderr) out(res.stderr);
  if (res.error) out(`${res.error.message}\n`);
  out(`apply exited ${res.status ?? 1}\n`);
}

out(`advisor ready (${id})\n`);
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  pending += chunk;
  const lines = pending.split(/\r\n|\r|\n/);
  pending = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    out(`you said: ${line}\n`);
    if (line === "draft") writeDraft();
    else if (line === "apply") apply();
    // Nothing else keeps the process alive: closing stdin ends it with code 0.
    else if (line === "exit") return void process.stdin.destroy();
  }
});
