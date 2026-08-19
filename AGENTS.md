# AGENTS.md

This file is the source of truth for any coding agent working in this repository.

## What this is

A single-file Node HTTP server (`server.js`, ~1000 lines, CommonJS, no build step,
no tests) that serves a read-only directory of markdown/notes as a mobile-friendly
file explorer and viewer over Tailscale. It is deployed only as a docker compose
service on this machine; there is no CI, no bundler, and no framework.

## Commands

```sh
docker compose up -d --build   # start, and rebuild after editing server.js
docker compose restart         # enough for plugins/ changes — bind-mounted, not baked in
docker compose logs -f
curl -s localhost:8080/_healthz

node server.js                 # run outside docker; needs DOCS_ROOT set to a real dir
```

`server.js` is baked into the image (`COPY server.js ./`), so editing it needs a
`--build`. `plugins/` is bind-mounted, so it only needs a restart.

## Architecture

Everything is one process with no router library — `http.createServer` in
`server.js` dispatches on `pathname` in order: `/_healthz`, `/_mtime`,
`/_recent`, `/_search`, `/_assets/…`, then the path resolved against `ROOT`.

Layers worth knowing before editing:

- **Path safety is centralised.** `safeResolve(urlPath)` (URL-encoded input) and
  `resolveDecoded(rel)` (already-decoded input, e.g. query strings) are the only
  ways a request turns into a filesystem path. `safeResolve` decodes and
  delegates; `resolveDecoded` is where the whole policy lives, and it rejects
  three things: escapes above `ROOT`, any path segment starting with `.`, and
  symlinks whose real path lands outside `ROOT` (it returns the *real* path, so
  callers stat what they checked). Never build an fs path from request data any
  other way — this is the entire security boundary, since there is no auth.
  Note `SKIP_DIRS` is deliberately **not** part of it: it bounds traversal cost
  in `walkMarkdown`/`listEntries`, and promoting it to an access rule would 404
  legitimate files under `dist/`, `build/`, `out/`.
- **Dispatch on extension**, via the `MD_EXT` / `TEXT_EXT` / `MIME` / `IMAGE_EXT`
  / `VIDEO_EXT` / `AUDIO_EXT` sets near the top. Adding a file type usually means
  adding to one of those sets rather than adding a branch.
- **Query flags:** `?raw=1` short-circuits to raw bytes for any type (this is how
  the sprite plugin fetches atlas JSON that would otherwise render as HTML);
  `?view=1` asks the plugins then falls back to core viewers; `?view=<name>`
  targets one plugin.
- **All HTML goes through `layout({title, rel, body, watchPath, mermaid, wide,
  head})`.** It emits breadcrumbs, the CSS link, and the live-reload client. New
  pages should call it, not hand-roll a document.
- **CSS/JS are inline constants** (`APP_CSS`, and assets served from `/_assets/`
  with an in-memory `ASSET_CACHE`). mermaid and highlight.js are read out of
  `node_modules` at request time and cached — there is no asset pipeline.
- **Live reload** is the page polling `/_mtime?path=…` every two seconds while
  visible, comparing an `mtime:size` signature. It replaced an SSE stream,
  which held one of the browser's six connections per origin for the life of
  every open page and wedged the server after a handful of notes. Anything
  interpolated into that inline `<script>` must escape `<` — `JSON.stringify`
  alone does not, and a path can contain `</script>`. The page a user already
  opened stays live, which is why revising a doc in place beats writing a new
  file with a new URL.

### Plugins

`plugins/*.js` are optional view providers, consulted **only** for `?view=`.
Contract:

```js
module.exports = {
  name, label?,
  async claims({ abs, ext, stat, api }),   // -> bool
  async view({ abs, stat, api }),          // -> { title, body, head?, wide? }
  assets: { 'x.js': { type, body } },      // served at /_assets/p/<name>/<key>
}
```

`api` = `{ ROOT, safeResolve, resolveDecoded, relOf, hrefOf, escapeHtml, fmtSize, ago }`;
a plugin must use these rather than rolling its own path handling. A plugin that
throws is logged and skipped, and the core viewer takes over — keep that property.
`PLUGINS_DISABLE=sprite` disables one without deleting it.

## Constraints to preserve

- **Port bindings in `docker-compose.yml` each name an explicit address**
  (Tailscale IP, `127.0.0.1`, and `LOCAL_HOST_IP` for the Debian/Ubuntu
  `127.0.1.1` hostname quirk). Never collapse these to bare `8080:8080` — there
  is no authentication, and the tailnet is the trust boundary.
- The docs volume is mounted `:ro` and the container runs `read_only` with
  `no-new-privileges`. The server must never need to write outside `/tmp`.
- Host-specific values live in `.env` (`DOCS_DIR`, `TAILSCALE_IP`,
  `LOCAL_HOST_IP`, `TZ`); keep `.env.example` in sync when adding one.
- Walks and search are bounded (`MAX_WALK_ENTRIES`, `MAX_SEARCH_BYTES`,
  `SKIP_DIRS`) because the served tree is a whole dev directory. Keep new
  traversal code inside those limits.
