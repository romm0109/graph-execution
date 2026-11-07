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
}
interface ToastItem extends ToastInput {
  id: number;
}

export const TOAST_MS = 6000;
const GLYPH: Record<ToastTone, Glyph> = { ok: "dot", bad: "diamond", live: "pulse" };

interface ToastApi {
  show(t: ToastInput): void;
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

/** Shows toasts bottom-right; each disappears after 6 s. Works inside or outside a Router. */
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
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_MS),
      );
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

  const api = useMemo(() => ({ show }), [show]);

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
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const NOOP: ToastApi = { show: () => {} };

/** `show()` a toast. Outside a `ToastProvider` (e.g. a page rendered alone in a test) it does nothing. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}
