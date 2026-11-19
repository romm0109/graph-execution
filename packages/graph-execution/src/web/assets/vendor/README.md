# Bundled third-party files

Vendored so the UI works offline and over SSH tunnels. Not listed in `package.json`.

| Path | Source package | Version |
| --- | --- | --- |
| `highlight/highlight.min.js` | `@highlightjs/cdn-assets` `es/highlight.min.js` | 11.12.0 |
| `highlight/languages/*.min.js` (typescript, javascript, json, python, go, rust, java, css, scss, xml, bash, markdown, yaml, sql, diff) | `@highlightjs/cdn-assets` `es/languages/` | 11.12.0 |
| `highlight/LICENSE` | `@highlightjs/cdn-assets` | 11.12.0 |
| `fonts/inter-latin-{400,500,600}-normal.woff2` | `@fontsource/inter` | 5.3.0 |
| `fonts/jetbrains-mono-latin-{400,500,600}-normal.woff2` | `@fontsource/jetbrains-mono` | 5.3.0 |
| `fonts/Inter-LICENSE.txt`, `fonts/JetBrainsMono-LICENSE.txt` | the font packages | 5.3.0 |

Each language file does `export default` a grammar for `hljs.registerLanguage(name, grammar)`.

## xterm (`dist/web/assets/vendor/xterm/`, copied at build time)

The advisor terminal on the escalation screen uses xterm.js. Unlike the files above, these packages **are** dependencies
of `graph-execution` (the shared terminal module, `src/terminal/`, needs them too), so they are not committed here:
`scripts/vendor-xterm.mjs`, run by the postbuild, copies them from `node_modules` (resolved with `createRequire` from
the engine folder) into `dist/web/assets/vendor/xterm/`.

| Published file | Source package file |
| --- | --- |
| `xterm.mjs` | `@xterm/xterm` `lib/xterm.mjs` |
| `xterm.css` | `@xterm/xterm` `css/xterm.css` (linked by `loadTerminal` in `escalation.js` when the terminal first loads) |
| `addon-fit.mjs` | `@xterm/addon-fit` `lib/addon-fit.mjs` |
| `addon-webgl.mjs` | `@xterm/addon-webgl` `lib/addon-webgl.mjs` |
| `xterm-zerolag-input.mjs` | `xterm-zerolag-input` `dist/index.js` |

Every package ships an ES module build with no imports of its own, so the page loads them with `import()` from
relative URLs (`.mjs` is served as `text/javascript`, `src/web/assets.ts`) instead of UMD `<script>` tags and globals.
The terminal client itself (`assets/terminal/client.js`) takes the classes as options and has no bare imports.
