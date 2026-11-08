import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api, post } from "../api";
import type { SandboxBuild, SandboxRecipe, SandboxSettings } from "../types";
import { useToast } from "../ui/toast";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** How often the build state is re-read while a build runs. */
export const BUILD_POLL_MS = 2000;

type Fields = { base: string; packages: string; extraLines: string };

const toFields = (r: SandboxRecipe): Fields => ({ base: r.base, packages: r.packages.join("\n"), extraLines: r.extraLines });

/** The packages textarea as a list: split on whitespace and newlines, empties dropped. */
const parsePackages = (text: string) => text.split(/\s+/).filter((p) => p !== "");

const sameRecipe = (a: SandboxRecipe, b: SandboxRecipe) =>
  a.base === b.base && a.extraLines === b.extraLines && a.packages.length === b.packages.length && a.packages.every((p, i) => p === b.packages[i]);

const isSettings = (s: unknown): s is SandboxSettings =>
  !!s && typeof s === "object" && !!(s as SandboxSettings).recipe && Array.isArray((s as SandboxSettings).recipe.packages);

const isBuild = (b: unknown): b is SandboxBuild =>
  !!b && typeof b === "object" && typeof (b as SandboxBuild).state === "string" && Array.isArray((b as SandboxBuild).log);

function BuildBadge({ build }: { build: SandboxBuild }) {
  if (build.state === "idle") return null;
  if (build.state === "building") {
    return (
      <span className="badge tone-warn" data-tone="warn" data-testid="sandbox-build-state">
        <span className="glyph glyph-ring" aria-hidden="true" />
        {build.step === "clis" ? "building (CLIs)" : "building (image)"}
      </span>
    );
  }
  if (build.state === "ready") {
    return (
      <span className="badge tone-ok" data-tone="ok" data-testid="sandbox-build-state">
        <span className="glyph glyph-dot" aria-hidden="true" />
        ready
      </span>
    );
  }
  return (
    <span className="badge tone-bad" data-tone="bad" data-testid="sandbox-build-state">
      <span className="glyph glyph-ring" aria-hidden="true" />
      failed
    </span>
  );
}

/**
 * Settings → Sandbox → Image: the recipe of the sandbox image graph-manager builds (base, apt packages,
 * extra Dockerfile lines), its Dockerfile, Save and rebuild / Reset to defaults / Rebuild, and the build
 * state with its log (polled every 2 s while building). `onBuilt` runs when the build state changes, so
 * the card can refresh the sandbox status.
 */
