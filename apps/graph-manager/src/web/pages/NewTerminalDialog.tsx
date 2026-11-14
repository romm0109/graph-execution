// The New terminal dialog (docs/prd/hosted-sessions.md): a repository (a live session, a project or any repository of
// the connected forges), a branch (new by default, or an existing one) and an agent. It posts itself.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, post } from "../api";
import { defaultBranchName, repoPath, sessionLabel } from "../sessions";
import type { AgentId, AgentInfo, ForgeRepoEntry, ProjectEntry, RepoRef, SessionInfo, TerminalInfo } from "../types";
import { useFocusTrap } from "../ui/focus";
import { Icon } from "../ui/Icon";
import { Kbd } from "../ui/Kbd";
import { Segmented } from "../ui/Segmented";

/** How long the repository search waits after the last key. */
export const SEARCH_DEBOUNCE_MS = 200;

/** What the dialog opened: the terminal, its session and what the page needs to show it before the next poll. */
export interface Opened {
  sessionId: string;
  terminalId: string;
  branch: string;
  label: string;
  workspaceId?: string;
  agent?: AgentId;
  title?: string;
}

export interface NewTerminalInitial {
  sessionId?: string;
  repo?: RepoRef;
  projectId?: string;
  agent?: AgentId;
}

type Option =
  | { kind: "live"; key: string; label: string; sessionId: string; branch: string; workspaceId?: string; projectId?: string }
  | { kind: "project"; key: string; label: string; projectId: string; repos: RepoRef[] }
  | { kind: "repo"; key: string; label: string; repo: RepoRef; isPrivate: boolean };

const sameRepo = (a: RepoRef, b: RepoRef) => a.forge === b.forge && a.owner === b.owner && a.name === b.name;
const errorText = (err: unknown) => (err instanceof ApiError ? err.error : err instanceof Error ? err.message : String(err));
const matches = (text: string, query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.toLowerCase().includes(w));

function testId(o: Option): string {
  if (o.kind === "live") return `new-terminal-live-${o.sessionId}`;
  if (o.kind === "project") return `new-terminal-project-${o.projectId}`;
  return `new-terminal-repo-${o.repo.forge}-${repoPath(o.repo)}`;
}

const repoOption = (repo: RepoRef, isPrivate = false): Option => ({ kind: "repo", key: `repo:${repo.forge}:${repoPath(repo)}`, label: repoPath(repo), repo, isPrivate });
const liveOption = (s: SessionInfo, projects: ProjectEntry[]): Option => ({
  kind: "live",
  key: `live:${s.id}`,
  label: sessionLabel(s, projects),
  sessionId: s.id,
  branch: s.branch,
  workspaceId: s.workspaceId,
  ...(s.projectId ? { projectId: s.projectId } : {}),
});
const projectOption = (p: ProjectEntry): Option => ({ kind: "project", key: `project:${p.id}`, label: p.name, projectId: p.id, repos: p.repos ?? [] });
/** A session that is open or opening (not closing). */
const isOpen = (s: SessionInfo) => s.state !== "ending" && s.state !== "save-failed";

