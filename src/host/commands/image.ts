// /agy image — generate or edit images inline from chat via ImageService.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { formatImageResultMarkdown } from '../image-tool.ts'
import type { ImageRequest } from '../image.ts'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

const IMAGE_USAGE = [
  'Usage: `/agy image <prompt> [-a <ratio>] [-n <name>] [-i <refPath>] [-o <outPath>] [--model <id>] [--effort <level>]`',
  'Aliases: `/agy img ...`',
].join('\n')

/** Tokenize shell-like command arguments while preserving single/double quotes. */
export function tokenizeImageArgs(input: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote !== null) {
      if (ch === '\\' && i + 1 < input.length && (input[i + 1] === quote || input[i + 1] === '\\')) {
        cur += input[++i]
      } else if (ch === quote) {
        quote = null
      } else {
        cur += ch
      }
      hasToken = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(cur)
        cur = ''
        hasToken = false
      }
      continue
    }
    cur += ch
    hasToken = true
  }
  if (hasToken) tokens.push(cur)
  return tokens
}

export function parseImageCommandInput(raw: string): ImageRequest | { error: string } {
  const afterSub = raw.trim().replace(/^(?:\/agy\s+)?(?:image|img)\s*/i, '').trim()
  if (afterSub === '') return { error: IMAGE_USAGE }
  const tokens = tokenizeImageArgs(afterSub)
  const promptParts: string[] = []
  const refs: string[] = []
  let name: string | undefined
  let aspectRatio: string | undefined
  let outPath: string | undefined
  let model: string | undefined
  let effort: string | undefined
  let force = false

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    const takeVal = (): string | undefined => (i + 1 < tokens.length ? tokens[++i] : undefined)
    if (tok === '-a' || tok === '--aspect-ratio' || tok === '--ratio') {
      const v = takeVal()
      if (v === undefined) return { error: `missing value for ${tok}\n${IMAGE_USAGE}` }
      aspectRatio = v
    } else if (tok === '-n' || tok === '--name') {
      const v = takeVal()
      if (v === undefined) return { error: `missing value for ${tok}\n${IMAGE_USAGE}` }
      name = v
    } else if (tok === '-i' || tok === '--image' || tok === '--ref' || tok === '--reference') {
      const v = takeVal()
      if (v === undefined) return { error: `missing value for ${tok}\n${IMAGE_USAGE}` }
      refs.push(v)
    } else if (tok === '-o' || tok === '--out' || tok === '--output') {
      const v = takeVal()
      if (v === undefined) return { error: `missing value for ${tok}\n${IMAGE_USAGE}` }
      outPath = v
    } else if (tok === '--model') {
      const v = takeVal()
      if (v === undefined) return { error: `missing value for ${tok}\n${IMAGE_USAGE}` }
      model = v
    } else if (tok === '--effort') {
      const v = takeVal()
      if (v === undefined) return { error: `missing value for ${tok}\n${IMAGE_USAGE}` }
      effort = v
    } else if (tok === '--force') {
      force = true
    } else if (tok === '-p' || tok === '--prompt') {
      const v = takeVal()
      if (v === undefined) return { error: `missing value for ${tok}\n${IMAGE_USAGE}` }
      promptParts.push(v)
    } else {
      promptParts.push(tok)
    }
  }

  const prompt = promptParts.join(' ').trim()
  if (prompt === '') return { error: `Prompt is required.\n${IMAGE_USAGE}` }
  return {
    prompt,
    ...(name !== undefined ? { name } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    ...(refs.length > 0 ? { imagePaths: refs } : {}),
    ...(outPath !== undefined ? { outPath } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(force ? { force: true } : {}),
  }
}

export async function handleImage(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  if (!deps.imageService) {
    return err('Image service is not initialized in this host.')
  }
  const parsed = parseImageCommandInput(ctx.raw || `${ctx.sub} ${ctx.arg}`.trim())
  if ('error' in parsed) return err(parsed.error)

  const res = await deps.imageService().generate(parsed)
  if (!res.ok) {
    return err(`Image generation failed (${res.code ?? 'AGY_ERROR'}): ${res.error ?? 'unknown error'}`)
  }
  return ok(formatImageResultMarkdown(res))
}
