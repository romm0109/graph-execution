/** Something a feature does when a user is disabled or deleted (end their terminals, delete their runs, …). */
export type UserHook = (userId: string) => Promise<void>;

/**
 * The features that own per-user resources register here, so the gateway's disable and delete (routes/gateway.ts)
 * reach them without knowing them. Hooks run one after another in registration order.
 */
export class UserLifecycle {
  private readonly disableHooks: UserHook[] = [];
  private readonly deleteHooks: UserHook[] = [];

  onDisable(fn: UserHook): void {
    this.disableHooks.push(fn);
  }

  onDelete(fn: UserHook): void {
    this.deleteHooks.push(fn);
  }

  /** Runs every disable hook; a failing hook is logged (console.error) and the others still run. */
  disabled(userId: string): Promise<void> {
    return run(this.disableHooks, userId, "disable");
  }

  /** Runs every delete hook; a failing hook is logged (console.error) and the others still run. */
  deleted(userId: string): Promise<void> {
    return run(this.deleteHooks, userId, "delete");
  }
}

async function run(hooks: UserHook[], userId: string, what: string): Promise<void> {
  for (const fn of hooks) {
    try {
      await fn(userId);
    } catch (err) {
      console.error(`user ${what} hook failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
