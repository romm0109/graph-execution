import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { CommandPalette } from "./CommandPalette";
import { isInTerminal, isTypingTarget, useKey } from "./keys";
import { useOverview } from "./overview";
import { Icon, type IconName } from "./ui/Icon";
import { Kbd } from "./ui/Kbd";
import { useTheme, type ThemePref } from "./ui/theme";
import "./Shell.css";

type Tone = "live" | "warn" | "bad";

/** The counts behind the status block and the badges. */
export function useNavCounts() {
  const { runs, terminals, workspaces, forges, loaded } = useOverview();
  return {
    terminals: terminals.length,
    live: runs.filter((r) => r.live).length,
    failed: runs.filter((r) => r.status === "failed").length,
    workspaces: workspaces.length,
    noForge: loaded && !forges.github.connected && !forges.gitlab.connected,
  };
}

const NEXT_THEME: Record<ThemePref, ThemePref> = { dark: "system", system: "light", light: "dark" };
const THEME_ICON: Record<ThemePref, IconName> = { system: "monitor", light: "sun", dark: "moon" };
const CHORD: Record<string, string> = { r: "/runs", t: "/terminals", w: "/workspaces", p: "/projects", v: "/reviewers", s: "/settings" };
const CHORD_MS = 1000;

function StatusRow({ id, to, count, label, tone, glyph }: { id: string; to: string; count: number; label: string; tone: Tone; glyph: string }) {
  const cls = count === 0 ? "status-row zero" : `status-row tone-${tone}`;
  return (
    <Link to={to} className={cls} data-testid={`status-${id}`}>
      <span className={`glyph glyph-${count === 0 ? "ring" : glyph} tone-${count === 0 ? "mute" : tone}`} aria-hidden="true" />
      <span className="status-count num">{count}</span>
      <span className="status-label">{label}</span>
    </Link>
  );
}

function NavItem({ to, icon, label, badge, dot }: { to: string; icon: IconName; label: string; badge?: ReactNode; dot?: Tone }) {
  return (
    <NavLink to={to} className="nav-item" aria-label={label} title={label}>
      <span className="nav-icon">
        <Icon name={icon} />
      </span>
      <span className="nav-label">{label}</span>
      {badge !== undefined && <span className="nav-badge mono">{badge}</span>}
      {dot && <span className={`nav-dot tone-${dot}`} data-testid={`dot-${label}`} aria-hidden="true" />}
    </NavLink>
  );
}

const RUN_DETAIL = /^\/runs\/([^/]+)\/([^/]+)\/?$/;

/** True on the detail page of a run whose own page is live: the nav becomes a rail there (boards 10, 11). */
export function isLiveRunDetail(pathname: string, runs: { workspaceId: string; id: string; live: boolean }[]): boolean {
  const m = RUN_DETAIL.exec(pathname);
  if (!m) return false;
  const [ws, id] = [decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)];
  return runs.some((r) => r.live && r.workspaceId === ws && r.id === id);
}

