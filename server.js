'use strict'

const http = require('http')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const url = require('url')

const MarkdownIt = require('markdown-it')
const anchor = require('markdown-it-anchor')
const taskLists = require('markdown-it-task-lists')
const hljs = require('highlight.js')

const ROOT = path.resolve(process.env.DOCS_ROOT || '/docs')
const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '0.0.0.0'

// Directories that are never worth walking or listing.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.venv', 'venv',
  '__pycache__', 'target', 'dist', 'build', 'out', 'coverage', '.cache',
  '.turbo', '.pnpm-store', 'vendor', '.tox', '.mypy_cache', '.pytest_cache',
  'Pods', 'DerivedData', '.gradle', '.idea', '.terraform',
])

const MD_EXT = new Set(['.md', '.markdown', '.mdx'])
const TEXT_EXT = new Set([
  '.txt', '.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.rs', '.go', '.py', '.rb',
  '.sh', '.bash', '.zsh', '.sql', '.html', '.css', '.scss', '.swift', '.kt',
  '.java', '.c', '.h', '.cpp', '.hpp', '.diff', '.patch', '.log', '.csv',
])
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.bmp': 'image/bmp',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.flac': 'audio/flac',
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac'])

const MAX_WALK_ENTRIES = 40000
const MAX_SEARCH_BYTES = 512 * 1024

// ---------------------------------------------------------------- markdown

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  highlight (code, lang) {
    if (lang === 'mermaid') {
      return `<pre class="mermaid">${escapeHtml(code)}</pre>`
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        const out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        return `<pre class="hljs"><code class="language-${escapeHtml(lang)}">${out}</code></pre>`
      } catch { /* fall through */ }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`
  },
})
md.use(anchor, { permalink: anchor.permalink.headerLink({ safariReaderFix: true }) })
md.use(taskLists, { enabled: true, label: true })

// ------------------------------------------------------------------ paths

/** Resolve a URL pathname to an absolute path inside ROOT, or null if it escapes. */
/** Resolve an already-decoded, ROOT-relative path. Returns null if it escapes. */
function resolveDecoded (rel) {
  const abs = path.resolve(ROOT, '.' + path.posix.normalize('/' + rel))
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null
  return abs
}

/** Resolve a percent-encoded URL path. Query values are already decoded by
 *  url.parse — those go through resolveDecoded, or a name containing a literal
 *  '%' gets decoded twice and throws. */
function safeResolve (urlPath) {
  let rel
  try {
    rel = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  return resolveDecoded(rel)
}

function relOf (abs) {
  const rel = path.relative(ROOT, abs)
  return rel === '' ? '' : rel.split(path.sep).join('/')
}

function hrefOf (abs, trailingSlash = false) {
  const rel = relOf(abs)
  if (rel === '') return '/'
  const encoded = '/' + rel.split('/').map(encodeURIComponent).join('/')
  return trailingSlash ? encoded + '/' : encoded
}

// -------------------------------------------------------------------- walk

/**
 * Walk ROOT collecting markdown files. Stops at MAX_WALK_ENTRIES so a stray
 * huge tree can't wedge the server.
 */
async function walkMarkdown (opts = {}) {
  const { onFile } = opts
  const out = []
  let seen = 0
  const queue = [ROOT]
  while (queue.length) {
    const dir = queue.shift()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (seen++ > MAX_WALK_ENTRIES) return out
      if (e.name.startsWith('.') && e.name !== '.claude') continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        queue.push(abs)
      } else if (e.isFile() && MD_EXT.has(path.extname(e.name).toLowerCase())) {
        let st
        try {
          st = await fsp.stat(abs)
        } catch {
          continue
        }
        const rec = { abs, rel: relOf(abs), mtime: st.mtimeMs, size: st.size }
        if (onFile) await onFile(rec)
        out.push(rec)
      }
    }
  }
  return out
}

// ------------------------------------------------------------------ layout

function escapeHtml (s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function breadcrumbs (rel) {
  const parts = rel === '' ? [] : rel.split('/')
  const crumbs = ['<a href="/">~/development</a>']
  let acc = ''
  parts.forEach((p, i) => {
    acc += '/' + encodeURIComponent(p)
    const last = i === parts.length - 1
    crumbs.push(last ? `<span>${escapeHtml(p)}</span>` : `<a href="${acc}/">${escapeHtml(p)}</a>`)
  })
  return crumbs.join('<span class="sep">/</span>')
}

function layout ({ title, rel, body, watchPath, mermaid, wide, head }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>📄</text></svg>">
<link rel="stylesheet" href="/_assets/app.css">
<link rel="stylesheet" href="/_assets/hljs.css">
${head || ''}
</head>
<body>
<header class="topbar">
  <nav class="crumbs">${breadcrumbs(rel)}</nav>
  <div class="actions">
    <a href="/_recent">Recent</a>
    <form class="search" action="/_search"><input name="q" type="search" placeholder="Search…" autocomplete="off"></form>
  </div>
</header>
<main class="${wide ? 'wide' : mermaid ? 'doc' : 'doc plain'}">
${body}
</main>
${watchPath ? `<div id="reload-toast">Updated — reloading…</div>
<script>
  // Polled, not streamed. A held connection is one of the browser's six per
  // origin, and every open page would hold one — so a few open notes locked
  // the whole server out. Polling only while visible keeps it to one small
  // request every two seconds for the page actually being read.
  const watch = '/_mtime?path=' + encodeURIComponent(${JSON.stringify(watchPath)})
  let sig = null
  let timer = 0
  const poll = async () => {
    let now
    try {
      now = (await (await fetch(watch, { cache: 'no-store' })).json()).sig
    } catch { return } // server restarting, say — try again next tick
    if (sig === null) { sig = now; return }
    if (now === sig) return
    document.getElementById('reload-toast').classList.add('show')
    setTimeout(() => location.reload(), 250)
  }
  // Restarting on show also catches up a page returning from the back/forward
  // cache, which may have missed a change while it was away.
  const start = () => { if (!timer) { poll(); timer = setInterval(poll, 2000) } }
  const stop = () => { clearInterval(timer); timer = 0 }
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start())
  addEventListener('pagehide', stop)
  addEventListener('pageshow', start)
  start()
