/**
 * Environment additions that turn on `core.longpaths` for every git process started from here, agents' included.
 * Without it git for Windows cannot create or delete paths over 260 characters, which deep worktrees with
 * `node_modules` easily reach. git reads `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` (git >= 2.31;
 * older ones ignore them) as `-c` options, so the user's own config is left alone, and pairs already set are kept.
 * Elsewhere the option means nothing to git, so nothing is added; neither is anything when it is already set.
 */
export function longPathsEnv(env: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return {};
  const parsed = Number(env.GIT_CONFIG_COUNT);
  const count = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  for (let i = 0; i < count; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === "core.longpaths") return {};
  }
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "core.longpaths",
    [`GIT_CONFIG_VALUE_${count}`]: "true",
  };
}
