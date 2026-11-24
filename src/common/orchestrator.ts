import { DEFAULT_FALLBACK_MODELS } from './model-lineup.ts'
import { splitEffortSuffix } from './reasoning.ts'

export interface OrchestratorRoleConfig {
  orchestratorPlannerModel?: string
  orchestratorPlannerEffort?: string
  orchestratorExecutorModel?: string
  orchestratorExecutorEffort?: string
}

export interface OrchestratorSettingsPayload {
  planner?: string
  executor?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `modelId` selects an Antigravity Orchestrator role model. */
export function isOrchestratorModel(modelId?: string): boolean {
  if (typeof modelId !== 'string') return false
  const normalized = modelId.trim().toLowerCase().replace(/^agy\//, '')
  return normalized.startsWith('gemini-pro-orchestrator')
}

/**
 * Format an agy tiered model slug for an Orchestrator planner/executor slot
 * (`<base>-<effort>` when effort-capable, or `<model>` for model/agy default).
 * Returns `undefined` when the role model itself is left empty (`Auto`).
 */
export function resolveOrchestratorRoleSlug(
  model: string | undefined,
  effort: string | undefined,
  supportedEfforts?: readonly string[] | null,
): string | undefined {
  const trimmedModel = (model ?? '').trim()
  if (trimmedModel === '') return undefined

  const cleanEffort = (effort ?? '').trim().toLowerCase()
  const knownEfforts =
    supportedEfforts === undefined || supportedEfforts === null
      ? undefined
      : supportedEfforts.map((e) => e.trim().toLowerCase()).filter(Boolean)

  if (cleanEffort === '') return trimmedModel

  // Models with an explicit empty effort list (e.g. `gpt-oss-120b-medium`) do
  // not accept an extra `-effort` suffix.
  if (supportedEfforts !== undefined) {
    if (!knownEfforts || knownEfforts.length === 0) return trimmedModel
    if (!knownEfforts.includes(cleanEffort)) return trimmedModel
    const split = splitEffortSuffix(trimmedModel)
    const base =
      split.effort !== undefined && knownEfforts.includes(split.effort)
        ? split.base
        : trimmedModel
    return `${base}-${cleanEffort}`
  }

  // Fallback when no catalog entry is available: preserve `gpt-oss-120b-medium`
  // whose `-medium` belongs to the canonical id rather than a selectable tier.
  if (trimmedModel.toLowerCase() === 'gpt-oss-120b-medium') return trimmedModel
  const split = splitEffortSuffix(trimmedModel)
  const base = split.effort !== undefined ? split.base : trimmedModel
  return `${base}-${cleanEffort}`
}

function defaultEffortsForModel(modelId: string): readonly string[] | undefined {
  const clean = modelId.trim().toLowerCase().replace(/^agy\//, '')
  if (clean === '') return undefined
  const direct = DEFAULT_FALLBACK_MODELS.find((m) => m.id.toLowerCase() === clean)
  if (direct) return direct.efforts ?? []
  const split = splitEffortSuffix(clean)
  if (split.effort !== undefined) {
    const byBase = DEFAULT_FALLBACK_MODELS.find((m) => m.id.toLowerCase() === split.base)
    if (byBase) return byBase.efforts ?? []
  }
  return undefined
}

/** Build the `--settings.orchestrator` payload from configured planner/executor pairs. */
export function buildOrchestratorSettingsObject(
  cfg: OrchestratorRoleConfig,
  effortsForModel: (modelId: string) => readonly string[] | null | undefined = defaultEffortsForModel,
): OrchestratorSettingsPayload | undefined {
  const plannerModel = cfg.orchestratorPlannerModel ?? ''
  const executorModel = cfg.orchestratorExecutorModel ?? ''
  const planner = resolveOrchestratorRoleSlug(
    plannerModel,
    cfg.orchestratorPlannerEffort,
    effortsForModel(plannerModel),
  )
  const executor = resolveOrchestratorRoleSlug(
    executorModel,
    cfg.orchestratorExecutorEffort,
    effortsForModel(executorModel),
  )
  if (planner === undefined && executor === undefined) return undefined
  return {
    ...(planner !== undefined ? { planner } : {}),
    ...(executor !== undefined ? { executor } : {}),
  }
}

function parseSettingsObject(
  raw: string,
  readFile?: (filePath: string) => string,
): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  let jsonText = trimmed
  if (!trimmed.startsWith('{')) {
    if (!readFile) return undefined
    try {
      jsonText = readFile(trimmed)
    } catch {
      return undefined
    }
  }
  try {
    const parsed = JSON.parse(jsonText)
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Merge `{ orchestrator }` into an existing `agySettings` JSON object or file
 * without clobbering unrelated keys.
 */
export function mergeOrchestratorIntoAgySettings(
  baseSettings: string | undefined,
  orchestrator: OrchestratorSettingsPayload | undefined,
  readFile?: (filePath: string) => string,
): string | undefined {
  const trimmedBase = baseSettings?.trim() ?? ''
  if (!orchestrator || (orchestrator.planner === undefined && orchestrator.executor === undefined)) {
    return trimmedBase !== '' ? trimmedBase : undefined
  }
  if (trimmedBase === '') {
    return JSON.stringify({ orchestrator })
  }
  const baseObj = parseSettingsObject(trimmedBase, readFile)
  if (!baseObj) {
    return JSON.stringify({ orchestrator })
  }
  const existingOrch = isPlainObject(baseObj.orchestrator) ? baseObj.orchestrator : {}
  return JSON.stringify({
    ...baseObj,
    orchestrator: {
      ...existingOrch,
      ...orchestrator,
    },
  })
}
