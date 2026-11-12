/** The providers the Start run drawer offers (`fake` is the hidden test provider). */
export const PROVIDERS = ["claude", "codex", "opencode", "qwen", "pi", "omp", "copilot", "fake"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_OPTIONS = PROVIDERS.map((p) => ({ value: p, label: p === "fake" ? "fake (test)" : p }));
