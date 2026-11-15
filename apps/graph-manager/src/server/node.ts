/** How to start a Node script from this process. */
export interface NodeCommand {
  /** The runtime to run: this process's own executable. */
  file: string;
  /** Extra environment for the child: ELECTRON_RUN_AS_NODE=1 under Electron, else nothing. */
  env: Record<string, string>;
}

/** This process's own runtime, plus ELECTRON_RUN_AS_NODE=1 when it is Electron (graph-manager desktop). */
export function nodeCommand(versions: NodeJS.ProcessVersions = process.versions, execPath: string = process.execPath): NodeCommand {
  // `versions.electron` stays set in a child forked with ELECTRON_RUN_AS_NODE=1, after main.ts deleted the variable.
  return { file: execPath, env: versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
}
