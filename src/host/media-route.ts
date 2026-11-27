// Media and asset route handler for dsh-agy-link.
// Serves local media referenced by Antigravity (file://, absolute paths, WSL paths, staged media)
// and opens local files safely (POST-only, loopback-origin gated, workspace-confined, injection-free).
import { createReadStream, existsSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import {
  authorizePluginRequest,
  isRemoteOpenBlocked,
  sendMediaStream,
  type ConnectionTrustLike,
  type HttpRequestLike,
  type HttpResponseLike,
} from './media-http.ts';
import {
  executeOpenInSystem,
  handleOpenFileWithDeps,
  spawnDetachedOpener,
} from './media-open.ts';
import { prepareCompatibleMedia, type MediaTranscodeDeps } from './media-transcode.ts';

export {
  authorizePluginRequest,
  executeOpenInSystem,
  isRemoteOpenBlocked,
  spawnDetachedOpener,
  type ConnectionTrustLike,
  type HttpRequestLike,
  type HttpResponseLike,
};

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
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
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

export function isCrossOriginBlocked(req: HttpRequestLike, connection?: ConnectionTrustLike): boolean {
  return authorizePluginRequest(req, connection) !== undefined;
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

export interface MediaRequestOptions {
  workspaceRoot?: string;
  workspaceRoots?: string | readonly string[];
  connection?: ConnectionTrustLike;
  cacheDir?: string;
  transcodeDeps?: MediaTranscodeDeps;
}

interface ResolvedMediaTarget {
  filePath: string;
  ext: string;
  contentType: string;
  st: Stats;
  download: boolean;
  compat: boolean;
  raw: boolean;
}

function resolveAuthorizedMediaTarget(
  req: HttpRequestLike,
  res: HttpResponseLike,
  opts: MediaRequestOptions,
): ResolvedMediaTarget | null {
  const rejection = authorizePluginRequest(req, opts.connection);
  if (rejection !== undefined) {
    res.writeHead(rejection, { 'Content-Type': 'text/plain' });
    res.end(rejection === 401 ? 'authentication required' : 'cross-origin media access denied');
    return null;
  }

  let targetPath = '';
  let download = false;
  let compat = false;
  let raw = false;
  try {
    const u = new URL(req.url ?? '', 'http://localhost');
    targetPath = u.searchParams.get('path') ?? u.searchParams.get('url') ?? '';
    download = u.searchParams.get('download') === '1' || u.searchParams.get('download') === 'true';
    compat = u.searchParams.get('compat') === '1' || u.searchParams.get('compat') === 'true';
    raw = u.searchParams.get('raw') === '1' || u.searchParams.get('raw') === 'true';
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid url');
    return null;
  }

  if (!targetPath) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing path query parameter');
    return null;
  }

  const roots = opts.workspaceRoots ?? opts.workspaceRoot;
  const filePath = resolveLocalMediaPath(targetPath, roots);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('file not found');
    return null;
  }
  try {
    const st = statSync(filePath);
    if (!st.isFile()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('not a regular file');
      return null;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_MAP[ext] ?? 'application/octet-stream';
    const isMedia =
      contentType.startsWith('image/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      contentType === 'application/pdf' ||
      ext === '.svg';
    if (!isMedia) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('access denied: not an image');
      return null;
    }

    if (!isConfinementAllowed(filePath, roots)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('access denied: outside allowed workspace roots');
      return null;
    }

    return { filePath, ext, contentType, st, download, compat, raw };
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('failed to read media: ' + String(err));
    return null;
  }
}

export function handleMediaRequest(
  req: HttpRequestLike,
  res: HttpResponseLike,
  opts: MediaRequestOptions = {},
): void {
  const target = resolveAuthorizedMediaTarget(req, res, opts);
  if (!target) return;
  try {
    sendMediaStream(req, res, target.filePath, target.contentType, target.st, {
      download: target.download,
    });
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('failed to read media: ' + String(err));
  }
}

/**
 * Async media handler used by the HTTP transport: prepares a browser-compatible
 * remux/transcode copy (cached on disk) when a local video or TIFF/HEIC image
 * uses a format browsers cannot natively decode, then streams with full HEAD,
 * ETag/304, and RFC 9110 Range support.
 */
export async function handleMediaRequestAsync(
  req: HttpRequestLike,
  res: HttpResponseLike,
  opts: MediaRequestOptions = {},
): Promise<void> {
  const target = resolveAuthorizedMediaTarget(req, res, opts);
  if (!target) return;
  try {
    const cacheDir = opts.cacheDir ?? join(tmpdir(), 'dsh-agy-media-cache');
    const skipTranscode = target.raw || (target.download && !target.compat);
    const prepared = await prepareCompatibleMedia({
      filePath: target.filePath,
      ext: target.ext,
      contentType: target.contentType,
      size: target.st.size,
      mtimeMs: target.st.mtimeMs,
      cacheDir,
      forceCompat: target.compat,
      raw: skipTranscode,
      ...(opts.transcodeDeps ? { deps: opts.transcodeDeps } : {}),
    });
    const extraHeaders: Record<string, string> = {};
    if (prepared.transcoded) extraHeaders['X-Agy-Media-Compat'] = prepared.mode;
    else if (prepared.mode === 'fallback') extraHeaders['X-Agy-Media-Fallback'] = '1';
    sendMediaStream(req, res, prepared.filePath, prepared.contentType, prepared, {
      download: target.download,
      ...(prepared.cacheTag ? { cacheTag: prepared.cacheTag } : {}),
      ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    });
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('failed to prepare media: ' + String(err));
  }
}

export function handleOpenFile(
  req: HttpRequestLike,
  res: HttpResponseLike,
  opts: { workspaceRoots?: string | readonly string[]; connection?: ConnectionTrustLike } = {},
): void {
  handleOpenFileWithDeps(req, res, { resolveLocalMediaPath, isConfinementAllowed }, opts);
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
