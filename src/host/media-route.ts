// Media and asset route handler for dsh-agy-link.
// Serves local images referenced by Antigravity (file://, absolute paths, WSL paths, staged media)
// and static plugin assets (e.g. mermaid.min.js) safely to DSH Desktop and Web clients.
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const MIME_MAP: Record<string, string> = {
  // Images
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
  // Videos
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  // Audios
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  // Text & Assets
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const IS_WIN = process.platform === 'win32';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.cache', '.venv', 'dist', 'build', '.idea', '.vscode', '.next', '.nuxt', 'Library',
]);

/** decodeURIComponent that returns null instead of throwing on malformed input. */
function safeDecodeUri(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
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
      // Fallback manual parsing if URL constructor or fileURLToPath throws
    }

    if (converted !== null) {
      p = converted;
    } else {
      const withoutScheme = p.slice(7);
      const decoded = safeDecodeUri(withoutScheme);
      if (decoded === null) return null;
      p = decoded;

      if (IS_WIN) {
        if (/^\/[A-Za-z]:/.test(p)) {
          p = p.slice(1);
        } else if (p.startsWith('wsl.localhost/')) {
          p = '\\\\' + p.replace(/\//g, '\\');
        } else if (p.startsWith('/wsl.localhost/')) {
          p = '\\\\' + p.slice(1).replace(/\//g, '\\');
        }
      } else {
        if (!p.startsWith('/')) {
          if (existsSync('/' + p) || /^(Users|home|private|tmp|var|opt|Applications)\//.test(p)) {
            p = '/' + p;
          }
        }
      }
    }
  }

  if (IS_WIN) {
    const mntMatch = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (mntMatch) {
      p = `${mntMatch[1]!.toUpperCase()}:\\${mntMatch[2]!.replace(/\//g, '\\')}`;
    } else if (p.startsWith('/home/')) {
      p = `\\\\wsl.localhost\\Ubuntu\\${p.replace(/\//g, '\\')}`;
    }
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

/**
 * Normalize and resolve a raw path or file:// URL into a system file path.
 * Converts WSL /mnt/X/ and /home/ paths on Windows where possible.
 */
export function resolveLocalMediaPath(
  rawPath: string,
  workspaceRoots?: string | readonly string[],
): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const p = parseRawMediaUri(rawPath.trim());
  if (p === null) return null;

  // Strip query string and fragment/hash (e.g. #L123-L145 or ?v=1)
  const cleanPath = p.split(/[?#]/)[0] ?? p;

  // If path is already absolute, check directly
  if ((IS_WIN && (/^[A-Za-z]:/.test(cleanPath) || cleanPath.startsWith('\\\\'))) || (!IS_WIN && cleanPath.startsWith('/'))) {
    const resolved = resolve(cleanPath);
    if (existsSync(resolved)) return resolved;
  }

  // Resolve candidates against workspace roots / media directory
  const roots: string[] = [];
  if (typeof workspaceRoots === 'string' && workspaceRoots !== '') {
    roots.push(workspaceRoots);
  } else if (Array.isArray(workspaceRoots)) {
    for (const r of workspaceRoots) {
      if (typeof r === 'string' && r !== '') roots.push(r);
    }
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
    const isRootWide = root === home || root === '/' || (IS_WIN && /^[A-Za-z]:\\?$/.test(root));
    const depth = isRootWide ? 1 : 3;
    const found = searchInDirectory(root, strippedRel, baseName, depth);
    if (found) return found;
  }

  const resolved = resolve(cleanPath);
  if (existsSync(resolved)) {
    return resolved;
  }

  return null;
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
      res.writeHead(416, {
        'Content-Range': `bytes */${totalSize}`,
        'Content-Type': 'text/plain',
      });
      res.end('requested range not satisfiable');
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    });

    const stream = createReadStream(filePath, { start, end });
    stream.on('error', () => {
      try { res.end(); } catch { /* ignore */ }
    });
    // @ts-ignore
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': totalSize,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    try { res.end(); } catch { /* ignore */ }
  });
  // @ts-ignore
  stream.pipe(res);
}

/**
 * Handle GET /plugins/agy-link/media?path=...
 */
