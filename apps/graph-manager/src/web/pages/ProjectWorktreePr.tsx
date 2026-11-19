// Create PR for a project terminal (docs/prd/project-terminal-worktrees.md): one linked PR per repo with work, each with
// its own Merge into; then each repo's steps, the linking, the error and Retry, until every PR is open.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, post } from "../api";
import { useFocusTrap } from "../ui/focus";
import { Kbd } from "../ui/Kbd";
import { PR_POLL_MS, PrSteps, type ProjectPrJob, type ProjectPrJobRepo } from "./PrPanel";
import { workText } from "./WorktreeClose";

export interface ProjectWorktreePrTarget {
  projectId: string;
  worktreeId: string;
  title: string;
  repos: { name: string; baseBranch?: string; dirty: number; ahead: number; isolated: boolean }[];
}

const STATE_LABEL: Record<ProjectPrJobRepo["status"], string> = {
  pending: "waiting",
  running: "creating…",
  done: "opened",
  failed: "failed",
  skipped: "skipped",
};

const hasWork = (r: { dirty: number; ahead: number; isolated: boolean }): boolean => r.isolated && (r.dirty > 0 || r.ahead > 0);

export function ProjectWorktreePrDialog({ target, onClose, onDone }: { target: ProjectWorktreePrTarget | null; onClose(): void; onDone(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [bases, setBases] = useState<Record<string, string>>({});
  const [job, setJob] = useState<ProjectPrJob | undefined>(undefined);
  const [error, setError] = useState("");
  useFocusTrap(ref, target !== null, onClose);
  const url = target ? `/api/projects/${encodeURIComponent(target.projectId)}/worktrees/${encodeURIComponent(target.worktreeId)}/pr` : "";

  useEffect(() => {
    setTitle(target?.title ?? "");
    setBody("");
    setBases(Object.fromEntries((target?.repos ?? []).filter(hasWork).map((r) => [r.name, r.baseBranch ?? ""])));
    setJob(undefined);
    setError("");
  }, [target]);

  const running = job?.status === "running";
  useEffect(() => {
    if (!running || !url) return;
    const timer = setTimeout(() => {
      void api<{ job?: ProjectPrJob }>(url)
        .then((r) => {
          if (r.job) {
            setJob(r.job);
            if (r.job.status === "done") onDone();
          } else setJob((j) => (j ? { ...j } : j));
        })
        .catch(() => setJob((j) => (j ? { ...j } : j)));
    }, PR_POLL_MS);
    return () => clearTimeout(timer);
  }, [running, job, url, onDone]);

  const start = useCallback(
    async (retry: boolean) => {
      setError("");
      const given = Object.fromEntries(Object.entries(bases).filter(([, b]) => b.trim() !== "").map(([n, b]) => [n, b.trim()]));
      try {
        const res = await post<{ job: ProjectPrJob }>(url, { title, body, ...(Object.keys(given).length > 0 ? { bases: given } : {}), ...(retry ? { retry: true } : {}) });
        setJob(res.job);
      } catch (err) {
        setError(err instanceof ApiError ? err.error : String(err));
      }
    },
    [url, title, body, bases],
  );

  if (!target) return null;
  const failed = job?.status === "failed";
  const done = job?.status === "done";
  const changed = target.repos.filter(hasWork);
  const idle = target.repos.filter((r) => !hasWork(r));
  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="project-worktree-pr">
        <h2 id={titleId} className="dialog-title">
          Create PRs for “{target.title}”
        </h2>
        {done ? (
          <ul className="dialog-body" data-testid="project-pr-links">
            {job.repos
              .filter((r) => r.pr)
              .map((r) => (
                <li key={r.name}>
                  <span className="mono">{r.name}</span>{" "}
                  <a href={r.pr!.url} target="_blank" rel="noreferrer" data-testid={`project-pr-link-${r.name}`}>
                    #{r.pr!.number} ↗
                  </a>
                </li>
              ))}
          </ul>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Title</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} readOnly={running} required data-autofocus data-testid="project-pr-title" />
            </label>
            <label className="field">
              <span className="field-label">Body</span>
              <textarea className="textarea mono" rows={4} value={body} onChange={(e) => setBody(e.target.value)} readOnly={running} data-testid="project-pr-body" />
            </label>
            <div className="field" data-testid="project-pr-repos">
              <span className="field-label">Repos</span>
              {changed.map((r) => {
                const jr = job?.repos.find((x) => x.name === r.name);
                return (
                  <div key={r.name} className="project-pr-repo" data-testid={`project-pr-repo-${r.name}`}>
                    <div>
                      <span className="mono">{r.name}</span> <span className="muted">{workText(r)}</span>
                      {jr && <span className="muted" data-testid={`project-pr-state-${r.name}`}> · {jr.pr && jr.status === "skipped" ? "already open" : STATE_LABEL[jr.status]}</span>}
                    </div>
                    <label className="field">
                      <span className="field-label">Merge into</span>
                      <input
                        className="input mono"
                        value={bases[r.name] ?? ""}
                        placeholder="the branch the worktree came from"
                        onChange={(e) => setBases((b) => ({ ...b, [r.name]: e.target.value }))}
                        readOnly={running}
                        data-testid={`pr-base-${r.name}`}
                      />
                    </label>
                    {jr && jr.status !== "pending" && jr.status !== "skipped" && (
                      <PrSteps job={{ id: job!.id, status: "running", steps: jr.steps, base: "", branch: "", startedAt: job!.startedAt }} />
                    )}
                    {jr?.error && (
                      <pre className="field-error pr-error" data-testid={`project-pr-error-${r.name}`}>
                        {jr.error}
                      </pre>
                    )}
                  </div>
                );
              })}
              {idle.map((r) => (
                <div key={r.name} className="project-pr-repo muted" data-testid={`project-pr-skip-${r.name}`}>
                  <span className="mono">{r.name}</span> {r.isolated ? "no changes" : "not isolated"} · skipped
                </div>
              ))}
            </div>
            {job && job.link.state !== "pending" && (
              <p className="muted" data-testid="project-pr-link-state">
                Linking: {job.link.state}
                {job.link.detail ? ` — ${job.link.detail}` : ""}
              </p>
            )}
            {failed && job?.error && (
              <pre className="field-error pr-error" data-testid="project-pr-job-error">
                {job.error}
              </pre>
            )}
            {error && (
              <pre className="field-error pr-error" data-testid="project-pr-post-error">
                {error}
              </pre>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {done ? "Close" : "Cancel"} <Kbd>Esc</Kbd>
          </button>
          {!done && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={running || title.trim() === "" || changed.length === 0}
              onClick={() => void start(failed)}
              data-testid={failed ? "project-pr-retry" : "project-pr-submit"}
            >
              {running ? "Creating…" : failed ? "Retry" : "Create PRs"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