/** The app frame: the nav (or a 56px rail below 1100px), the scrolling main area, the command palette and global keys. */
export function Shell({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const c = useNavCounts();
  const { runs } = useOverview();
  const { pathname } = useLocation();
  const rail = isLiveRunDetail(pathname, runs);
  const navigate = useNavigate();
  const { pref, setPref } = useTheme();
  const [host, setHost] = useState("");
  const [palette, setPalette] = useState(false);
  const chordAt = useRef(0);

  useEffect(() => {
    let alive = true;
    api<{ host?: string }>("/api/auth/info")
      .then((r) => alive && typeof r?.host === "string" && setHost(r.host))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const closePalette = useCallback(() => setPalette(false), []);
  useKey(
    "Ctrl+k",
    (e) => {
      e.preventDefault();
      setPalette((p) => !p);
    },
    { allowInInput: true },
  );

  // g-chords and "/": plain keys, never while typing or in a terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || isInTerminal(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const now = Date.now();
      if (chordAt.current && now - chordAt.current <= CHORD_MS) {
        chordAt.current = 0;
        const to = CHORD[e.key.toLowerCase()];
        if (to) {
          // Consumed: page bindings on the same letter (Runs' "s" → Start run) must not see it.
          e.preventDefault();
          e.stopImmediatePropagation();
          navigate(to);
          return;
        }
      }
      if (e.key === "g") {
        chordAt.current = now;
        return;
      }
      chordAt.current = 0;
      if (e.key === "/") {
        const el = document.querySelector<HTMLElement>("[data-filter]");
        if (el) {
          e.preventDefault();
          el.focus();
        }
      }
    };
    // Capture phase: runs before every page-level window listener (child effects register theirs first).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [navigate]);

  const runsDot: Tone | undefined = c.failed > 0 ? "bad" : c.live > 0 ? "live" : undefined;

  return (
    <div className={rail ? "gm-shell rail" : "gm-shell"} data-testid="gm-shell">
      <nav className="gm-nav" aria-label="Main">
        <div className="nav-brand">
          <Icon name="logo" size={22} />
          <div className="nav-brand-text">
            <strong>graph-manager</strong>
            {host && (
              <span className="nav-host mono" data-testid="nav-host">
                {host}
              </span>
            )}
          </div>
        </div>

        <div className="nav-status" data-testid="nav-status">
          <StatusRow id="live" to="/runs?status=live" count={c.live} label="runs live" tone="live" glyph="pulse" />
          <StatusRow id="failed" to="/runs?status=failed" count={c.failed} label={c.failed === 1 ? "run failed" : "runs failed"} tone="bad" glyph="diamond" />
        </div>

        <div className="nav-links">
          <NavItem
            to="/runs"
            icon="runs"
            label="Runs"
            dot={runsDot}
            badge={
              c.live > 0 || c.failed > 0 ? (
                <>
                  {c.live > 0 && <span className="tone-text-live">{c.live} live</span>}
                  {c.live > 0 && c.failed > 0 && " · "}
                  {c.failed > 0 && <span className="tone-text-bad">{c.failed} failed</span>}
                </>
              ) : undefined
            }
          />
          <NavItem
            to="/terminals"
            icon="terminal"
            label="Terminals"
            badge={c.terminals > 0 ? <span className="nav-count">{c.terminals}</span> : undefined}
          />
          <NavItem to="/workspaces" icon="folder" label="Workspaces" badge={c.workspaces > 0 ? <span className="nav-count">{c.workspaces}</span> : undefined} />
          <NavItem to="/projects" icon="projects" label="Projects" />
          <NavItem to="/reviewers" icon="review" label="Reviewers" />
          <NavItem
            to="/settings"
            icon="settings"
            label="Settings"
            dot={c.noForge ? "warn" : undefined}
            badge={c.noForge ? <span className="settings-dot" data-testid="settings-dot" title="No forge connected" /> : undefined}
          />
        </div>

        <div className="nav-spacer" />

        <div className="nav-footer">
          <button type="button" className="nav-jump" onClick={() => setPalette(true)} aria-label="Jump to…" title="Jump to… (Ctrl K)">
            <Icon name="search" size={14} />
            <span className="nav-jump-label">Jump to…</span>
            <Kbd>Ctrl K</Kbd>
          </button>
          <div className="nav-footer-row">
            <button
              type="button"
              className="nav-icon-btn"
              aria-label={`Theme: ${pref}. Switch to ${NEXT_THEME[pref]}`}
              title={`Theme: ${pref}`}
              data-theme-pref={pref}
              onClick={() => setPref(NEXT_THEME[pref])}
            >
              <Icon name={THEME_ICON[pref]} size={15} />
            </button>
            <span className="nav-spacer" />
            <button type="button" className="nav-logout" aria-label="Log out" title="Log out" onClick={onLogout}>
              <Icon name="logout" size={15} />
              <span className="nav-logout-label">Log out</span>
            </button>
          </div>
        </div>
      </nav>
      <main className="gm-main">{children}</main>
      <CommandPalette open={palette} onClose={closePalette} />
    </div>
  );
}
