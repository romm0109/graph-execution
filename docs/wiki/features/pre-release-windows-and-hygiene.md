# Pre-release fixes: Windows, --version, release hygiene (GE-14 … GE-18, GE-22)

## Summary

Fixes for the Windows-only bugs GE-14 … GE-17 (Jira KAN-75 … KAN-78), `--version` (GE-18), release hygiene (GE-22: version 1.2.0, MIT `LICENSE`) and the three follow-ups left by the GE-01 … GE-13 work. The Windows fixes were found by reading the code; they are unit-tested with simulated Windows paths, process tables and command lines that run on Linux/macOS CI, and still need a smoke test on a real Windows machine.

## Decisions

| Decision | Why | Ticket |
|---|---|---|
| After an agent exits on Windows, `killLeftovers` (`src/providers/wintree.ts`) lists processes with PowerShell (`Get-CimInstance Win32_Process`, sent `-EncodedCommand`) and `taskkill /F /T`s the agent's descendants. A direct child must have been created while the agent ran (±2 s); a deeper one no earlier than its parent. | Windows has no process groups and `taskkill /T` needs a live PID, but it never re-parents orphans, so their `ppid` still names the dead agent. Creation times rule out reused PIDs. Costs one PowerShell call per agent exit. | KAN-75 |
| `findOnPath` on Windows never takes a bare name: it tries each PATHEXT extension, unless the name already ends in one. | That is how cross-spawn (inside execa) resolves the spawn; npm puts an extensionless `sh` shim next to `claude.cmd`, which Windows cannot run. | KAN-76 |
| `cmd` is called as `cmd /d /s /c "<line>"` with `windowsVerbatimArguments` (`cmdArgs` / `quoteCmdArg` in `src/launch/quote.ts`), for the `--web` detached fallback and the browser opener. | Node's quoting plus cmd's quote-stripping rule broke a path with a space (`%TEMP%` under "C:\Users\Ada Lovelace") and `start "" <file>`; a URL's `&` was a command separator. | KAN-77 |
| Setup and validate run as `sh -c <command>` on Windows (`posixShell` in `src/validate/shell.ts`): `GRAPH_EXECUTION_SHELL`, else `sh` on the PATH, else Git for Windows' `sh.exe` next to `git`; `cmd.exe` only when none is found, or with `GRAPH_EXECUTION_SHELL=cmd`. | Commands are written for `sh`; git is required anyway and Git for Windows always ships `sh.exe`. The env var keeps an escape hatch for cmd-only commands. | KAN-78 |
| `--version` / `-v` reads `package.json` one folder above the module (`src/version.ts`). | One source of truth; works from `src/` and from the packed `dist/`. | GE-18 |
| Version 1.2.0 (npm `latest` was 1.1.0). | Since 1.1.0 there is a new flag (`--version`), a new config key (`idleTimeoutMinutes`) and changed exit codes: a minor release, not a patch. | GE-22 |
| `clean` reports branches it keeps on the run's own line (`keeps branches …`, `deleted <id> …; kept branches …`), not as `Skipped <id>`. | The run folder is still deleted, so "Skipped" then "deleted" contradicted itself. Only wholly skipped runs (live) are "Skipped". | follow-up |
| `LogTail.subscribe(labels, offsets, catchUp)` sends a second subscriber the bytes between its offset and the shared position, synchronously, before it joins the broadcast. | The run page shares one watcher across tabs; the second tab otherwise lost what was written between its list and its subscribe. | follow-up |

## Code references

- `src/providers/wintree.ts`, `src/providers/spawn.ts` — Windows leftover kill.
- `src/providers/index.ts` — `findOnPath`.
- `src/launch/quote.ts`, `src/launch/handoff.ts`, `src/readme/readme.ts` — cmd command lines.
- `src/validate/shell.ts`, `src/validate/commands.ts` — shell for setup/validate.
- `src/version.ts`, `src/cli.ts` — `--version`.
- `src/cleanup/plan.ts`, `src/cleanup/clean.ts`, `src/cleanup/execute.ts` — kept branches.
- `src/web/logtail.ts`, `src/web/server.ts` — catch-up.

## Related

- [Bug-hunt hardening (GE-01 … GE-13)](bug-hunt-hardening.md)
- [Project wiki index](../index.md)

## Last updated

2026-11-06