</script>` : ''}
${mermaid ? `<script type="module">
  import mermaid from '/_assets/mermaid.esm.min.mjs'
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  mermaid.initialize({ startOnLoad: true, theme: dark ? 'dark' : 'default', securityLevel: 'loose' })
</script>` : ''}
</body>
</html>`
}

// ------------------------------------------------------------------ routes

async function renderMarkdown (abs, res) {
  const raw = await fsp.readFile(abs, 'utf8')
  const html = md.render(raw)
  const rel = relOf(abs)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(layout({
    title: path.basename(abs),
    rel,
    body: html,
    watchPath: rel,
    mermaid: /class="mermaid"/.test(html),
  }))
}

async function renderText (abs, res) {
  const raw = await fsp.readFile(abs, 'utf8')
  const ext = path.extname(abs).slice(1)
  let code
  if (ext && hljs.getLanguage(ext)) {
    code = hljs.highlight(raw, { language: ext, ignoreIllegals: true }).value
  } else {
    code = escapeHtml(raw)
  }
  const rel = relOf(abs)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(layout({
    title: path.basename(abs),
    rel,
    body: `<pre class="hljs filecode"><code>${code}</code></pre>`,
    watchPath: rel,
  }))
}

const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Visible, non-skipped entries of a directory, folders first then files. */
async function listEntries (abs) {
  const entries = await fsp.readdir(abs, { withFileTypes: true })
  const dirs = []
  const files = []
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      dirs.push(e.name)
    } else {
      files.push(e.name)
    }
  }
  dirs.sort(COLLATOR.compare)
  files.sort(COLLATOR.compare)
  return { dirs, files }
}

