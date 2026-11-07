import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ApiError, LOGOUT_EVENT, api, post } from "./api";
import { OverviewProvider } from "./overview";
import { Shell } from "./Shell";
import Login from "./pages/Login";
import RunDetail from "./pages/RunDetail";
import Runs from "./pages/Runs";
import Reviewers from "./pages/Reviewers";
import Settings from "./pages/Settings";
import Terminals from "./pages/Terminals";
import Workspaces from "./pages/Workspaces";
import "./Shell.css";

type AuthState = "checking" | "in" | "out" | "error";

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

  const logout = useCallback(async () => {
    try {
      await post("/api/auth/logout");
    } finally {
      setAuth("out");
    }
  }, []);

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
  if (auth === "out") return <Login onLogin={() => setAuth("in")} />;

  return (
    <BrowserRouter>
      <OverviewProvider>
        <Shell onLogout={() => void logout()}>
          <Routes>
            <Route path="/" element={<Navigate to="/runs" replace />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:ws/:runId" element={<RunDetail />} />
            <Route path="/terminals" element={<Terminals />} />
            <Route path="/workspaces" element={<Workspaces />} />
            <Route path="/reviewers" element={<Reviewers />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/runs" replace />} />
          </Routes>
        </Shell>
      </OverviewProvider>
    </BrowserRouter>
  );
}
