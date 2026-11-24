// Top-level `/atw` command — mirrors agy's native `/btw <question>` experience
// without colliding with community `/btw` plugins.
//
// In GUI mode (`webServer` active and no `--wait`/`--print` flag), `/atw <question>`
// launches the streaming read-only side question in BtwService and returns
// immediately so DSH's composer never freezes while the answer streams inside
// the dismissible BtwDock card above the composer. In headless mode or with
// `--wait`, it awaits completion and prints the full answer directly.
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { BtwService } from '../features/btw/service.ts'

export interface BtwCommandDeps {
  btw: () => BtwService
  isWebActive?: () => boolean
}

export interface ParsedBtwArgs {
  action: 'ask' | 'open' | 'copy' | 'clear' | 'dismiss' | 'help'
  question: string
  wait: boolean
  newThread: boolean
  model?: string
  effort?: string
}

const HELP = [
  '**/atw** — 不中断当前主回合、不写入主会话历史的旁路只读提问',
  '- `/atw <问题>` — 发起旁路提问（主回合运行中亦可；答案流式显示在输入框上方 `/atw` 卡片）',
  '- `/atw` — 打开或切回本会话的 `/atw` 卡片',
  '- `/atw --new <问题>` — 开启新旁路线程（不沿用上一条 `/atw` 上下文）',
  '- `/atw --wait <问题>` — 同步等待完整答复并输出到命令结果',
  '- `/atw --model <id> --effort <low|medium|high> <问题>` — 临时指定模型/思考档',
  '- `/atw copy` — 输出当前 `/atw` 答复全文',
  '- `/atw dismiss` / `/atw clear` — 收起卡片 / 清空本会话 `/atw` 记录',
  '- `/atw help` — 本说明',
].join('\n')

function ok(text?: string): CommandResult {
  return text === undefined ? { kind: 'success' } : { kind: 'success', text }
}

function err(text: string): CommandResult {
  return { kind: 'error', text }
}

export function parseBtwArgs(raw: string): ParsedBtwArgs {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { action: 'open', question: '', wait: false, newThread: false }
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  const first = tokens[0]!.toLowerCase()
  if (tokens.length === 1) {
    if (first === 'help' || first === '--help' || first === '-h') {
      return { action: 'help', question: '', wait: false, newThread: false }
    }
    if (first === 'copy') return { action: 'copy', question: '', wait: false, newThread: false }
    if (first === 'clear') return { action: 'clear', question: '', wait: false, newThread: false }
    if (first === 'dismiss' || first === 'close') return { action: 'dismiss', question: '', wait: false, newThread: false }
  }

  let wait = false
  let newThread = false
  let model: string | undefined
  let effort: string | undefined
  const rest: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === '--wait' || tok === '--print' || tok === '-p') {
      wait = true
    } else if (tok === '--new') {
      newThread = true
    } else if (tok === '--model' && i + 1 < tokens.length) {
      model = tokens[++i]
    } else if (tok === '--effort' && i + 1 < tokens.length) {
      effort = tokens[++i]
    } else {
      rest.push(tok)
    }
  }
  const question = rest.join(' ').trim()
  return {
    action: question === '' ? 'open' : 'ask',
    question,
    wait,
    newThread,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  }
}

function sessionIdOf(invocation?: CommandInvocation): string {
  const id = invocation?.agent?.id
  return id === undefined || id === null || String(id).trim() === '' ? 'global' : String(id)
}

export function btwCommandDefinition(deps: BtwCommandDeps): CommandDefinition {
  return {
    name: 'atw',
    description: 'Antigravity 旁路提问：不打断主回合、不污染会话历史的只读即时问答（/atw <问题>）',
    input: { hint: '<问题> | copy | clear | help' },
    handler: async (invocation) => handleBtwCommand(deps, invocation),
  }
}

async function handleBtwCommand(deps: BtwCommandDeps, invocation?: CommandInvocation): Promise<CommandResult> {
  const parsed = parseBtwArgs(invocation?.rawInput ?? '')
  const btw = deps.btw()
  const sessionId = sessionIdOf(invocation)

  switch (parsed.action) {
    case 'help':
      return ok(HELP)
    case 'clear':
      btw.clear(sessionId)
      return ok('Cleared `/atw` side questions for this session.')
    case 'dismiss':
      btw.dismiss(sessionId, false)
      return ok('Dismissed `/atw` card.')
    case 'copy': {
      const view = btw.view(sessionId)
      const cur = view.entries[view.activeIndex] ?? view.entries[view.entries.length - 1]
      if (!cur || cur.answer.trim() === '') {
        return err('No `/atw` answer available in this session yet.')
      }
      return ok(cur.answer)
    }
    case 'open': {
      const view = btw.view(sessionId)
      if (view.entries.length > 0) {
        btw.dismiss(sessionId, true)
        return ok('Opened `/atw` card.')
      }
      if (deps.isWebActive?.()) {
        btw.dismiss(sessionId, true)
        return ok('Opened `/atw` card.')
      }
      return err('Usage: /atw <side question>')
    }
    case 'ask': {
      const hasExisting = btw.view(sessionId).entries.length > 0
      const req = {
        sessionId,
        question: parsed.question,
        followUp: !parsed.newThread && hasExisting,
        newThread: parsed.newThread,
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}),
      }
      if (!parsed.wait && deps.isWebActive?.()) {
        btw.start(req)
        return ok(parsed.question)
      }
      const entry = await btw.ask(req)
      if (entry.status === 'aborted') return err('Side question aborted.')
      if (entry.status === 'error') return err(`Side question failed: ${entry.error ?? 'unknown error'}`)
      return ok(`**Side Answer (\`/atw\`)**\n\n${entry.answer}`)
    }
  }
}
