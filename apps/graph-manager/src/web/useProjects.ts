import { useEffect, useState } from "react";
import { api } from "./api";
import type { ProjectEntry } from "./types";

/** The list of `GET /api/projects` (a bare array; an older server's `{ projects }` is read too), else empty. */
export function projectList(res: unknown): ProjectEntry[] {
  if (Array.isArray(res)) return res as ProjectEntry[];
  const wrapped = (res as { projects?: unknown } | undefined)?.projects;
  return Array.isArray(wrapped) ? (wrapped as ProjectEntry[]) : [];
}

/** The projects (`GET /api/projects`), fetched once; empty until it answers and when it fails. */
export function useProjects(): ProjectEntry[] {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  useEffect(() => {
    let live = true;
    api<unknown>("/api/projects").then(
      (r) => {
        if (live) setProjects(projectList(r));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return projects;
}
