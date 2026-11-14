import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { nextRunWatch, POLL_MS, type RunWatch } from "./runs";
import type { AgentRequest, ForgesInfo, RunSummary, TerminalInfo, WorkspaceEntry } from "./types";
import { useToast } from "./ui/toast";

/** Failed polls in a row after which the data counts as stale. */
export const STALE_AFTER = 3;

export interface Overview {
  runs: RunSummary[];
  terminals: TerminalInfo[];
  workspaces: WorkspaceEntry[];
  workspacesRoot?: string;
  forges: ForgesInfo;
  /** Requests from agents in terminals waiting for the browser (`GET /api/agent-requests`). */
  agentRequests: AgentRequest[];
  /** The first poll has finished (whatever its result). */
  loaded: boolean;
  /** When a poll last got an answer (ms since epoch). */
  updatedAt?: number;
  /** Polls in a row where every request failed. */
  failures: number;
  stale: boolean;
  /** Polls now; resolves when the new data is in. */
  refresh(): Promise<void>;
}

type Data = Omit<Overview, "stale" | "refresh">;

const EMPTY: Data = {
  runs: [],
  terminals: [],
  workspaces: [],
  forges: { github: { connected: false }, gitlab: { connected: false } },
  agentRequests: [],
  loaded: false,
  failures: 0,
};

const OverviewContext = createContext<Overview | null>(null);

const runKey = (r: RunSummary) => `${r.workspaceId}/${r.id}`;
/** `github~octo~hello` → `octo/hello`. */
/** The repo's last path segment, as on board 19: `github~platform~infra~deploy-tools` → `deploy-tools`. */
const repoName = (workspaceId: string) => workspaceId.split("~").slice(1).pop() || workspaceId;

/**
 * Polls runs, terminals, workspaces, forges and agent requests every 2 s for the whole app. Keeps the last good answer of each,
 * pauses while the tab is hidden, and toasts when a run starts or turns failed between two polls.
 */
export function OverviewProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Data>(EMPTY);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // The runs' statuses at the previous successful runs poll; undefined until the first one.
  const prevStatus = useRef<Map<string, string> | undefined>(undefined);
  // The runs seen running, so a run an agent starts from a terminal is announced once.
  const runWatch = useRef<RunWatch>(undefined);
  const mounted = useRef(true);
  const inflight = useRef<Promise<void> | undefined>(undefined);

  const poll = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    const p = (async () => {
      const [r, t, w, f, a] = await Promise.allSettled([
        api<{ runs: RunSummary[] }>("/api/runs"),
        api<{ terminals: TerminalInfo[] }>("/api/terminals"),
        api<{ workspaces: WorkspaceEntry[]; root?: string }>("/api/workspaces"),
        api<ForgesInfo>("/api/forges"),
        api<{ requests: AgentRequest[] }>("/api/agent-requests"),
      ]);
      if (!mounted.current) return;
      if (r.status === "fulfilled" && Array.isArray(r.value?.runs)) {
        const runs = r.value.runs;
        const prev = prevStatus.current;
        if (prev) {
          for (const run of runs) {
            const before = prev.get(runKey(run));
            if (run.status === "failed" && before !== undefined && before !== "failed") {
              toastRef.current.show({
                tone: "bad",
                text: `Run ${run.id.slice(-4)} failed in ${repoName(run.workspaceId)}`,
                action: { label: "Open", to: `/runs/${encodeURIComponent(run.workspaceId)}/${encodeURIComponent(run.id)}` },
              });
            }
          }
        }
        prevStatus.current = new Map(runs.map((x) => [runKey(x), x.status]));
        const watched = nextRunWatch(runWatch.current, runs);
        runWatch.current = watched.watch;
        for (const run of watched.started) {
          toastRef.current.show({
            tone: "live",
            text: `Run ${run.id.slice(-4)} started in ${repoName(run.workspaceId)}`,
            action: { label: "Open", to: `/runs/${encodeURIComponent(run.workspaceId)}/${encodeURIComponent(run.id)}` },
          });
        }
      }
      const allFailed = [r, t, w, f, a].every((x) => x.status === "rejected");
      setData((d) => ({
        runs: r.status === "fulfilled" && Array.isArray(r.value?.runs) ? r.value.runs : d.runs,
        terminals: t.status === "fulfilled" && Array.isArray(t.value?.terminals) ? t.value.terminals : d.terminals,
        workspaces: w.status === "fulfilled" && Array.isArray(w.value?.workspaces) ? w.value.workspaces : d.workspaces,
        workspacesRoot: w.status === "fulfilled" && typeof w.value?.root === "string" ? w.value.root : d.workspacesRoot,
        forges: f.status === "fulfilled" && f.value?.github && f.value?.gitlab ? f.value : d.forges,
        agentRequests: a.status === "fulfilled" && Array.isArray(a.value?.requests) ? a.value.requests : d.agentRequests,
        loaded: true,
        updatedAt: allFailed ? d.updatedAt : Date.now(),
        failures: allFailed ? d.failures + 1 : 0,
      }));
    })().finally(() => {
      inflight.current = undefined;
    });
    inflight.current = p;
    return p;
  }, []);

  useEffect(() => {
    mounted.current = true;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!document.hidden) await poll();
      if (!stop) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    const onVis = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      mounted.current = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [poll]);

  const value = useMemo<Overview>(() => ({ ...data, stale: data.failures >= STALE_AFTER, refresh: poll }), [data, poll]);
  return <OverviewContext.Provider value={value}>{children}</OverviewContext.Provider>;
}

const FALLBACK: Overview = { ...EMPTY, stale: false, refresh: async () => {} };

/** The shared overview data. Outside an `OverviewProvider` (a page rendered alone in a test) it is empty. */
export function useOverview(): Overview {
  return useContext(OverviewContext) ?? FALLBACK;
}

/** The current time, re-rendering every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** "3s ago", "2m ago", "1h ago". */
export function agoText(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** "updated 1s ago", amber when the data is stale. */
export function UpdatedAgo() {
  const { updatedAt, stale } = useOverview();
  const now = useNow();
  return (
    <span className={stale ? "updated-ago stale" : "updated-ago"} data-stale={stale ? "true" : "false"} data-testid="updated-ago">
      {updatedAt === undefined ? "updating…" : `updated ${agoText(updatedAt, now)}`}
    </span>
  );
}

/** The amber "Can't reach the server" bar; renders nothing while the data is fresh. */
export function StaleBanner() {
  const { updatedAt, stale } = useOverview();
  const now = useNow();
  if (!stale) return null;
  const since = updatedAt === undefined ? "" : ` Showing data from ${agoText(updatedAt, now)}.`;
  return (
    <div className="stale-banner" role="status" data-testid="stale-banner">
      <span className="glyph glyph-half tone-warn" aria-hidden="true" />
      <span className="stale-banner-text">Can’t reach the server.{since} Retrying…</span>
    </div>
  );
}
