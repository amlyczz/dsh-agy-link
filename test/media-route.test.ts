import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLocalMediaPath,
  handleMediaRequest,
  handleAssetRequest,
  handleOpenFile,
  executeOpenInSystem,
} from '../src/host/media-route.ts';
import { existsSync, writeFileSync, mkdirSync, rmSync, symlinkSync, mkdtempSync } from 'node:fs';
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

    // 2. Standard 3-slash file:/// URL (RFC 8089)
    const stdFileUrl = 'file://' + (isWin ? '/' + sampleFile.replace(/\\/g, '/') : sampleFile);
    const resolvedStd = resolveLocalMediaPath(stdFileUrl);
    assert.ok(resolvedStd !== null, 'standard 3-slash file:/// URL should resolve');
    assert.equal(resolvedStd, resolvedDirect);

    // 2b. file:/// URL with drive or legacy 4 slashes
    const fileUrl = 'file:///' + (isWin ? sampleFile.replace(/\\/g, '/') : sampleFile);
    const resolvedUrl = resolveLocalMediaPath(fileUrl);
    assert.ok(resolvedUrl !== null, 'file:/// URL should resolve');
    assert.equal(resolvedUrl, resolvedDirect);

    // 3. Relative path with workspaceRoot or array of workspaceRoots
    const resolvedRel = resolveLocalMediaPath('test-image.png', tempDir);
    assert.ok(resolvedRel !== null, 'relative path should resolve against workspaceRoot');
    const resolvedMulti = resolveLocalMediaPath('test-image.png', ['/invalid/path', tempDir]);
    assert.ok(resolvedMulti !== null, 'relative path should resolve against candidate array');
    assert.equal(resolvedMulti, resolvedDirect);

    // 3b. Relative path with leading slash or file:/// prefix against roots
    const resolvedSlash = resolveLocalMediaPath('/test-image.png', tempDir);
    assert.equal(resolvedSlash, resolvedDirect);
    const resolvedFileRel = resolveLocalMediaPath('file:///test-image.png', tempDir);
    assert.equal(resolvedFileRel, resolvedDirect);

    // 3c. 2-slash POSIX file:// URL
    if (!isWin) {
      const twoSlash = 'file://' + sampleFile.replace(/^\/+/, '');
      const resolvedTwoSlash = resolveLocalMediaPath(twoSlash);
      assert.equal(resolvedTwoSlash, resolvedDirect, '2-slash file:// URL should resolve');
    }

    // 3d. Shallow 1-level subfolder search in roots
    const subFolder = join(tempDir, 'subproject');
    mkdirSync(subFolder, { recursive: true });
    const subFile = join(subFolder, 'sub-image.png');
    writeFileSync(subFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const resolvedSub = resolveLocalMediaPath('sub-image.png', tempDir);
    assert.equal(resolvedSub, subFile, 'shallow search should locate image in subfolder');

    // 3e. Percent-encoded UTF-8 path
    const utf8Folder = join(tempDir, '中文目录');
    mkdirSync(utf8Folder, { recursive: true });
    const utf8File = join(utf8Folder, '测试.png');
    writeFileSync(utf8File, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const encodedUrl = 'file://' + (isWin ? '/' + utf8File.replace(/\\/g, '/') : utf8File).replace(/中文目录/, '%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95').replace(/测试/, '%E6%B5%8B%E8%AF%95');
    const resolvedUtf8 = resolveLocalMediaPath(encodedUrl);
    assert.equal(resolvedUtf8, utf8File, 'percent-encoded path should decode and resolve');

    // 3f. File path with fragment/line range (#L12-L25 or ?v=1)
    const anchorUrl = (isWin ? sampleFile : sampleFile) + '#L10-L20';
    const resolvedAnchor = resolveLocalMediaPath(anchorUrl);
    assert.equal(resolvedAnchor, resolvedDirect, 'path with #L anchor should strip fragment and resolve');

    const fileUrlWithAnchor = fileUrl + '#L50';
    const resolvedFileUrlAnchor = resolveLocalMediaPath(fileUrlWithAnchor);
    assert.equal(resolvedFileUrlAnchor, resolvedDirect, 'file:// URL with #L anchor should resolve');

    // 3g. Tilde path (~/...)
    const homeRel = resolveLocalMediaPath('~/non-existent-subpath-test-999');
    assert.equal(homeRel, null, 'non-existent tilde path resolves to null without error');

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

test('media-route: handleAssetRequest refuses a symlink that escapes the asset dir', () => {
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'agy-asset-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'agy-asset-out-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
    let status = 0;
    const res = {
      writeHead(s: number) { status = s; },
      end() {},
      on() { return this; },
      once() { return this; },
      emit() { return true; },
      write() { return true; },
    };
    handleAssetRequest({ url: '/plugins/agy-link/assets/leak.txt' }, res as never, root);
    assert.notEqual(status, 200, 'must not serve a file outside the asset dir via symlink');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('media-route: resolves deeply nested project files up to depth 3', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-deep-root-'));
  const nested = join(root, 'tmp', 'master_continuous');
  mkdirSync(nested, { recursive: true });
  const sample = join(nested, 'master_montage_6panel.png');
  writeFileSync(sample, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    const resolved = resolveLocalMediaPath('master_montage_6panel.png', [root]);
    assert.equal(resolved, sample, 'deeply nested image should be found in project folder');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('media-route: handleMediaRequest streams video with Range 206 support', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-video-root-'));
  const videoFile = join(root, 'sample.mp4');
  const buffer = Buffer.alloc(100, 0x42);
  writeFileSync(videoFile, buffer);

  try {
    let status = 0;
    let headers: Record<string, unknown> = {};
    const mockRes = {
      writeHead(s: number, h: Record<string, unknown>) {
        status = s;
        headers = h;
      },
      end() {},
      on() { return this; },
      once() { return this; },
      emit() { return true; },
      write() { return true; },
    };

    // Range request bytes=10-29 (20 bytes)
    handleMediaRequest(
      {
        url: '/plugins/agy-link/media?path=' + encodeURIComponent(videoFile),
        headers: { range: 'bytes=10-29' },
      },
      mockRes as never,
    );

    assert.equal(status, 206, 'range request responds with 206 Partial Content');
    assert.equal(headers['Content-Type'], 'video/mp4');
    assert.equal(headers['Content-Range'], 'bytes 10-29/100');
    assert.equal(headers['Content-Length'], 20);
    assert.equal(headers['Accept-Ranges'], 'bytes');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('media-route: handleOpenFile validates path and returns JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-open-root-'));
  const testDoc = join(root, 'report.md');
  writeFileSync(testDoc, '# Report');

  try {
    // 404 for missing file
    let notFoundStatus = 0;
    let notFoundBody = '';
    const res404 = {
      writeHead(s: number) { notFoundStatus = s; },
      end(b?: unknown) { notFoundBody = String(b ?? ''); },
    };
    handleOpenFile(
      { url: '/plugins/agy-link/open?path=' + encodeURIComponent('missing_file_xyz.md') },
      res404 as never,
      { workspaceRoots: [root] },
    );
    assert.equal(notFoundStatus, 404);
    assert.ok(notFoundBody.includes('file not found'));

    // Missing path query parameter
    let badStatus = 0;
    const resBad = {
      writeHead(s: number) { badStatus = s; },
      end() {},
    };
    handleOpenFile({ url: '/plugins/agy-link/open' }, resBad as never);
    assert.equal(badStatus, 400);

    // executeOpenInSystem reveal test
    const revealRes = executeOpenInSystem(testDoc, true);
    assert.equal(revealRes.ok, true, 'reveal in explorer/finder should succeed');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
