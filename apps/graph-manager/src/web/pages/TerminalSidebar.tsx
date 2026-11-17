// The Terminals sidebar (boards 07–09): count, New, per-workspace / per-project / "Workspaces root" sections.

import type { AgentId, AgentInfo, KeptProjectWorktree, KeptWorktree, RunSummary, TerminalInfo, WorkspaceEntry } from "../types";
import { workText } from "./WorktreeClose";
import { AgentIcon } from "../ui/AgentIcon";
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
  /** A project's section. */
  project?: boolean;
  items: TerminalInfo[];
}

/** The id and name of a project, as the sidebar needs them. */
export type ProjectName = { id: string; name: string };

/**
 * One section per workspace (in the order of the workspaces list), one per project (in the order of `projects`,
 * unknown ids last), then "Workspaces root" (neither).
 */
export function groupTerminals(terminals: TerminalInfo[], workspaces: WorkspaceEntry[], projects: ProjectName[] = []): Section[] {
  const sections: Section[] = [];
  const byWs = new Map<string, TerminalInfo[]>();
  const byProject = new Map<string, TerminalInfo[]>();
  for (const t of terminals) {
    if (t.workspaceId) byWs.set(t.workspaceId, [...(byWs.get(t.workspaceId) ?? []), t]);
    else if (t.projectId) byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t]);
  }
  const sorted = (groups: Map<string, TerminalInfo[]>, known: { id: string }[]) => {
    const order = (id: string) => {
      const i = known.findIndex((k) => k.id === id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...groups].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b));
  };
  for (const [id, items] of sorted(byWs, workspaces)) {
    sections.push({ key: `ws:${id}`, label: workspacePath(id, workspaces), items });
  }
  for (const [id, items] of sorted(byProject, projects)) {
    sections.push({ key: `project:${id}`, label: projects.find((p) => p.id === id)?.name ?? id, project: true, items });
  }
  const root = terminals.filter((t) => !t.workspaceId && !t.projectId);
  if (root.length > 0) sections.push({ key: "root", label: "Workspaces root", items: root });
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
  /** Names the project sections. */
  projects?: ProjectName[];
  runs: RunSummary[];
  /** Pane number (1–4) of each terminal shown in a pane, and whether that pane is focused. */
  panes: Map<string, { n: number; focused: boolean }>;
  /** Keyboard selection (index into the shown items), -1 for none. */
  selected: number;
  onOpen(id: string): void;
  onOpenRun(run: RunSummary): void;
  onNew(): void;
  /** The agent buttons (Claude Code, Codex, …); a CLI that is not installed is disabled. */
  agents: AgentInfo[];
  onNewAgent(id: AgentId): void;
  /** The agent whose terminal is being created. */
  busyAgent?: AgentId;
  className?: string;
  /** Kept terminal worktrees (KAN-100), listed under their workspace. */
  kept?: KeptWorktree[];
  onOpenKept?(w: KeptWorktree): void;
  onPrKept?(w: KeptWorktree): void;
  onDeleteKept?(w: KeptWorktree): void;
  /** Kept project terminal worktrees, listed under their project. */
  keptProjects?: KeptProjectWorktree[];
  onOpenKeptProject?(w: KeptProjectWorktree): void;
  onPrKeptProject?(w: KeptProjectWorktree): void;
  onDeleteKeptProject?(w: KeptProjectWorktree): void;
}

/** What a kept project worktree set holds, summed over the project repo and its repos. */
export function projectWorkText(w: KeptProjectWorktree): string {
  const sum = w.repos.reduce((acc, r) => ({ dirty: acc.dirty + r.dirty, ahead: acc.ahead + r.ahead }), { dirty: w.project.dirty, ahead: w.project.ahead });
  return `${w.repos.length} repo${w.repos.length === 1 ? "" : "s"} · ${workText(sum)}`;
}

