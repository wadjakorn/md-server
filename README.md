# md-server

A file explorer and markdown viewer for a directory of working notes, reachable
from a phone over Tailscale. Exists so agent-written plans, designs, and reports
are readable away from the terminal — write a `.md`, share a URL, done. There is
no publish step and no build step.

## Setup

```sh
cp .env.example .env      # then edit it
docker compose up -d --build
```

`.env` holds everything host-specific:

| variable | meaning | default |
|---|---|---|
| `DOCS_DIR` | directory to serve | `${HOME}/development` |
| `TAILSCALE_IP` | this machine's tailnet address | `127.0.0.1` |
| `LOCAL_HOST_IP` | address the box's own hostname resolves to | `127.0.1.1` |

Leave `TAILSCALE_IP` unset and the server binds loopback only — safe by default,
and never the LAN.

## URLs

| | |
|---|---|
| MagicDNS | `http://<your-host>:8080/` |
| Fully qualified | `http://<your-host>.<your-tailnet>.ts.net:8080/` |
| Raw Tailscale IP | `http://<your-tailscale-ip>:8080/` |
| On the box | `http://127.0.0.1:8080/` |

The path after the port is relative to the served directory, so
`<docs>/capz/PLAN.md` → `…:8080/capz/PLAN.md`.

The short-name form needs one wrinkle handled: on Debian and Ubuntu `/etc/hosts`
maps the box's own hostname to `127.0.1.1`, which beats the Tailscale search
domain locally — hence `LOCAL_HOST_IP`. Without that binding the short name
works from the tailnet but is refused on the box itself.

## Routes

- `/<path>` — a directory lists as the file explorer; a `.md` file renders. Any
  other file serves its raw bytes, so images embedded in markdown resolve.
- `/<path>?view=1` — the viewer for that file: image viewer, sprite player,
  highlighted source, or a download page, whichever fits
- `/<path>?raw=1` — raw bytes for any type, including the `.json` that would
  otherwise render as highlighted HTML
- `/_recent` — every markdown file under the root, newest edit first
- `/_search?q=` — filename and full-text search
- `/_mtime?path=` — `{"sig"}`, a change signature for one file; what the
  open page polls to know it should reload
- `/_healthz` — liveness probe

## Features

- **File explorer** — folders first, then files, each with an icon, size and
  last-edit time. Browsing a folder never auto-opens its README.
- **Image viewer** — fit-to-screen with tap-to-zoom, arrow keys or ‹ › to walk
  the other images in the same folder, and the next one prefetched.
- **Auto-reload** — the open page reloads when the file changes on disk, so a
  link stays live while a doc is being revised. It polls `/_mtime` every two
  seconds while visible, and stops while the tab is in the background. A held
  connection would be simpler, but each one costs a page one of the browser's
  six per origin, and a handful of open notes then locks the server out.
- **Mermaid** diagrams, **highlight.js** syntax highlighting, both following the
  device's light/dark setting.
- Mobile-first layout with safe-area insets; wide tables and code scroll inside
  their own container rather than the page.
- Source files (`.ts`, `.rs`, `.json`, …) render highlighted; images and video
  are served inline so they work in markdown.

## Operating

```bash
docker compose up -d --build   # start / rebuild after editing server.js
docker compose logs -f         # tail
docker compose restart
```

`restart: unless-stopped` brings it back after a reboot.

## Security

- Published on the Tailscale interface and loopback **only** — every port
  binding names an explicit address, so the LAN (`192.168.x`) and the public
  internet cannot reach it. Do not change those to bare `8080:8080`.
- The served directory is mounted **read-only**; the container itself runs
  read-only with `no-new-privileges`.
- Path traversal out of the doc root is rejected. Dotfiles and heavy build
  directories (`node_modules`, `target`, `.git`, …) are skipped in listings,
  walks, and search.

There is no authentication — anything on the tailnet that can reach port 8080
can read the served directory. That is the intended trust boundary; don't widen
the port binding.

## Plugins

Viewers that are not core live in `plugins/*.js` and are consulted only for
`?view=`. A plugin exports:

```js
module.exports = {
  name: 'sprite',
  label: 'Animate',                 // button text on the image viewer
  async claims ({ abs, ext, stat, api }) { … },   // will you handle this file?
  async view ({ abs, stat, api }) { … },          // -> { title, body, head?, wide? }
  assets: { 'sprite.js': { type: '…', body: '…' } },  // served at /_assets/p/<name>/<key>
}
```

`api` provides `ROOT`, `safeResolve`, `resolveDecoded`, `relOf`, `hrefOf`,
`escapeHtml`, `fmtSize` and `ago`, so a plugin never rolls its own path
sanitising. A plugin that throws is logged and skipped; the core viewer takes
over.

`plugins/` is bind-mounted into the container, so adding or removing one is a
`docker compose restart`, not a rebuild. `PLUGINS_DISABLE=sprite` turns one off
without deleting it.

**`sprite`** — claims a TexturePacker atlas (`frames` + `meta`, hash or array
form) reached either through the `.json` or through the `.png` beside it. It
groups frame keys like `walk-south-2` into animations, plays them on a canvas
with adjustable fps and pixelated zoom, and shows every frame in a grid. The
sheet comes from `meta.image`, reduced to a bare filename before use. Remove the
plugin and those `.png` files simply open in the image viewer.
