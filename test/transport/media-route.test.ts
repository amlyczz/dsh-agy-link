import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLocalMediaPath,
  handleMediaRequest,
  handleAssetRequest,
  handleOpenFile,
  isCrossOriginBlocked,
  executeOpenInSystem,
  spawnDetachedOpener,
} from '../../src/host/media-route.ts';
import { existsSync, writeFileSync, mkdirSync, rmSync, symlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

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
    // 405 on GET (prevents markdown image RCE ![x](/plugins/agy-link/open?path=...))
    let getMethodStatus = 0;
    const res405 = {
      writeHead(s: number) { getMethodStatus = s; },
      end() {},
    };
    handleOpenFile(
      { method: 'GET', url: '/plugins/agy-link/open?path=' + encodeURIComponent(testDoc) },
      res405 as never,
      { workspaceRoots: [root] },
    );
    assert.equal(getMethodStatus, 405, 'GET must be rejected with 405 to prevent markdown image launch');

    // 403 on cross-origin browser requests and no wildcard CORS
    let corsStatus = 0;
    let corsHeaders: Record<string, unknown> = {};
    const resCors = {
      writeHead(s: number, h: Record<string, unknown>) { corsStatus = s; corsHeaders = h ?? {}; },
      end() {},
    };
    handleOpenFile(
      { method: 'POST', headers: { origin: 'https://evil.example' }, url: '/plugins/agy-link/open?path=' + encodeURIComponent(testDoc) },
      resCors as never,
      { workspaceRoots: [root] },
    );
    assert.equal(corsStatus, 403, 'cross-origin open requests must be denied');
    assert.equal(corsHeaders['Access-Control-Allow-Origin'], undefined, 'must never emit wildcard CORS');

    // 403 when file is outside workspaceRoots
    const outsideDir = mkdtempSync(join(tmpdir(), 'agy-open-outside-'));
    const outsideFile = join(outsideDir, 'outside.png');
    writeFileSync(outsideFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      let outOpenStatus = 0;
      handleOpenFile(
        { method: 'POST', url: '/plugins/agy-link/open?path=' + encodeURIComponent(outsideFile) },
        { writeHead(s: number) { outOpenStatus = s; }, end() {} } as never,
        { workspaceRoots: [root] },
      );
      assert.equal(outOpenStatus, 403, 'opening file outside allowed workspaceRoots must be denied');

      let outMediaStatus = 0;
      handleMediaRequest(
        { url: '/plugins/agy-link/media?path=' + encodeURIComponent(outsideFile) },
        { writeHead(s: number) { outMediaStatus = s; }, end() {} } as never,
        { workspaceRoots: [root] },
      );
      assert.equal(outMediaStatus, 403, 'reading media outside allowed workspaceRoots must be denied');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }

    // 404 for missing file on POST
    let notFoundStatus = 0;
    let notFoundBody = '';
    const res404 = {
      writeHead(s: number) { notFoundStatus = s; },
      end(b?: unknown) { notFoundBody = String(b ?? ''); },
    };
    handleOpenFile(
      { method: 'POST', url: '/plugins/agy-link/open?path=' + encodeURIComponent('missing_file_xyz.md') },
      res404 as never,
      { workspaceRoots: [root] },
    );
    assert.equal(notFoundStatus, 404);
    assert.ok(notFoundBody.includes('file not found'));

    // Missing path query parameter on POST
    let badStatus = 0;
    const resBad = {
      writeHead(s: number) { badStatus = s; },
      end() {},
    };
    handleOpenFile({ method: 'POST', url: '/plugins/agy-link/open' }, resBad as never);
    assert.equal(badStatus, 400);

    // executeOpenInSystem reveal test. The opener is injected: this unit test must
    // never launch a real Explorer / Finder / xdg-open. Doing so opened a window on
    // the developer's desktop on every run, because the test removes its temp dir in
    // `finally` and `explorer /select,<gone>` degrades to opening the Desktop folder.
    const launched: string[] = [];
    const fakeOpener = ((command: string, args: readonly string[]) => {
      launched.push([command, ...args].join(' '));
      return true;
    }) as unknown as typeof spawnDetachedOpener;

    // A stale path must fail instead of handing a missing target to the OS opener.
    const staleRes = executeOpenInSystem(join(root, 'already-deleted.md'), true, fakeOpener);
    assert.equal(staleRes.ok, false, 'a missing target must fail instead of opening something else');
    assert.equal(launched.length, 0, 'a missing target must not reach the OS opener');

    const revealRes = executeOpenInSystem(testDoc, true, fakeOpener);
    assert.equal(revealRes.ok, true, 'reveal in explorer/finder should succeed');
    const expected = process.platform === 'darwin'
      ? 'open -R ' + testDoc
      : process.platform === 'win32'
        ? 'explorer.exe /select,' + testDoc
        : 'xdg-open ' + testDoc;
    assert.deepEqual(launched, [expected], 'reveal must hand the exact target to the platform opener');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---- Opener launch failures must never escalate to an uncaughtException ----

test('media-route: a missing OS opener is contained instead of killing the host', () => {
  // Live incident (2026-11-16 / 2026-11-18): `spawn('xdg-open', ...)` on a
  // headless Linux host reports ENOENT asynchronously. The old code attached no
  // 'error' listener, so Node raised an uncaughtException, dsh exited with code 1
  // and systemd restarted the whole server — four times, once per UI click.
  let child: (EventEmitter & { unref: () => void }) | undefined;
  const fakeSpawn = ((command: string, args: readonly string[]) => {
    assert.equal(command, 'xdg-open');
    assert.deepEqual([...args], ['/tmp/agent-artifact.md']);
    child = Object.assign(new EventEmitter(), { unref: () => {} });
    return child;
  }) as unknown as Parameters<typeof spawnDetachedOpener>[2];

  assert.equal(
    spawnDetachedOpener('xdg-open', ['/tmp/agent-artifact.md'], fakeSpawn),
    true,
    'a started child is reported as launched',
  );
  assert.ok(child, 'the injected spawn must have been called');

  // Emitting the launch error must be swallowed by the helper's listener. An
  // unhandled 'error' event would throw here and, in production, kill the host.
  assert.doesNotThrow(() => {
    child!.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }));
  });
});

