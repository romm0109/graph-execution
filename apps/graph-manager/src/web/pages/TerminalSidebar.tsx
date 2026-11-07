// The Terminals sidebar (boards 07–09): count, New, filter chips, NEEDS YOU / per-workspace / WORKSPACES ROOT sections.

import type { RunSummary, TerminalInfo, WorkspaceEntry } from "../types";
import { Icon } from "../ui/Icon";
import { Kbd } from "../ui/Kbd";
import { StatusGlyph } from "../ui/StatusBadge";
import { glyphOf, toneOf } from "../ui/status";

export type TermFilter = "working" | "idle" | "other";
export const FILTERS: TermFilter[] = ["working", "idle", "other"];

export function parseFilter(v: string | null): TermFilter | undefined {
  return FILTERS.includes(v as TermFilter) ? (v as TermFilter) : undefined;
}

export function matchesFilter(t: TerminalInfo, f: TermFilter | undefined): boolean {
  if (!f) return true;
  if (f === "other") return t.status === "exited";
  return t.status === f;
}

/** A short duration: `14s`, `4m`, `2h`, `3d`. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const time = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/** How long a working terminal has been producing output (from the start of the current burst). */
export function workingFor(t: TerminalInfo, now: number): number {
  return now - (time(t.workingSince) ?? time(t.lastOutputAt) ?? time(t.createdAt) ?? now);
}

/** How long an idle terminal has been quiet. */
export function idleFor(t: TerminalInfo, now: number): number {
  return now - (time(t.lastOutputAt) ?? time(t.createdAt) ?? now);
}

/** `octo/hello` for a workspace id, from the workspaces list when it has it. */
export function workspacePath(id: string, workspaces: WorkspaceEntry[]): string {
  return workspaces.find((w) => w.id === id)?.fullPath ?? (id.split("~").slice(1).join("/") || id);
}

/** The last path segment: `deploy-tools`; `~/workspaces` for a terminal without a workspace. */
export function workspaceShort(t: TerminalInfo, workspaces: WorkspaceEntry[]): string {
  if (!t.workspaceId) return "~/workspaces";
  const full = workspacePath(t.workspaceId, workspaces);
  return full.split("/").pop() || full;
}

/** The item's mono sub-line: `bash · working 14s`, `deploy-tools · bash · idle 4m`, `exited 0 · 22m ago`. */
export function subLine(t: TerminalInfo, workspaces: WorkspaceEntry[], now: number): string {
  if (t.status === "exited") return `exited ${t.exitCode ?? "?"} · ${shortDuration(idleFor(t, now))} ago`;
  if (t.status === "working") return `${t.process ?? "shell"} · working ${shortDuration(workingFor(t, now))}`;
  // Idle items sit together under NEEDS YOU, so they keep the folder, and name the process too (an idle `claude` vs `bash`).
  return `${[workspaceShort(t, workspaces), t.process].filter(Boolean).join(" · ")} · idle ${shortDuration(idleFor(t, now))}`;
}

export interface Section {
  key: string;
  label: string;
  tone?: "warn";
  items: TerminalInfo[];
}

/** NEEDS YOU (every idle terminal), one section per workspace (the rest), WORKSPACES ROOT (no workspace). */
export function groupTerminals(terminals: TerminalInfo[], workspaces: WorkspaceEntry[], filter?: TermFilter): Section[] {
  const shown = terminals.filter((t) => matchesFilter(t, filter));
  const sections: Section[] = [];
  const idle = shown.filter((t) => t.status === "idle");
  if (idle.length > 0) sections.push({ key: "needs-you", label: "NEEDS YOU", tone: "warn", items: idle });
  const rest = shown.filter((t) => t.status !== "idle");
  const byWs = new Map<string, TerminalInfo[]>();
  for (const t of rest) if (t.workspaceId) byWs.set(t.workspaceId, [...(byWs.get(t.workspaceId) ?? []), t]);
  const order = (id: string) => {
    const i = workspaces.findIndex((w) => w.id === id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  for (const [id, items] of [...byWs].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))) {
    sections.push({ key: `ws:${id}`, label: workspacePath(id, workspaces).toUpperCase(), items });
  }
  const root = rest.filter((t) => !t.workspaceId);
  if (root.length > 0) sections.push({ key: "root", label: "WORKSPACES ROOT", items: root });
  return sections;
}

export function liveRunsIn(runs: RunSummary[], workspaceId: string | undefined): RunSummary[] {
  if (!workspaceId) return [];
  return runs.filter((r) => r.live && r.workspaceId === workspaceId);
}

export const last4 = (id: string) => id.slice(-4);

