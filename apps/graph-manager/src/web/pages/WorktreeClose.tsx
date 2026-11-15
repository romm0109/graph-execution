// Closing a terminal whose worktree holds work (KAN-100): Delete, Keep or Create PR, or Cancel to leave it open.
import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../ui/focus";
import { Kbd } from "../ui/Kbd";

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
