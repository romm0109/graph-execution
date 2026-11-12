// A minimal Docker Engine API client over a unix socket or a Windows named pipe (KAN-88). No dependency: node:http with `socketPath`.
// Request bodies are never logged or put in errors: a container's Env holds API keys.
import http from "node:http";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";

/** The API version prefix. 1.45 (Docker 26+) is needed for `VolumeOptions.Subpath`. */
export const DOCKER_API = "/v1.45";

/** A failed Docker call. `status` is the HTTP status, or 0 when the socket could not be reached. */
export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DockerError";
  }
}

export interface ContainerMount {
  Type: string;
  Name?: string;
  Source: string;
  Destination: string;
  RW?: boolean;
}

export interface ContainerInfo {
  Id: string;
  Name: string;
  Config: { Image: string; Hostname: string; Labels?: Record<string, string>; Env?: string[] };
  State: { Status: string; Running: boolean; ExitCode: number };
  Mounts?: ContainerMount[];
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }>;
    /** Published ports, e.g. `"7600/tcp": [{ HostIp: "127.0.0.1", HostPort: "55012" }]`. */
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
  };
  HostConfig?: Record<string, unknown>;
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Labels: Record<string, string>;
  State: string;
}

export interface NetworkInfo {
  Id: string;
  Name: string;
  Containers?: Record<string, unknown>;
}

export interface VolumeInfo {
  Name: string;
  Mountpoint?: string;
  Labels?: Record<string, string> | null;
}

export interface ImageInfo {
  Id: string;
  RepoTags?: string[];
  Config?: { Env?: string[]; Labels?: Record<string, string> | null };
}

export interface ImageSummary {
  Id: string;
  RepoTags: string[] | null;
  Labels?: Record<string, string> | null;
}

export interface BuildOptions {
  nocache?: boolean;
  labels?: Record<string, string>;
  /** Each non-empty line of the build log, as it arrives. */
  onLine?: (line: string) => void;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  raw?: Buffer;
  contentType?: string;
  /** Milliseconds; 0 = none. Default 30 s. */
  timeoutMs?: number;
  /** Statuses that are not errors besides 2xx (e.g. 304, 404). */
  ok?: number[];
}

interface Response {
  status: number;
  body: Buffer;
}

function errorMessage(status: number, body: Buffer): string {
  const text = body.toString("utf8").trim();
  if (text !== "") {
    try {
      const json = JSON.parse(text) as { message?: unknown };
      if (typeof json.message === "string" && json.message !== "") return json.message;
    } catch {
      // not JSON: the text itself
    }
    return text;
  }
  return `HTTP ${status}`;
}

/** Splits Docker's multiplexed log stream (8-byte frame headers) into text; a TTY container's plain text is kept as is. */
export function demuxLogs(buf: Buffer): string {
  if (buf.length === 0) return "";
  const first = buf[0];
  if (buf.length < 8 || (first !== 0 && first !== 1 && first !== 2)) return buf.toString("utf8");
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, Math.min(buf.length, i + 8 + len)));
    i += 8 + len;
  }
  return Buffer.concat(parts).toString("utf8");
}

/** An image name in a URL path: each `/`-separated part encoded, the slashes kept (`ghcr.io/o/img:1`). */
function imagePath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

/** The parts of `GET /info` graph-manager reads. */
export interface DockerInfo {
  OSType?: string;
  OperatingSystem?: string;
  ServerVersion?: string;
}

export class DockerClient {
  /** `platform` is the host platform (tests set it): on `win32` and `darwin` graph-manager is never in a container itself. */
  constructor(
    readonly socketPath: string,
    readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    return this.send(method, path, opts);
  }

