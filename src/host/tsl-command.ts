// `/tsl` — Gemini "plain language" translation of the current session output.
//
// Deliberately a top-level command (not an `/agy` sub-command): it is a quick,
// frequent action ("这段黑话翻一下") and the short name is the point. Every
// invocation funnels into the same TranslationService the automatic post-turn
// hook and the per-message button use (spec: .spec/translation.md).
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { PluginConfig } from '../common/types.ts'
import type { TranslationService, TranslateTurnOptions } from './translate.ts'

export interface TslSessionAuto {
  get(sessionId: string): boolean | undefined
  set(sessionId: string, value: boolean | undefined): void
}

export interface TslCommandDeps {
  cfg: () => PluginConfig
  translate: () => TranslationService
  setOverride: (key: string, value: unknown) => void
  sessionAuto: TslSessionAuto
  sessions?: () => { get(id: unknown): unknown } | undefined
}

const HELP = [
  '**/tsl** — 用 Gemini 把当前会话的输出翻成人话（默认 `gemini-3.8-flash` · medium；`--effort low` 更快）',
  '- `/tsl` — 翻译当前会话**最后一个已完成回合**，并在该回复下方生成译文卡片',
  '- `/tsl 3` — 翻译第 3 回合（卡片锚在那条回复下方）',
  '- `/tsl --full` — 连本回合的中间解释一起翻（默认只翻最终答复）',
  '- `/tsl --text 任意文本…` — 直接翻译给定文本（不落卡片）',
  '- `/tsl --model <id> --effort <low|medium|high>` — 本次临时换模型/档位',
  '- `/tsl --print` — 命令结果里也回显译文全文',
  '- `/tsl --no-persist` / `--force` — 不写卡片 / 忽略缓存重译',
  '- `/tsl auto [on|off|status]` — 本会话的自动翻译开关（默认跟随插件设置，关闭）',
  '- `/tsl help` — 本说明',
].join('\n')

interface ParsedArgs {
  turn?: number
  text?: string
  full: boolean
  print: boolean
  persist: boolean
  force: boolean
  model?: string
  effort?: string
  lang?: string
  auto?: 'on' | 'off' | 'status'
  help: boolean
}

/** Parse the free-form tail of `/tsl`. Never throws: unknown tokens are text. */
export function parseTslArgs(raw: string): ParsedArgs {
  const out: ParsedArgs = { full: false, print: false, persist: true, force: false, help: false }
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const loose: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === '--full') out.full = true
    else if (tok === '--print') out.print = true
    else if (tok === '--no-persist') out.persist = false
    else if (tok === '--force') out.force = true
    else if (tok === 'help' || tok === '--help' || tok === '-h') out.help = true
    else if (tok === '--model' || tok === '--effort' || tok === '--lang' || tok === '--text') {
      const value = tokens[++i]
      if (value === undefined) continue
      if (tok === '--model') out.model = value
      else if (tok === '--effort') out.effort = value
      else if (tok === '--lang') out.lang = value
      else out.text = [value, ...tokens.slice(i + 1)].join(' ')
      if (tok === '--text') break
    } else if (tok === 'auto') {
      const mode = tokens[i + 1]
      if (mode === 'on' || mode === 'off') {
        out.auto = mode
        i++
      } else {
        out.auto = 'status'
      }
    } else if (/^\d+$/.test(tok) && out.turn === undefined) {
      out.turn = Number(tok)
    } else {
      loose.push(tok)
    }
  }
  if (out.text === undefined && loose.length > 0) out.text = loose.join(' ')
  return out
}

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function err(text: string): CommandResult {
  return { kind: 'error', text }
}

function seconds(ms: number): string {
  return (Math.round(ms / 100) / 10).toString() + 's'
}

function headerFor(res: { model: string; effort: string; accountId?: string; cached: boolean; durationMs: number; recordSeq?: number | null; turn?: number }): string {
  const bits = ['`' + res.model + '`']
  if (res.effort !== '') bits.push(res.effort)
  if (res.accountId !== undefined && res.accountId !== '') bits.push('账号 `' + res.accountId + '`')
  bits.push(seconds(res.durationMs))
  if (res.cached) bits.push('缓存命中')
  const turn = res.turn
  const where = turn !== undefined && res.recordSeq !== null && res.recordSeq !== undefined
    ? '\n位置：第 ' + turn + ' 回合最后回复下方（💠 Gemini 译文）'
    : ''
  return '✅ 已生成译文 · ' + bits.join(' · ') + where
}

