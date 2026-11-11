import type { HostServices } from '../../../host/services.ts'
import { sendJson, readBody, methodOf, type RawRes, type RouteRegistrar } from '../respond.ts'

function handleConfig(services: HostServices, req: unknown, res: unknown): void {
  const { setOverride, notifyPicker, onConfigWritten } = services
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const key = typeof body.key === 'string' ? body.key : ''
        const allowed = [
          'permissionMode', 'defaultModel', 'defaultEffort', 'askTool', 'workspaceRoot', 'hiddenModels', 'autoWarmup', 'warmupModels',
          'autoTranslate', 'translateModel', 'translateEffort', 'translateTargetLanguage', 'translateMaxChars', 'translateSkipSameModel', 'translateBindConversation', 'translateMinIntervalMs',
          'imageModel', 'imageEffort', 'imageTimeoutMs', 'imageMaxBytes', 'imageOutputDir', 'imageRetries',
        ]
        if (!allowed.includes(key)) {
          sendJson(res as RawRes, 400, { error: 'key not settable' })
          return
        }
        if (key === 'hiddenModels' && (!Array.isArray(body.value) || !(body.value as unknown[]).every((x) => typeof x === 'string'))) {
          sendJson(res as RawRes, 400, { error: 'hiddenModels must be an array of model ids' })
          return
        }
        if (key === 'warmupModels' && (!Array.isArray(body.value) || !(body.value as unknown[]).every((x) => typeof x === 'string'))) {
          sendJson(res as RawRes, 400, { error: 'warmupModels must be an array of model names' })
          return
        }
        setOverride(key, body.value)
        onConfigWritten(key, body.value)
        // Picker visibility changed — the webview re-reads the catalog only
        // after this event, so the toggle must announce itself.
        if (key === 'hiddenModels') notifyPicker()
        sendJson(res as RawRes, 200, { ok: true, key, value: body.value })
      })()
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/config', handler: (req, res) => handleConfig(services, req, res) })
}
