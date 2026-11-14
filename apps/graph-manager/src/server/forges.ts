import type { AppContext } from "./app.js";
import type { UserStore } from "./store.js";

export type ForgeKind = "github" | "gitlab";

export interface ForgeRepo {
  fullPath: string;
  name: string;
  defaultBranch: string;
  cloneUrl: string;
  private: boolean;
  webUrl: string;
}

/** How to reach a forge. `apiUrl` is `config.githubApiUrl` for GitHub and `${baseUrl}/api/v4` for GitLab. */
export interface ForgeConn {
  kind: ForgeKind;
  token: string;
  apiUrl: string;
}

export interface PullRequest {
  url: string;
  number: number;
}

export interface ForgeClient {
  /** The token's user: GitHub `login`, GitLab `username`. */
  verify(): Promise<{ login: string }>;
  /** The first 100 repos the user can access, most recently pushed/active first. */
  listRepos(query?: string): Promise<ForgeRepo[]>;
  getRepo(fullPath: string): Promise<ForgeRepo>;
  createPullRequest(p: { fullPath: string; head: string; base: string; title: string; body: string }): Promise<PullRequest>;
  /** Replaces the body (GitLab: description) of an open PR/MR. */
  updatePullRequest(p: { fullPath: string; number: number; body: string }): Promise<void>;
}

/** A failed forge call. `status` is the forge's HTTP status, or 502 when the forge could not be reached. The message never holds the token. */
export class ForgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ForgeError";
  }
}

export const FORGE_NAMES: Record<ForgeKind, string> = { github: "GitHub", gitlab: "GitLab" };

/** git `-c` args that authenticate HTTPS clones and pushes with the token, without putting it into the remote URL. */
export function gitAuthArgs(kind: ForgeKind, token: string): string[] {
  const user = kind === "github" ? "x-access-token" : "oauth2";
  const b64 = Buffer.from(`${user}:${token}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${b64}`];
}

function redact(text: string, token: string): string {
  return token === "" ? text : text.split(token).join("***");
}

function messageOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" && body.trim() !== "" ? body.trim().slice(0, 300) : undefined;
  const b = body as Record<string, unknown>;
  for (const key of ["message", "error_description", "error"]) {
    const v = b[key];
    if (typeof v === "string" && v !== "") return v;
    if (Array.isArray(v) && v.length > 0) return v.map(String).join(", ");
    if (v && typeof v === "object") return JSON.stringify(v);
  }
  return undefined;
}

