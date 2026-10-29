// Media and asset route handler for dsh-agy-link.
// Serves local images referenced by Antigravity (file://, absolute paths, WSL paths, staged media)
// and static plugin assets (e.g. mermaid.min.js) safely to DSH Desktop and Web clients.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

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
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const IS_WIN = process.platform === 'win32';

/** decodeURIComponent that returns null instead of throwing on malformed input. */
function safeDecodeUri(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Normalize and resolve a raw path or file:// URL into a system file path.
 * Converts WSL /mnt/X/ and /home/ paths on Windows where possible.
 */
export function resolveLocalMediaPath(rawPath: string, workspaceRoot?: string): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;
  let p = rawPath.trim();

  // Strip file:// prefix. decodeURIComponent throws on a malformed escape (e.g.
  // a double-encoded query decodes to a literal 'file:///%E0%A4%A'); treat that
  // as "not a usable path" instead of letting a URIError escape the route.
  if (p.startsWith('file:///')) {
    const decoded = safeDecodeUri(p.slice(8));
    if (decoded === null) return null;
    p = decoded;
    // On Windows, file:///D:/foo -> D:/foo
    if (IS_WIN && !/^[A-Za-z]:/.test(p) && /^\/[A-Za-z]:/.test(p)) {
      p = p.slice(1);
    }
  } else if (p.startsWith('file://')) {
    const decoded = safeDecodeUri(p.slice(7));
    if (decoded === null) return null;
    p = decoded;
    if (IS_WIN && p.startsWith('wsl.localhost/')) {
      p = '\\\\' + p.replace(/\//g, '\\');
    }
  }

  // Windows-specific WSL path mapping
  if (IS_WIN) {
    // /mnt/c/... -> C:\...
    const mntMatch = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (mntMatch) {
      p = `${mntMatch[1]!.toUpperCase()}:\\${mntMatch[2]!.replace(/\//g, '\\')}`;
    } else if (p.startsWith('/home/')) {
      // /home/... -> \\wsl.localhost\Ubuntu\home\...
      p = `\\\\wsl.localhost\\Ubuntu\\${p.replace(/\//g, '\\')}`;
    }
  }

  // If path is relative and workspaceRoot is provided, resolve against workspaceRoot
  if (workspaceRoot && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.startsWith('\\\\')) {
    const candidate = resolve(workspaceRoot, p);
    if (existsSync(candidate)) return candidate;
  }

  const resolved = resolve(p);
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
}

/**
 * Handle GET /plugins/agy-link/media?path=...
 */
export function handleMediaRequest(
  req: HttpRequestLike,
  res: HttpResponseLike,
  opts: { workspaceRoot?: string } = {},
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

  const filePath = resolveLocalMediaPath(targetPath, opts.workspaceRoot);
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

    // Only allow media types or known formats
    if (!contentType.startsWith('image/') && ext !== '.svg') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('access denied: not an image');
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      // Sandbox defensively: an operator-supplied SVG served from the DSH origin
      // must not execute scripts if opened/navigated directly.
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
    res.end('failed to read media: ' + String(err));
  }
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

  // Prevent directory traversal
  const safeName = subPath.replace(/\.\./g, '').replace(/^[/\\]+/, '');
  const filePath = join(assetDir, safeName);

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
