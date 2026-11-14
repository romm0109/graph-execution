import { useState, type FormEvent } from "react";
import { StatusGlyph } from "../ui/StatusBadge";
import { AppLink, LoginBrand, errorText, useAuthInfo } from "./Login";
import "./Login.css";

const EXPIRED = "This link has expired or was already used. Ask for a new one.";

/** The page of a set-password link (invite or reset, from `graph-manager users add|reset`); logs in on success. */
export default function SetPassword({ onLogin }: { onLogin: () => void }) {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(token === "" ? EXPIRED : null);
  const [busy, setBusy] = useState(false);
  const { host } = useAuthInfo();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== repeat) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/set-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        onLogin();
        return;
      }
      const text = await errorText(res);
      setError(text === "link expired or used" ? EXPIRED : text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page" data-testid="page-set-password">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <LoginBrand host={host} />
        <p className="login-switch" style={{ margin: 0, textAlign: "left" }}>
          Choose a password of at least 10 characters.
        </p>
        <label className="field">
          Password
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="field">
          Repeat password
          <input className="input" type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        {error && (
          <p className="login-error" role="alert">
            <StatusGlyph tone="bad" glyph="diamond" />
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || token === ""}>
          {busy ? "Saving…" : "Set password"}
        </button>
        <p className="login-switch">
          <AppLink to="/">Log in</AppLink>
        </p>
      </form>
    </main>
  );
}
