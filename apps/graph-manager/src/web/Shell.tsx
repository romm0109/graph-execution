import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { CommandPalette } from "./CommandPalette";
import { isInTerminal, isTypingTarget, useKey } from "./keys";
import { useOverview } from "./overview";
import { useFocusTrap } from "./ui/focus";
import { Icon, type IconName } from "./ui/Icon";
import { Kbd } from "./ui/Kbd";
import { NARROW, useMedia } from "./ui/media";
import { listenForInstallPrompt, useStandaloneLinks } from "./ui/standalone";
import { useTheme, type ThemePref } from "./ui/theme";
import { useVisualViewport } from "./ui/viewport";
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
    approvals: runs.filter((r) => r.status === "awaiting-approval").length,
    noForge: loaded && !forges.github.connected && !forges.gitlab.connected,
  };
}

const NEXT_THEME: Record<ThemePref, ThemePref> = { dark: "system", system: "light", light: "dark" };
const THEME_ICON: Record<ThemePref, IconName> = { system: "monitor", light: "sun", dark: "moon" };
const CHORD: Record<string, string> = { r: "/runs", a: "/approvals", t: "/terminals", w: "/workspaces", p: "/projects", v: "/reviewers", s: "/settings" };
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

const PAGE_TITLES: Record<string, string> = {
  runs: "Runs",
  approvals: "Approvals",
  terminals: "Terminals",
  workspaces: "Workspaces",
  projects: "Projects",
  reviewers: "Reviewers",
  settings: "Settings",
};

/** The phone top bar title: the page name, or the run id on a run page. */
export function pageTitle(pathname: string): string {
  const m = RUN_DETAIL.exec(pathname);
  if (m) return decodeURIComponent(m[2]!);
  return PAGE_TITLES[pathname.split("/")[1] ?? ""] ?? "graph-manager";
}

/** The app frame: the nav (a 56px rail from 900 to 1099px; a top bar and a drawer below 900px), the scrolling main area, the command palette and global keys. */
export function Shell({ children, onLogout, extensions = [] }: { children: ReactNode; onLogout: () => void; extensions?: string[] }) {
  useVisualViewport();
  useStandaloneLinks();
  useEffect(() => listenForInstallPrompt(), []);
  const c = useNavCounts();
  const { runs } = useOverview();
  const { pathname, search } = useLocation();
  const rail = isLiveRunDetail(pathname, runs);
  const navigate = useNavigate();
  const { pref, setPref } = useTheme();
  const [host, setHost] = useState("");
  const [palette, setPalette] = useState(false);
  const chordAt = useRef(0);

  // Phones (below 900px): the nav is a drawer opened from the top bar's ☰.
  const narrow = useMedia(NARROW);
  const [navOpen, setNavOpen] = useState(false);
  const drawerOpen = narrow && navOpen;
  const navRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeNav = useCallback(() => setNavOpen(false), []);
  useFocusTrap(navRef, drawerOpen, closeNav);
  // Back to ☰ on close. iOS doesn't focus a tapped button, so the trap's own "focus the opener" isn't enough.
  // Skipped when the palette just opened: its own trap keeps focus in its input.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !drawerOpen && narrow && !palette) menuRef.current?.focus();
    wasOpen.current = drawerOpen;
  }, [drawerOpen, narrow, palette]);
  // A route change (a nav link or status row tap) closes it; so does growing past 900px.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname, search]);
  useEffect(() => {
    if (!narrow) setNavOpen(false);
  }, [narrow]);

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
      {narrow && (
        <header className="gm-topbar" data-testid="gm-topbar">
          <button
            ref={menuRef}
            type="button"
            className="gm-topbar-menu"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="gm-nav"
            data-testid="nav-menu"
            onClick={() => setNavOpen(true)}
          >
            <Icon name="menu" size={18} />
          </button>
          <span className="gm-topbar-brand" aria-hidden="true">
            <Icon name="logo" size={20} />
          </span>
          <span className="gm-topbar-title" data-testid="topbar-title">
            {pageTitle(pathname)}
          </span>
          {c.live > 0 && (
            <Link to="/runs?status=live" className="gm-topbar-live" aria-label={`${c.live} ${c.live === 1 ? "run" : "runs"} live`} data-testid="topbar-live">
              <span className="glyph glyph-pulse tone-live" aria-hidden="true" />
            </Link>
          )}
        </header>
      )}
      {drawerOpen && <div className="gm-nav-scrim" data-testid="nav-scrim" onClick={closeNav} aria-hidden="true" />}
      <nav
        ref={navRef}
        id="gm-nav"
        className={drawerOpen ? "gm-nav drawer" : "gm-nav"}
        aria-label="Main"
        tabIndex={-1}
        // Tapping the link of the page you're already on doesn't change the route; close the drawer anyway.
        onClick={(e) => {
          if (drawerOpen && (e.target as Element).closest("a")) closeNav();
        }}
      >
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
            to="/approvals"
            icon="check"
            label="Approvals"
            dot={c.approvals > 0 ? "warn" : undefined}
            badge={
              c.approvals > 0 ? (
                <span className="nav-count" data-testid="approvals-count">
                  {c.approvals}
                </span>
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
          {extensions.map((name) => (
            <NavItem key={name} to={`/x/${name}`} icon="extension" label={name} />
          ))}
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
          <button type="button" className="nav-jump" onClick={() => {
              setNavOpen(false);
              setPalette(true);
            }}
            aria-label="Jump to…" title="Jump to… (Ctrl K)">
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
