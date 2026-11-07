import { describe, expect, it } from "vitest";
import { codexToolCalls, opencodeToolCalls, streamJsonToolCalls } from "./tools.js";

// Lines from each CLI's real output for "run `echo loopcheck` twice, then read note.txt", with ids trimmed.
const claudeBash =
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo loopcheck","description":"Echo loopcheck (first)"}}]}}';
const claudeText = '{"type":"assistant","message":{"content":[{"type":"text","text":"DONE"}]}}';
const qwenRead =
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call_1","name":"read_file","input":{"file_path":"/w/note.txt"}}]}}';
const codexStarted =
  '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \'echo loopcheck\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}';
const codexCompleted =
  '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc \'echo loopcheck\'","aggregated_output":"loopcheck\\n","exit_code":0,"status":"completed"}}';
const codexMessage = '{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"DONE"}}';
const opencodeShell =
  '{"type":"tool_use","sessionID":"s","part":{"type":"tool","id":"call_1","tool":"shell","state":{"status":"completed","input":{"command":"echo loopcheck"},"output":"loopcheck\\n"}}}';
const opencodeStep = '{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"tool-calls"}}';

describe("streamJsonToolCalls (Claude Code, Qwen Code)", () => {
  it("returns the tool_use blocks of an assistant message", () => {
    expect(streamJsonToolCalls(claudeBash)).toEqual([
      { name: "Bash", input: { command: "echo loopcheck", description: "Echo loopcheck (first)" } },
    ]);
    expect(streamJsonToolCalls(qwenRead)).toEqual([{ name: "read_file", input: { file_path: "/w/note.txt" } }]);
  });
  it("returns nothing for text, other messages and non-JSON lines", () => {
    expect(streamJsonToolCalls(claudeText)).toEqual([]);
    expect(streamJsonToolCalls('{"type":"user","message":{"content":[]}}')).toEqual([]);
    expect(streamJsonToolCalls("not json")).toEqual([]);
  });
});

describe("codexToolCalls", () => {
  it("counts a call once, on its item.completed, without the fields that change between runs", () => {
    expect(codexToolCalls(codexStarted)).toEqual([]);
    expect(codexToolCalls(codexCompleted)).toEqual([
      { name: "command_execution", input: { command: "/bin/zsh -lc 'echo loopcheck'" } },
    ]);
  });
  it("ignores messages and non-JSON lines", () => {
    expect(codexToolCalls(codexMessage)).toEqual([]);
    expect(codexToolCalls("Reading prompt from stdin...")).toEqual([]);
  });
});

describe("opencodeToolCalls", () => {
  it("returns the tool and its input from a tool_use event", () => {
    expect(opencodeToolCalls(opencodeShell)).toEqual([{ name: "shell", input: { command: "echo loopcheck" } }]);
  });
  it("ignores other events and non-JSON lines", () => {
    expect(opencodeToolCalls(opencodeStep)).toEqual([]);
    expect(opencodeToolCalls("")).toEqual([]);
  });
});
