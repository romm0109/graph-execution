// Terminals (boards 07, 08, 09, 19): grouped sidebar, tabs, a 1/2/4-pane split of terminals and runs, the Ctrl Space
// prefix, restart and reconnect.

import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, post } from "../api";
import { useSetVisibleTerminals } from "../agentRequests";
import { ExtraKeys } from "../components/ExtraKeys";
import type { TerminalHandle } from "../components/TerminalView";
import { useListNav } from "../keys";
import { useOverview } from "../overview";
import { nextRunWatch, type RunWatch } from "../runs";
import type { AgentId, AgentInfo, BranchList, KeptProjectWorktree, KeptWorktree, ProjectEntry, ProjectWork, RunSummary, TerminalInfo, WorkspaceEntry } from "../types";
import { ConfirmDialog } from "../ui/Dialog";
import { useFocusTrap } from "../ui/focus";
import { Icon, type IconName } from "../ui/Icon";
import { Kbd } from "../ui/Kbd";
import { COARSE, NARROW, useMedia } from "../ui/media";
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
import { SpecFloat, terminalSpecs, useSpecs, workspaceSpecs, type SpecEntry } from "./SpecFloat";
import { nextWatch, type SpecWatch } from "./specPane";
import { EmptyPane, RunPane, TerminalPane, type PaneChrome } from "./TerminalPane";
import { TerminalSidebar, last4, liveRunsIn, shownOrder, workspacePath } from "./TerminalSidebar";
import "./Terminals.css";
import { mergeConflictFiles, mergeErrorText, ProjectWorktreeCloseDialog, WorktreeCloseDialog, workText, type WorktreeWork } from "./WorktreeClose";
import { WorktreePrDialog, type WorktreePrTarget } from "./WorktreePr";
import { ProjectWorktreePrDialog, type ProjectWorktreePrTarget } from "./ProjectWorktreePr";

export type { TerminalInfo };

