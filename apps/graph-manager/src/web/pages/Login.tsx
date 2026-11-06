import { useState, type FormEvent } from "react";
import { ApiError, post } from "../api";

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/login", { password });
      onLogin();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Wrong password." : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center" data-testid="page-login">
      <form className="card login" onSubmit={(e) => void submit(e)}>
        <h1>graph-manager</h1>
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" disabled={busy}>
          Log in
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
