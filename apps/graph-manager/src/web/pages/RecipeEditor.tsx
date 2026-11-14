import { useEffect, useId, useRef, useState } from "react";
import { post } from "../api";
import type { DockerfilePreview, RecipeToolchain, SandboxRecipe, ToolchainId, ToolchainInfo } from "../types";

/** How long after the last change of the recipe the Dockerfile preview is re-read. */
export const PREVIEW_DEBOUNCE_MS = 300;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type MoveDir = "up" | "down";

/**
 * The sandbox image recipe as a form: base image, the 7 toolchains (checkbox, editable snippet, reset,
 * move up/down), extra Dockerfile lines and a live Dockerfile preview (`POST /api/sandbox/dockerfile`).
 * Controlled: it never saves; every edit calls `onChange` with a new recipe.
 */
export function RecipeEditor({
  recipe,
  toolchains,
  onChange,
  disabled = false,
}: {
  recipe: SandboxRecipe;
  toolchains: ToolchainInfo[];
  onChange: (r: SandboxRecipe) => void;
  disabled?: boolean;
}) {
  const p = useId();
  const [open, setOpen] = useState<Partial<Record<ToolchainId, boolean>>>({});
  const [preview, setPreview] = useState<DockerfilePreview | undefined>();
  const [previewError, setPreviewError] = useState<string | null>(null);

  const info = (id: ToolchainId) => toolchains.find((t) => t.id === id);
  const defaultSnippet = (id: ToolchainId) => info(id)?.snippet ?? "";

  const updateToolchain = (id: ToolchainId, patch: Partial<RecipeToolchain>) =>
    onChange({ ...recipe, toolchains: recipe.toolchains.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  // Move up / down, keeping focus on the moved row's same button once the new order is rendered.
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const pendingFocus = useRef<{ id: ToolchainId; dir: MoveDir } | null>(null);
  const move = (index: number, dir: MoveDir) => {
    const other = dir === "up" ? index - 1 : index + 1;
    if (other < 0 || other >= recipe.toolchains.length) return;
    const next = [...recipe.toolchains];
    const moved = next[index] as RecipeToolchain;
    next[index] = next[other] as RecipeToolchain;
    next[other] = moved;
    pendingFocus.current = { id: moved.id, dir };
    onChange({ ...recipe, toolchains: next });
  };
  const order = recipe.toolchains.map((t) => t.id).join(",");
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const same = buttons.current.get(`${target.id}-${target.dir}`);
    // At the end of the list the same button is disabled; fall back to the other direction.
    const fallback = buttons.current.get(`${target.id}-${target.dir === "up" ? "down" : "up"}`);
    (same && !same.disabled ? same : fallback)?.focus();
  }, [order]);

  // The Dockerfile preview: once on mount, then PREVIEW_DEBOUNCE_MS after the last change. Stale answers are ignored.
  const key = JSON.stringify(recipe);
  const recipeRef = useRef(recipe);
  recipeRef.current = recipe;
  const requestId = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const run = () => {
      const id = ++requestId.current;
      post<DockerfilePreview>("/api/sandbox/dockerfile", { recipe: recipeRef.current }).then(
        (res) => {
          if (!alive.current || id !== requestId.current) return;
          setPreview(res);
          setPreviewError(null);
        },
        (err: unknown) => {
          if (!alive.current || id !== requestId.current) return;
          setPreviewError(`Couldn't preview the Dockerfile: ${message(err)}`);
        },
      );
    };
    // The first request goes out at once; later ones wait for the edits to settle.
    if (requestId.current === 0) {
      run();
      return;
    }
    const timer = setTimeout(run, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  const errorText = previewError ?? preview?.error;
  const last = recipe.toolchains.length - 1;

  return (
    <div className="recipe-editor">
      <label className="field">
        <span className="field-label">Base image</span>
        <input
          className="input mono"
          autoComplete="off"
          spellCheck={false}
          data-testid="recipe-base"
          disabled={disabled}
          value={recipe.base}
          onChange={(e) => onChange({ ...recipe, base: e.target.value })}
        />
        <span className="field-hint">A Node image (node 20+, git, glibc). The toolchains are added on top.</span>
      </label>
      <div className="field">
        <span className="field-label">Toolchains</span>
        <ul className="recipe-toolchains" data-testid="recipe-toolchains">
          {recipe.toolchains.map((t, i) => {
            const name = info(t.id)?.name ?? t.id;
            const def = defaultSnippet(t.id);
            const edited = t.snippet !== def;
            const expanded = !!open[t.id];
            const snippetId = `${p}-toolchain-${t.id}-snippet`;
            return (
              <li key={t.id} className="recipe-toolchain" data-testid={`toolchain-${t.id}`}>
                <label className="recipe-toolchain-name">
                  <input
                    type="checkbox"
                    data-testid={`toolchain-${t.id}-enabled`}
                    disabled={disabled}
                    checked={t.enabled}
                    onChange={(e) => updateToolchain(t.id, { enabled: e.target.checked })}
                  />
                  <span>{name}</span>
                </label>
                {edited && (
                  <span className="badge tone-warn" data-tone="warn" data-testid={`toolchain-${t.id}-edited`}>
                    edited
                  </span>
                )}
                <span className="recipe-toolchain-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-testid={`toolchain-${t.id}-edit`}
                    aria-expanded={expanded}
                    aria-controls={snippetId}
                    aria-label={`Edit the ${name} snippet`}
                    disabled={disabled}
                    onClick={() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-testid={`toolchain-${t.id}-reset`}
                    aria-label={`Reset the ${name} snippet to default`}
                    disabled={disabled || !edited}
                    onClick={() => updateToolchain(t.id, { snippet: def })}
                  >
                    Reset to default
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-testid={`toolchain-${t.id}-up`}
                    aria-label={`Move ${name} up`}
                    ref={(el) => {
                      buttons.current.set(`${t.id}-up`, el);
                    }}
                    disabled={disabled || i === 0}
                    onClick={() => move(i, "up")}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-testid={`toolchain-${t.id}-down`}
                    aria-label={`Move ${name} down`}
                    ref={(el) => {
                      buttons.current.set(`${t.id}-down`, el);
                    }}
                    disabled={disabled || i === last}
                    onClick={() => move(i, "down")}
                  >
                    ↓
                  </button>
                </span>
                {expanded && (
                  <textarea
                    id={snippetId}
                    className="textarea mono recipe-toolchain-snippet"
                    spellCheck={false}
                    aria-label={`${name} snippet`}
                    data-testid={`toolchain-${t.id}-snippet`}
                    disabled={disabled}
                    value={t.snippet}
                    onChange={(e) => updateToolchain(t.id, { snippet: e.target.value })}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <label className="field">
        <span className="field-label">Extra Dockerfile lines</span>
        <textarea
          className="textarea mono sandbox-extra"
          spellCheck={false}
          data-testid="recipe-extra"
          disabled={disabled}
          value={recipe.extraLines}
          onChange={(e) => onChange({ ...recipe, extraLines: e.target.value })}
        />
        <span className="field-hint">
          Runs after the toolchains. Use <code className="mono">COPY --from=&lt;image&gt; &lt;dir&gt; &lt;dir&gt;</code> to add a tool from another
          image. FROM is not allowed.
        </span>
      </label>
      <details className="sandbox-dockerfile" open>
        <summary>Dockerfile</summary>
        <pre className="mono" data-testid="recipe-dockerfile">
          {preview?.dockerfile ?? ""}
        </pre>
      </details>
      {errorText && (
        <p className="field-error mono" data-testid="recipe-error">
          {errorText}
        </p>
      )}
    </div>
  );
}
