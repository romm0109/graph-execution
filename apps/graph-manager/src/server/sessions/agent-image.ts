// The agent runtime of session containers (docs/prd/hosted-sessions.md, "DockerProvisioner"): the image
// `gm-agent:<hash>` holds graph-manager's built server, the engine and their npm dependencies under /opt/gm-agent. Its
// /opt/gm-agent is copied into the named volume `gm-agent-<id12>`, which every session container mounts read-only, so
// any sandbox image (the session owner's) can run `graph-manager agent`. Mirrors ensureCliImage/ensureClisVolume.
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DockerClient } from "../docker.js";
import type { User } from "../identity.js";
import { IMAGE_LABEL, INSTANCE_LABEL } from "../sandbox-image.js";
import { tarArchive, type TarEntry } from "../tar.js";

/** The repository of the agent runtime image. */
export const AGENT_IMAGE_REPO = "gm-agent";
/** Where a session container has the agent runtime (and the image has it). */
export const AGENT_TARGET = "/opt/gm-agent";
/** Where a session container has its workspaces (the user's volume). */
export const WORKSPACES_TARGET = "/workspaces";
/** The label (value "1") on the gm-agent volumes. */
export const AGENT_LABEL = "gm.agent";
/** The label on a user's volume and on every session and run container: the user id. */
export const USER_LABEL = "gm.user";
/** The label on a run container and its volume: the run id. */
export const RUN_CONTAINER_LABEL = "gm.run-container";

/** The image and volume a session container runs the agent from. */
export interface AgentRuntime {
  imageTag: string;
  volume: string;
}

/** The engine's own files the bundled graph-manager adds under dist/manager: not needed by the agent. */
const MANAGER_BUNDLE = ["server", "web", "package.json"].map((e) => `dist/manager/${e}`);

/** The Dockerfile of the agent runtime image (the full bookworm image has python3/make/g++ for node-pty). */
export function agentDockerfile(): string {
  return [
    "FROM node:24.22.1-bookworm",
    `COPY package.json ${AGENT_TARGET}/package.json`,
    `RUN cd ${AGENT_TARGET} && npm install --omit=dev --no-audit --no-fund`,
    `COPY engine ${AGENT_TARGET}/node_modules/graph-execution`,
    `COPY server ${AGENT_TARGET}/server`,
    `RUN mkdir -p ${AGENT_TARGET}/bin && printf '#!/bin/sh\\nexec node ${AGENT_TARGET}/server/cli.js "$@"\\n' > ${AGENT_TARGET}/bin/graph-manager \\`,
    ` && chmod 755 ${AGENT_TARGET}/bin/graph-manager && mkdir -p ${WORKSPACES_TARGET} && chown 1000:1000 ${WORKSPACES_TARGET}`,
    "",
  ].join("\n");
}

/** Every file under `dir`, as paths relative to it with "/" separators, sorted. */
async function filesOf(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) for (const f of await filesOf(path.join(dir, e.name))) out.push(`${e.name}/${f}`);
    else if (e.isFile()) out.push(e.name);
  }
  return out.sort();
}

async function treeEntries(dir: string, prefix: string, skip: (rel: string) => boolean = () => false): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  for (const rel of await filesOf(dir)) {
    if (skip(rel)) continue;
    out.push({ path: `${prefix}/${rel}`, content: await readFile(path.join(dir, rel)) });
  }
  return out;
}

/**
 * The build context's entries: the Dockerfile, a package.json with the engine's dependencies (they are graph-manager's
 * server dependencies too), `server/**` = graph-manager's built server folder, `engine/**` = the engine's package.json
 * and dist (without the bundled graph-manager), as copyEngine lays them out.
 */
