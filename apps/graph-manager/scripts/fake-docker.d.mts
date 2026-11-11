export interface FakeMount {
  Type: string;
  Name?: string;
  Source: string;
  Destination: string;
  RW?: boolean;
}

export interface FakeDockerOptions {
  /** Default: `<tmpdir>/fake-docker-<rand>.sock`. A stale socket file is removed first. */
  socketPath?: string;
  /** Run a started container's Cmd as a local process (Linux only). */
  exec?: boolean;
  /** Image names that `GET /images/{name}/json` knows; `POST /images/create` adds one (names with "missing" fail). */
  images?: string[];
  /** Milliseconds `POST /build` waits after the step lines, before the last line, so a build can be seen in progress. */
  buildDelayMs?: number;
  /** What `GET /info` reports as `OSType`; default "linux". "windows" is a Docker Desktop in Windows-containers mode. */
  osType?: string;
  /** graph-manager's own container: `GET /containers/<self.id>/json` answers it. */
  self?: { id: string; name?: string; image?: string; mounts?: FakeMount[]; networks?: string[] };
}

export interface FakeContainer {
  Id: string;
  /** With a leading `/`, like Docker. */
  Name: string;
  Created: string;
  Config: {
    Image: string;
    Hostname: string;
    Labels: Record<string, string>;
    Env: string[];
    Cmd: string[];
    WorkingDir: string;
    User: string;
  };
  HostConfig: Record<string, unknown> & { Mounts?: { Type: string; Source: string; Target: string; ReadOnly?: boolean }[]; AutoRemove?: boolean; NetworkMode?: string };
  NetworkingConfig: Record<string, unknown>;
  State: { Status: "created" | "running" | "exited"; Running: boolean; ExitCode: number };
  Mounts: FakeMount[];
  /** Archives put into the container: the path and the tar's entry names. */
  archives: { path: string; names: string[] }[];
  /** stdout + stderr of the process (exec mode). */
  logs: string;
  /** The container's loopback address `127.0.0.<n>`. */
  ip: string;
  networks: string[];
  /** The fake root dir (exec mode). */
  root?: string;
}

export interface FakeRequest {
  method: string;
  /** Without the `/v1.xx` prefix. */
  path: string;
  query: Record<string, string>;
  /** Parsed JSON, or `{ tarEntries }` for an archive. */
  body: unknown;
}

export interface FakeImage {
  /** `sha256:<64 hex>`; tags of one image share it. */
  Id: string;
  Labels: Record<string, string>;
  Env: string[];
}

export interface FakeBuild {
  tag: string;
  nocache: boolean;
  labels: Record<string, string>;
  /** The text of the context's `Dockerfile`. */
  dockerfile: string;
}

export interface FakeDocker {
  socketPath: string;
  requests: FakeRequest[];
  containers: Map<string, FakeContainer>;
  networks: Map<string, { Id: string; Name: string; Driver: string; Containers: string[] }>;
  volumes: Map<string, { Name: string; Driver: string; Mountpoint: string; Labels: Record<string, string>; CreatedAt: string }>;
  /** Every `POST /build`, in order. */
  builds: FakeBuild[];
  /** Image name (tag) → image. */
  images: Map<string, FakeImage>;
  close(): Promise<void>;
}

export function parseTar(buf: Buffer): { name: string; type: string; mode: number; data: Buffer }[];

export function startFakeDocker(opts?: FakeDockerOptions): Promise<FakeDocker>;
