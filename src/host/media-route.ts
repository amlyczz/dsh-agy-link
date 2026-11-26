// Media and asset route handler for dsh-agy-link.
// Serves local media referenced by Antigravity (file://, absolute paths, WSL paths, staged media)
// and opens local files safely (POST-only, loopback-origin gated, workspace-confined, injection-free).
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.ogv': 'video/ogg',
  '.pdf': 'application/pdf',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const IS_WIN = process.platform === 'win32';
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.cache', '.venv', 'dist', 'build', '.idea', '.vscode', '.next', '.nuxt', 'Library',
]);
const SENSITIVE_PATH_RE = /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|antigravity-oauth-token(?:\.bak)?|\.primary-credential\.json|\.ssh|Keychains|id_rsa|id_ed25519)(?:$|[/\\])/i;

function safeDecodeUri(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function isCrossOriginBlocked(req: HttpRequestLike): boolean {
  const rawOrigin = req.headers?.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (!origin) return false;
  if (origin === 'null') return true;
  if (/^(?:dsh-app|app|vscode-webview):\/\//i.test(origin)) return false;
  try {
    const u = new URL(origin);
    return u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' && u.hostname !== '[::1]';
  } catch {
    return true;
  }
}

export function isConfinementAllowed(filePath: string, workspaceRoots?: string | readonly string[]): boolean {
  if (SENSITIVE_PATH_RE.test(filePath)) return false;
  if (workspaceRoots === undefined) return true;
  const rawRoots = typeof workspaceRoots === 'string'
    ? (workspaceRoots ? [workspaceRoots] : [])
    : workspaceRoots.filter((r) => typeof r === 'string' && r !== '');
  if (rawRoots.length === 0) return true;
  let realTarget: string;
  try {
    realTarget = realpathSync(filePath);
  } catch {
    realTarget = resolve(filePath);
  }
  if (SENSITIVE_PATH_RE.test(realTarget)) return false;
  for (const r of rawRoots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(r);
    } catch {
      realRoot = resolve(r);
    }
    const cmpTarget = IS_WIN ? realTarget.toLowerCase() : realTarget;
    const cmpRoot = IS_WIN ? realRoot.toLowerCase() : realRoot;
    if (cmpTarget === cmpRoot || cmpTarget.startsWith(cmpRoot.endsWith(sep) ? cmpRoot : cmpRoot + sep)) {
      return true;
    }
  }
  return false;
}

function parseRawMediaUri(raw: string): string | null {
  let p = raw;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = join(homedir(), p.slice(2));
  }
  if (p.startsWith('file://')) {
    let converted: string | null = null;
    try {
      converted = fileURLToPath(p);
    } catch {
      // Fallback manual parsing below
    }
    if (converted !== null) {
      p = converted;
    } else {
      const decoded = safeDecodeUri(p.slice(7));
      if (decoded === null) return null;
      p = decoded;
      if (IS_WIN) {
        if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
        else if (p.startsWith('wsl.localhost/')) p = '\\\\' + p.replace(/\//g, '\\');
        else if (p.startsWith('/wsl.localhost/')) p = '\\\\' + p.slice(1).replace(/\//g, '\\');
      } else if (!p.startsWith('/') && (existsSync('/' + p) || /^(Users|home|private|tmp|var|opt|Applications)\//.test(p))) {
        p = '/' + p;
      }
    }
  }

  if (IS_WIN) {
    const mntMatch = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (mntMatch) p = `${mntMatch[1]!.toUpperCase()}:\\${mntMatch[2]!.replace(/\//g, '\\')}`;
    else if (p.startsWith('/home/')) p = `\\\\wsl.localhost\\Ubuntu\\${p.replace(/\//g, '\\')}`;
  }

  if (p.includes('%')) {
    const decoded = safeDecodeUri(p);
    if (decoded !== null) p = decoded;
  }
  return p;
}

function searchInDirectory(
  dir: string,
  targetRel: string,
  baseName: string,
  maxDepth: number,
  currentDepth = 0,
): string | null {
  if (currentDepth > maxDepth || !existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile() && (ent.name === targetRel || ent.name === baseName)) {
        return join(dir, ent.name);
      }
    }
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith('.') && !SKIP_DIRS.has(ent.name)) {
        const sub = join(dir, ent.name);
        if (targetRel !== '') {
          const direct = join(sub, targetRel);
          if (existsSync(direct)) return direct;
        }
        const found = searchInDirectory(sub, targetRel, baseName, maxDepth, currentDepth + 1);
        if (found) return found;
      }
    }
  } catch {
    // ignore readdir errors
  }
  return null;
}

