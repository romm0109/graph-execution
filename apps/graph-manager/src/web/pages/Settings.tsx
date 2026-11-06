import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, post } from "../api";

type Kind = "github" | "gitlab";

interface ForgeStatus {
  connected: boolean;
  login?: string;
  baseUrl?: string;
}

type Forges = Record<Kind, ForgeStatus>;

const NAMES: Record<Kind, string> = { github: "GitHub", gitlab: "GitLab" };
const DEFAULT_GITLAB = "https://gitlab.com";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ForgeCard({ kind, status, onChange }: { kind: Kind; status: ForgeStatus | undefined; onChange: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_GITLAB);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setToken("");
      await onChange();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const connect = (e: FormEvent) => {
    e.preventDefault();
    void run(() => post(`/api/forges/${kind}`, kind === "gitlab" ? { token, baseUrl } : { token }, "PUT"));
  };
  const disconnect = () => void run(() => api(`/api/forges/${kind}`, { method: "DELETE" }));

  return (
    <div className="card forge-card" data-testid={`forge-${kind}`}>
      <h2>{NAMES[kind]}</h2>
      {status === undefined ? (
        <p className="muted">Loading…</p>
      ) : status.connected ? (
        <>
          <p>
            Connected as <strong>{status.login}</strong>
            {status.baseUrl && <span className="muted"> on {status.baseUrl}</span>}
          </p>
          <button type="button" data-testid="disconnect" disabled={busy} onClick={disconnect}>
            Disconnect
          </button>
        </>
      ) : (
        <form className="forge-form" onSubmit={connect}>
          <label htmlFor={`${kind}-token`}>Personal access token</label>
          <input
            id={`${kind}-token`}
            data-testid="token-input"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {kind === "gitlab" && (
            <>
              <label htmlFor="gitlab-base-url">Base URL</label>
              <input id="gitlab-base-url" data-testid="base-url-input" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </>
          )}
          <button type="submit" data-testid="connect" disabled={busy || token.trim() === ""}>
            Connect
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default function Settings() {
  const [forges, setForges] = useState<Forges | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setForges(await api<Forges>("/api/forges"));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section data-testid="page-settings">
      <h1>Settings</h1>
      <p className="muted">Connect GitHub and GitLab with personal access tokens. Tokens are stored on the server and never shown again.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="forge-cards">
        <ForgeCard kind="github" status={forges?.github} onChange={load} />
        <ForgeCard kind="gitlab" status={forges?.gitlab} onChange={load} />
      </div>
    </section>
  );
}
