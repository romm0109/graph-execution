import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ApiError, LOGOUT_EVENT, api, post } from "./api";
import { AgentRequestHost, VisibleTerminalsProvider } from "./agentRequests";
import { OverviewProvider } from "./overview";
import { loadPlugins, usePlugins } from "./plugins";
import { Shell } from "./Shell";
import Login from "./pages/Login";
import Projects from "./pages/Projects";
import RunDetail from "./pages/RunDetail";
import Runs from "./pages/Runs";
import Reviewers from "./pages/Reviewers";
import SetPassword from "./pages/SetPassword";
import Settings from "./pages/Settings";
import Signup from "./pages/Signup";
import Terminals from "./pages/Terminals";
import "./Shell.css";

type AuthState = "checking" | "in" | "out" | "expired" | "error";

type AuthMode = "users" | "gateway";

/** What `/api/auth/me` tells about the signed-in user; every field may be missing (older servers, test fakes). */
export interface Me {
  user?: { id: string; name: string; email?: string };
  mode?: AuthMode;
  logoutUrl?: string;
}

function meOf(body: unknown): Me {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const me: Me = {};
  const u = b.user as Record<string, unknown> | undefined;
  if (u && typeof u === "object" && typeof u.id === "string" && typeof u.name === "string") {
    me.user = { id: u.id, name: u.name, ...(typeof u.email === "string" ? { email: u.email } : {}) };
  }
  if (b.mode === "users" || b.mode === "gateway") me.mode = b.mode;
  if (typeof b.logoutUrl === "string") me.logoutUrl = b.logoutUrl;
  return me;
}

/** The server's sign-in mode from the public `/api/auth/info`; undefined when unknown. */
async function serverMode(): Promise<AuthMode | undefined> {
  try {
    // Plain fetch: `api` would announce a 401 as a logout, which asks this again.
    const res = await fetch("/api/auth/info", { headers: { accept: "application/json" } });
    if (!res.ok) return undefined;
    const info = (await res.json()) as { mode?: unknown } | null;
    return info?.mode === "gateway" || info?.mode === "users" ? info.mode : undefined;
  } catch {
    return undefined;
  }
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [me, setMe] = useState<Me>({});
  // A set-password link opens its page whoever is logged in (an admin may test an invite in their own browser).
  const [linkPage, setLinkPage] = useState(() => window.location.pathname === "/set-password");

  const loggedIn = useCallback(() => {
    window.history.replaceState({}, "", "/");
    setLinkPage(false);
    setAuth("in");
  }, []);

  /** Signed out: the login page, or in gateway mode (the gateway signs people in) the "sign-in has expired" gate. */
  const signedOut = useCallback(async () => {
    setAuth((await serverMode()) === "gateway" ? "expired" : "out");
  }, []);

  const check = useCallback(() => {
    api("/api/auth/me")
      .then((body) => {
        setMe(meOf(body));
        setAuth("in");
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void signedOut();
        else setAuth("error");
      });
  }, [signedOut]);

  useEffect(() => {
    check();
  }, [check]);

  // Plugins need a login (`/api/ui/plugins`): import them once signed in. A second call returns the first one's promise.
  const plugins = usePlugins();
  useEffect(() => {
    if (auth === "in") void loadPlugins();
  }, [auth]);

  useEffect(() => {
    // Signed in before, so `/api/auth/me` already told the mode.
    const onLogout = () => setAuth(me.mode === "gateway" ? "expired" : "out");
    window.addEventListener(LOGOUT_EVENT, onLogout);
    return () => window.removeEventListener(LOGOUT_EVENT, onLogout);
  }, [me.mode]);

  const logout = useCallback(async () => {
    if (me.mode === "gateway") {
      // The gateway owns the sign-in: log out there.
      if (me.logoutUrl) window.location.assign(me.logoutUrl);
      return;
    }
    try {
      await post("/api/auth/logout");
    } finally {
      setAuth("out");
    }
  }, [me.mode, me.logoutUrl]);

  if (linkPage) return <SetPassword onLogin={loggedIn} />;
  if (auth === "checking")
    return (
      <div className="gate" role="status" aria-label="Loading" data-testid="auth-checking">
        <span className="gate-spinner" aria-hidden="true" />
      </div>
    );
  if (auth === "error")
    return (
      <div className="gate" role="alert">
        <p className="t-heading" style={{ margin: 0 }}>
          Can’t reach the graph-manager server.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          Check that it is running, then try again.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => check()}>
          Retry
        </button>
      </div>
    );
  if (auth === "expired")
    return (
      <div className="gate" role="alert" data-testid="auth-expired">
        <p className="t-heading" style={{ margin: 0 }}>
          Your sign-in has expired.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  if (auth === "out")
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/signup" element={<Signup onLogin={loggedIn} />} />
          <Route path="/set-password" element={<SetPassword onLogin={loggedIn} />} />
          <Route path="*" element={<Login onLogin={loggedIn} />} />
        </Routes>
      </BrowserRouter>
    );

  return (
    <BrowserRouter>
      <OverviewProvider>
        <VisibleTerminalsProvider>
        <Shell
          onLogout={() => void logout()}
          account={me.user ? { name: me.user.name, mode: me.mode ?? "users", ...(me.logoutUrl ? { logoutUrl: me.logoutUrl } : {}) } : undefined}
        >
          <Routes>
            <Route path="/" element={<Navigate to="/runs" replace />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:ws/:runId" element={<RunDetail />} />
            <Route path="/terminals" element={<Terminals />} />
            <Route path="/workspaces" element={<Navigate to="/terminals" replace />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/reviewers" element={<Reviewers />} />
            <Route path="/settings" element={<Settings authMode={me.mode} />} />
            {plugins.routes.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
            {/* Until the plugins registered, a deep link to a plugin page waits instead of going to /runs. */}
            <Route
              path="*"
              element={
                plugins.loaded ? (
                  <Navigate to="/runs" replace />
                ) : (
                  <div className="gate" role="status" aria-label="Loading" data-testid="plugins-loading">
                    <span className="gate-spinner" aria-hidden="true" />
                  </div>
                )
              }
            />
          </Routes>
        </Shell>
        <AgentRequestHost />
        </VisibleTerminalsProvider>
      </OverviewProvider>
    </BrowserRouter>
  );
}
