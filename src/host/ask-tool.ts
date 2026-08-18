// agy_ask — the AskAntigravity equivalent (spec P1 / M7): a one-shot
// delegation tool so any DSH model can consult an Antigravity model. Alias
// resolution mirrors the pi bridge (flash / pro / gemini / sonnet / opus /
// gpt-oss plus exact slugs, newest version wins, effort nearest-match).
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Catalog } from './models.ts'
import type { OneShotDeps } from './oneshot.ts'
import { runAgyOnce } from './oneshot.ts'

const ALIASES: Readonly<Record<string, string>> = {
  flash: 'gemini',
  pro: 'gemini',
  gemini: 'gemini',
  sonnet: 'claude',
  opus: 'claude',
  claude: 'claude',
  'gpt-oss': 'gpt-oss',
  oss: 'gpt-oss',
}

/** Resolve a user-facing model word against the live catalog. */
export function resolveAskModel(
  input: string,
  catalog: Catalog,
  defaultModel: string,
): string {
  const q = input.trim().toLowerCase()
  if (q === '') return defaultModel
  const ids = catalog.models.map((m) => m.id)
  if (ids.includes(q)) return q
  const prefix = ALIASES[q] ?? q.replace(/\s+/g, '-')
  let level = ''
  for (const eff of ['high', 'medium', 'low']) {
    if (q.endsWith(' ' + eff) || q.endsWith('-' + eff)) level = eff
  }
  const base = level !== '' ? prefix.replace(/-?(high|medium|low)$/, '') : prefix
  const candidates = ids.filter((id) => id.startsWith(base))
  if (candidates.length === 0) return defaultModel !== '' ? defaultModel : q
  const sorted = candidates.slice().sort(compareNatural)
  const last = sorted[sorted.length - 1] ?? q
  if (level === '') return last
  const exact = sorted.find((id) => id.endsWith('-' + level))
  return exact ?? last
}

function compareNatural(a: string, b: string): number {
  const na = a.split(/(\d+)/)
  const nb = b.split(/(\d+)/)
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i] ?? ''
    const y = nb[i] ?? ''
    const xn = Number(x)
    const yn = Number(y)
    if (Number.isFinite(xn) && Number.isFinite(yn) && x !== '' && y !== '') {
      if (xn !== yn) return xn - yn
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function defineAgyAskTool(deps: OneShotDeps & { catalog: () => Catalog }) {
  return defineTool({
    name: 'agy_ask',
    description: 'Delegate a one-shot task to a Google Antigravity model via the agy CLI (e.g. ask Gemini for a review while keeping the current model). Returns the final answer text.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The task or question for the Antigravity model.',
      },
      model: {
        type: 'string',
        description: 'Model to ask: flash, pro, gemini, sonnet, opus, gpt-oss, or an exact slug (default: the bridge default model).',
      },
      effort: {
        type: 'string',
        description: 'Reasoning effort for effort-capable models: low, medium, or high.',
      },
      mode: {
        type: 'string',
        description: 'agy execution mode: plan (read-only) or accept-edits. Defaults to the bridge permission mode.',
      },
      timeoutMinutes: {
        type: 'number',
        description: 'Optional timeout budget in minutes (default 10).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 15 * 60_000,
    async execute(args, exec) {
      void exec.signal;
      const cfg = deps.cfg()
      const model = resolveAskModel(args.model ?? '', deps.catalog(), cfg.defaultModel)
      const res = await runAgyOnce(deps, {
        prompt: args.prompt,
        model: model === '' ? undefined : model,
        effort: args.effort,
        mode: args.mode,
        timeoutMs: args.timeoutMinutes ? args.timeoutMinutes * 60_000 : undefined,
        signal: exec.signal,
      })
      if (!res.ok) {
        throw new Error('agy_ask failed: ' + (res.error ?? 'unknown error'))
      }
      const footer = res.conversationId ? '\n\n(agy conversation: ' + res.conversationId + ' — continue it with: agy --conversation ' + res.conversationId + ')' : ''
      return res.text + footer + '\n(' + Math.round(res.durationMs / 100) / 10 + 's)'
    },
  })
}
