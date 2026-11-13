// Argument normalisation, the agy bridge prompt, and reply/path parsing.
// Moved verbatim out of src/host/image.ts.
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { PluginConfig } from '../../common/types.ts'
import { SUPPORTED_ASPECT_RATIOS, type ImageTarget } from './types.ts'
import { PREFERRED_GEMINI_FLASH } from '../../common/model-lineup.ts'

/** Accept `16:9`, `16x9`, `16/9`, `16-9`; return the canonical `w:h` or null. */
export function normalizeAspectRatio(value: string | undefined): string | null {
  const raw = value?.trim()
  if (raw === undefined || raw === '') return null
  const m = /^(\d{1,2})\s*[:x/×-]\s*(\d{1,2})$/.exec(raw)
  if (m === null) return null
  const canonical = m[1] + ':' + m[2]
  return (SUPPORTED_ASPECT_RATIOS as readonly string[]).includes(canonical) ? canonical : null
}

/** Safe artifact stem: `[A-Za-z0-9._-]`, no leading dots, bounded length. */
export function normalizeImageName(value: string | undefined, now: number): string {
  const fallback = 'agy-image-' + now
  const raw = (value ?? '').trim()
  if (raw === '') return fallback
  // Keep CJK? agy sanitises names on disk; an ASCII stem is what survives
  // reliably across platforms and makes the artifact easy to find again.
  const ascii = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
  return ascii === '' ? fallback : ascii
}

export function resolveImageTarget(cfg: PluginConfig, override?: { model?: string; effort?: string }): ImageTarget {
  const model = (override?.model ?? cfg.imageModel ?? '').trim() ||
    (cfg.defaultModel ?? '').trim() ||
    PREFERRED_GEMINI_FLASH
  const effort = (override?.effort ?? cfg.imageEffort ?? '').trim()
  return { model, effort }
}

/**
 * The bridge prompt. It carries the exact tool arguments as JSON, forbids
 * rewriting them, and defines the two machine-readable reply lines the parser
 * accepts. Everything else (finding/validating the artifact) is code, not
 * trust in this text.
 */
export function buildImageAgentPrompt(spec: {
  prompt: string
  name: string
  aspectRatio?: string
  imagePaths?: readonly string[]
}): string {
  const lines = [
    'Call the `generate_image` tool exactly once to create the image described below.',
    '',
    'Pass these arguments VERBATIM. Do not rewrite, translate, shorten, beautify or "improve" the Prompt:',
    '- Prompt: ' + JSON.stringify(spec.prompt),
    '- ImageName: ' + JSON.stringify(spec.name),
  ]
  if (spec.aspectRatio !== undefined && spec.aspectRatio !== '') {
    lines.push('- AspectRatio: ' + JSON.stringify(spec.aspectRatio))
  }
  if (spec.imagePaths !== undefined && spec.imagePaths.length > 0) {
    lines.push('- ImagePaths: ' + JSON.stringify(spec.imagePaths))
  }
  lines.push(
    '',
    'Use the tool yourself. If your instructions require delegating to the built-in image-generator subagent, hand it these exact arguments unchanged.',
    'Do not use any other tool. Do not edit files. Do not ask follow-up questions.',
    'When the tool returns, reply with exactly one line:',
    'IMAGE_PATH=<absolute path of the generated image>',
    'If the tool fails, reply with exactly one line:',
    'IMAGE_ERROR=<the error message>',
  )
  return lines.join('\n')
}

/** `IMAGE_PATH=...` / `IMAGE_ERROR=...` from a model reply. */
export function parseImageReply(text: string): { path?: string; error?: string } {
  const out: { path?: string; error?: string } = {}
  const path = /IMAGE_PATH\s*=\s*(.+)/i.exec(text)
  if (path !== null && path[1] !== undefined) {
    const v = path[1].trim().replace(/^`|`$/g, '')
    if (v !== '') out.path = v
  }
  const error = /IMAGE_ERROR\s*=\s*(.+)/i.exec(text)
  if (error !== null && error[1] !== undefined) {
    const v = error[1].trim()
    if (v !== '') out.error = v
  }
  return out
}

const IMAGE_PATH_RE = /(?<![\w:/])(?:file:\/\/)?(?:\/|~\/)[^\s"'`<>|]+?\.(?:png|jpe?g|webp|gif)\b/gi

/** Every image path mentioned in free text (absolute or `file://`). */
export function extractImagePaths(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(IMAGE_PATH_RE)) {
    let p = m[0].trim().replace(/^file:\/\//, '')
    if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
    if (!isAbsolute(p)) continue
    if (seen.has(p)) continue
    seen.add(p)
    found.push(p)
  }
  return found
}
