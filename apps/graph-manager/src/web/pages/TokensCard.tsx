import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, post } from "../api";
import { relativeTime } from "../runs";
import { API_SCOPES, type ApiToken } from "../types";
import { ConfirmDialog } from "../ui/Dialog";
import { useToast } from "../ui/toast";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Scope = (typeof API_SCOPES)[number];

/**
 * Settings → API tokens (docs/prd/automation-api.md): the admin's bearer tokens for /api/v1. A new token is shown once
 * (with Copy) and only kept in state until Done; the server keeps only its hash.
 */
export function TokensCard() {
  const toast = useToast();
  // undefined: loading.
  const [tokens, setTokens] = useState<ApiToken[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<Scope>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<ApiToken | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api<{ tokens: ApiToken[] }>("/api/tokens");
      if (!mounted.current) return;
      if (!res || !Array.isArray(res.tokens)) {
        setLoadError("Couldn't load the API tokens: unexpected answer");
        return;
      }
      setTokens(res.tokens);
      setLoadError(null);
    } catch (err) {
      if (mounted.current) setLoadError(`Couldn't load the API tokens: ${message(err)}`);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const toggle = (scope: Scope) =>
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });

  const canCreate = !busy && name.trim() !== "" && scopes.size > 0;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ token: string }>("/api/tokens", { name: name.trim(), scopes: API_SCOPES.filter((s) => scopes.has(s)) });
      if (!mounted.current) return;
      setCreated(res.token);
      setName("");
      setScopes(new Set());
      void load();
    } catch (err) {
      if (mounted.current) setError(message(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(created);
      toast.show({ tone: "ok", text: "Copied" });
    } catch {
      valueRef.current?.select();
      toast.show({ tone: "bad", text: "Copy it by hand" });
    }
  };

  const confirmRevoke = async () => {
    if (!revoke) return;
    setBusy(true);
    try {
      await api(`/api/tokens/${encodeURIComponent(revoke.id)}`, { method: "DELETE" });
      setRevoke(null);
      await load();
    } catch (err) {
      setRevoke(null);
      toast.show({ tone: "bad", text: `Couldn't revoke ${revoke.name}: ${message(err)}` });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section className="settings-card tokens-card" aria-label="API tokens" data-testid="api-tokens">
      <div className="settings-card-head">
        <h2>API tokens</h2>
      </div>
      <div className="tokens-body">
        <p className="field-hint tokens-hint">
          Bearer tokens for the automation API under <code className="mono">/api/v1</code>.
        </p>
        {loadError ? (
          <p className="field-error forge-error mono" data-testid="tokens-load-error">
            {loadError}
          </p>
        ) : tokens === undefined ? null : tokens.length === 0 ? (
          <p className="muted tokens-empty" data-testid="tokens-empty">
            No tokens yet.
          </p>
        ) : (
          <div className="tokens-table-wrap">
            <table className="tokens-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Scopes</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} data-testid={`token-row-${t.id}`}>
                    <td className="tokens-name">{t.name}</td>
                    <td className="mono tokens-scopes">{t.scopes.join(", ")}</td>
                    <td title={t.createdAt}>{relativeTime(t.createdAt)}</td>
                    <td title={t.lastUsedAt}>{t.lastUsedAt ? relativeTime(t.lastUsedAt) : "never"}</td>
                    <td className="tokens-actions">
                      <button type="button" className="btn tokens-revoke" data-testid="token-revoke" disabled={busy} onClick={() => setRevoke(t)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {created !== null && (
          <div className="tokens-created" data-testid="token-created">
            <div className="tokens-created-row">
              <input
                ref={valueRef}
                className="input mono"
                data-testid="token-value"
                aria-label="New API token"
                readOnly
                value={created}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" className="btn btn-primary" data-testid="token-copy" onClick={() => void copy()}>
                Copy
              </button>
            </div>
            <div className="tokens-created-row">
              <span className="field-hint">Copy it now. You won&apos;t see it again.</span>
              <button type="button" className="btn" data-testid="token-done" onClick={() => setCreated(null)}>
                Done
              </button>
            </div>
          </div>
        )}
        <form className="forge-form tokens-form" onSubmit={(e) => void create(e)}>
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input"
              data-testid="token-name"
              maxLength={100}
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className="tokens-scopes-field">
            <legend className="field-label">Scopes</legend>
            <div className="tokens-scope-list">
              {API_SCOPES.map((s) => (
                <label key={s} className="tokens-scope">
                  <input type="checkbox" data-testid={`token-scope-${s}`} checked={scopes.has(s)} onChange={() => toggle(s)} />
                  <span className="mono">{s}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {error && (
            <p className="field-error forge-error mono" role="alert" data-testid="token-error">
              {error}
            </p>
          )}
          <div className="forge-actions">
            <button type="submit" className="btn btn-primary" data-testid="token-create" disabled={!canCreate}>
              Create token
            </button>
          </div>
        </form>
      </div>
      <ConfirmDialog
        open={revoke !== null}
        tone="danger"
        title={`Revoke ${revoke?.name ?? ""}?`}
        body="Clients using this token get 401 at once. This can't be undone."
        confirmLabel="Revoke"
        busy={busy}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setRevoke(null)}
      />
    </section>
  );
}