function fmtSize (bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function iconFor (name, isDir) {
  if (isDir) return '📁'
  const ext = path.extname(name).toLowerCase()
  if (MD_EXT.has(ext)) return '📄'
  if (IMAGE_EXT.has(ext)) return '🖼️'
  if (ext === '.pdf') return '📕'
  if (VIDEO_EXT.has(ext)) return '🎬'
  if (AUDIO_EXT.has(ext)) return '🎵'
  if (ext === '.json' || ext === '.yml' || ext === '.yaml' || ext === '.toml') return '⚙️'
  if (TEXT_EXT.has(ext)) return '📜'
  return '📦'
}

/** Files get ?view=1 so a click lands on a viewer; the bare URL stays raw. */
function entryHref (dirRel, name, isDir) {
  const base = (dirRel === '' ? '' : '/' + dirRel.split('/').map(encodeURIComponent).join('/')) +
    '/' + encodeURIComponent(name)
  if (isDir) return base + '/'
  const ext = path.extname(name).toLowerCase()
  return MD_EXT.has(ext) || TEXT_EXT.has(ext) ? base : base + '?view=1'
}

async function renderDir (abs, res) {
  let listed
  try {
    listed = await listEntries(abs)
  } catch {
    return notFound(res)
  }
  const { dirs, files } = listed
  const rel = relOf(abs)

  // stat() per entry is the only cost that scales with directory size; past a
  // few thousand entries drop the metadata rather than the whole page.
  const withMeta = dirs.length + files.length <= 2000
  const statOf = async (name) => {
    if (!withMeta) return null
    try {
      return await fsp.stat(path.join(abs, name))
    } catch {
      return null // broken symlink — show the row without metadata
    }
  }
  const dirStats = await Promise.all(dirs.map(statOf))
  const fileStats = await Promise.all(files.map(statOf))

  const row = (name, isDir, st) => {
    const meta = st
      ? `<span class="size">${isDir ? '' : fmtSize(st.size)}</span><time datetime="${new Date(st.mtimeMs).toISOString()}">${ago(st.mtimeMs)}</time>`
      : '<span class="size"></span><time></time>'
    return `<li class="${isDir ? 'dir' : 'file'}"><a href="${entryHref(rel, name, isDir)}">` +
      `<span class="ico" aria-hidden="true">${iconFor(name, isDir)}</span>` +
      `<span class="name">${escapeHtml(name)}${isDir ? '/' : ''}</span>${meta}</a></li>`
  }

  const rows = [
    ...dirs.map((n, i) => row(n, true, dirStats[i])),
    ...files.map((n, i) => row(n, false, fileStats[i])),
  ].join('')

  const up = rel === ''
    ? ''
    : `<li class="dir up"><a href="${hrefOf(path.dirname(abs), true)}"><span class="ico" aria-hidden="true">↩</span><span class="name">..</span><span class="size"></span><time></time></a></li>`

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(layout({
    title: rel === '' ? 'development' : path.basename(abs),
    rel,
    watchPath: rel,
    body: `<h1>${rel === '' ? '~/development' : escapeHtml(path.basename(abs))}</h1>` +
      (rows || up
        ? `<ul class="listing explorer">${up}${rows}</ul>`
        : '<p class="empty">Empty directory.</p>') +
      (withMeta ? '' : '<p class="empty">Large directory — size and date hidden.</p>'),
  }))
}

async function renderRecent (res) {
  const files = await walkMarkdown()
  files.sort((a, b) => b.mtime - a.mtime)
  const top = files.slice(0, 150)
  const rows = top.map(f => {
    const href = '/' + f.rel.split('/').map(encodeURIComponent).join('/')
    const dir = path.posix.dirname(f.rel)
    return `<li class="recent-item">
      <a href="${href}"><span class="name">${escapeHtml(path.posix.basename(f.rel))}</span>
      <span class="path">${dir === '.' ? '' : escapeHtml(dir)}</span></a>
      <time datetime="${new Date(f.mtime).toISOString()}">${ago(f.mtime)}</time>
    </li>`
  }).join('')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(layout({
    title: 'Recent',
    rel: '',
    body: `<h1>Recently edited</h1><ul class="listing recent">${rows || '<p class="empty">No markdown found.</p>'}</ul>`,
  }))
}

async function renderSearch (q, res) {
  const query = (q || '').trim()
  const form = `<h1>Search</h1>
    <form class="bigsearch" action="/_search"><input name="q" type="search" value="${escapeHtml(query)}" placeholder="Search filenames and contents…" autofocus></form>`
  if (!query) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(layout({ title: 'Search', rel: '', body: form }))
  }
  const needle = query.toLowerCase()
  const hits = []
  await walkMarkdown({
    onFile: async (f) => {
      if (hits.length >= 100) return
      const nameHit = f.rel.toLowerCase().includes(needle)
      let snippet = ''
      if (f.size <= MAX_SEARCH_BYTES) {
        let text = ''
        try {
          text = await fsp.readFile(f.abs, 'utf8')
        } catch { /* unreadable */ }
        const idx = text.toLowerCase().indexOf(needle)
        if (idx >= 0) {
          const start = Math.max(0, idx - 60)
          const chunk = text.slice(start, idx + needle.length + 90).replace(/\s+/g, ' ')
          snippet = (start > 0 ? '…' : '') + escapeHtml(chunk) + '…'
          snippet = snippet.replace(
            new RegExp(escapeRegExp(escapeHtml(query)), 'ig'),
            (m) => `<mark>${m}</mark>`,
          )
        } else if (!nameHit) {
          return
        }
      } else if (!nameHit) {
        return
      }
      hits.push({ rel: f.rel, snippet, mtime: f.mtime })
    },
  })
  hits.sort((a, b) => b.mtime - a.mtime)
  const rows = hits.map(h => {
    const href = '/' + h.rel.split('/').map(encodeURIComponent).join('/')
    return `<li class="hit"><a href="${href}">${escapeHtml(h.rel)}</a>${h.snippet ? `<p class="snippet">${h.snippet}</p>` : ''}</li>`
  }).join('')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(layout({
    title: `Search: ${query}`,
    rel: '',
    body: `${form}<p class="count">${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length >= 100 ? ' (capped)' : ''}</p><ul class="listing hits">${rows || '<p class="empty">Nothing found.</p>'}</ul>`,
  }))
}

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ago (ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return new Date(ms).toISOString().slice(0, 10)
}

