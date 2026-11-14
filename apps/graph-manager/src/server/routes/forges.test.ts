import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../../scripts/fake-forge.mjs";
import type { UserStore } from "../store.js";
import { appWithLogin } from "../test-helpers.js";

let forge: FakeForge;
let app: FastifyInstance;
let cookie: string;
let store: UserStore;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  forge = await startFakeForge();
});

afterAll(async () => {
  await forge.close();
});

beforeEach(async () => {
  ({ app, cookie, store, cleanup } = await appWithLogin({ githubApiUrl: `${forge.url}/github` }));
});

afterEach(async () => {
  await cleanup();
});

const req = (method: "GET" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });

describe("forge routes", () => {
  it("need a login", async () => {
    expect((await app.inject({ url: "/api/forges" })).statusCode).toBe(401);
  });

  it("start not connected", async () => {
    expect((await req("GET", "/api/forges")).json()).toEqual({ github: { connected: false }, gitlab: { connected: false } });
  });

  it("connect GitHub with a valid token and never return it", async () => {
    const res = await req("PUT", "/api/forges/github", { token: "gh-good" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: true, login: "octo", apiUrl: `${forge.url}/github`, tokenEnd: "good" });
    expect(res.body).not.toContain("gh-good");
    const list = await req("GET", "/api/forges");
    expect(list.json()).toEqual({ github: { connected: true, login: "octo", apiUrl: `${forge.url}/github`, tokenEnd: "good" }, gitlab: { connected: false } });
    expect(list.body).not.toContain("gh-good");
    expect(store.get().forges.github).toEqual({ token: "gh-good", login: "octo" });

    const repos = await req("GET", "/api/forges/github/repos");
    expect(repos.statusCode).toBe(200);
    expect((repos.json() as { repos: { fullPath: string }[] }).repos.map((r) => r.fullPath)).toContain("octo/hello");
    expect(repos.body).not.toContain("gh-good");

    expect((await req("DELETE", "/api/forges/github")).statusCode).toBe(204);
    expect((await req("GET", "/api/forges")).json()).toEqual({ github: { connected: false }, gitlab: { connected: false } });
  });

  it("reject a bad token with 400 and save nothing", async () => {
    const res = await req("PUT", "/api/forges/github", { token: "bad-token" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "GitHub 401: Bad credentials" });
    expect(res.body).not.toContain("bad-token");
    expect((await req("GET", "/api/forges")).json()).toMatchObject({ github: { connected: false } });
    expect(store.get().forges.github).toBeUndefined();
  });

  it("reject an empty token", async () => {
    expect((await req("PUT", "/api/forges/github", { token: "" })).statusCode).toBe(400);
  });

  it("connect GitLab with a base URL", async () => {
    const res = await req("PUT", "/api/forges/gitlab", { token: "gl-good", baseUrl: `${forge.url}/gitlab//` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: true, login: "gitlab-user" });
    const list = await req("GET", "/api/forges");
    expect(list.json()).toEqual({
      github: { connected: false },
      gitlab: { connected: true, login: "gitlab-user", baseUrl: `${forge.url}/gitlab`, apiUrl: `${forge.url}/gitlab`, tokenEnd: "good" },
    });
    expect(list.body).not.toContain("gl-good");
    const repos = await req("GET", "/api/forges/gitlab/repos?q=proj");
    expect((repos.json() as { repos: { fullPath: string }[] }).repos.map((r) => r.fullPath)).toEqual(["grp/sub/proj"]);
    expect((await req("DELETE", "/api/forges/gitlab")).statusCode).toBe(204);
    expect(store.get().forges.gitlab).toBeUndefined();
  });

  it("show only the last 4 characters of a long token, never the token", async () => {
    const token = "ghp_0123456789abcdefa91f";
    await store.update((d) => {
      d.forges.github = { token, login: "octo" };
      d.forges.gitlab = { token: "glpat-zyxwvutsr9876", login: "gl", baseUrl: "https://gitlab.example.com" };
    });
    const list = await req("GET", "/api/forges");
    expect(list.json()).toEqual({
      github: { connected: true, login: "octo", apiUrl: `${forge.url}/github`, tokenEnd: "a91f" },
      gitlab: { connected: true, login: "gl", baseUrl: "https://gitlab.example.com", apiUrl: "https://gitlab.example.com", tokenEnd: "9876" },
    });
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain("glpat-zyxwvutsr9876");
    expect(list.body).not.toContain(token.slice(-5));
  });

  it("give no tokenEnd for a token of 4 characters or fewer", async () => {
    await store.update((d) => {
      d.forges.github = { token: "1234", login: "octo" };
    });
    const gh = (await req("GET", "/api/forges")).json() as { github: Record<string, unknown> };
    expect(gh.github).not.toHaveProperty("tokenEnd");
    expect(JSON.stringify(gh)).not.toContain("1234");
  });

  it("give the last 4 characters of a short token such as the fake forge's gh-good", async () => {
    await store.update((d) => {
      d.forges.github = { token: "gh-good", login: "octo" };
    });
    const gh = (await req("GET", "/api/forges")).json() as { github: Record<string, unknown> };
    expect(gh.github.tokenEnd).toBe("good");
    expect(JSON.stringify(gh)).not.toContain("gh-good");
  });

  it("reject a bad GitLab token and a non-http base URL", async () => {
    const bad = await req("PUT", "/api/forges/gitlab", { token: "nope", baseUrl: `${forge.url}/gitlab` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "GitLab 401: 401 Unauthorized" });
    const ftp = await req("PUT", "/api/forges/gitlab", { token: "gl-good", baseUrl: "ftp://example.com" });
    expect(ftp.statusCode).toBe(400);
    expect(store.get().forges.gitlab).toBeUndefined();
  });

  it("answer 400 for repos when not connected, and for an unknown forge", async () => {
    const res = await req("GET", "/api/forges/github/repos");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "github is not connected" });
    expect((await req("DELETE", "/api/forges/bitbucket")).statusCode).toBe(400);
  });
});
