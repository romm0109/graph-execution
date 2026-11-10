import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusGlyph } from "./StatusBadge";
import type { Glyph } from "./status";

export type ToastTone = "ok" | "bad" | "live";
export interface ToastAction {
  label: string;
  /** An in-app path; navigates without a reload (react-router's BrowserRouter listens to popstate). */
  to?: string;
  onClick?: () => void;
}
export interface ToastInput {
  tone: ToastTone;
  text: string;
  action?: ToastAction;
  /** Stays until the user presses its action or × (then `onDismiss` runs), or `dismiss(id)` is called. */
  sticky?: boolean;
  /** A sticky toast's × was pressed. */
  onDismiss?: () => void;
}
interface ToastItem extends ToastInput {
  id: number;
}

export const TOAST_MS = 6000;
const GLYPH: Record<ToastTone, Glyph> = { ok: "dot", bad: "diamond", live: "pulse" };

interface ToastApi {
  /** Shows a toast; returns its id, for `dismiss`. */
  show(t: ToastInput): number;
  /** Removes a toast without running its `onDismiss`. */
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Navigates to an in-app path without a Router: pushState, then the popstate BrowserRouter listens to. */
export function navigateTo(to: string): void {
  try {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch {
    window.location.assign(to);
  }
}

/** Shows toasts bottom-right; each disappears after 6 s unless sticky. Works inside or outside a Router. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t !== undefined) clearTimeout(t);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (t: ToastInput) => {
      const id = nextId.current++;
      setToasts((list) => [...list, { ...t, id }]);
      if (!t.sticky)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), TOAST_MS),
        );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" data-testid="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast tone-${t.tone}`} role="status" data-tone={t.tone}>
            <StatusGlyph tone={t.tone} glyph={GLYPH[t.tone]} />
            <span className="toast-text">{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  const a = t.action;
                  dismiss(t.id);
                  a?.onClick?.();
                  if (a?.to !== undefined) navigateTo(a.to);
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.sticky && (
              <button
                type="button"
                className="toast-action toast-dismiss"
                aria-label="Dismiss"
                title="Dismiss"
                onClick={() => {
                  dismiss(t.id);
                  t.onDismiss?.();
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const NOOP: ToastApi = { show: () => 0, dismiss: () => {} };

/** `show()` a toast. Outside a `ToastProvider` (e.g. a page rendered alone in a test) it does nothing. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}
