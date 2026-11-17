// Closing a terminal whose worktree holds work (KAN-100): Delete, Keep or Create PR, or Cancel to leave it open.
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../api";
import { useFocusTrap } from "../ui/focus";
import { Kbd } from "../ui/Kbd";
import type { ProjectWork } from "../types";

export interface WorktreeWork {
  title: string;
  branch: string;
  dirty: number;
  ahead: number;
}

/** "3 uncommitted files and 1 commit", "1 commit", … */
export function workText(w: { dirty: number; ahead: number }): string {
  const parts: string[] = [];
  if (w.dirty > 0) parts.push(`${w.dirty} uncommitted file${w.dirty === 1 ? "" : "s"}`);
  if (w.ahead > 0) parts.push(`${w.ahead} commit${w.ahead === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" and ") : "no changes";
}

export function WorktreeCloseDialog({
  work,
  onDelete,
  onKeep,
  onCreatePr,
  onCancel,
}: {
  work: WorktreeWork | null;
  onDelete(): void;
  onKeep(): void;
  onCreatePr?: () => void;
  onCancel(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useFocusTrap(ref, work !== null, onCancel);
  if (!work) return null;
  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1} data-testid="worktree-close">
        <h2 id={titleId} className="dialog-title">
          Close “{work.title}”?
        </h2>
        <div id={bodyId} className="dialog-body">
          <span className="mono">{work.branch}</span> has {workText(work)}. Delete it, keep the worktree to come back to it, or open a pull request.
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} data-autofocus>
            Cancel <Kbd>Esc</Kbd>
          </button>
          <button type="button" className="btn btn-danger" onClick={onDelete} data-testid="close-delete">
            Delete
          </button>
          <button type="button" className="btn" onClick={onKeep} data-testid="close-keep">
            Keep
          </button>
          {onCreatePr && (
            <button type="button" className="btn btn-primary" onClick={onCreatePr} data-testid="close-pr">
              Create PR
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The files of a failed Merge project files when it was a conflict (`409 { error: "merge conflict", files }`). */
export function mergeConflictFiles(err: unknown): string[] | undefined {
  if (!(err instanceof ApiError) || err.status !== 409) return undefined;
  const files = (err.body as { files?: unknown } | undefined)?.files;
  return Array.isArray(files) && files.length > 0 ? files.map(String) : undefined;
}

/** Why Merge project files failed, for a message. */
export function mergeErrorText(err: unknown): string {
  const files = mergeConflictFiles(err);
  if (files) return `Merge conflict in: ${files.join(", ")}. The worktree stays; resolve it in a terminal on it.`;
  return err instanceof ApiError ? err.error : err instanceof Error ? err.message : String(err);
}

/** Closing a project terminal (docs/prd/project-terminal-worktrees.md): the work in its project and repo worktrees. */
export function ProjectWorktreeCloseDialog({
  work,
  onDelete,
  onKeep,
  onCreatePr,
  onMergeProject,
  onCancel,
}: {
  work: ProjectWork | null;
  onDelete(): void;
  onKeep(): void;
  onCreatePr?: () => void;
  /** Merge project files: commit the project worktree's changes and merge its branch into the project folder's. */
  onMergeProject?: () => Promise<void>;
  onCancel(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const [merged, setMerged] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const branch = work?.branch;
  useEffect(() => {
    setMerged(false);
    setMerging(false);
    setMergeError(null);
  }, [branch]);
  useFocusTrap(ref, work !== null, onCancel);
  if (!work) return null;
  const projectWork = work.project.dirty + work.project.ahead > 0;
  const merge = async () => {
    if (!onMergeProject) return;
    setMerging(true);
    setMergeError(null);
    try {
      await onMergeProject();
      setMerged(true);
    } catch (err) {
      setMergeError(mergeErrorText(err));
    } finally {
      setMerging(false);
    }
  };
  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1} data-testid="worktree-close">
        <h2 id={titleId} className="dialog-title">
          Close “{work.title}”?
        </h2>
        <div id={bodyId} className="dialog-body">
          <p>
            <span className="mono">{work.branch}</span> holds work. Delete all its worktrees, or keep them to come back to them.
          </p>
          <table className="close-work-table" data-testid="close-work-table">
            <tbody>
              <tr>
                <th scope="row">Project files</th>
                <td data-testid="close-project-work">{merged && !projectWork ? "merged" : workText(work.project)}</td>
              </tr>
              {work.repos.map((r) => (
                <tr key={r.name}>
                  <th scope="row" className="mono">
                    {r.name}
                  </th>
                  <td>{r.isolated ? workText(r) : "not isolated"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {mergeError && (
            <p role="alert" data-testid="close-merge-error">
              {mergeError}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} data-autofocus>
            Cancel <Kbd>Esc</Kbd>
          </button>
          <button type="button" className="btn btn-danger" onClick={onDelete} data-testid="close-delete">
            Delete all
          </button>
          <button type="button" className="btn" onClick={onKeep} data-testid="close-keep">
            Keep all
          </button>
          {onMergeProject && projectWork && (
            <button type="button" className="btn" onClick={() => void merge()} disabled={merging} data-testid="close-merge-project">
              {merging ? "Merging…" : "Merge project files"}
            </button>
          )}
          {onCreatePr && (
            <button type="button" className="btn btn-primary" onClick={onCreatePr} data-testid="close-pr">
              Create PR
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
