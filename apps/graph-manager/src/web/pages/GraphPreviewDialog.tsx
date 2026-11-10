// A task folder's graph in a modal (docs/prd/agent-supervisor.md, `open_graph` / `propose_graph`): read-only, or with
// Approve / Reject when an agent proposes it.

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "../api";
import { workspaceLabel, type RunGraph } from "../runs";
import { useFocusTrap } from "../ui/focus";
import { Kbd } from "../ui/Kbd";
import { TaskGraph } from "./TaskGraph";
import "./GraphPreviewDialog.css";

const enc = encodeURIComponent;

export function GraphPreviewDialog({
  open,
  workspaceId,
  tasksDir,
  node,
  propose = false,
  onClose,
  onApprove,
  onReject,
}: {
  open: boolean;
  workspaceId: string;
  tasksDir: string;
  node?: string;
  /** Approve / Reject buttons (propose_graph); otherwise only Close. */
  propose?: boolean;
  onClose: () => void;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [graph, setGraph] = useState<RunGraph | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useFocusTrap(ref, open, onClose);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setGraph(undefined);
    setError(undefined);
    api<RunGraph>(`/api/workspaces/${enc(workspaceId)}/graph?tasksDir=${enc(tasksDir)}`).then(
      (g) => alive && setGraph(g),
      (e: unknown) => alive && setError(e instanceof ApiError ? e.error : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [open, workspaceId, tasksDir]);

  useEffect(() => {
    if (!graph || !node) return;
    const id = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(node) : node;
    bodyRef.current?.querySelector(`[data-testid="graph-node-${id}"]`)?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [graph, node]);

  if (!open) return null;
  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="dialog graph-preview" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="graph-preview">
        <div>
          <h2 id={titleId} className="dialog-title">
            Graph of {tasksDir}
          </h2>
          <div className="graph-preview-sub">{workspaceLabel(workspaceId)}</div>
        </div>
        <div ref={bodyRef} className="dialog-body graph-preview-body">
          {graph ? <TaskGraph graph={graph} selected={node} /> : error ? <span className="graph-preview-error">{error}</span> : "Loading…"}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} data-testid="graph-preview-close" data-autofocus={propose ? undefined : true}>
            Close <Kbd>Esc</Kbd>
          </button>
          {propose && (
            <>
              <button type="button" className="btn" onClick={onReject} data-testid="graph-preview-reject">
                Reject
              </button>
              <button type="button" className="btn btn-primary" onClick={onApprove} data-testid="graph-preview-approve" data-autofocus>
                Approve
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
