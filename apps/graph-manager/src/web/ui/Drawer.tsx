import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./focus";
import { Icon } from "./Icon";

/**
 * A right-side panel (360px; full width under 900px) over a dimmed page. Tab stays inside, Esc or a click outside
 * closes it, and focus goes back to the element that opened it.
 */
export function Drawer({
  open,
  title,
  onClose,
  footer,
  children,
  testId,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useFocusTrap(ref, open, onClose);
  if (!open) return null;
  return createPortal(
    <>
      <div className="drawer-overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={ref} className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid={testId}>
        <div className="drawer-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer !== undefined && <div className="drawer-footer">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}
