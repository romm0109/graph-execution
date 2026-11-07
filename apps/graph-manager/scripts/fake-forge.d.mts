export interface FakePull {
  forge: "github" | "gitlab";
  fullPath: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface FakeForge {
  /** `http://127.0.0.1:<port>`; GitHub API at `<url>/github`, GitLab base URL `<url>/gitlab`. */
  url: string;
  /** Where the bare repos live. */
  dir: string;
  pulls: FakePull[];
  /** Creates `<dir>/<fullPath>.git` with one commit on main; registers it on `forge`, or on both when omitted. Returns the bare repo path. */
  addRepo(fullPath: string, forge?: "github" | "gitlab"): string;
  close(): Promise<void>;
}

export function startFakeForge(opts?: { port?: number; dir?: string }): Promise<FakeForge>;
