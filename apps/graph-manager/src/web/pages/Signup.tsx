import { useState, type FormEvent } from "react";
import { StatusGlyph } from "../ui/StatusBadge";
import { AppLink, LoginBrand, errorText, useAuthInfo } from "./Login";
import "./Login.css";

/** Open sign-up (`GM_SIGNUP=open`): username, display name and password; logs in on success. */
export default function Signup({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ username, displayName, password }),
      });
      if (res.ok) {
        try {
          window.localStorage.setItem("gm.lastUsername", username.trim().toLowerCase());
        } catch {
          // Storage blocked.
        }
        onLogin();
        return;
      }
      setError(await errorText(res));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page" data-testid="page-signup">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <LoginBrand host={host} />
        <label className="field">
          Username
          <input
            className="input"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          Display name
          <input className="input" type="text" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="field">
          Password
          <input className="input" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
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
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
        <p className="login-switch">
          Have an account? <AppLink to="/">Log in</AppLink>
        </p>
      </form>
      <p className="login-footer">At least 10 characters for the password. Usernames use a–z, 0–9, _ and -.</p>
    </main>
  );
}
