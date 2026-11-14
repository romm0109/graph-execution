import * as React from "react";
import { useSyncExternalStore, type ReactNode } from "react";
import { api } from "./api";

/** A nav item a plugin adds at the end of the nav links. */
export interface PluginNav {
  label: string;
  path: string;
}
/** A page a plugin adds to the router. */
export interface PluginRoute {
  path: string;
  element: ReactNode;
}
/** A section a plugin adds at the end of the Settings page. */
export interface PluginSettingsSection {
  title: string;
  element: ReactNode;
}
/** What a plugin module's default export is called with. `React` is graph-manager's own React: plugins use it, never a bundled copy. */
export interface PluginApi {
  React: typeof React;
  registerNav(item: PluginNav): void;
  registerRoute(route: PluginRoute): void;
  registerTopbar(element: ReactNode): void;
  registerSettingsSection(section: PluginSettingsSection): void;
}
/** Everything the plugins registered; `loaded` once every module was imported (or the safety timeout passed). */
export interface PluginRegistry {
  nav: PluginNav[];
  routes: PluginRoute[];
  topbar: ReactNode[];
  settings: PluginSettingsSection[];
  loaded: boolean;
}

/** Imports one module URL. Replaced in tests (vitest cannot import http URLs). */
export type Importer = (url: string) => Promise<{ default?: unknown }>;
const defaultImporter: Importer = (url) => import(/* @vite-ignore */ url) as Promise<{ default?: unknown }>;

/** The paths of graph-manager's own pages: a plugin adds pages, it never replaces one. */
const BUILTIN_PATHS = new Set(["/", "/runs", "/runs/:ws/:runId", "/terminals", "/workspaces", "/projects", "/reviewers", "/settings", "/signup", "/set-password", "*"]);

/** How long `loadPlugins` waits for the modules before it marks the registry loaded anyway (a late plugin still registers). */
export const PLUGIN_LOAD_TIMEOUT_MS = 10_000;

const EMPTY: PluginRegistry = { nav: [], routes: [], topbar: [], settings: [], loaded: false };
let snapshot: PluginRegistry = EMPTY;
const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;

function update(next: Partial<PluginRegistry>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): PluginRegistry => snapshot;

/** The plugin registry; re-renders when a plugin registers something or loading finishes. */
export function usePlugins(): PluginRegistry {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isPath = (v: unknown): v is string => typeof v === "string" && v.startsWith("/");

function pluginApi(url: string): PluginApi {
  const bad = (what: string, value: unknown) => console.error(`graph-manager: plugin ${url} registered an invalid ${what}:`, value);
  return {
    React,
    registerNav(item) {
      if (!item || !nonEmpty(item.label) || !isPath(item.path)) return bad("nav item", item);
      update({ nav: [...snapshot.nav, { label: item.label, path: item.path }] });
    },
    registerRoute(route) {
      if (!route || !isPath(route.path)) return bad("route", route);
      if (BUILTIN_PATHS.has(route.path) || snapshot.routes.some((r) => r.path === route.path)) {
        console.error(`graph-manager: plugin ${url} cannot replace the page ${route.path}`);
        return;
      }
      update({ routes: [...snapshot.routes, { path: route.path, element: route.element }] });
    },
    registerTopbar(element) {
      if (element === undefined || element === null) return bad("top bar element", element);
      update({ topbar: [...snapshot.topbar, element] });
    },
    registerSettingsSection(section) {
      if (!section || !nonEmpty(section.title)) return bad("settings section", section);
      update({ settings: [...snapshot.settings, { title: section.title, element: section.element }] });
    },
  };
}

async function importAll(importer: Importer): Promise<void> {
  let urls: string[] = [];
  try {
    const body = await api<{ plugins?: unknown }>("/api/ui/plugins");
    if (Array.isArray(body?.plugins)) urls = body.plugins.filter((u): u is string => typeof u === "string");
  } catch {
    // No plugins: the UI is the built-in one.
  }
  for (const url of urls) {
    try {
      const mod = await importer(url);
      if (typeof mod?.default !== "function") {
        console.error(`graph-manager: plugin ${url} has no default export function`);
        continue;
      }
      await (mod.default as (api: PluginApi) => unknown)(pluginApi(url));
    } catch (err) {
      console.error(`graph-manager: plugin ${url} failed to load:`, err);
    }
  }
}

/** Reads /api/ui/plugins and imports each module once, in order. Never throws; marks `loaded` when done. */
export function loadPlugins(importer: Importer = defaultImporter): Promise<void> {
  if (loading) return loading;
  loading = new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (!snapshot.loaded) update({ loaded: true });
      resolve();
    };
    const timer = setTimeout(done, PLUGIN_LOAD_TIMEOUT_MS);
    void importAll(importer).then(done, done);
  });
  return loading;
}

/** Tests only: empties the registry and forgets that plugins were loaded. */
export function resetPlugins(): void {
  loading = undefined;
  snapshot = EMPTY;
  for (const listener of listeners) listener();
}
