import { ENGINE_PROVIDER_IDS } from "graph-execution/api";

/** The providers a run may use: the engine's (from the catalog) plus the hidden test provider `fake`. */
export const PROVIDERS = [...ENGINE_PROVIDER_IDS, "fake"] as unknown as readonly [string, ...string[]];