async function call<T>(conn: ForgeConn, method: string, path: string, body?: unknown): Promise<T> {
  const name = FORGE_NAMES[conn.kind];
  const headers: Record<string, string> =
    conn.kind === "github"
      ? { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
      : { "PRIVATE-TOKEN": conn.token, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${conn.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    throw new ForgeError(502, redact(`${name} unreachable: ${cause ?? (err as Error).message}`, conn.token));
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg = messageOf(parsed) ?? (res.statusText || "request failed");
    throw new ForgeError(res.status, redact(`${name} ${res.status}: ${msg}`, conn.token));
  }
  return parsed as T;
}

interface GithubRepo {
  full_name: string;
  name: string;
  default_branch: string;
  clone_url: string;
  private: boolean;
  html_url: string;
}

interface GitlabProject {
  id: number;
  path_with_namespace: string;
  name: string;
  path?: string;
  default_branch: string | null;
  http_url_to_repo: string;
  visibility?: string;
  web_url: string;
}

function fromGithub(r: GithubRepo): ForgeRepo {
  return { fullPath: r.full_name, name: r.name, defaultBranch: r.default_branch, cloneUrl: r.clone_url, private: r.private, webUrl: r.html_url };
}

function fromGitlab(p: GitlabProject): ForgeRepo {
  return {
    fullPath: p.path_with_namespace,
    name: p.name,
    defaultBranch: p.default_branch ?? "main",
    cloneUrl: p.http_url_to_repo,
    private: p.visibility !== "public",
    webUrl: p.web_url,
  };
}

function githubRepoPath(fullPath: string): string {
  return fullPath
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function githubClient(conn: ForgeConn): ForgeClient {
  return {
    async verify() {
      const u = await call<{ login: string }>(conn, "GET", "/user");
      return { login: u.login };
    },
    async listRepos(query) {
      const repos = await call<GithubRepo[]>(conn, "GET", "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
      const all = repos.map(fromGithub);
      const q = query?.trim().toLowerCase();
      return q ? all.filter((r) => r.fullPath.toLowerCase().includes(q)) : all;
    },
    async getRepo(fullPath) {
      return fromGithub(await call<GithubRepo>(conn, "GET", `/repos/${githubRepoPath(fullPath)}`));
    },
    async createPullRequest(p) {
      const pr = await call<{ html_url: string; number: number }>(conn, "POST", `/repos/${githubRepoPath(p.fullPath)}/pulls`, {
        title: p.title,
        head: p.head,
        base: p.base,
        body: p.body,
      });
      return { url: pr.html_url, number: pr.number };
    },
    async updatePullRequest(p) {
      await call<unknown>(conn, "PATCH", `/repos/${githubRepoPath(p.fullPath)}/pulls/${p.number}`, { body: p.body });
    },
  };
}

function gitlabClient(conn: ForgeConn): ForgeClient {
  return {
    async verify() {
      const u = await call<{ username: string }>(conn, "GET", "/user");
      return { login: u.username };
    },
    async listRepos(query) {
      const q = query?.trim();
      const search = q ? `&search=${encodeURIComponent(q)}` : "";
      const projects = await call<GitlabProject[]>(conn, "GET", `/projects?membership=true&per_page=100&order_by=last_activity_at&simple=true${search}`);
      return projects.map(fromGitlab);
    },
    async getRepo(fullPath) {
      return fromGitlab(await call<GitlabProject>(conn, "GET", `/projects/${encodeURIComponent(fullPath)}`));
    },
    async createPullRequest(p) {
      const project = await call<GitlabProject>(conn, "GET", `/projects/${encodeURIComponent(p.fullPath)}`);
      const mr = await call<{ web_url: string; iid: number }>(conn, "POST", `/projects/${project.id}/merge_requests`, {
        source_branch: p.head,
        target_branch: p.base,
        title: p.title,
        description: p.body,
      });
      return { url: mr.web_url, number: mr.iid };
    },
    async updatePullRequest(p) {
      const project = await call<GitlabProject>(conn, "GET", `/projects/${encodeURIComponent(p.fullPath)}`);
      await call<unknown>(conn, "PUT", `/projects/${project.id}/merge_requests/${p.number}`, { description: p.body });
    },
  };
}

export function forgeClient(conn: ForgeConn): ForgeClient {
  return conn.kind === "github" ? githubClient(conn) : gitlabClient(conn);
}

/** The GitLab REST base for a GitLab base URL. */
export function gitlabApiUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v4`;
}

/** The saved connection for `kind`, or undefined when it is not connected. */
export function connFor(ctx: AppContext, us: UserStore, kind: ForgeKind): ForgeConn | undefined {
  const forges = us.get().forges;
  if (kind === "github") {
    const gh = forges.github;
    return gh ? { kind, token: gh.token, apiUrl: ctx.config.githubApiUrl } : undefined;
  }
  const gl = forges.gitlab;
  return gl ? { kind, token: gl.token, apiUrl: gitlabApiUrl(gl.baseUrl) } : undefined;
}

/** A client for the saved connection. Throws `ForgeError(400)` when `kind` is not connected. */
export function clientFor(ctx: AppContext, us: UserStore, kind: ForgeKind): ForgeClient {
  const conn = connFor(ctx, us, kind);
  if (!conn) throw new ForgeError(400, `${kind} is not connected`);
  return forgeClient(conn);
}
