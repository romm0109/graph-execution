import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./focus";
import { Kbd } from "./Kbd";

/**
 * A modal confirm dialog on a fixed overlay. Esc (or Cancel) calls `onCancel`; focus starts on Cancel, stays inside,
 * and goes back to the opener on close. `extraAction` adds a third button (e.g. "Open run").
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "primary",
  onConfirm,
  onCancel,
  extraAction,
  busy = false,
}: {
  open: boolean;
  title: ReactNode;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
  extraAction?: { label: string; onClick: () => void };
  busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useFocusTrap(ref, open, onCancel);
  if (!open) return null;
  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}>
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        <div id={bodyId} className="dialog-body">
          {body}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} data-autofocus>
            {cancelLabel} <Kbd>Esc</Kbd>
          </button>
          {extraAction && (
            <button type="button" className="btn" onClick={extraAction.onClick}>
              {extraAction.label}
            </button>
          )}
          <button type="button" className={tone === "danger" ? "btn btn-danger btn-solid" : "btn btn-primary"} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
