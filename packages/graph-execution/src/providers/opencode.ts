/**
 * OpenCode CLI adapter (PRD §6, §9), following the pattern documented in `claude.ts`.
 *
 * Runs `opencode run` unattended (`--auto`: auto-approves every permission that is not explicitly denied;
 * the worktree is the only isolation, PRD §9) with `--format json` so text parts can be picked out of the
 * JSONL stream. Without a message argument `opencode run` reads the prompt from stdin, where it is sent.
 * No credentials are read or set: the CLI uses the user's existing login.
 */
import { execaSync } from "execa";
import { splitArgs } from "./args.js";
import { spawnAgent } from "./spawn.js";
import { opencodeToolCalls } from "./tools.js";
import type { AgentEvent, AgentRun, AgentRunOptions, InteractiveCommand, InteractiveOptions, Provider } from "./types.js";

export const OPENCODE_BIN = "opencode";

/** Extra CLI flags appended to every invocation, split with shell-style quoting (see `splitArgs`). */
export const OPENCODE_ARGS_ENV = "GRAPH_EXECUTION_OPENCODE_ARGS";

export function opencodeArgs(opts: Pick<AgentRunOptions, "model">, env = process.env): string[] {
  const args = ["run", "--auto", "--format", "json"];
  if (opts.model) args.push("--model", opts.model);
  const extra = splitArgs(env[OPENCODE_ARGS_ENV], OPENCODE_ARGS_ENV);
  return [...args, ...extra];
}

/**
 * The major version `<bin> --version` prints, or undefined when the CLI does not start, prints no version or takes
 * longer than 10 s (copied from graph-manager's `apps/graph-manager/src/server/agents.ts`). Synchronous: it runs once,
 * when an advisor terminal starts.
 */
export function cliMajor(bin: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  try {
    const res = execaSync(bin, ["--version"], { env, extendEnv: false, reject: false, stdin: "ignore", timeout: 10_000 });
    const m = /(\d+)\.\d+\.\d+/.exec(String(res.stdout ?? ""));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OpenCode's interactive TUI. OpenCode 1 takes the first message with `--prompt`. OpenCode 2 is a client of a shared
 * background service (`--standalone` gives it a private one with this terminal's env, as graph-manager's terminals do)
 * and its prompt option is not known here, so the message is typed into the PTY.
 */
export function opencodeInteractive(o: InteractiveOptions, major: number | undefined = cliMajor(OPENCODE_BIN)): InteractiveCommand {
  const model = o.model ? ["--model", o.model] : [];
  if (major !== undefined && major >= 2) return { file: OPENCODE_BIN, args: ["--standalone", ...model], typeFirstMessage: true };
  return { file: OPENCODE_BIN, args: [...model, "--prompt", o.firstMessage] };
}

/** The text of `text` events, otherwise the raw line. */
export function parseOpencodeLine(line: string): string {
  try {
    const msg = JSON.parse(line) as { type?: unknown; part?: { type?: unknown; text?: unknown } };
    if (msg.type === "text" && msg.part?.type === "text" && typeof msg.part.text === "string") {
      if (msg.part.text) return `${msg.part.text}\n`;
    }
  } catch {
    // Not JSON (e.g. stderr): pass it through.
  }
  return `${line}\n`;
}

export const opencodeProvider: Provider = {
  name: "opencode",
  run(opts: AgentRunOptions): AgentRun {
    const agent = spawnAgent(OPENCODE_BIN, opencodeArgs(opts), { ...opts, input: opts.prompt });
    const done = agent.exitCode.then((exitCode) => ({ exitCode }));
    // `done` is the source of truth for failures; keep a rejection unhandled-safe for callers that only read events.
    done.catch(() => {});
    async function* events(): AsyncIterable<AgentEvent> {
      try {
        for await (const line of agent.child.iterable({ from: "all" })) {
          if (!line) continue;
          yield { type: "output", text: parseOpencodeLine(line) };
          for (const call of opencodeToolCalls(line)) yield { type: "tool", ...call };
        }
      } catch {
        // Spawn failures surface through `done`.
      }
      yield { type: "exit", code: (await done).exitCode };
    }
    return { events: events(), done };
  },
  interactive: (o) => opencodeInteractive(o),
};
