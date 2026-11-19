import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { watchIdle } from "../agents/idle.js";
import { watchLoops } from "../agents/loop.js";
import { RunEmitter } from "../runner/events.js";
import { teeOutput } from "../runner/run.js";
import { trackProcesses } from "../state/processes.js";
import { claudeInteractive, claudeProvider } from "./claude.js";
import { codexInteractive } from "./codex.js";
import { createFakeProvider, fakeAdvisorPath, fakeInteractive } from "./fake.js";
import { opencodeInteractive } from "./opencode.js";
import { qwenInteractive } from "./qwen.js";
import type { Provider } from "./types.js";

const first = { cwd: "/w", firstMessage: "Read /r/escalations/E1/advisor.md and follow it." };

describe("interactive command lines", () => {
  it("claude takes the first message as its prompt argument", () => {
    expect(claudeInteractive(first)).toEqual({ file: "claude", args: [first.firstMessage] });
    expect(claudeInteractive({ ...first, model: "opus" })).toEqual({ file: "claude", args: ["--model", "opus", first.firstMessage] });
  });

  it("codex takes it as its [PROMPT] argument", () => {
    expect(codexInteractive({ ...first, model: "o3" })).toEqual({ file: "codex", args: ["--model", "o3", first.firstMessage] });
  });

  it("opencode 1 uses --prompt; opencode 2 runs --standalone and the message is typed", () => {
    expect(opencodeInteractive(first, 1)).toEqual({ file: "opencode", args: ["--prompt", first.firstMessage] });
    expect(opencodeInteractive(first, undefined)).toEqual({ file: "opencode", args: ["--prompt", first.firstMessage] });
    expect(opencodeInteractive({ ...first, model: "m" }, 2)).toEqual({ file: "opencode", args: ["--standalone", "--model", "m"], typeFirstMessage: true });
  });

  it("qwen uses -i (--prompt-interactive)", () => {
    expect(qwenInteractive(first)).toEqual({ file: "qwen", args: ["-i", first.firstMessage] });
  });

  it("the fake runs fake-advisor.js with the context file, the script and the id", () => {
    const cmd = fakeInteractive(first, { GRAPH_EXECUTION_FAKE_SCRIPT: "/s.json" });
    expect(cmd).toEqual({ file: process.execPath, args: [fakeAdvisorPath(), "/r/escalations/E1/advisor.md", "/s.json", "E1"] });
    expect(existsSync(fakeAdvisorPath())).toBe(true);
  });

  it("every provider wrapper forwards interactive", () => {
    const wrapped: Provider = teeOutput(watchIdle(watchLoops(trackProcesses(claudeProvider, "/tmp/x"), { repeats: 5 }), 10), new RunEmitter());
    expect(wrapped.interactive?.(first)).toEqual(claudeInteractive(first));
    const bare: Provider = { name: "x", run: claudeProvider.run };
    expect(teeOutput(watchIdle(watchLoops(trackProcesses(bare, "/tmp/x"), { repeats: 5 }), 10), new RunEmitter()).interactive).toBeUndefined();
    expect(createFakeProvider().interactive).toBeTypeOf("function");
  });
});

describe("fake advisor", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "fake-advisor-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("echoes lines, writes the scripted draft and exits", async () => {
    const draftFile = path.join(dir, "E1", "draft.json");
    const context = path.join(dir, "advisor.md");
    await writeFile(context, `# Escalation E1\n\nDraft file: ${draftFile}\nApply command: ${JSON.stringify([process.execPath, "-e", "console.log('applied')"])}\n`);
    const script = path.join(dir, "script.json");
    const draft = { escalationIds: ["E1"], action: "continue", guidance: "B" };
    await writeFile(script, JSON.stringify({ "advisor:E1": { attempts: [], draft } }));

    const child = spawn(process.execPath, [fakeAdvisorPath(), context, script, "E1"], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitFor = async (text: string): Promise<void> => {
      for (let i = 0; i < 200 && !out.includes(text); i++) await new Promise((r) => setTimeout(r, 25));
      expect(out).toContain(text);
    };
    await waitFor("advisor ready (E1)\r\n");
    child.stdin.write("hello\r");
    await waitFor("you said: hello\r\n");
    child.stdin.write("draft\n");
    await waitFor("draft written");
    expect(JSON.parse(await readFile(draftFile, "utf8"))).toEqual(draft);
    child.stdin.write("apply\r");
    await waitFor("apply exited 0");
    expect(out).toContain("applied");
    child.stdin.write("exit\r");
    expect(await exited).toBe(0);
  });
});
