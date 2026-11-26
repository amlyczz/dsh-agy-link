// Config resolution: env (DSH_AGY_*) > runtime overrides file > cordis
// entry config > defaults (spec ADR-13). The overrides file backs /agy
// hot changes and survives restarts; the env is read per call so a changed
// process environment is honored without reload.
import { defaultConfig, type AgyTransportMode, type PermissionMode, type PluginConfig, type TranslateDisplayMode, type WarmupWindowMode } from './types.ts'
import { MIN_WARMUP_INTERVAL_HOURS } from './timeouts.ts'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OverridesFile { [key: string]: unknown }

/**
 * Clamp the scheduled-warmup interval. `0` disables it; anything else is at
 * least MIN_WARMUP_INTERVAL_HOURS (a pool sweep now spans minutes, so a 1–2h
 * interval would re-arm before the previous run drains).
 */
export function clampWarmupIntervalHours(hours: number): number {
  const floored = Math.floor(hours)
  if (!Number.isFinite(floored) || floored <= 0) return 0
  return Math.min(168, Math.max(MIN_WARMUP_INTERVAL_HOURS, floored))
}

export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function stateDir(): string {
  return join(dshHome(), 'agy-link')
}

export function overridesPath(): string {
  return join(stateDir(), 'runtime-overrides.json')
}

function readJson(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {}
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function readOverrides(file = overridesPath()): OverridesFile {
  return readJson(file)
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** `mcpConfigScope` is a closed enum: unknown values fall back to the default. */
function asMcpConfigScope(v: unknown): PluginConfig['mcpConfigScope'] | undefined {
  return v === 'global' || v === 'workspace' || v === 'both' ? v : undefined
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    // Env/config booleans are commonly written TRUE / Yes / on; treat them
    // case-insensitively instead of silently ignoring anything but "true"/"1".
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  }
  return undefined
}

function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

/** Trimmed, de-duplicated string list; non-string / blank entries are dropped. */
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of v) {
    if (typeof x !== 'string') continue
    const s = x.trim()
    if (s === '' || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

const MODES: readonly PermissionMode[] = ['skip', 'auto', 'plan', 'accept-edits']

function asMode(v: unknown): PermissionMode | undefined {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
    ? (v as PermissionMode)
    : undefined
}

function asTransport(v: unknown): AgyTransportMode | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  return s === 'cli' || s === 'acp' ? s : undefined
}

function asTranslateDisplay(v: unknown): TranslateDisplayMode | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  return s === 'card' || s === 'replace' ? s : undefined
}

function asWarmupWindows(v: unknown): WarmupWindowMode | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().toLowerCase()
  return s === 'weekly' || s === '5h' || s === 'both' ? s : undefined
}