export function tslCommandDefinition(deps: TslCommandDeps): CommandDefinition {
  return {
    name: 'tsl',
    description: 'Gemini 人话翻译：把当前会话的输出改写成大白话（/tsl [回合] [--full] [--print] | /tsl auto on|off）',
    // Mirror of issue #27: without `input` DSH's composer drops `/tsl <args>`
    // to a plain chat message instead of dispatching the command.
    input: { hint: '[turn] [--full] [--print] [--model id] [--effort x] | auto [on|off|status] | help' },
    handler: (invocation) => handle(deps, invocation),
  }
}

function currentSessionId(invocation?: CommandInvocation): string | undefined {
  const id = invocation?.agent?.id
  return id === undefined || id === null || String(id) === '' ? undefined : String(id)
}

function sessionOf(deps: TslCommandDeps, invocation?: CommandInvocation): unknown {
  const direct = invocation?.agent?.session
  if (direct !== undefined && direct !== null) return direct
  const id = currentSessionId(invocation)
  if (id === undefined) return undefined
  try {
    return deps.sessions?.()?.get(id)
  } catch {
    return undefined
  }
}

async function handle(deps: TslCommandDeps, invocation?: CommandInvocation): Promise<CommandResult> {
  const args = parseTslArgs(invocation?.rawInput ?? '')
  const service = deps.translate()
  const sessionId = currentSessionId(invocation)

  if (args.help) return ok(HELP)

  if (args.auto !== undefined) {
    if (sessionId === undefined) return err('无法识别当前会话，`/tsl auto` 需要在会话内使用。')
    if (args.auto === 'status') {
      const override = deps.sessionAuto.get(sessionId)
      const effective = override ?? deps.cfg().autoTranslate
      return ok(
        '**自动翻译（本会话）**：' +
          (effective ? '开 🟢' : '关 ⚪') +
          (override === undefined ? '（跟随插件设置）' : '（本会话覆盖）') +
          '\n调整：`/tsl auto on` / `/tsl auto off`；插件默认开关在设置 → Antigravity。',
      )
    }
    deps.sessionAuto.set(sessionId, args.auto === 'on')
    if (args.auto === 'on') {
      // Catch up immediately: the hook only reacts to NEW turn ends, so without
      // this the switch would appear to do nothing until the next turn.
      void service.translateLastTurn(sessionId, { persist: true }).catch(() => undefined)
      return ok('本会话自动翻译已**开启**，正在补译最后一回合（完成后在回复下方出现译文卡片）。')
    }
    return ok('本会话自动翻译已**关闭**。')
  }

  const opts: TranslateTurnOptions = {
    full: args.full,
    persist: args.persist,
    force: args.force,
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.lang === undefined ? {} : { targetLanguage: args.lang }),
  }

  try {
    if (args.text !== undefined && args.text.trim() !== '') {
      const res = await service.translate({ text: args.text, ...(opts.model === undefined ? {} : { model: opts.model }), ...(opts.effort === undefined ? {} : { effort: opts.effort }), ...(opts.targetLanguage === undefined ? {} : { targetLanguage: opts.targetLanguage }), force: opts.force })
      if (!res.ok) return err('翻译失败：' + (res.error ?? 'unknown error'))
      return ok(headerFor(res) + '\n\n---\n\n' + res.text)
    }

    if (sessionId === undefined) return err('无法识别当前会话，`/tsl` 需要在会话内使用。')
    if (sessionOf(deps, invocation) === undefined) return err('当前会话的日志不可用，请稍后重试。')

    const res =
      args.turn === undefined
        ? await service.translateLastTurn(sessionId, opts)
        : await service.translateTurn(sessionId, args.turn, opts)

    if (!res.ok) {
      if (res.code === 'TURN_NOT_FOUND') return err('没有可翻译的助手回复（该回合可能是空的或还在运行）。')
      if (res.code === 'TRANSIENT') return err('当前回合还没结束，等它输出完再译。')
      return err('翻译失败：' + (res.error ?? 'unknown error'))
    }
    const showBody = args.print || res.recordSeq === null || res.recordSeq === undefined
    return ok(headerFor(res) + (showBody ? '\n\n---\n\n' + res.text : ''))
  } catch (e) {
    return err('翻译失败：' + (e instanceof Error ? e.message : String(e)))
  }
}
