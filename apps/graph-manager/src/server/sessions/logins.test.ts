import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startFakeForge, type FakeForge } from "../../../scripts/fake-forge.mjs";
import { createUser, hashPassword } from "../accounts.js";
import type { AppContext } from "../app.js";
import type { Db } from "../db/db.js";
import type { WorkspaceHost } from "../host/types.js";
import { ADMIN_USER } from "../identity.js";
import { appWithLogin, loginAs } from "../test-helpers.js";
import { agentKeyNames, providerOf } from "./logins.js";
import type { SessionProvisioner } from "./provisioner.js";

let forge: FakeForge;
let app: FastifyInstance;
let cookie: string;
let db: Db;
let ctx: AppContext;
let cleanup: (() => Promise<void>) | undefined;

/** The fake session home of the provisioner's hosts, and every `put` they received. */
let home: Map<string, string>;
let puts: Array<{ providers: string[]; files: Record<string, string> }>;

beforeAll(async () => {
  forge = await startFakeForge();
});

afterAll(async () => {
  await forge.close();
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** A host that is the local host except for `loginFiles`, which reads and writes `home`. */
function fakeHomeHost(local: WorkspaceHost): WorkspaceHost {
  const loginFiles = async (op: "get" | "put", _providers: string[], files?: Record<string, string>): Promise<Record<string, string>> => {
    if (op === "get") return Object.fromEntries(home);
    puts.push({ providers: _providers, files: { ...files } });
    for (const [k, v] of Object.entries(files ?? {})) home.set(k, v);
    return {};
  };
  return new Proxy(local, {
    get(target, prop, receiver) {
      if (prop === "loginFiles") return loginFiles;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

async function start(fakeHome = false): Promise<void> {
  home = new Map();
  puts = [];
  const provisioner: SessionProvisioner = {
    acquire: async () => fakeHomeHost(ctx.localHost),
    release: async () => undefined,
    acquireRun: async () => {
      throw new Error("no run containers");
    },
    releaseRun: async () => undefined,
  };
  const res = await appWithLogin(
    { githubApiUrl: `${forge.url}/github` },
    { sessions: { pollMs: 20, liveRuns: async () => 0 }, onContext: (c) => (ctx = c), ...(fakeHome ? { provisioner } : {}) },
  );
  ({ app, cookie, db, cleanup } = res);
  expect((await req("PUT", "/api/forges/github", { token: "gh-good" })).statusCode).toBe(200);
}

type Method = "GET" | "POST" | "PUT" | "DELETE";
const req = (method: Method, url: string, payload?: object, c = cookie) => app.inject({ method, url, payload, headers: { cookie: c } });

const HELLO = { forge: "github", owner: "octo", name: "hello" } as const;

async function secondUser(): Promise<string> {
  await createUser(db, { username: "bob", displayName: "Bob", passwordHash: await hashPassword("bob-password-1") });
  return loginAs(app, "bob", "bob-password-1");
}

/** Runs `echo` of `$name` in terminal `id` and returns what it printed between two markers. */
async function echoVar(id: string, name: string, c = cookie): Promise<string> {
  if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${id}/ws`, { headers: { cookie: c } });
  let out = "";
  const re = /<<v:([^>\r\n]*)>>/;
  const got = new Promise<string>((resolve, reject) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; data?: string };
      if (msg.type !== "data") return;
      out += msg.data ?? "";
      const m = re.exec(out);
      if (m) resolve(m[1] ?? "");
    });
    ws.on("error", reject);
  });
  await new Promise<void>((resolve) => ws.on("open", () => resolve()));
  // The markers are split in the command so the echoed input never matches.
  ws.send(JSON.stringify({ type: "input", data: `echo "<<""v:$${name}>>"\r` }));
  try {
    return await got;
  } finally {
    ws.close();
  }
}

describe("agent key names and login files", () => {
  it("lists every LOGIN_KEYS name once with its providers", () => {
    expect(agentKeyNames()).toEqual([
      { name: "ANTHROPIC_API_KEY", providers: ["claude", "opencode"] },
      { name: "CLAUDE_CODE_OAUTH_TOKEN", providers: ["claude"] },
      { name: "OPENAI_API_KEY", providers: ["codex", "opencode", "qwen"] },
    ]);
  });

  it("maps a path to the provider of its LOGIN_FILES entry", () => {
    expect(providerOf(".claude/.credentials.json")).toBe("claude");
    expect(providerOf(".claude.json")).toBe("claude");
    expect(providerOf(".codex/auth.json")).toBe("codex");
    expect(providerOf(".config/opencode/opencode.json")).toBe("opencode");
    expect(providerOf(".config/opencode/sub/x.json")).toBe("opencode");
    expect(providerOf(".config/opencode/")).toBeUndefined();
    expect(providerOf(".config/opencode/../../.ssh/id_rsa")).toBeUndefined();
    expect(providerOf(".ssh/id_rsa")).toBeUndefined();
    expect(providerOf(".claude/settings.json")).toBeUndefined();
  });
});

describe("agent keys API", () => {
  it("lists, saves and removes keys without ever returning a value", async () => {
    await start();
    const list = await req("GET", "/api/settings/agent-keys");
    expect(list.json()).toEqual({
      keys: [
        { name: "ANTHROPIC_API_KEY", providers: ["claude", "opencode"], saved: false },
        { name: "CLAUDE_CODE_OAUTH_TOKEN", providers: ["claude"], saved: false },
        { name: "OPENAI_API_KEY", providers: ["codex", "opencode", "qwen"], saved: false },
      ],
    });
    const put = await req("PUT", "/api/settings/agent-keys/ANTHROPIC_API_KEY", { value: "  sk-test  " });
    expect(put.statusCode).toBe(204);
    expect(put.body).not.toContain("sk-test");
    const after = await req("GET", "/api/settings/agent-keys");
    expect(after.body).not.toContain("sk-test");
    expect(after.json().keys[0]).toEqual({ name: "ANTHROPIC_API_KEY", providers: ["claude", "opencode"], saved: true });
    expect((await ctx.store.forUser(ADMIN_USER)).get().agentKeys).toEqual({ ANTHROPIC_API_KEY: "sk-test" });

    const del = await req("DELETE", "/api/settings/agent-keys/ANTHROPIC_API_KEY");
    expect(del.statusCode).toBe(204);
    expect((await req("GET", "/api/settings/agent-keys")).json().keys[0].saved).toBe(false);
  });

  it("rejects a name not in LOGIN_KEYS and a bad value without echoing it", async () => {
    await start();
    const bad = await req("PUT", "/api/settings/agent-keys/PATH", { value: "x" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "PATH is not an agent login key" });
    expect((await req("PUT", "/api/settings/agent-keys/PATH", {})).json()).toEqual({ error: "PATH is not an agent login key" });
    expect((await req("DELETE", "/api/settings/agent-keys/PATH")).json()).toEqual({ error: "PATH is not an agent login key" });
    const empty = await req("PUT", "/api/settings/agent-keys/OPENAI_API_KEY", { value: "   " });
    expect(empty.statusCode).toBe(400);
    const long = await req("PUT", "/api/settings/agent-keys/OPENAI_API_KEY", { value: "s".repeat(4097) });
    expect(long.statusCode).toBe(400);
    expect(long.body).not.toContain("ssss");
  });
});

describe.skipIf(process.platform === "win32")("agent keys in terminals", () => {
  it("adds the user's keys to new session and plain terminals, not to another user's", async () => {
    await start();
    expect((await req("PUT", "/api/settings/agent-keys/ANTHROPIC_API_KEY", { value: "sk-test" })).statusCode).toBe(204);
    const s = await req("POST", "/api/sessions", { repo: HELLO });
    expect(s.statusCode, s.body).toBe(201);
    expect(await echoVar(s.json<{ terminalId: string }>().terminalId, "ANTHROPIC_API_KEY")).toBe("sk-test");

    const plain = await req("POST", "/api/terminals", {});
    expect(plain.statusCode).toBe(201);
    expect(await echoVar(plain.json<{ id: string }>().id, "ANTHROPIC_API_KEY")).toBe("sk-test");

    const bob = await secondUser();
    const theirs = await req("POST", "/api/terminals", {}, bob);
    expect(theirs.statusCode).toBe(201);
    expect(await echoVar(theirs.json<{ id: string }>().id, "ANTHROPIC_API_KEY", bob)).toBe(process.env.ANTHROPIC_API_KEY ?? "");
  });
});

describe.skipIf(process.platform === "win32")("login files across sessions", () => {
  const CRED = Buffer.from('{"token":"t"}').toString("base64");

  async function openAndEnd(): Promise<void> {
    const s = await req("POST", "/api/sessions", { repo: HELLO });
    expect(s.statusCode, s.body).toBe(201);
    const del = await req("DELETE", `/api/sessions/${s.json<{ sessionId: string }>().sessionId}`);
    expect(del.statusCode, del.body).toBeLessThan(300);
    await ctx.sessions.settled();
  }

  it("saves the login files when a session ends and puts them into the next session's host", async () => {
    await start(true);
    await openAndEnd();
    expect(puts).toEqual([]);
    expect((await ctx.store.forUser(ADMIN_USER)).get().agentLogins).toEqual({});

    home.set(".claude/.credentials.json", CRED);
    home.set(".ssh/id_rsa", Buffer.from("secret").toString("base64"));
    home.set(".codex/auth.json", Buffer.alloc(300 * 1024).toString("base64"));
    await openAndEnd();
    expect((await ctx.store.forUser(ADMIN_USER)).get().agentLogins).toEqual({ ".claude/.credentials.json": CRED });

    home.clear();
    await openAndEnd();
    expect(puts).toEqual([{ providers: ["claude"], files: { ".claude/.credentials.json": CRED } }]);
  });

  it("does not put a provider's files when the user saved one of its keys", async () => {
    await start(true);
    home.set(".claude/.credentials.json", CRED);
    await openAndEnd();
    expect(puts).toEqual([]);
    expect((await req("PUT", "/api/settings/agent-keys/ANTHROPIC_API_KEY", { value: "sk-test" })).statusCode).toBe(204);
    await openAndEnd();
    expect(puts).toEqual([]);
  });
});
