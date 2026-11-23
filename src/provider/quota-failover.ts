// Live mid-run quota exhaustion detection and account failover coordinator.
// Keeps subagent/tool 429 handling pure and compact outside attempt.ts.
import {
  extractQuotaErrorModel,
  isImageModelId,
  isModelScopedQuotaFailure,
  isModelScopedQuotaTool,
  isTransientBurstRateLimit,
  looksLikeHardRateLimit,
  looksLikeTosViolation,
  parseResetDurationMs,
  type AgyEvent,
} from '../common/types.ts'
import { PREFERRED_IMAGE_QUOTA_MODEL } from '../common/model-lineup.ts'
import { modelFamilyOf, type ManagedAccount, type ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import { unwrapMcpTool } from '../host/mirror-tool.ts'
import type { SubagentQuotaExhaustedInfo } from '../features/subagent/tracker.ts'

export interface LiveQuotaFailoverState {
  family: ModelFamily
  crossFamily: boolean
  errorText: string
  rawErrorText: string
  resetTime?: string
  cooledInLive: boolean
  /** The refusal was scoped to one model, so no family cooldown may be written. */
  modelScoped?: boolean
}

const DIRECT_QUOTA_TOOLS = new Set(['generate_image', 'invoke_subagent', 'swarm', 'run_workflow'])

/**
 * Inspect one completed/failed tool step for an authoritative hard quota error
 * emitted directly by agy's image-generation or subagent delegation tool.
 */
export function isDirectToolQuotaExhausted(ev: AgyEvent): { toolName: string; errorText: string; modelScoped: boolean } | null {
  if (ev.kind !== 'step' || ev.stepKind !== 'tool' || !ev.tool) return null
  if (ev.state !== 'ERROR' && !ev.tool.error) return null
  const unwrapped = unwrapMcpTool(ev.tool.name, ev.tool.args)
  if (!DIRECT_QUOTA_TOOLS.has(unwrapped.tool)) return null
  const err = [
    ev.tool.error,
    typeof ev.tool.output === 'string' ? ev.tool.output : '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
  if (err === '') return null
  if (!looksLikeHardRateLimit(err) || isTransientBurstRateLimit(err) || looksLikeTosViolation(err)) {
    return null
  }
  // A model-scoped refusal (image model, one model's own quota) still rotates
  // to another account so the image can be produced, but the caller must NOT
  // cool the whole text family for it.
  const modelScoped = isModelScopedQuotaTool(unwrapped.tool) || isModelScopedQuotaFailure(err)
  return { toolName: unwrapped.tool, errorText: err, modelScoped }
}

/**
 * Find an alternative healthy account that can serve BOTH the current turn's
 * `(inputFamily, activeModel)` and (if different) the exhausted `exhaustedFamily`.
 */
export function findAlternativeAccount(
  pool: AccountPoolManager,
  currentAccountId: string,
  inputFamily: ModelFamily,
  activeModel: string,
  exhaustedFamily: ModelFamily,
): ManagedAccount | undefined {
  const now = Date.now()
  return pool.getAccounts().find((alt) => {
    if (alt.id === currentAccountId) return false
    const mainOk = typeof pool.isAccountEligibleForModel === 'function'
      ? pool.isAccountEligibleForModel(alt, inputFamily, activeModel, now)
      : pool.isAccountEligible(alt, inputFamily, now)
    if (!mainOk) return false
    if (exhaustedFamily !== inputFamily && !pool.isAccountEligible(alt, exhaustedFamily, now)) {
      return false
    }
    return true
  })
}

export interface LiveQuotaContext {
  pool?: AccountPoolManager
  account?: ManagedAccount
  inputFamily: ModelFamily
  activeModel: string
  emitNotice: (stepKey: string, text: string) => void
  onTriggerKill: () => void
}

export interface LiveQuotaController {
  handleQuotaExhausted: (info: SubagentQuotaExhaustedInfo) => void
  failoverState: () => LiveQuotaFailoverState | null
  cooledFamilies: () => ReadonlySet<ModelFamily>
}

export function createLiveQuotaController(ctx: LiveQuotaContext): LiveQuotaController {
  const cooled = new Set<ModelFamily>()
  let state: LiveQuotaFailoverState | null = null
  let triggeredKill = false

  const handleQuotaExhausted = (info: SubagentQuotaExhaustedInfo): void => {
    const raw = info.errorText.trim()
    if (raw === '' || isTransientBurstRateLimit(raw) || looksLikeTosViolation(raw)) return
    const detectedModel = info.model ?? extractQuotaErrorModel(raw)
    const modelScoped = info.modelScoped === true || isModelScopedQuotaFailure(raw) || isImageModelId(detectedModel)
    const modelFam = detectedModel ? modelFamilyOf(detectedModel) : undefined
    const targetFamily: ModelFamily = modelFam && modelFam !== 'unknown' ? modelFam : ctx.inputFamily
    const resetMs = info.resetMs ?? parseResetDurationMs(raw)
    const resetTime = resetMs && resetMs > 0 ? new Date(Date.now() + resetMs).toISOString() : undefined

    let cooledNow = false
    if (ctx.account && ctx.pool && !cooled.has(targetFamily)) {
      cooled.add(targetFamily)
      if (modelScoped) {
        // One model's own bucket ran out. Record it ONLY on that model and keep
        // the turn on this account: switching the family pointer here is what
        // made image quota exhaustion interrupt unrelated text work.
        const bucket = detectedModel ?? info.model ?? ''
        if (bucket !== '') ctx.pool.recordModelFailure(ctx.account.id, bucket, raw, resetTime)
        ctx.emitNotice(
          `live-quota-model-${ctx.account.id}-${bucket || 'model'}`,
          `[agy] ${bucket || '当前模型'} 的额度已耗尽，仅该模型暂停，其他模型与账号不受影响。\n`,
        )
        return
      }
      ctx.pool.recordFailure(ctx.account.id, targetFamily, raw, resetTime)
      cooledNow = true
    }

    const cooledInLive = modelScoped ? false : (cooledNow || cooled.has(targetFamily))
    const alt = ctx.account && ctx.pool
      ? findAlternativeAccount(ctx.pool, ctx.account.id, ctx.inputFamily, ctx.activeModel, targetFamily)
      : undefined
    const isParentLoop = info.source === 'parent-retry-loop'
    const subject = isParentLoop ? '主对话' : (info.role ? `子代理 (${info.role})` : '子代理/工具')

    if (alt && !triggeredKill) {
      triggeredKill = true
      state = {
        family: targetFamily,
        crossFamily: targetFamily !== ctx.inputFamily,
        errorText: raw.slice(0, 300),
        rawErrorText: raw,
        ...(resetTime === undefined ? {} : { resetTime }),
        cooledInLive,
        ...(modelScoped ? { modelScoped: true } : {}),
      }
      ctx.emitNotice(
        `live-quota-switch-${ctx.account?.id ?? 'none'}-${targetFamily}`,
        `[agy] ${subject}额度耗尽，已自动切换至可用账号 ${alt.alias || alt.id}...\n`,
      )
      ctx.onTriggerKill()
    } else if (!alt && isParentLoop && !triggeredKill) {
      triggeredKill = true
      state = {
        family: targetFamily,
        crossFamily: false,
        errorText: raw.slice(0, 300),
        rawErrorText: raw,
        ...(resetTime === undefined ? {} : { resetTime }),
        cooledInLive,
        ...(modelScoped ? { modelScoped: true } : {}),
      }
      ctx.emitNotice(
        `live-quota-loop-${ctx.account?.id ?? 'none'}-${targetFamily}`,
        `[agy] ${subject}连续触发硬配额限流，当前无其他可用账号，已提前终止重试\n`,
      )
      ctx.onTriggerKill()
    } else if (!alt) {
      ctx.emitNotice(
        `live-quota-none-${ctx.account?.id ?? 'none'}-${targetFamily}`,
        `[agy] ${subject}额度耗尽，当前无其他可用账号可切换\n`,
      )
    }
  }

  return {
    handleQuotaExhausted,
    failoverState: () => state,
    cooledFamilies: () => cooled,
  }
}

export function reportDirectToolQuota(quotaCtrl: LiveQuotaController | null, ev: AgyEvent): void {
  if (!quotaCtrl) return
  const direct = isDirectToolQuotaExhausted(ev)
  if (!direct) return
  // A generate_image 429 always belongs to the image model's bucket even when
  // the error text omits the model id: the tool name is the proof.
  const m = extractQuotaErrorModel(direct.errorText)
    ?? (direct.toolName === 'generate_image' ? PREFERRED_IMAGE_QUOTA_MODEL : undefined)
  const r = parseResetDurationMs(direct.errorText)
  quotaCtrl.handleQuotaExhausted({
    source: 'tool-step',
    errorText: direct.errorText,
    ...(direct.modelScoped ? { modelScoped: true } : {}),
    ...(m ? { model: m } : {}),
    ...(r !== undefined ? { resetMs: r } : {}),
  })
}

export function poolQuotaHopsFor(pool: AccountPoolManager | undefined): number {
  if (!pool) return 0
  return Math.min(Math.max(0, pool.getAccounts().filter((a) => a.enabled).length - 1), 16)
}

export function createPoolQuotaHooks(pool: AccountPoolManager) {
  return {
    poolQuotaHops: (): number => poolQuotaHopsFor(pool),
    onQuotaExhausted: (
      accountId: string | undefined,
      model: string,
      errorText: string,
      quotaModel?: string,
    ): boolean => {
      const errModel = extractQuotaErrorModel(errorText) || model
      const errFam = modelFamilyOf(errModel)
      const mainFam = modelFamilyOf(model)
      const targetFam = errFam !== 'unknown' ? errFam : mainFam
      const resetMs = parseResetDurationMs(errorText)
      const resetTime = resetMs && resetMs > 0 ? new Date(Date.now() + resetMs).toISOString() : undefined
      // The caller telling us which bucket ran out (image model) is authoritative:
      // it means "do NOT cool the family, only that model".
      const bucketModel = (quotaModel ?? '').trim() || errModel
      const modelScoped =
        (quotaModel !== undefined && quotaModel.trim() !== '') ||
        isModelScopedQuotaFailure(errorText) ||
        isImageModelId(errModel)
      if (accountId) {
        if (modelScoped) pool.recordModelFailure(accountId, bucketModel, errorText, resetTime)
        else pool.recordFailure(accountId, targetFam, errorText, resetTime)
        if (targetFam !== mainFam) {
          pool.advanceAccount(accountId, mainFam, model)
        }
      }
      // Non-mutating: availability for the NEXT attempt, without stealing the
      // family's sticky account from a concurrent chat turn.
      return pool.findAccount(mainFam, model, quotaModel) !== null
    },
    onModelSuccess: (accountId: string, quotaModel: string): void => {
      pool.recordModelSuccess(accountId, quotaModel)
    },
  }
}
