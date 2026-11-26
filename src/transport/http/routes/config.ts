import { isEffortId } from '../../../common/reasoning.ts'
import { MIN_WARMUP_INTERVAL_HOURS } from '../../../common/timeouts.ts'
import type { HostServices } from '../../../host/services.ts'
import { runRoute, sendJson, readBody, methodOf, type RawRes, type RouteRegistrar } from '../respond.ts'

const PERMISSION_MODES = new Set(['skip', 'auto', 'plan', 'accept-edits'])
const TRANSPORTS = new Set(['cli', 'acp'])
const WARMUP_WINDOWS = new Set(['weekly', '5h', 'both'])
const TRANSLATE_DISPLAYS = new Set(['card', 'replace'])

function validateConfigValue(key: string, value: unknown): string | null {
  if (key === 'hiddenModels') {
    return Array.isArray(value) && value.every((x) => typeof x === 'string')
      ? null
      : 'hiddenModels must be an array of model ids'
  }
  if (key === 'selectedModels') {
    // Allow-list of model ids; an empty array means "no restriction".
    return Array.isArray(value) && value.every((x) => typeof x === 'string')
      ? null
      : 'selectedModels must be an array of model ids'
  }
  if (key === 'warmupModels') {
    return Array.isArray(value) && value.every((x) => typeof x === 'string')
      ? null
      : 'warmupModels must be an array of model names'
  }
  if (key === 'permissionMode') {
    return typeof value === 'string' && PERMISSION_MODES.has(value)
      ? null
      : 'permissionMode must be skip, auto, plan, or accept-edits'
  }
  if (key === 'mcpBridgeScope') {
    return value === 'all' || value === 'host-only' ? null : 'mcpBridgeScope must be all or host-only'
  }
  if (key === 'transport') {
    return typeof value === 'string' && TRANSPORTS.has(value)
      ? null
      : 'transport must be cli or acp'
  }
  if (key === 'translateDisplay') {
    return typeof value === 'string' && TRANSLATE_DISPLAYS.has(value)
      ? null
      : 'translateDisplay must be card or replace'
  }
  if (key === 'sandbox' || key === 'imageTool' || key === 'syncAccountCustomizations' || key === 'backgroundWakeup' || key === 'mcpBridge' || key === 'btwEnabled' || key === 'cloakSystemPrompt' || key === 'respectExternalSignIn' || key === 'auxNeutralWorkspace') {
    return typeof value === 'boolean' ? null : `${key} must be a boolean`
  }
  if (key === 'warmupWindows') {
    return typeof value === 'string' && WARMUP_WINDOWS.has(value)
      ? null
      : 'warmupWindows must be weekly, 5h, or both'
  }
  if (key === 'warmupDailyTime') {
    return typeof value === 'string' && (value === '' || /^\d{1,2}:\d{2}$/.test(value.trim()))
      ? null
      : 'warmupDailyTime must be HH:MM or empty'
  }
  if (key === 'warmupTimezone') {
    return typeof value === 'string' ? null : 'warmupTimezone must be an IANA timezone string'
  }
  if (key === 'warmupIntervalHours') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 168) {
      return 'warmupIntervalHours must be a number between 0 and 168'
    }
    if (value > 0 && value < MIN_WARMUP_INTERVAL_HOURS) {
      return `warmupIntervalHours must be 0 (off) or at least ${MIN_WARMUP_INTERVAL_HOURS}`
    }
    return null
  }
  if (key === 'warmupMaxProbesPerRun') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 200
      ? null
      : 'warmupMaxProbesPerRun must be a number between 0 and 200 (0 = unlimited)'
  }
  if (key === 'agent' || key === 'orchestratorPlannerModel' || key === 'orchestratorExecutorModel' || key === 'btwModel') {
    return typeof value === 'string' ? null : `${key} must be a string`
  }
  if (key === 'orchestratorPlannerEffort' || key === 'orchestratorExecutorEffort' || key === 'btwEffort') {
    if (typeof value !== 'string') return `${key} must be a string`
    const trimmed = value.trim().toLowerCase()
    if (trimmed !== '' && !isEffortId(trimmed)) {
      return `${key} must be empty or a valid reasoning effort`
    }
    return null
  }
  if (key === 'quotaPollIntervalMs') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 60_000
      ? null
      : 'quotaPollIntervalMs must be a number of milliseconds >= 60000'
  }
  if (key === 'agySettings') {
    if (typeof value !== 'string') return 'agySettings must be a string'
    const trimmed = value.trim()
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return 'agySettings JSON must be a plain object'
        }
      } catch {
        return 'agySettings inline JSON is invalid'
      }
    }
    return null
  }
  return null
}

function handleConfig(services: HostServices, req: unknown, res: unknown): void {
  const { setOverride, notifyPicker, onConfigWritten } = services
      runRoute(res, async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const key = typeof body.key === 'string' ? body.key : ''
        const allowed = [
          'enabled', 'permissionMode', 'sandbox', 'agent', 'agySettings', 'transport', 'imageTool', 'syncAccountCustomizations', 'backgroundWakeup', 'mcpBridge', 'mcpBridgeScope', 'btwEnabled',
          'cloakSystemPrompt', 'respectExternalSignIn', 'auxNeutralWorkspace',
          'defaultModel', 'defaultEffort',
          'orchestratorPlannerModel', 'orchestratorPlannerEffort', 'orchestratorExecutorModel', 'orchestratorExecutorEffort',
          'askTool', 'workspaceRoot', 'hiddenModels',
          'autoWarmup', 'warmupModels', 'warmupWindows', 'warmupDailyTime', 'warmupTimezone', 'warmupIntervalHours', 'warmupMaxProbesPerRun',
          'autoTranslate', 'translateDisplay', 'translateModel', 'translateEffort', 'translateTargetLanguage', 'translateMaxChars', 'translateSkipSameModel', 'translateBindConversation', 'translateMinIntervalMs',
          'imageModel', 'imageEffort', 'imageTimeoutMs', 'imageMaxBytes', 'imageOutputDir', 'imageRetries',
          'btwModel', 'btwEffort',
          'showHeaderBadge', 'showTranslateAction', 'poolWideCatalog', 'selectedModels',
          'quotaPollIntervalMs',
        ]
        if (!allowed.includes(key)) {
          sendJson(res as RawRes, 400, { error: 'key not settable' })
          return
        }
        const validationError = validateConfigValue(key, body.value)
        if (validationError !== null) {
          sendJson(res as RawRes, 400, { error: validationError })
          return
        }
        setOverride(key, body.value)
        onConfigWritten(key, body.value)
        // Both keys change the model set DSH's picker must display:
        // `hiddenModels`/`selectedModels` change visibility, `poolWideCatalog`
        // switches between the active account's catalog and the pool-wide union
        // (issue #107/#108). Without this event the cached picker keeps the old
        // list until a restart, so ticking a checkbox looked like "it did
        // nothing".
        if (key === 'hiddenModels' || key === 'selectedModels' || key === 'poolWideCatalog' || key === 'enabled') {
          notifyPicker()
        }
        sendJson(res as RawRes, 200, { ok: true, key, value: body.value })
      })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/config', handler: (req, res) => handleConfig(services, req, res) })
}
