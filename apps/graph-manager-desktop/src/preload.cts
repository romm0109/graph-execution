// Preload for the app's own pages (dist/pages/*.html) only, never for a window showing graph-manager. Sandboxed
// preloads must be CommonJS: this .cts file compiles to dist/preload.cjs.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("gmDesktop", {
  action: (name: string) => ipcRenderer.invoke("gm:action", name),
  workspacesDir: () => ipcRenderer.invoke("gm:workspacesDir"),
  checkServer: (url: string, probe = true) => ipcRenderer.invoke("gm:checkServer", url, probe),
  chooseLocal: () => ipcRenderer.invoke("gm:chooseLocal"),
  chooseRemote: (origin: string) => ipcRenderer.invoke("gm:chooseRemote", origin),
});
