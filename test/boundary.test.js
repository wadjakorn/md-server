'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert')
const { makeFixture, startServer } = require('./helpers')

let srv
before(async () => { srv = await startServer(await makeFixture()) })
after(async () => { await srv.close() })

const status = async (p) => (await fetch(srv.base + p, { redirect: 'manual' })).status

// --- must be refused ------------------------------------------------------

test('a dotfile is refused, not merely hidden from the listing', async () => {
  assert.equal(await status('/proj/.env'), 404)
  assert.equal(await status('/proj/.env?raw=1'), 404)
})

test('.git internals are refused', async () => {
  assert.equal(await status('/proj/.git/config?raw=1'), 404)
})

test('.claude is refused — it holds credentials', async () => {
  assert.equal(await status('/.claude/settings.json?raw=1'), 404)
})

test('a symlink pointing outside the root is refused', async () => {
  assert.equal(await status('/escape.txt?raw=1'), 404)
  assert.equal(await status('/escapedir/secret.txt?raw=1'), 404)
})

test('traversal above the root is refused', async () => {
  assert.equal(await status('/%2e%2e/outside/secret.txt?raw=1'), 404)
  assert.equal(await status('/sub/%2e%2e/%2e%2e/outside/secret.txt?raw=1'), 404)
})

test('/_mtime inherits the same refusals', async () => {
  assert.equal(await status('/_mtime?path=proj/.env'), 400)
  assert.equal(await status('/_mtime?path=escape.txt'), 400)
})

test('a refused path is indistinguishable from a missing one', async () => {
  const denied = await fetch(srv.base + '/proj/.env')
  const missing = await fetch(srv.base + '/proj/nope.md')
  assert.equal(denied.status, missing.status)
})

// --- must keep working ----------------------------------------------------
// These guard the regression the first draft of the audit would have shipped:
// treating SKIP_DIRS as an access rule.

test('a real file under a SKIP_DIRS name is still served', async () => {
  assert.equal(await status('/dist/notes.md'), 200)
  assert.equal(await status('/dist/notes.md?raw=1'), 200)
  assert.equal(await status('/_mtime?path=dist/notes.md'), 200)
})

test('ordinary paths and the root listing still work', async () => {
  assert.equal(await status('/'), 200)
  assert.equal(await status('/sub/ok.md'), 200)
  assert.equal(await status('/_recent'), 200)
  assert.equal(await status('/_search?q=ok'), 200)
})

test('dotfiles are absent from the listing as well as refused', async () => {
  const html = await (await fetch(srv.base + '/')).text()
  assert.ok(!html.includes('.claude'), 'listing must not link a dotfile')
})