  /**
   * One HTTP call. With `onChunk`, a 2xx body is handed over chunk by chunk (and not kept); an error body is always
   * buffered for the error message.
   */
  private send(method: string, path: string, opts: RequestOptions, onChunk?: (chunk: Buffer) => void): Promise<Response> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) params.set(k, String(v));
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    let payload: Buffer | undefined;
    const headers: Record<string, string> = {};
    if (opts.raw) {
      payload = opts.raw;
      headers["content-type"] = opts.contentType ?? "application/x-tar";
    } else if (opts.body !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.body));
      headers["content-type"] = opts.contentType ?? "application/json";
    }
    if (payload) headers["content-length"] = String(payload.length);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, method, path: DOCKER_API + path + qs, headers }, (res) => {
        const chunks: Buffer[] = [];
        const status0 = res.statusCode ?? 0;
        const streaming = onChunk !== undefined && status0 >= 200 && status0 < 300;
        res.on("data", (c: Buffer) => {
          if (streaming) onChunk(c);
          else chunks.push(c);
        });
        res.on("error", (err) => reject(new DockerError(0, err.message)));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks);
          if ((status >= 200 && status < 300) || opts.ok?.includes(status)) resolve({ status, body });
          else reject(new DockerError(status, errorMessage(status, body)));
        });
      });
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker ${method} ${path} timed out after ${timeoutMs} ms`)));
      }
      req.on("error", (err) => reject(err instanceof DockerError ? err : new DockerError(0, err.message)));
      req.end(payload);
    });
  }

  private async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(method, path, opts);
    return JSON.parse(res.body.toString("utf8")) as T;
  }

  /** `GET /_ping`. Throws a `DockerError` when Docker is not reachable. */
  async ping(): Promise<void> {
    await this.request("GET", "/_ping", { timeoutMs: 5000 });
  }

  /** `GET /info`: what the daemon says about itself. `OSType` is "windows" when Docker Desktop runs Windows containers. */
  async info(): Promise<DockerInfo> {
    return this.json<DockerInfo>("GET", "/info", { timeoutMs: 5000 });
  }

  /** The container, or undefined when there is none with that id or name. */
  async inspectContainer(idOrName: string): Promise<ContainerInfo | undefined> {
    const res = await this.request("GET", `/containers/${encodeURIComponent(idOrName)}/json`, { ok: [404] });
    if (res.status === 404) return undefined;
    return JSON.parse(res.body.toString("utf8")) as ContainerInfo;
  }

  /**
   * graph-manager's own container (Docker sets HOSTNAME to its short id), or undefined when it does not run in Docker.
   * On Windows and macOS it never does (containers are Linux), so Docker is not asked: the host name could even match
   * an unrelated container's name.
   */
  async inspectSelf(): Promise<ContainerInfo | undefined> {
    if (this.platform === "win32" || this.platform === "darwin") return undefined;
    const host = process.env.HOSTNAME || os.hostname();
    if (!host) return undefined;
    try {
      return await this.inspectContainer(host);
    } catch (err) {
      if (err instanceof DockerError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Creates a container; returns its id. */
  async createContainer(name: string, body: object): Promise<string> {
    const res = await this.json<{ Id: string }>("POST", "/containers/create", { query: { name }, body });
    return res.Id;
  }

  /** Extracts a tar archive into the container at `path`. */
  async putArchive(id: string, path: string, tar: Buffer): Promise<void> {
    await this.request("PUT", `/containers/${encodeURIComponent(id)}/archive`, { query: { path }, raw: tar, contentType: "application/x-tar" });
  }

  /** Starts the container; already running is fine. */
  async startContainer(id: string): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/start`, { ok: [304] });
  }

  /** Stops the container (SIGTERM, SIGKILL after `timeoutSec`); already stopped or gone is fine. */
  async stopContainer(id: string, timeoutSec = 10): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/stop`, {
      query: { t: timeoutSec },
      ok: [304, 404],
      timeoutMs: (timeoutSec + 30) * 1000,
    });
  }

  /** Removes the container (forced by default); gone is fine. */
  async removeContainer(id: string, { force = true }: { force?: boolean } = {}): Promise<void> {
    await this.request("DELETE", `/containers/${encodeURIComponent(id)}`, { query: { force: force ? 1 : 0 }, ok: [404] });
  }

  /** Waits until the container exits; its exit code, or -1 when there is no such container. */
  async waitContainer(id: string): Promise<number> {
    const res = await this.request("POST", `/containers/${encodeURIComponent(id)}/wait`, { ok: [404], timeoutMs: 0 });
    if (res.status === 404) return -1;
    const body = JSON.parse(res.body.toString("utf8")) as { StatusCode?: number };
    return typeof body.StatusCode === "number" ? body.StatusCode : -1;
  }

  /** The last `tail` lines of the container's stdout and stderr, as text. */
  async containerLogs(id: string, tail = 20): Promise<string> {
    const res = await this.request("GET", `/containers/${encodeURIComponent(id)}/logs`, { query: { stdout: 1, stderr: 1, tail } });
    return demuxLogs(res.body);
  }

  /** All containers (running or not) with the label `key` or `key=value`. */
  async listContainers(label: string): Promise<ContainerSummary[]> {
    return this.json<ContainerSummary[]>("GET", "/containers/json", { query: { all: 1, filters: JSON.stringify({ label: [label] }) } });
  }

  async inspectNetwork(name: string): Promise<NetworkInfo | undefined> {
    const res = await this.request("GET", `/networks/${encodeURIComponent(name)}`, { ok: [404] });
    if (res.status === 404) return undefined;
    return JSON.parse(res.body.toString("utf8")) as NetworkInfo;
  }

  /** Creates a bridge network; returns its id. */
  async createNetwork(name: string): Promise<string> {
    const res = await this.json<{ Id: string }>("POST", "/networks/create", { body: { Name: name, Driver: "bridge", CheckDuplicate: true } });
    return res.Id;
  }

  /** Connects a container to the network; already connected is fine. */
  async connectNetwork(name: string, containerId: string): Promise<void> {
    try {
      await this.request("POST", `/networks/${encodeURIComponent(name)}/connect`, { body: { Container: containerId } });
    } catch (err) {
      if (err instanceof DockerError && (err.status === 403 || err.status === 409) && /already exists/i.test(err.message)) return;
      throw err;
    }
  }

  /** Creates a volume (an existing one with that name is answered as is). */
  async createVolume(name: string, labels?: Record<string, string>): Promise<VolumeInfo> {
    return this.json<VolumeInfo>("POST", "/volumes/create", { body: { Name: name, ...(labels ? { Labels: labels } : {}) } });
  }

  /** All volumes with the label `key` or `key=value`. */
  async listVolumes(label: string): Promise<VolumeInfo[]> {
    const res = await this.json<{ Volumes: VolumeInfo[] | null }>("GET", "/volumes", { query: { filters: JSON.stringify({ label: [label] }) } });
    return res.Volumes ?? [];
  }

  /** Removes a volume; gone (404) or still mounted by a container (409) is skipped silently. */
  async removeVolume(name: string): Promise<void> {
    await this.request("DELETE", `/volumes/${encodeURIComponent(name)}`, { ok: [404, 409] });
  }

  async inspectVolume(name: string): Promise<VolumeInfo | undefined> {
    const res = await this.request("GET", `/volumes/${encodeURIComponent(name)}`, { ok: [404] });
    if (res.status === 404) return undefined;
    return JSON.parse(res.body.toString("utf8")) as VolumeInfo;
  }

  /**
   * Pulls an image (`POST /images/create`). Docker answers 200 and reports a failed pull in the progress stream, so
   * the stream is read to its end and its last `error` thrown as a `DockerError`.
   */
  async pullImage(name: string): Promise<void> {
    const res = await this.request("POST", "/images/create", { query: { fromImage: name }, timeoutMs: 10 * 60_000 });
    for (const line of res.body.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const msg = JSON.parse(line) as { error?: unknown };
        if (typeof msg.error === "string" && msg.error !== "") throw new DockerError(500, msg.error);
      } catch (err) {
        if (err instanceof DockerError) throw err;
      }
    }
  }

  /** Whether the image is present locally. */
  async imageExists(name: string): Promise<boolean> {
    const res = await this.request("GET", `/images/${imagePath(name)}/json`, { ok: [404] });
    return res.status !== 404;
  }

  /** The image (by name or id), or undefined when it is not present locally. */
  async inspectImage(name: string): Promise<ImageInfo | undefined> {
    const res = await this.request("GET", `/images/${imagePath(name)}/json`, { ok: [404] });
    if (res.status === 404) return undefined;
    return JSON.parse(res.body.toString("utf8")) as ImageInfo;
  }

  /** All local images with the label `key` or `key=value`. */
  async listImages(label: string): Promise<ImageSummary[]> {
    return this.json<ImageSummary[]>("GET", "/images/json", { query: { filters: JSON.stringify({ label: [label] }) } });
  }

  /** Removes an image; gone (404) or used by a container (409) is skipped silently. */
  async removeImage(nameOrId: string): Promise<void> {
    await this.request("DELETE", `/images/${imagePath(nameOrId)}`, { ok: [404, 409] });
  }

  /**
   * Builds an image from a tar context (`POST /build`). The JSON-lines log is streamed to `onLine`; Docker answers 200
   * and reports a failed build in the stream, so its last error is thrown as a `DockerError(500, …)` at the end.
   */
  async buildImage(tag: string, context: Buffer, opts: BuildOptions = {}): Promise<void> {
    const decoder = new StringDecoder("utf8");
    let partial = "";
    let streamError: string | undefined;
    const onJsonLine = (line: string): void => {
      if (line.trim() === "") return;
      let msg: { stream?: unknown; error?: unknown; errorDetail?: { message?: unknown } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      if (msg === null || typeof msg !== "object") return;
      if (typeof msg.stream === "string") {
        for (const piece of msg.stream.split("\n")) {
          const text = piece.trimEnd();
          if (text !== "") opts.onLine?.(text);
        }
      }
      const detail = msg.errorDetail?.message;
      if (typeof detail === "string" && detail !== "") streamError = detail;
      else if (typeof msg.error === "string" && msg.error !== "") streamError = msg.error;
    };
    await this.send(
      "POST",
      "/build",
      {
        query: { t: tag, nocache: opts.nocache ? 1 : 0, rm: 1, forcerm: 1, labels: opts.labels ? JSON.stringify(opts.labels) : undefined },
        raw: context,
        contentType: "application/x-tar",
        timeoutMs: 30 * 60_000,
      },
      (chunk) => {
        partial += decoder.write(chunk);
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) onJsonLine(line);
      },
    );
    onJsonLine(partial + decoder.end());
    if (streamError !== undefined) throw new DockerError(500, streamError);
  }
}
