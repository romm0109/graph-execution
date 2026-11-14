# Database store: SQLite by default, Postgres optional, a store per user

graph-manager kept all its state in one JSON file (`<dataDir>/graph-manager.json`). It now keeps it in a database: SQLite at `<dataDir>/graph-manager.db` with nothing to set up, or Postgres when `GM_DATABASE_URL=postgres://…` is set. Every route reads and writes state through the caller's store, `await ctx.store.forUser(req.user)`. This is the first slice of the hosted-sessions spec (`docs/prd/hosted-sessions.md`); until accounts or a gateway exist, every request acts for the user `admin`, so nothing a user sees has changed.

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| SQLite (`better-sqlite3`) by default, Postgres (`pg`) with `GM_DATABASE_URL`; both behind one small `Db` interface (`query`, `exec`, `transaction`, `close`, `?` placeholders in both). | Nobody is forced to run Postgres; hosted and team installs can. One interface keeps the store code and its tests the same for both. | hosted-sessions |
| One JSON document per user in `user_data` (`data TEXT`), instance-wide settings (`sessionSecret`, `instanceId`) in `instance`. Every column is `TEXT` or `INTEGER`. | The per-user state keeps the exact zod schema it had (`dataSchema`), so its defaults and migrations (old sandbox recipes) keep working. TEXT/INTEGER return the same JS types from both drivers; no `SERIAL` or `JSONB` in shared SQL. | hosted-sessions |
| `revokedSessions` stays in the per-user data, read from `admin` for now. | The accounts task moves sessions to their owners. | hosted-sessions |
| Migrations `src/server/db/migrations/NNN-name.sql` (or `NNN-name.sqlite.sql` / `.postgres.sql`) run at startup in one transaction; `migrate` applies every version not applied yet, also one below the highest applied. | Features built in parallel add 002 and 003 in either order. One transaction: a failed migration leaves nothing half applied. | hosted-sessions |
| On first start, `<dataDir>/graph-manager.json` is imported into `admin` (and its session secret and instance id into `instance`) and renamed `graph-manager.json.imported`; nothing is imported when `admin` already has data. | Existing installs keep every setting, their login cookies and their sandbox image labels; the old file stays as a backup. | hosted-sessions |
| `UserStore.update` keeps the old serial chain with rollback: updates run one at a time, a failed write leaves the data in memory unchanged. | Same behaviour as the JSON store, which the routes rely on. | hosted-sessions |
| A database that can't be opened throws `ConfigError("Cannot connect to the database: …")`; a bad URL fails `loadConfig` with `invalid GM_DATABASE_URL: must start with postgres:// or postgresql://`. | Both stop startup with a readable message and exit 1, like the other config errors. | hosted-sessions |
| `better-sqlite3` and `pg` are dependencies of the engine package too, and in `MANAGER_ONLY_DEPENDENCIES`. | graph-manager ships inside the `graph-execution` npm package; sandboxes run only the engine CLI and don't need them. | hosted-sessions |
| Postgres tests run in a separate `postgres` CI job on ubuntu (`GM_TEST_DATABASE_URL`). | Service containers only run on Linux runners; macOS and Windows run the SQLite side of the contract suite. | hosted-sessions |

## Known follow-ups

- `req.user` is always `ADMIN_USER`; the accounts and gateway tasks set it from the session or the identity header.
- Sandboxes, the reviewers file (`<dataDir>/reviewers.json`) and the terminals' internal API (`/api/internal/*`) use the admin's settings (`TODO(hosted-sessions)` comments).
- The Create PR job registries are still per app, not per user.

## Code references

- `apps/graph-manager/src/server/db/db.ts`: `Db`, `openDb`, `DB_FILE`.
- `apps/graph-manager/src/server/db/sqlite.ts`, `apps/graph-manager/src/server/db/postgres.ts`: the drivers (`toPgParams`).
- `apps/graph-manager/src/server/db/migrate.ts`, `apps/graph-manager/src/server/db/migrations/001-base.sql`: migrations.
- `apps/graph-manager/src/server/db/import-json.ts`: `JsonFileStore`, `importJsonFile`.
- `apps/graph-manager/src/server/store.ts`: `Store`, `UserStore`, `SqlStore`, `InstanceData`, `Data`, `projectsOf`, `projectOf`.
- `apps/graph-manager/src/server/identity.ts`: `User`, `ADMIN_USER`, `req.user`; set in `apps/graph-manager/src/server/auth.ts`.
- Tests: `apps/graph-manager/src/server/db/db.contract.test.ts` (exports `dbContract`), `apps/graph-manager/src/server/db/import.test.ts`, `apps/graph-manager/src/server/store.test.ts`, `apps/graph-manager/src/server/store-usage.test.ts`; helpers `memoryDb`, `testStore`, `openTestStore` in `apps/graph-manager/src/server/test-helpers.ts`.
