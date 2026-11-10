## Summary

<!-- What does this change, and why? -->

## Testing

These are the same three commands [`.github/workflows/qa.yml`](.github/workflows/qa.yml) runs after `npm ci`, on Node 22, on Ubuntu, macOS, and Windows. The GitHub check names are `qa (ubuntu-latest)`, `qa (macos-latest)`, and `qa (windows-latest)`.

- [ ] `npm run typecheck` passes at the repository root
- [ ] `npm run lint` passes
- [ ] `npm test` passes

## UI changes (if any)

If this changes the engine terminal UI, the engine web view, or graph-manager, follow [`TESTING.md`](../TESTING.md): test the build in this checkout, run the CLI in a **temporary** git repo (not this worktree), and prefer `--provider fake`. For UI work, include a screenshot or captured terminal output as evidence.

- [ ] Not a UI change, or I followed TESTING.md for the surfaces I touched

## Safety (if this changes how agents run)

The CLI README states that agents run in full-auto mode with the user's permissions and that **this is not a sandbox**. Do not add sandbox or safety claims that contradict that.

- [ ] Not applicable, or I did not contradict the Safety section
