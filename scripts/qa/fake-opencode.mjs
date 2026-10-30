#!/usr/bin/env node
// Stand-in for `opencode run --auto --format json`, mimicking a weak/slow local model (e.g. Qwen3 27B).
// Behaviour comes from QA_OPENCODE_MODE: ok | slow | nocommit | loop | flaky | hang
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

if (process.argv.includes("--version")) {
  console.log("fake-opencode 0.0.0");
  process.exit(0);
}
const mode = process.env.QA_OPENCODE_MODE ?? "ok";
const delay = Number(process.env.QA_OPENCODE_DELAY_MS ?? 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log(JSON.stringify(o));
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const c of process.stdin) prompt += c;

const counter = path.join(process.env.QA_STATE_DIR ?? process.cwd(), ".qa-attempts");
const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
try { writeFileSync(counter, String(n)); } catch {}

const tool = (cmd) => emit({ type: "tool_use", part: { tool: "bash", state: { input: { command: cmd } } } });
const commit = () => {
  const name = `qa-${Date.now()}-${process.pid}.txt`;
  writeFileSync(name, "x\n");
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["-c", "user.name=qa", "-c", "user.email=qa@qa", "commit", "-q", "-m", "qa stub work"]);
};
emit({ type: "text", part: { type: "text", text: "starting" } });
if (mode === "hang") await sleep(10 * 60_000);
if (mode === "loop") { for (let i = 0; i < 30; i++) { tool("npm test"); await sleep(50); } process.exit(0); }
if (mode === "slow") await sleep(delay);
if (mode === "nocommit") { emit({ type: "text", part: { type: "text", text: "done (did not commit)" } }); process.exit(0); }
if (mode === "flaky" && n % 2 === 1) { console.error("provider error: context length exceeded"); process.exit(1); }
commit();
emit({ type: "text", part: { type: "text", text: "done" } });
