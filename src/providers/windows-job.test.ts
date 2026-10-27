import { describe, expect, it } from "vitest";
import { commandLine, jobLaunch, NO_JOB_ENV, quoteWindowsArg } from "./windows-job.js";

describe("quoteWindowsArg", () => {
  it("leaves plain arguments alone and quotes empty ones and ones with spaces", () => {
    expect(quoteWindowsArg("--model")).toBe("--model");
    expect(quoteWindowsArg("C:\\a\\b")).toBe("C:\\a\\b");
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("a b")).toBe('"a b"');
  });

  it("escapes quotes and the backslashes before them, and trailing backslashes", () => {
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"');
    expect(quoteWindowsArg("C:\\my dir\\")).toBe('"C:\\my dir\\\\"');
  });
});

describe("commandLine", () => {
  it("joins cross-spawn's already escaped cmd.exe arguments as they are", () => {
    const parsed = {
      command: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\bin\\opencode.cmd ^"run^""'],
      file: "C:\\bin\\opencode.cmd",
      options: { windowsVerbatimArguments: true },
    };
    expect(commandLine(parsed)).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: '/d /s /c "C:\\bin\\opencode.cmd ^"run^""',
    });
  });

  it("quotes each argument of an executable", () => {
    const parsed = { command: "codex", args: ["exec", "--model", "a b"], file: "C:\\bin\\codex.exe", options: {} };
    expect(commandLine(parsed)).toEqual({ file: "codex", args: 'exec --model "a b"' });
  });
});

describe("jobLaunch", () => {
  it("starts the agent directly when turned off", () => {
    expect(jobLaunch("opencode", ["run"], process.cwd(), { [NO_JOB_ENV]: "1" })).toBeUndefined();
  });

  it("starts the agent directly when it cannot be found, so the start error is reported as before", () => {
    expect(jobLaunch("no-such-agent-cli", [], process.cwd(), { PATH: "" })).toBeUndefined();
  });
});
