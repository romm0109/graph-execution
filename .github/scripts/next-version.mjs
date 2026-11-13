// Prints the version publish.yml releases. Usage: node next-version.mjs <main|dev> [latest]
//   main: package.json's version when it is above npm's latest (a minor or major bump made by hand),
//         else the next patch after npm's latest.
//   dev:  that same next version with -dev.<run>.<sha>, so a dev build sorts above the last release.
// [latest] overrides the npm lookup (for testing).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../../packages/graph-execution/package.json', import.meta.url), 'utf8'));
const [mode, latestArg] = process.argv.slice(2);
if (mode !== 'main' && mode !== 'dev') throw new Error('usage: next-version.mjs <main|dev> [latest]');

const parse = (v) => v.split('-')[0].split('.').map(Number);
const compare = (a, b) => parse(a).reduce((r, n, i) => r || n - parse(b)[i], 0);

let latest = latestArg;
if (!latest) {
  try {
    latest = execFileSync('npm', ['view', pkg.name, 'dist-tags.latest'], { encoding: 'utf8' }).trim();
  } catch {
    latest = ''; // never published
  }
}

const base = pkg.version.split('-')[0];
let next;
if (!latest || compare(base, latest) > 0) next = base;
else {
  const [major, minor, patch] = parse(latest);
  next = `${major}.${minor}.${patch + 1}`;
}

if (mode === 'dev') {
  const run = process.env.GITHUB_RUN_NUMBER ?? '0';
  const sha = (process.env.GITHUB_SHA ?? 'local').slice(0, 7);
  next = `${next}-dev.${run}.${sha}`;
}
console.log(next);
