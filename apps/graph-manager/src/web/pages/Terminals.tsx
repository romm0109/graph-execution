// Terminals (boards 07, 08, 09, 19): grouped sidebar, tabs, a 1/2/4-pane split of terminals and runs, the Ctrl Space
// prefix, restart and reconnect.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, post } from "../api";
import { useSetVisibleTerminals } from "../agentRequests";
import { useListNav } from "../keys";
import { useOverview } from "../overview";
import { nextRunWatch, type RunWatch } from "../runs";
import type { AgentId, AgentInfo, RunSummary, TerminalInfo, WorkspaceEntry } from "../types";
import { ConfirmDialog } from "../ui/Dialog";
import { useFocusTrap } from "../ui/focus";
import { Icon, type IconName } from "../ui/Icon";
import { Kbd } from "../ui/Kbd";
import { StatusGlyph } from "../ui/StatusBadge";
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
  const [newOpen, setNewOpen] = useState(false);
  /** The agent the New terminal dialog opens, while it is open for one. */
  const [newAgent, setNewAgent] = useState<AgentInfo | undefined>(undefined);
  /** The agent whose terminal is being created (its POST is running). */
  const [busyAgent, setBusyAgent] = useState<AgentId | undefined>(undefined);
  const agents = useAgents();
  const [confirm, setConfirm] = useState<TerminalInfo | null>(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState("");

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
  /** Creates the terminal and opens it in a pane; throws the server's error. */
  const createOrThrow = useCallback(
    async (body: NewTerminalBody) => {
      const info = await post<TerminalInfo>("/api/terminals", body);
      setCreated((c) => [...c.filter((t) => t.id !== info.id), info]);
      update((s) => openItem(s, termItem(info.id)));
      setError("");
      void overview.refresh();
      return info;
    },
    [update, overview],
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

  const destroy = useCallback(
    async (t: TerminalInfo) => {
      setRemoved((r) => new Set(r).add(t.id));
      update((s) => closeItem(s, termItem(t.id)));
      try {
        await api(`/api/terminals/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      void overview.refresh();
    },
    [update, overview],
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

  // `?workspace=<id>` opens a terminal there once (StrictMode-safe), then becomes `?focus=<id>`.
  const handled = useRef<string | null>(null);
  const workspaceParam = params.get("workspace");
  useEffect(() => {
    if (!workspaceParam || handled.current === workspaceParam) return;
    handled.current = workspaceParam;
    void create({ workspaceId: workspaceParam }).then((info) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("workspace");
          if (info) next.set("focus", info.id);
          return next;
        },
        { replace: true },
      );
    });
  }, [workspaceParam, create, setParams]);

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
  const order = useMemo(() => shownOrder(terminals, overview.workspaces), [terminals, overview.workspaces]);

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
    enabled: !newOpen && confirm === null,
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
  const modal = newOpen || confirm !== null;
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
  const pathOf = (t: TerminalInfo) => (t.workspaceId ? workspacePath(t.workspaceId, overview.workspaces) : overview.workspacesRoot ?? t.cwd);

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
      return <RunPane key={`${i}:${item}`} chrome={chrome(i)} ws={p.ws} runId={p.runId} path={workspacePath(p.ws, overview.workspaces)} summary={runsByKey.get(`${p.ws}/${p.runId}`)} />;
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
            workspaces={overview.workspaces}
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
            onNewAgent={(id) => {
              const a = agents.find((x) => x.id === id);
              if (!a) return;
              setNewAgent(a);
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
        open={newOpen}
        workspaces={overview.workspaces}
        defaultWorkspace={focusedWs}
        agent={newAgent}
        onCancel={() => {
          setNewOpen(false);
          setNewAgent(undefined);
        }}
        onCreate={async (body) => {
          if (!body.agent) {
            const info = await create(body);
            if (info) setNewOpen(false);
            return;
          }
          // An agent terminal: the error goes back to the dialog, which stays open.
          setBusyAgent(body.agent);
          try {
            await createOrThrow(body);
            setNewOpen(false);
            setNewAgent(undefined);
          } finally {
            setBusyAgent(undefined);
          }
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
  defaultWorkspace,
  agent,
  onCancel,
  onCreate,
}: {
  open: boolean;
  workspaces: WorkspaceEntry[];
  defaultWorkspace?: string;
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
  // A project-config agent (Qwen Code) commits its config in a workspace, so it needs one.
  const needsWorkspace = agent?.connect === "project-config";
  useFocusTrap(ref, open, onCancel);
  useEffect(() => {
    if (!open) return;
    const known = defaultWorkspace && workspaces.some((w) => w.id === defaultWorkspace) ? defaultWorkspace : "";
    setWs(known || (needsWorkspace ? (workspaces[0]?.id ?? "") : ""));
    setTitle("");
    setBusy(false);
    setError("");
  }, [open, agent?.id]);
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
          void onCreate({ ...(ws ? { workspaceId: ws } : {}), ...(title.trim() ? { title: title.trim() } : {}), ...(agent ? { agent: agent.id } : {}) })
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
            onChange={(e) => setWs(e.target.value)}
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
          </select>
          {needsWorkspace && <span className="field-hint">Commits .qwen/settings.json once if graph-manager's tools are not connected yet.</span>}
        </label>
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


type NewTerminalBody = { workspaceId?: string; title?: string; agent?: AgentId };

/** Shown until `GET /api/agents` answers, so the sidebar does not jump. */
const FALLBACK_AGENTS: AgentInfo[] = [
  { id: "claude", label: "Claude Code", installed: true, connect: "inject" },
  { id: "codex", label: "Codex", installed: true, connect: "inject" },
  { id: "opencode", label: "OpenCode", installed: true, connect: "inject" },
  { id: "qwen", label: "Qwen Code", installed: true, connect: "project-config" },
];

/** The agent CLIs and whether each is installed, fetched once. */
function useAgents(): AgentInfo[] {
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
