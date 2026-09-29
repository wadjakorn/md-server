'use strict'

const { spawn } = require('child_process')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')

/**
 * A fixture tree covering every case the boundary must decide. The returned
 * path is the DOCS_ROOT to serve; a sibling `outside/` is what the symlinks
 * escape to.
 */
async function makeFixture () {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdsrv-'))
  const docs = path.join(base, 'docs')
  const mk = (p) => fsp.mkdir(path.join(docs, p), { recursive: true })
  await Promise.all([
    mk('proj/.git'), mk('.claude'), mk('dist'), mk('sub'), mk('a<'),
    fsp.mkdir(path.join(base, 'outside'), { recursive: true }),
  ])
  const w = (p, s) => fsp.writeFile(path.join(docs, p), s)
  await Promise.all([
    w('proj/.env', 'SECRET=leaked\n'),
    w('proj/.git/config', '[core]\n'),
    w('.claude/settings.json', '{"key":"leaked"}\n'),
    w('dist/notes.md', '# under dist\n'),
    w('code.md', '# code\n\n```js\nconst a = 1\n```\n'),
    w('sub/ok.md', '# ok\n\n```mermaid\ngraph TD; A-->B;\n```\n'),
    // A filename cannot contain '/', but a path can — the separator supplies
    // the one that closes an inline <script>. Hence a directory named 'a<'.
    w('a</script><img src=x onerror=alert(1)>x.md', '# breakout\n'),
    w('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    w('big.md', '#'.repeat(3 * 1024 * 1024)),
    fsp.writeFile(path.join(base, 'outside', 'secret.txt'), 'HOSTSECRET\n'),
  ])
  await fsp.symlink(path.join(base, 'outside', 'secret.txt'), path.join(docs, 'escape.txt'))
  await fsp.symlink(path.join(base, 'outside'), path.join(docs, 'escapedir'))
  return docs
}

/** Start the real server on an ephemeral port and wait for it to answer. */
async function startServer (docsRoot) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DOCS_ROOT: docsRoot, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // PORT=0 lets the OS pick, so parallel runs cannot collide; the server
  // prints the address it settled on.
  const base = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10000)
    child.stdout.on('data', (d) => {
      out += d
      const m = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out)
      if (m) { clearTimeout(timer); resolve(m[1]) }
    })
    child.stderr.on('data', (d) => { out += d })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${out}`)) })
  })
  return {
    base,
    close: () => new Promise((resolve) => {
      child.once('exit', resolve)
      child.kill()
    }),
  }
}

module.exports = { makeFixture, startServer }
