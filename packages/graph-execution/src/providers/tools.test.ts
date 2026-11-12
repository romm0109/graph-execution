import { describe, expect, it } from "vitest";
import { codexToolCalls, copilotToolCalls, opencodeToolCalls, piJsonToolCalls, streamJsonToolCalls } from "./tools.js";

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

const piStart = '{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"}}';
const piEnd =
  '{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"hi\\n"}]},"isError":false}';
const piMessageEnd =
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"echo hi"}}],"stopReason":"toolUse"}}';
const ompStart =
  '{"type":"tool_execution_start","toolCallId":"call_2","toolName":"read","args":{"path":"a.txt"},"streamIndex":0}';

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

describe("piJsonToolCalls (pi, oh-my-pi)", () => {
  it("returns the tool and its args from a tool_execution_start event", () => {
    expect(piJsonToolCalls(piStart)).toEqual([{ name: "bash", input: { command: "echo hi" } }]);
    expect(piJsonToolCalls(ompStart)).toEqual([{ name: "read", input: { path: "a.txt" } }]);
    expect(piJsonToolCalls('{"type":"tool_execution_start","toolName":"ls"}')).toEqual([{ name: "ls", input: {} }]);
  });
  it("ignores the end event, the assistant message, a start without a tool name and non-JSON lines", () => {
    expect(piJsonToolCalls(piEnd)).toEqual([]);
    expect(piJsonToolCalls(piMessageEnd)).toEqual([]);
    expect(piJsonToolCalls('{"type":"tool_execution_start","args":{}}')).toEqual([]);
    expect(piJsonToolCalls("not json")).toEqual([]);
  });
});

describe("copilotToolCalls", () => {
  const start = JSON.stringify({
    type: "tool.execution_start",
    data: { toolCallId: "call_1", toolName: "bash", arguments: { command: "ls" } },
  });
  it("returns the tool and its arguments from a tool.execution_start event", () => {
    expect(copilotToolCalls(start)).toEqual([{ name: "bash", input: { command: "ls" } }]);
    expect(copilotToolCalls('{"type":"tool.execution_start","data":{"toolName":"view"}}')).toEqual([
      { name: "view", input: {} },
    ]);
  });
  it("ignores the complete event, the assistant message, a start without a tool name and non-JSON lines", () => {
    const complete = JSON.stringify({
      type: "tool.execution_complete",
      data: { toolCallId: "call_1", success: true, result: { content: "a\n" } },
    });
    const message = JSON.stringify({
      type: "assistant.message",
      data: { content: "Let me look.", toolRequests: [{ toolCallId: "call_1", name: "bash", arguments: { command: "ls" } }] },
    });
    expect(copilotToolCalls(complete)).toEqual([]);
    expect(copilotToolCalls(message)).toEqual([]);
    expect(copilotToolCalls('{"type":"tool.execution_start","data":{}}')).toEqual([]);
    expect(copilotToolCalls("not json")).toEqual([]);
  });
});
