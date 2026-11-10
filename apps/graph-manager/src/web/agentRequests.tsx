// Agent requests (docs/prd/agent-tools.md "Web", docs/prd/agent-supervisor.md "Agent requests and the web"): an agent
// in a terminal calls a UI tool, the overview poll brings the queued request, and the host here acts on it — right away
// when that terminal is on screen, else from a toast's Open. `start-run` opens the prefilled Start run drawer, `open-run`
// opens the run in a pane of the Terminals page (else the run page), `refresh` makes this tab re-fetch its data,
// `open-graph` opens a run page at a node or a read-only preview of a task folder's graph, and `propose-graph` shows
// that preview with Approve (opens the prefilled drawer) and Reject (types a line into the agent's terminal).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { post } from "./api";
import { useOverview } from "./overview";
import { GraphPreviewDialog } from "./pages/GraphPreviewDialog";
import { StartRunDrawer, type StartRunPrefill } from "./pages/StartRunDrawer";
import type { OpenGraphRequest, ProposeGraphRequest, StartRunRequest, TerminalAgentRequest } from "./types";
import { useToast } from "./ui/toast";

const NONE: ReadonlySet<string> = new Set();

/** Opens run `runId` of workspace `workspaceId` in the Terminals page's next free pane. */
export type RunOpener = (workspaceId: string, runId: string) => void;

/**
 * Terminal ids shown in a visible pane of the Terminals page (empty on other pages), and how that page opens a run in
 * a pane (a ref, so registering doesn't re-render).
 */
const VisibleTerminals = createContext<{
  ids: ReadonlySet<string>;
  set(ids: ReadonlySet<string>): void;
  opener: { current: RunOpener | undefined };
} | null>(null);

export function VisibleTerminalsProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<ReadonlySet<string>>(NONE);
  const opener = useRef<RunOpener | undefined>(undefined);
  const set = useCallback((next: ReadonlySet<string>) => {
    setIds((cur) => (sameSet(cur, next) ? cur : next));
  }, []);
  const value = useMemo(() => ({ ids, set, opener }), [ids, set]);
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

/** The Terminals page registers how it opens a run in its next free pane; cleared on unmount. No-op outside a provider. */
export function useRunPaneOpener(open: RunOpener): void {
  const ref = useContext(VisibleTerminals)?.opener;
  useEffect(() => {
    if (!ref) return;
    ref.current = open;
    return () => {
      if (ref.current === open) ref.current = undefined;
    };
  }, [ref, open]);
}

const AGENT_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", qwen: "Qwen Code" };

/** `github~octo~hello` → `hello`. */
const repoOf = (workspaceId: string): string => workspaceId.split("~").pop() || workspaceId;

/** The toast text: "Claude Code in hello wants to start a run", "… in hello: run <id>", "… wants to show you a graph". */
export function requestText(r: TerminalAgentRequest): string {
  const who = (r.agent && AGENT_LABELS[r.agent]) || "An agent";
  const repo = repoOf(r.workspaceId);
  switch (r.kind) {
    case "start-run":
      return `${who} in ${repo} wants to start a run`;
    case "open-run":
      return `${who} in ${repo}: run ${r.runId}`;
    case "open-graph":
    case "propose-graph":
      return `${who} in ${repo} wants to show you a graph`;
  }
}

/** Acks a request; `result` answers a propose-graph request (a rejection is typed into the agent's terminal). */
const ack = (id: string, result?: "approved" | "rejected") =>
  void post(`/api/agent-requests/${encodeURIComponent(id)}/ack`, result ? { result } : undefined).catch(() => {});

const enc = encodeURIComponent;