/** Layered config read; cheap enough to call per request (thunk pattern). */
export function resolveConfig(
  entry: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  overrides: OverridesFile = readOverrides(),
): PluginConfig {
  const base = defaultConfig()
  const e = entry ?? {}
  const layers: Array<Record<string, unknown>> = [overrides, e]
  const get = (k: string): unknown => {
    for (const l of layers) if (l[k] !== undefined && l[k] !== null && l[k] !== '') return l[k]
    return undefined
  }
  const cfg: PluginConfig = {
    ...base,
    enabled: asBool(get('enabled')) ?? base.enabled,
    agyBin: asString(get('agyBin')) ?? base.agyBin,
    extraArgs: Array.isArray(get('extraArgs'))
      ? (get('extraArgs') as unknown[]).filter((x): x is string => typeof x === 'string')
      : base.extraArgs,
    permissionMode: asMode(get('permissionMode')) ?? base.permissionMode,
    sandbox: asBool(get('sandbox')) ?? base.sandbox,
    agent: asString(get('agent')) ?? base.agent,
    agySettings: asString(get('agySettings')) ?? base.agySettings,
    transport: asTransport(get('transport')) ?? base.transport,
    imageTool: asBool(get('imageTool')) ?? base.imageTool,
    syncAccountCustomizations: asBool(get('syncAccountCustomizations')) ?? base.syncAccountCustomizations,
    mediaMaxFileBytes: asNum(get('mediaMaxFileBytes')) ?? base.mediaMaxFileBytes,
    defaultModel: asString(get('defaultModel')) ?? base.defaultModel,
    defaultEffort: asString(get('defaultEffort')) ?? base.defaultEffort,
    orchestratorPlannerModel: asString(get('orchestratorPlannerModel')) ?? base.orchestratorPlannerModel,
    orchestratorPlannerEffort: asString(get('orchestratorPlannerEffort')) ?? base.orchestratorPlannerEffort,
    orchestratorExecutorModel: asString(get('orchestratorExecutorModel')) ?? base.orchestratorExecutorModel,
    orchestratorExecutorEffort: asString(get('orchestratorExecutorEffort')) ?? base.orchestratorExecutorEffort,
    timeoutMs: asNum(get('timeoutMs')) ?? base.timeoutMs,
    longToolIdleMinutes: asNum(get('longToolIdleMinutes')) ?? base.longToolIdleMinutes,
    maxTurnMinutes: asNum(get('maxTurnMinutes')) ?? base.maxTurnMinutes,
    idleGraceMinutes: asNum(get('idleGraceMinutes')) ?? base.idleGraceMinutes,
    dispatchTimeoutMinutes: asNum(get('dispatchTimeoutMinutes')) ?? base.dispatchTimeoutMinutes,
    dispatchRetries: asNum(get('dispatchRetries')) ?? base.dispatchRetries,
    parallelSameAccount: asBool(get('parallelSameAccount')) ?? base.parallelSameAccount,
    respectExternalSignIn: asBool(get('respectExternalSignIn')) ?? base.respectExternalSignIn,
    reapOrphanMcp: asBool(get('reapOrphanMcp')) ?? base.reapOrphanMcp,
    maxConcurrent: asNum(get('maxConcurrent')) ?? base.maxConcurrent,
    contextWindowDefault: asNum(get('contextWindowDefault')) ?? base.contextWindowDefault,
    maxTokensDefault: asNum(get('maxTokensDefault')) ?? base.maxTokensDefault,
    forwardSystemPrompt: asBool(get('forwardSystemPrompt')) ?? base.forwardSystemPrompt,
    auxNeutralWorkspace: asBool(get('auxNeutralWorkspace')) ?? base.auxNeutralWorkspace,
    cloakSystemPrompt: asBool(get('cloakSystemPrompt')) ?? base.cloakSystemPrompt,
    digestMaxChars: asNum(get('digestMaxChars')) ?? base.digestMaxChars,
    contextTransferMaxChars: asNum(get('contextTransferMaxChars')) ?? base.contextTransferMaxChars,
    contextTransferMaxBytes: asNum(get('contextTransferMaxBytes')) ?? base.contextTransferMaxBytes,
    contextTransferFileAboveBytes: asNum(get('contextTransferFileAboveBytes')) ?? base.contextTransferFileAboveBytes,
    contextTransferFileMaxBytes: asNum(get('contextTransferFileMaxBytes')) ?? base.contextTransferFileMaxBytes,
    modelsCacheTtlMs: asNum(get('modelsCacheTtlMs')) ?? base.modelsCacheTtlMs,
    allowAuxiliary: asBool(get('allowAuxiliary')) ?? base.allowAuxiliary,
    compactionMaxChars: asNum(get('compactionMaxChars')) ?? base.compactionMaxChars,
    workspaceRoot: asString(get('workspaceRoot')) ?? base.workspaceRoot,
    fallbackModels: Array.isArray(get('fallbackModels'))
      ? (get('fallbackModels') as unknown[]).filter(
          (x): x is PluginConfig['fallbackModels'][number] =>
            !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string',
        )
      : base.fallbackModels,
    hiddenModels: asStringArray(get('hiddenModels')) ?? base.hiddenModels,
    selectedModels: asStringArray(get('selectedModels')) ?? base.selectedModels,
    askTool: asBool(get('askTool')) ?? base.askTool,
    mediaDir: asString(get('mediaDir')) ?? base.mediaDir,
    mediaTtlMs: asNum(get('mediaTtlMs')) ?? base.mediaTtlMs,
    mediaMaxBytes: asNum(get('mediaMaxBytes')) ?? base.mediaMaxBytes,
    mediaMaxImages: asNum(get('mediaMaxImages')) ?? base.mediaMaxImages,
    mcpBridge: asBool(get('mcpBridge')) ?? base.mcpBridge,
    mcpBridgeScope: [env.DSH_AGY_MCP_BRIDGE_SCOPE, overrides.mcpBridgeScope, e.mcpBridgeScope]
      .find(value => value === 'all' || value === 'host-only') ?? base.mcpBridgeScope,
    mcpConfigScope: asMcpConfigScope(get('mcpConfigScope')) ?? base.mcpConfigScope,
    mcpConfigPath: asString(get('mcpConfigPath')) ?? base.mcpConfigPath,
    mcpToolAllowlist: asString(get('mcpToolAllowlist')) ?? base.mcpToolAllowlist,
    rateLimitPerMinute: asNum(get('rateLimitPerMinute')) ?? base.rateLimitPerMinute,
    autoFallbackModel: asBool(get('autoFallbackModel')) ?? base.autoFallbackModel,
    logRetentionDays: asNum(get('logRetentionDays')) ?? base.logRetentionDays,
    disableTelemetry: asBool(get('disableTelemetry')) ?? base.disableTelemetry,
    quotaPollIntervalMs: asNum(get('quotaPollIntervalMs')) ?? base.quotaPollIntervalMs,
    quotaViaCli: asBool(get('quotaViaCli')) ?? base.quotaViaCli,
    proxyUrl: asString(get('proxyUrl')) ?? base.proxyUrl,
    suppressAgyAutoUpdate: asBool(get('suppressAgyAutoUpdate')) ?? base.suppressAgyAutoUpdate,
    autoWarmup: asBool(get('autoWarmup')) ?? base.autoWarmup,
    warmupModels: asStringArray(get('warmupModels')) ?? base.warmupModels,
    warmupWindows: asWarmupWindows(get('warmupWindows')) ?? base.warmupWindows,
    warmupDailyTime: asString(get('warmupDailyTime')) ?? base.warmupDailyTime,
    warmupTimezone: asString(get('warmupTimezone')) ?? base.warmupTimezone,
    warmupIntervalHours: asNum(get('warmupIntervalHours')) ?? base.warmupIntervalHours,
    warmupMaxProbesPerRun: asNum(get('warmupMaxProbesPerRun')) ?? base.warmupMaxProbesPerRun,
    autoTranslate: asBool(get('autoTranslate')) ?? base.autoTranslate,
    translateDisplay: asTranslateDisplay(get('translateDisplay')) ?? base.translateDisplay,
    translateModel: asString(get('translateModel')) ?? base.translateModel,
    translateEffort: asString(get('translateEffort')) ?? base.translateEffort,
    translateTargetLanguage: asString(get('translateTargetLanguage')) ?? base.translateTargetLanguage,
    translateMaxChars: asNum(get('translateMaxChars')) ?? base.translateMaxChars,
    translateMaxTokens: asNum(get('translateMaxTokens')) ?? base.translateMaxTokens,
    translateTimeoutMs: asNum(get('translateTimeoutMs')) ?? base.translateTimeoutMs,
    translateRetries: asNum(get('translateRetries')) ?? base.translateRetries,
    translateSkipSameModel: asBool(get('translateSkipSameModel')) ?? base.translateSkipSameModel,
    translateBindConversation: asBool(get('translateBindConversation')) ?? base.translateBindConversation,
    translateMinIntervalMs: asNum(get('translateMinIntervalMs')) ?? base.translateMinIntervalMs,
    showHeaderBadge: asBool(get('showHeaderBadge')) ?? base.showHeaderBadge,
    showTranslateAction: asBool(get('showTranslateAction')) ?? base.showTranslateAction,
    poolWideCatalog: asBool(get('poolWideCatalog')) ?? base.poolWideCatalog,
    imageModel: asString(get('imageModel')) ?? base.imageModel,
    imageEffort: asString(get('imageEffort')) ?? base.imageEffort,
    imageTimeoutMs: asNum(get('imageTimeoutMs')) ?? base.imageTimeoutMs,
    imageMaxBytes: asNum(get('imageMaxBytes')) ?? base.imageMaxBytes,
    imageOutputDir: asString(get('imageOutputDir')) ?? base.imageOutputDir,
    imageRetries: asNum(get('imageRetries')) ?? base.imageRetries,
    btwEnabled: asBool(get('btwEnabled')) ?? base.btwEnabled,
    btwModel: asString(get('btwModel')) ?? base.btwModel,
    btwEffort: asString(get('btwEffort')) ?? base.btwEffort,
    backgroundWakeup: asBool(get('backgroundWakeup')) ?? base.backgroundWakeup,
    backgroundWakeupTtlMinutes: asNum(get('backgroundWakeupTtlMinutes')) ?? base.backgroundWakeupTtlMinutes,
    backgroundWakeupMaxPerSession: asNum(get('backgroundWakeupMaxPerSession')) ?? base.backgroundWakeupMaxPerSession,
  }
  // Env wins last (spec ADR-13).
  if (env.DSH_AGY_ENABLED !== undefined) cfg.enabled = asBool(env.DSH_AGY_ENABLED) ?? cfg.enabled
  if (env.DSH_AGY_BIN) cfg.agyBin = env.DSH_AGY_BIN
  if (env.DSH_AGY_MODE) {
    const m = asMode(env.DSH_AGY_MODE)
    if (m) cfg.permissionMode = m
  }
  if (env.DSH_AGY_SKIP_PERMISSIONS !== undefined) {
    const skip = asBool(env.DSH_AGY_SKIP_PERMISSIONS)
    if (skip !== undefined) cfg.permissionMode = skip ? 'skip' : 'plan'
  }
  if (env.DSH_AGY_SANDBOX !== undefined) {
    const sb = asBool(env.DSH_AGY_SANDBOX)
    if (sb !== undefined) cfg.sandbox = sb
  }
  if (env.DSH_AGY_AGENT !== undefined) cfg.agent = env.DSH_AGY_AGENT
  if (env.DSH_AGY_SETTINGS !== undefined) cfg.agySettings = env.DSH_AGY_SETTINGS
  if (env.DSH_AGY_TRANSPORT) {
    const t = asTransport(env.DSH_AGY_TRANSPORT)
    if (t) cfg.transport = t
  }
  if (env.DSH_AGY_IMAGE_TOOL !== undefined) {
    const it = asBool(env.DSH_AGY_IMAGE_TOOL)
    if (it !== undefined) cfg.imageTool = it
  }
  if (env.DSH_AGY_SYNC_CUSTOMIZATIONS !== undefined) {
    const sc = asBool(env.DSH_AGY_SYNC_CUSTOMIZATIONS)
    if (sc !== undefined) cfg.syncAccountCustomizations = sc
  }
  if (env.DSH_AGY_MEDIA_MAX_FILE_BYTES) {
    const v = asNum(env.DSH_AGY_MEDIA_MAX_FILE_BYTES)
    if (v !== undefined && v > 0) cfg.mediaMaxFileBytes = v
  }
  if (env.DSH_AGY_DEFAULT_MODEL) cfg.defaultModel = env.DSH_AGY_DEFAULT_MODEL
  if (env.DSH_AGY_DEFAULT_EFFORT) cfg.defaultEffort = env.DSH_AGY_DEFAULT_EFFORT
  if (env.DSH_AGY_ORCHESTRATOR_PLANNER_MODEL !== undefined) cfg.orchestratorPlannerModel = env.DSH_AGY_ORCHESTRATOR_PLANNER_MODEL
  if (env.DSH_AGY_ORCHESTRATOR_PLANNER_EFFORT !== undefined) cfg.orchestratorPlannerEffort = env.DSH_AGY_ORCHESTRATOR_PLANNER_EFFORT
  if (env.DSH_AGY_ORCHESTRATOR_EXECUTOR_MODEL !== undefined) cfg.orchestratorExecutorModel = env.DSH_AGY_ORCHESTRATOR_EXECUTOR_MODEL
  if (env.DSH_AGY_ORCHESTRATOR_EXECUTOR_EFFORT !== undefined) cfg.orchestratorExecutorEffort = env.DSH_AGY_ORCHESTRATOR_EXECUTOR_EFFORT
  if (env.DSH_AGY_TIMEOUT_MS) {
    const t = asNum(env.DSH_AGY_TIMEOUT_MS)
    if (t && t > 0) cfg.timeoutMs = t
  }
  if (env.DSH_AGY_LONG_TOOL_IDLE_MINUTES) {
    const t = asNum(env.DSH_AGY_LONG_TOOL_IDLE_MINUTES)
    if (t !== undefined && t >= 0) cfg.longToolIdleMinutes = t
  }
  if (env.DSH_AGY_MAX_TURN_MINUTES) {
    const mt = asNum(env.DSH_AGY_MAX_TURN_MINUTES)
    if (mt !== undefined && mt >= 0) cfg.maxTurnMinutes = mt
  }
  if (env.DSH_AGY_IDLE_GRACE_MINUTES) {
    const g = asNum(env.DSH_AGY_IDLE_GRACE_MINUTES)
    if (g !== undefined && g >= 0) cfg.idleGraceMinutes = g
  }
  // Model context window / output cap. agy's model list carries no window, so
  // these are the only knobs a user has when the reported value is wrong (a
  // 256K model shown as the 1M default); neither is exposed in the settings UI.
  if (env.DSH_AGY_CONTEXT_WINDOW) {
    const w = asNum(env.DSH_AGY_CONTEXT_WINDOW)
    if (w !== undefined && w > 0) cfg.contextWindowDefault = Math.floor(w)
  }
  if (env.DSH_AGY_MAX_TOKENS) {
    const m = asNum(env.DSH_AGY_MAX_TOKENS)
    if (m !== undefined && m > 0) cfg.maxTokensDefault = Math.floor(m)
  }
  if (env.DSH_AGY_EXTRA_ARGS) {
    cfg.extraArgs = env.DSH_AGY_EXTRA_ARGS.split(/\s+/).filter(Boolean)
  }
  if (env.DSH_AGY_HIDDEN_MODELS) {
    const list = asStringArray(env.DSH_AGY_HIDDEN_MODELS.split(','))
    if (list) cfg.hiddenModels = list
  }
  // Empty env value means "no allow-list" (show everything), which is also the
  // default — assigning [] would otherwise be indistinguishable from a user
  // deliberately ticking nothing off.
  if (env.DSH_AGY_SELECTED_MODELS) {
    const list = asStringArray(env.DSH_AGY_SELECTED_MODELS.split(','))
    if (list && list.length > 0) cfg.selectedModels = list
  }
  if (env.DSH_AGY_WORKSPACE_ROOT) cfg.workspaceRoot = env.DSH_AGY_WORKSPACE_ROOT
  if (env.DSH_AGY_MEDIA_DIR) cfg.mediaDir = env.DSH_AGY_MEDIA_DIR
  if (env.DSH_AGY_MEDIA_TTL_MS) {
    const t = asNum(env.DSH_AGY_MEDIA_TTL_MS)
    if (t && t > 0) cfg.mediaTtlMs = t
  }
  if (env.DSH_AGY_MCP_BRIDGE !== undefined) {
    const b = asBool(env.DSH_AGY_MCP_BRIDGE)
    if (b !== undefined) cfg.mcpBridge = b
  }
  if (env.DSH_AGY_MCP_TOOL_ALLOWLIST) cfg.mcpToolAllowlist = env.DSH_AGY_MCP_TOOL_ALLOWLIST
  if (env.DSH_AGY_MCP_CONFIG_PATH) cfg.mcpConfigPath = env.DSH_AGY_MCP_CONFIG_PATH
  if (env.DSH_AGY_MCP_CONFIG_SCOPE !== undefined) {
    const scope = asMcpConfigScope(env.DSH_AGY_MCP_CONFIG_SCOPE)
    if (scope !== undefined) cfg.mcpConfigScope = scope
  }
  if (env.DSH_AGY_RATE_LIMIT_PER_MINUTE) {
    const r = asNum(env.DSH_AGY_RATE_LIMIT_PER_MINUTE)
    if (r !== undefined && r >= 0) cfg.rateLimitPerMinute = r
  }
  if (env.DSH_AGY_AUTO_FALLBACK_MODEL !== undefined) {
    const af = asBool(env.DSH_AGY_AUTO_FALLBACK_MODEL)
    if (af !== undefined) cfg.autoFallbackModel = af
  }
  if (env.DSH_AGY_LOG_RETENTION_DAYS) {
    const l = asNum(env.DSH_AGY_LOG_RETENTION_DAYS)
    if (l && l > 0) cfg.logRetentionDays = l
  }
  if (env.DSH_AGY_DISABLE_TELEMETRY !== undefined) {
    const dt = asBool(env.DSH_AGY_DISABLE_TELEMETRY)
    if (dt !== undefined) cfg.disableTelemetry = dt
  }
  if (env.DSH_AGY_QUOTA_POLL_INTERVAL_MS) {
    const q = asNum(env.DSH_AGY_QUOTA_POLL_INTERVAL_MS)
    if (q && q >= 60_000) cfg.quotaPollIntervalMs = q
  }
  if (env.DSH_AGY_QUOTA_VIA_CLI !== undefined) {
    const qvc = asBool(env.DSH_AGY_QUOTA_VIA_CLI)
    if (qvc !== undefined) cfg.quotaViaCli = qvc
  }
  if (env.DSH_AGY_PROXY_URL) cfg.proxyUrl = env.DSH_AGY_PROXY_URL
  if (env.DSH_AGY_SUPPRESS_AUTOUPDATE !== undefined) {
    const sa = asBool(env.DSH_AGY_SUPPRESS_AUTOUPDATE)
    if (sa !== undefined) cfg.suppressAgyAutoUpdate = sa
  }
  if (env.DSH_AGY_AUTO_WARMUP !== undefined) {
    const aw = asBool(env.DSH_AGY_AUTO_WARMUP)
    if (aw !== undefined) cfg.autoWarmup = aw
  }
  if (env.DSH_AGY_WARMUP_MODELS) {
    const wm = asStringArray(env.DSH_AGY_WARMUP_MODELS.split(','))
    if (wm) cfg.warmupModels = wm
  }
  if (env.DSH_AGY_WARMUP_WINDOWS) {
    const ww = asWarmupWindows(env.DSH_AGY_WARMUP_WINDOWS)
    if (ww) cfg.warmupWindows = ww
  }
  if (env.DSH_AGY_WARMUP_DAILY_TIME !== undefined) cfg.warmupDailyTime = env.DSH_AGY_WARMUP_DAILY_TIME
  if (env.DSH_AGY_WARMUP_TIMEZONE !== undefined) cfg.warmupTimezone = env.DSH_AGY_WARMUP_TIMEZONE
  if (env.DSH_AGY_WARMUP_INTERVAL_HOURS) {
    const ih = asNum(env.DSH_AGY_WARMUP_INTERVAL_HOURS)
    if (ih !== undefined && ih >= 0) cfg.warmupIntervalHours = Math.min(168, Math.floor(ih))
  }
  if (env.DSH_AGY_WARMUP_MAX_PROBES) {
    const mp = asNum(env.DSH_AGY_WARMUP_MAX_PROBES)
    if (mp !== undefined && mp >= 0) cfg.warmupMaxProbesPerRun = Math.floor(mp)
  }
  cfg.warmupIntervalHours = clampWarmupIntervalHours(cfg.warmupIntervalHours)
  cfg.warmupMaxProbesPerRun = Math.min(200, Math.max(0, Math.floor(cfg.warmupMaxProbesPerRun)))
  if (env.DSH_AGY_AUTO_TRANSLATE !== undefined) {
    const at = asBool(env.DSH_AGY_AUTO_TRANSLATE)
    if (at !== undefined) cfg.autoTranslate = at
  }
  if (env.DSH_AGY_TRANSLATE_MODEL) cfg.translateModel = env.DSH_AGY_TRANSLATE_MODEL
  if (env.DSH_AGY_TRANSLATE_EFFORT) cfg.translateEffort = env.DSH_AGY_TRANSLATE_EFFORT
  if (env.DSH_AGY_TRANSLATE_LANG) cfg.translateTargetLanguage = env.DSH_AGY_TRANSLATE_LANG
  const td = asTranslateDisplay(env.DSH_AGY_TRANSLATE_DISPLAY)
  if (td !== undefined) cfg.translateDisplay = td
  if (env.DSH_AGY_SHOW_HEADER_BADGE !== undefined) {
    const shb = asBool(env.DSH_AGY_SHOW_HEADER_BADGE)
    if (shb !== undefined) cfg.showHeaderBadge = shb
  }
  if (env.DSH_AGY_SHOW_TRANSLATE_ACTION !== undefined) {
    const sta = asBool(env.DSH_AGY_SHOW_TRANSLATE_ACTION)
    if (sta !== undefined) cfg.showTranslateAction = sta
  }
  if (env.DSH_AGY_POOL_WIDE_CATALOG !== undefined) {
    const pwc = asBool(env.DSH_AGY_POOL_WIDE_CATALOG)
    if (pwc !== undefined) cfg.poolWideCatalog = pwc
  }
  if (env.DSH_AGY_IMAGE_MODEL) cfg.imageModel = env.DSH_AGY_IMAGE_MODEL
  if (env.DSH_AGY_IMAGE_EFFORT) cfg.imageEffort = env.DSH_AGY_IMAGE_EFFORT
  if (env.DSH_AGY_IMAGE_TIMEOUT_MS) {
    const v = asNum(env.DSH_AGY_IMAGE_TIMEOUT_MS)
    if (v !== undefined) cfg.imageTimeoutMs = v
  }
  if (env.DSH_AGY_IMAGE_MAX_BYTES) {
    const v = asNum(env.DSH_AGY_IMAGE_MAX_BYTES)
    if (v !== undefined) cfg.imageMaxBytes = v
  }
  if (env.DSH_AGY_IMAGE_OUTPUT_DIR) cfg.imageOutputDir = env.DSH_AGY_IMAGE_OUTPUT_DIR
  if (env.DSH_AGY_IMAGE_RETRIES) {
    const v = asNum(env.DSH_AGY_IMAGE_RETRIES)
    if (v !== undefined) cfg.imageRetries = v
  }
  if (env.DSH_AGY_BTW_ENABLED !== undefined) cfg.btwEnabled = asBool(env.DSH_AGY_BTW_ENABLED) ?? cfg.btwEnabled
  if (env.DSH_AGY_BTW_MODEL !== undefined) cfg.btwModel = env.DSH_AGY_BTW_MODEL
  if (env.DSH_AGY_BTW_EFFORT !== undefined) cfg.btwEffort = env.DSH_AGY_BTW_EFFORT
  if (env.DSH_AGY_CLOAK_SYSTEM_PROMPT !== undefined) {
    const csp = asBool(env.DSH_AGY_CLOAK_SYSTEM_PROMPT)
    if (csp !== undefined) cfg.cloakSystemPrompt = csp
  }
  if (env.DSH_AGY_AUX_NEUTRAL_WORKSPACE !== undefined) {
    const anw = asBool(env.DSH_AGY_AUX_NEUTRAL_WORKSPACE)
    if (anw !== undefined) cfg.auxNeutralWorkspace = anw
  }
  if (env.DSH_AGY_BACKGROUND_WAKEUP !== undefined) {
    const bw = asBool(env.DSH_AGY_BACKGROUND_WAKEUP)
    if (bw !== undefined) cfg.backgroundWakeup = bw
  }
  if (env.DSH_AGY_BACKGROUND_WAKEUP_TTL_MINUTES) {
    const ttl = asNum(env.DSH_AGY_BACKGROUND_WAKEUP_TTL_MINUTES)
    if (ttl !== undefined && ttl > 0) cfg.backgroundWakeupTtlMinutes = Math.min(240, Math.max(1, Math.floor(ttl)))
  }
  if (env.DSH_AGY_BACKGROUND_WAKEUP_MAX_PER_SESSION) {
    const max = asNum(env.DSH_AGY_BACKGROUND_WAKEUP_MAX_PER_SESSION)
    if (max !== undefined && max > 0) cfg.backgroundWakeupMaxPerSession = Math.min(100, Math.max(1, Math.floor(max)))
  }
  cfg.backgroundWakeupTtlMinutes = Math.min(240, Math.max(1, Math.floor(cfg.backgroundWakeupTtlMinutes)))
  cfg.backgroundWakeupMaxPerSession = Math.min(100, Math.max(1, Math.floor(cfg.backgroundWakeupMaxPerSession)))
  return cfg
}
