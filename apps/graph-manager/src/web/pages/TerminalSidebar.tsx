// The Terminals sidebar: count, "N of M repositories open", New terminal, the agent buttons, one section per repo
// session (repository or project, branch and state), then "Other terminals".

import { countLine, sessionLabel, stateLabel } from "../sessions";
import type { AgentId, AgentInfo, RunSummary, SessionInfo, SessionState, TerminalInfo } from "../types";
import { AgentIcon } from "../ui/AgentIcon";
import { Icon } from "../ui/Icon";
import { Kbd } from "../ui/Kbd";

/** `octo/hello` for a workspace id, from the sessions when one has it. */
export function workspacePath(id: string, sessions: SessionInfo[] = []): string {
  const s = sessions.find((x) => x.workspaceId === id);
  if (s) return `${s.repo.owner}/${s.repo.name}`;
  return id.split("~").slice(1).join("/") || id;
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
  sessionId?: string;
  branch?: string;
  state?: SessionState;
  error?: string;
  items: TerminalInfo[];
}

/** The id and name of a project, as the sidebar needs them. */
export type ProjectName = { id: string; name: string };

/** The session a terminal belongs to: the one listing its id, else the one on its workspace (or project home). */
function sessionOf(t: TerminalInfo, sessions: SessionInfo[]): SessionInfo | undefined {
  return (
    (t.sessionId ? sessions.find((s) => s.id === t.sessionId) : undefined) ??
    sessions.find((s) => s.terminals.includes(t.id)) ??
    (t.workspaceId ? sessions.find((s) => s.workspaceId === t.workspaceId) : undefined) ??
    (t.projectId ? sessions.find((s) => s.workspaceId === `project~${t.projectId}`) : undefined)
  );
}

/**
 * One section per session (in `startedAt` order; a session without terminals still gets one), then "Other terminals"
 * for the terminals that belong to no session.
 */
export function groupTerminals(terminals: TerminalInfo[], sessions: SessionInfo[], projects: ProjectName[] = []): Section[] {
  const ordered = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  const items = new Map<string, TerminalInfo[]>(ordered.map((s) => [s.id, []]));
  const other: TerminalInfo[] = [];
  for (const t of terminals) {
    const s = sessionOf(t, ordered);
    if (s) items.get(s.id)!.push(t);
    else other.push(t);
  }
  const sections: Section[] = ordered.map((s) => ({
    key: `session:${s.id}`,
    label: sessionLabel(s, projects),
    ...(s.projectId ? { project: true } : {}),
    sessionId: s.id,
    branch: s.branch,
    state: s.state,
    ...(s.error !== undefined ? { error: s.error } : {}),
    items: items.get(s.id) ?? [],
  }));
  if (other.length > 0) sections.push({ key: "other", label: "Other terminals", items: other });
  return sections;
}

export function liveRunsIn(runs: RunSummary[], workspaceId: string | undefined): RunSummary[] {
  if (!workspaceId) return [];
  return runs.filter((r) => r.live && r.workspaceId === workspaceId);
}

export const last4 = (id: string) => id.slice(-4);

const STATE_TONE: Record<SessionState, "mute" | "live" | "warn" | "bad"> = { starting: "mute", live: "live", asking: "warn", ending: "warn", "save-failed": "bad" };

export interface TerminalSidebarProps {
  terminals: TerminalInfo[];
  sessions: SessionInfo[];
  /** `GM_MAX_SESSIONS`, or null. */
  limit: number | null;
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
  /** + on a session's head: a new terminal in that session. */
  onNewInSession(sessionId: string): void;
  /** Retry the push of a `save-failed` session. */
  onRetry(sessionId: string): void;
  /** Discard the changes of a `save-failed` session. */
  onDiscard(sessionId: string): void;
  /** Answer the uncommitted-changes question of an `asking` session. */
  onAsk(sessionId: string): void;
  /** The agent buttons (Claude Code, Codex, …); a CLI that is not installed is disabled. */
  agents: AgentInfo[];
  onNewAgent(id: AgentId): void;
  /** The agent whose terminal is being created. */
  busyAgent?: AgentId;
  className?: string;
}

export function TerminalSidebar(p: TerminalSidebarProps) {
  const sections = groupTerminals(p.terminals, p.sessions, p.projects);
  const count = countLine(p.sessions.length, p.limit);
  let index = 0;
  return (
    <aside className={`tsb ${p.className ?? ""}`} aria-label="Terminals" data-testid="terminal-sidebar">
      <div className="tsb-head">
        <div className="tsb-title">
          <h1>
            Terminals <span className="tsb-count num">{p.terminals.length}</span>
          </h1>
        </div>
        {count !== undefined && (
          <div className="tsb-session-count muted" data-testid="session-count">
            {count}
          </div>
        )}
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
        <button type="button" className="btn tsb-new" title="New terminal (Ctrl Space, n)" onClick={p.onNew} data-testid="new-terminal">
          <Icon name="plus" size={14} />
          New terminal
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
              {s.sessionId && s.state && (
                <span className={`badge tsb-session-state tone-${STATE_TONE[s.state]}`} data-testid={`session-state-${s.sessionId}`}>
                  {stateLabel(s.state)}
                </span>
              )}
              <span className="num">{s.items.length}</span>
              {s.sessionId && (s.state === "live" || s.state === "asking") && (
                <button
                  type="button"
                  className="tsb-section-new"
                  aria-label={`New terminal in ${s.label}`}
                  title={`New terminal in ${s.label}`}
                  data-testid={`session-new-${s.sessionId}`}
                  onClick={() => p.onNewInSession(s.sessionId!)}
                >
                  <Icon name="plus" size={12} />
                </button>
              )}
            </div>
            {s.sessionId && s.branch && (
              <div className="tsb-session-branch mono" title={s.branch} data-testid={`session-branch-${s.sessionId}`}>
                {s.branch}
              </div>
            )}
            {s.sessionId && s.state === "asking" && (
              <div className="tsb-session-actions">
                <button type="button" className="btn btn-sm" data-testid={`session-ask-${s.sessionId}`} onClick={() => p.onAsk(s.sessionId!)}>
                  Uncommitted changes…
                </button>
              </div>
            )}
            {s.sessionId && s.state === "save-failed" && (
              <div className="tsb-session-failed">
                <p className="field-error" role="alert" data-testid={`session-error-${s.sessionId}`}>
                  {s.error ?? "The push failed."}
                </p>
                <div className="tsb-session-actions">
                  <button type="button" className="btn btn-sm" data-testid={`session-retry-${s.sessionId}`} onClick={() => p.onRetry(s.sessionId!)}>
                    Retry
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" data-testid={`session-discard-${s.sessionId}`} onClick={() => p.onDiscard(s.sessionId!)}>
                    Discard
                  </button>
                </div>
              </div>
            )}
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
export function shownOrder(terminals: TerminalInfo[], sessions: SessionInfo[], projects: ProjectName[] = []): TerminalInfo[] {
  return groupTerminals(terminals, sessions, projects).flatMap((s) => s.items);
}
