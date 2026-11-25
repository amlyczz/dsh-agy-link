// /media, /assets and /mermaid.min.js: static-ish file serving guards.
//
// Pins the image-only media guard, traversal/symlink/directory rejection under
// the asset dir, and the mermaid bundle fallbacks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeReq, invoke, setup } from './http-contract-helpers.ts'

test('/media rejects a missing path, missing files, non-images and directories', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-media-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = join(root, 'note.txt')
  const image = join(root, 'ok.png')
  const dir = join(root, 'sub')
  writeFileSync(text, 'plain text')
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  mkdirSync(dir, { recursive: true })

  const s = setup()
  const route = s.route('/plugins/agy-link/media')

  const missingParam = await invoke(route, fakeReq('GET', '/'))
  assert.equal(missingParam.status(), 400)
  assert.equal(missingParam.text(), 'missing path query parameter')

  const missingFile = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(join(root, 'nope.png'))))
  assert.equal(missingFile.status(), 404)
  assert.equal(missingFile.text(), 'file not found')

  const nonImage = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(text)))
  assert.equal(nonImage.status(), 403)
  assert.equal(nonImage.text(), 'access denied: not an image')

  const notAFile = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(dir)))
  assert.equal(notAFile.status(), 403)
  assert.equal(notAFile.text(), 'not a regular file')

  // `path=` empty behaves like a missing parameter.
  const emptyParam = await invoke(route, fakeReq('GET', '/?path='))
  assert.equal(emptyParam.status(), 400)

  // A relative path is resolved against workspaceRoot when provided.
  const workspace = setup({}, { workspaceRoot: root })
  const relative = await invoke(workspace.route('/plugins/agy-link/media'), fakeReq('GET', '/?path=note.txt'))
  assert.equal(relative.status(), 403, 'relative path resolves under the workspace root')
  assert.equal(relative.text(), 'access denied: not an image')
})

test('/assets rejects traversal, missing assets and directories; serves mermaid only when present', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-assets-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const assets = join(root, 'assets')
  mkdirSync(assets, { recursive: true })
  mkdirSync(join(assets, 'nested'), { recursive: true })
  writeFileSync(join(assets, 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'secret.txt'), 'secret')
  let symlinked = true
  try {
    symlinkSync(join(root, 'secret.txt'), join(assets, 'escape.txt'))
  } catch {
    // Windows without Developer Mode refuses symlink creation (EPERM). The escape
    // case below cannot be exercised there; the remaining assertions still run.
    symlinked = false
  }

  const s = setup({ hostDir: root })
  const assetRoute = s.route('/plugins/agy-link/assets')

  const missing = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/none.js'))
  assert.equal(missing.status(), 404)
  assert.equal(missing.text(), 'asset not found')

  const traversal = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/%2e%2e%2fsecret.txt'))
  assert.equal(traversal.status(), 404, 'encoded traversal resolves to a literal name and is not served')
  assert.equal(traversal.text(), 'asset not found')

  if (symlinked) {
    const escaped = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/escape.txt'))
    assert.equal(escaped.status(), 403, 'symlink escape is forbidden')
    assert.equal(escaped.text(), 'forbidden')
  } else {
    t.diagnostic('symlink creation unavailable on this host: escape assertion skipped')
  }

  const directory = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/nested'))
  assert.equal(directory.status(), 403)
  assert.equal(directory.text(), 'not a file')

  const mermaidMissing = await invoke(s.route('/plugins/agy-link/mermaid.min.js'), fakeReq('GET'))
  assert.equal(mermaidMissing.status(), 404)
  assert.equal(mermaidMissing.text(), 'mermaid.min.js not found')

  writeFileSync(join(root, 'mermaid.min.js'), 'console.log("mermaid")')
  const mermaid = await invoke(s.route('/plugins/agy-link/mermaid.min.js'), fakeReq('GET'))
  assert.equal(mermaid.status(), 200)
  assert.equal(mermaid.headers()['content-type'], 'application/javascript; charset=utf-8')
  assert.equal(mermaid.text(), 'console.log("mermaid")')
})

test('/assets 404s when the asset dir cannot be resolved', async () => {
  const s = setup({ hostDir: '/nonexistent-agy-host-dir' })
  const captured = await invoke(s.route('/plugins/agy-link/assets'), fakeReq('GET', '/plugins/agy-link/assets/a.js'))
  assert.equal(captured.status(), 404)
  assert.equal(captured.text(), 'asset not found')
})

test('/mermaid.min.js maps an unreadable file to 500', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-mermaid-err-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A directory named mermaid.min.js exists but readFileSync throws EISDIR.
  mkdirSync(join(root, 'mermaid.min.js'))
  const s = setup({ hostDir: root })
  const captured = await invoke(s.route('/plugins/agy-link/mermaid.min.js'), fakeReq('GET'))
  assert.equal(captured.status(), 500)
  assert.match(captured.text(), /^read error: /)
})
