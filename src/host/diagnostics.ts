// /agy doctor (spec ADR-14): writes a markdown diagnostic report with the
// agy environment, catalog state, config snapshot, bindings, and the raw
// ring buffer of the last stream-json run — with auth URLs, codes, and
// token-shaped strings redacted before anything hits disk.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../common/config.ts'
import type { PluginConfig } from '../common/types.ts'
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

/** Redact auth URLs, long tokens, and authorization codes. */
export function redactLine(line: string): string {
  let out = line
  out = out.replace(/https:\/\/accounts\.google\.com\/\S+/g, '<auth-url-redacted>')
  out = out.replace(/\b[0-9]{4,}\//g, '4/<code-redacted>')
  out = out.replace(/ya29\.[A-Za-z0-9._-]+/g, '<oauth-token-redacted>')
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
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
  lines.push('- plugin config: ' + JSON.stringify({ ...cfg, extraArgs: cfg.extraArgs.length }))
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
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'doctor-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '.md')
  writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}
