import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalMediaPath, handleMediaRequest, handleAssetRequest } from '../src/host/media-route.ts';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('media-route: resolveLocalMediaPath handles Windows paths, file://, and relative paths', () => {
  const isWin = process.platform === 'win32';
  const tempDir = join(tmpdir(), 'agy-media-test-' + Date.now());
  mkdirSync(tempDir, { recursive: true });
  const sampleFile = join(tempDir, 'test-image.png');
  writeFileSync(sampleFile, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic

  try {
    // 1. Direct path
    const resolvedDirect = resolveLocalMediaPath(sampleFile);
    assert.ok(resolvedDirect !== null, 'direct path should resolve');
    assert.ok(existsSync(resolvedDirect));

    // 2. file:/// URL
    const fileUrl = 'file:///' + (isWin ? sampleFile.replace(/\\/g, '/') : sampleFile);
    const resolvedUrl = resolveLocalMediaPath(fileUrl);
    assert.ok(resolvedUrl !== null, 'file:/// URL should resolve');
    assert.equal(resolvedUrl, resolvedDirect);

    // 3. Relative path with workspaceRoot
    const resolvedRel = resolveLocalMediaPath('test-image.png', tempDir);
    assert.ok(resolvedRel !== null, 'relative path should resolve against workspaceRoot');

    // 4. Non-existent path returns null
    assert.equal(resolveLocalMediaPath('non-existent-image-12345.png'), null);
    assert.equal(resolveLocalMediaPath(''), null);
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('media-route: malformed percent-encoding in a file:// path is rejected, not thrown', () => {
  // A double-encoded query (?path=file%3A%2F%2F%2F%25E0...) decodes to the
  // literal string 'file:///%E0%A4%A', whose inner decodeURIComponent throws a
  // URIError. The route must reject it (404), never propagate an exception.
  const bad = 'file:///%E0%A4%A';
  assert.equal(resolveLocalMediaPath(bad), null, 'malformed escape resolves to null');
  let status = 0;
  const res = { writeHead(s: number) { status = s; }, end() {} };
  const url = '/plugins/agy-link/media?path=' + encodeURIComponent(bad);
  assert.doesNotThrow(() => handleMediaRequest({ url }, res as never));
  assert.equal(status, 404);
});

test('media-route: handleMediaRequest streams existing image and denies non-images', () => {
  const tempDir = join(tmpdir(), 'agy-media-http-test-' + Date.now());
  mkdirSync(tempDir, { recursive: true });
  const imgFile = join(tempDir, 'sample.png');
  const txtFile = join(tempDir, 'secret.txt');
  writeFileSync(imgFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(txtFile, 'secret content');

  try {
    // Valid image request
    let status = 0;
    let headers: Record<string, unknown> = {};
    let dataWritten = false;

    const mockRes = {
      writeHead(s: number, h: Record<string, unknown>) {
        status = s;
        headers = h;
      },
      end() {},
      on() { return this; },
      once() { return this; },
      emit() { return true; },
      write() { dataWritten = true; return true; },
    };

    handleMediaRequest(
      { url: '/plugins/agy-link/media?path=' + encodeURIComponent(imgFile) },
      mockRes as never,
    );
    assert.equal(status, 200);
    assert.equal(headers['Content-Type'], 'image/png');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff', 'no MIME sniffing');
    assert.match(String(headers['Content-Security-Policy']), /sandbox/, 'CSP sandbox on served media');

    // Block non-image text file
    let deniedStatus = 0;
    const mockResDenied = {
      writeHead(s: number) { deniedStatus = s; },
      end() {},
    };
    handleMediaRequest(
      { url: '/plugins/agy-link/media?path=' + encodeURIComponent(txtFile) },
      mockResDenied as never,
    );
    assert.equal(deniedStatus, 403);

    // 404 on missing file
    let notFoundStatus = 0;
    const mockRes404 = {
      writeHead(s: number) { notFoundStatus = s; },
      end() {},
    };
    handleMediaRequest(
      { url: '/plugins/agy-link/media?path=' + encodeURIComponent('missing.png') },
      mockRes404 as never,
    );
    assert.equal(notFoundStatus, 404);
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
