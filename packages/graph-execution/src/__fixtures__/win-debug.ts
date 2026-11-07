// TEMPORARY (ci/windows-wip): find out which process keeps a temp repo busy on Windows. Not for the final PR.
import { rm } from "node:fs/promises";
import { execa } from "execa";

export async function rmOrExplain(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    if (process.platform === "win32") {
      const script =
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name) :: $($_.CommandLine)\" }";
      const res = await execa("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { reject: false });
      const leaf = dir.split(/[\\/]/).pop() ?? dir;
      const hits = res.stdout.split(/\r?\n/).filter((l) => l.includes(leaf) || /node|cmd\.exe|git|sh\.exe|powershell/i.test(l));
      console.error(`[win-debug] ${String(err)}\n[win-debug] processes:\n${hits.join("\n")}`);
    }
    throw err;
  }
}
