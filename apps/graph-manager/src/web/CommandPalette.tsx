import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useOverview } from "./overview";
import { workspaceLabel } from "./runs";
import { Icon, type IconName } from "./ui/Icon";
import { Kbd } from "./ui/Kbd";
import { StatusBadge } from "./ui/StatusBadge";
import { useFocusTrap } from "./ui/focus";

export interface PaletteItem {
  id: string;
  group: "Pages" | "Actions" | "Runs" | "Terminals" | "Workspaces";
  icon: IconName;
  label: string;
  secondary?: string;
  badge?: ReactNode;
  to: string;
}

const MAX_RESULTS = 60;

/** Case-insensitive substring over the label and the secondary text; every word of the query has to match. */
export function matchItem(item: PaletteItem, query: string): boolean {
  const hay = `${item.label} ${item.secondary ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Jump to any page, run, terminal or workspace. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <PaletteDialog onClose={onClose} />;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const { runs, terminals, workspaces } = useOverview();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true, onClose);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [
      { id: "p:runs", group: "Pages", icon: "runs", label: "Runs", secondary: "page", to: "/runs" },
      { id: "p:terminals", group: "Pages", icon: "terminal", label: "Terminals", secondary: "page", to: "/terminals" },
      { id: "p:workspaces", group: "Pages", icon: "folder", label: "Workspaces", secondary: "page", to: "/workspaces" },
      { id: "p:settings", group: "Pages", icon: "settings", label: "Settings", secondary: "page", to: "/settings" },
      { id: "a:start", group: "Actions", icon: "plus", label: "Start run", secondary: "action", to: "/runs?start=1" },
      { id: "a:clone", group: "Actions", icon: "plus", label: "Clone repository", secondary: "action", to: "/workspaces?clone=1" },
    ];
    for (const r of runs) {
      list.push({
        id: `r:${r.workspaceId}/${r.id}`,
        group: "Runs",
        icon: "runs",
        label: r.id,
        secondary: `${workspaceLabel(r.workspaceId)} ${r.status}`,
        badge: <StatusBadge kind="run" value={r.status} />,
        to: `/runs/${encodeURIComponent(r.workspaceId)}/${encodeURIComponent(r.id)}`,
      });
    }
    for (const t of terminals) {
      list.push({
        id: `t:${t.id}`,
        group: "Terminals",
        icon: "terminal",
        label: t.title,
        secondary: `${t.workspaceId ? workspaceLabel(t.workspaceId) : t.cwd} ${t.status}`,
        badge: <StatusBadge kind="term" value={t.status} exitCode={t.exitCode} />,
        to: `/terminals?focus=${encodeURIComponent(t.id)}`,
      });
    }
    for (const w of workspaces) {
      list.push({ id: `w:${w.id}`, group: "Workspaces", icon: "folder", label: w.fullPath, secondary: `${w.forge} ${w.branch}`, to: "/workspaces" });
      list.push({
        id: `wt:${w.id}`,
        group: "Actions",
        icon: "terminal",
        label: `Open terminal in ${w.fullPath}`,
        secondary: w.forge,
        to: `/terminals?workspace=${encodeURIComponent(w.id)}`,
      });
    }
    return list;
  }, [runs, terminals, workspaces]);

  const results = useMemo(() => items.filter((i) => matchItem(i, query)).slice(0, MAX_RESULTS), [items, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (active >= results.length && results.length > 0) setActive(results.length - 1);
  }, [active, results.length]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const open = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    navigate(item.to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const down = e.key === "ArrowDown" || (e.ctrlKey && (e.key === "j" || e.key === "n"));
    const up = e.key === "ArrowUp" || (e.ctrlKey && (e.key === "k" || e.key === "p"));
    if (down) {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (up) {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(results[active]);
    }
  };

  let lastGroup = "";
  return (
    <div className="palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Jump to" ref={dialogRef} onKeyDown={onKeyDown} data-testid="palette">
        <div className="palette-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            data-autofocus
            className="palette-input"
            placeholder="Jump to a run, terminal or workspace…"
            aria-label="Jump to"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[active] ? `palette-item-${active}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul className="palette-results" id="palette-results" role="listbox" ref={listRef}>
          {results.length === 0 && <li className="palette-empty muted">No matches</li>}
          {results.map((item, i) => {
            const head = item.group !== lastGroup ? item.group : undefined;
            lastGroup = item.group;
            return (
              <li key={item.id} role="presentation">
                {head && <div className="palette-group t-label">{head}</div>}
                <div
                  id={`palette-item-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  className={i === active ? "palette-item active" : "palette-item"}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => open(item)}
                >
                  <Icon name={item.icon} size={14} />
                  <span className={item.group === "Runs" ? "palette-label mono" : "palette-label"}>{item.label}</span>
                  {item.group !== "Pages" && item.group !== "Actions" && item.secondary && (
                    <span className="palette-secondary muted">{item.group === "Workspaces" ? item.secondary : item.secondary.replace(/ \S+$/, "")}</span>
                  )}
                  {item.badge}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
