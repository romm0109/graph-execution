// Agent requests (docs/prd/agent-tools.md "Web"): an agent in a terminal calls `open_start_run`, the overview poll
// brings the queued request, and the host here opens the prefilled Start run drawer — right away when that terminal is
// on screen, else from a toast's Open.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { post } from "./api";
import { useOverview } from "./overview";
import { StartRunDrawer, type StartRunPrefill } from "./pages/StartRunDrawer";
import type { AgentId, AgentRequest } from "./types";
import { useToast } from "./ui/toast";

const NONE: ReadonlySet<string> = new Set();

/** Terminal ids shown in a visible pane of the Terminals page; empty on other pages. */
const VisibleTerminals = createContext<{ ids: ReadonlySet<string>; set(ids: ReadonlySet<string>): void } | null>(null);

export function VisibleTerminalsProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<ReadonlySet<string>>(NONE);
  const set = useCallback((next: ReadonlySet<string>) => {
    setIds((cur) => (sameSet(cur, next) ? cur : next));
  }, []);
  const value = useMemo(() => ({ ids, set }), [ids, set]);
  return <VisibleTerminals.Provider value={value}>{children}</VisibleTerminals.Provider>;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Publishes the terminals on screen; clears them on unmount. A no-op outside a `VisibleTerminalsProvider`. */
export function useSetVisibleTerminals(ids: ReadonlySet<string>): void {
  const set = useContext(VisibleTerminals)?.set;
  useEffect(() => {
    set?.(ids);
  }, [set, ids]);
  useEffect(() => {
    if (!set) return;
    return () => set(NONE);
  }, [set]);
}

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  qwen: "Qwen Code",
  pi: "pi",
  omp: "oh-my-pi",
  copilot: "GitHub Copilot",
};

/** `github~octo~hello` → `hello`. */
const repoOf = (workspaceId: string): string => workspaceId.split("~").pop() || workspaceId;

/** The request's agent when graph-manager knows it, else undefined. */
export function knownAgent(r: AgentRequest): AgentId | undefined {
  return r.agent !== undefined && Object.hasOwn(AGENT_LABELS, r.agent) ? (r.agent as AgentId) : undefined;
}

/** "Claude Code", or "An agent" when the agent is unknown. */
export function agentLabel(r: AgentRequest): string {
  const agent = knownAgent(r);
  return agent ? AGENT_LABELS[agent] : "An agent";
}

/** "Claude Code in hello wants to start a run". */
export function requestText(r: AgentRequest): string {
  return `${agentLabel(r)} in ${repoOf(r.workspaceId)} wants to start a run`;
}

/** Acts on the agents' pending requests for the whole app: opens the prefilled Start run drawer, or toasts once. */
export function AgentRequestHost() {
  const overview = useOverview();
  const visible = useContext(VisibleTerminals)?.ids ?? NONE;
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const toasted = useRef(new Set<string>());
  const opened = useRef(new Set<string>());
  const [drawer, setDrawer] = useState<
    { workspaceId: string; prefill: StartRunPrefill; agent?: AgentId; label: string } | undefined
  >(undefined);

  const openFor = useCallback((r: AgentRequest) => {
    opened.current.add(r.id);
    void post(`/api/agent-requests/${encodeURIComponent(r.id)}/ack`).catch(() => {});
    setDrawer({ workspaceId: r.workspaceId, prefill: r.prefill, agent: knownAgent(r), label: agentLabel(r) });
  }, []);

  const { agentRequests } = overview;
  useEffect(() => {
    for (const r of agentRequests) {
      if (r.kind !== "start-run" || opened.current.has(r.id)) continue;
      if (visible.has(r.terminalId) && !document.hidden) openFor(r);
      else if (!toasted.current.has(r.id)) {
        toasted.current.add(r.id);
        toastRef.current.show({ tone: "live", text: requestText(r), action: { label: "Open", onClick: () => openFor(r) } });
      }
    }
  }, [agentRequests, visible, openFor]);

  return (
    <StartRunDrawer
      open={!!drawer}
      onClose={() => setDrawer(undefined)}
      workspaces={overview.workspaces}
      initialWorkspace={drawer?.workspaceId}
      prefill={drawer?.prefill}
      openedBy={drawer && { agent: drawer.agent, label: drawer.label }}
    />
  );
}