export function handleMediaRequest(
  req: HttpRequestLike,
  res: HttpResponseLike,
  opts: { workspaceRoot?: string; workspaceRoots?: string | readonly string[] } = {},
): void {
  const reqUrl = req.url ?? '';
  let targetPath = '';
  try {
    const u = new URL(reqUrl, 'http://localhost');
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

    // Allow images, videos, audios and SVG
    const isMedia = contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/') || ext === '.svg';
    if (!isMedia) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('access denied: not an image');
      return;
    }

    sendMediaResponse(req, res, filePath, contentType, st.size);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('failed to read media: ' + String(err));
  }
}

export function executeOpenInSystem(targetPath: string, reveal = false): { ok: boolean; error?: string } {
  try {
    if (process.platform === 'darwin') {
      const args = reveal ? ['-R', targetPath] : [targetPath];
      const child = spawn('open', args, { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true };
    }
    if (process.platform === 'win32') {
      if (reveal) {
        const child = spawn('explorer.exe', [`/select,${targetPath}`], { detached: true, stdio: 'ignore' });
        child.unref();
        return { ok: true };
      }

      // 1. Try modern ShellExecute via PowerShell Start-Process (respects UserChoice e.g. VS Code, unlike legacy cmd.exe assoc)
      try {
        const psCmd = `Start-Process -FilePath "${targetPath.replace(/"/g, '`"')}" -ErrorAction Stop`;
        const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
          timeout: 4000,
          encoding: 'utf-8',
          windowsHide: true,
        });
        if (res.status === 0) {
          return { ok: true };
        }
      } catch {
        // Fall back below
      }

      // 2. If it is a text-like file and PowerShell failed, try opening with code or notepad
      const ext = extname(targetPath).toLowerCase();
      const isTextLike = ['.md', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.ts', '.js', '.py', '.gd', '.log', '.env'].includes(ext);
      if (isTextLike) {
        try {
          const codeRes = spawnSync('cmd.exe', ['/c', 'code', targetPath], { timeout: 3000, windowsHide: true });
          if (codeRes.status === 0) {
            return { ok: true };
          }
        } catch {
          // ignore
        }
        try {
          const child = spawn('notepad.exe', [targetPath], { detached: true, stdio: 'ignore' });
          child.unref();
          return { ok: true };
        } catch {
          // ignore
        }
      }

      // 3. Fallback to explorer reveal if direct opening failed
      try {
        const child = spawn('explorer.exe', [`/select,${targetPath}`], { detached: true, stdio: 'ignore' });
        child.unref();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    const child = spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Handle GET /plugins/agy-link/open?path=...&reveal=1
 */
export function handleOpenFile(
  req: HttpRequestLike,
  res: HttpResponseLike,
  opts: { workspaceRoots?: string | readonly string[] } = {},
): void {
  const reqUrl = req.url ?? '';
  let targetPath = '';
  let reveal = false;
  try {
    const u = new URL(reqUrl, 'http://localhost');
    targetPath = u.searchParams.get('path') ?? u.searchParams.get('url') ?? '';
    reveal = u.searchParams.get('reveal') === '1' || u.searchParams.get('reveal') === 'true';
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: 'invalid url' }));
    return;
  }

  if (!targetPath) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: 'missing path query parameter' }));
    return;
  }

  const filePath = resolveLocalMediaPath(targetPath, opts.workspaceRoots);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: 'file not found' }));
    return;
  }

  const result = executeOpenInSystem(filePath, reveal);
  if (!result.ok) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: result.error }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ ok: true, path: filePath, revealed: reveal }));
}

/**
 * Handle static assets under /plugins/agy-link/assets/...
 */
export function handleAssetRequest(
  req: HttpRequestLike,
  res: HttpResponseLike,
  assetDir: string,
): void {
  const reqUrl = req.url ?? '';
  let subPath = '';
  try {
    const u = new URL(reqUrl, 'http://localhost');
    subPath = u.pathname.replace(/^\/plugins\/agy-link\/assets\/?/, '');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid url');
    return;
  }

  // Prevent directory traversal AND symlink escape: resolve inside the
  // canonical asset dir and require the canonical target to stay inside it.
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
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });

    const stream = createReadStream(filePath);
    stream.on('error', () => {
      try { res.end(); } catch { /* ignore */ }
    });
    // @ts-ignore - pipe to response stream
    stream.pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('asset read error: ' + String(err));
  }
}
