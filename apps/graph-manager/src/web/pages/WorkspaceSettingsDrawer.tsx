import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, post } from "../api";
import type { SandboxBuild, SandboxRecipe, SandboxSettings, SandboxStatus, WorkspaceEntry, WorkspaceImageSource, WorkspaceSettings } from "../types";
import { Drawer } from "../ui/Drawer";
import { useToast } from "../ui/toast";
import { RecipeEditor } from "./RecipeEditor";
import { BUILD_POLL_MS, BuildBadge, BuildLog, isBuild } from "./SandboxImage";
import "./Settings.css";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const settingsUrl = (id: string) => `/api/workspaces/${encodeURIComponent(id)}/settings`;
const buildUrl = (id: string) => `/api/workspaces/${encodeURIComponent(id)}/sandbox/build`;
const rebuildUrl = (id: string) => `/api/workspaces/${encodeURIComponent(id)}/sandbox/rebuild`;

/** A deep copy of a recipe, so local edits never touch the global one. */
const copyRecipe = (r: SandboxRecipe): SandboxRecipe => ({
  base: r.base,
  toolchains: r.toolchains.map((t) => ({ id: t.id, enabled: t.enabled, snippet: t.snippet })),
  extraLines: r.extraLines,
});

const isSource = (s: unknown): s is WorkspaceImageSource => s === "global" || s === "recipe" || s === "image";
const isRunning = (b: SandboxBuild | undefined) => b?.state === "queued" || b?.state === "building";

const SOURCES: { value: WorkspaceImageSource; label: string }[] = [
  { value: "global", label: "Global recipe" },
  { value: "recipe", label: "Own recipe" },
  { value: "image", label: "Ready-made image" },
];

/**
 * Settings → Repositories → Edit (KAN-88, sandbox toolchains): where the repository's sandbox image comes from — the
 * global recipe, its own recipe (edited with `RecipeEditor`, built on save) or a ready-made image. Open while `workspace`
 * is set (only its `id` and `fullPath` are used).
 */
