// `graph-manager-mcp`: the MCP server (stdio) of graph-manager's tools for agents in its terminals. It lists and calls
// the tools through graph-manager's internal API (GM_INTERNAL_URL, GM_INTERNAL_TOKEN) for its terminal (GM_TERMINAL_ID).
// Dependency-free on purpose (only `node:` imports): it starts fast and works from dist/server alone.
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type Json = Record<string, unknown>;

export interface McpEnv {
  GM_INTERNAL_URL?: string;
  GM_INTERNAL_TOKEN?: string;
  GM_TERMINAL_ID?: string;
}

const NOT_IN_TERMINAL = "graph-manager tools work only in a graph-manager terminal";
const DEFAULT_PROTOCOL = "2025-06-18";

function log(s: string): void {
  process.stderr.write(`graph-manager-mcp: ${s}\n`);
}

function connection(env: McpEnv): { url: string; token: string; terminalId: string } | undefined {
  const { GM_INTERNAL_URL: url, GM_INTERNAL_TOKEN: token, GM_TERMINAL_ID: terminalId } = env;
  if (!url || !token || !terminalId) return undefined;
  return { url: url.replace(/\/+$/, ""), token, terminalId };
}

function networkMessage(e: unknown): string {
  return (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message ?? String(e);
}

async function bodyOf(res: Response): Promise<Json> {
  try {
    const b = (await res.json()) as unknown;
    return b && typeof b === "object" ? (b as Json) : {};
  } catch {
    return {};
  }
}

async function listTools(env: McpEnv, fetchFn: typeof fetch): Promise<unknown[]> {
  const c = connection(env);
  if (!c) {
    log(`no tools: ${NOT_IN_TERMINAL}`);
    return [];
  }
  try {
    const res = await fetchFn(`${c.url}/api/internal/tools`, { headers: { authorization: `Bearer ${c.token}` } });
    const body = await bodyOf(res);
    if (!res.ok) {
      log(`no tools: ${typeof body.error === "string" ? body.error : `graph-manager answered ${res.status}`}`);
      return [];
    }
    return Array.isArray(body.tools) ? body.tools : [];
  } catch (e) {
    log(`no tools: graph-manager did not answer at ${c.url}: ${networkMessage(e)}`);
    return [];
  }
}

async function callTool(params: Json, env: McpEnv, cwd: string, fetchFn: typeof fetch): Promise<{ text: string; isError: boolean }> {
  const c = connection(env);
  if (!c) return { text: NOT_IN_TERMINAL, isError: true };
  const name = String(params.name ?? "");
  let res: Response;
  try {
    res = await fetchFn(`${c.url}/api/internal/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ terminalId: c.terminalId, cwd, input: params.arguments ?? {} }),
    });
  } catch (e) {
    return { text: `graph-manager did not answer at ${c.url}: ${networkMessage(e)}`, isError: true };
  }
  const body = await bodyOf(res);
  if (!res.ok) return { text: typeof body.error === "string" ? body.error : `graph-manager answered ${res.status}`, isError: true };
  return { text: typeof body.text === "string" ? body.text : "", isError: body.isError === true };
}

/** One JSON-RPC message in, the response out (undefined for notifications). */
export async function handleMessage(msg: Json, env: McpEnv, cwd: string, fetchFn: typeof fetch): Promise<Json | undefined> {
  if (msg.id === undefined || msg.id === null) return undefined;
  const id = msg.id;
  const method = typeof msg.method === "string" ? msg.method : "";
  const params = msg.params && typeof msg.params === "object" ? (msg.params as Json) : {};
  const result = (r: unknown): Json => ({ jsonrpc: "2.0", id, result: r });
  switch (method) {
    case "initialize":
      return result({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "graph-manager", version: "0.1.0" },
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: await listTools(env, fetchFn) });
    case "tools/call": {
      const r = await callTool(params, env, cwd, fetchFn);
      return result({ content: [{ type: "text", text: r.text }], isError: r.isError });
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

async function main(): Promise<void> {
  const env: McpEnv = process.env;
  const cwd = process.cwd();
  const pending = new Set<Promise<void>>();
  const send = (r: Json) => process.stdout.write(`${JSON.stringify(r)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
      continue;
    }
    const p = handleMessage(msg as Json, env, cwd, globalThis.fetch)
      .then((r) => {
        if (r) send(r);
      })
      .catch((e: unknown) => {
        log(`error: ${(e as Error).message}`);
        const id = (msg as Json).id;
        if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code: -32603, message: (e as Error).message } });
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
