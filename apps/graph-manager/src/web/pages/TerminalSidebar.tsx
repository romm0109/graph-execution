// The Terminals sidebar (boards 07–09): count, New, per-workspace / WORKSPACES ROOT sections.

import type { RunSummary, TerminalInfo, WorkspaceEntry } from "../types";
import { Icon } from "../ui/Icon";
import { Kbd } from "../ui/Kbd";

/** `octo/hello` for a workspace id, from the workspaces list when it has it. */
export function workspacePath(id: string, workspaces: WorkspaceEntry[]): string {
  return workspaces.find((w) => w.id === id)?.fullPath ?? (id.split("~").slice(1).join("/") || id);
}

/** The item's mono sub-line: the foreground process (`bash`, `node`), `shell` while it is not known. */
export function subLine(t: TerminalInfo): string {
  return t.process ?? "shell";
}

export interface Section {
  key: string;
  label: string;
  items: TerminalInfo[];
}

/** One section per workspace (in the order of the workspaces list), then WORKSPACES ROOT (no workspace). */
export function groupTerminals(terminals: TerminalInfo[], workspaces: WorkspaceEntry[]): Section[] {
  const sections: Section[] = [];
  const byWs = new Map<string, TerminalInfo[]>();
  for (const t of terminals) if (t.workspaceId) byWs.set(t.workspaceId, [...(byWs.get(t.workspaceId) ?? []), t]);
  const order = (id: string) => {
    const i = workspaces.findIndex((w) => w.id === id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  for (const [id, items] of [...byWs].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))) {
    sections.push({ key: `ws:${id}`, label: workspacePath(id, workspaces).toUpperCase(), items });
  }
  const root = terminals.filter((t) => !t.workspaceId);
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
  /** Pane number (1–4) of each terminal shown in a pane, and whether that pane is focused. */
  panes: Map<string, { n: number; focused: boolean }>;
  /** Keyboard selection (index into the shown items), -1 for none. */
  selected: number;
  onOpen(id: string): void;
  onOpenRun(run: RunSummary): void;
  onNew(): void;
  className?: string;
}

export function TerminalSidebar(p: TerminalSidebarProps) {
  const sections = groupTerminals(p.terminals, p.workspaces);
  let index = 0;
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
      </div>
      <div className="tsb-list" data-testid="terminal-list">
        {sections.map((s) => (
          <div key={s.key} className="tsb-section" data-testid={`section-${s.key}`}>
            <div className="tsb-section-head">
              <span className="tsb-section-label">{s.label}</span>
              <span className="num">{s.items.length}</span>
            </div>
            {s.items.map((t) => {
              const i = index++;
              const pane = p.panes.get(t.id);
              const runs = liveRunsIn(p.runs, t.workspaceId);
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
                  <span className="tsb-item-icon" aria-hidden="true">
                    <Icon name="terminal" size={14} />
                  </span>
                  <span className="tsb-item-text">
                    <span className="tsb-item-title">{t.title}</span>
                    <span className="tsb-item-sub mono">{subLine(t)}</span>
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
      </div>
      <div className="tsb-foot">
        <span>
          <Kbd>Ctrl Space n</Kbd> new terminal
        </span>
        <span>
          <Kbd>Ctrl Space 1–4</Kbd> focus pane
        </span>
      </div>
    </aside>
  );
}

/** The flattened order of the items as shown (for j/k). */
export function shownOrder(terminals: TerminalInfo[], workspaces: WorkspaceEntry[]): TerminalInfo[] {
  return groupTerminals(terminals, workspaces).flatMap((s) => s.items);
}
