# Landing site at graph-execution.com

The site in `apps/site` is the public pitch for graph-execution: one static page that leads with "Turn a spec into a reviewed, tested pull request", the demo video, the install command, how a run works, the features, a "Built by itself" list of every shipped spec, and a waitlist for a hosted version for teams. The root README now opens with the same message.

Spec: [`docs/prd/done/landing-site.md`](../../prd/done/landing-site.md).

## Decisions

| Decision | Why | Ticket |
| --- | --- | --- |
| The site lives in this monorepo as the `apps/site` workspace. | Stars, issues and content stay in one repo, and a feature PR can update the site in the same change. | — |
| Astro 5, static output, no UI framework. One inline script for the copy button and reduced motion. | Fast and free to host. Astro 7 needs Node 22.23+, and the repo still supports Node 20. | — |
| Cloudflare Workers Builds builds from the repo (`npm ci && npm run build -w site`, then `npx wrangler deploy` with the root `wrangler.jsonc` pointing at `apps/site/dist`). | Free hosting with the custom domain, and no deploy workflow or API token in GitHub. | — |
| The video and poster are copied from `docs/assets/` into `public/` at build time and gitignored there. | One copy of the video in git. `copyFileSync` works on Windows, unlike symlinks. | — |
| "Built by itself" is generated from the first heading of each file in `docs/prd/done/`. | Checkable proof that grows with every finished spec. | — |
| The waitlist form posts to `PUBLIC_WAITLIST_ACTION`, a newsletter service such as Buttondown. Without it the section links to GitHub. | No backend to run. The list lives where the launch email is sent from. | — |
| The README's demo is a poster image linking to `docs/assets/demo.mp4`. | GitHub does not play a repo-relative mp4 inline, and the 60-second video is 25 MB as a GIF. | — |
| No analytics script. | Cloudflare Web Analytics can be turned on in the dashboard. | — |

## Known follow-ups

- Upload the video through the GitHub editor to get an inline player in the README (a `user-attachments` URL).
- Set `PUBLIC_WAITLIST_ACTION` in Cloudflare Pages once the newsletter account exists.
- A blog page for the "built by itself" story, and a page per feature.
- The site's `.astro` files are not type-checked in CI (`astro check` would add `@astrojs/check`).

## Code references

- Page: `apps/site/src/pages/index.astro`, layout and head tags `apps/site/src/layouts/Base.astro`, the flow diagram `apps/site/src/components/Flow.astro`.
- Spec list: `apps/site/src/lib/specs.ts` (`loadShippedSpecs`), the folder path is set in `apps/site/astro.config.mjs` (`__SPECS_DIR__`).
- Asset copy: `apps/site/scripts/copy-assets.mjs`.
- Tests: `apps/site/test/site.test.ts`, run by `npm test -w site` after a build.
- Deploy settings: `apps/site/README.md`.