export function TerminalSidebar(p: TerminalSidebarProps) {
  const sections = groupTerminals(p.terminals, p.workspaces, p.projects);
  const kept = p.kept ?? [];
  // A workspace with kept worktrees but no open terminal still gets its section.
  for (const w of kept) {
    if (!sections.some((s) => s.key === `ws:${w.workspaceId}`)) {
      sections.splice(sections.filter((s) => s.key.startsWith("ws:")).length, 0, { key: `ws:${w.workspaceId}`, label: workspacePath(w.workspaceId, p.workspaces), items: [] });
    }
  }
  // Likewise a project with kept worktrees, before "Workspaces root".
  const keptProjects = p.keptProjects ?? [];
  for (const w of keptProjects) {
    if (sections.some((s) => s.key === `project:${w.projectId}`)) continue;
    const at = sections.filter((s) => s.key.startsWith("ws:") || s.key.startsWith("project:")).length;
    sections.splice(at, 0, { key: `project:${w.projectId}`, label: p.projects?.find((x) => x.id === w.projectId)?.name ?? w.projectId, project: true, items: [] });
  }
  let index = 0;
  return (
    <aside className={`tsb ${p.className ?? ""}`} aria-label="Terminals" data-testid="terminal-sidebar">
      <div className="tsb-head">
        <div className="tsb-title">
          <h1>
            Terminals <span className="tsb-count num">{p.terminals.length}</span>
          </h1>
        </div>
        <div className="tsb-agents" role="group" aria-label="Open an agent">
          {p.agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`btn tsb-agent agent-${a.id}`}
              data-testid={`agent-btn-${a.id}`}
              disabled={!a.installed || p.busyAgent !== undefined}
              title={a.installed ? `Open ${a.label} in a new terminal` : `${a.binary ?? a.id} is not installed`}
              onClick={() => p.onNewAgent(a.id)}
            >
              {p.busyAgent === a.id ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  Connecting tools…
                </>
              ) : (
                <>
                  <AgentIcon agent={a.id} />
                  <span className="tsb-agent-label">{a.label}</span>
                </>
              )}
            </button>
          ))}
        </div>
        <button type="button" className="btn tsb-new" title="Plain terminal (Ctrl Space, n)" onClick={p.onNew} data-testid="new-terminal">
          <Icon name="plus" size={14} />
          Plain terminal
        </button>
      </div>
      <div className="tsb-list" data-testid="terminal-list">
        {sections.map((s) => (
          <div key={s.key} className="tsb-section" data-testid={`section-${s.key}`}>
            <div className="tsb-section-head">
              {s.project && <Icon name="projects" size={12} />}
              <span className="tsb-section-label" title={s.project ? `Project ${s.label}` : undefined}>
                {s.label}
              </span>
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
                    {t.agent ? <AgentIcon agent={t.agent} /> : <Icon name="terminal" size={14} />}
                  </span>
                  <span className="tsb-item-text">
                    <span className="tsb-item-title-row">
                      <span className="tsb-item-title">{t.title}</span>
                      {/* The logo shows the agent; screen readers get its name instead (the icon is aria-hidden). */}
                      {t.agent && (
                        <span className="visually-hidden" data-testid={`agent-label-${t.id}`}>
                          {`, ${p.agents.find((a) => a.id === t.agent)?.label ?? t.agent}`}
                        </span>
                      )}
                    </span>
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
            {kept
              .filter((w) => s.key === `ws:${w.workspaceId}`)
              .map((w) => (
                <div key={w.id} className="tsb-kept" data-testid="kept-worktree" title={w.path}>
                  <span className="tsb-item-icon" aria-hidden="true">
                    <Icon name="terminal" size={14} />
                  </span>
                  <span className="tsb-item-text">
                    <span className="tsb-item-title">{w.title}</span>
                    <span className="tsb-item-sub mono">
                      {w.branch} · {workText(w)}
                    </span>
                  </span>
                  <span className="tsb-kept-actions">
                    <button type="button" className="btn btn-sm" onClick={() => p.onOpenKept?.(w)} data-testid={`kept-open-${w.id}`}>
                      Open
                    </button>
                    {p.onPrKept && (
                      <button type="button" className="btn btn-sm" onClick={() => p.onPrKept?.(w)} data-testid={`kept-pr-${w.id}`}>
                        PR
                      </button>
                    )}
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => p.onDeleteKept?.(w)} data-testid={`kept-delete-${w.id}`}>
                      Delete
                    </button>
                  </span>
                </div>
              ))}
            {keptProjects
              .filter((w) => s.key === `project:${w.projectId}`)
              .map((w) => (
                <div key={w.id} className="tsb-kept" data-testid="kept-project-worktree" title={w.path}>
                  <span className="tsb-item-icon" aria-hidden="true">
                    <Icon name="terminal" size={14} />
                  </span>
                  <span className="tsb-item-text">
                    <span className="tsb-item-title">{w.title}</span>
                    <span className="tsb-item-sub mono">{projectWorkText(w)}</span>
                  </span>
                  <span className="tsb-kept-actions">
                    <button type="button" className="btn btn-sm" onClick={() => p.onOpenKeptProject?.(w)} data-testid="kept-project-open">
                      Open terminal
                    </button>
                    {p.onPrKeptProject && (
                      <button type="button" className="btn btn-sm" onClick={() => p.onPrKeptProject?.(w)} data-testid="kept-project-pr">
                        Create PR
                      </button>
                    )}
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => p.onDeleteKeptProject?.(w)} data-testid="kept-project-delete">
                      Delete
                    </button>
                  </span>
                </div>
              ))}
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
export function shownOrder(terminals: TerminalInfo[], workspaces: WorkspaceEntry[], projects: ProjectName[] = []): TerminalInfo[] {
  return groupTerminals(terminals, workspaces, projects).flatMap((s) => s.items);
}