export function NewTerminalDialog({
  open,
  sessions,
  projects,
  agents,
  initial,
  userId,
  onCancel,
  onOpened,
  onBusyAgent,
}: {
  open: boolean;
  sessions: SessionInfo[];
  projects: ProjectEntry[];
  agents: AgentInfo[];
  initial?: NewTerminalInitial;
  userId?: string;
  onCancel(): void;
  onOpened(r: Opened): void;
  /** The agent whose terminal is being opened (undefined when done), for the sidebar's buttons. */
  onBusyAgent?(agent: AgentId | undefined): void;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<ForgeRepoEntry[]>([]);
  const [forges, setForges] = useState<{ github: boolean; gitlab: boolean } | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<Option | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [branchName, setBranchName] = useState("");
  const [branchTouched, setBranchTouched] = useState(false);
  const [branches, setBranches] = useState<{ key: string; list?: string[]; error?: string } | undefined>(undefined);
  const [existing, setExisting] = useState("");
  const [agent, setAgent] = useState<AgentId | "">("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pendingProject = useRef<string | undefined>(undefined);
  useFocusTrap(ref, open, onCancel);

  // Reset on open, with the initial choice.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setMode("new");
    setBranchName(userId ? defaultBranchName(userId, new Date()) : "");
    setBranchTouched(false);
    setBranches(undefined);
    setExisting("");
    setAgent(initial?.agent ?? "");
    setTitle("");
    setBusy(false);
    setError("");
    pendingProject.current = undefined;
    let pick: Option | undefined;
    const live = initial?.sessionId
      ? sessions.find((s) => s.id === initial.sessionId)
      : initial?.repo
        ? sessions.find((s) => !s.projectId && sameRepo(s.repo, initial.repo!))
        : initial?.projectId
          ? sessions.find((s) => s.projectId === initial.projectId && isOpen(s))
          : undefined;
    if (live) pick = liveOption(live, projects);
    else if (initial?.repo) pick = repoOption(initial.repo);
    else if (initial?.projectId) {
      const p = projects.find((x) => x.id === initial.projectId);
      if (p) pick = projectOption(p);
      else pendingProject.current = initial.projectId;
    }
    setPicked(pick);
    // Only on opening: later session or project updates must not undo the user's choice.
  }, [open, initial?.sessionId, initial?.repo?.forge, initial?.repo?.owner, initial?.repo?.name, initial?.projectId, initial?.agent]);

  // The user id may come after the dialog opened.
  useEffect(() => {
    if (open && userId && !branchTouched && branchName === "") setBranchName(defaultBranchName(userId, new Date()));
  }, [open, userId, branchTouched, branchName]);

  // A preselected project may come after the dialog opened.
  useEffect(() => {
    const id = pendingProject.current;
    if (!open || !id) return;
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    pendingProject.current = undefined;
    const live = sessions.find((s) => s.projectId === p.id && isOpen(s));
    setPicked((cur) => cur ?? (live ? liveOption(live, projects) : projectOption(p)));
  }, [open, projects]);

  // The repository search, debounced; a late answer for an older query is dropped.
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api<{ repos?: ForgeRepoEntry[]; forges?: { github: boolean; gitlab: boolean } }>(`/api/repos?q=${encodeURIComponent(query.trim())}`)
        .then((r) => {
          if (n !== seq.current) return;
          setRepos(Array.isArray(r?.repos) ? r.repos : []);
          if (r?.forges) setForges(r.forges);
        })
        .catch(() => {
          if (n === seq.current) setRepos([]);
        })
        .finally(() => {
          if (n === seq.current) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query]);

  const options = useMemo<Option[]>(() => {
    const live = sessions.filter(isOpen).map((s) => liveOption(s, projects));
    const liveIds = new Set(live.map((o) => (o.kind === "live" ? o.sessionId : "")));
    // A repository whose live session the overview does not list yet still shows once, as a live entry.
    for (const r of repos) {
      if (r.live && r.sessionId && !liveIds.has(r.sessionId)) {
        live.push({ kind: "live", key: `live:${r.sessionId}`, label: repoPath(r.repo), sessionId: r.sessionId, branch: r.branch ?? "" });
        liveIds.add(r.sessionId);
      }
    }
    const liveShown = live.filter((o) => matches(`${o.label} ${o.kind === "live" ? o.branch : ""}`, query));
    // A project with an open session is listed once, as its live entry.
    const projectShown: Option[] = projects
      .filter((p) => !sessions.some((s) => s.projectId === p.id && isOpen(s)))
      .filter((p) => matches(`${p.name} ${(p.repos ?? []).map(repoPath).join(" ")}`, query))
      .map(projectOption);
    const repoShown = repos
      .filter((r) => !r.live && !sessions.some((s) => !s.projectId && isOpen(s) && sameRepo(s.repo, r.repo)))
      .map((r) => repoOption(r.repo, r.private));
    // A preselected repository (Runs' "Open terminal") shows even before, or without, a search answer naming it.
    if (picked?.kind === "repo" && !repoShown.some((o) => o.key === picked.key) && !liveShown.some((o) => o.label === picked.label)) repoShown.unshift(picked);
    return [...liveShown, ...projectShown, ...repoShown];
  }, [sessions, projects, repos, query, picked]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (active >= options.length && options.length > 0) setActive(options.length - 1);
  }, [active, options.length]);

  // The branches of the picked repository (of a project: its first one), when Existing branch is chosen.
  const branchRepo = picked?.kind === "repo" ? picked.repo : picked?.kind === "project" ? picked.repos[0] : undefined;
  const repoKey = branchRepo ? `${branchRepo.forge}:${branchRepo.owner}/${branchRepo.name}` : undefined;
  useEffect(() => {
    if (!open || mode !== "existing" || !branchRepo || !repoKey) return;
    if (branches?.key === repoKey) return;
    const r = branchRepo;
    setBranches({ key: repoKey });
    setExisting("");
    let alive = true;
    api<{ defaultBranch: string; branches: string[] }>(
      `/api/repos/branches?forge=${encodeURIComponent(r.forge)}&owner=${encodeURIComponent(r.owner)}&name=${encodeURIComponent(r.name)}`,
    )
      .then((res) => {
        if (!alive) return;
        const list = Array.isArray(res?.branches) ? res.branches : [];
        setBranches({ key: repoKey, list });
        setExisting(list[0] ?? "");
      })
      .catch((err: unknown) => alive && setBranches({ key: repoKey, error: errorText(err) }));
    return () => {
      alive = false;
    };
  }, [open, mode, repoKey]);

  if (!open) return null;

  const agentInfo = agents.find((a) => a.id === agent);
  const installed = agents.filter((a) => a.installed);

  const pick = (o: Option | undefined) => {
    if (!o) return;
    setPicked(o);
    setError("");
  };

  const submit = () => {
    if (busy) return;
    if (!picked) {
      setError("Pick a repository.");
      return;
    }
    if (picked.kind !== "live" && mode === "existing" && !existing) {
      setError("Pick a branch.");
      return;
    }
    const extra = { ...(agent ? { agent } : {}), ...(title.trim() ? { title: title.trim() } : {}) };
    const branch = mode === "existing" ? { existing } : branchName.trim() ? { new: branchName.trim() } : {};
    setBusy(true);
    setError("");
    if (agent) onBusyAgent?.(agent);
    const request: Promise<Opened> =
      picked.kind === "live"
        ? post<TerminalInfo>(`/api/sessions/${encodeURIComponent(picked.sessionId)}/terminals`, extra).then((info) => ({
            sessionId: picked.sessionId,
            terminalId: info.id,
            branch: picked.branch,
            label: picked.label,
            workspaceId: info.workspaceId ?? picked.workspaceId,
            ...extra,
          }))
        : post<{ sessionId: string; terminalId: string; branch: string }>(
            "/api/sessions",
            picked.kind === "repo" ? { repo: picked.repo, branch, ...extra } : { projectId: picked.projectId, branch, ...extra },
          ).then((r) => ({
            sessionId: r.sessionId,
            terminalId: r.terminalId,
            branch: r.branch,
            label: picked.label,
            ...(picked.kind === "repo" ? { workspaceId: `${picked.repo.forge}~${picked.repo.owner.split("/").join("~")}~${picked.repo.name}` } : {}),
            ...extra,
          }));
    request
      .then((r) => onOpened(r))
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => {
        setBusy(false);
        onBusyAgent?.(undefined);
      });
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      const o = options[active];
      // Enter picks the highlighted entry; once it is picked, Enter opens.
      if (o && o.key !== picked?.key) pick(o);
      else submit();
    }
  };

  const noForge = forges !== undefined && !forges.github && !forges.gitlab;
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
        aria-label="New terminal"
        tabIndex={-1}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="dialog-title">New terminal</h2>
        <div className="field">
          <span className="field-label">Repository</span>
          <input
            className="input"
            aria-label="Repository"
            placeholder="Search repositories"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            role="combobox"
            aria-expanded="true"
            aria-controls="new-terminal-results"
            aria-activedescendant={options[active] ? `nt-opt-${active}` : undefined}
            data-autofocus
            data-testid="new-terminal-search"
          />
          <ul className="nt-results" role="listbox" id="new-terminal-results" aria-label="Repositories" data-testid="new-terminal-results">
            {options.map((o, i) => {
              return (
                <li
                  key={o.key}
                  id={`nt-opt-${i}`}
                  role="option"
                  aria-selected={picked?.key === o.key}
                  className={`nt-option${i === active ? " active" : ""}`}
                  data-testid={testId(o)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setActive(i);
                    pick(o);
                  }}
                >
                  <Icon name={o.kind === "project" || (o.kind === "live" && o.projectId) ? "projects" : o.kind === "live" ? "terminal" : "folder"} size={14} />
                  <span className="nt-option-label">{o.label}</span>
                  {o.kind === "live" && <span className="badge tone-live">live</span>}
                  {o.kind === "live" && o.branch && <span className="mono muted nt-option-label">{o.branch}</span>}
                  {o.kind === "project" && (
                    <span className="muted">
                      project · {o.repos.length} {o.repos.length === 1 ? "repository" : "repositories"}
                    </span>
                  )}
                  {o.kind === "repo" && o.isPrivate && <span className="muted">private</span>}
                </li>
              );
            })}
            {options.length === 0 && (
              <li className="nt-empty" role="presentation">
                {searching ? "Searching…" : noForge ? "No repositories found. Connect GitHub or GitLab in Settings." : "No repositories found."}
              </li>
            )}
          </ul>
        </div>

        <div className="field" data-testid="new-terminal-branch">
          <span className="field-label">Branch</span>
          {picked?.kind === "live" ? (
            <>
              <span className="mono nt-branch-fixed">{picked.branch}</span>
              <span className="field-hint">The branch is fixed while the session is live.</span>
            </>
          ) : (
            <>
              <Segmented
                ariaLabel="Branch"
                value={mode}
                onChange={(v) => setMode(v)}
                options={[
                  { value: "new", label: "New branch" },
                  { value: "existing", label: "Existing branch" },
                ]}
              />
              {mode === "new" ? (
                <input
                  className="input mono"
                  aria-label="New branch name"
                  value={branchName}
                  placeholder="the default gm/<user>-<date>-<4 chars>"
                  onChange={(e) => {
                    setBranchTouched(true);
                    setBranchName(e.target.value);
                  }}
                  data-testid="new-terminal-branch-name"
                />
              ) : (
                <>
                  <select
                    className="select"
                    aria-label="Existing branch"
                    value={existing}
                    onChange={(e) => setExisting(e.target.value)}
                    disabled={!branches?.list}
                    data-testid="new-terminal-branch-existing"
                  >
                    {!picked && <option value="">Pick a repository first</option>}
                    {picked && !branches?.list && !branches?.error && <option value="">Loading branches…</option>}
                    {branches?.list?.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  {branches?.error && <span className="field-hint">{branches.error}</span>}
                </>
              )}
            </>
          )}
        </div>

        <label className="field">
          <span className="field-label">Agent</span>
          <select className="select" value={agent} onChange={(e) => setAgent(e.target.value as AgentId | "")} data-testid="new-terminal-agent">
            <option value="">Shell</option>
            {installed.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
            {/* A preselected agent that is not installed stays visible, so the server's answer explains it. */}
            {agentInfo && !agentInfo.installed && <option value={agentInfo.id}>{agentInfo.label}</option>}
          </select>
          {agentInfo?.connect === "project-config" && (
            <span className="field-hint">Commits .qwen/settings.json once (in the workspace or project folder) if graph-manager's tools are not connected yet.</span>
          )}
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
            {busy ? (
              <>
                <span className="btn-spinner" aria-hidden="true" />
                {agent ? "Connecting tools…" : "Opening…"}
              </>
            ) : (
              "Open"
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