export function WorkspaceSettingsDrawer({ workspace, onClose }: { workspace?: WorkspaceEntry; onClose: () => void }) {
  const toast = useToast();
  const [source, setSource] = useState<WorkspaceImageSource>("global");
  const [savedSource, setSavedSource] = useState<WorkspaceImageSource>("global");
  const [image, setImage] = useState("");
  const [recipe, setRecipe] = useState<SandboxRecipe | null>(null);
  const [effectiveImage, setEffectiveImage] = useState("");
  const [globalSettings, setGlobalSettings] = useState<SandboxSettings | undefined>();
  const [build, setBuild] = useState<SandboxBuild | undefined>();
  const [defaultImage, setDefaultImage] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = workspace?.id;
  // The workspace the drawer shows now, so an answer for a previous one is ignored.
  const current = useRef(id);
  current.current = id;

  const apply = useCallback((s: WorkspaceSettings | undefined) => {
    const src = isSource(s?.source) ? s.source : s?.image ? "image" : "global";
    setSource(src);
    setSavedSource(src);
    setImage(s?.image ?? "");
    setRecipe(s?.recipe ? copyRecipe(s.recipe) : null);
    setEffectiveImage(s?.effectiveImage ?? "");
  }, []);

  useEffect(() => {
    if (id === undefined) return;
    let alive = true;
    setSource("global");
    setSavedSource("global");
    setImage("");
    setRecipe(null);
    setEffectiveImage("");
    setGlobalSettings(undefined);
    setBuild(undefined);
    setError(null);
    setBusy(false);
    setLoaded(false);
    api<WorkspaceSettings>(settingsUrl(id)).then(
      (s) => {
        if (!alive) return;
        apply(s);
        setLoaded(true);
      },
      (err: unknown) => {
        if (!alive) return;
        setError(`Couldn't load the settings: ${message(err)}`);
        setLoaded(true);
      },
    );
    api<SandboxSettings>("/api/settings/sandbox").then(
      (s) => alive && s && s.recipe && Array.isArray(s.toolchains) && setGlobalSettings(s),
      () => undefined,
    );
    api<SandboxStatus>("/api/sandbox/status").then(
      (s) => alive && setDefaultImage(s?.defaultImage || undefined),
      () => alive && setDefaultImage(undefined),
    );
    return () => {
      alive = false;
    };
  }, [id, apply]);

  // The first time Own recipe is chosen, start from a copy of the global recipe.
  useEffect(() => {
    if (source === "recipe" && recipe === null && globalSettings) setRecipe(copyRecipe(globalSettings.recipe));
  }, [source, recipe, globalSettings]);

  // The build of the workspace's own image: read it when the saved source is `recipe`, poll while it runs.
  const showBuild = savedSource === "recipe";
  useEffect(() => {
    if (id === undefined || !showBuild) return;
    let alive = true;
    api<SandboxBuild>(buildUrl(id)).then(
      (b) => alive && isBuild(b) && setBuild(b),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [id, showBuild]);

  const running = isRunning(build);
  useEffect(() => {
    if (id === undefined || !showBuild || !running) return;
    let alive = true;
    const timer = setInterval(() => {
      api<SandboxBuild>(buildUrl(id)).then(
        (b) => alive && isBuild(b) && setBuild(b),
        () => undefined,
      );
    }, BUILD_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, showBuild, running]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!workspace || busy) return;
    setError(null);
    let body: { source: "global" } | { source: "image"; image: string } | { source: "recipe"; recipe: SandboxRecipe };
    if (source === "image") {
      const trimmed = image.trim();
      if (trimmed === "") {
        setError("Enter an image, or choose Global recipe");
        return;
      }
      body = { source: "image", image: trimmed };
    } else if (source === "recipe") {
      if (!recipe) return;
      body = { source: "recipe", recipe };
    } else {
      body = { source: "global" };
    }
    const wsId = workspace.id;
    setBusy(true);
    try {
      const res = await post<WorkspaceSettings>(settingsUrl(wsId), body, "PUT");
      if (current.current !== wsId) return;
      const queued = isRunning(res?.build);
      toast.show({
        tone: "ok",
        text: queued ? "Saved; building the repository's sandbox image" : "Saved the repository settings",
      });
      if (res) apply(res);
      if (res?.build && isBuild(res.build)) setBuild(res.build);
      if (body.source === "recipe" && queued) return;
      onClose();
    } catch (err) {
      if (current.current === wsId) setError(message(err));
    } finally {
      if (current.current === wsId) setBusy(false);
    }
  };

  const rebuild = async () => {
    if (!workspace || busy || running) return;
    const wsId = workspace.id;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ build?: SandboxBuild }>(rebuildUrl(wsId));
      if (current.current !== wsId) return;
      setBuild(isBuild(res?.build) ? res.build : { state: "queued", log: [] });
    } catch (err) {
      if (current.current === wsId) setError(message(err));
    } finally {
      if (current.current === wsId) setBusy(false);
    }
  };

  const choose = (value: WorkspaceImageSource) => {
    setSource(value);
    setError(null);
  };

  return (
    <Drawer
      open={workspace !== undefined}
      title={
        <span className="ws-settings-title">
          Repository settings
          <span className="mono ws-settings-path field-hint">{workspace?.fullPath}</span>
        </span>
      }
      onClose={onClose}
      testId="workspace-settings-drawer"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="workspace-settings-save"
            disabled={!loaded || busy || (source === "recipe" && recipe === null)}
            onClick={() => void save()}
          >
            Save
          </button>
        </>
      }
    >
      <form className="ws-settings-form" onSubmit={(e) => void save(e)}>
        <fieldset className="ws-image-source" data-testid="workspace-image-source" disabled={!loaded}>
          <legend className="field-label">Sandbox image</legend>
          {SOURCES.map((s) => (
            <label key={s.value} className="ws-image-source-choice">
              <input
                type="radio"
                name="image-source"
                value={s.value}
                checked={source === s.value}
                onChange={() => choose(s.value)}
                data-testid={`workspace-source-${s.value}`}
              />{" "}
              {s.label}
            </label>
          ))}
        </fieldset>

        {source === "global" && (
          <p className="field-hint ws-global-image" data-testid="workspace-global-image">
            Uses the image built in Settings → Sandbox:{" "}
            <code className="mono">{savedSource === "global" ? effectiveImage : (globalSettings?.image ?? "")}</code>
          </p>
        )}

        {source === "recipe" && (
          <div className="ws-recipe">
            {recipe ? (
              <RecipeEditor
                recipe={recipe}
                toolchains={globalSettings?.toolchains ?? []}
                onChange={setRecipe}
                disabled={!loaded || busy}
              />
            ) : (
              <p className="field-hint">Loading the global recipe…</p>
            )}
            <div className="sandbox-recipe-actions">
              <button
                type="button"
                className="btn"
                data-testid="workspace-copy-global"
                disabled={!globalSettings || busy}
                onClick={() => globalSettings && setRecipe(copyRecipe(globalSettings.recipe))}
              >
                Copy global again
              </button>
              {showBuild && (
                <button type="button" className="btn" data-testid="workspace-rebuild" disabled={busy || running} onClick={() => void rebuild()}>
                  Rebuild
                </button>
              )}
            </div>
            {showBuild && build && (
              <div className="ws-build">
                <div className="sandbox-recipe-head">
                  <span className="field-label">Image build</span>
                  <BuildBadge build={build} testId="workspace-build-state" />
                </div>
                {build.state === "failed" && build.error && (
                  <p className="field-error mono" data-testid="workspace-build-error">
                    {build.error}
                  </p>
                )}
                {build.log.length > 0 && <BuildLog log={build.log} testId="workspace-build-log" />}
              </div>
            )}
          </div>
        )}

        {source === "image" && (
          <label className="field">
            <span className="field-label">Image</span>
            <input
              className="input mono"
              data-testid="workspace-image"
              autoComplete="off"
              spellCheck={false}
              placeholder={defaultImage ?? "node:24-bookworm"}
              disabled={!loaded}
              aria-invalid={error ? true : undefined}
              value={image}
              onChange={(e) => setImage(e.target.value)}
            />
            <span className="field-hint">Needs node 20+, git and glibc (not Alpine). Used instead of any recipe.</span>
          </label>
        )}

        {error && (
          <p className="field-error mono" role="alert" data-testid="workspace-settings-error">
            {error}
          </p>
        )}
      </form>
    </Drawer>
  );
}
