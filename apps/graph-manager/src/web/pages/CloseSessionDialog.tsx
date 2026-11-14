// "acme/api has uncommitted changes.": asked when the last terminal of a session closes and its clone has changes
// (docs/prd/hosted-sessions.md, "Session lifecycle"). There is no cancel: the session waits (`asking`) for an answer.

import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../ui/focus";

/** The files the dialog lists before "and N more". */
export const MAX_FILES = 20;

const NOOP = () => {};

export function CloseSessionDialog({
  open,
  label,
  changes,
  error,
  busy,
  onPush,
  onKeep,
  onDiscard,
}: {
  open: boolean;
  label: string;
  /** The changed files; undefined when not known (e.g. after a reload). */
  changes?: string[];
  /** Set after a failed push: the dialog offers Retry and Discard. */
  error?: string;
  busy?: "push" | "keep" | "discard";
  onPush(): void;
  onKeep(): void;
  onDiscard(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Esc does nothing: there is no "cancel", only the three answers.
  useFocusTrap(ref, open, NOOP);
  if (!open) return null;
  const shown = changes?.slice(0, MAX_FILES) ?? [];
  const more = (changes?.length ?? 0) - shown.length;
  const failed = error !== undefined;
  return createPortal(
    <div className="dialog-overlay">
      <div ref={ref} className="dialog close-session-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="close-session-dialog">
        <h2 id={titleId} className="dialog-title">
          {`${label} has uncommitted changes.`}
        </h2>
        <div className="dialog-body">
          {failed ? (
            <p className="field-error" role="alert" data-testid="close-error">
              {error}
            </p>
          ) : (
            <p className="muted">Push them to the session's branch, keep the session open without a terminal, or discard them.</p>
          )}
          {shown.length > 0 && (
            <ul className="close-session-files mono" data-testid="close-files">
              {shown.map((f) => (
                <li key={f} title={f}>
                  {f}
                </li>
              ))}
              {more > 0 && <li className="muted">{`and ${more} more`}</li>}
            </ul>
          )}
        </div>
        <div className="dialog-actions">
          {!failed && (
            <button type="button" className="btn" disabled={busy !== undefined} onClick={onKeep} data-testid="close-keep">
              Keep open
            </button>
          )}
          <button type="button" className="btn btn-danger" disabled={busy !== undefined} onClick={onDiscard} data-testid="close-discard">
            Discard
          </button>
          <button type="button" className="btn btn-primary" disabled={busy !== undefined} onClick={onPush} data-autofocus data-testid="close-push">
            {busy === "push" && <span className="btn-spinner" aria-hidden="true" />}
            {failed ? "Retry" : busy === "push" ? "Pushing…" : "Push to branch"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
