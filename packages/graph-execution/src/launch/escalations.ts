import path from "node:path";
import { loadEscalations } from "../escalation/store.js";
import { EXIT_ABORT, EXIT_SUCCESS, type ExitCode } from "../state/errors.js";
import { findRunDir, type RunCommandOptions, stderrLine, stdoutLine } from "./resolve.js";

const REASON_MAX = 100;

/** `graph-execution escalations`: one line per escalation of the run: id, node, status and reason. */
export async function listEscalations(opts: RunCommandOptions): Promise<ExitCode> {
  const out = opts.out ?? stdoutLine;
  const err = opts.err ?? stderrLine;
  const found = await findRunDir(opts);
  if ("error" in found) {
    err(found.error);
    return EXIT_ABORT;
  }
  const records = await loadEscalations(found.runDir);
  if (records.length === 0) {
    out(`no escalations in run ${path.basename(found.runDir)}`);
    return EXIT_SUCCESS;
  }
  const rows = records.map((r) => {
    const reason = r.reason.replace(/\s+/g, " ").trim();
    return {
      id: r.id,
      node: r.node === "fixer" ? "fixer" : `task ${r.node}`,
      status: r.status,
      reason: reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason,
    };
  });
  const width = (key: "id" | "node" | "status"): number => Math.max(...rows.map((r) => r[key].length));
  const [wi, wn, ws] = [width("id"), width("node"), width("status")];
  for (const r of rows) out(`${r.id.padEnd(wi)}  ${r.node.padEnd(wn)}  ${r.status.padEnd(ws)}  ${r.reason}`);
  return EXIT_SUCCESS;
}
