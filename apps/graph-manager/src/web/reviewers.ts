/** One stored reviewer, as `GET /api/reviewers` returns it. */
export interface Reviewer {
  id: string;
  type: "diff" | "tester";
  name: string;
  enabled: boolean;
  instructions: string;
  repoFile: string;
  provider?: string;
  model?: string;
  files?: string[];
  blockAt: BlockAt;
}

export type BlockAt = "major" | "blocker" | "never";

export interface ReviewersResponse {
  reviewers: Reviewer[];
  builtinIds: string[];
  providers: string[];
  file: string;
}

/** The drawer's fields: everything as text, `files` one glob per line. */
export interface ReviewerForm {
  id: string;
  type: "diff" | "tester";
  name: string;
  enabled: boolean;
  instructions: string;
  repoFile: string;
  provider: string;
  model: string;
  files: string;
  blockAt: BlockAt;
}

export const INSTRUCTIONS_MAX = 20000;

/** `security` → `SECURITY_REVIEW.md`, `perf-check` → `PERF_CHECK_REVIEW.md`. */
export const repoFileFor = (id: string): string => `${id.toUpperCase().replaceAll("-", "_") || "NAME"}_REVIEW.md`;

/** `Security review!` → `security-review` (lowercase, other runs → `-`, at most 32 characters). */
export const idFromName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");

export function toForm(r?: Reviewer): ReviewerForm {
  return {
    id: r?.id ?? "",
    type: r?.type ?? "diff",
    name: r?.name ?? "",
    enabled: r?.enabled ?? true,
    instructions: r?.instructions ?? "",
    repoFile: r?.repoFile ?? "",
    provider: r?.provider ?? "",
    model: r?.model ?? "",
    files: (r?.files ?? []).join("\n"),
    blockAt: r?.blockAt ?? "major",
  };
}

export function fromForm(f: ReviewerForm, isNew: boolean): Reviewer {
  const files = f.files
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const provider = f.provider.trim();
  const model = f.model.trim();
  return {
    id: f.id.trim(),
    type: isNew ? "diff" : f.type,
    name: f.name.trim(),
    enabled: f.enabled,
    instructions: f.instructions,
    repoFile: f.repoFile.trim(),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(files.length > 0 ? { files } : {}),
    blockAt: f.blockAt,
  };
}

/** `run default`, `claude`, `claude · opus`, or `run default · opus`. */
export const providerLabel = (r: Pick<Reviewer, "provider" | "model">): string =>
  r.model ? `${r.provider || "run default"} · ${r.model}` : r.provider || "run default";

export const blockLabel: Record<BlockAt, string> = {
  major: "blocks at major",
  blocker: "blocks at blocker",
  never: "never blocks",
};

export const typeLabel = (r: Pick<Reviewer, "type">): string => (r.type === "tester" ? "live tester" : "diff");
