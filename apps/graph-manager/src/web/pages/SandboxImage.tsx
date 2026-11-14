import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api, post } from "../api";
import type { SandboxBuild, SandboxRecipe, SandboxSettings } from "../types";
import { useToast } from "../ui/toast";
import { RecipeEditor } from "./RecipeEditor";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** How often the build state is re-read while a build runs. */
export const BUILD_POLL_MS = 2000;

/** A deep copy of a recipe, with only the known fields, so it can be compared with JSON.stringify. */
const normalize = (r: SandboxRecipe): SandboxRecipe => ({
  base: r.base,
  toolchains: r.toolchains.map((t) => ({ id: t.id, enabled: t.enabled, snippet: t.snippet })),
  extraLines: r.extraLines,
});

const sameRecipe = (a: SandboxRecipe, b: SandboxRecipe) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

const isSettings = (s: unknown): s is SandboxSettings =>
  !!s && typeof s === "object" && !!(s as SandboxSettings).recipe &&
  Array.isArray((s as SandboxSettings).recipe.toolchains) &&
  Array.isArray((s as SandboxSettings).toolchains);

export const isBuild = (b: unknown): b is SandboxBuild =>
  !!b && typeof b === "object" && typeof (b as SandboxBuild).state === "string" && Array.isArray((b as SandboxBuild).log);

/** The build state as a badge (nothing while idle). Shared by Settings → Sandbox and the workspace settings drawer. */
export function BuildBadge({ build, testId = "sandbox-build-state" }: { build: SandboxBuild; testId?: string }) {
  if (build.state === "idle") return null;
  if (build.state === "queued") {
    return (
      <span className="badge tone-warn" data-tone="warn" data-testid={testId}>
        <span className="glyph glyph-ring" aria-hidden="true" />
        queued
      </span>
    );
  }
  if (build.state === "building") {
    return (
      <span className="badge tone-warn" data-tone="warn" data-testid={testId}>
        <span className="glyph glyph-ring" aria-hidden="true" />
        {build.step === "clis" ? "building (CLIs)" : "building (image)"}
      </span>
    );
  }
  if (build.state === "ready") {
    return (
      <span className="badge tone-ok" data-tone="ok" data-testid={testId}>
        <span className="glyph glyph-dot" aria-hidden="true" />
        ready
      </span>
    );
  }
  return (
    <span className="badge tone-bad" data-tone="bad" data-testid={testId}>
      <span className="glyph glyph-ring" aria-hidden="true" />
      failed
    </span>
  );
}

/** A build log that scrolls to the bottom when new lines arrive, if the user was at the bottom. */
export function BuildLog({ log, testId }: { log: string[]; testId: string }) {
  const logRef = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [log.length]);
  const onScroll = () => {
    const el = logRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };
  return (
    <pre className="sandbox-build-log mono" ref={logRef} onScroll={onScroll} data-testid={testId}>
      {log.join("\n")}
    </pre>
  );
}

/**
 * Settings → Sandbox → Image: the recipe of the sandbox image graph-manager builds (base, toolchains,
 * extra Dockerfile lines) in a `RecipeEditor` with its live Dockerfile preview, Save and rebuild / Reset to defaults / Rebuild, and the build
 * state with its log (polled every 2 s while queued or building). `onBuilt` runs when the build state changes, so
 * the card can refresh the sandbox status.
 */
export function SandboxImage({ onBuilt }: { onBuilt?: () => void }) {
  const toast = useToast();
  const [settings, setSettings] = useState<SandboxSettings | undefined>();
  const [edited, setEdited] = useState<SandboxRecipe>({ base: "", toolchains: [], extraLines: "" });
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
        setEdited(normalize(res.recipe));
      },
      (err: unknown) => alive.current && setLoadError(`Couldn't load the sandbox image recipe: ${message(err)}`),
    );
    void refreshBuild();
    return () => {
      alive.current = false;
    };
  }, [refreshBuild]);

  const building = build?.state === "building" || build?.state === "queued";

  // Poll while queued or building; the timer is cleared when the state changes and on unmount.
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
        setEdited(normalize(res.recipe));
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
      {settings && (
        <>
          <RecipeEditor recipe={edited} toolchains={settings.toolchains} onChange={setEdited} disabled={disabled || building} />
          <p className="sandbox-saved-image" data-testid="sandbox-saved-image">
            Saved image: <code className="mono">{settings.image}</code>
          </p>
        </>
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
      {build && build.log.length > 0 && <BuildLog log={build.log} testId="sandbox-build-log" />}
    </form>
  );
}
