import type { RunSummary } from "../types";

const isHttpUrl = (url: string | undefined): url is string => url !== undefined && /^https?:\/\//i.test(url);

/** A run's refs (tickets): `KAN-41 ↗` links to their URLs in a new tab, plain text when there is no http(s) URL. */
export function RefLinks({ refs }: { refs?: RunSummary["refs"] }) {
  if (!refs || refs.length === 0) return null;
  return (
    <span className="ref-links">
      {refs.map((r) =>
        isHttpUrl(r.url) ? (
          <a
            key={r.ref}
            className="ref-link mono"
            href={r.url}
            target="_blank"
            rel="noreferrer"
            title={r.title ?? r.ref}
            onClick={(e) => e.stopPropagation()}
          >
            {r.ref} ↗
          </a>
        ) : (
          <span key={r.ref} className="ref-link mono" title={r.title ?? r.ref}>
            {r.ref}
          </span>
        ),
      )}
    </span>
  );
}
