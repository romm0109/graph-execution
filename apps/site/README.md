# site

The [graph-execution.com](https://graph-execution.com) landing site: one static page built with [Astro](https://astro.build), plus a 404 page.

## Run it

From the repository root:

```bash
npm ci
npm run dev -w site       # http://localhost:4321
npm run build -w site     # writes apps/site/dist
npm test -w site          # builds, then checks the built pages
```

`prebuild` (and `dev`) copy `docs/assets/demo.mp4` and `docs/assets/demo-poster.jpg` into `public/`. The copies are gitignored, so the repo keeps one copy of the video.

The "Built by itself" list is generated at build time from the first `# ` heading of every file in `docs/prd/done/`. Moving a spec there adds it to the site on the next deploy.

## Waitlist

The "Hosted for teams" section shows an email form when `PUBLIC_WAITLIST_ACTION` is set at build time. The form posts one field, `email`, to that URL. When it is unset, the section links to the GitHub repo instead.

The site stores nothing itself. Point the form at a newsletter service, so the same list is the one you email at launch. With [Buttondown](https://buttondown.com) the value is `https://buttondown.com/api/emails/embed-subscribe/<your-username>`. Any service that accepts a plain HTML form POST with an `email` field works the same way.

## Deploy on Cloudflare

The site deploys as a Cloudflare Worker with static assets. [`wrangler.jsonc`](wrangler.jsonc) points at `dist/` and serves `404.html` for unknown paths.

In Cloudflare, import this repository under **Workers & Pages → Create** and set:

| Setting | Value |
| --- | --- |
| Project name | `graph-execution` (must match `name` in `wrangler.jsonc`) |
| Build command | `npm ci && npm run build -w site` |
| Deploy command | `npx wrangler deploy --config apps/site/wrangler.jsonc` |
| Root directory | (empty, the repository root) |
| Build variables | `NODE_VERSION=22`, and optionally `PUBLIC_WAITLIST_ACTION` |

Pass `--config`: without it wrangler finds no config at the root and stops with "detection logic has been run in the root of a workspace". Then add `graph-execution.com` as a custom domain under the Worker's **Settings → Domains & Routes**.
