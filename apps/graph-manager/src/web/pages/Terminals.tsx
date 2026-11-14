// Terminals (boards 07, 08, 09, 19): grouped sidebar, tabs, a 1/2/4-pane split of terminals and runs, the Ctrl Space
// prefix, restart and reconnect.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, post } from "../api";
import { useSetVisibleTerminals } from "../agentRequests";
import { useListNav } from "../keys";
import { useOverview } from "../overview";
import { nextRunWatch, type RunWatch } from "../runs";
import { repoOfWorkspace, sessionLabel } from "../sessions";
import type { AgentId, CloseResult, RunSummary, SessionInfo, TerminalInfo } from "../types";
import { ConfirmDialog } from "../ui/Dialog";
import { Icon, type IconName } from "../ui/Icon";
import { Kbd } from "../ui/Kbd";
import { StatusGlyph } from "../ui/StatusBadge";
import { useToast } from "../ui/toast";
import { useAgents } from "../useAgents";
import { useProjects } from "../useProjects";
import {
  closeItem,
  cycleLayout,
  focusPane,
  loadLayout,
  openInNextFree,
  openItem,
  parseItem,
  prune,
  runItem,
  saveLayout,
  setLayout,
  termItem,
  type ItemId,
  type LayoutState,
  type PaneCount,
} from "./layout";
import { CloseSessionDialog } from "./CloseSessionDialog";
import { NewTerminalDialog, type NewTerminalInitial, type Opened } from "./NewTerminalDialog";
import { SpecFloat, useWorkspaceSpecs, type SpecEntry } from "./SpecFloat";
import { nextWatch, type SpecWatch } from "./specPane";
import { EmptyPane, RunPane, TerminalPane, type PaneChrome } from "./TerminalPane";
import { TerminalSidebar, last4, liveRunsIn, shownOrder, workspacePath } from "./TerminalSidebar";
import "./Terminals.css";

export type { TerminalInfo };

/** How long the Ctrl Space prefix waits for the next key. */
export const PREFIX_MS = 1500;
const NARROW = "(max-width: 899.98px)";

function useNarrow(): boolean {
  const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(NARROW) : undefined);
  const [narrow, setNarrow] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

/** Plain interactive shells: closing a terminal at its prompt needs no confirmation. */
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ash", "tcsh", "csh", "ksh", "pwsh"]);

/** True when `name` (a foreground process such as `bash`, `-zsh` or `/usr/bin/fish`) is a plain shell. */
export function isShell(name: string): boolean {
  const base = name.trim().split("/").pop() ?? "";
  return SHELLS.has(base.replace(/^-/, ""));
}

/** Closing asks first only while a program other than a shell runs in the terminal. */
export function needsCloseConfirm(t: TerminalInfo): boolean {
  return t.status !== "exited" && !!t.process && !isShell(t.process);
}

/** The workspace of a pane's item: a terminal's `workspaceId`, a run's workspace; undefined for the root or nothing. */
export function itemWorkspace(item: ItemId | null | undefined, terminal: (id: string) => TerminalInfo | undefined): string | undefined {
  const p = parseItem(item ?? "");
  if (p?.kind === "term") return terminal(p.id)?.workspaceId;
  if (p?.kind === "run") return p.ws;
  return undefined;
}

const newestSpec = (specs: SpecEntry[]): SpecEntry | undefined => specs.reduce<SpecEntry | undefined>((a, s) => (!a || s.mtimeMs > a.mtimeMs ? s : a), undefined);

const isPrefix = (e: KeyboardEvent) => e.ctrlKey && !e.altKey && !e.metaKey && (e.key === " " || e.code === "Space");
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

