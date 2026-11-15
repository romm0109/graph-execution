// Create PR from a terminal's worktree (docs/prd/isolated-workspaces.md, KAN-100): title, body and Merge into, then the
// job's steps (access, commit, push, create) with its error and Retry, until the PR is open.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, post } from "../api";
import { useFocusTrap } from "../ui/focus";
import { Kbd } from "../ui/Kbd";
import { PR_POLL_MS, PrSteps, type PrJob } from "./PrPanel";

export interface WorktreePrTarget {
  workspaceId: string;
  worktreeId: string;
  title: string;
  branch: string;
}

export function WorktreePrDialog({ target, onClose, onDone }: { target: WorktreePrTarget | null; onClose(): void; onDone(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [job, setJob] = useState<PrJob | undefined>(undefined);
  const [pr, setPr] = useState<{ url: string; number: number } | undefined>(undefined);
  const [error, setError] = useState("");
  useFocusTrap(ref, target !== null, onClose);
  const url = target ? `/api/workspaces/${encodeURIComponent(target.workspaceId)}/worktrees/${encodeURIComponent(target.worktreeId)}/pr` : "";

  useEffect(() => {
    setTitle(target?.title ?? "");
    setBody("");
    setBase("");
    setJob(undefined);
    setPr(undefined);
    setError("");
  }, [target]);

  const running = job?.status === "running";
  useEffect(() => {
    if (!running || !url) return;
    const timer = setTimeout(() => {
      void api<{ job?: PrJob; pr?: { url: string; number: number } }>(url)
        .then((r) => {
          if (r.job) setJob(r.job);
          if (r.pr) {
            setPr(r.pr);
            onDone();
          }
        })
        .catch(() => setJob((j) => (j ? { ...j } : j)));
    }, PR_POLL_MS);
    return () => clearTimeout(timer);
  }, [running, job, url, onDone]);

  const start = useCallback(
    async (retry: boolean) => {
      setError("");
      try {
        const res = await post<{ job: PrJob }>(url, { title, body, ...(base.trim() ? { base: base.trim() } : {}), ...(retry ? { retry: true } : {}) });
        setJob(res.job);
      } catch (err) {
        setError(err instanceof ApiError ? err.error : String(err));
      }
    },
    [url, title, body, base],
  );

  if (!target) return null;
  const failed = job?.status === "failed";
  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="worktree-pr">
        <h2 id={titleId} className="dialog-title">
          Create PR from <span className="mono">{target.branch}</span>
        </h2>
        {pr ? (
          <p className="dialog-body">
            <a href={pr.url} target="_blank" rel="noreferrer" data-testid="worktree-pr-link">
              Pull request #{pr.number} ↗
            </a>
          </p>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Title</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} readOnly={running} required data-autofocus data-testid="worktree-pr-title" />
            </label>
            <label className="field">
              <span className="field-label">Merge into</span>
              <input className="input mono" value={base} placeholder="the branch the worktree came from" onChange={(e) => setBase(e.target.value)} readOnly={running} data-testid="worktree-pr-base" />
            </label>
            <label className="field">
              <span className="field-label">Body</span>
              <textarea className="textarea mono" rows={5} value={body} onChange={(e) => setBody(e.target.value)} readOnly={running} data-testid="worktree-pr-body" />
            </label>
            {job && <PrSteps job={job} />}
            {failed && job?.error && (
              <pre className="field-error pr-error" data-testid="worktree-pr-error">
                {job.error}
              </pre>
            )}
            {error && (
              <pre className="field-error pr-error" data-testid="worktree-pr-post-error">
                {error}
              </pre>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {pr ? "Close" : "Cancel"} <Kbd>Esc</Kbd>
          </button>
          {!pr && (
            <button type="button" className="btn btn-primary" disabled={running || title.trim() === ""} onClick={() => void start(failed)} data-testid={failed ? "worktree-pr-retry" : "worktree-pr-submit"}>
              {running ? "Creating…" : failed ? "Retry" : "Create PR"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
