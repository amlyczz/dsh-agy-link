import type { HostServices } from '../../../host/services.ts'
import { type RawRes, type RouteRegistrar } from '../respond.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  handleMediaRequest,
  handleAssetRequest,
  handleOpenFile,
  type HttpRequestLike,
  type HttpResponseLike,
} from '../../../host/media-route.ts'

function handleMermaid(services: HostServices, req: unknown, res: unknown): void {
  const { hostDir } = services
  const p = join(hostDir, 'mermaid.min.js')
  const fallback = join(hostDir, '..', 'assets', 'mermaid.min.js')
  const file = existsSync(p) ? p : existsSync(fallback) ? fallback : null
  if (!file) {
    ;(res as RawRes).writeHead(404, { 'content-type': 'text/plain' })
    ;(res as RawRes).end('mermaid.min.js not found')
    return
  }
  try {
    const content = readFileSync(file)
    ;(res as RawRes).writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    })
    ;(res as RawRes).end(content)
  } catch (err) {
    ;(res as RawRes).writeHead(500, { 'content-type': 'text/plain' })
    ;(res as RawRes).end('read error: ' + String(err))
  }
}

function collectWorkspaceRoots(services: HostServices): string[] {
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

  const home = homedir()
  const devDirs = [join(home, 'Developer'), join(home, 'Workspace'), join(home, 'Projects')]
  for (const d of devDirs) {
    if (existsSync(d) && !roots.includes(d)) roots.push(d)
  }
  const desktop = join(home, 'Desktop')
  const downloads = join(home, 'Downloads')
  if (existsSync(desktop) && !roots.includes(desktop)) roots.push(desktop)
  if (existsSync(downloads) && !roots.includes(downloads)) roots.push(downloads)
  if (!roots.includes(home)) roots.push(home)

  return roots
}

function handleMedia(services: HostServices, req: unknown, res: unknown): void {
  const roots = collectWorkspaceRoots(services)
  handleMediaRequest(req as HttpRequestLike, res as HttpResponseLike, { workspaceRoots: roots })
}

function handleOpen(services: HostServices, req: unknown, res: unknown): void {
  const roots = collectWorkspaceRoots(services)
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
