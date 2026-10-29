// /agy doctor (spec ADR-14): writes a markdown diagnostic report with the
// agy environment, catalog state, config snapshot, bindings, and the raw
// ring buffer of the last stream-json run — with auth URLs, codes, and
// token-shaped strings redacted before anything hits disk.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../common/config.ts'
import type { PluginConfig } from '../common/types.ts'
import { describeAgyAutoUpdate } from './auto-updater.ts'
import type { ModelCatalog } from './models.ts'
import type { SessionStore } from './sessions.ts'

export interface DoctorDeps {
  cfg: () => PluginConfig
  bin: () => string | null
  version: () => string | null
  catalog: () => ModelCatalog
  store: () => SessionStore
  recentLines: () => readonly string[];
}

/**
 * Redact user:pass credentials from a proxy URL for display in command output
 * and reports. The full URL (with embedded credentials) stays in config only.
 */
export function redactProxyUrl(url: string): string {
  if (url === '') return url
  try {
    const u = new URL(url)
    if (u.username !== '' || u.password !== '') {
      u.username = u.username !== '' ? '***' : ''
      u.password = u.password !== '' ? '***' : ''
      return u.toString()
    }
    return url
  } catch {
    return '<proxy-url-redacted>'
  }
}

/** Redact auth URLs, long tokens, and authorization codes. */
export function redactLine(line: string): string {
  let out = line
  out = out.replace(/https:\/\/accounts\.google\.com\/\S+/g, '<auth-url-redacted>')
  out = out.replace(/\b[0-9]{4,}\//g, '4/<code-redacted>')
  out = out.replace(/ya29\.[A-Za-z0-9._-]+/g, '<oauth-token-redacted>')
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
  // Google OAuth refresh tokens ("1//0…") and AIza API keys did not match any
  // rule above and landed in the doctor report verbatim when agy echoed them.
  out = out.replace(/\b1\/\/0[A-Za-z0-9._-]{10,}/g, '<oauth-refresh-token-redacted>')
  out = out.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '<api-key-redacted>')
  // OIDC/JWT id_tokens (Google's id_token is a JWT: header.payload.signature)
  // and provider secret keys that do not share the AIza shape.
  out = out.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '<jwt-redacted>')
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<api-key-redacted>')
  out = out.replace(/\bGOCSPX-[A-Za-z0-9_-]{10,}\b/g, '<api-key-redacted>')
  // Auth-carrying request/response headers whose scheme is not `Bearer`
  // (Basic auth, cookies, provider key headers) would otherwise leak verbatim.
  out = out.replace(/\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\r\n]+/gi, '$1: <redacted>')
  out = out.replace(/\b(?:https?|socks[45]):\/\/[^\s/]*:[^\s/@]*@[^\s]+/gi, '<proxy-url-redacted>')
  return out
}

export function writeDoctorReport(deps: DoctorDeps): string {
  const cfg = deps.cfg()
  const cat = deps.catalog().get()
  const bindings = deps.store().all()
  const lines: string[] = []
  lines.push('# dsh-agy-link diagnostic report')
  lines.push('')
  lines.push('- generated: ' + new Date().toISOString())
  lines.push('- agy binary: ' + (deps.bin() ?? 'NOT FOUND'))
  lines.push('- agy version: ' + (deps.version() ?? 'unknown'))
  // Issue #49: whether spawns pre-empt agy's `--bg-updater` console flash.
  lines.push(
    '- agy auto-updater: ' +
      (cfg.suppressAgyAutoUpdate ? describeAgyAutoUpdate() : 'not suppressed (suppressAgyAutoUpdate=false)'),
  )
  // The full config is dumped for support: scrub values that can carry
  // credentials (proxyUrl) instead of emitting them into a 0644 file.
  const cfgDump: Record<string, unknown> = { ...cfg, extraArgs: cfg.extraArgs.length }
  if (typeof cfgDump.proxyUrl === 'string' && cfgDump.proxyUrl !== '') {
    cfgDump.proxyUrl = redactProxyUrl(cfgDump.proxyUrl as string)
  }
  lines.push('- plugin config: ' + JSON.stringify(cfgDump))
  lines.push('- catalog: ' + cat.source + ' — ' + cat.models.length + ' models' + (cat.lastError === undefined ? '' : ' — error: ' + cat.lastError))
  for (const m of cat.models) {
    lines.push('  - ' + m.id + (m.efforts ? ' [' + m.efforts.join('/') + ']' : ''))
  }
  lines.push('- conversation bindings: ' + Object.keys(bindings).length)
  for (const [k, b] of Object.entries(bindings)) {
    lines.push('  - ' + k + ' -> ' + b.conversationId + ' @ ' + new Date(b.updatedAt).toISOString())
  }
  lines.push('- node: ' + process.version + ' — ' + process.platform + ' ' + process.arch)
  lines.push('')
  lines.push('## last stream-json stdout (redacted, tail)')
  lines.push('')
  lines.push('```')
  const recent = deps.recentLines()
  for (const l of recent.slice(-400)) lines.push(redactLine(l))
  lines.push('```')
  lines.push('')
  const dir = join(stateDir(), 'diagnostics')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'doctor-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '.md')
  // The report is redacted but still diagnostic, owner-only: mkdir 0700 + file
  // 0600 so other local users cannot read config paths / residual log text.
  writeFileSync(file, lines.join('\n'), { encoding: 'utf8', mode: 0o600 })
  return file
}
