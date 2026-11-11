/**
 * GitHub Copilot CLI adapter (PRD §6, §9), following the pattern documented in `claude.ts`.
 *
 * Runs `copilot` (npm `@github/copilot`) headless: with no `-p` and piped stdin, it runs one-shot on the prompt sent to
 * stdin (with `-p`, stdin would be ignored). `--allow-all` auto-approves every tool, path and URL (the worktree is the
 * only isolation, PRD §9): without it every shell, edit, path or URL tool is silently denied and the run still exits 0.
 * `--output-format json` prints one JSON event per line. Auto-update is off (`--no-auto-update` and
 * `COPILOT_AUTO_UPDATE=false`).
 * Copilot has no `--no-session`: each run gets a fresh `--session-id`, whose folder under
 * `$COPILOT_HOME/session-state/` (default `~/.copilot`) is removed, best effort, once the process exited.
 * No credentials are read or set: the CLI uses the user's existing login (`copilot login` or `COPILOT_GITHUB_TOKEN`).
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { splitArgs } from "./args.js";
import { spawnAgent } from "./spawn.js";
import { copilotToolCalls } from "./tools.js";
import type { AgentEvent, AgentRun, AgentRunOptions, Provider } from "./types.js";

export const COPILOT_BIN = "copilot";

/** Extra CLI flags appended to every invocation, split with shell-style quoting (see `splitArgs`). */
export const COPILOT_ARGS_ENV = "GRAPH_EXECUTION_COPILOT_ARGS";

export function copilotArgs(
  opts: Pick<AgentRunOptions, "model"> & { sessionId?: string },
  env = process.env,
): string[] {
  const args = ["--output-format", "json", "--allow-all", "--no-auto-update"];
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  const extra = splitArgs(env[COPILOT_ARGS_ENV], COPILOT_ARGS_ENV);
  return [...args, ...extra];
}

/** Where Copilot keeps a session's state: `<COPILOT_HOME or ~/.copilot>/session-state/<id>`. */
export function copilotSessionDir(sessionId: string, env = process.env): string {
  const home = env.COPILOT_HOME || path.join(homedir(), ".copilot");
  return path.join(home, "session-state", sessionId);
}

/**
 * The assistant's text for `assistant.message` events, the message of a `session.error`, "" for the other JSON events
 * (the `assistant.message_delta` events would repeat the text) and the raw line for non-JSON lines. The caller skips "".
 */
export function parseCopilotLine(line: string): string {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return `${line}\n`; // Not JSON (e.g. stderr): pass it through.
  }
  if (typeof msg !== "object" || msg === null) return `${line}\n`;
  const { type, data } = msg as { type?: unknown; data?: { content?: unknown; message?: unknown } };
  if (type === "assistant.message") return typeof data?.content === "string" && data.content ? `${data.content}\n` : "";
  if (type === "session.error") return `copilot: ${String(data?.message ?? "error")}\n`;
  return "";
}

export const copilotProvider: Provider = {
  name: "copilot",
  run(opts: AgentRunOptions): AgentRun {
    const sessionId = randomUUID();
    const agent = spawnAgent(COPILOT_BIN, copilotArgs({ model: opts.model, sessionId }), {
      ...opts,
      input: opts.prompt,
      env: { COPILOT_AUTO_UPDATE: "false" },
    });
    const cleanup = (): Promise<void> =>
      rm(copilotSessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
    const done = agent.exitCode.then(
      async (exitCode) => {
        await cleanup();
        return { exitCode };
      },
      async (err: unknown) => {
        await cleanup();
        throw err;
      },
    );
    // `done` is the source of truth for failures; keep a rejection unhandled-safe for callers that only read events.
    done.catch(() => {});
    async function* events(): AsyncIterable<AgentEvent> {
      try {
        for await (const line of agent.child.iterable({ from: "all" })) {
          if (!line) continue;
          const text = parseCopilotLine(line);
          if (text) yield { type: "output", text };
          for (const call of copilotToolCalls(line)) yield { type: "tool", ...call };
        }
      } catch {
        // Spawn failures surface through `done`.
      }
      yield { type: "exit", code: (await done).exitCode };
    }
    return { events: events(), done };
  },
};