test('media-route: a synchronously throwing spawn reports false instead of escaping', () => {
  const throwingSpawn = (() => {
    throw new Error('spawn blocked');
  }) as unknown as Parameters<typeof spawnDetachedOpener>[2];
  assert.equal(spawnDetachedOpener('xdg-open', ['/tmp/x'], throwingSpawn), false);
});

test('media-route: isCrossOriginBlocked rejects null/file:// and allows dsh-app://', () => {
  assert.equal(isCrossOriginBlocked({ headers: {} }), false);
  assert.equal(isCrossOriginBlocked({ headers: { origin: 'http://localhost:3000' } }), false);
  assert.equal(isCrossOriginBlocked({ headers: { origin: 'http://127.0.0.1:8080' } }), false);
  assert.equal(isCrossOriginBlocked({ headers: { origin: 'dsh-app://desktop' } }), false);
  assert.equal(isCrossOriginBlocked({ headers: { origin: 'app://dsh' } }), false);
  assert.equal(isCrossOriginBlocked({ headers: { origin: 'vscode-webview://panel' } }), false);

  assert.equal(isCrossOriginBlocked({ headers: { origin: 'null' } }), true);
  assert.equal(isCrossOriginBlocked({ headers: { origin: 'file:///tmp/evil.html' } }), true);
  assert.equal(isCrossOriginBlocked({ headers: { origin: 'https://evil.example' } }), true);
});

test('media-route: handleOpenFile rejects executable extensions unless reveal=1', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-open-exe-'));
  try {
    for (const ext of ['.exe', '.bat', '.ps1', '.sh']) {
      const script = join(root, 'payload' + ext);
      writeFileSync(script, 'echo hello');
      let status = 0;
      let body = '';
      const res = {
        writeHead(s: number) { status = s; },
        end(b?: unknown) { body = String(b ?? ''); },
      };
      handleOpenFile(
        { method: 'POST', url: '/plugins/agy-link/open?path=' + encodeURIComponent(script) },
        res as never,
        { workspaceRoots: [root] },
      );
      assert.equal(status, 403, `${ext} must be refused without reveal=1`);
      assert.match(body, /executable/i);
    }
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
