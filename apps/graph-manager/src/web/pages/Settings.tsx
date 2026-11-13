import { useState, type FormEvent } from "react";
import { api, post } from "../api";
import { useOverview } from "../overview";
import type { ForgesInfo } from "../types";
import { ConfirmDialog } from "../ui/Dialog";
import { Segmented } from "../ui/Segmented";
import { SkeletonRows } from "../ui/Skeleton";
import { useTheme, type ThemePref } from "../ui/theme";
import { useToast } from "../ui/toast";
import { SandboxCard } from "./SandboxCard";
import { TokensCard } from "./TokensCard";
import "./Settings.css";

type Kind = "github" | "gitlab";
type ForgeStatus = ForgesInfo[Kind];

const NAMES: Record<Kind, string> = { github: "GitHub", gitlab: "GitLab" };
const SCOPES: Record<Kind, string> = { github: "repo", gitlab: "api" };
const DEFAULT_GITLAB = "https://gitlab.com";
const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const disconnectBody =
  "The token is deleted from the server. Existing workspaces stay, but Create PR and cloning won't work until you reconnect.";

/** `https://api.github.com · token ends ••••a91f` (the token part only when the server gave its end). */
export function connectionLine(status: ForgeStatus): string {
  const parts = [status.apiUrl ?? ("baseUrl" in status ? status.baseUrl : undefined), status.tokenEnd ? `token ends ••••${status.tokenEnd}` : undefined];
  return parts.filter(Boolean).join(" · ");
}

function ForgeCard({ kind, status, loaded, onChange }: { kind: Kind; status: ForgeStatus; loaded: boolean; onChange: () => Promise<void> }) {
  const toast = useToast();
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const name = NAMES[kind];
  const tokenId = `${kind}-token`;
  const errorId = `${kind}-error`;

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || token.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/forges/${kind}`, kind === "gitlab" ? { token, baseUrl: baseUrl.trim() || DEFAULT_GITLAB } : { token }, "PUT");
      setToken("");
      await onChange();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api(`/api/forges/${kind}`, { method: "DELETE" });
      setConfirm(false);
      setError(null);
      await onChange();
    } catch (err) {
      setConfirm(false);
      toast.show({ tone: "bad", text: `Couldn't disconnect ${name}: ${message(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-card forge-card" aria-label={name} data-testid={`forge-${kind}`}>
      <div className="settings-card-head">
        <h2>{name}</h2>
        {!loaded ? null : status.connected ? (
          <span className="badge tone-ok" data-tone="ok" data-testid="forge-status">
            <span className="glyph glyph-dot" aria-hidden="true" />
            connected
          </span>
        ) : (
          <span className="badge tone-mute" data-tone="mute" data-testid="forge-status">
            <span className="glyph glyph-ring" aria-hidden="true" />
            not connected
          </span>
        )}
      </div>
      {!loaded ? (
        <div className="forge-loading">
          <SkeletonRows rows={2} header={false} />
        </div>
      ) : status.connected ? (
        <div className="forge-connected">
          <div className="forge-connected-text">
            <span>
              Connected as <strong className="mono">{status.login}</strong>
            </span>
            <span className="forge-meta mono" data-testid="forge-meta">
              {connectionLine(status)}
            </span>
          </div>
          <button type="button" className="btn forge-disconnect" data-testid="disconnect" disabled={busy} onClick={() => setConfirm(true)}>
            Disconnect
          </button>
        </div>
      ) : (
        <form className="forge-form" onSubmit={(e) => void connect(e)}>
          {kind === "gitlab" && (
            <label className="field">
              <span className="field-label">Base URL</span>
              <input
                className="input mono"
                data-testid="base-url-input"
                type="url"
                placeholder={DEFAULT_GITLAB}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <span className="field-hint">
                Default <code className="mono">{DEFAULT_GITLAB}</code>; change it for self-hosted GitLab.
              </span>
            </label>
          )}
          <label className="field" htmlFor={tokenId}>
            <span className="field-label">Personal access token</span>
            <input
              id={tokenId}
              className="input mono"
              data-testid="token-input"
              type="password"
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <span className="field-hint">
              Needs the <code className="mono">{SCOPES[kind]}</code> scope.
            </span>
          </label>
          {error && (
            <p id={errorId} className="field-error forge-error mono" role="alert">
              {error}
            </p>
          )}
          <div className="forge-actions">
            <button type="submit" className="btn btn-primary" data-testid="connect" disabled={busy || token.trim() === ""}>
              Connect
            </button>
          </div>
        </form>
      )}
      <ConfirmDialog
        open={confirm}
        tone="danger"
        title={`Disconnect ${name}?`}
        body={disconnectBody}
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={() => void disconnect()}
        onCancel={() => setConfirm(false)}
      />
    </section>
  );
}

export default function Settings() {
  const { forges, loaded, refresh } = useOverview();
  const { pref, setPref } = useTheme();
  return (
    <section className="page settings-page" data-testid="page-settings">
      <header className="settings-header">
        <h1>Settings</h1>
        <p className="muted">
          Forge connections let you search, clone, and open PRs or MRs. Tokens are stored on the server and never shown again after saving.
        </p>
      </header>
      <div className="settings-forges">
        <ForgeCard kind="github" status={forges.github} loaded={loaded} onChange={refresh} />
        <ForgeCard kind="gitlab" status={forges.gitlab} loaded={loaded} onChange={refresh} />
      </div>
      <SandboxCard />
      <TokensCard />
      <section className="settings-card settings-appearance" aria-label="Appearance" data-testid="appearance">
        <div className="settings-appearance-text">
          <h2>Appearance</h2>
          <span className="field-hint">Saved in this browser only.</span>
        </div>
        <Segmented options={THEMES} value={pref} onChange={setPref} ariaLabel="Theme" />
      </section>
    </section>
  );
}
