import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { ApiError, LOGOUT_EVENT, api, post } from "./api";
import Login from "./pages/Login";
import RunDetail from "./pages/RunDetail";
import Runs from "./pages/Runs";
import Settings from "./pages/Settings";
import Terminals from "./pages/Terminals";
import Workspaces from "./pages/Workspaces";

type AuthState = "checking" | "in" | "out" | "error";

const NAV = [
  { to: "/workspaces", label: "Workspaces" },
  { to: "/terminals", label: "Terminals" },
  { to: "/runs", label: "Runs" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const [auth, setAuth] = useState<AuthState>("checking");

  const check = useCallback(() => {
    api("/api/auth/me")
      .then(() => setAuth("in"))
      .catch((err: unknown) => setAuth(err instanceof ApiError && err.status === 401 ? "out" : "error"));
  }, []);

  useEffect(() => {
    check();
    const onLogout = () => setAuth("out");
    window.addEventListener(LOGOUT_EVENT, onLogout);
    return () => window.removeEventListener(LOGOUT_EVENT, onLogout);
  }, [check]);

  const logout = async () => {
    try {
      await post("/api/auth/logout");
    } finally {
      setAuth("out");
    }
  };

  if (auth === "checking") return <div className="center muted">Loading…</div>;
  if (auth === "error")
    return (
      <div className="center">
        <p className="error">Can't reach the graph-manager server.</p>
        <button onClick={check}>Retry</button>
      </div>
    );
  if (auth === "out") return <Login onLogin={() => setAuth("in")} />;

  return (
    <BrowserRouter>
      <div className="shell">
        <nav className="nav">
          <div className="brand">graph-manager</div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
              {n.label}
            </NavLink>
          ))}
          <div className="spacer" />
          <button className="secondary" onClick={() => void logout()}>
            Log out
          </button>
        </nav>
        <main className="main">
          <Routes>
            <Route path="/" element={<Navigate to="/runs" replace />} />
            <Route path="/workspaces" element={<Workspaces />} />
            <Route path="/terminals" element={<Terminals />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:ws/:runId" element={<RunDetail />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/runs" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