export async function agentContextEntries(serverDir: string, engineDir: string): Promise<TarEntry[]> {
  const enginePkg = JSON.parse(await readFile(path.join(engineDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const pkg = { name: "gm-agent", private: true, type: "module", dependencies: enginePkg.dependencies ?? {} };
  return [
    { path: "Dockerfile", content: Buffer.from(agentDockerfile()) },
    { path: "package.json", content: Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`) },
    { path: "engine/package.json", content: await readFile(path.join(engineDir, "package.json")) },
    ...(await treeEntries(path.join(engineDir, "dist"), "engine/dist", (rel) => MANAGER_BUNDLE.some((m) => `dist/${rel}` === m || `dist/${rel}`.startsWith(`${m}/`)))),
    ...(await treeEntries(serverDir, "server")),
  ];
}

/** The build context (a tar owned by 0:0). */
export async function agentContext(serverDir: string, engineDir: string): Promise<Buffer> {
  return tarArchive(await agentContextEntries(serverDir, engineDir), { uid: 0, gid: 0 });
}

/** `gm-agent:<first 12 hex of sha256 of the context's paths and contents>` (the tar itself carries the time). */
export function agentImageTag(entries: TarEntry[]): string {
  const h = createHash("sha256");
  for (const e of entries) {
    h.update(e.path).update("\0");
    h.update(e.content ?? Buffer.alloc(0)).update("\0");
  }
  return `${AGENT_IMAGE_REPO}:${h.digest("hex").slice(0, 12)}`;
}

function labelsOf(kind: string, instance?: string): Record<string, string> {
  return instance ? { [kind]: "1", [INSTANCE_LABEL]: instance } : { [kind]: "1" };
}

/** Builds the agent runtime image of `entries` when it is missing; its tag and id. */
export async function ensureAgentImage(
  docker: DockerClient,
  entries: TarEntry[],
  instance?: string,
  onLine?: (l: string) => void,
): Promise<{ tag: string; id: string }> {
  const tag = agentImageTag(entries);
  if (!(await docker.inspectImage(tag))) {
    await docker.buildImage(tag, tarArchive(entries, { uid: 0, gid: 0 }), { labels: labelsOf(IMAGE_LABEL, instance), ...(onLine ? { onLine } : {}) });
  }
  const info = await docker.inspectImage(tag);
  if (!info) throw new Error("the agent image was built but cannot be inspected");
  return { tag, id: info.Id };
}

/**
 * Fills the volume `name` from the image's `target`: Docker copies the image's folder into a volume mounted there
 * when the volume is empty. A volume this call created is removed again when the fill fails.
 */
export async function fillVolume(
  docker: DockerClient,
  p: { name: string; imageTag: string; target: string; created: boolean },
): Promise<void> {
  let code: number;
  try {
    let id: string | undefined;
    try {
      id = await docker.createContainer(`gm-fill-${randomBytes(4).toString("hex")}`, {
        Image: p.imageTag,
        Cmd: ["true"],
        Labels: { "gm.volume-fill": "1" },
        HostConfig: { Mounts: [{ Type: "volume", Source: p.name, Target: p.target }] },
      });
      await docker.startContainer(id);
      code = await docker.waitContainer(id);
    } finally {
      if (id) await docker.removeContainer(id).catch(() => undefined);
    }
  } catch (err) {
    if (p.created) await docker.removeVolume(p.name).catch(() => undefined);
    throw err;
  }
  if (code !== 0) {
    if (p.created) await docker.removeVolume(p.name).catch(() => undefined);
    throw new Error(`filling ${p.name} failed (exit ${code})`);
  }
}

/** The volume of the agent image `image`: `gm-agent-<first 12 hex of the id>`. */
export function agentVolumeName(imageId: string): string {
  return `gm-agent-${imageId.replace(/^sha256:/, "").slice(0, 12)}`;
}

/** Makes sure the agent runtime volume of the image exists and is filled (like ensureClisVolume); its name. */
export async function ensureAgentVolume(docker: DockerClient, image: { tag: string; id: string }, instance?: string): Promise<string> {
  const name = agentVolumeName(image.id);
  const existed = (await docker.inspectVolume(name)) !== undefined;
  if (!existed) await docker.createVolume(name, labelsOf(AGENT_LABEL, instance));
  // An existing one gets the fill too: one left empty by a graph-manager stopped between the create and the fill.
  await fillVolume(docker, { name, imageTag: image.tag, target: AGENT_TARGET, created: !existed });
  return name;
}

/** A user id as a Docker name part: a readable slug plus a hash of the id, so ids differing only in case differ. */
export function dockerSafeId(id: string): string {
  const slug =
    id
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 40) || "u";
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

/** The workspaces volume of a user. */
export function userVolumeName(userId: string): string {
  return `gm-user-${dockerSafeId(userId)}`;
}

/**
 * Makes sure the workspaces volume of a user exists; a new one is filled from the agent image's empty, 1000-owned
 * /workspaces, so the session user can write it. Returns its name.
 */
export async function ensureUserVolume(docker: DockerClient, agentImageTag: string, user: User): Promise<string> {
  const name = userVolumeName(user.id);
  return ensureFreshVolume(docker, name, agentImageTag, { [USER_LABEL]: user.id });
}

/** Creates the volume `name` with `labels` and fills it from the agent image's /workspaces, unless it exists. */
export async function ensureFreshVolume(docker: DockerClient, name: string, agentImageTag: string, labels: Record<string, string>): Promise<string> {
  if (await docker.inspectVolume(name)) return name;
  await docker.createVolume(name, labels);
  await fillVolume(docker, { name, imageTag: agentImageTag, target: WORKSPACES_TARGET, created: true });
  return name;
}
