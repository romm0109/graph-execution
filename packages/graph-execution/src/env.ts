// Imported first by `cli.ts`: ESM evaluates imports in order, so this runs before React is loaded.
//
// React picks its development or production build from NODE_ENV the first time it is loaded, and an unset NODE_ENV
// means development. React 19's development build records a `performance.measure` entry for every render, and Node
// keeps those entries for the life of the process. The live view re-renders every 100 ms for its spinners, so a long
// run grew the heap by several MB a second until it hit the limit (about 4 GB, after roughly 12 minutes).
// An explicit NODE_ENV (e.g. `development` while hacking on the UI) is left alone.
/** True when the user set no NODE_ENV: `graph-execution manager` then takes the default away from what it starts. */
export const NODE_ENV_DEFAULTED = process.env.NODE_ENV === undefined;
process.env.NODE_ENV ??= "production";
