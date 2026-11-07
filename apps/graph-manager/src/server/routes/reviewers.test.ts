import { readFile, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { BUILTIN_INSTRUCTIONS, BUILTIN_REVIEWERS, type Reviewer } from "graph-execution/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { reviewersFilePath } from "../reviewers.js";
import { DataStore } from "../store.js";
import { appWithLogin } from "../test-helpers.js";

let app: FastifyInstance;
let cookie: string;
let config: Config;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ app, cookie, config, cleanup } = await appWithLogin());
});

afterEach(async () => {
  await cleanup();
});

const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
const fileList = async (): Promise<Reviewer[]> => (JSON.parse(await readFile(reviewersFilePath(config.dataDir), "utf8")) as { reviewers: Reviewer[] }).reviewers;
const SECURITY = { id: "security", type: "diff", name: "Security", instructions: "Check auth", provider: "claude" };

describe("reviewer routes", () => {
  it("need a login", async () => {
    expect((await app.inject({ url: "/api/reviewers" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/reviewers", payload: SECURITY })).statusCode).toBe(401);
  });

  it("start with the built-ins and write reviewers.json with mode 600", async () => {
    const res = await req("GET", "/api/reviewers");
    expect(res.statusCode).toBe(200);
    const body = res.json<{ reviewers: Reviewer[]; builtinIds: string[]; providers: string[]; file: string }>();
    expect(body.reviewers).toEqual(BUILTIN_REVIEWERS);
    expect(body.builtinIds).toEqual(["code", "tester"]);
    expect(body.providers).toContain("claude");
    expect(body.file).toBe(reviewersFilePath(config.dataDir));
    if (process.platform !== "win32") expect((await stat(body.file)).mode & 0o777).toBe(0o600);
    expect(await fileList()).toEqual(BUILTIN_REVIEWERS);
  });

  it("add a reviewer with defaults", async () => {
    const res = await req("POST", "/api/reviewers", SECURITY);
    expect(res.statusCode).toBe(201);
    expect(res.json<{ reviewer: Reviewer }>().reviewer).toEqual({ ...SECURITY, enabled: true, repoFile: "SECURITY_REVIEW.md", blockAt: "major" });
    expect((await fileList()).map((r) => r.id)).toEqual(["code", "tester", "security"]);
  });

  it.each([
    ["a duplicate id", { ...BUILTIN_REVIEWERS[0], repoFile: "OTHER.md" }, 'id: duplicate reviewer id "code"'],
    ["a second tester", { id: "qa", type: "tester", name: "QA" }, "type: "],
    ["a repoFile outside the repo root", { ...SECURITY, repoFile: "../x.md" }, "repoFile: "],
    ["a repoFile already used", { ...SECURITY, repoFile: "REVIEW.md" }, 'repoFile: "REVIEW.md" is already used by reviewer "code"'],
    ["an invalid glob", { ...SECURITY, files: ["src/[a].ts"] }, 'invalid glob "src/[a].ts"'],
    ["an unknown provider", { ...SECURITY, provider: "nope" }, "provider: "],
    ["an unknown key", { ...SECURITY, colour: "red" }, "colour"],
  ])("reject %s with 400", async (_what, payload, error) => {
    const res = await req("POST", "/api/reviewers", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain(error);
    expect((await fileList()).map((r) => r.id)).toEqual(["code", "tester"]);
  });

  it("edit and disable a reviewer in place", async () => {
    await req("POST", "/api/reviewers", SECURITY);
    await req("POST", "/api/reviewers", { id: "docs", type: "diff", name: "Docs" });
    const created = (await req("GET", "/api/reviewers")).json<{ reviewers: Reviewer[] }>().reviewers[2]!;
    const res = await req("PUT", "/api/reviewers/security", { ...created, enabled: false, name: "Sec" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ reviewer: Reviewer }>().reviewer).toMatchObject({ id: "security", enabled: false, name: "Sec" });
    expect((await fileList()).map((r) => r.id)).toEqual(["code", "tester", "docs"]);
    const list = (await req("GET", "/api/reviewers")).json<{ reviewers: Reviewer[] }>().reviewers;
    expect(list.map((r) => r.id)).toEqual(["code", "tester", "security", "docs"]);

    const renamed = await req("PUT", "/api/reviewers/security", { ...created, id: "sec" });
    expect(renamed.statusCode).toBe(400);
    expect(renamed.json()).toEqual({ error: "id: cannot be changed" });
    const partial = await req("PUT", "/api/reviewers/security", { enabled: false });
    expect(partial.statusCode).toBe(400);
    expect(partial.json()).toEqual({ error: "the body must be the whole reviewer (id missing)" });
    const unknown = await req("PUT", "/api/reviewers/nope", { ...created, id: "nope" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "unknown reviewer" });
    const testerType = await req("PUT", "/api/reviewers/tester", { ...BUILTIN_REVIEWERS[1], type: "diff" });
    expect(testerType.statusCode).toBe(400);
  });

  it("delete, reset and survive a restart", async () => {
    await req("POST", "/api/reviewers", SECURITY);
    const tester = await req("DELETE", "/api/reviewers/tester");
    expect(tester.statusCode).toBe(400);
    expect(tester.json()).toEqual({ error: "the live tester can be disabled, not deleted" });
    expect((await req("DELETE", "/api/reviewers/nope")).statusCode).toBe(404);
    expect((await req("DELETE", "/api/reviewers/code")).statusCode).toBe(204);
    expect((await fileList()).map((r) => r.id)).toEqual(["tester", "security"]);

    const reset = await req("POST", "/api/reviewers/reset/code");
    expect(reset.statusCode).toBe(200);
    expect(reset.json<{ reviewer: Reviewer }>().reviewer).toEqual(BUILTIN_REVIEWERS[0]);
    expect((await fileList()).map((r) => r.id)).toEqual(["code", "tester", "security"]);

    await req("PUT", "/api/reviewers/tester", { ...BUILTIN_REVIEWERS[1], instructions: "custom" });
    const resetTester = await req("POST", "/api/reviewers/reset/tester");
    expect(resetTester.json<{ reviewer: Reviewer }>().reviewer.instructions).toBe(BUILTIN_INSTRUCTIONS.tester);

    const other = await req("POST", "/api/reviewers/reset/security");
    expect(other.statusCode).toBe(400);
    expect(other.json()).toEqual({ error: "only code and tester have built-in instructions" });

    const again = await DataStore.open(config.dataDir);
    expect(again.reviewers().map((r) => r.id)).toEqual(["code", "tester", "security"]);
    expect(again.reviewers()).toEqual(await fileList());
  });
});
