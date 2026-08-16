'use strict'

/**
 * Sprite atlas viewer.
 *
 * Claims a TexturePacker-style atlas — either the .json itself or a .png that
 * has one beside it — and plays the frames back on a canvas. All atlas parsing
 * happens in the browser; the server only decides whether the pair exists.
 *
 * Delete this file and .png files fall back to the normal image viewer.
 */

const fs = require('fs/promises')
const path = require('path')

const MAX_ATLAS_BYTES = 4 * 1024 * 1024
const IMG_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg'])

/** Read a JSON atlas, or null if it is not one. Never throws. */
async function readAtlas (abs) {
  let st
  try {
    st = await fs.stat(abs)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > MAX_ATLAS_BYTES) return null
  let data
  try {
    data = JSON.parse(await fs.readFile(abs, 'utf8'))
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const frames = data.frames
  const ok = Array.isArray(frames) ? frames.length > 0 : frames && typeof frames === 'object' && Object.keys(frames).length > 0
  return ok ? data : null
}

/**
 * Given an atlas path, find its sheet: meta.image if present, else the
 * same basename with an image extension. meta.image comes from a file we do
 * not control, so it is reduced to a bare filename before use.
 */
async function sheetFor (atlasAbs, atlas, api) {
  const dir = path.dirname(atlasAbs)
  const candidates = []
  if (atlas.meta && typeof atlas.meta.image === 'string') {
    candidates.push(path.basename(atlas.meta.image))
  }
  const stem = path.basename(atlasAbs, path.extname(atlasAbs))
  for (const ext of IMG_EXT) candidates.push(stem + ext)

  for (const name of candidates) {
    const abs = path.join(dir, name)
    // Belt and braces: the join above cannot escape after basename(), but the
    // resolver is the one place that decides what is inside ROOT.
    if (!api.resolveDecoded(api.relOf(abs))) continue
    try {
      if ((await fs.stat(abs)).isFile()) return abs
    } catch { /* next candidate */ }
  }
  return null
}

/** For a .png, the atlas sitting next to it. */
async function atlasFor (imgAbs) {
  const guess = path.join(path.dirname(imgAbs), path.basename(imgAbs, path.extname(imgAbs)) + '.json')
  const atlas = await readAtlas(guess)
  return atlas ? { atlasAbs: guess, atlas } : null
}

/** Resolve either entry point to the {atlas, sheet} pair, or null. */
async function pairFor (abs, ext, api) {
  if (ext === '.json') {
    const atlas = await readAtlas(abs)
    if (!atlas) return null
    const sheetAbs = await sheetFor(abs, atlas, api)
    return sheetAbs ? { atlasAbs: abs, sheetAbs } : null
  }
  if (IMG_EXT.has(ext)) {
    const found = await atlasFor(abs)
    if (!found) return null
    const sheetAbs = await sheetFor(found.atlasAbs, found.atlas, api)
    // Only claim if the atlas really points back at this image.
    return sheetAbs === abs ? { atlasAbs: found.atlasAbs, sheetAbs: abs } : null
  }
  return null
}

const CLIENT = String.raw`
(() => {
  const el = (id) => document.getElementById(id)
  const cv = el('sp-canvas'), ctx = cv.getContext('2d')
  const state = { anims: new Map(), name: null, i: 0, fps: 8, zoom: 4, playing: true, last: 0 }

  // "idle-east-0", "walk_01.png", "frame0001" -> group name + index
  const split = (key) => {
    const m = key.match(/^(.*?)[-_ ]?(\d+)(\.\w+)?$/)
    return m && m[1] ? { group: m[1], idx: Number(m[2]) } : null
  }

  function build (atlas) {
    const raw = Array.isArray(atlas.frames)
      ? atlas.frames.map(f => [f.filename, f])
      : Object.entries(atlas.frames)
    const groups = new Map()
    for (const [key, f] of raw) {
      const s = split(key)
      const g = s ? s.group : 'all'
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push({ key, idx: s ? s.idx : groups.get(g).length, rect: f.frame })
    }
    // No usable grouping — one animation of everything, in atlas order.
    if (groups.size === 1 && groups.has('all')) {
      groups.set('all', raw.map(([key, f], i) => ({ key, idx: i, rect: f.frame })))
    }
    for (const list of groups.values()) list.sort((a, b) => a.idx - b.idx)
    return groups
  }

  function draw () {
    const frames = state.anims.get(state.name)
    if (!frames || !frames.length) return
    const f = frames[state.i % frames.length]
    const z = state.zoom
    // Assigning width/height reallocates the backing store and resets the
    // context state, so only touch them when the size actually changed.
    const w = f.rect.w * z, h = f.rect.h * z
    if (cv.width !== w || cv.height !== h) {
      cv.width = w
      cv.height = h
      ctx.imageSmoothingEnabled = false
    }
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(SHEET, f.rect.x, f.rect.y, f.rect.w, f.rect.h, 0, 0, w, h)
    el('sp-frame').textContent = (state.i % frames.length) + 1 + ' / ' + frames.length + '  ' + f.key
  }

  // The loop runs only while this page is the one on screen. Left unbounded it
  // keeps animating from the back/forward cache, so opening a second sprite
  // means two sheets being drawn at once on a device with one GPU to spare.
  let raf = 0
  function tick (t) {
    raf = requestAnimationFrame(tick)
    if (!state.playing) return
    if (t - state.last < 1000 / state.fps) return
    state.last = t
    state.i++
    draw()
  }
  function run () { if (!raf) raf = requestAnimationFrame(tick) }
  function halt () { if (raf) { cancelAnimationFrame(raf); raf = 0 } }
  document.addEventListener('visibilitychange', () => document.hidden ? halt() : run())
  addEventListener('pagehide', halt)

  function select (name) {
    state.name = name
    state.i = 0
    for (const b of document.querySelectorAll('.sp-anim')) b.classList.toggle('on', b.dataset.name === name)
    draw()
  }

  function grid () {
    const wrap = el('sp-grid')
    const frag = document.createDocumentFragment()
    for (const [name, frames] of state.anims) {
      const h = document.createElement('h3')
      h.textContent = name + ' (' + frames.length + ')'
      frag.appendChild(h)
      const row = document.createElement('div')
      row.className = 'sp-row'
      for (const f of frames) {
        const c = document.createElement('canvas')
        c.width = f.rect.w * 2
        c.height = f.rect.h * 2
        const g = c.getContext('2d')
        g.imageSmoothingEnabled = false
        g.drawImage(SHEET, f.rect.x, f.rect.y, f.rect.w, f.rect.h, 0, 0, c.width, c.height)
        c.title = f.key
        row.appendChild(c)
      }
      frag.appendChild(row)
    }
    wrap.appendChild(frag)
  }

  let SHEET
  async function boot () {
    const [atlas, img] = await Promise.all([
      fetch(ATLAS_URL).then(r => r.json()),
      new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = SHEET_URL }),
    ])
    SHEET = img
    state.anims = build(atlas)
    const bar = el('sp-anims')
    for (const name of state.anims.keys()) {
      const b = document.createElement('button')
      b.className = 'sp-anim'
      b.dataset.name = name
      b.textContent = name
      b.onclick = () => select(name)
      bar.appendChild(b)
    }
    select(state.anims.keys().next().value)
    grid()
    run()
  }

  el('sp-fps').oninput = (e) => { state.fps = Number(e.target.value); el('sp-fps-v').textContent = state.fps }
  el('sp-zoom').oninput = (e) => { state.zoom = Number(e.target.value); el('sp-zoom-v').textContent = state.zoom + 'x'; draw() }
  el('sp-play').onclick = (e) => { state.playing = !state.playing; e.target.textContent = state.playing ? '⏸' : '▶' }
  el('sp-step').onclick = () => { state.playing = false; el('sp-play').textContent = '▶'; state.i++; draw() }
  el('sp-back').onclick = () => { state.playing = false; el('sp-play').textContent = '▶'; state.i = Math.max(0, state.i - 1); draw() }

  boot().catch(err => { el('sp-frame').textContent = 'Failed to load atlas: ' + err.message })
})()
`

const CSS = `
.sp-bar { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .5rem 0; }
.sp-anim { padding: .3rem .7rem; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--bg); color: var(--fg); font: inherit; font-size: .85rem; cursor: pointer; }
.sp-anim.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.sp-ctl { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin: .5rem 0 1rem;
  color: var(--muted); font-size: .85rem; }
.sp-ctl button { padding: .25rem .75rem; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--code-bg); color: var(--fg); font: inherit; cursor: pointer; }
.sp-ctl label { display: flex; gap: .4rem; align-items: center; }
.sp-ctl input[type=range] { width: 7rem; }
.sp-stage { display: flex; justify-content: center; padding: 1rem 0;
  background: repeating-conic-gradient(var(--code-bg) 0 25%, transparent 0 50%) 0 0 / 20px 20px;
  border: 1px solid var(--line); border-radius: var(--radius); }
#sp-canvas { image-rendering: pixelated; }
#sp-frame { text-align: center; color: var(--muted); font-size: .8rem; margin: .5rem 0 1.5rem;
  font-variant-numeric: tabular-nums; }
.sp-row { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: 1rem; }
.sp-row canvas { image-rendering: pixelated; border: 1px solid var(--line); border-radius: 4px; }
`

module.exports = {
  name: 'sprite',
  label: 'Animate',

  async claims ({ abs, ext, api }) {
    return Boolean(await pairFor(abs, ext, api))
  },

  async view ({ abs, api }) {
    const ext = path.extname(abs).toLowerCase()
    const pair = await pairFor(abs, ext, api)
    if (!pair) throw new Error('not an atlas')
    const { atlasAbs, sheetAbs } = pair
    const atlasUrl = api.hrefOf(atlasAbs) + '?raw=1'
    const sheetUrl = api.hrefOf(sheetAbs) + '?raw=1'

    return {
      title: path.basename(sheetAbs),
      head: `<style>${CSS}</style>`,
      body: `<div class="viewhead">
  <h1>${api.escapeHtml(path.basename(sheetAbs))}</h1>
  <p class="meta">
    <span>sprite atlas</span>
    <a href="${api.hrefOf(sheetAbs)}?view=1">Sheet</a>
    <a href="${api.hrefOf(atlasAbs)}">Atlas JSON</a>
  </p>
</div>
<div class="sp-bar" id="sp-anims"></div>
<div class="sp-ctl">
  <button id="sp-play">⏸</button>
  <button id="sp-back">◀</button>
  <button id="sp-step">▶|</button>
  <label>fps <input id="sp-fps" type="range" min="1" max="30" value="8"><span id="sp-fps-v">8</span></label>
  <label>zoom <input id="sp-zoom" type="range" min="1" max="8" value="4"><span id="sp-zoom-v">4x</span></label>
</div>
<div class="sp-stage"><canvas id="sp-canvas"></canvas></div>
<p id="sp-frame"></p>
<h2>All frames</h2>
<div id="sp-grid"></div>
<script>
  const ATLAS_URL = ${JSON.stringify(atlasUrl)}
  const SHEET_URL = ${JSON.stringify(sheetUrl)}
</script>
<script src="/_assets/p/sprite/sprite.js"></script>`,
    }
  },

  assets: {
    'sprite.js': { type: 'text/javascript; charset=utf-8', body: CLIENT },
  },
}
