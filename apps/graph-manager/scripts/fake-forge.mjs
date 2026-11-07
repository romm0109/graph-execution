#!/usr/bin/env node
// A fake GitHub + GitLab REST API for tests and the live tester. No real tokens, no network.
//
//   node apps/graph-manager/scripts/fake-forge.mjs [port] [dir]
//
// GitHub is served at <url>/github (GM_GITHUB_API_URL=<url>/github), GitLab at <url>/gitlab/api/v4
// (GitLab base URL <url>/gitlab). Valid tokens: gh-good (login octo), gl-good (username gitlab-user).
// Repos are bare git repos under <dir>, cloned over file://.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const GH_TOKEN = "gh-good";
const GL_TOKEN = "gl-good";
const GH_LOGIN = "octo";
const GL_LOGIN = "gitlab-user";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fake Forge",
      GIT_AUTHOR_EMAIL: "fake@forge.test",
      GIT_COMMITTER_NAME: "Fake Forge",
      GIT_COMMITTER_EMAIL: "fake@forge.test",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).toString();
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Starts the fake forge.
 * @param {{ port?: number, dir?: string }} [opts]
 * @returns {Promise<{ url: string, dir: string, pulls: Array<{forge: string, fullPath: string, head: string, base: string, title: string, body: string}>, addRepo: (fullPath: string, forge?: "github" | "gitlab") => string, close: () => Promise<void> }>}
 */