export function resolveLocalMediaPath(
  rawPath: string,
  workspaceRoots?: string | readonly string[],
): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const p = parseRawMediaUri(rawPath.trim());
  if (p === null) return null;

  const cleanPath = p.split(/[?#]/)[0] ?? p;

  if ((IS_WIN && (/^[A-Za-z]:/.test(cleanPath) || cleanPath.startsWith('\\\\'))) || (!IS_WIN && cleanPath.startsWith('/'))) {
    const resolved = resolve(cleanPath);
    if (existsSync(resolved)) return resolved;
  }

  const roots: string[] = [];
  if (typeof workspaceRoots === 'string' && workspaceRoots !== '') roots.push(workspaceRoots);
  else if (Array.isArray(workspaceRoots)) {
    for (const r of workspaceRoots) if (typeof r === 'string' && r !== '') roots.push(r);
  }

  const strippedRel = cleanPath.replace(/^[/\\]+/, '');
  const baseName = extname(cleanPath) ? cleanPath.split(/[/\\]/).pop()! : cleanPath;

  for (const root of roots) {
    const candidate = resolve(root, cleanPath);
    if (existsSync(candidate)) return candidate;

    if (strippedRel !== cleanPath) {
      const relCandidate = resolve(root, strippedRel);
      if (existsSync(relCandidate)) return relCandidate;
    }

    const baseCandidate = resolve(root, baseName);
    if (existsSync(baseCandidate)) return baseCandidate;

    const home = homedir();
    const tmp = tmpdir();
    const isRootWide = root === home || root === tmp || root === '/' || (IS_WIN && /^[A-Za-z]:\\?$/.test(root));
    if (!isRootWide) {
      const found = searchInDirectory(root, strippedRel, baseName, 3);
      if (found) return found;
    }
  }

  const resolved = resolve(cleanPath);
  return existsSync(resolved) ? resolved : null;
}

export interface HttpResponseLike {
  writeHead(status: number, headers: Record<string, string | number>): unknown;
  end(body?: unknown): unknown;
}

export interface HttpRequestLike {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

function sendMediaResponse(
  req: HttpRequestLike,
  res: HttpResponseLike,
  filePath: string,
  contentType: string,
  totalSize: number,
): void {
  const rangeHeader = req.headers?.range;
  if (rangeHeader && typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
    const parts = rangeHeader.slice(6).split('-');
    const start = parseInt(parts[0] ?? '0', 10);
    const end = parts[1] && parts[1] !== '' ? parseInt(parts[1], 10) : totalSize - 1;

    if (isNaN(start) || isNaN(end) || start > end || start >= totalSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${totalSize}`, 'Content-Type': 'text/plain' });
      res.end('requested range not satisfiable');
      return;
    }

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    });

    const stream = createReadStream(filePath, { start, end });
    stream.on('error', () => { try { res.end(); } catch { /* ignore */ } });
    // @ts-ignore
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': totalSize,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });

  const stream = createReadStream(filePath);
  stream.on('error', () => { try { res.end(); } catch { /* ignore */ } });
  // @ts-ignore
  stream.pipe(res);
}

export function handleMediaRequest(
  req: HttpRequestLike,
  res: HttpResponseLike,
  opts: { workspaceRoot?: string; workspaceRoots?: string | readonly string[] } = {},
): void {
  if (isCrossOriginBlocked(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('cross-origin media access denied');
    return;
  }
  let targetPath = '';
  try {
    const u = new URL(req.url ?? '', 'http://localhost');
    targetPath = u.searchParams.get('path') ?? u.searchParams.get('url') ?? '';
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid url');
    return;
  }

  if (!targetPath) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing path query parameter');
    return;
  }

  const roots = opts.workspaceRoots ?? opts.workspaceRoot;
  const filePath = resolveLocalMediaPath(targetPath, roots);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('file not found');
    return;
  }
  try {
    const st = statSync(filePath);
    if (!st.isFile()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('not a regular file');
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_MAP[ext] ?? 'application/octet-stream';
    const isMedia = contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/') || contentType === 'application/pdf' || ext === '.svg';
    if (!isMedia) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('access denied: not an image');
      return;
    }

    if (!isConfinementAllowed(filePath, roots)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('access denied: outside allowed workspace roots');
      return;
    }

    sendMediaResponse(req, res, filePath, contentType, st.size);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('failed to read media: ' + String(err));
  }
}

/**
 * Launch one detached OS opener without letting a launch failure kill the host.
 *
 * `spawn()` reports a missing (ENOENT) or non-executable (EACCES) target
 * asynchronously as an `error` event, so a surrounding try/catch never sees it:
 * with no listener Node raises an `uncaughtException` and the whole dsh process
 * exits. On a headless Linux host every "open in app" click therefore killed the
 * server (systemd then restarted it), because `xdg-open` is not installed.
 *
 * The listener is the entire point of this helper: it turns a launch failure
 * into a silent no-op instead of a process-killing exception. A synchronous
 * throw still reports `false` so callers can answer with an error.
 *
 * @param command executable path or PATH name.
 * @param args argv (never a shell string).
 * @param spawnImpl injection seam for tests.
 * @returns true when the child was started, false when spawn threw synchronously.
 */
export function spawnDetachedOpener(
  command: string,
  args: readonly string[],
  spawnImpl: typeof spawn = spawn,
): boolean {
  try {
    const child = spawnImpl(command, [...args], { detached: true, stdio: 'ignore' });
    // Must be attached before the first tick: the error is emitted asynchronously.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open `targetPath` with the platform handler, or reveal it in the file manager.
 *
 * A path that no longer exists must never reach the OS opener: on Windows,
 * `explorer.exe /select,<missing>` does not fail, it silently opens the Desktop
 * folder instead, so a stale click looks like the plugin randomly opening the
 * user's Desktop. Fail fast and let the route answer with a real error.
 *
 * @param opener injection seam for tests: a unit test must never launch a real
 *   Explorer / Finder / xdg-open on the developer's machine.
 */
export function executeOpenInSystem(
  targetPath: string,
  reveal = false,
  opener: typeof spawnDetachedOpener = spawnDetachedOpener,
): { ok: boolean; error?: string } {
  try {
    if (!existsSync(targetPath)) {
      return { ok: false, error: 'target does not exist: ' + targetPath };
    }
    if (process.platform === 'darwin') {
      if (!opener('open', reveal ? ['-R', targetPath] : [targetPath])) {
        return { ok: false, error: 'failed to launch the system opener' };
      }
      return { ok: true };
    }
    if (process.platform === 'win32') {
      if (reveal) {
        if (!opener('explorer.exe', [`/select,${targetPath}`])) {
          return { ok: false, error: 'failed to launch explorer.exe' };
        }
        return { ok: true };
      }

      // Pass path via environment variable ($env:AGY_OPEN_TARGET) with -LiteralPath
      // so `$()` / backticks / quotes in filenames can NEVER execute PowerShell code.
      try {
        const res = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -LiteralPath $env:AGY_OPEN_TARGET -ErrorAction Stop'],
          {
            timeout: 4000,
            encoding: 'utf-8',
            windowsHide: true,
            env: { ...process.env, AGY_OPEN_TARGET: targetPath },
          },
        );
        if (res.status === 0) return { ok: true };
      } catch {
        // Fall back below
      }

      const ext = extname(targetPath).toLowerCase();
      if (['.md', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.ts', '.js', '.py', '.gd', '.log'].includes(ext)) {
        if (opener('notepad.exe', [targetPath])) return { ok: true };
      }

      if (!opener('explorer.exe', [`/select,${targetPath}`])) {
        return { ok: false, error: 'failed to launch explorer.exe' };
      }
      return { ok: true };
    }
    if (!opener('xdg-open', [targetPath])) {
      return { ok: false, error: 'failed to launch xdg-open' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Handle POST /plugins/agy-link/open?path=...&reveal=1
 * Strictly POST-only and loopback-origin gated to prevent markdown-image RCE.
 */
const DANGEROUS_OPEN_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.msix', '.ps1', '.psm1', '.psd1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.scr', '.pif', '.hta',
  '.cpl', '.lnk', '.url', '.reg', '.sh', '.bash', '.zsh', '.command', '.app',
  '.action', '.workflow', '.apk', '.jar', '.dll', '.sys', '.drv',
]);

export function handleOpenFile(
  req: HttpRequestLike,
  res: HttpResponseLike,
  opts: { workspaceRoots?: string | readonly string[] } = {},
): void {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'POST only' }));
    return;
  }
  if (isCrossOriginBlocked(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'cross-origin open denied' }));
    return;
  }

  let targetPath = '';
  let reveal = false;
  try {
    const u = new URL(req.url ?? '', 'http://localhost');
    targetPath = u.searchParams.get('path') ?? u.searchParams.get('url') ?? '';
    reveal = u.searchParams.get('reveal') === '1' || u.searchParams.get('reveal') === 'true';
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid url' }));
    return;
  }

  if (!targetPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'missing path query parameter' }));
    return;
  }

  const filePath = resolveLocalMediaPath(targetPath, opts.workspaceRoots);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'file not found' }));
    return;
  }
  if (!isConfinementAllowed(filePath, opts.workspaceRoots)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'access denied: path outside allowed workspace roots' }));
    return;
  }

  if (!reveal && DANGEROUS_OPEN_EXTS.has(extname(filePath).toLowerCase())) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'access denied: executable file type requires reveal=1' }));
    return;
  }

  const result = executeOpenInSystem(filePath, reveal);
  if (!result.ok) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: result.error }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: filePath, revealed: reveal }));
}

export function handleAssetRequest(
  req: HttpRequestLike,
  res: HttpResponseLike,
  assetDir: string,
): void {
  let subPath = '';
  try {
    const u = new URL(req.url ?? '', 'http://localhost');
    subPath = u.pathname.replace(/^\/plugins\/agy-link\/assets\/?/, '');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid url');
    return;
  }

  let filePath: string;
  try {
    const root = realpathSync(assetDir);
    const candidate = resolve(root, subPath.replace(/^[/\\]+/, ''));
    const real = realpathSync(candidate);
    if (real !== root && !real.startsWith(root + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    filePath = real;
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('asset not found');
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('asset not found');
    return;
  }

  try {
    const st = statSync(filePath);
    if (!st.isFile()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('not a file');
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_MAP[ext] ?? 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });

    const stream = createReadStream(filePath);
    stream.on('error', () => { try { res.end(); } catch { /* ignore */ } });
    // @ts-ignore
    stream.pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('asset read error: ' + String(err));
  }
}
