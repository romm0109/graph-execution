import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../api";
import type { CloneJob, ForgeRepo, ForgesInfo, WorkspaceEntry } from "../types";
import { Drawer } from "../ui/Drawer";
import { Icon } from "../ui/Icon";
import { Progress } from "../ui/Progress";
import { useToast } from "../ui/toast";

type ForgeKind = "github" | "gitlab";

/** How often running clone jobs are polled. */
export const CLONE_POLL_MS = 1000;
/** Delay between the last keystroke and the repo search. */
export const SEARCH_DEBOUNCE_MS = 300;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const jobKey = (forge: string, fullPath: string) => `${forge}:${fullPath}`;

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Clone jobs, polled every second while any is running. Calls `onDone` once for each job seen running that turns done.
 * Stays mounted while the drawer is closed, so a clone started from it still toasts when it ends.
 */
function useCloneJobs(open: boolean, onDone: (job: CloneJob) => void) {
  const [jobs, setJobs] = useState<Map<string, CloneJob>>(new Map());
  const seenRunning = useRef(new Set<string>());
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((list: CloneJob[]) => {
    if (!mounted.current) return;
    setJobs((prev) => {
      const next = new Map(prev);
      // Newest start wins for one repo (a failed clone retried).
      for (const j of [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) next.set(jobKey(j.forge, j.fullPath), j);
      return next;
    });
    for (const j of list) {
      if (j.status === "running") seenRunning.current.add(j.id);
      else if (seenRunning.current.delete(j.id) && j.status === "done") onDoneRef.current(j);
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await api<{ jobs: CloneJob[] }>("/api/workspaces/clones");
      if (Array.isArray(res?.jobs)) apply(res.jobs);
    } catch {
      // Keep the last known jobs; the next poll retries.
    }
  }, [apply]);

  // Pick up clones already running (e.g. started before a reload) whenever the drawer opens.
  useEffect(() => {
    if (open) void poll();
  }, [open, poll]);

  const anyRunning = [...jobs.values()].some((j) => j.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => void poll(), CLONE_POLL_MS);
    return () => clearInterval(id);
  }, [anyRunning, poll]);

  return { jobs, apply };
}

