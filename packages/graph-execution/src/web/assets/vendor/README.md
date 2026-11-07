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
