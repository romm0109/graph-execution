import type { ReactNode } from "react";

/** An empty state: what's missing and the one button that fixes it. */
export function EmptyState({ title, body, action, icon }: { title: ReactNode; body?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty-state" data-testid="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      <strong className="empty-state-title">{title}</strong>
      {body !== undefined && <div className="empty-state-body">{body}</div>}
      {action}
    </div>
  );
}
