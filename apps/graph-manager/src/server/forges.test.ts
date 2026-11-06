import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../scripts/fake-forge.mjs";
import { ForgeError, forgeClient, gitAuthArgs, gitlabApiUrl } from "./forges.js";

let forge: FakeForge;

beforeAll(async () => {
  forge = await startFakeForge();
});

afterAll(async () => {
  await forge.close();
});

const gh = (token = "gh-good") => forgeClient({ kind: "github", token, apiUrl: `${forge.url}/github` });
const gl = (token = "gl-good") => forgeClient({ kind: "gitlab", token, apiUrl: gitlabApiUrl(`${forge.url}/gitlab`) });

describe("github client", () => {
  it("verifies a token", async () => {
    expect(await gh().verify()).toEqual({ login: "octo" });
  });

  it("throws ForgeError(401) with the forge's message for a bad token, without the token", async () => {
    const err = await gh("bad-secret").verify().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).status).toBe(401);
    expect((err as ForgeError).message).toBe("GitHub 401: Bad credentials");
    expect((err as ForgeError).message).not.toContain("bad-secret");
  });

  it("lists and gets repos", async () => {
    const repos = await gh().listRepos();
    const hello = repos.find((r) => r.fullPath === "octo/hello");
    expect(hello).toMatchObject({ name: "hello", defaultBranch: "main", private: true });
    expect(hello?.cloneUrl).toMatch(/^file:\/\/.*octo\/hello\.git$/);
    expect(await gh().listRepos("nomatch")).toEqual([]);
    expect((await gh().getRepo("octo/hello")).fullPath).toBe("octo/hello");
    await expect(gh().getRepo("octo/missing")).rejects.toMatchObject({ status: 404 });
  });

  it("creates a pull request and rejects a missing head branch", async () => {
    const pr = await gh().createPullRequest({ fullPath: "octo/hello", head: "main", base: "main", title: "T", body: "B" });
    expect(pr.number).toBeGreaterThan(0);
    expect(pr.url).toContain("/pull/");
    expect(forge.pulls).toContainEqual({ forge: "github", fullPath: "octo/hello", head: "main", base: "main", title: "T", body: "B" });
    await expect(gh().createPullRequest({ fullPath: "octo/hello", head: "nope", base: "main", title: "T", body: "B" })).rejects.toMatchObject({ status: 422 });
  });
});

describe("gitlab client", () => {
  it("verifies a token", async () => {
    expect(await gl().verify()).toEqual({ login: "gitlab-user" });
    await expect(gl("bad").verify()).rejects.toMatchObject({ status: 401 });
  });

  it("lists, searches and gets projects", async () => {
    const repos = await gl().listRepos();
    const proj = repos.find((r) => r.fullPath === "grp/sub/proj");
    expect(proj?.cloneUrl).toMatch(/^file:\/\/.*grp\/sub\/proj\.git$/);
    expect((await gl().listRepos("proj")).map((r) => r.fullPath)).toContain("grp/sub/proj");
    expect(await gl().listRepos("zzz")).toEqual([]);
    expect((await gl().getRepo("grp/sub/proj")).name).toBe("proj");
  });

  it("creates a merge request", async () => {
    const pr = await gl().createPullRequest({ fullPath: "grp/sub/proj", head: "main", base: "main", title: "MR", body: "D" });
    expect(pr.url).toContain("/merge_requests/");
    expect(forge.pulls).toContainEqual({ forge: "gitlab", fullPath: "grp/sub/proj", head: "main", base: "main", title: "MR", body: "D" });
    const res = await fetch(`${forge.url}/__fake/pulls`);
    expect(((await res.json()) as unknown[]).length).toBe(forge.pulls.length);
  });
});

describe("network errors", () => {
  it("throw ForgeError(502)", async () => {
    const c = forgeClient({ kind: "github", token: "t0k3n", apiUrl: "http://127.0.0.1:1" });
    const err = await c.verify().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).status).toBe(502);
    expect((err as ForgeError).message).not.toContain("t0k3n");
  });
});

describe("gitAuthArgs", () => {
  it("builds a Basic auth header", () => {
    expect(gitAuthArgs("github", "t")).toEqual(["-c", "http.extraHeader=Authorization: Basic eC1hY2Nlc3MtdG9rZW46dA=="]);
    expect(gitAuthArgs("gitlab", "t")[1]).toBe(`http.extraHeader=Authorization: Basic ${Buffer.from("oauth2:t").toString("base64")}`);
  });
});
