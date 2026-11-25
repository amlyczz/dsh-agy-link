import type { HostServices } from '../../../host/services.ts'
import { headerOf, type RawRes, type RouteRegistrar } from '../respond.ts'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import {
  handleMediaRequest,
  handleAssetRequest,
  handleOpenFile,
  type HttpRequestLike,
  type HttpResponseLike,
} from '../../../host/media-route.ts'
import { brainDirCandidates } from '../../../runtime/agy/db/paths.ts'

let mermaidCache: { file: string; content: Buffer; etag: string } | null = null

function handleMermaid(services: HostServices, req: unknown, res: unknown): void {
  const { hostDir } = services
  const candidates = [
    join(hostDir, 'mermaid.min.js'),
    join(hostDir, 'assets', 'mermaid.min.js'),
    join(hostDir, '..', 'assets', 'mermaid.min.js'),
    join(hostDir, '..', '..', 'assets', 'mermaid.min.js'),
  ]
  const file = candidates.find((c) => existsSync(c)) ?? null
  if (!file) {
    ;(res as RawRes).writeHead(404, { 'content-type': 'text/plain' })
    ;(res as RawRes).end('mermaid.min.js not found')
    return
  }

  try {
    if (mermaidCache === null || mermaidCache.file !== file) {
      const content = readFileSync(file)
      const etag = `"${createHash('sha1').update(content).digest('base64url').slice(0, 16)}"`
      mermaidCache = { file, content, etag }
    }
    const inm = headerOf(req, 'if-none-match')
    if (inm !== '' && inm.split(',').some((t) => t.trim() === mermaidCache!.etag || t.trim() === '*')) {
      ;(res as RawRes).writeHead(304, { etag: mermaidCache.etag, 'cache-control': 'public, max-age=86400' })
      ;(res as RawRes).end()
      return
    }
    ;(res as RawRes).writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      etag: mermaidCache.etag,
    })
    ;(res as RawRes).end(mermaidCache.content)
  } catch (err) {
    ;(res as RawRes).writeHead(500, { 'content-type': 'text/plain' })
    ;(res as RawRes).end('read error: ' + String(err))
  }
}

export function collectWorkspaceRoots(
  services: HostServices,
  opts: { includeDownloadsAndTmp?: boolean } = {},
): string[] {
  const { getConfig, mediaDir, activeCwds } = services
  const roots: string[] = []
  const cfgRoot = getConfig().workspaceRoot
  if (cfgRoot) roots.push(cfgRoot)
  if (typeof mediaDir === 'function') {
    const md = mediaDir()
    if (md) roots.push(md)
  }

  // Collect active session directories
  if (typeof activeCwds === 'function') {
    for (const c of activeCwds()) {
      if (c && !roots.includes(c)) roots.push(c)
    }
  }

  const cwd = process.cwd()
  if (!roots.includes(cwd)) roots.push(cwd)

  const includeDownloadsAndTmp = opts.includeDownloadsAndTmp !== false
  const home = homedir()
  const allowedUserDirs = [
    join(home, 'Developer'),
    join(home, 'Workspace'),
    join(home, 'Projects'),
    join(home, 'Desktop'),
    ...(includeDownloadsAndTmp ? [join(home, 'Downloads')] : []),
  ]
  for (const d of allowedUserDirs) {
    if (existsSync(d) && !roots.includes(d)) roots.push(d)
  }

  if (includeDownloadsAndTmp) {
    const tmp = tmpdir()
    if (tmp && existsSync(tmp) && !roots.includes(tmp)) roots.push(tmp)
  }

  try {
    for (const b of brainDirCandidates()) {
      if (existsSync(b) && !roots.includes(b)) roots.push(b)
    }
  } catch {
    // ignore
  }

  return roots
}

function handleMedia(services: HostServices, req: unknown, res: unknown): void {
  const roots = collectWorkspaceRoots(services)
  handleMediaRequest(req as HttpRequestLike, res as HttpResponseLike, { workspaceRoots: roots })
}

function handleOpen(services: HostServices, req: unknown, res: unknown): void {
  const roots = collectWorkspaceRoots(services, { includeDownloadsAndTmp: false })
  handleOpenFile(req as HttpRequestLike, res as HttpResponseLike, { workspaceRoots: roots })
}

function handleAssets(req: unknown, res: unknown, assetDir: string): void {
  handleAssetRequest(req as HttpRequestLike, res as HttpResponseLike, assetDir)
}

function resolveAssetDir(currentDir: string): string {
  const candidates = [
    join(currentDir, 'assets'),
    join(currentDir, '../assets'),
    join(currentDir, '../../assets'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return join(currentDir, 'assets')
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  const assetDir = resolveAssetDir(services.hostDir)
  reg({ kind: 'exact', path: '/plugins/agy-link/mermaid.min.js', handler: (req, res) => handleMermaid(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/media', handler: (req, res) => handleMedia(services, req, res) })
  reg({ kind: 'exact', path: '/plugins/agy-link/open', handler: (req, res) => handleOpen(services, req, res) })
  reg({ kind: 'prefix', path: '/plugins/agy-link/assets', handler: (req, res) => handleAssets(req, res, assetDir) })
}