export default function Terminals() {
  const overview = useOverview();
  const [params, setParams] = useSearchParams();
  const narrow = useNarrow();

  // Terminals created or renamed here, until the overview poll catches up; ids deleted here, until it drops them.
  const [created, setCreated] = useState<TerminalInfo[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [titles, setTitles] = useState<Record<string, string>>({});

  const terminals = useMemo(() => {
    const fromServer = overview.terminals.filter((t) => !removed.has(t.id));
    const known = new Set(fromServer.map((t) => t.id));
    return [...fromServer, ...created.filter((t) => !known.has(t.id) && !removed.has(t.id))].map((t) =>
      titles[t.id] !== undefined ? { ...t, title: titles[t.id]! } : t,
    );
  }, [overview.terminals, created, removed, titles]);

  useEffect(() => {
    const known = new Set(overview.terminals.map((t) => t.id));
    setCreated((c) => (c.some((t) => known.has(t.id)) ? c.filter((t) => !known.has(t.id)) : c));
    setRemoved((r) => (r.size > 0 && [...r].some((id) => !known.has(id)) ? new Set([...r].filter((id) => known.has(id))) : r));
    setTitles((ts) => {
      const stale = Object.keys(ts).filter((id) => overview.terminals.find((t) => t.id === id)?.title === ts[id] || !known.has(id));
      if (stale.length === 0) return ts;
      const next = { ...ts };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [overview.terminals]);

  const byId = useMemo(() => new Map(terminals.map((t) => [t.id, t])), [terminals]);
  const runsByKey = useMemo(() => new Map(overview.runs.map((r) => [`${r.workspaceId}/${r.id}`, r])), [overview.runs]);

  // Layout, saved on every change.
  const [state, setState] = useState<LayoutState>(() => loadLayout());
  useEffect(() => saveLayout(state), [state]);
  const update = useCallback((f: (s: LayoutState) => LayoutState) => setState((s) => f(s)), []);

  // Drop ids that no longer exist, once the server answered cleanly.
  const canPrune = overview.loaded && overview.failures === 0 && !overview.stale;
  useEffect(() => {
    if (!canPrune) return;
    update((s) =>
      prune(s, (item) => {
        const p = parseItem(item);
        if (!p) return false;
        return p.kind === "term" ? byId.has(p.id) : runsByKey.has(`${p.ws}/${p.runId}`);
      }),
    );
  }, [canPrune, byId, runsByKey, update]);

  const [maximized, setMaximized] = useState<number | null>(null);
  const [drawer, setDrawer] = useState(false);
  /** The New terminal dialog: open, and what it opens on (a session, a repository, a project, an agent). */
  const [newDialog, setNewDialog] = useState<{ open: boolean; initial?: NewTerminalInitial }>({ open: false });
  const newOpen = newDialog.open;
  /** The agent whose terminal is being created (its POST is running). */
  const [busyAgent, setBusyAgent] = useState<AgentId | undefined>(undefined);
  const agents = useAgents();
  const projects = useProjects();
  const toast = useToast();
  const [confirm, setConfirm] = useState<TerminalInfo | null>(null);
  /** The uncommitted-changes question of a session whose last terminal closed. */
  const [ask, setAsk] = useState<{ sessionId: string; label: string; changes?: string[]; error?: string } | null>(null);
  const [askBusy, setAskBusy] = useState<"push" | "keep" | "discard" | undefined>(undefined);
  /** "Discard all uncommitted changes in …?"; `fromAsk`: Cancel goes back to the question. */
  const [discard, setDiscard] = useState<{ sessionId: string; label: string; fromAsk: boolean } | null>(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState("");
  const [userId, setUserId] = useState<string | undefined>(undefined);

  // The signed-in user's id names the default branch (`gm/<user>-<date>-<4 chars>`); without it the server picks.
  useEffect(() => {
    let alive = true;
    api<{ user?: { id?: unknown } }>("/api/auth/me")
      .then((me) => alive && typeof me?.user?.id === "string" && setUserId(me.user.id))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const sessionById = useMemo(() => new Map(overview.sessions.map((x) => [x.id, x])), [overview.sessions]);
  const labelOf = useCallback(
    (sessionId: string, fallback?: string) => {
      const x = sessionById.get(sessionId);
      return x ? sessionLabel(x, projects) : (fallback ?? sessionId);
    },
    [sessionById, projects],
  );

  // The panes on screen: under 900px only the focused one, maximised only that one.
  const shown: number[] = narrow ? [state.focused] : maximized !== null && maximized < state.layout ? [maximized] : [0, 1, 2, 3].slice(0, state.layout);
  const focusedItem = state.panes[state.focused] ?? null;

  // The floating spec pane: the focused workspace's specs are watched; one that changes after the first answer opens.
  const focusedWs = itemWorkspace(focusedItem, (id) => byId.get(id));
  const specAnswer = useWorkspaceSpecs(focusedWs);
  const [specOpen, setSpecOpen] = useState<{ ws: string; path: string } | null>(null);
  const watch = useRef<{ ws?: string; watch: SpecWatch }>({ watch: {} });
  useEffect(() => {
    if (!focusedWs || specAnswer.ws !== focusedWs) return;
    if (watch.current.ws !== focusedWs) watch.current = { ws: focusedWs, watch: {} };
    const r = nextWatch(watch.current.watch, specAnswer.specs);
    watch.current.watch = r.watch;
    if (r.open) setSpecOpen({ ws: focusedWs, path: r.open });
  }, [specAnswer, focusedWs]);
  const latestSpec = specAnswer.ws === focusedWs ? newestSpec(specAnswer.specs) : undefined;

  // A run that starts in the focused workspace (the agent in its terminal started it) opens in the next free pane.
  const runWatch = useRef<RunWatch>(undefined);
  useEffect(() => {
    if (!overview.loaded || overview.failures > 0) return;
    const r = nextRunWatch(runWatch.current, overview.runs);
    runWatch.current = r.watch;
    const mine = r.started.find((run) => run.workspaceId === focusedWs);
    if (mine) update((s) => openInNextFree(s, runItem(mine.workspaceId, mine.id)));
  }, [overview.runs, overview.loaded, overview.failures, focusedWs, update]);

  const paneBadges = useMemo(() => {
    const m = new Map<string, { n: number; focused: boolean }>();
    for (const i of shown) {
      const p = parseItem(state.panes[i] ?? "");
      if (p?.kind === "term") m.set(p.id, { n: i + 1, focused: i === state.focused });
    }
    return m;
  }, [shown.join(","), state.panes, state.focused]);
  // An agent's Start run request for a terminal on screen pops up here (AgentRequestHost).
  useSetVisibleTerminals(useMemo(() => new Set(paneBadges.keys()), [paneBadges]));

  const openTerm = useCallback((id: string) => update((s) => openItem(s, termItem(id))), [update]);
  const openRun = useCallback((r: RunSummary) => update((s) => openInNextFree(s, runItem(r.workspaceId, r.id))), [update]);

  const focusPaneN = useCallback(
    (n: number) => {
      setMaximized((m) => (m !== null && m !== n ? null : m));
      update((s) => focusPane(s, n));
    },
    [update],
  );

  // Creating and closing.
  /** Shows a terminal the server just opened (before the next poll lists it) and puts it in the focused pane. */
  const showOpened = useCallback(
    (r: Opened) => {
      const info: TerminalInfo = {
        id: r.terminalId,
        title: r.title ?? r.label,
        cwd: "",
        ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
        ...(r.agent ? { agent: r.agent } : {}),
        sessionId: r.sessionId,
        status: "idle",
        createdAt: new Date().toISOString(),
      };
      setCreated((c) => [...c.filter((t) => t.id !== info.id), info]);
      update((s) => openItem(s, termItem(info.id)));
      setError("");
      void overview.refresh();
    },
    [update, overview],
  );

  const openNew = useCallback((initial?: NewTerminalInitial) => setNewDialog({ open: true, ...(initial ? { initial } : {}) }), []);

  /** A new terminal in a live session; the error shows on the page. */
  const openInSession = useCallback(
    async (x: SessionInfo) => {
      try {
        const info = await post<TerminalInfo>(`/api/sessions/${encodeURIComponent(x.id)}/terminals`, {});
        showOpened({ sessionId: x.id, terminalId: info.id, branch: x.branch, label: info.title || labelOf(x.id), workspaceId: info.workspaceId ?? x.workspaceId, title: info.title });
        return info.id;
      } catch (err) {
        setError(err instanceof ApiError ? err.error : err instanceof Error ? err.message : String(err));
        return undefined;
      }
    },
    [showOpened, labelOf],
  );

  const destroy = useCallback(
    async (t: TerminalInfo) => {
      setRemoved((r) => new Set(r).add(t.id));
      update((s) => closeItem(s, termItem(t.id)));
      try {
        const res = await api<{ sessionId?: string; ask?: { changes?: string[] } } | undefined>(`/api/terminals/${encodeURIComponent(t.id)}`, { method: "DELETE" });
        if (res?.ask && res.sessionId) {
          setAsk({
            sessionId: res.sessionId,
            label: labelOf(res.sessionId, t.workspaceId ? workspacePath(t.workspaceId, overview.sessions) : undefined),
            changes: Array.isArray(res.ask.changes) ? res.ask.changes : [],
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      void overview.refresh();
    },
    [update, overview, labelOf],
  );

  /** Answers a session's close question (or retries / discards a failed push). */
  const closeSession = useCallback(
    async (sessionId: string, action: "push" | "keep" | "discard") => {
      const label = labelOf(sessionId, ask?.sessionId === sessionId ? ask.label : undefined);
      setAskBusy(action);
      try {
        const res = await post<CloseResult>(`/api/sessions/${encodeURIComponent(sessionId)}/close`, { action });
        if (action === "push" && res?.session?.state === "save-failed") {
          setAsk((a) => (a && a.sessionId === sessionId ? { ...a, error: res.session.error ?? "The push failed." } : a));
        } else {
          setAsk((a) => (a?.sessionId === sessionId ? null : a));
          if (action === "push") {
            const skipped = res?.skipped ?? [];
            const branch = res?.session?.branch ?? sessionById.get(sessionId)?.branch ?? "the branch";
            toast.show({ tone: "ok", text: skipped.length > 0 ? `Pushed to ${branch}. Not committed: ${skipped.join(", ")}` : `Pushed to ${branch}.` });
          } else if (action === "discard") {
            toast.show({ tone: "ok", text: `Discarded the changes in ${label}.` });
          }
        }
      } catch (err) {
        const text = err instanceof ApiError ? err.error : err instanceof Error ? err.message : String(err);
        if (ask?.sessionId === sessionId) setAsk((a) => (a ? { ...a, error: text } : a));
        else setError(text);
      } finally {
        setAskBusy(undefined);
        void overview.refresh();
      }
    },
    [labelOf, ask, sessionById, toast, overview],
  );

  /** The question of a session that is `asking` with no dialog open (e.g. after a reload). */
  const reopenAsk = useCallback(
    (sessionId: string) => {
      const x = sessionById.get(sessionId);
      setAsk({ sessionId, label: labelOf(sessionId), ...(x?.changes ? { changes: x.changes } : {}) });
    },
    [sessionById, labelOf],
  );

  /** × on a tab or a pane: a terminal running a program (not a shell) asks first; a run tab just closes. */
  const closeItemId = useCallback(
    (item: ItemId | null) => {
      if (!item) return;
      const p = parseItem(item);
      if (p?.kind === "term") {
        const t = byId.get(p.id);
        if (!t) return update((s) => closeItem(s, item));
        if (needsCloseConfirm(t)) setConfirm(t);
        else void destroy(t);
      } else {
        update((s) => closeItem(s, item));
      }
    },
    [byId, destroy, update],
  );

  /** Drops `names` from the URL and sets `focus` when given. */
  const replaceParams = useCallback(
    (names: string[], focus?: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const n of names) next.delete(n);
          if (focus) next.set("focus", focus);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  // `?new=1` opens the New terminal dialog once (StrictMode-safe).
  const newHandled = useRef(false);
  const newParam = params.get("new");
  useEffect(() => {
    if (!newParam || newHandled.current) return;
    newHandled.current = true;
    openNew();
    replaceParams(["new"]);
  }, [newParam, openNew, replaceParams]);

  // `?session=<id>` opens the session's terminals (the first in the focused pane, the rest as tabs), then becomes
  // `?focus=<first>`; a session without terminals opens the dialog on it. Waits for the sessions.
  const sessionHandled = useRef<string | null>(null);
  const sessionParam = params.get("session");
  useEffect(() => {
    if (!sessionParam || sessionHandled.current === sessionParam || !overview.loaded) return;
    sessionHandled.current = sessionParam;
    const x = sessionById.get(sessionParam);
    const ids = x ? terminals.filter((t) => x.terminals.includes(t.id) || t.sessionId === x.id).map((t) => t.id) : [];
    if (x && ids.length > 0) {
      update((s) => {
        const tabs = [...s.tabs];
        for (const id of ids.slice(1)) if (!tabs.includes(termItem(id))) tabs.push(termItem(id));
        return { ...s, tabs };
      });
      replaceParams(["session"], ids[0]);
    } else {
      if (x) openNew({ sessionId: x.id });
      replaceParams(["session"]);
    }
  }, [sessionParam, overview.loaded, sessionById, terminals, update, openNew, replaceParams]);

  // `?workspace=<id>` (Runs' "Open terminal") opens a terminal in that workspace's live session once, then becomes
  // `?focus=<id>`; without a live session it opens the dialog with the repository picked.
  const handled = useRef<string | null>(null);
  const workspaceParam = params.get("workspace");
  useEffect(() => {
    if (!workspaceParam || handled.current === workspaceParam || !overview.loaded) return;
    handled.current = workspaceParam;
    const live = overview.sessions.find((x) => x.workspaceId === workspaceParam && (x.state === "live" || x.state === "asking"));
    if (live) {
      void openInSession(live).then((id) => replaceParams(["workspace"], id));
      return;
    }
    const repo = repoOfWorkspace(workspaceParam);
    const projectId = workspaceParam.startsWith("project~") ? workspaceParam.slice("project~".length) : undefined;
    openNew(repo ? { repo } : projectId ? { projectId } : undefined);
    replaceParams(["workspace"]);
  }, [workspaceParam, overview.loaded, overview.sessions, openInSession, openNew, replaceParams]);

  // `?project=<id>[&agent=<agentId>]` opens the dialog with the project (and agent) picked, once. An unknown agent is ignored.
  const projectHandled = useRef<string | null>(null);
  const projectParam = params.get("project");
  const agentParam = params.get("agent");
  useEffect(() => {
    const key = projectParam ? `${projectParam}:${agentParam ?? ""}` : null;
    if (!projectParam || !key || projectHandled.current === key) return;
    projectHandled.current = key;
    const agent = URL_AGENTS.find((a) => a === agentParam);
    openNew({ projectId: projectParam, ...(agent ? { agent } : {}) });
    replaceParams(["project", "agent"]);
  }, [projectParam, agentParam, openNew, replaceParams]);

  const focusParam = params.get("focus");
  const focusHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!focusParam || focusHandled.current === focusParam) return;
    focusHandled.current = focusParam;
    openTerm(focusParam);
  }, [focusParam, openTerm]);

  const runParam = params.get("run");
  const runHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!runParam || runHandled.current === runParam) return;
    const slash = runParam.indexOf("/");
    if (slash <= 0) return;
    runHandled.current = runParam;
    update((s) => openItem(s, runItem(runParam.slice(0, slash), runParam.slice(slash + 1))));
  }, [runParam, update]);

  // j/k/Enter in the sidebar.
  const order = useMemo(() => shownOrder(terminals, overview.sessions, projects), [terminals, overview.sessions, projects]);

  // An empty screen takes a terminal into the focused pane: one that isn't on screen (one opened elsewhere, or after a server restart,
  // or under 900px where only the focused pane shows), so the page never sits blank while the sidebar lists one.
  // Wide: only terminals that have no tab yet (tabs the user arranged stay where they are). Narrow: the tab bar is
  // hidden, so any terminal outside the one visible pane.
  const shownKey = shown.join(",");
  useEffect(() => {
    // Only when nothing is on screen: an empty pane next to a busy one is the user's choice.
    if (shownKey.split(",").some((i) => state.panes[Number(i)] != null)) return;
    const taken = new Set<ItemId>(narrow ? [] : [...state.tabs, ...state.panes.filter((p): p is ItemId => p != null)]);
    const candidate = [...order, ...terminals].find((t) => !taken.has(termItem(t.id)));
    if (!candidate) return;
    update((s) => (s.panes[s.focused] != null ? s : openItem(s, termItem(candidate.id), s.focused)));
  }, [state.panes, state.tabs, shownKey, narrow, order, terminals, update]);
  const [selected] = useListNav(order.length, {
    onOpen: (i) => {
      const t = order[i];
      if (t) {
        openTerm(t.id);
        setDrawer(false);
      }
    },
    enabled: !newOpen && confirm === null && ask === null && discard === null,
  });

  // The Ctrl Space prefix: works everywhere on the page, including inside an xterm. The key after it never reaches
  // the shell: the window capture listener swallows it before xterm's textarea sees it, and the xterm key filter
  // (attachCustomKeyEventHandler) refuses it as well.
  const armedRef = useRef(false);
  const armTimer = useRef<number | undefined>(undefined);
  const arm = (on: boolean) => {
    armedRef.current = on;
    setArmed(on);
    window.clearTimeout(armTimer.current);
    if (on) armTimer.current = window.setTimeout(() => arm(false), PREFIX_MS);
  };
  const actions = useRef<(key: string) => void>(() => {});
  actions.current = (key: string) => {
    if (key === "n") openNew();
    else if (key === "x") closeItemId(focusedItem);
    else if (key >= "1" && key <= "4") focusPaneN(Number(key) - 1);
    else if (key === "|" || key === "\\") {
      setMaximized(null);
      update(cycleLayout);
    }
  };
  const modal = newOpen || confirm !== null || ask !== null || discard !== null;
  const modalRef = useRef(modal);
  modalRef.current = modal;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalRef.current || e.isComposing) return;
      if (isPrefix(e)) {
        e.preventDefault();
        e.stopPropagation();
        arm(true);
        return;
      }
      if (!armedRef.current || MODIFIERS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      arm(false);
      actions.current(e.key.toLowerCase() === e.key ? e.key : e.key.toLowerCase());
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(armTimer.current);
    };
  }, []);

  const keyFilter = useCallback((e: KeyboardEvent) => !(isPrefix(e) || armedRef.current), []);

  const onExited = useCallback(() => void overview.refresh(), [overview]);

  // Rendering helpers.
  const pathOf = (t: TerminalInfo) => (t.workspaceId ? workspacePath(t.workspaceId, overview.sessions) : t.cwd);

  const chrome = (i: number): PaneChrome => ({
    pane: i,
    focused: i === state.focused,
    maximized: maximized === i,
    onFocus: () => {
      if (state.focused !== i) update((s) => focusPane(s, i));
    },
    onMaximize: () => setMaximized((m) => (m === i ? null : i)),
    onClose: () => closeItemId(state.panes[i] ?? null),
  });

  const renderPane = (i: number) => {
    const item = state.panes[i] ?? null;
    const p = item ? parseItem(item) : undefined;
    if (p?.kind === "term") {
      const t = byId.get(p.id);
      if (t)
        return (
          <TerminalPane
            key={`${i}:${item}`}
            chrome={chrome(i)}
            term={t}
            path={pathOf(t)}
            liveRun={liveRunsIn(overview.runs, t.workspaceId)[0]}
            spec={latestSpec && t.workspaceId === focusedWs ? latestSpec : undefined}
            keyFilter={keyFilter}
            onOpenRun={openRun}
            onOpenSpec={(path) => focusedWs && setSpecOpen({ ws: focusedWs, path })}
            onExited={onExited}
            onRestarted={onExited}
          />
        );
    } else if (p?.kind === "run") {
      return <RunPane key={`${i}:${item}`} chrome={chrome(i)} ws={p.ws} runId={p.runId} path={workspacePath(p.ws, overview.sessions)} summary={runsByKey.get(`${p.ws}/${p.runId}`)} />;
    }
    return <EmptyPane key={`${i}:empty`} chrome={chrome(i)} />;
  };

  const empty = overview.loaded && terminals.length === 0 && state.tabs.length === 0;
  const cols = shown.length === 1 ? 1 : 2;
  const rows = shown.length === 4 ? 2 : 1;

  return (
    <section data-testid="page-terminals" className={`page terms-page${narrow ? " narrow" : ""}`}>
      {(!narrow || drawer) && (
        <>
          {narrow && <div className="tsb-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
          <TerminalSidebar
            className={narrow ? "drawer" : ""}
            terminals={terminals}
            sessions={overview.sessions}
            limit={overview.sessionLimit}
            projects={projects}
            runs={overview.runs}
            panes={paneBadges}
            selected={selected}
            onOpen={(id) => {
              openTerm(id);
              setDrawer(false);
            }}
            onOpenRun={(r) => {
              openRun(r);
              setDrawer(false);
            }}
            onNew={() => {
              openNew();
              setDrawer(false);
            }}
            onNewInSession={(id) => {
              openNew({ sessionId: id });
              setDrawer(false);
            }}
            onRetry={(id) => void closeSession(id, "push")}
            onDiscard={(id) => setDiscard({ sessionId: id, label: labelOf(id), fromAsk: false })}
            onAsk={reopenAsk}
            agents={agents}
            busyAgent={busyAgent}
            onNewAgent={(id) => {
              openNew({ agent: id });
              setDrawer(false);
            }}
          />
        </>
      )}
      <main className="terms-main">
        {narrow && (
          <div className="terms-topbar">
            <button type="button" className="btn btn-sm" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)} data-testid="sidebar-toggle">
              <Icon name="menu" size={14} />
              Terminals <span className="num muted">{terminals.length}</span>
            </button>
            <span className="tp-spacer" />
            <button type="button" className="btn btn-primary btn-sm btn-icon" aria-label="New terminal" onClick={() => openNew()}>
              <Icon name="plus" size={14} />
            </button>
          </div>
        )}
        {empty ? (
          <div className="terms-empty-wrap">
            <div className="terms-empty" data-testid="terminals-empty">
              <h2>No terminals open</h2>
              <p>Open a repository to start a session.</p>
              <button type="button" className="btn btn-primary" onClick={() => openNew()}>
                New terminal <Kbd>Ctrl Space n</Kbd>
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="terms-tabbar">
              <div role="tablist" aria-label="Open terminals" className="terms-tabs">
                {state.tabs.map((item) => (
                  <Tab
                    key={item}
                    item={item}
                    selected={item === focusedItem}
                    term={(() => {
                      const p = parseItem(item);
                      return p?.kind === "term" ? byId.get(p.id) : undefined;
                    })()}
                    onSelect={() => update((s) => openItem(s, item, s.focused))}
                    onClose={() => closeItemId(item)}
                    onRename={async (id, title) => {
                      setTitles((ts) => ({ ...ts, [id]: title }));
                      try {
                        await post(`/api/terminals/${encodeURIComponent(id)}`, { title }, "PATCH");
                        void overview.refresh();
                      } catch (err) {
                        setTitles((ts) => {
                          const next = { ...ts };
                          delete next[id];
                          return next;
                        });
                        setError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  />
                ))}
              </div>
              {!narrow && (
                <div role="group" aria-label="Layout" className="terms-layouts">
                  {([1, 2, 4] as PaneCount[]).map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-label={n === 1 ? "Single pane" : n === 2 ? "Two panes" : "Four panes"}
                      aria-pressed={state.layout === n && maximized === null}
                      data-testid={`layout-${n}`}
                      onClick={() => {
                        setMaximized(null);
                        update((s) => setLayout(s, n));
                      }}
                    >
                      <Icon name={`layout-${n}` as IconName} size={14} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            {error && (
              <div className="terms-error" role="alert">
                {error}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError("")}>
                  Dismiss
                </button>
              </div>
            )}
            <div className="terms-grid" data-testid="pane-grid" data-panes={shown.length} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
              {shown.map(renderPane)}
            </div>
          </>
        )}
        {specOpen && focusedWs && specOpen.ws === focusedWs && (
          <SpecFloat
            key={specOpen.ws}
            ws={specOpen.ws}
            path={specOpen.path}
            specs={specAnswer.specs}
            narrow={narrow}
            onSelect={(path) => setSpecOpen({ ws: focusedWs, path })}
            onClose={() => setSpecOpen(null)}
          />
        )}
      </main>
      {armed && (
        <div className="prefix-hint" role="status" data-testid="prefix-hint">
          <Kbd>Ctrl Space</Kbd>…
        </div>
      )}
      <NewTerminalDialog
        open={newDialog.open}
        sessions={overview.sessions}
        projects={projects}
        agents={agents}
        initial={newDialog.initial}
        userId={userId}
        onCancel={() => setNewDialog({ open: false })}
        onBusyAgent={setBusyAgent}
        onOpened={(r) => {
          setNewDialog({ open: false });
          showOpened(r);
        }}
      />
      <CloseSessionDialog
        open={ask !== null && discard === null}
        label={ask?.label ?? ""}
        changes={ask?.changes}
        error={ask?.error}
        busy={askBusy}
        onPush={() => ask && void closeSession(ask.sessionId, "push")}
        onKeep={() => ask && void closeSession(ask.sessionId, "keep")}
        onDiscard={() => ask && setDiscard({ sessionId: ask.sessionId, label: ask.label, fromAsk: true })}
      />
      <ConfirmDialog
        open={discard !== null}
        title={`Discard all uncommitted changes in ${discard?.label ?? ""}?`}
        body="The changed files go back to the branch's last commit. This cannot be undone."
        cancelLabel="Cancel"
        confirmLabel="Discard"
        tone="danger"
        busy={askBusy !== undefined}
        onCancel={() => setDiscard(null)}
        onConfirm={() => {
          const d = discard;
          setDiscard(null);
          if (d) void closeSession(d.sessionId, "discard");
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={`Close “${confirm?.title ?? ""}”?`}
        body={confirm ? `${confirm.process ?? "The process"} is running. Closing the tab ends it and its scrollback.` : ""}
        cancelLabel="Keep running"
        confirmLabel="Close terminal"
        tone="danger"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const t = confirm;
          setConfirm(null);
          if (t) void destroy(t);
        }}
      />
    </section>
  );
}

function Tab({
  item,
  term,
  selected,
  onSelect,
  onClose,
  onRename,
}: {
  item: ItemId;
  term?: TerminalInfo;
  selected: boolean;
  onSelect(): void;
  onClose(): void;
  onRename(id: string, title: string): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const p = parseItem(item);
  const label = p?.kind === "run" ? `run ${last4(p.runId)}` : (term?.title ?? p?.id ?? item);
  const commit = () => {
    const title = draft.trim();
    setEditing(false);
    if (term && title && title !== term.title && title.length <= 200) void onRename(term.id, title);
  };
  return (
    <div role="tab" aria-selected={selected} className={`terms-tab${selected ? " selected" : ""}`} data-testid={`tab-${item}`} onClick={onSelect}>
      {!term && <StatusGlyph tone="live" glyph="dot" />}
      {editing ? (
        <input
          className="terms-tab-input"
          aria-label="Terminal title"
          value={draft}
          maxLength={200}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setEditing(false);
            e.stopPropagation();
          }}
        />
      ) : (
        <span
          className="terms-tab-label"
          onDoubleClick={(e) => {
            if (!term) return;
            e.stopPropagation();
            setDraft(term.title);
            setEditing(true);
          }}
          title={term ? "Double-click to rename" : undefined}
        >
          {label}
        </span>
      )}
      <button
        type="button"
        className="terms-tab-close"
        aria-label={`Close ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}

/** The agents `?agent=` may name. */
const URL_AGENTS: AgentId[] = ["claude", "codex", "opencode", "qwen"];
