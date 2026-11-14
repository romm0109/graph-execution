import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "../ui/Icon";
import { StatusGlyph } from "../ui/StatusBadge";
import "./Login.css";

type LoginError = { kind: "wrong" | "other"; text: string } | { kind: "limited"; text: string };

function limitedText(retryAfter: string | null): string {
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : undefined;
  if (seconds === undefined) return "Too many attempts. Try again later.";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many attempts. Try again in ${String(minutes)} minute${minutes === 1 ? "" : "s"}.`;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON.
  }
  return res.statusText || `HTTP ${String(res.status)}`;
}

/** The login card (boards 03/04): logo, host name from `/api/auth/info`, the admin password and Log in. */
export default function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<LoginError | null>(null);
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/info", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { host?: unknown };
        if (!cancelled && typeof body.host === "string") setHost(body.host);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // fetch directly (not api()) to read Retry-After on a 429.
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        onLogin();
        return;
      }
      if (res.status === 401) setError({ kind: "wrong", text: "Wrong password." });
      else if (res.status === 429) setError({ kind: "limited", text: limitedText(res.headers.get("retry-after")) });
      else setError({ kind: "other", text: await errorText(res) });
    } catch (err) {
      setError({ kind: "other", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const invalid = error?.kind === "wrong";

  return (
    <main className="login-page" data-testid="page-login">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <div className="login-brand">
          <Icon name="logo" size={32} />
          <div className="login-brand-text">
            <h1>graph-manager</h1>
            {host && (
              <span className="login-host" data-testid="login-host">
                {host}
              </span>
            )}
          </div>
        </div>

        <label className="field">
          Admin password
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            aria-invalid={invalid || undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error &&
          (error.kind === "limited" ? (
            <p className="login-limited" role="alert">
              {error.text}
            </p>
          ) : (
            <p className="login-error" role="alert">
              <StatusGlyph tone="bad" glyph="diamond" />
              {error.text}
            </p>
          ))}

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
      <p className="login-footer">
        One admin per deployment. The password is printed when graph-manager starts and saved in its data folder, unless{" "}
        <code>GM_PASSWORD</code> is set.
      </p>
    </main>
  );
}
