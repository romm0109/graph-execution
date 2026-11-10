// The floating spec pane of the Terminals page: the spec being written in the focused workspace, over the terminals.
// It follows the file while it is written; the user reads it here and answers the agent in the terminal.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ApiError, api } from "../api";
import { SpecView } from "../components/SpecView";
import { useOnRefresh } from "../overview";
import { POLL_MS } from "../runs";
import { Icon } from "../ui/Icon";
import { useTheme } from "../ui/theme";
import { clampBox, defaultBox, EDGES, loadBox, resizeBox, saveBox, type Box, type Edge } from "./specPane";
import "./SpecFloat.css";

/** One entry of `GET /api/workspaces/:id/specs`. */
export interface SpecEntry {
  path: string;
  name: string;
  title: string;
  mtimeMs: number;
  size: number;
}

/** Polls `setTimeout`-style while the page is visible; runs `load` at once and when the page comes back. */
function usePoll(load: (() => Promise<void>) | undefined): void {
  useEffect(() => {
    if (!load) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!document.hidden) await load();
      if (!stop) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);
}

/**
 * The specs of workspace `ws`, polled every POLL_MS while the page is visible. `ws` is the workspace the answer is
 * for (undefined until the first answer); a failed poll keeps the last good answer.
 */
export function useWorkspaceSpecs(ws: string | undefined): { ws?: string; specs: SpecEntry[] } {
  const [answer, setAnswer] = useState<{ ws?: string; specs: SpecEntry[] }>({ specs: [] });
  const load = useCallback(async () => {
    if (!ws) return;
    try {
      const r = await api<{ specs?: SpecEntry[] }>(`/api/workspaces/${encodeURIComponent(ws)}/specs`);
      setAnswer({ ws, specs: Array.isArray(r?.specs) ? r.specs : [] });
    } catch {
      // keep the last good answer
    }
  }, [ws]);
  usePoll(ws ? load : undefined);
  useOnRefresh(() => void load());
  // An answer for another workspace (the one focused before, or a late one) is not shown.
  return answer.ws !== undefined && answer.ws === ws ? answer : EMPTY_SPECS;
}

const EMPTY_SPECS: { ws?: string; specs: SpecEntry[] } = { specs: [] };

type FileState = { kind: "loading" } | { kind: "ok"; text: string; mtimeMs: number } | { kind: "gone" } | { kind: "error"; message: string };

const baseName = (p: string) => p.split("/").pop() ?? p;

function viewOf(el: HTMLElement | null | undefined): { w: number; h: number } {
  const parent = el?.parentElement;
  const r = parent?.getBoundingClientRect();
  if (r && r.width > 0 && r.height > 0) return { w: r.width, h: r.height };
  return { w: window.innerWidth, h: window.innerHeight };
}

export function SpecFloat({
  ws,
  path,
  specs,
  narrow,
  onSelect,
  onClose,
}: {
  ws: string;
  path: string;
  specs: SpecEntry[];
  narrow: boolean;
  onSelect(path: string): void;
  onClose(): void;
}) {
  const { resolved } = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const [file, setFile] = useState<FileState>({ kind: "loading" });

  // The file, polled while mounted; a new state only when its mtime changed.
  const url = `/api/workspaces/${encodeURIComponent(ws)}/specs/file?path=${encodeURIComponent(path)}`;
  useEffect(() => {
    setFile({ kind: "loading" });
    scrollTop.current = 0;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [url]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ path: string; text: string; mtimeMs: number }>(url);
      setFile((f) => (f.kind === "ok" && f.mtimeMs === r.mtimeMs && f.text === r.text ? f : { kind: "ok", text: String(r.text ?? ""), mtimeMs: r.mtimeMs }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setFile({ kind: "gone" });
      else setFile((f) => (f.kind === "ok" ? f : { kind: "error", message: err instanceof Error ? err.message : String(err) }));
    }
  }, [url]);
  usePoll(load);

  // Keep the reading position across updates of the text.
  const text = file.kind === "ok" ? file.text : undefined;
  useLayoutEffect(() => {
    if (bodyRef.current && text !== undefined) bodyRef.current.scrollTop = scrollTop.current;
  }, [text]);

  // The box: saved, clamped to the main area.
  const [box, setBox] = useState<Box | null>(null);
  const boxRef = useRef<Box | null>(null);
  boxRef.current = box;
  useLayoutEffect(() => {
    const view = viewOf(rootRef.current);
    const tabbar = rootRef.current?.parentElement?.querySelector<HTMLElement>(".terms-tabbar");
    setBox(clampBox(loadBox() ?? defaultBox(view, tabbar?.offsetHeight ?? 0), view));
  }, []);
  useEffect(() => {
    const onResize = () => setBox((b) => (b ? clampBox(b, viewOf(rootRef.current)) : b));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startPointer = (e: ReactPointerEvent<HTMLElement>, mode: "move" | Edge) => {
    if (narrow || e.button !== 0 || !boxRef.current) return;
    if (mode === "move" && (e.target as HTMLElement).closest("button, select, input, a")) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, box: boxRef.current };
    const view = viewOf(rootRef.current);
    const target = e.currentTarget;
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {
      // not every environment supports pointer capture
    }
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      const b = start.box;
      setBox(mode === "move" ? clampBox({ ...b, x: b.x + dx, y: b.y + dy }, view) : resizeBox(b, mode, dx, dy, view));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (boxRef.current) saveBox(boxRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const name = specs.find((s) => s.path === path)?.name ?? baseName(path);
  const options = specs.some((s) => s.path === path) ? specs : [{ path, name } as SpecEntry, ...specs];
  const style = !narrow && box ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined;

  return (
    <div
      ref={rootRef}
      className={`spec-float${narrow ? " narrow" : ""}`}
      role="dialog"
      aria-label={`Spec ${name}`}
      aria-modal="false"
      data-testid="spec-float"
      style={style}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="sf-head" onPointerDown={(e) => startPointer(e, "move")} data-testid="spec-drag">
        <span className="sf-label">spec</span>
        <span className="sf-path mono" title={path}>
          {path}
        </span>
        <span className="tp-spacer" />
        {options.length > 1 && (
          <select className="sf-select" aria-label="Spec" value={path} onChange={(e) => onSelect(e.target.value)} data-testid="spec-select">
            {options.map((s) => (
              <option key={s.path} value={s.path}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="tp-icon sf-close" aria-label="Close spec" onClick={onClose} data-testid="spec-close">
          <Icon name="close" size={13} />
        </button>
      </div>
      <div
        ref={bodyRef}
        className="sf-body"
        tabIndex={0}
        onScroll={(e) => {
          scrollTop.current = e.currentTarget.scrollTop;
        }}
        data-testid="spec-body"
      >
        {file.kind === "ok" ? (
          <SpecView text={file.text} theme={resolved} />
        ) : (
          <p className="muted sf-note" role={file.kind === "gone" || file.kind === "error" ? "status" : undefined}>
            {file.kind === "gone" ? "This spec was moved or deleted." : file.kind === "error" ? file.message : "Loading…"}
          </p>
        )}
      </div>
      {!narrow && <button type="button" tabIndex={-1} className="sf-resize" aria-label="Resize spec" onPointerDown={(e) => startPointer(e, "se")} data-testid="spec-resize" />}
      {!narrow &&
        EDGES.filter((edge) => edge !== "se").map((edge) => (
          <span key={edge} className={`sf-edge sf-edge-${edge}`} aria-hidden="true" onPointerDown={(e) => startPointer(e, edge)} data-testid={`spec-resize-${edge}`} />
        ))}
    </div>
  );
}