// ----------------------------------------------------------------- viewers

function rawHref (abs) {
  return hrefOf(abs) + '?raw=1'
}

/** Siblings of the same kind, in listing order — powers prev/next. */
async function siblings (abs, match) {
  try {
    const { files } = await listEntries(path.dirname(abs))
    return files.filter(match)
  } catch {
    return []
  }
}

async function renderImage (abs, st, res) {
  const rel = relOf(abs)
  const name = path.basename(abs)
  const dir = path.dirname(abs)
  const names = await siblings(abs, n => IMAGE_EXT.has(path.extname(n).toLowerCase()))
  const i = names.indexOf(name)
  const at = (k) => (k >= 0 && k < names.length ? hrefOf(path.join(dir, names[k])) + '?view=1' : null)
  const prev = i > 0 ? at(i - 1) : null
  const next = i >= 0 && i < names.length - 1 ? at(i + 1) : null
  const nextRaw = i >= 0 && i < names.length - 1 ? hrefOf(path.join(dir, names[i + 1])) : null

  const plugin = await pluginFor(abs, st)
  const nav = `<nav class="pager">
    ${prev ? `<a class="pg" href="${prev}" rel="prev" id="pg-prev">‹</a>` : '<span class="pg off">‹</span>'}
    <span class="pos">${i >= 0 ? `${i + 1} / ${names.length}` : ''}</span>
    ${next ? `<a class="pg" href="${next}" rel="next" id="pg-next">›</a>` : '<span class="pg off">›</span>'}
  </nav>`

  const body = `<div class="viewhead">
    <h1>${escapeHtml(name)}</h1>
    <p class="meta"><span>${fmtSize(st.size)}</span><span id="dims"></span><span>${ago(st.mtimeMs)}</span>
      <a href="${rawHref(abs)}">Raw</a>
      ${plugin ? `<a class="cta" href="${hrefOf(abs)}?view=${encodeURIComponent(plugin.name)}">▶ ${escapeHtml(plugin.label || plugin.name)}</a>` : ''}
    </p>
  </div>
  ${nav}
  <div class="imgwrap"><img id="img" src="${hrefOf(abs)}" alt="${escapeHtml(name)}"></div>
  <script>
    const img = document.getElementById('img')
    const show = () => { document.getElementById('dims').textContent = img.naturalWidth + '×' + img.naturalHeight }
    img.complete ? show() : img.addEventListener('load', show)
    img.addEventListener('click', () => img.classList.toggle('actual'))
    document.addEventListener('keydown', (e) => {
      const go = e.key === 'ArrowLeft' ? 'pg-prev' : e.key === 'ArrowRight' ? 'pg-next' : null
      if (go) document.getElementById(go)?.click()
    })
  </script>`

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(layout({
    title: name,
    rel,
    wide: true,
    watchPath: rel,
    head: nextRaw ? `<link rel="prefetch" href="${nextRaw}">` : '',
    body,
  }))
}

