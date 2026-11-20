import type { HostServices } from '../../../host/services.ts'
import { runRoute, sendJson, readBody, methodOf, type RawRes, type RouteRegistrar } from '../respond.ts'

const PERMISSION_MODES = new Set(['skip', 'plan', 'accept-edits'])

function validateConfigValue(key: string, value: unknown): string | null {
  if (key === 'hiddenModels') {
    return Array.isArray(value) && value.every((x) => typeof x === 'string')
      ? null
      : 'hiddenModels must be an array of model ids'
  }
  if (key === 'warmupModels') {
    return Array.isArray(value) && value.every((x) => typeof x === 'string')
      ? null
      : 'warmupModels must be an array of model names'
  }
  if (key === 'permissionMode') {
    return typeof value === 'string' && PERMISSION_MODES.has(value)
      ? null
      : 'permissionMode must be skip, plan, or accept-edits'
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
          'enabled', 'permissionMode', 'defaultModel', 'defaultEffort', 'askTool', 'workspaceRoot', 'hiddenModels', 'autoWarmup', 'warmupModels',
          'autoTranslate', 'translateModel', 'translateEffort', 'translateTargetLanguage', 'translateMaxChars', 'translateSkipSameModel', 'translateBindConversation', 'translateMinIntervalMs',
          'imageModel', 'imageEffort', 'imageTimeoutMs', 'imageMaxBytes', 'imageOutputDir', 'imageRetries',
          'showHeaderBadge', 'showTranslateAction', 'poolWideCatalog',
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
        // Keys that change the visible model set must broadcast immediately so
        // DSH's picker stays synchronized with the console.
        if (key === 'hiddenModels' || key === 'poolWideCatalog' || key === 'enabled') {
          notifyPicker()
        }
        sendJson(res as RawRes, 200, { ok: true, key, value: body.value })
      })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/config', handler: (req, res) => handleConfig(services, req, res) })
}