export function CloneDrawer({
  open,
  onClose,
  forges,
  workspaces,
  root,
  refresh,
}: {
  open: boolean;
  onClose: () => void;
  forges: ForgesInfo;
  workspaces: WorkspaceEntry[];
  root?: string;
  refresh: () => Promise<void>;
}) {
  const toast = useToast();
  const connected = (["github", "gitlab"] as const).filter((k) => forges[k].connected);
  const [picked, setPicked] = useState<ForgeKind | undefined>(undefined);
  const forge: ForgeKind | undefined = picked && forges[picked].connected ? picked : connected[0];
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<ForgeRepo[] | undefined>(undefined);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);
  const [postErrors, setPostErrors] = useState<Record<string, string>>({});

  const { jobs, apply } = useCloneJobs(open, (job) => {
    void refresh();
    const id = job.workspace?.id ?? [job.forge, ...job.fullPath.split("/")].join("~");
    toast.show({
      tone: "ok",
      text: `Cloned ${job.fullPath}`,
      action: {
        label: "Open terminal",
        to: `/terminals?workspace=${encodeURIComponent(id)}`,
      },
    });
  });

  useEffect(() => {
    if (!open || !forge) return;
    let stale = false;
    const timer = setTimeout(() => {
      api<{ repos: ForgeRepo[] }>(`/api/forges/${forge}/repos?q=${encodeURIComponent(query.trim())}`)
        .then((r) => {
          if (stale) return;
          setRepos(Array.isArray(r?.repos) ? r.repos : []);
          setSearchError(undefined);
        })
        .catch((err: unknown) => {
          if (stale) return;
          setRepos(undefined);
          setSearchError(message(err));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, forge, query]);

  const clone = async (fullPath: string) => {
    if (!forge) return;
    const key = jobKey(forge, fullPath);
    setPostErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    try {
      const res = await post<{ job: CloneJob }>("/api/workspaces", {
        forge,
        fullPath,
      });
      if (res?.job) apply([res.job]);
    } catch (err) {
      setPostErrors((e) => ({ ...e, [key]: message(err) }));
    }
  };

  const login = forge ? forges[forge].login : undefined;
  const cloned = (fullPath: string) => workspaces.some((w) => w.forge === forge && w.fullPath === fullPath);

  return (
    <Drawer open={open} title="Clone repository" onClose={onClose} testId="clone-drawer">
      <div className="clone-forges" role="radiogroup" aria-label="Forge">
        {(["github", "gitlab"] as const).map((k) => {
          const info = forges[k];
          const sub = !info.connected
            ? "not connected"
            : k === "github"
              ? `as ${info.login ?? "?"}`
              : hostOf(forges.gitlab.baseUrl) || `as ${info.login ?? "?"}`;
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={forge === k}
              disabled={!info.connected}
              className="clone-forge"
              data-testid={`clone-forge-${k}`}
              onClick={() => {
                if (forge === k) return;
                setPicked(k);
                setRepos(undefined);
              }}
            >
              <strong>{k === "github" ? "GitHub" : "GitLab"}</strong>
              <span className="mono">{sub}</span>
            </button>
          );
        })}
      </div>

      {!forge ? (
        <div className="clone-note-box" data-testid="clone-no-forge">
          No forge connected. <Link to="/settings">Connect one in Settings</Link> to search repositories.
        </div>
      ) : (
        <>
          <label className="clone-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              className="mono"
              aria-label="Search repositories"
              placeholder="Search repositories"
              data-testid="repo-search"
              data-autofocus
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {repos && (
              <span className="clone-count" data-testid="repo-count">
                {repos.length === 1 ? "1 result" : `${repos.length} results`}
              </span>
            )}
          </label>

          {searchError ? (
            <p className="clone-error" role="alert" data-testid="clone-search-error">
              {searchError}
            </p>
          ) : repos === undefined ? (
            <p className="muted clone-loading">Searching…</p>
          ) : repos.length === 0 ? (
            <p className="muted clone-empty" data-testid="clone-empty">
              {query.trim() ? (
                <>
                  No repositories match “{query.trim()}” for <span className="mono">{login ?? forge}</span>.
                </>
              ) : (
                <>
                  No repositories for <span className="mono">{login ?? forge}</span>.
                </>
              )}
            </p>
          ) : (
            <ul className="clone-results">
              {repos.map((r) => {
                const job = jobs.get(jobKey(forge, r.fullPath));
                const running = job?.status === "running";
                const isCloned = cloned(r.fullPath) || job?.status === "done";
                const error = postErrors[jobKey(forge, r.fullPath)] ?? (job?.status === "failed" ? job.error : undefined);
                const pct = Math.round((job?.progress ?? 0) * 100);
                return (
                  <li key={r.fullPath} className="clone-result" data-testid={`repo-${r.fullPath}`}>
                    <div className="clone-result-line">
                      <span className="mono clone-result-name" title={r.fullPath}>
                        {r.fullPath}
                      </span>
                      {isCloned ? (
                        <span className="muted clone-cloned">already cloned</span>
                      ) : (
                        <>
                          {r.private && <span className="clone-private">private</span>}
                          {running ? (
                            <span className="mono clone-pct" data-testid={`clone-pct-${r.fullPath}`}>
                              {pct}%
                            </span>
                          ) : (
                            <button type="button" className="btn btn-sm clone-btn" data-testid={`clone-${r.fullPath}`} onClick={() => void clone(r.fullPath)}>
                              Clone
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {running && !isCloned && (
                      <div className="clone-progress">
                        <Progress value={job.progress ?? 0} tone="live" label={`Cloning ${r.fullPath}`} />
                        <span className="mono clone-phase">{job.phase ?? "Starting…"}</span>
                      </div>
                    )}
                    {error && !running && !isCloned && (
                      <span className="clone-error" role="alert">
                        {error}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <p className="clone-footnote">
        Repos are cloned into <span className="mono">{root ?? "<workspaces>"}/&lt;forge&gt;/&lt;full path&gt;</span>, keeping nested GitLab groups.
      </p>
    </Drawer>
  );
}