async function renderDownload (abs, st, res) {
  const rel = relOf(abs)
  const name = path.basename(abs)
  const ext = path.extname(abs).toLowerCase()
  let preview = ''
  if (VIDEO_EXT.has(ext)) preview = `<video controls playsinline src="${hrefOf(abs)}"></video>`
  else if (AUDIO_EXT.has(ext)) preview = `<audio controls src="${hrefOf(abs)}"></audio>`
  else if (ext === '.pdf') preview = `<iframe class="pdf" src="${hrefOf(abs)}"></iframe>`

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(layout({
    title: name,
    rel,
    wide: Boolean(preview),
    watchPath: rel,
    body: `<div class="viewhead">
      <h1>${escapeHtml(name)}</h1>
      <p class="meta"><span>${fmtSize(st.size)}</span><span>${ago(st.mtimeMs)}</span>
        <a class="cta" href="${rawHref(abs)}" download>Download</a></p>
    </div>${preview}`,
  }))
}

/** Serve raw bytes with a validator so repeat views (prev/next) hit the cache. */
function sendFile (abs, st, req, res) {
  const ext = path.extname(abs).toLowerCase()
  const lastMod = st.mtime.toUTCString()
  if (req.headers['if-modified-since'] === lastMod) {
    res.writeHead(304, { 'last-modified': lastMod, 'cache-control': 'no-cache' })
    return res.end()
  }
  const type = MIME[ext] ||
    (ext === '.json' ? 'application/json; charset=utf-8'
      : TEXT_EXT.has(ext) || MD_EXT.has(ext) ? 'text/plain; charset=utf-8'
        : 'application/octet-stream')
  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    'last-modified': lastMod,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  return fs.createReadStream(abs).pipe(res)
}

// ----------------------------------------------------- live reload (polled)

/**
 * One stat, as a change signature the page can compare against.
 *
 * This replaced an SSE stream. A stream cost one of the browser's six
 * connections per origin for the whole life of every page that opened it, so
 * five or six open notes — or, on a phone, a couple of pages held in the
 * back/forward cache — wedged the origin completely: no further request to
 * this server could be made until the browser tore an old page down. A poll
 * holds nothing open, and drops the per-page fs.watchFile watcher too.
 */
async function handleMtime (res, query) {
  // query values arrive already decoded — resolveDecoded, not safeResolve.
  const abs = resolveDecoded('/' + (query.path || ''))
  if (!abs) {
    res.writeHead(400).end()
    return
  }
  let sig = null
  try {
    const st = await fsp.stat(abs)
    sig = `${st.mtimeMs}:${st.size}`
  } catch { /* deleted — reported as null, not an error */ }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ sig }))
}

// ----------------------------------------------------------------- plugins

/**
 * Optional view providers loaded from PLUGINS_DIR. A plugin exports
 *   { name, label?, claims({abs, ext, stat, api}), view({abs, stat, api}), assets? }
 * and only ever runs for `?view=`. Delete the file and the core viewers take
 * over again — nothing else in the server knows what a plugin does.
 */
const PLUGINS_DIR = path.resolve(process.env.PLUGINS_DIR || path.join(__dirname, 'plugins'))
const DISABLED = new Set((process.env.PLUGINS_DISABLE || '').split(',').map(s => s.trim()).filter(Boolean))

const PLUGIN_API = { ROOT, safeResolve, resolveDecoded, relOf, hrefOf, escapeHtml, fmtSize, ago }

function loadPlugins () {
  let names
  try {
    names = fs.readdirSync(PLUGINS_DIR).filter(n => n.endsWith('.js')).sort()
  } catch {
    return []
  }
  const out = []
  for (const file of names) {
    try {
      const p = require(path.join(PLUGINS_DIR, file))
      if (!p || typeof p.name !== 'string' || typeof p.claims !== 'function' || typeof p.view !== 'function') {
        console.warn(`[md-server] plugin ${file}: bad shape, skipped`)
        continue
      }
      if (DISABLED.has(p.name)) continue
      out.push(p)
    } catch (err) {
      console.warn(`[md-server] plugin ${file}: ${err.message}`)
    }
  }
  if (out.length) console.log(`[md-server] plugins: ${out.map(p => p.name).join(', ')}`)
  return out
}