/** Acts on the agents' pending requests for the whole app: opens the drawer or a run, refreshes, or toasts once. */
export function AgentRequestHost() {
  const overview = useOverview();
  const ctx = useContext(VisibleTerminals);
  const visible = ctx?.ids ?? NONE;
  const opener = ctx?.opener;
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  /** Request id → id of its toast. Agent-request toasts stay until used or dismissed, and go when the request does. */
  const toasts = useRef(new Map<string, number>());
  const opened = useRef(new Set<string>());
  /** Proposals whose preview the user closed without answering: toasted again, never re-opened by themselves. */
  const closed = useRef(new Set<string>());
  const refreshed = useRef(new Set<string>());
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState<{ workspaceId: string; prefill: StartRunPrefill; originTerminalId?: string } | undefined>(undefined);
  const [preview, setPreview] = useState<{ request: OpenGraphRequest | ProposeGraphRequest } | undefined>(undefined);

  const openFor = useCallback((r: StartRunRequest) => {
    opened.current.add(r.id);
    ack(r.id);
    setDrawer({ workspaceId: r.workspaceId, prefill: r.prefill, originTerminalId: r.terminalId });
  }, []);

  const showGraph = useCallback(
    (r: OpenGraphRequest | ProposeGraphRequest) => {
      opened.current.add(r.id);
      if (r.kind === "propose-graph") {
        // Acked when the user approves or rejects; closing the preview keeps it pending (toasted again).
        setPreview({ request: r });
        return;
      }
      ack(r.id);
      if (r.runId) navigate(`/runs/${enc(r.workspaceId)}/${enc(r.runId)}${r.node ? `?node=${enc(r.node)}` : ""}`);
      else if (r.tasksDir) setPreview({ request: r });
    },
    [navigate],
  );

  /** Toasts a request once, until Open or × (× acks it; for a proposal it is a rejection the agent is told about). */
  const toastRequest = useCallback(
    (r: TerminalAgentRequest) => {
      if (toasts.current.has(r.id)) return;
      const used = () => {
        toasts.current.delete(r.id);
        opened.current.add(r.id);
      };
      const action =
        r.kind === "open-run"
          ? {
              label: "Open",
              to: `/runs/${enc(r.workspaceId)}/${enc(r.runId)}`,
              onClick: () => {
                used();
                ack(r.id);
              },
            }
          : {
              label: "Open",
              onClick: () => {
                toasts.current.delete(r.id);
                if (r.kind === "start-run") openFor(r);
                else showGraph(r);
              },
            };
      const id = toastRef.current.show({
        tone: "live",
        text: requestText(r),
        sticky: true,
        action,
        onDismiss: () => {
          used();
          closed.current.delete(r.id);
          ack(r.id, r.kind === "propose-graph" ? "rejected" : undefined);
        },
      });
      toasts.current.set(r.id, id);
    },
    [openFor, showGraph],
  );

  const { agentRequests, requestRefresh } = overview;
  useEffect(() => {
    for (const r of agentRequests) {
      switch (r.kind) {
        case "start-run":
          if (opened.current.has(r.id)) break;
          if (visible.has(r.terminalId) && !document.hidden) openFor(r);
          else toastRequest(r);
          break;
        case "open-run": {
          if (opened.current.has(r.id)) break;
          const open = opener?.current;
          if (visible.has(r.terminalId) && !document.hidden && open) {
            opened.current.add(r.id);
            ack(r.id);
            open(r.workspaceId, r.runId);
          } else toastRequest(r);
          break;
        }
        case "refresh":
          // Listed for 10 s and never acked: act on each id once.
          if (refreshed.current.has(r.id)) break;
          refreshed.current.add(r.id);
          requestRefresh();
          break;
        case "open-graph":
        case "propose-graph":
          if (opened.current.has(r.id)) break;
          if (visible.has(r.terminalId) && !document.hidden && !closed.current.has(r.id)) showGraph(r);
          else toastRequest(r);
          break;
      }
    }
    // A request acked elsewhere (another tab) or expired: its toast goes too.
    const pending = new Set(agentRequests.map((r) => r.id));
    for (const [rid, tid] of toasts.current) {
      if (pending.has(rid)) continue;
      toasts.current.delete(rid);
      toastRef.current.dismiss(tid);
    }
  }, [agentRequests, visible, openFor, showGraph, toastRequest, opener, requestRefresh]);

  const shown = preview?.request;
  const closePreview = () => {
    setPreview(undefined);
    if (shown?.kind !== "propose-graph") return;
    // Not answered: keep it pending and offer it again from a toast.
    opened.current.delete(shown.id);
    closed.current.add(shown.id);
    toastRequest(shown);
  };

  return (
    <>
      <StartRunDrawer
        open={!!drawer}
        onClose={() => setDrawer(undefined)}
        workspaces={overview.workspaces}
        initialWorkspace={drawer?.workspaceId}
        prefill={drawer?.prefill}
        originTerminalId={drawer?.originTerminalId}
      />
      {shown && (
        <GraphPreviewDialog
          open
          workspaceId={shown.workspaceId}
          tasksDir={shown.kind === "propose-graph" ? shown.prefill.tasksDir : (shown.tasksDir ?? "")}
          node={shown.kind === "open-graph" ? shown.node : undefined}
          propose={shown.kind === "propose-graph"}
          onClose={closePreview}
          onApprove={() => {
            if (shown.kind !== "propose-graph") return;
            ack(shown.id, "approved");
            setPreview(undefined);
            setDrawer({ workspaceId: shown.workspaceId, prefill: shown.prefill, originTerminalId: shown.terminalId });
          }}
          onReject={() => {
            ack(shown.id, "rejected");
            setPreview(undefined);
          }}
        />
      )}
    </>
  );
}
