// The pi extension that graph-manager writes to `<dataDir>/agents/pi-graph-manager.ts` at startup (writePiExtension in
// agents.ts) and that pi terminals load with `pi -e <file>`. pi has no MCP, so the extension is a small MCP client of
// `graph-manager-mcp`: it lists graph-manager's tools and registers each one as a pi tool.
//
// It is a string because it is written to disk and loaded by pi, not by graph-manager. Keep it to `node:` imports and
// to type annotations Node can strip (`node --experimental-strip-types`): pi-extension.test.ts loads the written file
// that way and runs it against graph-manager's real MCP server. No backticks or "${" in it: it is a template literal.

export const PI_EXTENSION_SOURCE = `// graph-manager's tools in pi. Written by graph-manager at startup (apps/graph-manager/src/server/pi-extension.ts);
// edits are overwritten. Load it with: pi -e <this file>
//
// pi has no MCP: this extension starts graph-manager-mcp (on the terminal's PATH), speaks MCP JSON-RPC 2.0 over its
// stdio (one JSON message per line), lists its tools and registers each one as graph-manager_<name>. A tool call is
// sent as tools/call; the child is killed when pi exits. Only node: imports.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const COMMAND = "graph-manager-mcp";
const PREFIX = "graph-manager_";
const PROTOCOL = "2025-06-18";

type Json = Record<string, any>;

/** Starts the MCP server and returns its client once initialized. */
export async function connect(command: string = COMMAND, cwd: string = process.cwd()) {
  const child = spawn(command, [], { stdio: ["pipe", "pipe", "inherit"], env: process.env, cwd, shell: process.platform === "win32" });
  const pending = new Map<number, { resolve: (r: Json) => void; reject: (e: Error) => void }>();
  let next = 1;
  let closed: Error | undefined;
  const fail = (err: Error) => {
    closed = closed ?? err;
    for (const p of pending.values()) p.reject(closed);
    pending.clear();
  };
  child.on("error", (err: Error) => fail(err));
  child.on("exit", (code: number | null) => fail(new Error(COMMAND + " exited (" + code + ")")));
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line: string) => {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(String(msg.error.message ?? "MCP error")));
    else p.resolve(msg.result ?? {});
  });
  const send = (msg: Json) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
  const request = (method: string, params: Json = {}): Promise<Json> =>
    new Promise((resolve, reject) => {
      if (closed) return reject(closed);
      const id = next++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const close = () => {
    if (child.exitCode === null && !child.killed) child.kill();
  };
  process.on("exit", close);
  try {
    await request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "pi-graph-manager", version: "1" } });
    send({ method: "notifications/initialized" });
    const listed = await request("tools/list");
    const tools: Json[] = Array.isArray(listed.tools) ? listed.tools : [];
    return { tools, call: (name: string, args: Json) => request("tools/call", { name, arguments: args }), close };
  } catch (err) {
    close();
    throw err;
  }
}

/** An MCP tools/call result as text: text items as is, other items as JSON; "Error: " first when it failed. */
export function resultText(result: Json): string {
  const items: Json[] = Array.isArray(result.content) ? result.content : [];
  const text = items.map((c) => (c && c.type === "text" ? String(c.text ?? "") : JSON.stringify(c))).join("\\n");
  return result.isError ? "Error: " + text : text;
}

export default async function (pi: any) {
  let client;
  try {
    client = await connect();
  } catch (err) {
    process.stderr.write("pi-graph-manager: graph-manager's tools are not available: " + (err as Error).message + "\\n");
    return;
  }
  const { call } = client;
  for (const tool of client.tools) {
    const name = String(tool.name);
    pi.registerTool({
      name: PREFIX + name,
      label: "graph-manager: " + name,
      description: String(tool.description ?? name),
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      async execute(_id: string, params: Json) {
        let text: string;
        try {
          text = resultText(await call(name, params ?? {}));
        } catch (err) {
          text = "Error: " + (err as Error).message;
        }
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }
}
`;
