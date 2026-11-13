// agy_ask — the AskAntigravity equivalent (spec P1 / M7): a one-shot
// delegation tool so any DSH model can consult an Antigravity model. Alias
// resolution mirrors the pi bridge (flash / pro / gemini / sonnet / opus /
// gpt-oss plus exact slugs, newest version wins, effort nearest-match).
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Catalog } from './models.ts'
import { defaultEffortFor, findEntry } from './models.ts'
import type { OneShotDeps } from './oneshot.ts'
import { runAgyOnce } from './oneshot.ts'
import { parseEffortUnsupported } from './adapter.ts'
import { EFFORT_SUFFIXES, REASONING_EFFORTS } from '../common/reasoning.ts'

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

/**
 * Split a model word into (base, effort): `"gemini-3.8-flash high"`,
 * `"gemini-high"` and `"hydrogen extra"` all carry a level. The effort list is
 * the canonical one (common/reasoning.ts), longest suffix first, so `xhigh`
 * is never read as `high`.
 */
function splitAskQuery(input: string): { base: string; effort?: string } {
  const q = input.trim().toLowerCase()
  const prefix = ALIASES[q] ?? q.replace(/\s+/g, '-')
  for (const eff of EFFORT_SUFFIXES) {
    if (q.endsWith(' ' + eff) || q.endsWith('-' + eff)) {
      return { base: prefix.slice(0, -(eff.length + 1)), effort: eff }
    }
  }
  return { base: prefix }
}

/** The effort a model word asks for, if any (`"hydrogen extra"` → `xhigh`). */
export function resolveAskEffort(input: string): string | undefined {
  const q = input.trim()
  if (q === '') return undefined
  return splitAskQuery(q).effort
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
  const { base } = splitAskQuery(q)
  const candidates = ids.filter((id) => id.startsWith(base))
  if (candidates.length === 0) return defaultModel !== '' ? defaultModel : q
  const sorted = candidates.slice().sort(compareNatural)
  // Catalog ids are already folded (base + efforts), so the newest matching
  // base IS the answer; the level travels separately as --effort.
  return sorted[sorted.length - 1] ?? q
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

/**
 * The `model` parameter's help text, built from the LIVE catalog: the model list
 * and the effort list are never retyped here (a hardcoded "flash, pro, gemini,
 * sonnet, opus" line is the same drift that put models in the picker agy does
 * not have). Family words still work through ALIASES.
 */
export function askModelHelp(catalog: Catalog): string {
  const ids = catalog.models.map((m) => m.id)
  const listed = ids.length > 0 ? ids.join(', ') : 'any agy model id'
  return 'Model to ask: ' + listed + ', a family word (' + Object.keys(ALIASES).join(', ')
    + '), or an exact slug (default: the bridge default model).'
}

/** The `effort` parameter's help text, from the canonical effort vocabulary. */
export function askEffortHelp(): string {
  return 'Reasoning effort for effort-capable models: ' + REASONING_EFFORTS.join(', ') + '.'
}

export function defineAgyAskTool(deps: OneShotDeps & { catalog: () => Catalog }) {
  const catalogNow = deps.catalog()
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
        description: askModelHelp(catalogNow),
      },
      effort: {
        type: 'string',
        description: askEffortHelp(),
      },
      mode: {
        type: 'string',
        description: 'agy execution mode: plan (read-only) or accept-edits. Defaults to the bridge permission mode.',
      },
      timeoutMinutes: {
        type: 'number',
        description: 'Optional timeout budget in minutes (default 10).',
      },
      readPaths: {
        type: 'string',
        description: 'Optional space/comma-separated text files to inline into the prompt (workspace-relative or absolute; binaries are skipped with a note).',
      },
      schema: {
        type: 'string',
        description: 'Optional JSON Schema (as a JSON string) enforcing the final answer via agy --json-schema.',
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
      let parsedSchema: unknown
      if (typeof args.schema === 'string' && args.schema.trim() !== '') {
        try {
          parsedSchema = JSON.parse(args.schema)
        } catch (e) {
          throw new Error('agy_ask: schema is not valid JSON: ' + String(e))
        }
      }
      const readPaths = typeof args.readPaths === 'string' && args.readPaths.trim() !== ''
        ? args.readPaths.split(/[ ,]+/).filter(Boolean)
        : []
      // Effort defaults to the bridge default (high-first) for effort models.
      // A model agy has already refused `--effort` for (issue #67) is asked
      // without the flag — the catalog is advisory, the refusal is the truth.
      const entry = findEntry(deps.catalog(), model)
      // A level written into the model word ("hydrogen extra") wins over the
      // model default; an explicit `effort` argument wins over both.
      const askedEffort = resolveAskEffort(args.model ?? '')
      const wanted = args.effort ?? askedEffort ?? (entry?.efforts ? defaultEffortFor(entry, cfg) : undefined)
      const learned = deps.effortUnsupported?.() ?? []
      const refusedBefore = wanted !== undefined && learned.some((m) => m !== '' && (m === model || m === entry?.id))
      const call = (effort: string | undefined) =>
        runAgyOnce(deps, {
          prompt: args.prompt,
          model: model === '' ? undefined : model,
          effort,
          mode: args.mode,
          timeoutMs: args.timeoutMinutes ? args.timeoutMinutes * 60_000 : undefined,
          signal: exec.signal,
          readPaths,
          schema: parsedSchema,
        })
      let effort = refusedBefore ? undefined : wanted
      let res = await call(effort)
      if (!res.ok && effort !== undefined) {
        const refused = parseEffortUnsupported(String(res.error ?? ''))
        if (refused !== null) {
          // Learn it (persist + refresh the picker) and replay once without the
          // flag, exactly like the streaming path does.
          deps.onEffortUnsupported?.(refused)
          effort = undefined
          res = await call(undefined)
        }
      }
      if (!res.ok) {
        throw new Error('agy_ask failed: ' + (res.error ?? 'unknown error'))
      }
      const footer = res.conversationId ? '\n\n(agy conversation: ' + res.conversationId + ' — continue it with: agy --conversation ' + res.conversationId + ')' : ''
      return res.text + footer + '\n(' + Math.round(res.durationMs / 100) / 10 + 's)'
    },
  })
}