export interface TerminalSidebarProps {
  terminals: TerminalInfo[];
  workspaces: WorkspaceEntry[];
  runs: RunSummary[];
  filter?: TermFilter;
  onFilter(f: TermFilter | undefined): void;
  /** Pane number (1–4) of each terminal shown in a pane, and whether that pane is focused. */
  panes: Map<string, { n: number; focused: boolean }>;
  /** Keyboard selection (index into the shown items), -1 for none. */
  selected: number;
  now: number;
  onOpen(id: string): void;
  onOpenRun(run: RunSummary): void;
  onNew(): void;
  className?: string;
}

export function TerminalSidebar(p: TerminalSidebarProps) {
  const counts = {
    working: p.terminals.filter((t) => t.status === "working").length,
    idle: p.terminals.filter((t) => t.status === "idle").length,
    other: p.terminals.filter((t) => t.status === "exited").length,
  };
  const sections = groupTerminals(p.terminals, p.workspaces, p.filter);
  let index = 0;
  const chip = (f: TermFilter, tone: string, label: string) => (
    <button
      type="button"
      className={`tsb-chip tone-${tone}${p.filter === f ? " on" : ""}`}
      aria-pressed={p.filter === f}
      data-testid={`filter-${f}`}
      data-filter={f === "working" ? "" : undefined}
      onClick={() => p.onFilter(p.filter === f ? undefined : f)}
    >
      {f === "working" && <span className="glyph glyph-pulse" aria-hidden="true" />}
      {label}
    </button>
  );
  return (
    <aside className={`tsb ${p.className ?? ""}`} aria-label="Terminals" data-testid="terminal-sidebar">
      <div className="tsb-head">
        <div className="tsb-title">
          <h1>
            Terminals <span className="tsb-count num">{p.terminals.length}</span>
          </h1>
          <button type="button" className="btn btn-primary tsb-new" title="New terminal (Ctrl Space, n)" onClick={p.onNew} data-testid="new-terminal">
            <Icon name="plus" size={14} />
            New
          </button>
        </div>
        <div className="tsb-chips" role="group" aria-label="Filter terminals">
          {chip("working", "live", `${counts.working} working`)}
          {chip("idle", "warn", `${counts.idle} idle`)}
          {chip("other", "mute", `${counts.other} other`)}
        </div>
      </div>
      <div className="tsb-list" data-testid="terminal-list">
        {sections.map((s) => (
          <div key={s.key} className="tsb-section" data-testid={`section-${s.key}`}>
            <div className={`tsb-section-head${s.tone ? ` tone-${s.tone}` : ""}`}>
              <span className="tsb-section-label">{s.label}</span>
              <span className="num">{s.items.length}</span>
            </div>
            {s.items.map((t) => {
              const i = index++;
              const tone = toneOf("term", t.status, t.exitCode);
              const pane = p.panes.get(t.id);
              const runs = liveRunsIn(p.runs, t.workspaceId);
              const subTone = t.status === "exited" && t.exitCode !== 0 ? "bad" : s.tone === "warn" ? "warn" : "";
              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  className={`tsb-item${pane?.focused ? " active" : ""}${i === p.selected ? " focused" : ""}`}
                  data-testid={`terminal-item-${t.id}`}
                  title={t.cwd}
                  onClick={() => p.onOpen(t.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      p.onOpen(t.id);
                    }
                  }}
                >
                  <StatusGlyph tone={tone} glyph={glyphOf("term", t.status, t.exitCode)} />
                  <span className="tsb-item-text">
                    <span className="tsb-item-title">{t.title}</span>
                    <span className={`tsb-item-sub mono${subTone ? ` tone-${subTone}` : ""}`}>{subLine(t, p.workspaces, p.now)}</span>
                  </span>
                  <span className="tsb-item-right">
                    {runs.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className="run-chip"
                        title={`Open run ${r.id} in a pane`}
                        data-testid={`run-chip-${r.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          p.onOpenRun(r);
                        }}
                      >
                        {last4(r.id)}
                      </button>
                    ))}
                    {pane && (
                      <span className={`pane-num${pane.focused ? " focused" : ""}`} title="Visible in pane" data-testid={`pane-badge-${t.id}`}>
                        {pane.n}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {sections.length === 0 && p.terminals.length > 0 && <p className="muted tsb-none">No terminals match this filter.</p>}
      </div>
      <div className="tsb-foot">
        <span>
          <Kbd>Ctrl Space a</Kbd> next idle
        </span>
        <span>
          <Kbd>Ctrl Space 1–4</Kbd> focus pane
        </span>
      </div>
    </aside>
  );
}

/** The flattened order of the items as shown (for j/k). */
export function shownOrder(terminals: TerminalInfo[], workspaces: WorkspaceEntry[], filter?: TermFilter): TerminalInfo[] {
  return groupTerminals(terminals, workspaces, filter).flatMap((s) => s.items);
}