export function SandboxImage({ onBuilt }: { onBuilt?: () => void }) {
  const toast = useToast();
  const [settings, setSettings] = useState<SandboxSettings | undefined>();
  const [fields, setFields] = useState<Fields>({ base: "", packages: "", extraLines: "" });
  const [build, setBuild] = useState<SandboxBuild | undefined>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const refreshBuild = useCallback(async () => {
    try {
      const b = await api<SandboxBuild>("/api/sandbox/build");
      if (alive.current && isBuild(b)) setBuild(b);
    } catch {
      // Keep the last known state; the next poll or action retries.
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    api<SandboxSettings>("/api/settings/sandbox").then(
      (res) => {
        if (!alive.current) return;
        if (!isSettings(res)) {
          setLoadError("Couldn't load the sandbox image recipe.");
          return;
        }
        setSettings(res);
        setFields(toFields(res.recipe));
      },
      (err: unknown) => alive.current && setLoadError(`Couldn't load the sandbox image recipe: ${message(err)}`),
    );
    void refreshBuild();
    return () => {
      alive.current = false;
    };
  }, [refreshBuild]);

  const building = build?.state === "building";

  // Poll while building; the timer is cleared when the state changes and on unmount.
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void refreshBuild(), BUILD_POLL_MS);
    return () => clearInterval(timer);
  }, [building, refreshBuild]);

  // Tell the card when the build state changes (e.g. it left `building`), so it re-reads the status.
  const lastState = useRef<SandboxBuild["state"] | undefined>(undefined);
  const onBuiltRef = useRef(onBuilt);
  onBuiltRef.current = onBuilt;
  useEffect(() => {
    const state = build?.state;
    if (state === undefined) return;
    const prev = lastState.current;
    lastState.current = state;
    if (prev !== undefined && prev !== state) onBuiltRef.current?.();
  }, [build?.state]);

  // Auto-scroll the log to the bottom when new lines arrive, if the user was at the bottom.
  const logRef = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  const logLength = build?.log.length ?? 0;
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [logLength]);
  const onLogScroll = () => {
    const el = logRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };

  const edited: SandboxRecipe = { base: fields.base, packages: parsePackages(fields.packages), extraLines: fields.extraLines };
  const changed = settings !== undefined && !sameRecipe(edited, settings.recipe);
  const isDefault = settings === undefined || sameRecipe(settings.recipe, settings.defaultRecipe);

  const putRecipe = async (recipe: SandboxRecipe | null, done: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<SandboxSettings>("/api/settings/sandbox", { recipe }, "PUT");
      if (!alive.current) return;
      if (isSettings(res)) {
        setSettings(res);
        setFields(toFields(res.recipe));
      }
      toast.show({ tone: "ok", text: done });
      await refreshBuild();
    } catch (err) {
      if (alive.current) setError(message(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!changed || building) return;
    void putRecipe(edited, "Saved the sandbox image recipe");
  };

  const reset = () => void putRecipe(null, "Reset the sandbox image recipe to the defaults");

  const rebuild = async () => {
    if (busy || building) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ build?: SandboxBuild }>("/api/sandbox/rebuild");
      if (!alive.current) return;
      setBuild(isBuild(res?.build) ? res.build : { state: "building", log: [] });
      await refreshBuild();
    } catch (err) {
      if (alive.current) setError(message(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const disabled = settings === undefined || busy;

  return (
    <form className="forge-form sandbox-recipe" aria-label="Sandbox image" onSubmit={save}>
      <div className="sandbox-recipe-head">
        <h3>Image</h3>
        {build && <BuildBadge build={build} />}
      </div>
      <label className="field">
        <span className="field-label">Base image</span>
        <input
          className="input mono"
          autoComplete="off"
          spellCheck={false}
          data-testid="sandbox-base"
          disabled={disabled}
          value={fields.base}
          onChange={(e) => setFields((f) => ({ ...f, base: e.target.value }))}
        />
      </label>
      <label className="field">
        <span className="field-label">Packages</span>
        <textarea
          className="textarea mono sandbox-packages"
          spellCheck={false}
          data-testid="sandbox-packages"
          disabled={disabled}
          value={fields.packages}
          onChange={(e) => setFields((f) => ({ ...f, packages: e.target.value }))}
        />
        <span className="field-hint">apt packages from Debian, one per line</span>
      </label>
      <label className="field">
        <span className="field-label">Extra Dockerfile lines</span>
        <textarea
          className="textarea mono sandbox-extra"
          spellCheck={false}
          data-testid="sandbox-extra"
          disabled={disabled}
          value={fields.extraLines}
          onChange={(e) => setFields((f) => ({ ...f, extraLines: e.target.value }))}
        />
        <span className="field-hint">
          Runs after the packages. Use <code className="mono">COPY --from=&lt;image&gt; &lt;dir&gt; &lt;dir&gt;</code> to add a tool from another
          image. FROM is not allowed.
        </span>
      </label>
      {settings && (
        <details className="sandbox-dockerfile">
          <summary>Dockerfile</summary>
          <pre className="mono" data-testid="sandbox-dockerfile">
            {settings.dockerfile}
          </pre>
        </details>
      )}
      {loadError && (
        <p className="field-error forge-error mono" data-testid="sandbox-recipe-load-error">
          {loadError}
        </p>
      )}
      {error && (
        <p className="field-error forge-error mono" role="alert" data-testid="sandbox-recipe-error">
          {error}
        </p>
      )}
      <div className="sandbox-recipe-actions">
        <button type="button" className="btn" data-testid="sandbox-reset-recipe" disabled={disabled || building || isDefault} onClick={reset}>
          Reset to defaults
        </button>
        <button
          type="button"
          className="btn"
          data-testid="sandbox-rebuild"
          title="Rebuilds the image and the provider CLIs without the cache"
          disabled={busy || building}
          onClick={() => void rebuild()}
        >
          Rebuild
        </button>
        <button type="submit" className="btn btn-primary" data-testid="sandbox-save-recipe" disabled={disabled || building || !changed}>
          Save and rebuild
        </button>
      </div>
      {build?.state === "failed" && build.error && (
        <p className="field-error forge-error mono" data-testid="sandbox-build-error">
          {build.error}
        </p>
      )}
      {build && build.log.length > 0 && (
        <pre className="sandbox-build-log mono" ref={logRef} onScroll={onLogScroll} data-testid="sandbox-build-log">
          {build.log.join("\n")}
        </pre>
      )}
    </form>
  );
}
