import { useEffect, useState } from "react";
import { api } from "./api";
import type { AgentInfo } from "./types";

/** Shown until `GET /api/agents` answers, so the sidebar does not jump. */
export const FALLBACK_AGENTS: AgentInfo[] = [
  { id: "claude", label: "Claude Code", installed: true, connect: "inject" },
  { id: "codex", label: "Codex", installed: true, connect: "inject" },
  { id: "opencode", label: "OpenCode", installed: true, connect: "inject" },
  { id: "qwen", label: "Qwen Code", installed: true, connect: "project-config" },
];

/** The agent CLIs and whether each is installed, fetched once. */
export function useAgents(): AgentInfo[] {
  const [agents, setAgents] = useState<AgentInfo[]>(FALLBACK_AGENTS);
  useEffect(() => {
    let live = true;
    api<{ agents: AgentInfo[] }>("/api/agents").then(
      (r) => {
        if (live && Array.isArray(r?.agents)) setAgents(r.agents);
      },
      () => {
        if (live) setAgents([]);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return agents;
}
