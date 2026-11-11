// The web bundle cannot import graph-execution/api (it pulls in Node modules), so it keeps its own provider and agent
// lists. This test keeps them equal to the provider catalog.
import { ENGINE_PROVIDER_IDS, PROVIDER_CATALOG, providerInfo } from "graph-execution/api";
import { describe, expect, it } from "vitest";
import { AGENT_LABELS } from "../web/agentRequests";
import { FALLBACK_AGENTS } from "../web/pages/Terminals";
import { PROVIDERS as WEB_PROVIDERS } from "../web/pages/StartRunDrawer";
import { AGENTS } from "./agents.js";
import { PROVIDERS as SERVER_PROVIDERS } from "./routes/runs.js";

describe("web lists match the provider catalog", () => {
  it("offers the engine providers, plus fake, in the Start run drawer", () => {
    expect(WEB_PROVIDERS.filter((p) => p !== "fake")).toEqual([...ENGINE_PROVIDER_IDS]);
    expect([...WEB_PROVIDERS]).toEqual([...SERVER_PROVIDERS]);
  });

  it("names every graph-manager agent with its catalog label", () => {
    for (const a of AGENTS) {
      const info = providerInfo(a.id);
      expect(info, a.id).toBeDefined();
      expect(a.label, a.id).toBe(info?.label);
      expect(AGENT_LABELS[a.id], a.id).toBe(info?.label);
    }
    expect(Object.keys(AGENT_LABELS).sort()).toEqual(AGENTS.map((a) => a.id).sort());
  });

  it("falls back to the same agents, with their catalog labels and connect modes", () => {
    expect(FALLBACK_AGENTS.map((a) => a.id)).toEqual(AGENTS.map((a) => a.id));
    for (const a of FALLBACK_AGENTS) {
      expect(a.label, a.id).toBe(providerInfo(a.id)?.label);
      expect(PROVIDER_CATALOG.some((p) => p.id === a.id && p.mcp === a.connect), a.id).toBe(true);
    }
  });
});