const PLUGINS = loadPlugins()

/** First plugin willing to handle this file, or null. Never throws. */
async function pluginFor (abs, stat) {
  const ext = path.extname(abs).toLowerCase()
  for (const p of PLUGINS) {
    try {
      if (await p.claims({ abs, ext, stat, api: PLUGIN_API })) return p
    } catch (err) {
      console.warn(`[md-server] plugin ${p.name} claims(): ${err.message}`)
    }
  }
  return null
}

// ----------------------------------------------------------------- assets

const ASSET_CACHE = new Map()
const MERMAID_DIR = path.dirname(require.resolve('mermaid/dist/mermaid.esm.min.mjs'))

async function serveAsset (name, res) {
  if (name === 'app.css') {
    return sendCached(res, 'app.css', 'text/css; charset=utf-8', () => Promise.resolve(APP_CSS))
  }
  if (name === 'hljs.css') {
    return sendCached(res, 'hljs.css', 'text/css; charset=utf-8', buildHljsCss)
  }
  // Plugin-owned assets live under /_assets/p/<plugin>/<key>. Checked before
  // the mermaid fallthrough, which would otherwise swallow every .js name.
  if (name.startsWith('p/')) {
    const [, pname, ...rest] = name.split('/')
    const p = PLUGINS.find(x => x.name === pname)
    const asset = p && p.assets && p.assets[rest.join('/')]
    if (!asset) return notFound(res)
    res.writeHead(200, {
      'content-type': asset.type || 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
    })
    return res.end(asset.body)
  }
  // Everything else comes out of mermaid's dist dir: the entry bundle plus the
  // chunks/… modules it lazily imports relative to itself.
  if (!name.endsWith('.mjs') && !name.endsWith('.js')) return notFound(res)
  const file = path.resolve(MERMAID_DIR, name)
  if (!file.startsWith(MERMAID_DIR + path.sep)) return notFound(res)
  try {
    const buf = await fsp.readFile(file)
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    })
    return res.end(buf)
  } catch {
    return notFound(res)
  }
}