export async function startFakeForge({ port = 0, dir } = {}) {
  const ownDir = dir === undefined;
  const root = path.resolve(dir ?? mkdtempSync(path.join(os.tmpdir(), "fake-forge-")));
  mkdirSync(root, { recursive: true });
  /** @type {Map<string, {forge: string, id: number, fullPath: string}>} key `${forge}:${fullPath}` */
  const repos = new Map();
  const pulls = [];
  let nextId = 1;
  let url = "";

  const barePath = (fullPath) => path.join(root, `${fullPath}.git`);

  function addRepo(fullPath, forge) {
    const bare = barePath(fullPath);
    if (!existsSync(bare)) {
      mkdirSync(path.dirname(bare), { recursive: true });
      git(["init", "--bare", "-q", "-b", "main", bare]);
      const tmp = mkdtempSync(path.join(os.tmpdir(), "fake-forge-seed-"));
      try {
        git(["clone", "-q", pathToFileURL(bare).href, "seed"], tmp);
        const work = path.join(tmp, "seed");
        git(["checkout", "-q", "-B", "main"], work);
        writeFileSync(path.join(work, "README.md"), `# ${fullPath}\n`);
        git(["add", "README.md"], work);
        git(["commit", "-q", "-m", "Initial commit"], work);
        git(["push", "-q", "origin", "main"], work);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    const kinds = forge ? [forge] : ["github", "gitlab"];
    for (const k of kinds) {
      const key = `${k}:${fullPath}`;
      if (!repos.has(key)) repos.set(key, { forge: k, id: nextId++, fullPath });
    }
    return bare;
  }

  const cloneUrl = (fullPath) => pathToFileURL(barePath(fullPath)).href;
  const name = (fullPath) => fullPath.split("/").pop() ?? fullPath;

  const githubRepo = (r) => ({
    id: r.id,
    full_name: r.fullPath,
    name: name(r.fullPath),
    default_branch: "main",
    clone_url: cloneUrl(r.fullPath),
    private: true,
    html_url: `${url}/web/github/${r.fullPath}`,
  });
  const gitlabProject = (r) => ({
    id: r.id,
    path_with_namespace: r.fullPath,
    name: name(r.fullPath),
    path: name(r.fullPath),
    default_branch: "main",
    http_url_to_repo: cloneUrl(r.fullPath),
    visibility: "private",
    web_url: `${url}/web/gitlab/${r.fullPath}`,
  });

  function headExists(fullPath, head) {
    try {
      git(["rev-parse", "--verify", "-q", `refs/heads/${head}`], barePath(fullPath));
      return true;
    } catch {
      return false;
    }
  }

  function recordPull(forge, fullPath, p) {
    pulls.push({ forge, fullPath, head: p.head, base: p.base, title: p.title, body: p.body });
    return pulls.filter((x) => x.forge === forge).length;
  }

  async function handleGithub(req, res, rest) {
    if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return sendJson(res, 401, { message: "Bad credentials" });
    const u = new URL(rest, "http://x");
    const p = u.pathname;
    if (req.method === "GET" && p === "/user") return sendJson(res, 200, { login: GH_LOGIN, id: 1 });
    if (req.method === "GET" && p === "/user/repos") {
      const list = [...repos.values()].filter((r) => r.forge === "github").reverse().map(githubRepo);
      return sendJson(res, 200, list);
    }
    const pullsMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(p);
    if (req.method === "POST" && pullsMatch) {
      const fullPath = `${decodeURIComponent(pullsMatch[1])}/${decodeURIComponent(pullsMatch[2])}`;
      const repo = repos.get(`github:${fullPath}`);
      if (!repo) return sendJson(res, 404, { message: "Not Found" });
      const body = await readBody(req);
      if (!body.head || !headExists(fullPath, body.head)) {
        return sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] });
      }
      const number = recordPull("github", fullPath, body);
      return sendJson(res, 201, { number, html_url: `${url}/web/github/${fullPath}/pull/${number}` });
    }
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(p);
    if (req.method === "GET" && repoMatch) {
      const repo = repos.get(`github:${decodeURIComponent(repoMatch[1])}/${decodeURIComponent(repoMatch[2])}`);
      return repo ? sendJson(res, 200, githubRepo(repo)) : sendJson(res, 404, { message: "Not Found" });
    }
    return sendJson(res, 404, { message: "Not Found" });
  }

  function findProject(idOrPath) {
    const decoded = decodeURIComponent(idOrPath);
    for (const r of repos.values()) {
      if (r.forge === "gitlab" && (String(r.id) === decoded || r.fullPath === decoded)) return r;
    }
    return undefined;
  }

  async function handleGitlab(req, res, rest) {
    if (req.headers["private-token"] !== GL_TOKEN) return sendJson(res, 401, { message: "401 Unauthorized" });
    const u = new URL(rest, "http://x");
    const p = u.pathname;
    if (req.method === "GET" && p === "/user") return sendJson(res, 200, { username: GL_LOGIN, id: 1 });
    if (req.method === "GET" && p === "/projects") {
      const q = (u.searchParams.get("search") ?? "").toLowerCase();
      const list = [...repos.values()]
        .filter((r) => r.forge === "gitlab" && (q === "" || r.fullPath.toLowerCase().includes(q)))
        .reverse()
        .map(gitlabProject);
      return sendJson(res, 200, list);
    }
    const mrMatch = /^\/projects\/([^/]+)\/merge_requests$/.exec(p);
    if (req.method === "POST" && mrMatch) {
      const repo = findProject(mrMatch[1]);
      if (!repo) return sendJson(res, 404, { message: "404 Project Not Found" });
      const body = await readBody(req);
      if (!body.source_branch || !headExists(repo.fullPath, body.source_branch)) {
        return sendJson(res, 422, { message: ["Source branch does not exist"] });
      }
      const iid = recordPull("gitlab", repo.fullPath, { head: body.source_branch, base: body.target_branch, title: body.title, body: body.description });
      return sendJson(res, 201, { iid, web_url: `${url}/web/gitlab/${repo.fullPath}/-/merge_requests/${iid}` });
    }
    const projMatch = /^\/projects\/([^/]+)$/.exec(p);
    if (req.method === "GET" && projMatch) {
      const repo = findProject(projMatch[1]);
      return repo ? sendJson(res, 200, gitlabProject(repo)) : sendJson(res, 404, { message: "404 Project Not Found" });
    }
    return sendJson(res, 404, { message: "404 Not Found" });
  }

  const server = http.createServer((req, res) => {
    const raw = req.url ?? "/";
    const handle = async () => {
      if (req.method === "GET" && raw.split("?")[0] === "/__fake/pulls") return sendJson(res, 200, pulls);
      if (raw === "/github" || raw.startsWith("/github/") || raw.startsWith("/github?")) return handleGithub(req, res, raw.slice("/github".length) || "/");
      const gl = "/gitlab/api/v4";
      if (raw.startsWith(`${gl}/`) || raw.startsWith(`${gl}?`)) return handleGitlab(req, res, raw.slice(gl.length));
      return sendJson(res, 404, { message: "Not Found" });
    };
    handle().catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { message: String(err && err.message ? err.message : err) });
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;

  addRepo("octo/hello", "github");
  addRepo("grp/sub/proj", "gitlab");

  return {
    url,
    dir: root,
    pulls,
    addRepo,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          if (ownDir) rmSync(root, { recursive: true, force: true });
          resolve(undefined);
        });
      }),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = process.argv[2] ? Number(process.argv[2]) : 0;
  const dir = process.argv[3];
  const forge = await startFakeForge({ port, dir });
  console.log(`fake forge on ${forge.url}`);
  console.log(`  GM_GITHUB_API_URL=${forge.url}/github   (GitHub token: ${GH_TOKEN}, login ${GH_LOGIN})`);
  console.log(`  GitLab base URL: ${forge.url}/gitlab     (GitLab token: ${GL_TOKEN}, username ${GL_LOGIN})`);
  console.log(`  repos in ${forge.dir}; pull requests at ${forge.url}/__fake/pulls`);
  const stop = () => {
    void forge.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
