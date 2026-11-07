import { useEffect, useId, useMemo, useRef } from "react";
import { mermaidSources, renderSpecHtml } from "../spec";
import "./SpecView.css";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Renders a spec's Markdown (raw HTML escaped, unsafe links dropped). Mermaid blocks are drawn by a lazily imported
 * mermaid, one block at a time: a broken block shows its error and source, the rest still render.
 */
export function SpecView({ text, theme }: { text: string; theme: "light" | "dark" }) {
  const ref = useRef<HTMLElement>(null);
  const html = useMemo(() => renderSpecHtml(text), [text]);
  const sources = useMemo(() => mermaidSources(text), [text]);
  const uid = useId().toLowerCase().replace(/[^a-z0-9-]/g, "");

  useEffect(() => {
    const root = ref.current;
    if (!root || sources.length === 0) return;
    let cancelled = false;
    void (async () => {
      const { default: mermaid } = await import("mermaid");
      if (cancelled) return;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default" });
      const blocks = root.querySelectorAll<HTMLElement>("[data-mermaid]");
      for (const el of blocks) {
        const i = Number(el.dataset.mermaid);
        const src = sources[i];
        if (src === undefined) continue;
        try {
          const { svg } = await mermaid.render(`spec-mmd-${uid}-${i}`, src);
          if (cancelled) return;
          el.innerHTML = svg;
          el.classList.add("spec-mermaid-ok");
          el.classList.remove("spec-mermaid-failed");
        } catch (err) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          el.innerHTML = `<div class="spec-mermaid-error">Diagram error: ${escapeHtml(msg)}</div><pre>${escapeHtml(src)}</pre>`;
          el.classList.add("spec-mermaid-failed");
          el.classList.remove("spec-mermaid-ok");
        }
      }
    })().catch((err: unknown) => {
      // Mermaid failed to load: leave the sources visible.
      if (!cancelled) console.error("mermaid failed to load", err);
    });
    return () => {
      cancelled = true;
    };
  }, [html, sources, theme, uid]);

  return <article className="spec-view" ref={ref} dangerouslySetInnerHTML={{ __html: html }} data-testid="spec-view" />;
}