/** How long the Ctrl Space prefix waits for the next key. */
export const PREFIX_MS = 1500;

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
  const narrow = useMedia(NARROW);
  const coarse = useMedia(COARSE);

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
  const [newOpen, setNewOpen] = useState(false);
  /** The agent the New terminal dialog opens, while it is open for one. */
  const [newAgent, setNewAgent] = useState<AgentInfo | undefined>(undefined);
  /** What the New terminal dialog preselects when a one-click link (`?workspace=`, `?project=`) opened it. */
  const [newDefaults, setNewDefaults] = useState<{ workspace?: string; project?: string }>({});
  /** The agent whose terminal is being created (its POST is running). */
  const [busyAgent, setBusyAgent] = useState<AgentId | undefined>(undefined);
  const agents = useAgents();
  const projects = useProjects();
  const [confirm, setConfirm] = useState<TerminalInfo | null>(null);
  const [deleting, setDeleting] = useState<KeptWorktree | null>(null);
  const [deletingProject, setDeletingProject] = useState<KeptProjectWorktree | null>(null);
  const [prFor, setPrFor] = useState<WorktreePrTarget | null>(null);
  const [projectPrFor, setProjectPrFor] = useState<ProjectWorktreePrTarget | null>(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState("");

  // The panes on screen: under 900px only the focused one, maximised only that one.
  const shown: number[] = narrow ? [state.focused] : maximized !== null && maximized < state.layout ? [maximized] : [0, 1, 2, 3].slice(0, state.layout);
  const focusedItem = state.panes[state.focused] ?? null;

  // The extra-keys row (touch screens): it types into the focused terminal through a stable proxy of its handle.
  const termHandle = useRef<TerminalHandle | null>(null);
  const keysHandle = useMemo<TerminalHandle>(
    () => ({
      input: (d) => termHandle.current?.input(d),
      focus: () => termHandle.current?.focus(),
      appCursor: () => termHandle.current?.appCursor() ?? false,
    }),
    [],
  );
  // Sticky Ctrl: the ref is read inside xterm's onData. One use or a pane change drops it.
  const [ctrl, setCtrlState] = useState(false);
  const ctrlRef = useRef(false);
  const setCtrl = useCallback((on: boolean) => {
    ctrlRef.current = on;
    setCtrlState(on);
  }, []);
  const ctrlArmed = useCallback(() => ctrlRef.current, []);
  const onCtrlUsed = useCallback(() => setCtrl(false), [setCtrl]);
  useEffect(() => setCtrl(false), [state.focused, focusedItem, setCtrl]);
  // The row shows while a terminal (or the row itself) has focus.
  const [termFocused, setTermFocused] = useState(false);
  const keysRef = useRef<HTMLDivElement>(null);
  const inTerminal = (n: EventTarget | null) => n instanceof Element && n.closest(".tp-body") !== null;
  const onGridBlur = (e: FocusEvent) => {
    const next = e.relatedTarget;
    if (inTerminal(next) || (next instanceof Node && keysRef.current?.contains(next))) return;
    setTermFocused(false);
  };
  const showKeys = coarse && termFocused;
  // Toasts are fixed outside the page: a class on <html> lifts them above the row.
  useEffect(() => {
    document.documentElement.classList.toggle("xk-open", showKeys);
    return () => document.documentElement.classList.remove("xk-open");
  }, [showKeys]);

  // The floating spec pane (KAN-99): the focused terminal's own worktree is watched (its workspace for a terminal
  // without one, or a run); a spec created after the first answer opens it, edits never do.
  const focusedWs = itemWorkspace(focusedItem, (id) => byId.get(id));
  const focusedParsed = parseItem(focusedItem ?? "");
  const focusedTerm = focusedParsed?.kind === "term" ? byId.get(focusedParsed.id) : undefined;
  const specSource = focusedTerm?.worktree ? terminalSpecs(focusedTerm.id) : focusedWs ? workspaceSpecs(focusedWs) : undefined;
  const specAnswer = useSpecs(specSource);
  const [specOpen, setSpecOpen] = useState<{ ws: string; path: string } | null>(null);
  const watches = useRef(new Map<string, SpecWatch>());
  useEffect(() => {
    if (!specSource || specAnswer.ws !== specSource) return;
    const r = nextWatch(watches.current.get(specSource) ?? {}, specAnswer.specs);
    watches.current.set(specSource, r.watch);
    if (r.open) setSpecOpen({ ws: specSource, path: r.open });
  }, [specAnswer, specSource]);
  const latestSpec = specAnswer.ws === specSource ? newestSpec(specAnswer.specs) : undefined;

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
  /** Creates the terminal and opens it in a pane; throws the server's error. */
  const toast = useToast();
  const createOrThrow = useCallback(
    async (body: NewTerminalBody) => {
      const answer = await post<TerminalInfo>("/api/terminals", body);
      const { warnings, ...info } = answer;
      // e.g. origin could not be fetched and the worktree was cut from the local branch.
      if (Array.isArray(warnings) && warnings.length > 0) toast.show({ tone: "bad", text: warnings.join(" ") });
      setCreated((c) => [...c.filter((t) => t.id !== info.id), info]);
      update((s) => openItem(s, termItem(info.id)));
      setError("");
      void overview.refresh();
      return info;
    },
    [update, overview, toast],
  );
  /** `createOrThrow` with the error shown on the page. */
  const create = useCallback(
    async (body: NewTerminalBody) => {
      try {
        return await createOrThrow(body);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return undefined;
      }
    },
    [createOrThrow],
  );

  // Kept terminal worktrees (KAN-100), listed in the sidebar.
  const [kept, setKept] = useState<KeptWorktree[]>([]);
  const [keptProjects, setKeptProjects] = useState<KeptProjectWorktree[]>([]);
  const loadKept = useCallback(async () => {
    try {
      const r = await api<{ worktrees?: KeptWorktree[]; projectWorktrees?: KeptProjectWorktree[] }>("/api/worktrees");
      setKept(Array.isArray(r?.worktrees) ? r.worktrees : []);
      setKeptProjects(Array.isArray(r?.projectWorktrees) ? r.projectWorktrees : []);
    } catch {
      // keep the last list
    }
  }, []);
  useEffect(() => {
    void loadKept();
    const timer = setInterval(() => void loadKept(), 5000);
    return () => clearInterval(timer);
  }, [loadKept]);
  /** A terminal whose worktree holds work, waiting for Delete / Keep / Create PR. */
  const [closing, setClosing] = useState<{ term: TerminalInfo; work: WorktreeWork } | null>(null);
  /** A project terminal whose worktrees hold work, waiting for Delete all / Keep all. */
  const [closingProject, setClosingProject] = useState<{ term: TerminalInfo; work: ProjectWork } | null>(null);

  const destroy = useCallback(
    async (t: TerminalInfo, choice?: "delete" | "keep") => {
      const url = `/api/terminals/${encodeURIComponent(t.id)}${choice ? `?worktree=${choice}` : ""}`;
      if (t.worktree && !choice) {
        // A worktree terminal closes only once the server agrees: with work in it, the user chooses first.
        try {
          await api(url, { method: "DELETE" });
        } catch (err) {
          const body =
            err instanceof ApiError
              ? (err.body as
                  | {
                      needsChoice?: boolean;
                      dirty?: number;
                      ahead?: number;
                      branch?: string;
                      project?: { dirty?: number; ahead?: number };
                      repos?: { name: string; isolated?: boolean; dirty?: number; ahead?: number }[];
                    }
                  | undefined)
              : undefined;
          if (err instanceof ApiError && err.status === 409 && body?.needsChoice && Array.isArray(body.repos)) {
            setClosingProject({
              term: t,
              work: {
                title: t.title,
                branch: body.branch ?? t.worktree.branch,
                project: { dirty: body.project?.dirty ?? 0, ahead: body.project?.ahead ?? 0 },
                repos: body.repos.map((r) => ({ name: r.name, isolated: r.isolated === true, dirty: r.dirty ?? 0, ahead: r.ahead ?? 0 })),
              },
            });
            return;
          }
          if (err instanceof ApiError && err.status === 409 && body?.needsChoice) {
            setClosing({ term: t, work: { title: t.title, branch: body.branch ?? t.worktree.branch, dirty: body.dirty ?? 0, ahead: body.ahead ?? 0 } });
            return;
          }
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
        setRemoved((r) => new Set(r).add(t.id));
        update((s) => closeItem(s, termItem(t.id)));
        void overview.refresh();
        void loadKept();
        return;
      }
      setRemoved((r) => new Set(r).add(t.id));
      update((s) => closeItem(s, termItem(t.id)));
      try {
        await api(url, { method: "DELETE" });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      void overview.refresh();
      void loadKept();
    },
    [update, overview, loadKept],
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

  // `?workspace=<id>` opens the New terminal dialog on that workspace once (StrictMode-safe); Create then sets `?focus=<id>`.
  const handled = useRef<string | null>(null);
  const workspaceParam = params.get("workspace");
  useEffect(() => {
    if (!workspaceParam || handled.current === workspaceParam) return;
    handled.current = workspaceParam;
    setNewDefaults({ workspace: workspaceParam });
    setNewAgent(undefined);
    setNewOpen(true);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("workspace");
        return next;
      },
      { replace: true },
    );
  }, [workspaceParam, setParams]);

  // `?project=<id>[&agent=<agentId>]` opens the dialog on the project once, the same way. An unknown agent is ignored.
  const projectHandled = useRef<string | null>(null);
  const projectParam = params.get("project");
  const agentParam = params.get("agent");
  useEffect(() => {
    const key = projectParam ? `${projectParam}:${agentParam ?? ""}` : null;
    if (!projectParam || !key || projectHandled.current === key) return;
    projectHandled.current = key;
    const named = URL_AGENTS.find((a) => a === agentParam);
    setNewDefaults({ project: projectParam });
    setNewAgent(named ? agents.find((a) => a.id === named) : undefined);
    setNewOpen(true);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("project");
        next.delete("agent");
        return next;
      },
      { replace: true },
    );
  }, [projectParam, agentParam, agents, setParams]);

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
  const order = useMemo(() => shownOrder(terminals, overview.workspaces, projects), [terminals, overview.workspaces, projects]);

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
    enabled: !newOpen && confirm === null && closing === null && deleting === null && prFor === null && projectPrFor === null,
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
  const openNew = () => {
    setNewAgent(undefined);
    setNewDefaults({});
    setNewOpen(true);
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
  const modal = newOpen || confirm !== null || closing !== null || deleting !== null || prFor !== null || projectPrFor !== null;
  const modalRef = useRef(modal);
  modalRef.current = modal;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalRef.current || e.isComposing) return;
      // Android's keyboard reports every key this way; the character then arrives through xterm's onData (onPrefixData).
      if (armedRef.current && (e.key === "Unidentified" || e.keyCode === 229)) return;
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
  // The key after the prefix, typed on a phone keyboard (it only reaches xterm's onData).
  const onPrefixData = useCallback((data: string) => {
    if (!armedRef.current || data.length !== 1) return false;
    arm(false);
    actions.current(data.toLowerCase());
    return true;
  }, []);

  const onExited = useCallback(() => void overview.refresh(), [overview]);

  // Rendering helpers.
  const pathOf = (t: TerminalInfo) => (t.workspaceId ? workspacePath(t.workspaceId, overview.workspaces) : t.projectId ? t.cwd : overview.workspacesRoot ?? t.cwd);

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
            spec={latestSpec && (t.worktree ? t.id === focusedTerm?.id : t.workspaceId === focusedWs) ? latestSpec : undefined}
            keyFilter={keyFilter}
            onOpenRun={openRun}
            onOpenSpec={(path) => specSource && setSpecOpen({ ws: specSource, path })}
            onExited={onExited}
            onRestarted={onExited}
            handleRef={i === state.focused ? termHandle : undefined}
            ctrlArmed={i === state.focused ? ctrlArmed : undefined}
            onCtrlUsed={i === state.focused ? onCtrlUsed : undefined}
            onPrefixData={i === state.focused ? onPrefixData : undefined}
          />
        );
    } else if (p?.kind === "run") {
      return <RunPane key={`${i}:${item}`} chrome={chrome(i)} ws={p.ws} runId={p.runId} path={workspacePath(p.ws, overview.workspaces)} summary={runsByKey.get(`${p.ws}/${p.runId}`)} />;
    }
    return <EmptyPane key={`${i}:empty`} chrome={chrome(i)} />;
  };

  const empty = overview.loaded && terminals.length === 0 && state.tabs.length === 0;
  const cols = shown.length === 1 ? 1 : 2;
  const rows = shown.length === 4 ? 2 : 1;

  return (
    <section data-testid="page-terminals" className={`page terms-page${narrow ? " narrow" : ""}${showKeys ? " xk" : ""}`}>
      {(!narrow || drawer) && (
        <>
          {narrow && <div className="tsb-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
          <TerminalSidebar
            className={narrow ? "drawer" : ""}
            terminals={terminals}
            workspaces={overview.workspaces}
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
            onNew={openNew}
            agents={agents}
            busyAgent={busyAgent}
            kept={kept}
            onOpenKept={(w) => {
              void create({ workspaceId: w.workspaceId, worktreeId: w.id }).then(() => loadKept());
              setDrawer(false);
            }}
            onDeleteKept={(w) => setDeleting(w)}
            keptProjects={keptProjects}
            onOpenKeptProject={(w) => {
              void create({ projectId: w.projectId, projectWorktreeId: w.id }).then(() => loadKept());
              setDrawer(false);
            }}
            onDeleteKeptProject={(w) => setDeletingProject(w)}
            onMergeKeptProject={(w) => {
              void post(`/api/projects/${encodeURIComponent(w.projectId)}/worktrees/${encodeURIComponent(w.id)}/merge-project`)
                .then(() => {
                  toast.show({ tone: "ok", text: "Merged project files" });
                  void loadKept();
                })
                .catch((err: unknown) => {
                  const files = mergeConflictFiles(err);
                  toast.show({ tone: "bad", text: files ? `Merge conflict in: ${files.join(", ")}` : mergeErrorText(err) });
                });
            }}
            onPrKeptProject={(w) => {
              setProjectPrFor({ projectId: w.projectId, worktreeId: w.id, title: w.title, repos: w.repos });
              setDrawer(false);
            }}
            onPrKept={(w) => {
              setPrFor({ workspaceId: w.workspaceId, worktreeId: w.id, title: w.title, branch: w.branch });
              setDrawer(false);
            }}
            onNewAgent={(id) => {
              const a = agents.find((x) => x.id === id);
              if (!a) return;
              setNewAgent(a);
              setNewDefaults({});
              setNewOpen(true);
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
            <button type="button" className="btn btn-primary btn-sm btn-icon" aria-label="New terminal" onClick={openNew}>
              <Icon name="plus" size={14} />
            </button>
          </div>
        )}
        {empty ? (
          <div className="terms-empty-wrap">
            <div className="terms-empty" data-testid="terminals-empty">
              <h2>No terminals open</h2>
              <p>A new terminal opens in the selected workspace, or in {overview.workspacesRoot ?? "/workspaces"} if none is selected.</p>
              <button type="button" className="btn btn-primary" onClick={openNew}>
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
            <div className="terms-grid" onFocus={(e) => setTermFocused(inTerminal(e.target))} onBlur={onGridBlur} data-testid="pane-grid" data-panes={shown.length} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
              {shown.map(renderPane)}
            </div>
          </>
        )}
        {showKeys && (
          <div ref={keysRef} className="xk-wrap" onBlur={onGridBlur}>
            <ExtraKeys handle={keysHandle} ctrl={ctrl} onCtrl={setCtrl} onPrefix={() => arm(true)} />
          </div>
        )}
        {specOpen && specSource && specOpen.ws === specSource && (
          <SpecFloat
            key={specOpen.ws}
            ws={specOpen.ws}
            path={specOpen.path}
            specs={specAnswer.specs}
            narrow={narrow}
            onSelect={(path) => setSpecOpen({ ws: specSource, path })}
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
        open={newOpen}
        workspaces={overview.workspaces}
        projects={projects}
        defaultWorkspace={newDefaults.workspace ?? focusedWs}
        defaultProject={newDefaults.project}
        agent={newAgent}
        onCancel={() => {
          setNewOpen(false);
          setNewAgent(undefined);
          setNewDefaults({});
        }}
        onCreate={async (body) => {
          const done = (info: TerminalInfo) => {
            setNewOpen(false);
            setNewAgent(undefined);
            setNewDefaults({});
            setParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                next.set("focus", info.id);
                return next;
              },
              { replace: true },
            );
          };
          if (!body.agent) {
            const info = await create(body);
            if (info) done(info);
            return;
          }
          // An agent terminal: the error goes back to the dialog, which stays open.
          setBusyAgent(body.agent);
          try {
            done(await createOrThrow(body));
          } finally {
            setBusyAgent(undefined);
          }
        }}
      />
      <WorktreeCloseDialog
        work={closing?.work ?? null}
        onCancel={() => setClosing(null)}
        onDelete={() => {
          const c = closing;
          setClosing(null);
          if (c) void destroy(c.term, "delete");
        }}
        onKeep={() => {
          const c = closing;
          setClosing(null);
          if (c) void destroy(c.term, "keep");
        }}
        onCreatePr={() => {
          const c = closing;
          setClosing(null);
          if (c?.term.worktree && c.term.workspaceId) {
            setPrFor({ workspaceId: c.term.workspaceId, worktreeId: c.term.worktree.id, title: c.term.title, branch: c.term.worktree.branch });
          }
        }}
      />
      <ProjectWorktreeCloseDialog
        work={closingProject?.work ?? null}
        onCancel={() => setClosingProject(null)}
        onDelete={() => {
          const c = closingProject;
          setClosingProject(null);
          if (c) void destroy(c.term, "delete");
        }}
        onKeep={() => {
          const c = closingProject;
          setClosingProject(null);
          if (c) void destroy(c.term, "keep");
        }}
        onMergeProject={async () => {
          const c = closingProject;
          if (!c) return;
          await post(`/api/terminals/${encodeURIComponent(c.term.id)}/merge-project`);
          setClosingProject((cur) => (cur && cur.term.id === c.term.id ? { ...cur, work: { ...cur.work, project: { dirty: 0, ahead: 0 } } } : cur));
        }}
        onCreatePr={() => {
          const c = closingProject;
          setClosingProject(null);
          if (c?.term.worktree && c.term.projectId) {
            const baseOf = new Map((c.term.worktree.repos ?? []).map((r) => [r.name, r.baseBranch] as const));
            setProjectPrFor({
              projectId: c.term.projectId,
              worktreeId: c.term.worktree.id,
              title: c.term.title,
              repos: c.work.repos.map((r) => {
                const baseBranch = baseOf.get(r.name);
                return { ...r, ...(baseBranch ? { baseBranch } : {}) };
              }),
            });
          }
        }}
      />
      <ProjectWorktreePrDialog
        target={projectPrFor}
        onClose={() => setProjectPrFor(null)}
        onDone={() => {
          // The server closed the terminal and removed the repo worktrees; the branches stay for the PRs.
          const t = terminals.find((x) => x.projectId === projectPrFor?.projectId && x.worktree?.id === projectPrFor?.worktreeId);
          if (t) {
            setRemoved((r) => new Set(r).add(t.id));
            update((st) => closeItem(st, termItem(t.id)));
          }
          void overview.refresh();
          void loadKept();
        }}
      />
      <WorktreePrDialog
        target={prFor}
        onClose={() => setPrFor(null)}
        onDone={() => {
          // The server closed the terminal and removed its worktree; the branch stays for the PR.
          const t = terminals.find((x) => x.worktree?.id === prFor?.worktreeId);
          if (t) {
            setRemoved((r) => new Set(r).add(t.id));
            update((st) => closeItem(st, termItem(t.id)));
          }
          void overview.refresh();
          void loadKept();
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete the worktree “${deleting?.title ?? ""}”?`}
        body={deleting ? `${deleting.branch} and its ${workText(deleting)} are deleted. This cannot be undone.` : ""}
        confirmLabel="Delete worktree"
        tone="danger"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const w = deleting;
          setDeleting(null);
          if (!w) return;
          void api(`/api/workspaces/${encodeURIComponent(w.workspaceId)}/worktrees/${encodeURIComponent(w.id)}`, { method: "DELETE" })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => void loadKept());
        }}
      />
      <ConfirmDialog
        open={deletingProject !== null}
        title={`Delete the worktree “${deletingProject?.title ?? ""}”?`}
        body={deletingProject ? `Its worktrees in ${deletingProject.repos.length} repos and the project files are deleted. This cannot be undone.` : ""}
        confirmLabel="Delete worktree"
        tone="danger"
        onCancel={() => setDeletingProject(null)}
        onConfirm={() => {
          const w = deletingProject;
          setDeletingProject(null);
          if (!w) return;
          void api(`/api/projects/${encodeURIComponent(w.projectId)}/worktrees/${encodeURIComponent(w.id)}`, { method: "DELETE" })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => void loadKept());
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

function NewTerminalDialog({
  open,
  workspaces,
  projects,
  defaultWorkspace,
  defaultProject,
  agent,
  onCancel,
  onCreate,
}: {
  open: boolean;
  workspaces: WorkspaceEntry[];
  projects: ProjectEntry[];
  defaultWorkspace?: string;
  /** A project id the dialog preselects (`?project=`), before `defaultWorkspace`. */
  defaultProject?: string;
  /** Set when the dialog opens an agent (Claude Code, …) instead of a plain shell. */
  agent?: AgentInfo;
  onCancel(): void;
  /** Rejects with the error to show in the dialog. */
  onCreate(body: NewTerminalBody): Promise<void>;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [ws, setWs] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A project-config agent (Qwen Code) commits its config in a workspace or a project folder, so it needs one.
  // `ws` is a workspace id, `project:<id>` or "" (the workspaces root).
  const needsWorkspace = agent?.connect === "project-config";
  useFocusTrap(ref, open, onCancel);
  useEffect(() => {
    if (!open) return;
    const project = defaultProject && projects.some((p) => p.id === defaultProject) ? `${PROJECT_OPTION}${defaultProject}` : "";
    const known = defaultWorkspace && workspaces.some((w) => w.id === defaultWorkspace) ? defaultWorkspace : "";
    setWs(project || known || (needsWorkspace ? (workspaces[0]?.id ?? "") : ""));
    setTitle("");
    setBusy(false);
    setError("");
  }, [open, agent?.id]);
  // The default may name a workspace or project the lists did not hold yet when the dialog opened (a one-click link).
  const pending = useRef(false);
  useEffect(() => {
    pending.current = open;
  }, [open]);
  useEffect(() => {
    if (!open || !pending.current) return;
    if (!defaultProject && !defaultWorkspace) {
      pending.current = false;
      return;
    }
    if (defaultProject && projects.some((p) => p.id === defaultProject)) {
      pending.current = false;
      setWs(`${PROJECT_OPTION}${defaultProject}`);
    } else if (!defaultProject && defaultWorkspace && workspaces.some((w) => w.id === defaultWorkspace)) {
      pending.current = false;
      setWs(defaultWorkspace);
    }
  }, [open, projects, workspaces, defaultProject, defaultWorkspace]);
  // The branch a workspace terminal's worktree is cut from (Base): local refs first, then the list after `git fetch`.
  const onWorkspace = ws !== "" && !ws.startsWith(PROJECT_OPTION);
  const [base, setBase] = useState("");
  const [branchList, setBranchList] = useState<BranchList | null>(null);
  const [fetching, setFetching] = useState(false);
  const [offline, setOffline] = useState(false);
  /** The user picked the base by hand: refreshes keep it while it is still listed. */
  const picked = useRef(false);
  useEffect(() => {
    setBranchList(null);
    setBase("");
    setOffline(false);
    setFetching(false);
    picked.current = false;
    if (!open || !onWorkspace) return;
    let gone = false;
    let fetched = false;
    const url = `/api/workspaces/${encodeURIComponent(ws)}/branches`;
    const apply = (r: BranchList) => {
      const branches = Array.isArray(r?.branches) ? r.branches.filter((b) => typeof b === "string") : [];
      setBranchList({ ...r, branches });
      setBase((prev) => {
        if (r.noCommit) return "";
        if (picked.current && branches.includes(prev)) return prev;
        if (r.default && branches.includes(r.default)) return r.default;
        if (branches.includes(prev)) return prev;
        return r.current && branches.includes(r.current) ? r.current : (branches[0] ?? "");
      });
    };
    setFetching(true);
    api<BranchList>(url).then(
      (r) => {
        if (!gone && !fetched) apply(r);
      },
      () => {},
    );
    api<BranchList>(`${url}?fetch=1`).then(
      (r) => {
        if (gone) return;
        fetched = true;
        apply(r);
        setOffline(r?.fetched === false && !r.noCommit);
        setFetching(false);
      },
      () => {
        if (gone) return;
        setOffline(true);
        setFetching(false);
      },
    );
    return () => {
      gone = true;
    };
  }, [open, ws, onWorkspace]);
  const noCommit = branchList?.noCommit === true;
  // A project terminal: one Base per repo, each cut from its own workspace (docs/prd/project-terminal-worktrees.md).
  const projectId = ws.startsWith(PROJECT_OPTION) ? ws.slice(PROJECT_OPTION.length) : "";
  const [repoRows, setRepoRows] = useState<RepoBaseRow[] | null>(null);
  useEffect(() => {
    setRepoRows(null);
    if (!open || !projectId) return;
    let gone = false;
    const patch = (name: string, f: (row: RepoBaseRow) => RepoBaseRow) => {
      if (!gone) setRepoRows((rows) => rows?.map((row) => (row.name === name ? f(row) : row)) ?? rows);
    };
    api<ProjectBranches>(`/api/projects/${encodeURIComponent(projectId)}/branches`).then(
      (r) => {
        if (gone) return;
        const rows: RepoBaseRow[] = (Array.isArray(r?.repos) ? r.repos : []).map((repo) => {
          const branches = Array.isArray(repo.branches) ? repo.branches.filter((b) => typeof b === "string") : [];
          const isolated = !!repo.workspaceId && !repo.noCommit && !repo.missing;
          return {
            name: repo.name,
            workspaceId: repo.workspaceId,
            branches,
            noCommit: repo.noCommit === true,
            missing: repo.missing === true || !repo.workspaceId,
            base: isolated ? pickBase({ ...repo, branches }, "", false) : "",
            picked: false,
            fetching: isolated,
            offline: false,
          };
        });
        setRepoRows(rows);
        for (const row of rows) {
          if (!row.fetching || !row.workspaceId) continue;
          api<BranchList>(`/api/workspaces/${encodeURIComponent(row.workspaceId)}/branches?fetch=1`).then(
            (b) => {
              const branches = Array.isArray(b?.branches) ? b.branches.filter((x) => typeof x === "string") : [];
              patch(row.name, (cur) => ({
                ...cur,
                branches: b?.noCommit ? [] : branches,
                noCommit: b?.noCommit === true,
                base: b?.noCommit ? "" : pickBase({ ...b, branches }, cur.base, cur.picked),
                fetching: false,
                offline: b?.fetched === false && !b.noCommit,
              }));
            },
            () => patch(row.name, (cur) => ({ ...cur, fetching: false, offline: true })),
          );
        }
      },
      () => {
        if (!gone) setRepoRows([]);
      },
    );
    return () => {
      gone = true;
    };
  }, [open, projectId]);
  // The workspaces may arrive after the dialog opened.
  useEffect(() => {
    if (open && needsWorkspace && !ws && workspaces[0]) setWs(workspaces[0].id);
  }, [open, needsWorkspace, ws, workspaces]);
  if (!open) return null;
  const heading = agent ? `New ${agent.label} terminal` : "New terminal";
  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        ref={ref}
        className="dialog new-term-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        tabIndex={-1}
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          if (needsWorkspace && !ws) {
            setError(`${agent?.label ?? "This agent"} needs a workspace.`);
            return;
          }
          setBusy(true);
          setError("");
          void onCreate({
            ...(ws.startsWith(PROJECT_OPTION) ? { projectId: ws.slice(PROJECT_OPTION.length) } : ws ? { workspaceId: ws } : {}),
            ...(onWorkspace && !noCommit && base ? { base } : {}),
            ...(projectId && repoRows?.some((r) => !r.noCommit && !r.missing && r.base)
              ? { bases: Object.fromEntries(repoRows.filter((r) => !r.noCommit && !r.missing && r.base).map((r) => [r.name, r.base])) }
              : {}),
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(agent ? { agent: agent.id } : {}),
          })
            .catch((err: unknown) => setError(err instanceof ApiError ? err.error : err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2 className="dialog-title">{heading}</h2>
        <label className="field">
          <span className="field-label">Workspace</span>
          <select
            className="select"
            value={ws}
            onChange={(e) => {
              pending.current = false;
              setWs(e.target.value);
            }}
            // Enter creates (Ctrl Space n, Enter), as in the Title field; arrows still pick the workspace.
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                e.preventDefault();
                ref.current?.requestSubmit();
              }
            }}
            data-autofocus
            data-testid="new-terminal-workspace"
          >
            {!needsWorkspace && <option value="">Workspaces root</option>}
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.fullPath}
              </option>
            ))}
            {projects.length > 0 && (
              <optgroup label="Projects">
                {projects.map((p) => (
                  <option key={p.id} value={`${PROJECT_OPTION}${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {needsWorkspace && (
            <span className="field-hint">Commits .qwen/settings.json once (in the workspace or project folder) if graph-manager's tools are not connected yet.</span>
          )}
        </label>
        {onWorkspace && (
          <label className="field">
            <span className="field-label">
              Base {fetching && <span className="btn-spinner" aria-hidden="true" data-testid="new-terminal-base-loading" />}
            </span>
            <select
              className="select"
              value={noCommit ? "" : base}
              disabled={noCommit}
              onChange={(e) => {
                picked.current = true;
                setBase(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                  e.preventDefault();
                  ref.current?.requestSubmit();
                }
              }}
              data-testid="new-terminal-base"
            >
              {noCommit || !branchList ? (
                <option value="">{noCommit ? "—" : "Loading…"}</option>
              ) : (
                branchList.branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))
              )}
            </select>
            {noCommit ? (
              <span className="field-hint" data-testid="new-terminal-base-nocommit">
                No commits yet: not isolated
              </span>
            ) : offline ? (
              <span className="field-hint" data-testid="new-terminal-base-offline">
                Offline: local branches
              </span>
            ) : null}
          </label>
        )}
        {projectId &&
          repoRows?.map((row) => (
            <label key={row.name} className="field">
              <span className="field-label">
                {row.name} {row.fetching && <span className="btn-spinner" aria-hidden="true" data-testid={`new-terminal-base-loading-${row.name}`} />}
              </span>
              <select
                className="select"
                value={row.noCommit || row.missing ? "" : row.base}
                disabled={row.noCommit || row.missing}
                onChange={(e) => {
                  const value = e.target.value;
                  setRepoRows((rows) => rows?.map((r) => (r.name === row.name ? { ...r, base: value, picked: true } : r)) ?? rows);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                    e.preventDefault();
                    ref.current?.requestSubmit();
                  }
                }}
                data-testid={`new-terminal-base-${row.name}`}
              >
                {row.noCommit || row.missing ? (
                  <option value="">—</option>
                ) : (
                  row.branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))
                )}
              </select>
              {row.noCommit ? (
                <span className="field-hint" data-testid={`new-terminal-base-nocommit-${row.name}`}>
                  No commits yet: not isolated
                </span>
              ) : row.missing ? (
                <span className="field-hint">No workspace for this repo</span>
              ) : row.offline ? (
                <span className="field-hint" data-testid={`new-terminal-base-offline-${row.name}`}>
                  Offline: local branches
                </span>
              ) : null}
            </label>
          ))}
        <label className="field">
          <span className="field-label">Title</span>
          <input className="input" value={title} maxLength={200} placeholder="optional" onChange={(e) => setTitle(e.target.value)} data-testid="new-terminal-title" />
        </label>
        {error && (
          <p className="field-error" role="alert" data-testid="new-terminal-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel <Kbd>Esc</Kbd>
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="new-terminal-create">
            {busy && agent ? (
              <>
                <span className="btn-spinner" aria-hidden="true" />
                Connecting tools…
              </>
            ) : (
              "Create"
            )}
          </button>
        </div>
      </form>
    </div>
  );
}


type NewTerminalBody = {
  workspaceId?: string;
  projectId?: string;
  title?: string;
  agent?: AgentId;
  worktreeId?: string;
  projectWorktreeId?: string;
  base?: string;
  /** A project terminal: repo name → the branch its worktree is cut from. */
  bases?: Record<string, string>;
};

/** `GET /api/projects/:id/branches`: each repo's local branches. */
interface ProjectBranches {
  repos: { name: string; workspaceId?: string; branches: string[]; default?: string; current?: string; noCommit?: boolean; missing?: boolean }[];
}

/** One repo's Base row in the New terminal dialog (a project terminal). */
interface RepoBaseRow {
  name: string;
  workspaceId?: string;
  branches: string[];
  noCommit: boolean;
  missing: boolean;
  base: string;
  /** Picked by hand: refreshes keep it while it is still listed. */
  picked: boolean;
  fetching: boolean;
  offline: boolean;
}

/** The base to select after a branch list arrives: a hand-picked one that is still listed, else the default. */
function pickBase(r: { branches: string[]; default?: string; current?: string }, prev: string, picked: boolean): string {
  const { branches } = r;
  if (picked && branches.includes(prev)) return prev;
  if (r.default && branches.includes(r.default)) return r.default;
  if (branches.includes(prev)) return prev;
  return r.current && branches.includes(r.current) ? r.current : (branches[0] ?? "");
}

/** The agents `?agent=` may name. */
const URL_AGENTS: AgentId[] = ["claude", "codex", "opencode", "qwen"];
/** The prefix of a project's value in the New terminal dialog's select (a workspace id has no ":"). */
const PROJECT_OPTION = "project:";