async function sendCached (res, key, type, produce) {
  let body = ASSET_CACHE.get(key)
  if (body === undefined) {
    body = await produce()
    ASSET_CACHE.set(key, body)
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' })
  res.end(body)
}

/** Wrap highlight.js's light and dark themes in prefers-color-scheme queries. */
async function buildHljsCss () {
  const dir = path.dirname(require.resolve('highlight.js/package.json'))
  const light = await fsp.readFile(path.join(dir, 'styles/github.css'), 'utf8')
  const dark = await fsp.readFile(path.join(dir, 'styles/github-dark.css'), 'utf8')
  return `@media (prefers-color-scheme: light) {\n${light}\n}\n@media (prefers-color-scheme: dark) {\n${dark}\n}\n`
}

const APP_CSS = `
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0;
  --accent: #0969da; --code-bg: #f6f8fa; --topbar: #f6f8facc; --mark: #fff8c5;
  --radius: 8px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d;
    --accent: #4493f8; --code-bg: #151b23; --topbar: #0d1117cc; --mark: #4a3f00;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  overflow-wrap: anywhere;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center;
  justify-content: space-between;
  padding: .6rem max(.9rem, env(safe-area-inset-left)) .6rem max(.9rem, env(safe-area-inset-right));
  background: var(--topbar); backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
  font-size: .875rem;
}
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem; min-width: 0; }
.crumbs .sep { color: var(--muted); }
.crumbs span:not(.sep) { color: var(--muted); }
.actions { display: flex; align-items: center; gap: .75rem; }
.search input, .bigsearch input {
  font: inherit; color: var(--fg); background: var(--code-bg);
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: .35rem .6rem; width: 9rem; max-width: 40vw;
}
.bigsearch input { width: 100%; max-width: 100%; padding: .6rem .8rem; font-size: 1rem; margin: .5rem 0 1.5rem; }

main.doc {
  max-width: 46rem; margin: 0 auto;
  padding: 1.5rem max(1rem, env(safe-area-inset-left)) 6rem max(1rem, env(safe-area-inset-right));
}
main.wide {
  max-width: none; margin: 0;
  padding: 1rem max(.75rem, env(safe-area-inset-left)) 4rem max(.75rem, env(safe-area-inset-right));
}

/* ---- explorer ---- */
ul.explorer { list-style: none; padding: 0; margin: 1rem 0 0; }
ul.explorer li { border-bottom: 1px solid var(--line); }
ul.explorer a {
  display: grid; grid-template-columns: 1.6rem 1fr auto auto; gap: .6rem;
  align-items: baseline; padding: .7rem .25rem; color: var(--fg); text-decoration: none;
}
ul.explorer a:hover { background: var(--code-bg); }
ul.explorer .ico { font-size: .95rem; line-height: 1; }
ul.explorer .name { overflow-wrap: anywhere; }
ul.explorer .dir .name { font-weight: 600; }
ul.explorer .size, ul.explorer time {
  color: var(--muted); font-size: .8rem; font-variant-numeric: tabular-nums; white-space: nowrap;
}
ul.explorer .size { min-width: 4.5rem; text-align: right; }
ul.explorer time { min-width: 5rem; text-align: right; }
@media (max-width: 30rem) {
  ul.explorer a { grid-template-columns: 1.4rem 1fr auto; }
  ul.explorer .size { display: none; }
}

/* ---- viewers ---- */
.viewhead h1 { border: 0; margin: 0 0 .25rem; font-size: 1.2rem; }
.viewhead .meta { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; color: var(--muted); font-size: .85rem; margin: 0 0 .75rem; }
.viewhead .cta {
  padding: .25rem .7rem; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--code-bg); color: var(--accent);
}
.pager { display: flex; align-items: center; justify-content: center; gap: 1.5rem; margin: .25rem 0 .75rem; }
.pager .pg { font-size: 1.6rem; line-height: 1; padding: .1rem .9rem; border: 1px solid var(--line); border-radius: var(--radius); }
.pager .pg.off { opacity: .3; }
.pager .pos { color: var(--muted); font-size: .85rem; font-variant-numeric: tabular-nums; }
.imgwrap { text-align: center; overflow: auto; }
.imgwrap img {
  max-width: 100%; height: auto; cursor: zoom-in;
  background: repeating-conic-gradient(var(--code-bg) 0 25%, transparent 0 50%) 0 0 / 20px 20px;
}
.imgwrap img.actual { max-width: none; width: auto; cursor: zoom-out; }
video, audio { width: 100%; max-width: 60rem; display: block; margin: 0 auto; }
iframe.pdf { width: 100%; height: 80vh; border: 1px solid var(--line); border-radius: var(--radius); }
h1, h2, h3, h4 { line-height: 1.25; margin: 2rem 0 .75rem; font-weight: 600; }
h1 { font-size: 1.9rem; margin-top: .5rem; padding-bottom: .35rem; border-bottom: 1px solid var(--line); }
h2 { font-size: 1.4rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.15rem; }
h1 a, h2 a, h3 a, h4 a, h5 a, h6 a { color: inherit; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1rem; }
blockquote { border-left: 3px solid var(--line); padding: .1rem 0 .1rem 1rem; margin-left: 0; color: var(--muted); }
code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: .875em; }
:not(pre) > code { background: var(--code-bg); padding: .15em .4em; border-radius: 6px; }
pre {
  background: var(--code-bg); border: 1px solid var(--line); border-radius: var(--radius);
  padding: .85rem 1rem; overflow-x: auto; font-size: .875rem; line-height: 1.5;
}
pre code { background: none; padding: 0; }
pre.filecode { font-size: .8125rem; }
pre.mermaid { border: none; background: none; text-align: center; padding: 0; overflow-x: auto; }
pre.mermaid svg { max-width: 100%; height: auto; }
img, video { max-width: 100%; height: auto; border-radius: var(--radius); }
hr { border: none; border-top: 1px solid var(--line); margin: 2rem 0; }

table { border-collapse: collapse; display: block; overflow-x: auto; width: max-content; max-width: 100%; }
th, td { border: 1px solid var(--line); padding: .4rem .7rem; text-align: left; }
th { background: var(--code-bg); }
tbody tr:nth-child(2n) { background: color-mix(in srgb, var(--code-bg) 55%, transparent); }

ul.listing { list-style: none; padding: 0; }
ul.listing li { border-bottom: 1px solid var(--line); }
ul.listing li a { display: block; padding: .7rem .25rem; }
ul.listing.muted a { color: var(--muted); }
ul.listing li.dir a::before { content: "📁 "; }
ul.listing li.file a::before { content: "📄 "; }
.muted-head { color: var(--muted); font-size: 1.05rem; }
.empty { color: var(--muted); }
.count { color: var(--muted); font-size: .875rem; }

.recent-item { display: flex; align-items: baseline; gap: 1rem; }
.recent-item a { flex: 1; min-width: 0; }
.recent-item .name { font-weight: 500; }
.recent-item .path { display: block; color: var(--muted); font-size: .8125rem; }
.recent-item time { color: var(--muted); font-size: .8125rem; white-space: nowrap; }
.hit a { padding-bottom: .2rem; }
.snippet { color: var(--muted); font-size: .875rem; margin: 0 0 .7rem; }
mark { background: var(--mark); color: inherit; border-radius: 3px; }

.contains-task-list { list-style: none; padding-left: .25rem; }
.task-list-item-checkbox { margin-right: .5rem; }

#reload-toast {
  position: fixed; bottom: 1rem; left: 50%; transform: translate(-50%, 200%);
  background: var(--fg); color: var(--bg); padding: .5rem 1rem; border-radius: 999px;
  font-size: .8125rem; transition: transform .2s ease;
}
#reload-toast.show { transform: translate(-50%, 0); }
`

// ------------------------------------------------------------------ server

function notFound (res) {
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
  res.end(layout({ title: 'Not found', rel: '', body: '<h1>404</h1><p class="empty">No such file under ~/development.</p>' }))
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true)
  const pathname = parsed.pathname

  try {
    if (pathname === '/_healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('ok\n')
    }
    if (pathname === '/_mtime') return await handleMtime(res, parsed.query)
    if (pathname === '/_recent') return await renderRecent(res)
    if (pathname === '/_search') return await renderSearch(parsed.query.q, res)
    if (pathname.startsWith('/_assets/')) {
      return await serveAsset(pathname.slice('/_assets/'.length), res)
    }

    const abs = safeResolve(pathname)
    if (!abs) return notFound(res)

    let st
    try {
      st = await fsp.stat(abs)
    } catch {
      return notFound(res)
    }

    // A directory is always the explorer now — no auto-opening its README.
    if (st.isDirectory()) return await renderDir(abs, res)

    const ext = path.extname(abs).toLowerCase()

    // ?raw=1 always means bytes, whatever the type. It is how the sprite
    // plugin reads its atlas JSON, which would otherwise render as HTML.
    if (parsed.query.raw) return sendFile(abs, st, req, res)

    const view = parsed.query.view
    if (view) {
      // ?view=<plugin> targets one plugin; ?view=1 asks whoever will take it.
      const p = view === '1' || view === 'true'
        ? await pluginFor(abs, st)
        : PLUGINS.find(x => x.name === view)
      if (p) {
        try {
          if (await p.claims({ abs, ext, stat: st, api: PLUGIN_API })) {
            const out = await p.view({ abs, stat: st, api: PLUGIN_API })
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            return res.end(layout({
              title: out.title || path.basename(abs),
              rel: relOf(abs),
              wide: out.wide !== false,
              watchPath: relOf(abs),
              head: out.head || '',
              body: out.body,
            }))
          }
        } catch (err) {
          // A broken plugin must not take the file down with it.
          console.warn(`[md-server] plugin ${p.name} view(): ${err.message}`)
        }
      }
      if (IMAGE_EXT.has(ext)) return await renderImage(abs, st, res)
      if (MD_EXT.has(ext)) return await renderMarkdown(abs, res)
      if (TEXT_EXT.has(ext) || ext === '') {
        if (st.size > 2 * 1024 * 1024) return await renderDownload(abs, st, res)
        return await renderText(abs, res)
      }
      return await renderDownload(abs, st, res)
    }

    if (MD_EXT.has(ext)) return await renderMarkdown(abs, res)
    if (MIME[ext]) return sendFile(abs, st, req, res)
    if (TEXT_EXT.has(ext) || ext === '') {
      if (st.size > 2 * 1024 * 1024) return await renderDownload(abs, st, res)
      return await renderText(abs, res)
    }
    return sendFile(abs, st, req, res)
  } catch (err) {
    console.error('[md-server]', pathname, err)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('Internal error\n')
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[md-server] serving ${ROOT} on http://${HOST}:${PORT}`)
})
