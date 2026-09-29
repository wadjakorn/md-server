'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert')
const { makeFixture, startServer } = require('./helpers')

let srv
before(async () => { srv = await startServer(await makeFixture()) })
after(async () => { await srv.close() })

/** The one line of the live-reload client that carries the path. */
const watchLine = async (p) => {
  const html = await (await fetch(srv.base + p)).text()
  const i = html.indexOf('const watch')
  assert.notEqual(i, -1, 'page should carry the live-reload client')
  return html.slice(i, html.indexOf('\n', i))
}

test('a path containing </script> cannot break out of the reload script', async () => {
  const line = await watchLine('/a%3C/script%3E%3Cimg%20src=x%20onerror=alert(1)%3Ex.md')
  assert.ok(!line.includes('</script>'), 'the literal closer must not survive')
  assert.ok(line.includes('\\u003c'), 'it should be escaped, not stripped')
})

test('the same escaping applies on a directory listing', async () => {
  const line = await watchLine('/a%3C/')
  assert.ok(!line.includes('</script>'))
})

test('a code block gets the copy button script; a mermaid-only page does not', async () => {
  const code = await (await fetch(srv.base + '/code.md')).text()
  assert.ok(code.includes('copy-btn'), 'a fenced code block should be copyable')
  const diagram = await (await fetch(srv.base + '/sub/ok.md')).text()
  assert.ok(!diagram.includes('copy-btn'), 'a diagram is not code to copy')
})

test('svg is sandboxed and never sniffed', async () => {
  const r = await fetch(srv.base + '/logo.svg')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.match(r.headers.get('content-security-policy') || '', /sandbox/)
})

test('a markdown file over the render cap becomes a download page', async () => {
  const html = await (await fetch(srv.base + '/big.md')).text()
  assert.ok(html.includes('Download'), 'should offer the bytes instead')
  assert.ok(html.length < 1024 * 1024, 'the 3 MB body must not have been rendered')
})

test('range requests are answered with 206', async () => {
  const r = await fetch(srv.base + '/logo.svg', { headers: { Range: 'bytes=0-9' } })
  assert.equal(r.status, 206)
  assert.match(r.headers.get('content-range'), /^bytes 0-9\/\d+$/)
  assert.equal((await r.arrayBuffer()).byteLength, 10)
})

test('an unsatisfiable range is a 416, not a truncated 200', async () => {
  const r = await fetch(srv.base + '/logo.svg', { headers: { Range: 'bytes=999999-' } })
  assert.equal(r.status, 416)
})

test('a suffix range returns the tail', async () => {
  const full = await (await fetch(srv.base + '/logo.svg')).arrayBuffer()
  const r = await fetch(srv.base + '/logo.svg', { headers: { Range: 'bytes=-5' } })
  assert.equal(r.status, 206)
  assert.equal((await r.arrayBuffer()).byteLength, 5)
  assert.ok(full.byteLength > 5)
})

test('a whole-file request is still a plain 200', async () => {
  const r = await fetch(srv.base + '/logo.svg')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('accept-ranges'), 'bytes')
})

test('mermaid runs strict', async () => {
  const html = await (await fetch(srv.base + '/sub/ok.md')).text()
  assert.ok(html.includes('mermaid.initialize'), 'fixture should render a mermaid diagram')
  assert.ok(!html.includes("securityLevel: 'loose'"))
  assert.ok(html.includes("securityLevel: 'strict'"))
})
