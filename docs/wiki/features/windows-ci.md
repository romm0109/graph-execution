# Windows in CI

## Summary

`qa` now runs on `windows-latest` next to `ubuntu-latest` and `macos-latest`, all three blocking, with `fail-fast: false` so each OS reports its own result. The first Windows run failed 47 engine tests and could not load 4 graph-manager test files. Most failures came from the test environment, but CI also found Windows bugs in the product, which earlier Windows fixes ([GE-14 … GE-17](pre-release-windows-and-hygiene.md)) had only covered with simulated inputs. Both packages pass on all three OSes.

## Decisions

| Decision | Why | Ticket |
|---|---|---|
| `.gitattributes`: `* text=auto eol=lf`. | Git for Windows checks out with CRLF by default. That broke the shebang of `apps/graph-manager/scripts/fake-forge.mjs` ("Invalid or unexpected token") and the bundled skills' frontmatter. The repo was already LF, so nothing was renormalized. | — |
| On Windows the vitest configs set `core.autocrlf=false` (through `GIT_CONFIG_COUNT`) and `TEMP`/`TMP` to the long form of `os.tmpdir()`. | The tests compare file contents byte for byte, and git prints `C:\Users\runneradmin\…` where `os.tmpdir()` gives `C:\Users\RUNNER~1\…`. This is test-environment only: a user's own `autocrlf` stays theirs. | — |
| `listWorktrees`, the cleanup scan and `repoRoot` pass git's paths through `path.resolve`. | git prints `C:/x/y` on Windows, and the code compares those paths with native `C:\x\y` paths (leftover worktrees vs a resumed run's own). | — |
| `startup` and `assertNoLeftoverWorktrees` use `realpathSync.native`. | The JS `realpathSync` keeps 8.3 short names, so a spec under a short path was not recognised as inside the repo and showed up in the "uncommitted changes" warning. | — |
| `run.cmd` starts with `chcp 65001 >nul`. | The script is written in UTF-8 and cmd.exe reads it in the console code page, so a path or argument such as `ünï` arrived as `├╝n├»`. | — |
| `spawnAgent` on Windows reports `failed to start "<cli>": … ENOENT` when the CLI exited 1 and is not on the PATH. | A missing `.cmd` shim runs through cmd.exe, which exits 1 instead of failing the spawn, so the attempt looked like an agent failure. | — |
| The run lock records when it was written (a third line). On Windows `acquireLock` takes over a lock whose PID was created after that time, or that `tasklist` no longer lists. | Windows reuses a dead process's PID right away, and after a crash `--resume` said "locked by the running process N" for another process. A process that has exited can also still answer `kill(pid, 0)` while a handle to it is open. Only `acquireLock` asks Windows (PowerShell `Get-Process`, about a second). `lockHolder` (listings, retention, the launcher's check) stays cheap: an earlier version asked from there and slowed every run start in a suite. | — |
| Atomic writes rename with `renameReplacing` (`packages/graph-execution/src/fs/rename.ts`, exported from `graph-execution/api` for graph-manager): it retries EPERM, EACCES and EBUSY for up to 10 s on Windows. | Windows refuses to rename over a file another process has open. `suite.json` failed with EPERM while the web page polled it, which aborted the suite. | — |
| `git worktree add` is tried up to 3 times, removing what a failed add left in between. | Two features of a suite run git in the same repository: one feature's worktree commands failed the other's add halfway ("could not open '.git/worktrees/review-tester-r0/gitdir' for writing"). | — |
| Recursive `rm` in the product uses `RM_RETRY` (10 retries, linear back-off), except the launcher's best-effort removal of its script folder. | A file that an agent just closed can stay locked for a moment and fail the removal with EBUSY or EPERM, which used up a task attempt. The script folder is in use by the `run.cmd` that is still running, so retrying there only delayed the launcher, by more than the `--web` tests' 15 s. | — |
| `runCommands` starts nothing once its signal has aborted. | Killing right after the spawn raced `sh` starting its command: `taskkill /T` could run before the command existed and miss it. | — |
| Fake agent CLIs in the tests get a `<name>.cmd` shim on Windows (`src/__fixtures__/fake-bin.ts`). | That is how npm installs a CLI there. `findOnPath` does not take an extensionless file on Windows. | — |
| Skipped on Windows: the two SIGINT tests and the `chmod 000` test. | Windows has no SIGINT one process can send another (`kill("SIGINT")` terminates it without running handlers), and chmod only sets the read-only flag. | — |
| Longer timeouts on Windows: 120 s test and hook default, and 3× the suite e2e test limits and waits. | git and process start-up are several times slower on the runners. | — |

## Known follow-ups

- Ctrl+C and the hard-kill path on Windows have no automated test: the SIGINT tests are skipped there.
- The lock's Windows check costs a PowerShell call when a lock file is in the way, and is skipped when PowerShell is missing (the old behaviour: a live PID counts).
- `src/validate/commands.test.ts` still builds its hang command with a forward-slash path (`shPath`). A user's own commands are passed to `sh` as written.

## Code references

- `.github/workflows/qa.yml`, `.gitattributes`
- `packages/graph-execution/vitest.config.ts`, `apps/graph-manager/vitest.config.ts`: Windows test environment.
- `packages/graph-execution/src/git/git.ts`: `repoRoot`, `listWorktrees`, `RM_RETRY`, worktree add retries.
- `packages/graph-execution/src/state/state.ts`, `packages/graph-execution/src/providers/wintree.ts`: the lock check.
- `packages/graph-execution/src/fs/rename.ts`: `renameReplacing`.
- `packages/graph-execution/src/launch/script.ts`: `chcp 65001`.
- `packages/graph-execution/src/providers/spawn.ts`: missing CLI on Windows.
- `packages/graph-execution/src/validate/commands.ts`: no start after an abort.

## Related

- [Pre-release fixes: Windows, --version, release hygiene](pre-release-windows-and-hygiene.md)
