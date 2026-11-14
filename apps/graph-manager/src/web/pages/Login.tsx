import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { Icon } from "../ui/Icon";
import { StatusGlyph } from "../ui/StatusBadge";
import { navigateTo } from "../ui/toast";
import "./Login.css";

/** Where the login page remembers the last username (this browser only). */
export const LAST_USERNAME_KEY = "gm.lastUsername";

function readLastUsername(): string {
  try {
    return window.localStorage.getItem(LAST_USERNAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastUsername(username: string): void {
  try {
    window.localStorage.setItem(LAST_USERNAME_KEY, username);
  } catch {
    // Storage blocked: nothing to remember.
  }
}

/** An in-app link that works with or without a Router around it (the logged-out pages). */
export function AppLink({ to, children, testId }: { to: string; children: string; testId?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigateTo(to);
  };
  return (
    <a href={to} onClick={onClick} data-testid={testId}>
      {children}
    </a>
  );
}

/** The brand row of the logged-out cards: logo, name and the host from `/api/auth/info`. */
export function LoginBrand({ host }: { host: string | null }) {
  return (
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
  );
}

export interface AuthInfo {
  host: string | null;
  signup: boolean;
}

/** `/api/auth/info`: the host name and whether sign-up is open; `{ host: null, signup: false }` until it answers. */
export function useAuthInfo(): AuthInfo {
  const [info, setInfo] = useState<AuthInfo>({ host: null, signup: false });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/info", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { host?: unknown; signup?: unknown };
        if (!cancelled) setInfo({ host: typeof body.host === "string" ? body.host : null, signup: body.signup === true });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}

type LoginError = { kind: "wrong" | "other"; text: string } | { kind: "limited"; text: string };

function limitedText(retryAfter: string | null): string {
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : undefined;
  if (seconds === undefined) return "Too many attempts. Try again later.";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many attempts. Try again in ${String(minutes)} minute${minutes === 1 ? "" : "s"}.`;
}

export async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON.
  }
  return res.statusText || `HTTP ${String(res.status)}`;
}

/** The login card (boards 03/04): logo, host name from `/api/auth/info`, username, password and Log in. */
export default function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState(readLastUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<LoginError | null>(null);
  const [busy, setBusy] = useState(false);
  const { host, signup } = useAuthInfo();

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
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        saveLastUsername(username.trim());
        onLogin();
        return;
      }
      if (res.status === 401) setError({ kind: "wrong", text: "Wrong username or password." });
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
        <LoginBrand host={host} />

        <label className="field">
          Username
          <input
            className="input"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus={username === ""}
            value={username}
            aria-invalid={invalid || undefined}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="field">
          Password
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus={username !== ""}
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
        {signup && (
          <p className="login-switch">
            New here? <AppLink to="/signup" testId="login-signup">Create account</AppLink>
          </p>
        )}
      </form>
      {!signup && (
        <p className="login-footer">
          Accounts are added on the server with <code>graph-execution manager users add</code>.
        </p>
      )}
    </main>
  );
}
